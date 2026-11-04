import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { CanonicalStreamCoordinator } from '../src/core/recorder/canonical-stream-coordinator';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { buildConversationTree } from '../src/core/conversation-tree/tree';
import type { Message } from '../src/core/models';
import type { NormalizedHistoryMessage } from '../src/adapters/deepseek/history/types';

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

describe('Realistic Wire Scenarios Reproduction & Fix Verification Suite', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  // Helper simulating background.ts parentage resolution pipeline for live turns
  async function persistUserTurnWithParentResolution(userMsg: Message): Promise<void> {
    const existingMsgs = await storageRepo.listMessagesByConversation(userMsg.conversationId);
    if (userMsg.remoteParentId && !userMsg.parentId) {
      const targetRemoteParent = String(userMsg.remoteParentId);
      let parentCandidate = existingMsgs.find(
        (m) =>
          m.role === 'assistant' &&
          ((m.remoteId && String(m.remoteId) === targetRemoteParent) || m.id === targetRemoteParent)
      );
      if (!parentCandidate) {
        const siblingUser = existingMsgs.find(
          (m) =>
            m.role === 'user' &&
            m.id !== userMsg.id &&
            m.remoteParentId &&
            String(m.remoteParentId) === targetRemoteParent &&
            m.parentId
        );
        if (siblingUser?.parentId) {
          parentCandidate = existingMsgs.find((m) => m.id === siblingUser.parentId);
        }
      }
      if (parentCandidate && parentCandidate.role === 'assistant') {
        userMsg.parentId = parentCandidate.id;
      }
    }
    await storageRepo.saveMessages([userMsg]);
  }

  // Helper simulating background.ts canonical checkpoint assistant parentage resolution
  async function persistCanonicalCheckpointWithParentResolution(checkpoint: any): Promise<void> {
    const targetConvId = checkpoint.conversation?.id || checkpoint.message.conversationId;
    if (checkpoint.message.role === 'assistant' && targetConvId) {
      const asstMsg = checkpoint.message;
      const remoteParent = asstMsg.remoteParentId ? String(asstMsg.remoteParentId) : undefined;
      const needsParentResolution =
        !asstMsg.parentId ||
        (remoteParent !== undefined && asstMsg.parentId === remoteParent);

      if (needsParentResolution) {
        const existingMsgs = await storageRepo.listMessagesByConversation(targetConvId);
        let resolvedParent = remoteParent
          ? existingMsgs.find(
              (m) => m.role === 'user' && m.remoteId && String(m.remoteId) === remoteParent
            )
          : undefined;

        if (!resolvedParent && remoteParent) {
          const siblingAsst = existingMsgs.find(
            (m) =>
              m.role === 'assistant' &&
              m.id !== asstMsg.id &&
              m.remoteParentId &&
              String(m.remoteParentId) === remoteParent &&
              m.parentId
          );
          if (siblingAsst?.parentId) {
            resolvedParent = existingMsgs.find((m) => m.id === siblingAsst.parentId);
          }
        }

        if (!resolvedParent) {
          const userCandidates = existingMsgs.filter((m) => m.role === 'user');
          if (userCandidates.length === 1) {
            resolvedParent = userCandidates[0];
          } else if (userCandidates.length > 1) {
            const lastFinishedAsst = existingMsgs
              .filter((m) => m.role === 'assistant' && m.id !== asstMsg.id && m.parentId)
              .at(-1);
            if (lastFinishedAsst?.parentId) {
              resolvedParent = existingMsgs.find((m) => m.id === lastFinishedAsst.parentId);
            }
          }
        }

        if (resolvedParent) {
          asstMsg.parentId = resolvedParent.id;
          if (!resolvedParent.remoteId && remoteParent) {
            resolvedParent.remoteId = remoteParent;
            await storageRepo.saveMessages([resolvedParent]);
          }
        }
      }
    }
    await storageRepo.saveCanonicalCheckpoint(checkpoint);
  }

  it('Scenario A: Edit первого запроса создает 2 корневые пользовательские ветки, 4 сообщения, переключатель веток 1 / 2', async () => {
    const conversationId = 'conv_wire_scenario_a';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_conv_a',
      title: 'Три закона робототехники',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // ── Turn 1 ──
    const u1: Message = {
      id: 'turn_user_robotech',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Назови 3 закона робототехники',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await persistUserTurnWithParentResolution(u1);

    const coord1 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_a',
      streamId: 'stream_a1',
      provisionalSessionId: conversationId,
      clientTurnId: u1.id,
      requestPrompt: u1.content,
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord1.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_a1', sequence: 1, timestamp: 1050, messageId: '102', requestMessageId: '101' });
    coord1.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_a1', sequence: 2, timestamp: 1100, delta: 'Три закона робототехники: 1. Робот не может причинить вред человеку...' });
    coord1.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_a1', sequence: 3, timestamp: 1200, status: 'FINISHED' });
    await coord1.awaitFinalPersistence();

    // ── Edit Turn 1 (User edits prompt to thermodynamics) ──
    // DeepSeek sends completion with parent_message_id: null
    const u2: Message = {
      id: 'turn_user_thermo',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Назови 3 закона термодинамики',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    await persistUserTurnWithParentResolution(u2);

    const coord2 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_a',
      streamId: 'stream_a2',
      provisionalSessionId: conversationId,
      clientTurnId: u2.id,
      requestPrompt: u2.content,
      requestParentMessageId: null,
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord2.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_a2', sequence: 1, timestamp: 2050, messageId: '202', requestMessageId: '201' });
    coord2.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_a2', sequence: 2, timestamp: 2100, delta: 'Три закона термодинамики: 1. Закон сохранения энергии...' });
    coord2.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_a2', sequence: 3, timestamp: 2200, status: 'FINISHED' });
    await coord2.awaitFinalPersistence();

    // Verify DB state
    const allMsgs = await storageRepo.listMessagesByConversation(conversationId);
    expect(allMsgs).toHaveLength(4);

    // Build tree
    const tree = buildConversationTree(allMsgs);
    expect(tree.roots).toHaveLength(2);
    expect(tree.unlinkedMessages).toHaveLength(0);

    const rootRobo = tree.roots.find((r) => r.message.id === u1.id)!;
    const rootThermo = tree.roots.find((r) => r.message.id === u2.id)!;
    expect(rootRobo.userBranchCount).toBe(2);
    expect(rootThermo.userBranchCount).toBe(2);

    // Initial unselected view defaults to the newest branch (thermodynamics)
    expect(tree.activePath.map((m) => m.id)).toEqual([u2.id, coord2.getRecorder().buildMessageSnapshot().id]);

    // Switch to root branch 0 (robotics)
    const treeRobo = buildConversationTree(allMsgs, {
      viewSelection: {
        conversationId,
        selectedRootId: u1.id,
        selectedChildByParent: {},
        updatedAt: Date.now(),
      },
    });
    expect(treeRobo.activePath.map((m) => m.id)).toEqual([u1.id, coord1.getRecorder().buildMessageSnapshot().id]);
  });

  it('Scenario B: Regenerate первого ответа без requestPrompt связывает ответ с родителем, 3 сообщения, вариант 1 / 2, 0 unlinked', async () => {
    const conversationId = 'conv_wire_scenario_b';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_conv_b',
      title: 'Три закона термодинамики',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Turn 1 prompt arrives without knowing server remoteId initially
    const u1: Message = {
      id: 'turn_user_b1',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Назови 3 закона термодинамики',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await persistUserTurnWithParentResolution(u1);

    const coord1 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_b',
      streamId: 'stream_b1',
      provisionalSessionId: conversationId,
      clientTurnId: u1.id,
      requestPrompt: u1.content,
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    // Server assigns requestMessageId: '101' and messageId: '102'
    coord1.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_b1', sequence: 1, timestamp: 1050, messageId: '102', requestMessageId: '101' });
    coord1.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_b1', sequence: 2, timestamp: 1100, delta: 'Ответ 1...' });
    coord1.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_b1', sequence: 3, timestamp: 1200, status: 'FINISHED' });
    await coord1.awaitFinalPersistence();

    // Now User clicks Regenerate on DeepSeek.
    // DeepSeek wire request: POST /api/v0/chat/completion with parent_message_id: 101, NO prompt!
    const coordRegen = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_b',
      streamId: 'stream_b_regen',
      provisionalSessionId: conversationId,
      requestParentMessageId: '101', // Remote ID from DeepSeek parent_message_id
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage, // undefined on regenerate
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    // Server generates new response messageId: '103' under requestMessageId: '101'
    coordRegen.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_b_regen', sequence: 1, timestamp: 2050, messageId: '103', requestMessageId: '101' });
    coordRegen.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_b_regen', sequence: 2, timestamp: 2100, delta: 'Ответ после Regenerate...' });
    coordRegen.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_b_regen', sequence: 3, timestamp: 2200, status: 'FINISHED' });
    await coordRegen.awaitFinalPersistence();

    const allMsgs = await storageRepo.listMessagesByConversation(conversationId);
    expect(allMsgs).toHaveLength(3); // 1 User + 2 Assistant

    const tree = buildConversationTree(allMsgs);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.message.id).toBe(u1.id);
    expect(tree.roots[0]!.children).toHaveLength(2); // Two assistant variants!
    expect(tree.unlinkedMessages).toHaveLength(0);
    expect(tree.unlinkedDetails).toHaveLength(0);

    const asstVariantA = tree.roots[0]!.children[0]!;
    const asstVariantB = tree.roots[0]!.children[1]!;
    expect(asstVariantA.assistantVariantCount).toBe(2);
    expect(asstVariantB.assistantVariantCount).toBe(2);
  });

  it('Scenario C: Regenerate второго ответа при 2-шаговом диалоге сохраняет общую историю, 5 сообщений, переключатель 1 / 2, 0 unlinked', async () => {
    const conversationId = 'conv_wire_scenario_c';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_conv_c',
      title: 'Проверка 1',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // ── Turn 1 ──
    const u1: Message = {
      id: 'turn_user_c1',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Проверка 1',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await persistUserTurnWithParentResolution(u1);

    const coord1 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_c',
      streamId: 'stream_c1',
      provisionalSessionId: conversationId,
      clientTurnId: u1.id,
      requestPrompt: u1.content,
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord1.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_c1', sequence: 1, timestamp: 1050, messageId: '102', requestMessageId: '101' });
    coord1.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_c1', sequence: 2, timestamp: 1100, delta: 'Проверка пройдена...' });
    coord1.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_c1', sequence: 3, timestamp: 1200, status: 'FINISHED' });
    await coord1.awaitFinalPersistence();

    // ── Turn 2 ──
    const u2: Message = {
      id: 'turn_user_c2',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Проверка 2',
      remoteParentId: '102', // server ID of Assistant 1
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    await persistUserTurnWithParentResolution(u2);

    const coord2 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_c',
      streamId: 'stream_c2',
      provisionalSessionId: conversationId,
      clientTurnId: u2.id,
      requestPrompt: u2.content,
      requestParentMessageId: '102',
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord2.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_c2', sequence: 1, timestamp: 2050, messageId: '104', requestMessageId: '103' });
    coord2.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_c2', sequence: 2, timestamp: 2100, delta: 'Проверка 2 принята (ответ A)...' });
    coord2.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_c2', sequence: 3, timestamp: 2200, status: 'FINISHED' });
    await coord2.awaitFinalPersistence();

    // ── Regenerate Turn 2 Assistant ──
    // DeepSeek wire request: POST /api/v0/chat/completion with parent_message_id: 103 (server ID of User 2)
    const coord2Regen = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_c',
      streamId: 'stream_c2_regen',
      provisionalSessionId: conversationId,
      requestParentMessageId: '103', // server ID of User 2
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord2Regen.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_c2_regen', sequence: 1, timestamp: 3050, messageId: '105', requestMessageId: '103' });
    coord2Regen.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_c2_regen', sequence: 2, timestamp: 3100, delta: 'Проверка 2 принята (ответ B после Regenerate)...' });
    coord2Regen.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_c2_regen', sequence: 3, timestamp: 3200, status: 'FINISHED' });
    await coord2Regen.awaitFinalPersistence();

    const allMsgs = await storageRepo.listMessagesByConversation(conversationId);
    expect(allMsgs).toHaveLength(5); // 2 User + 3 Assistant

    const tree = buildConversationTree(allMsgs);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.message.id).toBe(u1.id);
    expect(tree.unlinkedMessages).toHaveLength(0);
    expect(tree.unlinkedDetails).toHaveLength(0);

    // Turn 1 Assistant
    const asst1Node = tree.roots[0]!.children[0]!;
    expect(asst1Node.children).toHaveLength(1);

    // Turn 2 User
    const user2Node = asst1Node.children[0]!;
    expect(user2Node.message.id).toBe(u2.id);
    expect(user2Node.children).toHaveLength(2); // Two assistant variants!

    const asst2a = user2Node.children[0]!;
    const asst2b = user2Node.children[1]!;
    expect(asst2a.assistantVariantCount).toBe(2);
    expect(asst2b.assistantVariantCount).toBe(2);

    // Default active path includes the common ancestor and the latest regenerated variant
    expect(tree.activePath.map((m) => m.id)).toEqual([
      u1.id,
      coord1.getRecorder().buildMessageSnapshot().id,
      u2.id,
      coord2Regen.getRecorder().buildMessageSnapshot().id,
    ]);
  });

  it('Scenario D: Edit второго сообщения сохраняет общих предков, 6 сообщений, переключатель 1 / 2, 0 потерянных сообщений', async () => {
    const conversationId = 'conv_wire_scenario_d';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_conv_d',
      title: 'Проверка 3',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // ── Turn 1: Проверка 3 -> Ответ 3 ──
    const u1: Message = {
      id: 'turn_user_d1',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Проверка 3',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await persistUserTurnWithParentResolution(u1);

    const coord1 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_d',
      streamId: 'stream_d1',
      provisionalSessionId: conversationId,
      clientTurnId: u1.id,
      requestPrompt: u1.content,
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord1.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_d1', sequence: 1, timestamp: 1050, messageId: '102', requestMessageId: '101' });
    coord1.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_d1', sequence: 2, timestamp: 1100, delta: 'Проверка 3 принята...' });
    coord1.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_d1', sequence: 3, timestamp: 1200, status: 'FINISHED' });
    await coord1.awaitFinalPersistence();

    // ── Turn 2: Проверка 4 -> Ответ 4 ──
    const u2a: Message = {
      id: 'turn_user_d2a',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Проверка 4',
      remoteParentId: '102', // server ID of Assistant 1
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    await persistUserTurnWithParentResolution(u2a);

    const coord2a = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_d',
      streamId: 'stream_d2a',
      provisionalSessionId: conversationId,
      clientTurnId: u2a.id,
      requestPrompt: u2a.content,
      requestParentMessageId: '102',
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord2a.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_d2a', sequence: 1, timestamp: 2050, messageId: '104', requestMessageId: '103' });
    coord2a.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_d2a', sequence: 2, timestamp: 2100, delta: 'Проверка 4 принята...' });
    coord2a.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_d2a', sequence: 3, timestamp: 2200, status: 'FINISHED' });
    await coord2a.awaitFinalPersistence();

    // ── Edit Turn 2: Проверка 4 -> Проверка 5 ──
    // DeepSeek wire request: POST /api/v0/chat/completion with prompt: 'Проверка 5', parent_message_id: 102
    const u2b: Message = {
      id: 'turn_user_d2b',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Проверка 5',
      remoteParentId: '102', // server ID of Assistant 1
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 3000,
      updatedAt: 3000,
    };
    await persistUserTurnWithParentResolution(u2b);

    const coord2b = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_d',
      streamId: 'stream_d2b',
      provisionalSessionId: conversationId,
      clientTurnId: u2b.id,
      requestPrompt: u2b.content,
      requestParentMessageId: '102',
      onCheckpoint: async (dto) => {
        await persistCanonicalCheckpointWithParentResolution({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          conversation: dto.conversation,
          userMessage: dto.userMessage,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord2b.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_d2b', sequence: 1, timestamp: 3050, messageId: '106', requestMessageId: '105' });
    coord2b.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_d2b', sequence: 2, timestamp: 3100, delta: 'Проверка 5 принята...' });
    coord2b.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_d2b', sequence: 3, timestamp: 3200, status: 'FINISHED' });
    await coord2b.awaitFinalPersistence();

    const allMsgs = await storageRepo.listMessagesByConversation(conversationId);
    expect(allMsgs).toHaveLength(6); // 3 User + 3 Assistant

    const tree = buildConversationTree(allMsgs);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.message.id).toBe(u1.id);
    expect(tree.unlinkedMessages).toHaveLength(0);
    expect(tree.unlinkedDetails).toHaveLength(0);

    const asst1Node = tree.roots[0]!.children[0]!;
    expect(asst1Node.children).toHaveLength(2); // Two user edit forks (Проверка 4 and Проверка 5)!

    const node4 = asst1Node.children.find((c) => c.message.id === u2a.id)!;
    const node5 = asst1Node.children.find((c) => c.message.id === u2b.id)!;
    expect(node4.userBranchCount).toBe(2);
    expect(node5.userBranchCount).toBe(2);

    // Default active path uses newest branch (Проверка 5), preserving common ancestors (Проверка 3, Ответ 3)
    expect(tree.activePath.map((m) => m.id)).toEqual([
      u1.id,
      coord1.getRecorder().buildMessageSnapshot().id,
      u2b.id,
      coord2b.getRecorder().buildMessageSnapshot().id,
    ]);

    // Switching branch to branch 0 (Проверка 4) displays earlier fork, still preserving common ancestors!
    const treeBranch4 = buildConversationTree(allMsgs, {
      viewSelection: {
        conversationId,
        selectedChildByParent: {
          [asst1Node.message.id]: u2a.id,
        },
        updatedAt: Date.now(),
      },
    });
    expect(treeBranch4.activePath.map((m) => m.id)).toEqual([
      u1.id,
      coord1.getRecorder().buildMessageSnapshot().id,
      u2a.id,
      coord2a.getRecorder().buildMessageSnapshot().id,
    ]);
  });
});
