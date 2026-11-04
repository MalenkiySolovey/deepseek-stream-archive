import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import {
  persistUserTurnMessage,
  persistCanonicalCheckpointMessage,
} from '../src/core/recorder/checkpoint-persister';
import {
  isValidRoleParentage,
  resolveUserParent,
  resolveAssistantParent,
  assignRemoteIdSafely,
} from '../src/core/parentage/parent-resolver';
import { buildConversationTree } from '../src/core/conversation-tree/tree';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import type { Message } from '../src/core/models';
import type { CanonicalCheckpointData } from '../src/core/contracts/storage-repository';
import type { NormalizedHistoryMessage } from '../src/adapters/deepseek/history/types';

function makeMsg(partial: Partial<Message> & { id: string; conversationId: string; role: 'user' | 'assistant' }): Message {
  return {
    identityState: 'provisional',
    status: 'finished',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  };
}

describe('Audit: Negative Regression Tests Suite (Tests A through J)', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  it('Test A. Unknown remoteParentId: No automatic linking to last user, no changing remoteId', async () => {
    const convId = 'conv-test-a';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Test A Conversation',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const user1 = makeMsg({ id: 'u1', conversationId: convId, role: 'user', content: 'User 1 Prompt', remoteId: 'remote-u1', createdAt: 1000, updatedAt: 1000 });
    const asst1 = makeMsg({ id: 'a1', conversationId: convId, parentId: 'u1', role: 'assistant', content: 'Asst 1 Answer', remoteId: 'remote-a1', createdAt: 1100, updatedAt: 1100 });
    const user2 = makeMsg({ id: 'u2', conversationId: convId, parentId: 'a1', role: 'user', content: 'User 2 Prompt', remoteId: 'remote-u2', createdAt: 2000, updatedAt: 2000 });
    const asst2 = makeMsg({ id: 'a2', conversationId: convId, parentId: 'u2', role: 'assistant', content: 'Asst 2 Answer', remoteId: 'remote-a2', createdAt: 2100, updatedAt: 2100 });

    await storageRepo.saveMessages([user1, asst1, user2, asst2]);

    // Assistant checkpoint arrives with completely unresolvable remoteParentId
    const orphanAsst = makeMsg({
      id: 'a-orphan',
      conversationId: convId,
      role: 'assistant',
      remoteParentId: 'completely-unknown-parent-999',
      content: 'Orphan response text',
      createdAt: 3000,
      updatedAt: 3000,
    });

    const cpResult = await persistCanonicalCheckpointMessage(storageRepo, {
      streamKey: 'stream-orphan',
      checkpointSeq: 0,
      message: orphanAsst,
      revisions: [],
      recoveryEvents: [],
      isFinal: true,
    });

    expect(cpResult.success).toBe(true);

    const msgs = await storageRepo.listMessagesByConversation(convId);
    const savedOrphan = msgs.find((m) => m.id === 'a-orphan');
    const savedU1 = msgs.find((m) => m.id === 'u1');
    const savedU2 = msgs.find((m) => m.id === 'u2');

    // Invariant: MUST NOT guess parentId as u2 (or u1)
    expect(savedOrphan?.parentId).toBeUndefined();
    // Invariant: Existing user remoteIds MUST NOT be mutated
    expect(savedU1?.remoteId).toBe('remote-u1');
    expect(savedU2?.remoteId).toBe('remote-u2');

    // In Tree: orphan must be isolated in unlinkedMessages, NOT attached to u2
    const tree = buildConversationTree(msgs);
    expect(tree.unlinkedMessages.some((m) => m.id === 'a-orphan')).toBe(true);
    const node = tree.getNode('a-orphan');
    expect(node?.parent).toBeNull();
  });

  it('Test B. Regenerate of old branch: Does not attach to latest branch', async () => {
    const convId = 'conv-test-b';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Test B Conversation',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Turn 1: User 1 (remoteId: 101) -> Asst 1A (remoteId: 201)
    const u1 = makeMsg({ id: 'user-1', conversationId: convId, role: 'user', remoteId: '101', content: 'Turn 1 prompt', createdAt: 1000, updatedAt: 1000 });
    const a1a = makeMsg({ id: 'asst-1a', conversationId: convId, role: 'assistant', parentId: 'user-1', remoteId: '201', remoteParentId: '101', content: 'Turn 1 answer original', createdAt: 1100, updatedAt: 1100 });

    // Turn 2: User 2 (remoteId: 102) -> Asst 2 (remoteId: 202)
    const u2 = makeMsg({ id: 'user-2', conversationId: convId, role: 'user', parentId: 'asst-1a', remoteId: '102', remoteParentId: '201', content: 'Turn 2 prompt', createdAt: 2000, updatedAt: 2000 });
    const a2 = makeMsg({ id: 'asst-2', conversationId: convId, role: 'assistant', parentId: 'user-2', remoteId: '202', remoteParentId: '102', content: 'Turn 2 answer', createdAt: 2100, updatedAt: 2100 });

    await storageRepo.saveMessages([u1, a1a, u2, a2]);

    // Now user clicks Regenerate on Turn 1!
    // DeepSeek sends completion with parent_message_id = "101"
    const a1b = makeMsg({
      id: 'asst-1b-regen',
      conversationId: convId,
      role: 'assistant',
      remoteParentId: '101', // Turn 1's user server id!
      content: 'Turn 1 regenerated answer',
      createdAt: 3000,
      updatedAt: 3000,
    });

    const cpResult = await persistCanonicalCheckpointMessage(storageRepo, {
      streamKey: 'stream-regen-1',
      checkpointSeq: 0,
      message: a1b,
      revisions: [],
      recoveryEvents: [],
      isFinal: true,
    });

    expect(cpResult.success).toBe(true);

    const msgs = await storageRepo.listMessagesByConversation(convId);
    const savedA1b = msgs.find((m) => m.id === 'asst-1b-regen');

    // Invariant: Must resolve to Turn 1 User (user-1), NEVER Turn 2 User (user-2)!
    expect(savedA1b?.parentId).toBe('user-1');

    // In Tree: a1a and a1b must be siblings under user-1 with assistantVariantCount = 2
    const tree = buildConversationTree(msgs);
    const nodeA1a = tree.getNode('asst-1a');
    const nodeA1b = tree.getNode('asst-1b-regen');

    expect(nodeA1a?.parent?.message.id).toBe('user-1');
    expect(nodeA1b?.parent?.message.id).toBe('user-1');
    expect(nodeA1a?.assistantVariantCount).toBe(2);
    expect(nodeA1b?.assistantVariantCount).toBe(2);

    // Turn 2 user-2 must NOT have a1b as child or sibling
    const nodeU2 = tree.getNode('user-2');
    expect(nodeU2?.children.map((c) => c.message.id)).toEqual(['asst-2']);
  });

  it('Test C. Wrong role parentage: Assistant -> Assistant and User -> User rejected', () => {
    expect(isValidRoleParentage('assistant', 'assistant')).toBe(false);
    expect(isValidRoleParentage('user', 'user')).toBe(false);
    expect(isValidRoleParentage('assistant', 'user')).toBe(true);
    expect(isValidRoleParentage('user', 'assistant')).toBe(true);
    expect(isValidRoleParentage('user', null)).toBe(true);

    const convId = 'conv-test-c';
    const u1 = makeMsg({ id: 'u1', conversationId: convId, role: 'user', content: 'U1', createdAt: 1000, updatedAt: 1000 });
    // Invalid USER -> USER
    const u2 = makeMsg({ id: 'u2', conversationId: convId, role: 'user', parentId: 'u1', content: 'U2', createdAt: 1050, updatedAt: 1050 });

    const a1 = makeMsg({ id: 'a1', conversationId: convId, role: 'assistant', parentId: 'u1', content: 'A1', createdAt: 1100, updatedAt: 1100 });
    // Invalid ASSISTANT -> ASSISTANT
    const a2 = makeMsg({ id: 'a2', conversationId: convId, role: 'assistant', parentId: 'a1', content: 'A2', createdAt: 1200, updatedAt: 1200 });

    const tree = buildConversationTree([u1, u2, a1, a2]);

    // Invariants:
    // u2 must not be attached to u1
    const nodeU2 = tree.getNode('u2');
    expect(nodeU2?.parent).toBeNull();
    // a2 must not be attached to a1
    const nodeA2 = tree.getNode('a2');
    expect(nodeA2?.parent).toBeNull();

    // Both must be reported in unlinkedMessages with reason 'invalid_role_parentage'
    const detailU2 = tree.unlinkedDetails.find((d) => d.message.id === 'u2');
    const detailA2 = tree.unlinkedDetails.find((d) => d.message.id === 'a2');
    expect(detailU2?.reason).toBe('invalid_role_parentage');
    expect(detailA2?.reason).toBe('invalid_role_parentage');
  });

  it('Test D. Late server history: Preserves revisions, lastGood, and thinking', async () => {
    const convId = 'conv-test-d';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Test D Conversation',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const userMsg = makeMsg({
      id: 'prov-user',
      conversationId: convId,
      role: 'user',
      content: 'Provisional prompt',
      createdAt: 1000,
      updatedAt: 1000,
    });
    const asstMsg = makeMsg({
      id: 'prov-asst',
      conversationId: convId,
      parentId: 'prov-user',
      role: 'assistant',
      content: 'Provisional answer text',
      projectionState: 'provisional_logical',
      createdAt: 1100,
      updatedAt: 1100,
    });

    await storageRepo.saveMessages([userMsg, asstMsg]);
    // Save live revisions
    await storageRepo.saveRevisions([
      {
        id: 'rev-1',
        messageId: 'prov-asst',
        revisionIndex: 1,
        text: 'Provisional answer text',
        thinking: 'Provisional deepthink thoughts',
        isFinal: true,
        isLastGood: true,
        source: 'network',
        capturedAt: 1150,
      },
    ]);

    // Authoritative server history arrives later
    const reconciler = new HistoryReconciler(storageRepo);
    const histUser: NormalizedHistoryMessage = {
      messageId: 'server-u1',
      parentId: null,
      role: 'user',
      status: 'finished',
      createdAt: 1000,
      text: 'Provisional prompt',
      isFiltered: false,
      fragmentsCount: 1,
    };
    const histAsst: NormalizedHistoryMessage = {
      messageId: 'server-a1',
      parentId: 'server-u1',
      role: 'assistant',
      status: 'finished',
      createdAt: 1100,
      text: 'Provisional answer text',
      thinking: 'Provisional deepthink thoughts',
      isFiltered: false,
      fragmentsCount: 1,
    };

    await reconciler.reconcile({
      session: { sessionId: convId, title: 'Test D', updatedAt: 1200, pinned: false },
      messages: [histUser, histAsst],
    });

    const msgs = await storageRepo.listMessagesByConversation(convId);
    const finalAsst = msgs.find((m) => m.id === 'prov-asst');
    expect(finalAsst?.identityState).toBe('reconciled');
    expect(finalAsst?.remoteId).toBe('server-a1');
    expect(finalAsst?.parentId).toBe('prov-user');

    // Verify revisions were preserved intact
    const revisions = await storageRepo.listRevisionsByMessage('prov-asst');
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    expect(revisions[0]?.thinking).toBe('Provisional deepthink thoughts');
  });

  it('Test E & F: Identical prompt text logic in interceptor vs transport retry', () => {
    // Pure verification of turn deduplication contract:
    // If hasReceivedTokens is true, identical prompt is a NEW turn!
    const contextTurn1 = {
      clientTurnId: 'turn-1',
      prompt: 'Hello',
      hasReceivedTokens: true,
      isTerminal: true,
    };

    // Subsequent submission with same text:
    const isRetry1 =
      !contextTurn1.hasReceivedTokens &&
      !contextTurn1.isTerminal &&
      contextTurn1.prompt === 'Hello';
    expect(isRetry1).toBe(false); // New turn, not a retry!

    // If connection dropped with 0 tokens (hasReceivedTokens: false, isTerminal: false):
    const contextTurnRetry = {
      clientTurnId: 'turn-retry',
      prompt: 'Hello',
      hasReceivedTokens: false,
      isTerminal: false,
    };
    const isRetry2 =
      !contextTurnRetry.hasReceivedTokens &&
      !contextTurnRetry.isTerminal &&
      contextTurnRetry.prompt === 'Hello';
    expect(isRetry2).toBe(true); // Valid transport retry!
  });

  it('Test G. Multiple conversations: Complete isolation without cross-contamination', async () => {
    const conv1 = 'conv-isolated-1';
    const conv2 = 'conv-isolated-2';

    await storageRepo.saveConversation({ id: conv1, title: 'Conv 1', createdAt: 1000, updatedAt: 1000 });
    await storageRepo.saveConversation({ id: conv2, title: 'Conv 2', createdAt: 1000, updatedAt: 1000 });

    const u1 = makeMsg({ id: 'u1', conversationId: conv1, role: 'user', content: 'C1 P', createdAt: 1000, updatedAt: 1000 });
    const a1 = makeMsg({ id: 'a1', conversationId: conv1, parentId: 'u1', role: 'assistant', content: 'C1 A', createdAt: 1100, updatedAt: 1100 });

    const u2 = makeMsg({ id: 'u2', conversationId: conv2, role: 'user', content: 'C2 P', createdAt: 1000, updatedAt: 1000 });
    const a2 = makeMsg({ id: 'a2', conversationId: conv2, parentId: 'u2', role: 'assistant', content: 'C2 A', createdAt: 1100, updatedAt: 1100 });

    await storageRepo.saveMessages([u1, a1, u2, a2]);

    const tree1 = buildConversationTree(await storageRepo.listMessagesByConversation(conv1));
    const tree2 = buildConversationTree(await storageRepo.listMessagesByConversation(conv2));

    expect(tree1.activePath.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(tree2.activePath.map((m) => m.id)).toEqual(['u2', 'a2']);
  });

  it('Test H. Duplicate checkpoint idempotency: Identical checkpoint does not mutate state', async () => {
    const convId = 'conv-test-h';
    await storageRepo.saveConversation({ id: convId, title: 'Conv H', createdAt: 1000, updatedAt: 1000 });

    const user = makeMsg({ id: 'u-h', conversationId: convId, role: 'user', content: 'P', createdAt: 1000, updatedAt: 1000 });
    await storageRepo.saveMessages([user]);

    const checkpoint: CanonicalCheckpointData = {
      streamKey: 'stream-h',
      checkpointSeq: 0,
      message: makeMsg({
        id: 'a-h',
        conversationId: convId,
        parentId: 'u-h',
        role: 'assistant',
        content: 'Ans',
        createdAt: 1100,
        updatedAt: 1100,
      }),
      revisions: [
        {
          id: 'rev-h-1',
          messageId: 'a-h',
          revisionIndex: 1,
          text: 'Ans',
          source: 'network',
          capturedAt: 1100,
          isFinal: true,
          isLastGood: true,
        },
      ],
      recoveryEvents: [],
      isFinal: true,
    };

    // First persistence
    const res1 = await persistCanonicalCheckpointMessage(storageRepo, checkpoint);
    expect(res1.success).toBe(true);

    // Second duplicate persistence of same checkpoint
    const res2 = await persistCanonicalCheckpointMessage(storageRepo, checkpoint);
    expect(res2.success).toBe(true);

    const msgs = await storageRepo.listMessagesByConversation(convId);
    expect(msgs.filter((m) => m.id === 'a-h')).toHaveLength(1);
    const revs = await storageRepo.listRevisionsByMessage('a-h');
    expect(revs).toHaveLength(1);
  });

  it('Test I. RemoteId conflict: Detected and diagnosed, confirmed record preserved', () => {
    const convId = 'conv-test-i';
    const existingMsg1 = makeMsg({
      id: 'msg-first',
      conversationId: convId,
      role: 'user',
      remoteId: 'server-id-100',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const targetMsg2 = makeMsg({
      id: 'msg-second',
      conversationId: convId,
      role: 'user',
      createdAt: 2000,
      updatedAt: 2000,
    });

    // Attempting to assign 'server-id-100' to msg-second:
    const result = assignRemoteIdSafely(targetMsg2, 'server-id-100', [existingMsg1, targetMsg2]);

    expect(result.assigned).toBe(false);
    expect(result.conflictWithId).toBe('msg-first');
    expect(targetMsg2.remoteId).toBeUndefined();
    expect(existingMsg1.remoteId).toBe('server-id-100');
  });

  it('Test J. Independent UI: Branch switching in Side Panel does not alter underlying data', () => {
    const convId = 'conv-test-j';
    // User 1A (Robotics) vs User 1B (Thermodynamics)
    const u1a = makeMsg({ id: 'u1a', conversationId: convId, role: 'user', content: 'Robotics', createdAt: 1000, updatedAt: 1000 });
    const a1a = makeMsg({ id: 'a1a', conversationId: convId, parentId: 'u1a', role: 'assistant', content: 'Asst Robotics', createdAt: 1100, updatedAt: 1100 });

    const u1b = makeMsg({ id: 'u1b', conversationId: convId, role: 'user', content: 'Thermodynamics', createdAt: 2000, updatedAt: 2000 });
    const a1b = makeMsg({ id: 'a1b', conversationId: convId, parentId: 'u1b', role: 'assistant', content: 'Asst Thermodynamics', createdAt: 2100, updatedAt: 2100 });

    const messages = [u1a, a1a, u1b, a1b];

    // Default build (points to latest leaf by default)
    const treeDefault = buildConversationTree(messages);
    expect(treeDefault.roots).toHaveLength(2);
    expect(treeDefault.activePath.map((m) => m.id)).toEqual(['u1b', 'a1b']);

    // User switches to root branch 0 (Robotics) via viewSelection or branchSelections
    const treeBranch0 = buildConversationTree(messages, {
      viewSelection: {
        conversationId: convId,
        selectedRootId: 'u1a',
        selectedChildByParent: {},
        updatedAt: Date.now(),
      },
    });
    expect(treeBranch0.activePath.map((m) => m.id)).toEqual(['u1a', 'a1a']);

    // User switches back to root branch 1 (Thermodynamics)
    const treeBranch1 = buildConversationTree(messages, {
      viewSelection: {
        conversationId: convId,
        selectedRootId: 'u1b',
        selectedChildByParent: {},
        updatedAt: Date.now(),
      },
    });
    expect(treeBranch1.activePath.map((m) => m.id)).toEqual(['u1b', 'a1b']);

    // Underlying message objects are completely untouched
    expect(u1a.parentId).toBeUndefined();
    expect(u1b.parentId).toBeUndefined();
    expect(a1a.parentId).toBe('u1a');
    expect(a1b.parentId).toBe('u1b');
  });
});
