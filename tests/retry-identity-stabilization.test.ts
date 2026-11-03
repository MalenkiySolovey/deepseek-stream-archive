import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { CanonicalRevisionRecorder } from '../src/core/recorder/canonical-recorder';
import {
  isLogicalMessage,
  isUnmatchedCapture,
  isAttemptOnly,
  makeProvisionalMessageId,
  type Conversation,
  type Message,
  type ResponseRevision,
} from '../src/core/models';
import { closeExtensionDatabase } from '../src/storage/db';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';

describe('Live Retry Identity Stabilization & Branch Integrity', () => {
  let fakeFactory: IDBFactory;
  let storage: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storage = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
    closeExtensionDatabase();
  });

  it('CanonicalRevisionRecorder.flush(true) never creates 0-char ResponseRevision on empty streams', () => {
    const recorder = new CanonicalRevisionRecorder({
      conversationId: 'conv-empty',
      messageId: 'msg-empty-1',
      sourceRawStreamKey: 'prod:stream-empty-1',
    });

    // Simulate empty stream interrupted immediately by network
    recorder.feedSemanticEvent({
      streamId: 'stream-empty-1',
      sequence: 1,
      timestamp: 100,
      type: 'stream_interrupted',
    });

    const rev = recorder.flush(true);
    expect(rev).toBeNull();
    expect(recorder.getRevisions()).toHaveLength(0);

    const snapshot = recorder.buildMessageSnapshot();
    expect(snapshot.projectionState).toBe('attempt_only');
    expect(snapshot.parentId).toBeUndefined();
    expect(isLogicalMessage(snapshot)).toBe(false);
    expect(isAttemptOnly(snapshot)).toBe(true);
  });

  it('reproduces live defect and stabilizes: 3 transport attempts collapse into 1 logical assistant branch after history reconciliation', async () => {
    const reconciler = new HistoryReconciler(storage);
    const convId = 'conv-retry-live';
    const remoteSessionId = 'sess-retry-live';

    // 1. Initial conversation created
    const conv: Conversation = {
      id: convId,
      remoteId: remoteSessionId,
      title: 'Quantum Computing Inquiry',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storage.saveConversation(conv);

    // 2. User prompt message
    const userMsgId = 'msg-user-1';
    const userRemoteId = 'remote-user-1';
    const userMsg: Message = {
      id: userMsgId,
      remoteId: userRemoteId,
      conversationId: convId,
      identityState: 'reconciled',
      projectionState: 'logical',
      role: 'user',
      status: 'finished',
      content: 'Explain quantum entanglement',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storage.saveMessage(userMsg);

    // 3. DeepSeek triggers Attempt #1: interrupted with 0 text
    const streamKey1 = 'prod_session:xhr_stream_attempt_1';
    const attempt1Id = makeProvisionalMessageId(streamKey1);
    const attempt1Msg: Message = {
      id: attempt1Id,
      conversationId: convId,
      parentId: undefined, // empty attempt has no parentId
      remoteParentId: userRemoteId,
      sourceRawStreamKey: streamKey1,
      identityState: 'provisional',
      projectionState: 'attempt_only',
      role: 'assistant',
      status: 'interrupted',
      createdAt: 1010,
      updatedAt: 1010,
    };
    await storage.saveMessage(attempt1Msg);

    // 4. DeepSeek triggers Attempt #2: retry transport also interrupted with 0 text
    const streamKey2 = 'prod_session:xhr_stream_attempt_2';
    const attempt2Id = makeProvisionalMessageId(streamKey2);
    const attempt2Msg: Message = {
      id: attempt2Id,
      conversationId: convId,
      parentId: undefined,
      remoteParentId: userRemoteId,
      sourceRawStreamKey: streamKey2,
      identityState: 'provisional',
      projectionState: 'attempt_only',
      role: 'assistant',
      status: 'interrupted',
      createdAt: 1020,
      updatedAt: 1020,
    };
    await storage.saveMessage(attempt2Msg);

    // 5. DeepSeek triggers Attempt #3: successful response
    const streamKey3 = 'prod_session:xhr_stream_attempt_3';
    const attempt3Id = makeProvisionalMessageId(streamKey3);
    const asstRemoteId = 'remote-asst-success';
    const attempt3Msg: Message = {
      id: attempt3Id,
      remoteId: asstRemoteId,
      conversationId: convId,
      parentId: userMsgId,
      remoteParentId: userRemoteId,
      sourceRawStreamKey: streamKey3,
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      role: 'assistant',
      status: 'finished',
      createdAt: 1030,
      updatedAt: 1030,
    };
    await storage.saveMessage(attempt3Msg);

    const asstRev: ResponseRevision = {
      id: `rev_${attempt3Id}_0`,
      messageId: attempt3Id,
      revisionIndex: 0,
      text: 'Quantum entanglement is a physical phenomenon...',
      source: 'network',
      capturedAt: 1030,
      isFinal: true,
      isLastGood: false,
    };
    await storage.saveRevision(asstRev);

    // 6. Server history sync arrives
    const parsedHistory: DeepSeekParsedHistory = {
      session: {
        sessionId: remoteSessionId,
        title: 'Quantum Computing Inquiry',
        updatedAt: 1100,
        pinned: false,
      },
      messages: [
        {
          messageId: userRemoteId,
          parentId: null,
          role: 'user',
          text: 'Explain quantum entanglement',
          status: 'finished',
          createdAt: 1000,
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: asstRemoteId,
          parentId: userRemoteId,
          role: 'assistant',
          text: 'Quantum entanglement is a physical phenomenon...',
          status: 'finished',
          createdAt: 1030,
          isFiltered: false,
          fragmentsCount: 1,
        },
      ],
    };

    const result = await reconciler.reconcile(parsedHistory);
    expect(result.messagesCreated).toBe(0); // All were matched
    expect(result.messagesUpdated).toBeGreaterThanOrEqual(1);

    // 7. Verification: Messages in storage
    const storedMessages = await storage.listMessagesByConversation(convId);
    expect(storedMessages).toHaveLength(4); // 1 user + 3 assistant transport records

    // Logical messages check:
    const logicalMessages = storedMessages.filter((m) => isLogicalMessage(m));
    expect(logicalMessages).toHaveLength(2); // exactly 1 User and 1 Assistant

    const successfulAsst = storedMessages.find((m) => m.id === attempt3Id);
    expect(successfulAsst).toBeDefined();
    expect(successfulAsst?.identityState).toBe('reconciled');
    expect(successfulAsst?.projectionState).toBe('logical');
    expect(successfulAsst?.parentId).toBe(userMsgId);

    const emptyAttempt1 = storedMessages.find((m) => m.id === attempt1Id);
    expect(emptyAttempt1?.projectionState).toBe('attempt_only');
    expect(emptyAttempt1?.parentId).toBeUndefined(); // MUST NOT branch under user message!

    const emptyAttempt2 = storedMessages.find((m) => m.id === attempt2Id);
    expect(emptyAttempt2?.projectionState).toBe('attempt_only');
    expect(emptyAttempt2?.parentId).toBeUndefined(); // MUST NOT branch under user message!

    // 8. Verify listArchiveConversations messageCount reflects logical count
    const archiveConvs = await storage.listArchiveConversations();
    expect(archiveConvs.items).toHaveLength(1);
    expect(archiveConvs.items[0]?.messageCount).toBe(2); // 1 User + 1 Assistant, NOT 4!
  });

  it('preserves meaningful partial captures as unmatched_capture without polluting conversation branches', async () => {
    const reconciler = new HistoryReconciler(storage);
    const convId = 'conv-partial-capture';
    const remoteSessionId = 'sess-partial';
    const userRemoteId = 'u-partial';
    const asstRemoteId = 'a-partial-final';

    await storage.saveConversation({
      id: convId,
      remoteId: remoteSessionId,
      title: 'Partial Capture Test',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const userMsg: Message = {
      id: 'msg-u-part',
      remoteId: userRemoteId,
      conversationId: convId,
      identityState: 'reconciled',
      projectionState: 'logical',
      role: 'user',
      status: 'finished',
      content: 'Write a poem about the ocean',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storage.saveMessage(userMsg);

    // Attempt #1: Streams 80 chars, but connection is aborted
    const streamKey1 = 'prod_session:partial_stream_1';
    const partMsgId = makeProvisionalMessageId(streamKey1);
    const partialMsg: Message = {
      id: partMsgId,
      conversationId: convId,
      parentId: userMsg.id, // initially set before history
      remoteParentId: userRemoteId,
      sourceRawStreamKey: streamKey1,
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      role: 'assistant',
      status: 'interrupted',
      createdAt: 1010,
      updatedAt: 1010,
    };
    await storage.saveMessage(partialMsg);
    await storage.saveRevision({
      id: `rev_${partMsgId}_0`,
      messageId: partMsgId,
      revisionIndex: 0,
      text: 'The deep blue waves crash endlessly against the shore, whispering tales of...',
      source: 'network',
      capturedAt: 1010,
      isFinal: true,
      isLastGood: false,
    });

    // Attempt #2: Succeeds with full poem
    const streamKey2 = 'prod_session:final_stream_2';
    const finalMsgId = makeProvisionalMessageId(streamKey2);
    const finalMsg: Message = {
      id: finalMsgId,
      remoteId: asstRemoteId,
      conversationId: convId,
      parentId: userMsg.id,
      remoteParentId: userRemoteId,
      sourceRawStreamKey: streamKey2,
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      role: 'assistant',
      status: 'finished',
      createdAt: 1020,
      updatedAt: 1020,
    };
    await storage.saveMessage(finalMsg);
    await storage.saveRevision({
      id: `rev_${finalMsgId}_0`,
      messageId: finalMsgId,
      revisionIndex: 0,
      text: 'The deep blue waves crash endlessly against the shore, whispering tales of ancient lore...',
      source: 'network',
      capturedAt: 1020,
      isFinal: true,
      isLastGood: false,
    });

    // History sync arrives containing only the final message
    await reconciler.reconcile({
      session: {
        sessionId: remoteSessionId,
        title: 'Partial Capture Test',
        updatedAt: 1100,
        pinned: false,
      },
      messages: [
        {
          messageId: userRemoteId,
          parentId: null,
          role: 'user',
          text: 'Write a poem about the ocean',
          status: 'finished',
          createdAt: 1000,
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: asstRemoteId,
          parentId: userRemoteId,
          role: 'assistant',
          text: 'The deep blue waves crash endlessly against the shore, whispering tales of ancient lore...',
          status: 'finished',
          createdAt: 1020,
          isFiltered: false,
          fragmentsCount: 1,
        },
      ],
    });

    // Verify partial attempt is classified as unmatched_capture and has parentId stripped
    const loadedPartial = await storage.getMessage(partMsgId);
    expect(loadedPartial).toBeDefined();
    expect(loadedPartial?.projectionState).toBe('unmatched_capture');
    expect(loadedPartial?.parentId).toBeUndefined(); // Tree link stripped!
    expect(isUnmatchedCapture(loadedPartial!)).toBe(true);
    expect(isLogicalMessage(loadedPartial!)).toBe(false);

    // Verify its revisions are still 100% preserved
    const partialRevs = await storage.listRevisionsByMessage(partMsgId);
    expect(partialRevs).toHaveLength(1);
    expect(partialRevs[0]?.text).toContain('whispering tales of...');

    // Verify final message is logical and linked
    const loadedFinal = await storage.getMessage(finalMsgId);
    expect(loadedFinal?.projectionState).toBe('logical');
    expect(loadedFinal?.parentId).toBe(userMsg.id);
  });

  it('strictly preserves real regenerate branches in conversation tree when multiple messages exist in server history', async () => {
    const reconciler = new HistoryReconciler(storage);
    const convId = 'conv-regen';
    const remoteSessionId = 'sess-regen';
    const userRemoteId = 'u-regen-1';
    const asstRemote1 = 'a-regen-1';
    const asstRemote2 = 'a-regen-2';

    // Server history contains 1 user message and 2 assistant branches (user clicked Regenerate)
    await reconciler.reconcile({
      session: {
        sessionId: remoteSessionId,
        title: 'Regenerate Branch Test',
        updatedAt: 1200,
        pinned: false,
      },
      messages: [
        {
          messageId: userRemoteId,
          parentId: null,
          role: 'user',
          text: 'Suggest a title for my book',
          status: 'finished',
          createdAt: 1000,
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: asstRemote1,
          parentId: userRemoteId,
          role: 'assistant',
          text: 'Option A: The Quantum Horizon',
          status: 'finished',
          createdAt: 1010,
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: asstRemote2,
          parentId: userRemoteId,
          role: 'assistant',
          text: 'Option B: Echoes of Eternity',
          status: 'finished',
          createdAt: 1020,
          isFiltered: false,
          fragmentsCount: 1,
        },
      ],
    });

    const conv = await storage.getConversationByRemoteId(remoteSessionId);
    expect(conv).toBeDefined();

    const messages = await storage.listMessagesByConversation(conv!.id);
    expect(messages).toHaveLength(3);

    const user = messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();

    const asst1 = messages.find((m) => m.remoteId === asstRemote1);
    const asst2 = messages.find((m) => m.remoteId === asstRemote2);

    expect(asst1?.projectionState).toBe('logical');
    expect(asst2?.projectionState).toBe('logical');

    // Both assistant branches MUST share the user message as parentId!
    expect(asst1?.parentId).toBe(user?.id);
    expect(asst2?.parentId).toBe(user?.id);

    // Both count as logical messages
    const logical = messages.filter((m) => isLogicalMessage(m));
    expect(logical).toHaveLength(3);
  });

  it('repairCanonicalProjection() idempotently migrates legacy records and cleans phantom branches', async () => {
    const convId = 'conv-legacy-repair';

    await storage.saveConversation({
      id: convId,
      title: 'Legacy Corrupted Session',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const userMsg: Message = {
      id: 'legacy-user',
      conversationId: convId,
      identityState: 'reconciled',
      role: 'user',
      status: 'finished',
      content: 'Hello legacy',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storage.saveMessage(userMsg);

    // Legacy empty interrupted assistant attempt with phantom parent link
    const emptyLegacyMsg: Message = {
      id: 'legacy-asst-empty',
      conversationId: convId,
      parentId: userMsg.id, // Corrupted: erroneously linked as a branch
      remoteParentId: 'remote-user',
      sourceRawStreamKey: 'prod:stream_legacy_1',
      identityState: 'provisional',
      // projectionState is undefined on legacy records!
      role: 'assistant',
      status: 'interrupted',
      createdAt: 1010,
      updatedAt: 1010,
    };
    await storage.saveMessage(emptyLegacyMsg);

    // Legacy partial capture assistant with real revisions
    const partialLegacyMsg: Message = {
      id: 'legacy-asst-partial',
      conversationId: convId,
      parentId: userMsg.id, // Corrupted: erroneously linked as a branch
      remoteParentId: 'remote-user',
      sourceRawStreamKey: 'prod:stream_legacy_2',
      identityState: 'provisional',
      // projectionState is undefined!
      role: 'assistant',
      status: 'interrupted',
      createdAt: 1020,
      updatedAt: 1020,
    };
    await storage.saveMessage(partialLegacyMsg);
    await storage.saveRevision({
      id: 'rev-legacy-part',
      messageId: partialLegacyMsg.id,
      revisionIndex: 0,
      text: 'Useful partial text recovered from broken transport',
      source: 'network',
      capturedAt: 1020,
      isFinal: true,
      isLastGood: false,
    });

    // Run repair
    const repairResult = await storage.repairCanonicalProjection();
    expect(repairResult.scannedCount).toBe(3);
    expect(repairResult.attemptOnlyCount).toBe(1);
    expect(repairResult.unmatchedCapturesCount).toBe(1);

    // Verify empty attempt repaired:
    const repairedEmpty = await storage.getMessage(emptyLegacyMsg.id);
    expect(repairedEmpty?.projectionState).toBe('attempt_only');
    expect(repairedEmpty?.parentId).toBeUndefined(); // Phantom link removed!

    // Verify partial capture repaired:
    const repairedPartial = await storage.getMessage(partialLegacyMsg.id);
    expect(repairedPartial?.projectionState).toBe('unmatched_capture');
    expect(repairedPartial?.parentId).toBeUndefined(); // Phantom link removed!

    // Verify idempotency: running repair a second time causes 0 mutations
    const secondRepair = await storage.repairCanonicalProjection();
    expect(secondRepair.repairedCount).toBe(0);
    expect(secondRepair.attemptOnlyCount).toBe(1);
    expect(secondRepair.unmatchedCapturesCount).toBe(1);
  });
});
