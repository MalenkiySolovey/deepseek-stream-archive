import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { persistCanonicalCheckpointMessage } from '../src/core/recorder/checkpoint-persister';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { mergeCanonicalMessage } from '../src/core/models/message';
import { TurnIdentityCoordinator } from '../src/transport/request-identity';
import { buildConversationTree } from '../src/core/conversation-tree/tree';
import type { Message, Conversation } from '../src/core/models';
import type {
  DeepSeekParsedHistory,
  NormalizedHistorySession,
  NormalizedHistoryMessage,
} from '../src/adapters/deepseek/history/types';

describe('Audit of commit 0347ad0: Verification of Identity, Tree Linkage & Memory Invariants', () => {
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    storageRepo = new IndexedDbStorageRepository(new IDBFactory());
  });

  const makeMsg = (overrides: Partial<Message>): Message => ({
    id: 'msg-default',
    conversationId: 'conv-test',
    role: 'user',
    status: 'finished',
    identityState: 'provisional',
    projectionState: 'provisional_logical',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  });

  const makeHistSession = (sessionId: string): NormalizedHistorySession => ({
    sessionId,
    title: 'Test Session',
    updatedAt: 1000,
    pinned: false,
  });

  const makeHistMsg = (overrides: Partial<NormalizedHistoryMessage>): NormalizedHistoryMessage => ({
    messageId: 'hmsg-default',
    parentId: null,
    role: 'user',
    status: 'finished',
    createdAt: 1000,
    text: 'Hello',
    isFiltered: false,
    fragmentsCount: 1,
    ...overrides,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 1: Unlinking incorrect parentage upon remoteParentId conflict
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 1: Canonical checkpoint persister unlinks incorrect parentId when remoteParentId conflicts', async () => {
    const convId = 'conv-scenario-1';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Scenario 1 Session',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // 1. Create User A and User B
    const userA = makeMsg({
      id: 'user-a',
      conversationId: convId,
      role: 'user',
      remoteId: 'remote-user-a',
      content: 'Prompt A',
    });
    await storageRepo.saveMessage(userA);

    // 2. Save Assistant with incorrect parentId = User A
    const asst = makeMsg({
      id: 'asst-1',
      conversationId: convId,
      role: 'assistant',
      parentId: 'user-a',
      content: 'Assistant answer',
      status: 'streaming',
    });
    await storageRepo.saveMessage(asst);

    // 3. Checkpoint arrives with server remoteParentId pointing to remote-user-b (not User A)
    // 4. User B is not yet known/confirmed in DB
    const checkpoint = {
      streamKey: 'stream-1:scenario-1',
      checkpointSeq: 0,
      conversation: { id: convId, title: 'Scenario 1 Session', createdAt: 1000, updatedAt: 1000 },
      message: {
        ...asst,
        remoteParentId: 'remote-user-b',
      },
      revisions: [],
    };

    // 5. Run real canonical checkpoint persistence mechanism
    await persistCanonicalCheckpointMessage(storageRepo, checkpoint);

    // 6. Re-read Assistant from IndexedDB
    const reloadedAsst = await storageRepo.getMessage('asst-1');
    expect(reloadedAsst).not.toBeNull();

    // EXPECTED: The false parentId 'user-a' must NO LONGER be present in the saved message!
    expect(reloadedAsst!.parentId).toBeUndefined();

    // Second check: When confirmed User B appears, Assistant receives the correct link
    const userB = makeMsg({
      id: 'user-b',
      conversationId: convId,
      role: 'user',
      remoteId: 'remote-user-b',
      content: 'Prompt B',
    });
    await storageRepo.saveMessage(userB);

    const checkpoint2 = {
      streamKey: 'stream-1:scenario-1',
      checkpointSeq: 1,
      conversation: { id: convId, title: 'Scenario 1 Session', createdAt: 1000, updatedAt: 2000 },
      message: {
        ...asst,
        remoteParentId: 'remote-user-b',
      },
      revisions: [],
    };

    await persistCanonicalCheckpointMessage(storageRepo, checkpoint2);

    const reloadedAsst2 = await storageRepo.getMessage('asst-1');
    expect(reloadedAsst2!.parentId).toBe('user-b');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 2: Prevention of false matching for Regenerate responses
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 2: HistoryReconciler must NOT falsely match provisional Assistant B to server-A', async () => {
    const convId = 'conv-scenario-2';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Scenario 2 Session',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const user1 = makeMsg({
      id: 'user-1',
      conversationId: convId,
      role: 'user',
      remoteId: 'remote-u1',
      content: 'User Prompt',
    });
    const asstB = makeMsg({
      id: 'asst-b-local',
      conversationId: convId,
      role: 'assistant',
      parentId: 'user-1',
      remoteParentId: 'remote-u1',
      content: 'Второй ответ',
      status: 'finished',
      identityState: 'provisional',
    });
    await storageRepo.saveMessages([user1, asstB]);

    // Server history returns Assistant A BEFORE Assistant B
    const parsedHistory: DeepSeekParsedHistory = {
      session: makeHistSession(convId),
      messages: [
        makeHistMsg({
          messageId: 'remote-u1',
          role: 'user',
          text: 'User Prompt',
          parentId: null,
        }),
        makeHistMsg({
          messageId: 'server-A',
          role: 'assistant',
          parentId: 'remote-u1',
          text: 'Первый ответ', // Different text!
        }),
        makeHistMsg({
          messageId: 'server-B',
          role: 'assistant',
          parentId: 'remote-u1',
          text: 'Второй ответ', // Matches asstB!
        }),
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    const { plan } = await reconciler.createPlan(parsedHistory);
    await storageRepo.applyHistoryReconciliationPlan(plan);

    const reloadedAsstB = await storageRepo.getMessage('asst-b-local');
    expect(reloadedAsstB).not.toBeNull();
    expect(reloadedAsstB!.remoteId).toBe('server-B');

    const allMsgs = await storageRepo.listMessagesByConversation(convId);
    const msgServerA = allMsgs.find((m) => m.remoteId === 'server-A');
    expect(msgServerA).toBeDefined();
    expect(msgServerA!.id).not.toBe('asst-b-local');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 2b: Ambiguous Regenerate responses with identical text
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 2b: Ambiguous Regenerate responses with identical text must NOT be falsely merged', async () => {
    const convId = 'conv-scenario-2b';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Scenario 2b Session',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const user1 = makeMsg({
      id: 'user-1',
      conversationId: convId,
      role: 'user',
      remoteId: 'remote-u1',
      content: 'Same Prompt',
    });
    const asstProv = makeMsg({
      id: 'asst-local-ok',
      conversationId: convId,
      role: 'assistant',
      parentId: 'user-1',
      remoteParentId: 'remote-u1',
      content: 'OK',
      status: 'finished',
      identityState: 'provisional',
    });
    await storageRepo.saveMessages([user1, asstProv]);

    // Server history contains TWO responses under user-1 BOTH with text 'OK'
    const parsedHistory: DeepSeekParsedHistory = {
      session: makeHistSession(convId),
      messages: [
        makeHistMsg({
          messageId: 'remote-u1',
          role: 'user',
          text: 'Same Prompt',
        }),
        makeHistMsg({
          messageId: 'server-ok-1',
          role: 'assistant',
          parentId: 'remote-u1',
          text: 'OK',
        }),
        makeHistMsg({
          messageId: 'server-ok-2',
          role: 'assistant',
          parentId: 'remote-u1',
          text: 'OK',
        }),
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    const { plan } = await reconciler.createPlan(parsedHistory);
    await storageRepo.applyHistoryReconciliationPlan(plan);

    // Because it is ambiguous whether local-ok is server-ok-1 or server-ok-2,
    // neither should be guessed! Both server messages must exist separately.
    const allMsgs = await storageRepo.listMessagesByConversation(convId);
    const server1 = allMsgs.find((m) => m.remoteId === 'server-ok-1');
    const server2 = allMsgs.find((m) => m.remoteId === 'server-ok-2');
    expect(server1).toBeDefined();
    expect(server2).toBeDefined();
    expect(server1!.id).not.toBe(server2!.id);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 2c: Ambiguous root user prompts on server
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 2c: Ambiguous root user prompts with identical text on server must NOT be falsely merged', async () => {
    const convId = 'conv-scenario-2c';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Scenario 2c Session',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Locally we have one root user message with text 'Hello Root'
    const localRoot = makeMsg({
      id: 'local-root-1',
      conversationId: convId,
      role: 'user',
      content: 'Hello Root',
      parentId: undefined,
      remoteParentId: undefined,
    });
    await storageRepo.saveMessage(localRoot);

    // Server has TWO separate root user messages with text 'Hello Root' (e.g. root fork edits)
    const parsedHistory: DeepSeekParsedHistory = {
      session: makeHistSession(convId),
      messages: [
        makeHistMsg({
          messageId: 'server-root-A',
          role: 'user',
          parentId: null,
          text: 'Hello Root',
        }),
        makeHistMsg({
          messageId: 'server-root-B',
          role: 'user',
          parentId: null,
          text: 'Hello Root',
        }),
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    const { plan } = await reconciler.createPlan(parsedHistory);
    await storageRepo.applyHistoryReconciliationPlan(plan);

    // Both server root messages must be created separately; local-root-1 should not be falsely merged to root-A
    const allMsgs = await storageRepo.listMessagesByConversation(convId);
    const rootA = allMsgs.find((m) => m.remoteId === 'server-root-A');
    const rootB = allMsgs.find((m) => m.remoteId === 'server-root-B');
    expect(rootA).toBeDefined();
    expect(rootB).toBeDefined();
    expect(rootA!.id).not.toBe(rootB!.id);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 3: Real Production TurnIdentityCoordinator - Request Lifecycle
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 3: Distinguishes terminal 0-token completion from in-flight retry (User Mandatory Scenario)', () => {
    const coordinator = new TurnIdentityCoordinator({ transportRetryWindowMs: 2000 });

    // t = 0 ms: User sends "Привет"
    const turn1 = coordinator.resolveTurnForOutgoingRequest({
      prompt: 'Привет',
      sessionId: 'sess-1',
      parentTurnId: null,
      isRegenRequest: false,
      now: 1000,
    });
    expect(turn1.clientTurnId).toMatch(/^turn_user_/);
    expect(turn1.isReused).toBe(false);

    // t = 150 ms: Server terminates request without text (0 tokens)
    coordinator.handleTransportStreamEvent({
      producerSessionId: 'prod-1',
      streamId: 'stream-1',
      sequence: 1,
      streamSequence: 1,
      timestamp: 1150,
      transport: 'fetch',
      type: 'complete',
      metadata: { method: 'POST', url: '/api/chat', clientTurnId: turn1.clientTurnId },
    });

    // t = 500 ms: User sends "Привет" again
    const turn2 = coordinator.resolveTurnForOutgoingRequest({
      prompt: 'Привет',
      sessionId: 'sess-1',
      parentTurnId: null,
      isRegenRequest: false,
      now: 1500,
    });

    // EXPECTED: Two separate logical user messages with DIFFERENT clientTurnIds!
    expect(turn2.clientTurnId).not.toBe(turn1.clientTurnId);
    expect(turn2.isReused).toBe(false);
  });

  it('Scenario 3b: In-flight transport retry reuses clientTurnId within retry window', () => {
    const coordinator = new TurnIdentityCoordinator({ transportRetryWindowMs: 2000 });

    // t = 0 ms: Initial send
    const turn1 = coordinator.resolveTurnForOutgoingRequest({
      prompt: 'Prompt with retry',
      sessionId: 'sess-retry',
      parentTurnId: null,
      isRegenRequest: false,
      now: 1000,
    });

    // Request is STILL IN-FLIGHT (!isTerminal), 0 tokens received so far.
    // DeepSeek client re-sends at t = 200 ms (transport retry):
    const turn2 = coordinator.resolveTurnForOutgoingRequest({
      prompt: 'Prompt with retry',
      sessionId: 'sess-retry',
      parentTurnId: null,
      isRegenRequest: false,
      now: 1200,
    });

    // In-flight retry MUST reuse turn identity!
    expect(turn2.clientTurnId).toBe(turn1.clientTurnId);
    expect(turn2.isReused).toBe(true);
  });

  it('Scenario 3c: Aborted or filtered streams seal turn identity against subsequent reuse', () => {
    const coordinator = new TurnIdentityCoordinator({ transportRetryWindowMs: 2000 });

    const turn1 = coordinator.resolveTurnForOutgoingRequest({
      prompt: 'Aborted Prompt',
      sessionId: 'sess-abort',
      parentTurnId: null,
      isRegenRequest: false,
      now: 1000,
    });

    // User clicks Stop (abort)
    coordinator.handleTransportStreamEvent({
      producerSessionId: 'prod-1',
      streamId: 'stream-abort',
      sequence: 1,
      streamSequence: 1,
      timestamp: 1100,
      transport: 'fetch',
      type: 'abort',
      metadata: { method: 'POST', url: '/api/chat', clientTurnId: turn1.clientTurnId },
    });

    // Subsequent user send must get a fresh turn
    const turn2 = coordinator.resolveTurnForOutgoingRequest({
      prompt: 'Aborted Prompt',
      sessionId: 'sess-abort',
      parentTurnId: null,
      isRegenRequest: false,
      now: 1300,
    });

    expect(turn2.clientTurnId).not.toBe(turn1.clientTurnId);
  });

  it('Scenario 3d: Concurrent generations are isolated and receive distinct clientTurnIds', () => {
    const coordinator = new TurnIdentityCoordinator();

    const turnA = coordinator.resolveTurnForOutgoingRequest({
      prompt: 'Query A',
      sessionId: 'sess-A',
      parentTurnId: null,
      isRegenRequest: false,
      now: 1000,
    });

    const turnB = coordinator.resolveTurnForOutgoingRequest({
      prompt: 'Query B',
      sessionId: 'sess-B',
      parentTurnId: null,
      isRegenRequest: false,
      now: 1010,
    });

    expect(turnA.clientTurnId).not.toBe(turnB.clientTurnId);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 4: Memory Leak Prevention & Bounded FIFO Body Map
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 4: TurnIdentityCoordinator bounds request body map to max 50 entries and prunes expired', () => {
    const coordinator = new TurnIdentityCoordinator({
      maxBodyEntries: 50,
      bodyEntryTtlMs: 5000,
    });

    const baseTime = 1000;
    // Add 100 consecutive request bodies (simulating hundreds of generations)
    for (let i = 0; i < 100; i++) {
      const bodyObj = { prompt: `Prompt number ${i}`, chat_session_id: `sess_${i}` };
      coordinator.recordRequestBody(bodyObj, `turn_${i}`, baseTime + i * 10);
    }

    // Upper bound strictly enforced: never exceeds 50!
    expect(coordinator.getBodyMapSize()).toBeLessThanOrEqual(50);

    // Pruning expired entries: advance time by 10 seconds (> TTL 5000ms)
    coordinator.pruneExpiredBodyEntries(baseTime + 20_000);
    expect(coordinator.getBodyMapSize()).toBe(0);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 5: Full Conversation Tree Consistency (Edit, Regenerate, Linear)
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 5: Multi-branch conversation tree remains stable across Edit and Regenerate', async () => {
    const convId = 'conv-tree-stability';
    await storageRepo.saveConversation({
      id: convId,
      title: 'Tree Stability Session',
      createdAt: 1000,
      updatedAt: 5000,
    });

    // 1. Root prompt: User 1A -> Asst 1A
    const u1a = makeMsg({ id: 'u1a', conversationId: convId, role: 'user', content: 'User 1A', createdAt: 1000 });
    const a1a = makeMsg({ id: 'a1a', conversationId: convId, role: 'assistant', parentId: 'u1a', content: 'Asst 1A', createdAt: 1100 });

    // 2. Linear continuation: User 2 -> Asst 2
    const u2 = makeMsg({ id: 'u2', conversationId: convId, role: 'user', parentId: 'a1a', content: 'User 2', createdAt: 2000 });
    const a2 = makeMsg({ id: 'a2', conversationId: convId, role: 'assistant', parentId: 'u2', content: 'Asst 2', createdAt: 2100 });

    // 3. Edit fork of Root: User 1B -> Asst 1B
    const u1b = makeMsg({ id: 'u1b', conversationId: convId, role: 'user', content: 'User 1B (Edited)', createdAt: 3000 });
    const a1b = makeMsg({ id: 'a1b', conversationId: convId, role: 'assistant', parentId: 'u1b', content: 'Asst 1B', createdAt: 3100 });

    // 4. Regenerate of Asst 1B: Asst 1B-2 (sibling under u1b)
    const a1b2 = makeMsg({ id: 'a1b2', conversationId: convId, role: 'assistant', parentId: 'u1b', content: 'Asst 1B variant 2', createdAt: 3200 });

    await storageRepo.saveMessages([u1a, a1a, u2, a2, u1b, a1b, a1b2]);

    // Build the conversation tree from persistent storage
    const loadedMsgs = await storageRepo.listMessagesByConversation(convId);
    const tree = buildConversationTree(loadedMsgs);

    // Two root user branches: u1a and u1b
    expect(tree.roots).toHaveLength(2);

    const root1a = tree.roots.find((r) => r.message.id === 'u1a');
    const root1b = tree.roots.find((r) => r.message.id === 'u1b');
    expect(root1a).toBeDefined();
    expect(root1b).toBeDefined();

    // u1a has child a1a, which has child u2, which has child a2
    expect(root1a!.children).toHaveLength(1);
    expect(root1a!.children[0]?.message.id).toBe('a1a');
    expect(root1a!.children[0]?.children).toHaveLength(1);
    expect(root1a!.children[0]?.children[0]?.message.id).toBe('u2');
    expect(root1a!.children[0]?.children[0]?.children[0]?.message.id).toBe('a2');

    // u1b has TWO assistant siblings (Regenerate variants: a1b and a1b2)
    expect(root1b!.children).toHaveLength(2);
    const childIds = root1b!.children.map((c) => c.message.id);
    expect(childIds).toContain('a1b');
    expect(childIds).toContain('a1b2');

    // Neither branch overwrites or deletes the other! All 7 messages present in tree
    expect(tree.nodeMap.size).toBe(7);
  });
});
