import { describe, it, expect } from 'vitest';
import { validateTransportEventPayload } from '../src/bridge/validation';
import {
  CanonicalStreamCoordinator,
  type CanonicalCheckpointDto,
} from '../src/core/recorder/canonical-stream-coordinator';
import { buildConversationTree } from '../src/core/conversation-tree/tree';
import { mergeCanonicalMessage } from '../src/core/models/message';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import type { Message } from '../src/core/models/message';
import type { TransportEvent } from '../src/transport/types';
import type { StorageRepository } from '../src/core/contracts/storage-repository';

describe('End-to-End Live Turn 2 Parentage & Bridge Metadata Reproduction', () => {
  it('reproduces Defect 1: validateTransportEventPayload preserves clientTurnId, requestPrompt, and requestParentTurnId', () => {
    const rawTransportEvent: TransportEvent = {
      producerSessionId: 'prod_1',
      streamId: 'stream_turn_2',
      sequence: 10,
      streamSequence: 0,
      timestamp: Date.now(),
      transport: 'fetch',
      type: 'open',
      metadata: {
        method: 'POST',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        contentType: 'text/event-stream',
        clientTurnId: 'turn_user_2_abc',
        requestPrompt: 'What is the speed of light?',
        requestParentTurnId: 'asst_remote_1',
        requestSessionId: 'session_xyz',
      },
    };

    const validated = validateTransportEventPayload(rawTransportEvent);
    expect(validated).not.toBeNull();
    expect(validated?.metadata?.clientTurnId).toBe('turn_user_2_abc');
    expect(validated?.metadata?.requestPrompt).toBe('What is the speed of light?');
    expect(validated?.metadata?.requestParentTurnId).toBe('asst_remote_1');
    expect(validated?.metadata?.requestSessionId).toBe('session_xyz');
  });

  it('Scenario B: Linear Multi-Turn (Turn 1 -> Turn 2 -> Turn 3) keeps parentId unbroken and unlinkedMessages = 0', async () => {
    const sessionMessages: Message[] = [];

    // --- Turn 1 ---
    const user1Msg: Message = {
      id: 'turn_user_1',
      conversationId: 'session_xyz',
      role: 'user',
      status: 'finished',
      content: 'Hello DeepSeek',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    sessionMessages.push(user1Msg);

    const asst1Checkpoints: CanonicalCheckpointDto[] = [];
    const coordinator1 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_1',
      streamId: 'stream_1',
      provisionalSessionId: 'session_xyz',
      clientTurnId: 'turn_user_1',
      requestPrompt: 'Hello DeepSeek',
      requestParentMessageId: undefined,
      conversationTitle: 'DeepSeek Chat',
      onCheckpoint: async (dto) => {
        asst1Checkpoints.push(dto);
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq };
      },
    });

    coordinator1.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 'stream_1',
      sequence: 1,
      timestamp: 1010,
      messageId: 'asst_remote_1',
      requestMessageId: 'user_remote_1',
      sessionId: 'session_xyz',
    });
    coordinator1.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 'stream_1',
      sequence: 2,
      timestamp: 1020,
      delta: 'Hello! How can I help you today?',
    });
    coordinator1.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 'stream_1',
      sequence: 3,
      timestamp: 1030,
    });
    await coordinator1.awaitFinalPersistence();

    const finalAsst1 = asst1Checkpoints[asst1Checkpoints.length - 1]!.message;
    sessionMessages.push(finalAsst1);

    // --- Turn 2 ---
    const user2Msg: Message = {
      id: 'turn_user_2',
      conversationId: 'session_xyz',
      parentId: finalAsst1.id,
      remoteParentId: 'asst_remote_1',
      role: 'user',
      status: 'finished',
      content: 'What is 2+2?',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    sessionMessages.push(user2Msg);

    const openEventRaw2: TransportEvent = {
      producerSessionId: 'prod_1',
      streamId: 'stream_2',
      sequence: 20,
      streamSequence: 0,
      timestamp: 2005,
      transport: 'fetch',
      type: 'open',
      metadata: {
        method: 'POST',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        contentType: 'text/event-stream',
        clientTurnId: 'turn_user_2',
        requestPrompt: 'What is 2+2?',
        requestParentTurnId: 'asst_remote_1',
        requestSessionId: 'session_xyz',
      },
    };

    const openEvent2 = validateTransportEventPayload(openEventRaw2);
    expect(openEvent2).not.toBeNull();

    const asst2Checkpoints: CanonicalCheckpointDto[] = [];
    const coordinator2 = new CanonicalStreamCoordinator({
      producerSessionId: openEvent2!.producerSessionId,
      streamId: openEvent2!.streamId,
      provisionalSessionId: openEvent2!.metadata?.requestSessionId || 'session_xyz',
      clientTurnId: openEvent2!.metadata?.clientTurnId,
      requestPrompt: openEvent2!.metadata?.requestPrompt,
      requestParentMessageId: openEvent2!.metadata?.requestParentTurnId,
      conversationTitle: 'DeepSeek Chat',
      onCheckpoint: async (dto) => {
        asst2Checkpoints.push(dto);
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq };
      },
    });

    coordinator2.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 'stream_2',
      sequence: 1,
      timestamp: 2010,
      messageId: 'asst_remote_2',
      requestMessageId: 'user_remote_2',
      sessionId: 'session_xyz',
    });
    coordinator2.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 'stream_2',
      sequence: 2,
      timestamp: 2020,
      delta: '2+2 is 4.',
    });
    coordinator2.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 'stream_2',
      sequence: 3,
      timestamp: 2030,
    });
    await coordinator2.awaitFinalPersistence();

    const finalAsst2 = asst2Checkpoints[asst2Checkpoints.length - 1]!.message;
    sessionMessages.push(finalAsst2);

    // --- Turn 3 ---
    const user3Msg: Message = {
      id: 'turn_user_3',
      conversationId: 'session_xyz',
      parentId: finalAsst2.id,
      remoteParentId: 'asst_remote_2',
      role: 'user',
      status: 'finished',
      content: 'And what is 4+4?',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 3000,
      updatedAt: 3000,
    };
    sessionMessages.push(user3Msg);

    const openEventRaw3: TransportEvent = {
      producerSessionId: 'prod_1',
      streamId: 'stream_3',
      sequence: 30,
      streamSequence: 0,
      timestamp: 3005,
      transport: 'fetch',
      type: 'open',
      metadata: {
        method: 'POST',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        contentType: 'text/event-stream',
        clientTurnId: 'turn_user_3',
        requestPrompt: 'And what is 4+4?',
        requestParentTurnId: 'asst_remote_2',
        requestSessionId: 'session_xyz',
      },
    };

    const openEvent3 = validateTransportEventPayload(openEventRaw3);
    expect(openEvent3).not.toBeNull();

    const asst3Checkpoints: CanonicalCheckpointDto[] = [];
    const coordinator3 = new CanonicalStreamCoordinator({
      producerSessionId: openEvent3!.producerSessionId,
      streamId: openEvent3!.streamId,
      provisionalSessionId: openEvent3!.metadata?.requestSessionId || 'session_xyz',
      clientTurnId: openEvent3!.metadata?.clientTurnId,
      requestPrompt: openEvent3!.metadata?.requestPrompt,
      requestParentMessageId: openEvent3!.metadata?.requestParentTurnId,
      conversationTitle: 'DeepSeek Chat',
      onCheckpoint: async (dto) => {
        asst3Checkpoints.push(dto);
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq };
      },
    });

    coordinator3.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 'stream_3',
      sequence: 1,
      timestamp: 3010,
      messageId: 'asst_remote_3',
      requestMessageId: 'user_remote_3',
      sessionId: 'session_xyz',
    });
    coordinator3.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 'stream_3',
      sequence: 2,
      timestamp: 3020,
      delta: '4+4 is 8.',
    });
    coordinator3.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 'stream_3',
      sequence: 3,
      timestamp: 3030,
    });
    await coordinator3.awaitFinalPersistence();

    const finalAsst3 = asst3Checkpoints[asst3Checkpoints.length - 1]!.message;
    sessionMessages.push(finalAsst3);

    // Build DAG
    const tree = buildConversationTree(sessionMessages);

    expect(tree.unlinkedMessages).toHaveLength(0);
    expect(finalAsst1.parentId).toBe('turn_user_1');
    expect(finalAsst2.parentId).toBe('turn_user_2');
    expect(finalAsst3.parentId).toBe('turn_user_3');

    // Remote parent semantics
    expect(finalAsst1.remoteParentId).toBe('user_remote_1');
    expect(finalAsst2.remoteParentId).toBe('user_remote_2');
    expect(finalAsst3.remoteParentId).toBe('user_remote_3');

    // Verify tree linear path: u1 -> a1 -> u2 -> a2 -> u3 -> a3
    expect(tree.roots).toHaveLength(1);
    const u1 = tree.roots[0]!;
    expect(u1.message.id).toBe('turn_user_1');
    expect(u1.children).toHaveLength(1);
    const a1 = u1.children[0]!;
    expect(a1.message.id).toBe(finalAsst1.id);
    expect(a1.children).toHaveLength(1);
    const u2 = a1.children[0]!;
    expect(u2.message.id).toBe('turn_user_2');
    expect(u2.children).toHaveLength(1);
    const a2 = u2.children[0]!;
    expect(a2.message.id).toBe(finalAsst2.id);
    expect(a2.children).toHaveLength(1);
    const u3 = a2.children[0]!;
    expect(u3.message.id).toBe('turn_user_3');
    expect(u3.children).toHaveLength(1);
    const a3 = u3.children[0]!;
    expect(a3.message.id).toBe(finalAsst3.id);
    expect(a3.isLeaf).toBe(true);
  });

  it('Scenario A: Edit Turn creates valid sibling branches without unlinked orphans', async () => {
    const sessionMessages: Message[] = [];

    // Turn 1
    const user1Msg: Message = {
      id: 'u1',
      conversationId: 'session_edit',
      role: 'user',
      status: 'finished',
      content: 'Original prompt 1',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    sessionMessages.push(user1Msg);

    const asst1Checkpoints: CanonicalCheckpointDto[] = [];
    const coord1 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_1',
      streamId: 's1',
      provisionalSessionId: 'session_edit',
      clientTurnId: 'u1',
      requestPrompt: 'Original prompt 1',
      onCheckpoint: async (dto) => {
        asst1Checkpoints.push(dto);
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq };
      },
    });
    coord1.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 's1',
      sequence: 1,
      timestamp: 1010,
      messageId: 'a1_remote',
      requestMessageId: 'u1_remote',
    });
    coord1.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 's1',
      sequence: 2,
      timestamp: 1020,
      delta: 'Answer to original prompt 1',
    });
    coord1.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 's1',
      sequence: 3,
      timestamp: 1030,
    });
    await coord1.awaitFinalPersistence();
    const asst1Msg = asst1Checkpoints[asst1Checkpoints.length - 1]!.message;
    sessionMessages.push(asst1Msg);

    // Branch A: Turn 2a (child of asst 1)
    const user2aMsg: Message = {
      id: 'u2a',
      conversationId: 'session_edit',
      parentId: asst1Msg.id,
      remoteParentId: 'a1_remote',
      role: 'user',
      status: 'finished',
      content: 'Follow-up question A',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    sessionMessages.push(user2aMsg);

    const asst2aCheckpoints: CanonicalCheckpointDto[] = [];
    const coord2a = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_1',
      streamId: 's2a',
      provisionalSessionId: 'session_edit',
      clientTurnId: 'u2a',
      requestPrompt: 'Follow-up question A',
      requestParentMessageId: 'a1_remote',
      onCheckpoint: async (dto) => {
        asst2aCheckpoints.push(dto);
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq };
      },
    });
    coord2a.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 's2a',
      sequence: 1,
      timestamp: 2010,
      messageId: 'a2a_remote',
      requestMessageId: 'u2a_remote',
    });
    coord2a.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 's2a',
      sequence: 2,
      timestamp: 2020,
      delta: 'Answer to branch A',
    });
    coord2a.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 's2a',
      sequence: 3,
      timestamp: 2030,
    });
    await coord2a.awaitFinalPersistence();
    const asst2aMsg = asst2aCheckpoints[asst2aCheckpoints.length - 1]!.message;
    sessionMessages.push(asst2aMsg);

    // Branch B: User edits Turn 2 -> Turn 2b (sibling branch also replying to asst 1)
    const user2bMsg: Message = {
      id: 'u2b',
      conversationId: 'session_edit',
      parentId: asst1Msg.id,
      remoteParentId: 'a1_remote',
      role: 'user',
      status: 'finished',
      content: 'Edited follow-up question B',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2500,
      updatedAt: 2500,
    };
    sessionMessages.push(user2bMsg);

    const asst2bCheckpoints: CanonicalCheckpointDto[] = [];
    const coord2b = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_1',
      streamId: 's2b',
      provisionalSessionId: 'session_edit',
      clientTurnId: 'u2b',
      requestPrompt: 'Edited follow-up question B',
      requestParentMessageId: 'a1_remote',
      onCheckpoint: async (dto) => {
        asst2bCheckpoints.push(dto);
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq };
      },
    });
    coord2b.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 's2b',
      sequence: 1,
      timestamp: 2510,
      messageId: 'a2b_remote',
      requestMessageId: 'u2b_remote',
    });
    coord2b.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 's2b',
      sequence: 2,
      timestamp: 2520,
      delta: 'Answer to edited branch B',
    });
    coord2b.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 's2b',
      sequence: 3,
      timestamp: 2530,
    });
    await coord2b.awaitFinalPersistence();
    const asst2bMsg = asst2bCheckpoints[asst2bCheckpoints.length - 1]!.message;
    sessionMessages.push(asst2bMsg);

    const tree = buildConversationTree(sessionMessages);

    // Tree must have ZERO unlinked messages
    expect(tree.unlinkedMessages).toHaveLength(0);

    // Verify DAG branching structure:
    // Root: u1
    //   -> a1
    //        -> u2a -> a2a (branch 1)
    //        -> u2b -> a2b (branch 2)
    const a1Node = tree.roots[0]!.children[0]!;
    expect(a1Node.message.id).toBe(asst1Msg.id);
    expect(a1Node.children).toHaveLength(2);

    const branchA = a1Node.children.find((c) => c.message.id === 'u2a');
    expect(branchA).toBeDefined();
    expect(branchA!.children[0]!.message.id).toBe(asst2aMsg.id);

    const branchB = a1Node.children.find((c) => c.message.id === 'u2b');
    expect(branchB).toBeDefined();
    expect(branchB!.children[0]!.message.id).toBe(asst2bMsg.id);
  });

  it('Scenario C: mergeCanonicalMessage protects authoritative parentage against live overwrite', () => {
    const existingReconciledUser: Message = {
      id: 'turn_user_2',
      conversationId: 'conv_1',
      remoteId: 'user_remote_2',
      parentId: 'local_asst_1',
      remoteParentId: 'remote_asst_1',
      role: 'user',
      status: 'finished',
      content: 'Original prompt',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1000,
      updatedAt: 1000,
    };

    // Live checkpoint arrives later with raw remoteParentId masquerading as local parentId
    const incomingLiveUser: Message = {
      id: 'turn_user_2',
      conversationId: 'conv_1',
      remoteParentId: 'remote_asst_1',
      parentId: 'remote_asst_1', // masquerading
      role: 'user',
      status: 'finished',
      content: 'Original prompt',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1200,
    };

    const merged = mergeCanonicalMessage(existingReconciledUser, incomingLiveUser, 'live');

    // Local parentId must remain 'local_asst_1' and NOT be corrupted to 'remote_asst_1'!
    expect(merged.parentId).toBe('local_asst_1');
    expect(merged.remoteParentId).toBe('remote_asst_1');
    expect(merged.identityState).toBe('reconciled');
    expect(merged.projectionState).toBe('logical');
  });

  it('Scenario D: HistoryReconciler reconciles provisional live assistant without duplicating or orphaning it', async () => {
    // Stored live message before server history arrives:
    const liveUserMsg: Message = {
      id: 'local_user_turn_2',
      conversationId: 'conv_history_test',
      remoteId: undefined, // provisional
      parentId: 'local_asst_turn_1',
      remoteParentId: 'remote_asst_1',
      role: 'user',
      status: 'finished',
      content: 'Tell me a joke',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };

    const liveAsstMsg: Message = {
      id: 'local_asst_turn_2',
      conversationId: 'conv_history_test',
      remoteId: 'remote_asst_2',
      parentId: 'local_user_turn_2',
      remoteParentId: undefined,
      role: 'assistant',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2050,
      updatedAt: 2050,
    };

    const priorAsst1Msg: Message = {
      id: 'local_asst_turn_1',
      conversationId: 'conv_history_test',
      remoteId: 'remote_asst_1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1050,
      updatedAt: 1050,
    };

    const convObj = {
      id: 'conv_history_test',
      remoteId: 'server_conv_123',
      title: 'Joke Chat',
      createdAt: 1000,
      updatedAt: 2050,
    };

    const mockRepo: Partial<StorageRepository> = {
      getConversation: async () => convObj,
      getConversationByRemoteId: async () => convObj,
      listMessagesByConversation: async () => [priorAsst1Msg, liveUserMsg, liveAsstMsg],
      listRevisionsByMessage: async () => [],
    };

    const reconciler = new HistoryReconciler(mockRepo as StorageRepository);

    // DeepSeek server history payload:
    const historyPayload: import('../src/adapters/deepseek/history/types').DeepSeekParsedHistory = {
      session: {
        sessionId: 'server_conv_123',
        title: 'Joke Chat',
        pinned: false,
        updatedAt: 2050,
      },
      messages: [
        {
          messageId: 'remote_asst_1',
          role: 'assistant' as const,
          parentId: 'remote_user_1',
          text: 'Welcome!',
          status: 'finished' as const,
          isFiltered: false,
          fragmentsCount: 1,
          createdAt: 1050,
        },
        {
          messageId: 'remote_user_2',
          role: 'user' as const,
          parentId: 'remote_asst_1',
          text: 'Tell me a joke',
          status: 'finished' as const,
          isFiltered: false,
          fragmentsCount: 1,
          createdAt: 2000,
        },
        {
          messageId: 'remote_asst_2',
          role: 'assistant' as const,
          parentId: 'remote_user_2',
          text: 'Why did the chicken cross the road?',
          status: 'finished' as const,
          isFiltered: false,
          fragmentsCount: 1,
          createdAt: 2050,
        },
      ],
    };

    const { plan, result } = await reconciler.createPlan(historyPayload);

    expect(result.messagesUpdated).toBeGreaterThan(0);

    // Find reconciled messages in the plan
    const reconciledAsst2 = plan.messagesToPut.find((m) => m.id === 'local_asst_turn_2');
    expect(reconciledAsst2).toBeDefined();
    expect(reconciledAsst2!.identityState).toBe('reconciled');
    expect(reconciledAsst2!.remoteId).toBe('remote_asst_2');
    expect(reconciledAsst2!.remoteParentId).toBe('remote_user_2');
    expect(reconciledAsst2!.parentId).toBe('local_user_turn_2');
  });
});
