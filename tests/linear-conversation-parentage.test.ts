import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { CanonicalStreamCoordinator } from '../src/core/recorder/canonical-stream-coordinator';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { buildConversationTree } from '../src/core/conversation-tree/tree';
import type { Message } from '../src/core/models';
import type { DeepSeekParsedHistory, NormalizedHistoryMessage } from '../src/adapters/deepseek/history/types';

function makeHistMsg(partial: Partial<NormalizedHistoryMessage> & { messageId: string; role: 'user' | 'assistant'; text: string }): NormalizedHistoryMessage {
  return {
    messageId: partial.messageId,
    parentId: partial.parentId ?? null,
    role: partial.role,
    status: partial.status ?? 'finished',
    createdAt: partial.createdAt ?? Date.now(),
    text: partial.text,
    thinking: partial.thinking,
    isFiltered: partial.isFiltered ?? false,
    fragmentsCount: partial.fragmentsCount ?? 1,
    continuityDeliveryId: partial.continuityDeliveryId,
  };
}

describe('Linear Conversation Parentage & Continuity Gate', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  it('Turn 1 -> Turn 2: preserves strictly connected linear sequence (User 1 -> Asst 1 -> User 2 -> Asst 2) with 0 unlinked messages', async () => {
    const conversationId = 'conv_linear_test_1';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_session_1',
      title: 'Linear Conversation Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // ── Turn 1: User 1 sends prompt ──
    const clientTurnId1 = 'turn_user_001';
    const userMsg1: Message = {
      id: clientTurnId1,
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Напиши краткое приветствие',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessages([userMsg1]);

    // ── Turn 1: Assistant 1 streams ──
    const coordinator1 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_1',
      streamId: 'stream_1',
      provisionalSessionId: conversationId,
      clientTurnId: clientTurnId1,
      requestPrompt: 'Напиши краткое приветствие',
      requestParentMessageId: null,
      onCheckpoint: async (dto) => {
        await storageRepo.saveCanonicalCheckpoint({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return {
          success: true,
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          persistedAt: Date.now(),
        };
      },
    });

    // Ready event from DeepSeek: identifies request 101 and response 102
    coordinator1.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 'stream_1',
      sequence: 1,
      timestamp: 1050,
      requestMessageId: '101',
      messageId: '102',
    });

    // Text chunk
    coordinator1.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 'stream_1',
      sequence: 2,
      timestamp: 1100,
      delta: 'Привет! Чем я могу помочь?',
    });

    // Finish stream
    coordinator1.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 'stream_1',
      sequence: 3,
      timestamp: 1200,
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coordinator1.awaitFinalPersistence();

    // Verify Turn 1 in storage
    const msgsAfterTurn1 = await storageRepo.listMessagesByConversation(conversationId);
    expect(msgsAfterTurn1).toHaveLength(2);
    const asst1 = msgsAfterTurn1.find((m) => m.role === 'assistant')!;
    expect(asst1.parentId).toBe(clientTurnId1);
    expect(asst1.remoteId).toBe('102');

    // ── Turn 2: User 2 sends follow-up with parent_message_id = '102' ──
    const clientTurnId2 = 'turn_user_002';
    const userMsg2: Message = {
      id: clientTurnId2,
      conversationId,
      remoteParentId: '102',
      parentId: asst1.id, // resolved from existing assistant in conversation
      role: 'user',
      status: 'finished',
      content: 'Добавь ещё один пункт',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    await storageRepo.saveMessages([userMsg2]);

    // ── Turn 2: Assistant 2 streams ──
    const coordinator2 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_1',
      streamId: 'stream_2',
      provisionalSessionId: conversationId,
      clientTurnId: clientTurnId2,
      requestPrompt: 'Добавь ещё один пункт',
      requestParentMessageId: '102',
      onCheckpoint: async (dto) => {
        await storageRepo.saveCanonicalCheckpoint({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return {
          success: true,
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          persistedAt: Date.now(),
        };
      },
    });

    // Ready event from DeepSeek: identifies request 103 and response 104
    coordinator2.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 'stream_2',
      sequence: 1,
      timestamp: 2050,
      requestMessageId: '103',
      messageId: '104',
    });

    // Text chunk
    coordinator2.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 'stream_2',
      sequence: 2,
      timestamp: 2100,
      delta: 'Вот дополнительный пункт: всегда сохраняй контекст.',
    });

    // Finish stream
    coordinator2.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 'stream_2',
      sequence: 3,
      timestamp: 2200,
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coordinator2.awaitFinalPersistence();

    // ── Verify storage before server history ──
    const msgsBeforeHistory = await storageRepo.listMessagesByConversation(conversationId);
    expect(msgsBeforeHistory).toHaveLength(4);

    const asst2 = msgsBeforeHistory.find((m) => m.id !== asst1.id && m.role === 'assistant')!;
    expect(asst2.parentId).toBe(clientTurnId2);
    expect(asst2.remoteId).toBe('104');

    // ── Build Conversation Tree before server history ──
    const treeLive = buildConversationTree(msgsBeforeHistory);
    expect(treeLive.roots).toHaveLength(1);
    expect(treeLive.roots[0]!.message.id).toBe(clientTurnId1);
    expect(treeLive.activePath.map((m) => m.id)).toEqual([
      clientTurnId1,
      asst1.id,
      clientTurnId2,
      asst2.id,
    ]);
    expect(treeLive.unlinkedMessages).toHaveLength(0);
    expect(treeLive.unlinkedDetails).toHaveLength(0);

    // ── Server History Arrives and Reconciles ──
    const historyPayload: DeepSeekParsedHistory = {
      session: {
        sessionId: 'remote_session_1',
        title: 'Linear Conversation Test',
        updatedAt: 2500,
        currentMessageId: '104',
        pinned: false,
      },
      messages: [
        makeHistMsg({
          messageId: '101',
          parentId: null,
          role: 'user',
          text: 'Напиши краткое приветствие',
          createdAt: 1000,
        }),
        makeHistMsg({
          messageId: '102',
          parentId: '101',
          role: 'assistant',
          text: 'Привет! Чем я могу помочь?',
          createdAt: 1050,
        }),
        makeHistMsg({
          messageId: '103',
          parentId: '102',
          role: 'user',
          text: 'Добавь ещё один пункт',
          createdAt: 2000,
        }),
        makeHistMsg({
          messageId: '104',
          parentId: '103',
          role: 'assistant',
          text: 'Вот дополнительный пункт: всегда сохраняй контекст.',
          createdAt: 2050,
        }),
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    const recResult = await reconciler.reconcile(historyPayload);

    // ── Build Conversation Tree after server history ──
    const msgsAfterHistory = await storageRepo.listMessagesByConversation(conversationId);
    expect(msgsAfterHistory).toHaveLength(4);

    const treeReconciled = buildConversationTree(msgsAfterHistory);
    expect(treeReconciled.roots).toHaveLength(1);
    expect(treeReconciled.activePath.map((m) => m.id)).toEqual([
      clientTurnId1,
      asst1.id,
      clientTurnId2,
      asst2.id,
    ]);
    expect(treeReconciled.unlinkedMessages).toHaveLength(0);
    expect(treeReconciled.unlinkedDetails).toHaveLength(0);
  });

  it('10-Turn (20 messages) Sequential Linear Conversation: preserves complete single-path continuity with 0 unlinked messages', async () => {
    const conversationId = 'conv_10_turn_linear';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_session_10_turns',
      title: '10 Turn Sequential Benchmark',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const expectedMessageIds: string[] = [];
    const historyMessages: DeepSeekParsedHistory['messages'] = [];
    let lastAsstRemoteId: string | null = null;
    let lastAsstLocalId: string | null = null;

    for (let turn = 1; turn <= 10; turn++) {
      const userReqRemoteId = String(100 + turn);
      const asstRespRemoteId = String(200 + turn);
      const clientTurnId = `turn_user_${turn}`;
      const userPrompt = `Turn ${turn} user prompt query`;
      const asstResponse = `Turn ${turn} assistant answer response`;
      const turnTime = turn * 1000;

      // 1. User turn observed & persisted
      const userMsg: Message = {
        id: clientTurnId,
        conversationId,
        remoteParentId: lastAsstRemoteId || undefined,
        parentId: lastAsstLocalId || undefined,
        role: 'user',
        status: 'finished',
        content: userPrompt,
        identityState: 'provisional',
        projectionState: 'provisional_logical',
        createdAt: turnTime,
        updatedAt: turnTime,
      };
      await storageRepo.saveMessages([userMsg]);
      expectedMessageIds.push(clientTurnId);

      // 2. Assistant stream coordinator
      const coordinator = new CanonicalStreamCoordinator({
        producerSessionId: 'prod_10',
        streamId: `stream_${turn}`,
        provisionalSessionId: conversationId,
        clientTurnId,
        requestPrompt: userPrompt,
        requestParentMessageId: lastAsstRemoteId,
        onCheckpoint: async (dto) => {
          await storageRepo.saveCanonicalCheckpoint({
            streamKey: dto.streamKey,
            checkpointSeq: dto.checkpointSeq,
            isTerminal: dto.isFinal,
            conversation: dto.conversation,
            userMessage: dto.userMessage,
            message: dto.message,
            revisions: dto.revisions,
            recoveryEvents: dto.recoveryEvents,
          });
          return {
            success: true,
            streamKey: dto.streamKey,
            checkpointSeq: dto.checkpointSeq,
            persistedAt: Date.now(),
          };
        },
      });

      // Ready frame
      coordinator.feedSemanticEvent({
        type: 'message_id_identified',
        streamId: `stream_${turn}`,
        sequence: 1,
        timestamp: turnTime + 50,
        requestMessageId: userReqRemoteId,
        messageId: asstRespRemoteId,
      });

      // Delta
      coordinator.feedSemanticEvent({
        type: 'answer_delta',
        streamId: `stream_${turn}`,
        sequence: 2,
        timestamp: turnTime + 100,
        delta: asstResponse,
      });

      // Terminal
      coordinator.feedSemanticEvent({
        type: 'stream_finished',
        streamId: `stream_${turn}`,
        sequence: 3,
        timestamp: turnTime + 200,
        status: 'FINISHED',
        terminalReason: 'completed',
      });
      await coordinator.awaitFinalPersistence();

      const asstLocalId = coordinator.getRecorder().buildMessageSnapshot().id;
      expectedMessageIds.push(asstLocalId);
      lastAsstRemoteId = asstRespRemoteId;
      lastAsstLocalId = asstLocalId;

      // Prepare corresponding server history entry
      historyMessages.push(
        makeHistMsg({
          messageId: userReqRemoteId,
          parentId: turn === 1 ? null : String(200 + turn - 1),
          role: 'user',
          text: userPrompt,
          createdAt: turnTime,
        })
      );
      historyMessages.push(
        makeHistMsg({
          messageId: asstRespRemoteId,
          parentId: userReqRemoteId,
          role: 'assistant',
          text: asstResponse,
          createdAt: turnTime + 50,
        })
      );
    }

    // ── Verify 20 messages in live conversation tree ──
    const liveMessages = await storageRepo.listMessagesByConversation(conversationId);
    expect(liveMessages).toHaveLength(20);

    const liveTree = buildConversationTree(liveMessages);
    expect(liveTree.roots).toHaveLength(1);
    expect(liveTree.roots[0]!.message.id).toBe('turn_user_1');
    expect(liveTree.activePath.map((m) => m.id)).toEqual(expectedMessageIds);
    expect(liveTree.unlinkedMessages).toHaveLength(0);
    expect(liveTree.unlinkedDetails).toHaveLength(0);

    // Verify alternating user -> assistant sequence
    for (let i = 0; i < liveTree.activePath.length; i++) {
      const expectedRole = i % 2 === 0 ? 'user' : 'assistant';
      expect(liveTree.activePath[i]!.role).toBe(expectedRole);
    }

    // ── Reconcile full 10-turn server history ──
    const reconciler = new HistoryReconciler(storageRepo);
    await reconciler.reconcile({
      session: {
        sessionId: 'remote_session_10_turns',
        title: '10 Turn Sequential Benchmark',
        updatedAt: 15000,
        currentMessageId: lastAsstRemoteId,
        pinned: false,
      },
      messages: historyMessages,
    });

    const reconciledMessages = await storageRepo.listMessagesByConversation(conversationId);
    expect(reconciledMessages).toHaveLength(20);

    const reconciledTree = buildConversationTree(reconciledMessages);
    expect(reconciledTree.roots).toHaveLength(1);
    expect(reconciledTree.activePath.map((m) => m.id)).toEqual(expectedMessageIds);
    expect(reconciledTree.unlinkedMessages).toHaveLength(0);
    expect(reconciledTree.unlinkedDetails).toHaveLength(0);
  });
});
