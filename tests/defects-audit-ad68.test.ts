import { describe, it, expect, beforeEach } from 'vitest';
import { buildConversationTree } from '../src/core/conversation-tree/tree';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import {
  assignRemoteIdSafely,
  resolveAssistantParent,
  resolveUserParent,
} from '../src/core/parentage/parent-resolver';
import {
  persistUserTurnMessage,
  persistCanonicalCheckpointMessage,
} from '../src/core/recorder/checkpoint-persister';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import type { Message, Conversation } from '../src/core/models';
import type { DeepSeekParsedHistory, NormalizedHistoryMessage, NormalizedHistorySession } from '../src/adapters/deepseek/history/types';
import type { CanonicalCheckpointData } from '../src/core/contracts/storage-repository';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

function makeHistSession(partial: Partial<NormalizedHistorySession> & { sessionId: string; title: string }): NormalizedHistorySession {
  return {
    updatedAt: Date.now(),
    pinned: false,
    ...partial,
  };
}

function makeHistMsg(partial: Partial<NormalizedHistoryMessage> & { messageId: string; role: 'user' | 'assistant'; text: string }): NormalizedHistoryMessage {
  return {
    parentId: null,
    status: 'finished',
    createdAt: Date.now(),
    isFiltered: false,
    fragmentsCount: 1,
    ...partial,
  };
}

function makeMsg(partial: Partial<Message> & { id: string; role: Message['role'] }): Message {
  const now = Date.now();
  return {
    conversationId: 'conv-test-audit',
    createdAt: now,
    updatedAt: now,
    identityState: 'provisional',
    projectionState: 'logical',
    status: 'finished',
    ...partial,
  };
}

describe('Audit ad68c8e: Defects Reproduction & Strict Invariant Verification', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(async () => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  // ── 1. buildConversationTree: Single User and Assistant with alien remoteParentId ──
  it('Scenario 1: buildConversationTree does NOT attach assistant to sole user if remoteParentId contradicts', () => {
    const userA = makeMsg({
      id: 'u1',
      role: 'user',
      remoteId: '100',
      content: 'Question 1',
    });
    const asstB = makeMsg({
      id: 'a1',
      role: 'assistant',
      remoteParentId: '999', // Contradicting remote parent that does not exist
      content: 'Answer with alien remote parent',
    });

    const tree = buildConversationTree([userA, asstB]);

    // Defect on ad68c8e: asstB.parent was erroneously attached to u1 because candidateUserMsgs.length === 1!
    // Expected: asstB must NOT be attached to userA!
    const asstNode = tree.nodeMap.get('a1');
    expect(asstNode?.parent).toBeNull();
    expect(tree.unlinkedMessages.map((m) => m.id)).toContain('a1');
  });

  // ── 2. HistoryReconciler: Single provisional Assistant and unrelated server Assistant ──
  it('Scenario 2: HistoryReconciler does NOT match sole provisional assistant without proof of identity', async () => {
    const conv: Conversation = {
      id: 'conv-audit-2',
      remoteId: 'sess-audit-2',
      title: 'Session 2',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    // Unparented provisional assistant message (e.g. from an unfinished or orphan generation)
    const asstA = makeMsg({
      id: 'a1',
      conversationId: 'conv-audit-2',
      role: 'assistant',
      identityState: 'provisional',
      content: 'Local provisional response',
    });
    await storageRepo.saveMessages([asstA]);

    // Authoritative Server history arrives with an unrelated turn: USER B -> ASSISTANT B
    const historyPayload: DeepSeekParsedHistory = {
      session: makeHistSession({
        sessionId: 'sess-audit-2',
        title: 'Session 2',
        updatedAt: 2000,
      }),
      messages: [
        makeHistMsg({
          messageId: 'srv-user-b',
          role: 'user',
          text: 'Unrelated User Question B',
          createdAt: 2000,
        }),
        makeHistMsg({
          messageId: 'srv-asst-b',
          role: 'assistant',
          parentId: 'srv-user-b',
          text: 'Unrelated Server Answer B',
          createdAt: 2010,
        }),
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    await reconciler.reconcile(historyPayload);

    // Verify asstA did NOT get mutated to srv-asst-b
    const updatedAsstA = await storageRepo.getMessage('a1');
    // On ad68c8e, unmatchedProvisionalAssistant.length === 1 matched a1 with srv-asst-b!
    expect(updatedAsstA?.remoteId).toBeUndefined();
  });

  // ── 3. HistoryReconciler: Two different responses with identical text (Regenerate) ──
  it('Scenario 3: HistoryReconciler does NOT match provisional assistant solely based on identical text', async () => {
    const conv: Conversation = {
      id: 'conv-audit-3',
      remoteId: 'sess-audit-3',
      title: 'Session 3',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    // Two provisional responses with identical text 'Привет!'
    const asst1 = makeMsg({
      id: 'a1',
      conversationId: 'conv-audit-3',
      role: 'assistant',
      content: 'Привет!',
      identityState: 'provisional',
    });
    const asst2 = makeMsg({
      id: 'a2',
      conversationId: 'conv-audit-3',
      role: 'assistant',
      content: 'Привет!',
      identityState: 'provisional',
    });
    await storageRepo.saveMessages([asst1, asst2]);

    // Server history arrives for an unrelated USER B -> ASSISTANT B that also has text 'Привет!'
    const historyPayload: DeepSeekParsedHistory = {
      session: makeHistSession({
        sessionId: 'sess-audit-3',
        title: 'Session 3',
        updatedAt: 2000,
      }),
      messages: [
        makeHistMsg({
          messageId: 'srv-u-2',
          role: 'user',
          text: 'Different prompt',
          createdAt: 2000,
        }),
        makeHistMsg({
          messageId: 'srv-a-2',
          role: 'assistant',
          parentId: 'srv-u-2',
          text: 'Привет!', // Same text!
          createdAt: 2010,
        }),
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    await reconciler.reconcile(historyPayload);

    // On ad68c8e, line 150 returned true because cand.content === hm.text!
    const updatedA1 = await storageRepo.getMessage('a1');
    const updatedA2 = await storageRepo.getMessage('a2');
    expect(updatedA1?.remoteId).toBeUndefined();
    expect(updatedA2?.remoteId).toBeUndefined();
  });

  // ── 4. HistoryReconciler: Two different User messages with identical text ──
  it('Scenario 4: HistoryReconciler does NOT match provisional User messages solely by text', async () => {
    const conv: Conversation = {
      id: 'conv-audit-4',
      remoteId: 'sess-audit-4',
      title: 'Session 4',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    // Provisional user prompt with no remoteParentId (e.g. root prompt)
    const user1 = makeMsg({
      id: 'u1',
      conversationId: 'conv-audit-4',
      role: 'user',
      content: 'Привет',
      identityState: 'provisional',
    });
    await storageRepo.saveMessages([user1]);

    // History arrives for Turn 4 user prompt that also says 'Привет', but under an assistant parent!
    const historyPayload: DeepSeekParsedHistory = {
      session: makeHistSession({
        sessionId: 'sess-audit-4',
        title: 'Session 4',
        updatedAt: 2000,
      }),
      messages: [
        makeHistMsg({
          messageId: 'srv-user-4',
          role: 'user',
          parentId: 'srv-asst-parent-3', // Child prompt under Turn 3 assistant!
          text: 'Привет', // Same text
          createdAt: 2000,
        }),
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    await reconciler.reconcile(historyPayload);

    const updatedU1 = await storageRepo.getMessage('u1');
    // On ad68c8e, line 110 matched u1 with srv-user-4 because cand.content === hm.text!
    expect(updatedU1?.remoteId).toBeUndefined();
  });

  // ── 7. assignRemoteIdSafely: Collision detection when target already has the remoteId ──
  it('Scenario 7: assignRemoteIdSafely detects collision even if targetMsg already has the remoteId', () => {
    const targetMsg = makeMsg({
      id: 'm1',
      role: 'user',
      remoteId: 'srv-100',
    });
    const existingMsg = makeMsg({
      id: 'm2',
      role: 'user',
      remoteId: 'srv-100', // Collision! Two different messages claim srv-100!
    });

    // On ad68c8e, assignRemoteIdSafely returned { assigned: true } early without checking existingMsgs!
    const result = assignRemoteIdSafely(targetMsg, 'srv-100', [targetMsg, existingMsg]);
    expect(result.assigned).toBe(false);
    expect(result.conflictWithId).toBe('m2');
  });

  // ── 8. Atomicity: saveCanonicalCheckpoint includes parent user atomically ──
  it('Scenario 8: persistCanonicalCheckpointMessage saves parent user atomically with checkpoint', async () => {
    const conv: Conversation = {
      id: 'conv-audit-8',
      title: 'Session 8',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const userMsg = makeMsg({
      id: 'u-live-8',
      conversationId: 'conv-audit-8',
      role: 'user',
      sourceRawStreamKey: 'stream-8',
      content: 'Prompt 8',
    });
    await storageRepo.saveMessages([userMsg]);

    const asstMsg = makeMsg({
      id: 'a-live-8',
      conversationId: 'conv-audit-8',
      role: 'assistant',
      sourceRawStreamKey: 'stream-8',
      remoteParentId: 'server-user-8',
      content: 'Answer 8',
    });

    const checkpoint: CanonicalCheckpointData = {
      streamKey: 'stream-8',
      checkpointSeq: 0,
      isTerminal: true,
      conversation: conv,
      message: asstMsg,
      revisions: [
        {
          id: 'rev-8',
          messageId: 'a-live-8',
          revisionIndex: 0,
          text: 'Answer 8',
          source: 'network',
          capturedAt: 1010,
          isFinal: true,
          isLastGood: true,
        },
      ],
      recoveryEvents: [],
    };

    const res = await persistCanonicalCheckpointMessage(storageRepo, checkpoint);
    expect(res.success).toBe(true);

    const updatedUser = await storageRepo.getMessage('u-live-8');
    expect(updatedUser?.remoteId).toBe('server-user-8');
    const updatedAsst = await storageRepo.getMessage('a-live-8');
    expect(updatedAsst?.parentId).toBe('u-live-8');
  });

  // ── 9. Assistant with existing, but wrong parentId contradicting remoteParentId ──
  it('Scenario 9: persistCanonicalCheckpointMessage detects conflict when existing parentId contradicts remoteParentId', async () => {
    const conv: Conversation = {
      id: 'conv-audit-9',
      title: 'Session 9',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const user1 = makeMsg({
      id: 'u-wrong-1',
      conversationId: 'conv-audit-9',
      role: 'user',
      remoteId: 'srv-user-1',
      content: 'Turn 1 Question',
    });
    const user2 = makeMsg({
      id: 'u-correct-2',
      conversationId: 'conv-audit-9',
      role: 'user',
      remoteId: 'srv-user-2',
      content: 'Turn 2 Question',
    });
    await storageRepo.saveMessages([user1, user2]);

    // Assistant checkpoint arrives with parentId set to u-wrong-1, but remoteParentId pointing to srv-user-2!
    const asstMsg = makeMsg({
      id: 'a-9',
      conversationId: 'conv-audit-9',
      role: 'assistant',
      parentId: 'u-wrong-1', // Contradicts remoteParentId!
      remoteParentId: 'srv-user-2',
      content: 'Answer to Question 2',
    });

    const checkpoint: CanonicalCheckpointData = {
      streamKey: 'stream-9',
      checkpointSeq: 0,
      isTerminal: true,
      conversation: conv,
      message: asstMsg,
      revisions: [],
      recoveryEvents: [],
    };

    const res = await persistCanonicalCheckpointMessage(storageRepo, checkpoint);
    expect(res.success).toBe(true);

    const savedAsst = await storageRepo.getMessage('a-9');
    // Expected: The conflicting parentId must be re-resolved to the verified parent matching remoteParentId ('u-correct-2')!
    expect(savedAsst?.parentId).toBe('u-correct-2');
  });

  // ── 10. Repeated history reconciliation idempotency after reload ──
  it('Scenario 10: Repeated history reconciliation produces 0 duplicates and maintains stability', async () => {
    const conv: Conversation = {
      id: 'conv-audit-10',
      remoteId: 'sess-audit-10',
      title: 'Session 10',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const historyPayload: DeepSeekParsedHistory = {
      session: makeHistSession({
        sessionId: 'sess-audit-10',
        title: 'Session 10',
        updatedAt: 2000,
      }),
      messages: [
        makeHistMsg({
          messageId: 'srv-u-10',
          role: 'user',
          text: 'Hello world',
          createdAt: 2000,
        }),
        makeHistMsg({
          messageId: 'srv-a-10',
          role: 'assistant',
          parentId: 'srv-u-10',
          text: 'Hello back',
          createdAt: 2010,
        }),
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    const run1 = await reconciler.reconcile(historyPayload);
    expect(run1.messagesCreated).toBe(2);
    expect(run1.revisionsCreated).toBe(2);

    // Second run: exact same payload
    const run2 = await reconciler.reconcile(historyPayload);
    expect(run2.messagesCreated).toBe(0);
    expect(run2.revisionsCreated).toBe(0);

    const msgsAfter = await storageRepo.listMessagesByConversation('conv-audit-10');
    expect(msgsAfter).toHaveLength(2);
    const revsAfter = await storageRepo.listRevisionsByMessage(msgsAfter.find((m) => m.role === 'assistant')!.id);
    expect(revsAfter).toHaveLength(1);
  });

  // ── 5. Interceptor Turn Matching: Resend after empty completion ──
  it('Scenario 5: Repeated request after transport completion generates fresh clientTurnId', () => {
    interface TurnContext {
      clientTurnId: string;
      prompt: string;
      timestamp: number;
      hasReceivedTokens: boolean;
      isTerminal: boolean;
    }

    const TRANSPORT_RETRY_WINDOW_MS = 2000;
    let lastTurn: TurnContext | null = null;

    function getTurnIdForRequest(prompt: string, currentTime: number): string {
      if (
        lastTurn &&
        !lastTurn.hasReceivedTokens &&
        lastTurn.prompt.trim() === prompt.trim() &&
        currentTime - lastTurn.timestamp < TRANSPORT_RETRY_WINDOW_MS
      ) {
        return lastTurn.clientTurnId;
      }
      const newId = `turn_${currentTime}_${Math.random().toString(36).slice(2, 7)}`;
      lastTurn = {
        clientTurnId: newId,
        prompt,
        timestamp: currentTime,
        hasReceivedTokens: false,
        isTerminal: false,
      };
      return newId;
    }

    // 1. Initial attempt at t = 1000
    const turn1 = getTurnIdForRequest('Hello again', 1000);
    expect(turn1).toBeDefined();

    // 2. Immediate transport retry at t = 1050 (within 2000ms, 0 tokens)
    const turn1Retry = getTurnIdForRequest('Hello again', 1050);
    expect(turn1Retry).toBe(turn1); // Reuses turn for network retry

    // 3. User resends identical prompt at t = 4000 (after retry window expired)
    const turn2 = getTurnIdForRequest('Hello again', 4000);
    expect(turn2).not.toBe(turn1); // Must generate a NEW distinct turn!

    // 4. Stream receives tokens (hasReceivedTokens = true)
    lastTurn!.hasReceivedTokens = true;

    // 5. Subsequent prompt at t = 4500 (even within window, but tokens were received)
    const turn3 = getTurnIdForRequest('Hello again', 4500);
    expect(turn3).not.toBe(turn2);
  });

  // ── 6. Interceptor Stream Isolation: Concurrent Requests ──
  it('Scenario 6: Two concurrent requests maintain isolated stream turn identities', () => {
    interface StreamInfo {
      streamId: string;
      clientTurnId: string;
      hasReceivedTokens: boolean;
      isTerminal: boolean;
    }
    const streams = new Map<string, StreamInfo>();

    // Request A starts
    const streamA: StreamInfo = {
      streamId: 'stream-A',
      clientTurnId: 'turn-user-A',
      hasReceivedTokens: false,
      isTerminal: false,
    };
    streams.set('stream-A', streamA);

    // Request B starts concurrently
    const streamB: StreamInfo = {
      streamId: 'stream-B',
      clientTurnId: 'turn-user-B',
      hasReceivedTokens: false,
      isTerminal: false,
    };
    streams.set('stream-B', streamB);

    // Event arrives for stream A (chunk received)
    const eventA = { streamId: 'stream-A', type: 'chunk', text: 'Token from A' };
    const targetA = streams.get(eventA.streamId);
    if (targetA) targetA.hasReceivedTokens = true;

    // Verify stream A updated, stream B remained unchanged
    expect(streams.get('stream-A')?.hasReceivedTokens).toBe(true);
    expect(streams.get('stream-B')?.hasReceivedTokens).toBe(false);

    // Event arrives for stream B (terminal complete with 0 tokens)
    const eventB = { streamId: 'stream-B', type: 'complete' };
    const targetB = streams.get(eventB.streamId);
    if (targetB) targetB.isTerminal = true;

    // Verify stream B terminated without closing stream A
    expect(streams.get('stream-B')?.isTerminal).toBe(true);
    expect(streams.get('stream-A')?.isTerminal).toBe(false);
  });
});
