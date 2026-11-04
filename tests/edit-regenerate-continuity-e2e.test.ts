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

function makeTestMsg(partial: Partial<Message> & { id: string; conversationId: string; role: 'user' | 'assistant' }): Message {
  return {
    id: partial.id,
    conversationId: partial.conversationId,
    role: partial.role,
    status: partial.status ?? 'finished',
    content: partial.content,
    parentId: partial.parentId,
    remoteId: partial.remoteId,
    remoteParentId: partial.remoteParentId,
    sourceRawStreamKey: partial.sourceRawStreamKey,
    identityState: partial.identityState ?? 'provisional',
    projectionState: partial.projectionState ?? 'provisional_logical',
    createdAt: partial.createdAt ?? Date.now(),
    updatedAt: partial.updatedAt ?? Date.now(),
  };
}

describe('Edit & Regenerate Continuity E2E Suite', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  it('Scenario B: Edit of first prompt creates two valid roots with independent responses and 0 unlinked messages', async () => {
    const conversationId = 'conv_edit_root_test';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_edit_root',
      title: 'Краткое приветствие',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // ── Branch A: Original Turn 1 ──
    const u1_a: Message = {
      id: 'turn_user_1a',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Напиши краткое приветствие',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessages([u1_a]);

    const coord1_a = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_edit',
      streamId: 'stream_1a',
      provisionalSessionId: conversationId,
      clientTurnId: u1_a.id,
      requestPrompt: u1_a.content,
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
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord1_a.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 'stream_1a',
      sequence: 1,
      timestamp: 1050,
      requestMessageId: '101',
      messageId: '102',
    });
    coord1_a.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 'stream_1a',
      sequence: 2,
      timestamp: 1100,
      delta: 'Привет! Чем я могу помочь?',
    });
    coord1_a.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 'stream_1a',
      sequence: 3,
      timestamp: 1200,
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coord1_a.awaitFinalPersistence();

    // ── Branch B: User edits prompt 1 ──
    const u1_b: Message = {
      id: 'turn_user_1b',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Напиши развернутое приветствие',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    await storageRepo.saveMessages([u1_b]);

    const coord1_b = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_edit',
      streamId: 'stream_1b',
      provisionalSessionId: conversationId,
      clientTurnId: u1_b.id,
      requestPrompt: u1_b.content,
      requestParentMessageId: null, // edit of root has parent null
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
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord1_b.feedSemanticEvent({
      type: 'message_id_identified',
      streamId: 'stream_1b',
      sequence: 1,
      timestamp: 2050,
      requestMessageId: '201',
      messageId: '202',
    });
    coord1_b.feedSemanticEvent({
      type: 'answer_delta',
      streamId: 'stream_1b',
      sequence: 2,
      timestamp: 2100,
      delta: 'Здравствуйте! Я рад вас приветствовать и готов помочь с любой задачей.',
    });
    coord1_b.feedSemanticEvent({
      type: 'stream_finished',
      streamId: 'stream_1b',
      sequence: 3,
      timestamp: 2200,
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coord1_b.awaitFinalPersistence();

    // ── Verify live tree structure ──
    const allMsgs = await storageRepo.listMessagesByConversation(conversationId);
    expect(allMsgs).toHaveLength(4);

    const asst1_a = allMsgs.find((m) => m.sourceRawStreamKey === 'prod_edit:stream_1a')!;
    const asst1_b = allMsgs.find((m) => m.sourceRawStreamKey === 'prod_edit:stream_1b')!;

    expect(asst1_a.parentId).toBe(u1_a.id);
    expect(asst1_b.parentId).toBe(u1_b.id);

    // Tree with default branch selection (latest root u1_b)
    const treeLatest = buildConversationTree(allMsgs);
    expect(treeLatest.roots).toHaveLength(2);
    expect(treeLatest.unlinkedMessages).toHaveLength(0);
    expect(treeLatest.unlinkedDetails).toHaveLength(0);
    expect(treeLatest.activePath.map((m) => m.id)).toEqual([u1_b.id, asst1_b.id]);

    // Tree with branch selection choosing root 0 (u1_a)
    const treeBranchA = buildConversationTree(allMsgs, {
      branchSelections: { [u1_a.id]: 0 },
      viewSelection: {
        conversationId,
        selectedRootId: u1_a.id,
        selectedChildByParent: {},
        updatedAt: Date.now(),
      },
    });
    expect(treeBranchA.roots).toHaveLength(2);
    expect(treeBranchA.unlinkedMessages).toHaveLength(0);
    expect(treeBranchA.activePath.map((m) => m.id)).toEqual([u1_a.id, asst1_a.id]);

    // ── Reconcile Server History with both edit branches ──
    const reconciler = new HistoryReconciler(storageRepo);
    await reconciler.reconcile({
      session: {
        sessionId: 'remote_edit_root',
        title: 'Развернутое приветствие',
        currentMessageId: '202',
        pinned: false,
        updatedAt: 2500,
      },
      messages: [
        makeHistMsg({ messageId: '101', parentId: null, role: 'user', text: 'Напиши краткое приветствие' }),
        makeHistMsg({ messageId: '102', parentId: '101', role: 'assistant', text: 'Привет! Чем я могу помочь?' }),
        makeHistMsg({ messageId: '201', parentId: null, role: 'user', text: 'Напиши развернутое приветствие' }),
        makeHistMsg({ messageId: '202', parentId: '201', role: 'assistant', text: 'Здравствуйте! Я рад вас приветствовать и готов помочь с любой задачей.' }),
      ],
    });

    const reconciledMsgs = await storageRepo.listMessagesByConversation(conversationId);
    expect(reconciledMsgs).toHaveLength(4);

    const reconciledTree = buildConversationTree(reconciledMsgs);
    expect(reconciledTree.roots).toHaveLength(2);
    expect(reconciledTree.unlinkedMessages).toHaveLength(0);
    expect(reconciledTree.unlinkedDetails).toHaveLength(0);
  });

  it('Scenario D: Regenerate response creates sibling assistant variants under same user prompt with 0 unlinked messages', async () => {
    const conversationId = 'conv_regen_test';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_regen',
      title: 'Regenerate Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const userMsg: Message = {
      id: 'turn_user_prompt',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Explain quantum entanglement',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessages([userMsg]);

    // Assistant response variant 1
    const coord1 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_regen',
      streamId: 'stream_v1',
      provisionalSessionId: conversationId,
      clientTurnId: userMsg.id,
      requestPrompt: userMsg.content,
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
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord1.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_v1', sequence: 1, timestamp: 1050, messageId: '102' });
    coord1.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_v1', sequence: 2, timestamp: 1100, delta: 'Variant 1 explanation' });
    coord1.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_v1', sequence: 3, timestamp: 1200, status: 'FINISHED', terminalReason: 'completed' });
    await coord1.awaitFinalPersistence();

    // Assistant response variant 2 (Regenerate: requestParentMessageId is the user message remote id or local id)
    const coord2 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_regen',
      streamId: 'stream_v2',
      provisionalSessionId: conversationId,
      // In regenerate, clientTurnId is undefined because user did not type a prompt
      requestParentMessageId: userMsg.id, // or remote ID
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
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord2.feedSemanticEvent({ type: 'message_id_identified', streamId: 'stream_v2', sequence: 1, timestamp: 2050, messageId: '103' });
    coord2.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_v2', sequence: 2, timestamp: 2100, delta: 'Variant 2 regenerated explanation' });
    coord2.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_v2', sequence: 3, timestamp: 2200, status: 'FINISHED', terminalReason: 'completed' });
    await coord2.awaitFinalPersistence();

    const msgs = await storageRepo.listMessagesByConversation(conversationId);
    expect(msgs).toHaveLength(3);

    const asst1 = msgs.find((m) => m.sourceRawStreamKey === 'prod_regen:stream_v1')!;
    const asst2 = msgs.find((m) => m.sourceRawStreamKey === 'prod_regen:stream_v2')!;

    // Both assistant variants link to the same user prompt
    expect(asst1.parentId).toBe(userMsg.id);
    expect(asst2.remoteParentId).toBe(userMsg.id);

    const tree = buildConversationTree(msgs);
    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.message.id).toBe(userMsg.id);
    expect(tree.unlinkedMessages).toHaveLength(0);
    expect(tree.unlinkedDetails).toHaveLength(0);

    // Verify variants under user prompt
    const userNode = tree.roots[0]!;
    expect(userNode.children).toHaveLength(2);
    expect(userNode.children[0]!.assistantVariantCount).toBe(2);
    expect(userNode.children[1]!.assistantVariantCount).toBe(2);
  });

  it('Scenario F: Race Condition (user turn persisted after assistant stream completes) recovers parentage without loss', async () => {
    const conversationId = 'conv_race_test';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_race',
      title: 'Race Condition Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const clientTurnId = 'turn_user_race_1';

    // Assistant checkpoint commits FIRST
    const coord = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_race',
      streamId: 'stream_race_1',
      provisionalSessionId: conversationId,
      clientTurnId,
      requestPrompt: 'Fast response prompt',
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
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });
    coord.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_race_1', sequence: 1, timestamp: 1050, delta: 'Instant reply' });
    coord.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_race_1', sequence: 2, timestamp: 1100, status: 'FINISHED' });
    await coord.awaitFinalPersistence();

    // User turn persisted LATER via bridge MESSAGE_PERSIST_USER_TURN
    const delayedUserMsg: Message = {
      id: clientTurnId,
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Fast response prompt',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessages([delayedUserMsg]);

    const msgs = await storageRepo.listMessagesByConversation(conversationId);
    const tree = buildConversationTree(msgs);

    expect(tree.roots).toHaveLength(1);
    expect(tree.roots[0]!.message.id).toBe(clientTurnId);
    expect(tree.activePath).toHaveLength(2);
    expect(tree.unlinkedMessages).toHaveLength(0);
    expect(tree.unlinkedDetails).toHaveLength(0);
  });

  it('Scenario G: Safe recovery of pre-existing unlinked messages from IndexedDB v9 via HistoryReconciler', async () => {
    const conversationId = 'conv_v9_legacy_recovery';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_v9_legacy',
      title: 'Legacy Recovery Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Simulate pre-existing v9 database state with multiple user branches where assistant had ghost parent
    const legacyUser1: Message = {
      id: 'turn_user_legacy_1',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'First user question',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const legacyUser2: Message = {
      id: 'turn_user_legacy_2',
      conversationId,
      role: 'user',
      status: 'finished',
      content: 'Second user question',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    const legacyAssistant: Message = {
      id: 'msg_prod_legacy:stream_legacy',
      conversationId,
      parentId: 'msg_user_ghost_parent_999', // ghost parent
      sourceRawStreamKey: 'prod_legacy:stream_legacy',
      role: 'assistant',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 2100,
      updatedAt: 2100,
    };
    await storageRepo.saveMessages([legacyUser1, legacyUser2, legacyAssistant]);

    // Before reconciler, ghost parent with multiple candidate branches causes assistant to be safely unlinked
    const msgsBefore = await storageRepo.listMessagesByConversation(conversationId);
    const treeBefore = buildConversationTree(msgsBefore);
    expect(treeBefore.unlinkedMessages).toHaveLength(1);
    expect(treeBefore.unlinkedDetails[0]!.reason).toBe('parent_not_yet_persisted');

    // History arrives from DeepSeek
    const reconciler = new HistoryReconciler(storageRepo);
    await reconciler.reconcile({
      session: {
        sessionId: 'remote_v9_legacy',
        title: 'Legacy Recovery Test',
        currentMessageId: '502',
        updatedAt: 2100,
        pinned: false,
      },
      messages: [
        makeHistMsg({ messageId: '501', parentId: null, role: 'user', text: 'Second user question' }),
        makeHistMsg({ messageId: '502', parentId: '501', role: 'assistant', text: 'Authoritative answer' }),
      ],
    });

    // After reconciler, legacy assistant is safely reconciled and linked to legacyUser2
    const msgsAfter = await storageRepo.listMessagesByConversation(conversationId);
    const treeAfter = buildConversationTree(msgsAfter);

    expect(treeAfter.unlinkedMessages).toHaveLength(0);
    expect(treeAfter.unlinkedDetails).toHaveLength(0);
  });

  it('Тест 4: Edit after multiple turns preserves common assistant parent and creates two branches', async () => {
    const conversationId = 'conv_edit_multi_turn';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_edit_multi',
      title: 'Multi Turn Edit Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Turn 1: User 1 -> Asst 1
    const u1 = makeTestMsg({ id: 'u1', conversationId, role: 'user', content: 'Turn 1 prompt', createdAt: 1000, updatedAt: 1000 });
    const a1 = makeTestMsg({ id: 'a1', conversationId, role: 'assistant', parentId: 'u1', remoteId: '102', createdAt: 1100, updatedAt: 1100 });

    // Turn 2A: User 2A -> Asst 2A
    const u2_a = makeTestMsg({ id: 'u2_a', conversationId, role: 'user', parentId: 'a1', remoteParentId: '102', content: 'Prompt 2A original', createdAt: 2000, updatedAt: 2000 });
    const a2_a = makeTestMsg({ id: 'a2_a', conversationId, role: 'assistant', parentId: 'u2_a', remoteId: '202', createdAt: 2100, updatedAt: 2100 });

    // Turn 2B (Edit of turn 2): User 2B -> Asst 2B
    const u2_b = makeTestMsg({ id: 'u2_b', conversationId, role: 'user', parentId: 'a1', remoteParentId: '102', content: 'Prompt 2B edited', createdAt: 3000, updatedAt: 3000 });
    const a2_b = makeTestMsg({ id: 'a2_b', conversationId, role: 'assistant', parentId: 'u2_b', remoteId: '302', createdAt: 3100, updatedAt: 3100 });

    await storageRepo.saveMessages([u1, a1, u2_a, a2_a, u2_b, a2_b]);

    const msgs = await storageRepo.listMessagesByConversation(conversationId);
    expect(msgs).toHaveLength(6);

    const tree = buildConversationTree(msgs);
    expect(tree.roots).toHaveLength(1);
    expect(tree.unlinkedMessages).toHaveLength(0);
    expect(tree.unlinkedDetails).toHaveLength(0);

    const a1Node = tree.nodeMap.get('a1')!;
    expect(a1Node.children).toHaveLength(2);
    expect(a1Node.children[0]!.message.id).toBe('u2_a');
    expect(a1Node.children[1]!.message.id).toBe('u2_b');
    expect(a1Node.children[0]!.userBranchCount).toBe(2);
    expect(a1Node.children[1]!.userBranchCount).toBe(2);
  });

  it('Тест 7: Follow-up continuation on second regenerate response connects strictly to that variant', async () => {
    const conversationId = 'conv_regen_followup';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_regen_followup',
      title: 'Regen Followup Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Prompt A
    const uA = makeTestMsg({ id: 'uA', conversationId, role: 'user', content: 'Prompt A', createdAt: 1000, updatedAt: 1000 });
    // Assistant variant A1
    const aA1 = makeTestMsg({ id: 'aA1', conversationId, role: 'assistant', parentId: 'uA', remoteId: '102', createdAt: 1100, updatedAt: 1100 });
    // Assistant variant A2 (regenerated)
    const aA2 = makeTestMsg({ id: 'aA2', conversationId, role: 'assistant', parentId: 'uA', remoteId: '103', createdAt: 1200, updatedAt: 1200 });
    // Prompt B: follow-up to variant A2
    const uB = makeTestMsg({ id: 'uB', conversationId, role: 'user', parentId: 'aA2', remoteParentId: '103', content: 'Follow-up to variant 2', createdAt: 2000, updatedAt: 2000 });
    // Assistant response B
    const aB = makeTestMsg({ id: 'aB', conversationId, role: 'assistant', parentId: 'uB', remoteId: '202', createdAt: 2100, updatedAt: 2100 });

    await storageRepo.saveMessages([uA, aA1, aA2, uB, aB]);

    const msgs = await storageRepo.listMessagesByConversation(conversationId);
    const tree = buildConversationTree(msgs);

    expect(tree.roots).toHaveLength(1);
    expect(tree.unlinkedMessages).toHaveLength(0);
    expect(tree.unlinkedDetails).toHaveLength(0);

    // Active path following latest leaf should include uA -> aA2 -> uB -> aB
    expect(tree.activePath.map((m) => m.id)).toEqual(['uA', 'aA2', 'uB', 'aB']);

    // If user switches to variant A1:
    const treeVariant1 = buildConversationTree(msgs, {
      branchSelections: { uA: 0 },
    });
    expect(treeVariant1.activePath.map((m) => m.id)).toEqual(['uA', 'aA1']);
    expect(treeVariant1.unlinkedMessages).toHaveLength(0);
  });

  it('Тест 10 & 11: Incomplete server history preserves alternate branches, and repeated reconciliation is idempotent', async () => {
    const conversationId = 'conv_idempotent_test';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_idempotent',
      title: 'Idempotency Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Local state has Branch 1 and Branch 2
    const u1 = makeTestMsg({ id: 'u1', conversationId, role: 'user', content: 'Prompt 1', createdAt: 1000, updatedAt: 1000 });
    const a1 = makeTestMsg({ id: 'a1', conversationId, role: 'assistant', parentId: 'u1', remoteId: '102', createdAt: 1100, updatedAt: 1100 });
    const u1_edit = makeTestMsg({ id: 'u1_edit', conversationId, role: 'user', content: 'Prompt 1 edit', createdAt: 2000, updatedAt: 2000 });
    const a1_edit = makeTestMsg({ id: 'a1_edit', conversationId, role: 'assistant', parentId: 'u1_edit', remoteId: '202', createdAt: 2100, updatedAt: 2100 });

    await storageRepo.saveMessages([u1, a1, u1_edit, a1_edit]);

    // Server history arrives containing ONLY active branch (u1_edit -> a1_edit)
    const reconciler = new HistoryReconciler(storageRepo);
    const partialHistory: DeepSeekParsedHistory = {
      session: { sessionId: 'remote_idempotent', title: 'Idempotency Test', currentMessageId: '202', updatedAt: 2000, pinned: false },
      messages: [
        makeHistMsg({ messageId: '201', parentId: null, role: 'user', text: 'Prompt 1 edit' }),
        makeHistMsg({ messageId: '202', parentId: '201', role: 'assistant', text: 'Active response text' }),
      ],
    };

    // Reconcile pass 1
    const res1 = await reconciler.reconcile(partialHistory);
    const msgsPass1 = await storageRepo.listMessagesByConversation(conversationId);
    expect(msgsPass1).toHaveLength(4); // earlier branch u1 -> a1 preserved!

    const tree1 = buildConversationTree(msgsPass1);
    expect(tree1.roots).toHaveLength(2);
    expect(tree1.unlinkedMessages).toHaveLength(0);

    // Reconcile pass 2 (identical history payload)
    const res2 = await reconciler.reconcile(partialHistory);
    expect(res2.messagesCreated).toBe(0);
    expect(res2.revisionsCreated).toBe(0);

    const msgsPass2 = await storageRepo.listMessagesByConversation(conversationId);
    expect(msgsPass2).toHaveLength(4);

    const tree2 = buildConversationTree(msgsPass2);
    expect(tree2.roots).toHaveLength(2);
    expect(tree2.unlinkedMessages).toHaveLength(0);
  });

  it('Тест 13: Filtered/censored assistant turn in multi-turn conversation maintains parentage and last-good text', async () => {
    const conversationId = 'conv_filter_turn_test';
    await storageRepo.saveConversation({
      id: conversationId,
      remoteId: 'remote_filter_session',
      title: 'Filter Parentage Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Turn 1
    const u1 = makeTestMsg({ id: 'u1_filter', conversationId, role: 'user', content: 'Turn 1 prompt', createdAt: 1000, updatedAt: 1000 });
    const a1 = makeTestMsg({ id: 'a1_filter', conversationId, role: 'assistant', parentId: 'u1_filter', remoteId: '102', createdAt: 1100, updatedAt: 1100 });
    await storageRepo.saveMessages([u1, a1]);

    // Turn 2: sensitive query
    const u2 = makeTestMsg({ id: 'u2_filter', conversationId, role: 'user', parentId: 'a1_filter', remoteParentId: '102', content: 'Sensitive turn 2 prompt', createdAt: 2000, updatedAt: 2000 });
    await storageRepo.saveMessages([u2]);

    // Assistant 2 stream: streams answer, gets censored
    const coord = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_filt',
      streamId: 'stream_filt_2',
      provisionalSessionId: conversationId,
      clientTurnId: u2.id,
      requestPrompt: u2.content,
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
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
    });

    coord.feedSemanticEvent({ type: 'answer_delta', streamId: 'stream_filt_2', sequence: 1, timestamp: 2050, delta: 'Valuable pre-filter analysis text.' });
    coord.feedSemanticEvent({
      type: 'filter_triggered',
      streamId: 'stream_filt_2',
      sequence: 2,
      timestamp: 2100,
      lastGood: {
        answer: 'Valuable pre-filter analysis text.',
        thinking: 'Pre-filter thinking',
        capturedAt: 2100,
        reason: 'CONTENT_FILTER',
        projectionSource: 'top_level',
      },
    });
    coord.feedSemanticEvent({ type: 'answer_replace', streamId: 'stream_filt_2', sequence: 3, timestamp: 2150, fullText: 'Censorship apology stub.' });
    coord.feedSemanticEvent({ type: 'stream_finished', streamId: 'stream_filt_2', sequence: 4, timestamp: 2200, status: 'CONTENT_FILTER', terminalReason: 'filtered' });
    await coord.awaitFinalPersistence();

    const msgs = await storageRepo.listMessagesByConversation(conversationId);
    expect(msgs).toHaveLength(4);

    const tree = buildConversationTree(msgs);
    expect(tree.roots).toHaveLength(1);
    expect(tree.activePath).toHaveLength(4);
    expect(tree.unlinkedMessages).toHaveLength(0);

    const a2 = tree.activePath[3]!;
    expect(a2.status).toBe('filtered');
    expect(a2.parentId).toBe('u2_filter');

    // Verify last good revision is intact
    const revs = await storageRepo.listRevisionsByMessage(a2.id);
    const lastGood = revs.find((r) => r.isLastGood);
    expect(lastGood).toBeDefined();
    expect(lastGood?.text).toBe('Valuable pre-filter analysis text.');
  });
});
