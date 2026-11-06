import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { buildConversationTree } from '../src/core/conversation-tree/tree';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import type { Message } from '../src/core/models';
import type { NormalizedHistoryMessage } from '../src/adapters/deepseek/history/types';
import { compareMessageOrder } from '../src/core/conversation-tree/tree';

function makeMsg(partial: Partial<Message> & { id: string; conversationId: string; role: 'user' | 'assistant' }): Message {
  return {
    identityState: 'provisional',
    status: 'finished',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  };
}

describe('Audit of commit d311eb8: Reproduction of Linkage Defects', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  // Exactly what background.ts in commit d311eb8 does for canonical checkpoints:
  async function backgroundCheckpointHandler_d311(checkpoint: any): Promise<void> {
    const targetConvId = checkpoint.conversation?.id || checkpoint.message.conversationId;
    if (checkpoint.message.role === 'assistant' && targetConvId) {
      const asstMsg = checkpoint.message;
      const remoteParent = asstMsg.remoteParentId ? String(asstMsg.remoteParentId) : undefined;
      const needsParentResolution =
        !asstMsg.parentId ||
        (remoteParent !== undefined && asstMsg.parentId === remoteParent);

      if (needsParentResolution) {
        const existingMsgs = await storageRepo.listMessagesByConversation(targetConvId);

        // 1. Direct match by remoteId of user message
        let resolvedParent = remoteParent
          ? existingMsgs.find(
              (m) => m.role === 'user' && m.remoteId && String(m.remoteId) === remoteParent
            )
          : undefined;

        // 2. Sibling assistant match
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

        // 3. Fallback for linear / single-user turn or last active user turn (DEFECT 1)
        if (!resolvedParent) {
          const userCandidates = existingMsgs.filter((m) => m.role === 'user');
          if (userCandidates.length === 1) {
            resolvedParent = userCandidates[0];
          } else if (userCandidates.length > 1) {
            const lastFinishedAsst = existingMsgs
              .filter((m) => m.role === 'assistant' && m.id !== asstMsg.id && m.parentId)
              .sort(compareMessageOrder)
              .at(-1);
            if (lastFinishedAsst?.parentId) {
              resolvedParent = existingMsgs.find((m) => m.id === lastFinishedAsst.parentId);
            }
          }
        }

        if (resolvedParent) {
          asstMsg.parentId = resolvedParent.id;
          // DEFECT 2: If parent user message lacked remoteId, populate it from remoteParent
          if (!resolvedParent.remoteId && remoteParent) {
            resolvedParent.remoteId = remoteParent;
            await storageRepo.saveMessages([resolvedParent]);
          }
        }
      }
    }
    await storageRepo.saveCanonicalCheckpoint(checkpoint);
  }

  it('Defect 1 & 2 Reproduction: Regenerating Turn 1 erroneously links to Turn 2 user and mutates its remoteId', async () => {
    const convId = 'conv-defect-1';

    // Conversation already has 2 turns:
    // Turn 1: User A (no remoteId yet) -> Assistant A1
    const userA = makeMsg({ id: 'user-a', conversationId: convId, role: 'user', content: 'Turn 1 prompt', createdAt: 1000, updatedAt: 1000 });
    const asstA1 = makeMsg({ id: 'asst-a1', conversationId: convId, role: 'assistant', parentId: 'user-a', remoteId: 'server-asst-a1', content: 'Turn 1 answer', createdAt: 1100, updatedAt: 1100 });
    const userB = makeMsg({ id: 'user-b', conversationId: convId, role: 'user', parentId: 'asst-a1', content: 'Turn 2 prompt', createdAt: 2000, updatedAt: 2000 });
    const asstB1 = makeMsg({ id: 'asst-b1', conversationId: convId, role: 'assistant', parentId: 'user-b', remoteId: 'server-asst-b1', content: 'Turn 2 answer', createdAt: 2100, updatedAt: 2100 });

    await storageRepo.saveMessages([userA, asstA1, userB, asstB1]);

    // Now user regenerates Turn 1!
    // Incoming assistant checkpoint for Turn 1 with remoteParentId: 'server-user-a'
    const newAsstA2 = makeMsg({
      id: 'asst-a2',
      conversationId: convId,
      role: 'assistant',
      remoteParentId: 'server-user-a', // this was Turn 1's user server id
      status: 'streaming',
      createdAt: 3000,
      updatedAt: 3000,
    });

    await backgroundCheckpointHandler_d311({
      streamKey: 'stream-regen-turn1',
      checkpointSeq: 0,
      message: newAsstA2,
      revisions: [],
      recoveryEvents: [],
      isFinal: false,
    });

    // In d311eb8 logic:
    // resolvedParent was found via fallback step 3 as userB (lastFinishedAsst.parentId)!
    // This test proves that d311eb8 wrongly attaches asst-a2 to user-b!
    const msgs = await storageRepo.listMessagesByConversation(convId);
    const savedAsstA2 = msgs.find((m) => m.id === 'asst-a2');
    const savedUserB = msgs.find((m) => m.id === 'user-b');

    // In d311eb8, savedAsstA2.parentId === 'user-b' (WRONG!).
    // For this reproduction, we assert that the d311 behavior indeed produced this defect:
    expect(savedAsstA2?.parentId).toBe('user-b');
    // And userB had its remoteId falsely mutated to 'server-user-a'!
    expect(savedUserB?.remoteId).toBe('server-user-a');
  });

  it('Defect 1 & 2 Fixed: Production persistCanonicalCheckpointMessage refuses to attach to wrong user and does not mutate remoteId', async () => {
    const convId = 'conv-defect-fixed';
    await storageRepo.saveConversation({ id: convId, title: 'Fixed', createdAt: 1000, updatedAt: 1000 });

    const userA = makeMsg({ id: 'user-a', conversationId: convId, role: 'user', content: 'Turn 1', createdAt: 1000, updatedAt: 1000 });
    const asstA1 = makeMsg({ id: 'asst-a1', conversationId: convId, role: 'assistant', parentId: 'user-a', content: 'Turn 1 ans', createdAt: 1100, updatedAt: 1100 });
    const userB = makeMsg({ id: 'user-b', conversationId: convId, role: 'user', parentId: 'asst-a1', content: 'Turn 2', createdAt: 2000, updatedAt: 2000 });
    const asstB1 = makeMsg({ id: 'asst-b1', conversationId: convId, role: 'assistant', parentId: 'user-b', content: 'Turn 2 ans', createdAt: 2100, updatedAt: 2100 });

    await storageRepo.saveMessages([userA, asstA1, userB, asstB1]);

    const newAsstA2 = makeMsg({
      id: 'asst-a2',
      conversationId: convId,
      role: 'assistant',
      remoteParentId: 'server-user-a',
      status: 'streaming',
      createdAt: 3000,
      updatedAt: 3000,
    });

    // Call REAL production checkpoint persister:
    const { persistCanonicalCheckpointMessage } = await import('../src/core/recorder/checkpoint-persister');
    await persistCanonicalCheckpointMessage(storageRepo, {
      streamKey: 'stream-regen-turn1',
      checkpointSeq: 0,
      message: newAsstA2,
      revisions: [],
      recoveryEvents: [],
      isFinal: false,
    });

    const msgs = await storageRepo.listMessagesByConversation(convId);
    const savedAsstA2 = msgs.find((m) => m.id === 'asst-a2');
    const savedUserB = msgs.find((m) => m.id === 'user-b');

    // In FIXED production code:
    // 1. asst-a2 is NOT falsely attached to user-b!
    expect(savedAsstA2?.parentId).toBeUndefined();
    // 2. user-b's remoteId is NOT mutated!
    expect(savedUserB?.remoteId).toBeUndefined();
  });

  it('Defect 3 Fixed: tree.ts does NOT attach user with unresolvable remoteParentId to candidateAssistantMsgs', () => {
    const convId = 'conv-defect-3';
    const userA = makeMsg({ id: 'u1', conversationId: convId, role: 'user', content: 'Turn 1', createdAt: 1000, updatedAt: 1000 });
    const asstA = makeMsg({ id: 'a1', conversationId: convId, parentId: 'u1', role: 'assistant', content: 'Turn 1 answer', createdAt: 1100, updatedAt: 1100 });
    const userB = makeMsg({ id: 'u2', conversationId: convId, parentId: 'a1', role: 'user', content: 'Turn 2', createdAt: 2000, updatedAt: 2000 });
    const asstB = makeMsg({ id: 'a2', conversationId: convId, parentId: 'u2', role: 'assistant', content: 'Turn 2 answer', createdAt: 2100, updatedAt: 2100 });

    const userOrphan = makeMsg({
      id: 'u-orphan',
      conversationId: convId,
      role: 'user',
      content: 'Branch from old turn with unresolvable remote parent',
      remoteParentId: 'unknown-server-parent-999',
      createdAt: 3000,
      updatedAt: 3000,
    });

    const tree = buildConversationTree([userA, asstA, userB, asstB, userOrphan]);

    // Fixed invariant: userOrphan must NOT be attached to a2!
    const node = tree.getNode('u-orphan');
    expect(node?.parent).toBeNull();
    expect(tree.unlinkedMessages.some((m) => m.id === 'u-orphan')).toBe(true);
  });

  it('Defect 4 Fixed: tree.ts strictly rejects invalid role parentage (USER -> USER or ASSISTANT -> ASSISTANT)', () => {
    const convId = 'conv-defect-4';
    const u1 = makeMsg({ id: 'u1', conversationId: convId, role: 'user', content: 'U1', createdAt: 1000, updatedAt: 1000 });
    const u2 = makeMsg({ id: 'u2', conversationId: convId, role: 'user', parentId: 'u1', content: 'U2', createdAt: 1050, updatedAt: 1050 });

    const a1 = makeMsg({ id: 'a1', conversationId: convId, role: 'assistant', parentId: 'u1', content: 'A1', createdAt: 1100, updatedAt: 1100 });
    const a2 = makeMsg({ id: 'a2', conversationId: convId, role: 'assistant', parentId: 'a1', content: 'A2', createdAt: 1200, updatedAt: 1200 });

    const tree = buildConversationTree([u1, u2, a1, a2]);

    // Fixed invariant: invalid role edges are rejected!
    const nodeU2 = tree.getNode('u2');
    const nodeA2 = tree.getNode('a2');
    expect(nodeU2?.parent).toBeNull();
    expect(nodeA2?.parent).toBeNull();

    expect(tree.unlinkedDetails.find((d) => d.message.id === 'u2')?.reason).toBe('invalid_role_parentage');
    expect(tree.unlinkedDetails.find((d) => d.message.id === 'a2')?.reason).toBe('invalid_role_parentage');
  });

  it('Defect 5 Fixed: HistoryReconciler requires strong evidence and does not match wrong provisional assistant', async () => {
    const convId = 'conv-defect-5';
    const reconciler = new HistoryReconciler(storageRepo);

    const u1 = makeMsg({ id: 'u1', conversationId: convId, role: 'user', content: 'Prompt 1', createdAt: 1000, updatedAt: 1000 });
    const a1 = makeMsg({ id: 'a1', conversationId: convId, role: 'assistant', parentId: 'u1', content: 'Answer 1', createdAt: 1100, updatedAt: 1100 });

    const u2 = makeMsg({ id: 'u2', conversationId: convId, role: 'user', parentId: 'a1', remoteId: 'server-user-2', content: 'Prompt 2', createdAt: 2000, updatedAt: 2000 });
    const a2 = makeMsg({ id: 'a2', conversationId: convId, role: 'assistant', parentId: 'u2', remoteParentId: 'server-user-2', content: 'Answer 2', createdAt: 2100, updatedAt: 2100 });

    await storageRepo.saveConversation({ id: convId, title: 'Defect 5 session', createdAt: 1000, updatedAt: 2100 });
    await storageRepo.saveMessages([u1, a1, u2, a2]);

    const historyMsgTurn2: NormalizedHistoryMessage = {
      messageId: 'server-asst-2',
      parentId: 'server-user-2',
      role: 'assistant',
      status: 'finished',
      createdAt: 2100,
      text: 'Answer 2',
      isFiltered: false,
      fragmentsCount: 1,
    };

    const session = {
      sessionId: convId,
      title: 'Defect 5 session',
      updatedAt: 2100,
      pinned: false,
    };

    await reconciler.reconcile({ session, messages: [historyMsgTurn2] });

    const msgs = await storageRepo.listMessagesByConversation(convId);
    const savedA1 = msgs.find((m) => m.id === 'a1');
    const savedA2 = msgs.find((m) => m.id === 'a2');

    // In fixed code:
    // a1 (Answer 1) must NEVER be matched to server-asst-2!
    expect(savedA1?.remoteId).toBeUndefined();
    // a2 (Answer 2) matches server-asst-2 because content matches!
    expect(savedA2?.remoteId).toBe('server-asst-2');
  });
});
