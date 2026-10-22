import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
} from '../src/storage/schema';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';

describe('IndexedDB Storage Repository & Schema', () => {
  let fakeFactory: IDBFactory;
  let repository: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    repository = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase();
  });

  it('configures database schema with all required object stores and indexes', async () => {
    const db = await openExtensionDatabase(fakeFactory);

    expect(db.objectStoreNames.contains(STORE_CONVERSATIONS)).toBe(true);
    expect(db.objectStoreNames.contains(STORE_MESSAGES)).toBe(true);
    expect(db.objectStoreNames.contains(STORE_REVISIONS)).toBe(true);
    expect(db.objectStoreNames.contains(STORE_RECOVERY_EVENTS)).toBe(true);

    const tx = db.transaction(
      [STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS, STORE_RECOVERY_EVENTS],
      'readonly'
    );

    const convStore = tx.objectStore(STORE_CONVERSATIONS);
    expect(convStore.indexNames.contains('remoteId')).toBe(true);
    expect(convStore.indexNames.contains('updatedAt')).toBe(true);

    const msgStore = tx.objectStore(STORE_MESSAGES);
    expect(msgStore.indexNames.contains('conversationId')).toBe(true);
    expect(msgStore.indexNames.contains('remoteId')).toBe(true);
    expect(msgStore.indexNames.contains('parentId')).toBe(true);
    expect(msgStore.indexNames.contains('createdAt')).toBe(true);
    expect(msgStore.indexNames.contains('conversationId_remoteId')).toBe(true);

    const revStore = tx.objectStore(STORE_REVISIONS);
    expect(revStore.indexNames.contains('messageId')).toBe(true);
    expect(revStore.indexNames.contains('capturedAt')).toBe(true);
    expect(revStore.indexNames.contains('isLastGood')).toBe(true);

    const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);
    expect(recStore.indexNames.contains('messageId')).toBe(true);
    expect(recStore.indexNames.contains('detectedAt')).toBe(true);
  });

  it('persists and retrieves conversations', async () => {
    const conv: Conversation = {
      id: 'conv-100',
      title: 'DeepSeek Research Session',
      createdAt: 1710000000,
      updatedAt: 1710000500,
      remoteId: 'remote-conv-1',
    };

    await repository.saveConversation(conv);

    const fetched = await repository.getConversation('conv-100');
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe('DeepSeek Research Session');
    expect(fetched?.remoteId).toBe('remote-conv-1');

    const nonExistent = await repository.getConversation('missing-id');
    expect(nonExistent).toBeNull();

    const all = await repository.listConversations();
    expect(all).toHaveLength(1);
    expect(all[0]?.id).toBe('conv-100');
  });

  it('persists, retrieves, and queries messages by conversationId index', async () => {
    const msg1: Message = {
      id: 'msg-1',
      conversationId: 'conv-100',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 1710000010,
      updatedAt: 1710000010,
    };
    const msg2: Message = {
      id: 'msg-2',
      conversationId: 'conv-100',
      parentId: 'msg-1',
      role: 'assistant',
      status: 'streaming',
      identityState: 'provisional',
      createdAt: 1710000020,
      updatedAt: 1710000030,
    };
    const otherMsg: Message = {
      id: 'msg-99',
      conversationId: 'conv-other',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 1710000000,
      updatedAt: 1710000000,
    };

    await repository.saveMessage(msg1);
    await repository.saveMessage(msg2);
    await repository.saveMessage(otherMsg);

    const fetched = await repository.getMessage('msg-2');
    expect(fetched?.role).toBe('assistant');
    expect(fetched?.parentId).toBe('msg-1');

    const convMessages = await repository.listMessagesByConversation('conv-100');
    expect(convMessages).toHaveLength(2);
    const ids = convMessages.map((m) => m.id);
    expect(ids).toContain('msg-1');
    expect(ids).toContain('msg-2');
    expect(ids).not.toContain('msg-99');
  });

  it('persists revisions and retrieves revisions sorted with lastGood resolution', async () => {
    const rev0: ResponseRevision = {
      id: 'rev-0',
      messageId: 'msg-2',
      revisionIndex: 0,
      text: 'First draft response chunk',
      thinking: 'Initial thought',
      source: 'synthetic',
      capturedAt: 1710000021,
      isFinal: false,
      isLastGood: true,
    };
    const rev1: ResponseRevision = {
      id: 'rev-1',
      messageId: 'msg-2',
      revisionIndex: 1,
      text: 'Complete response chunk before recall',
      thinking: 'Refined thought',
      source: 'synthetic',
      capturedAt: 1710000025,
      isFinal: false,
      isLastGood: true,
    };
    const rev2: ResponseRevision = {
      id: 'rev-2',
      messageId: 'msg-2',
      revisionIndex: 2,
      text: 'Content filtered replacement placeholder',
      source: 'synthetic',
      capturedAt: 1710000030,
      isFinal: true,
      isLastGood: false,
    };

    await repository.saveRevision(rev1); // Save out of order to verify sorting
    await repository.saveRevision(rev0);
    await repository.saveRevision(rev2);

    const revisions = await repository.listRevisionsByMessage('msg-2');
    expect(revisions).toHaveLength(3);
    expect(revisions[0]?.revisionIndex).toBe(0);
    expect(revisions[1]?.revisionIndex).toBe(1);
    expect(revisions[2]?.revisionIndex).toBe(2);

    const lastGood = await repository.getLastGoodRevision('msg-2');
    expect(lastGood).not.toBeNull();
    expect(lastGood?.id).toBe('rev-1');
    expect(lastGood?.text).toBe('Complete response chunk before recall');
  });

  it('persists and filters recovery events', async () => {
    const evt1: RecoveryEvent = {
      id: 'rec-1',
      messageId: 'msg-2',
      kind: 'synthetic',
      detectedAt: 1710000035,
      recoveredRevisionId: 'rev-1',
      reason: 'Synthetic test recovery',
    };
    const evt2: RecoveryEvent = {
      id: 'rec-2',
      messageId: 'msg-3',
      kind: 'content_filter',
      detectedAt: 1710000040,
      recoveredRevisionId: 'rev-9',
    };

    await repository.saveRecoveryEvent(evt1);
    await repository.saveRecoveryEvent(evt2);

    const allEvents = await repository.listRecoveryEvents();
    expect(allEvents).toHaveLength(2);

    const msgEvents = await repository.listRecoveryEvents('msg-2');
    expect(msgEvents).toHaveLength(1);
    expect(msgEvents[0]?.id).toBe('rec-1');
    expect(msgEvents[0]?.kind).toBe('synthetic');
  });

  it('persists synthetic batch atomically across conversation, message, and revision', async () => {
    const batch = {
      conversation: {
        id: 'conv-batch-1',
        title: 'Synthetic Batch Conversation',
        createdAt: 1710000000,
        updatedAt: 1710000100,
      },
      message: {
        id: 'msg-batch-1',
        conversationId: 'conv-batch-1',
        role: 'assistant' as const,
        status: 'finished' as const,
        identityState: 'reconciled' as const,
        createdAt: 1710000050,
        updatedAt: 1710000100,
      },
      revision: {
        id: 'rev-batch-1',
        messageId: 'msg-batch-1',
        revisionIndex: 0,
        text: 'Persisted via atomic batch',
        source: 'synthetic' as const,
        capturedAt: 1710000050,
        isFinal: true,
        isLastGood: true,
      },
    };

    await repository.saveSyntheticBatch(batch);

    const savedConv = await repository.getConversation('conv-batch-1');
    const savedMsg = await repository.getMessage('msg-batch-1');
    const savedRev = await repository.getRevision('rev-batch-1');

    expect(savedConv).not.toBeNull();
    expect(savedConv?.title).toBe('Synthetic Batch Conversation');

    expect(savedMsg).not.toBeNull();
    expect(savedMsg?.conversationId).toBe('conv-batch-1');

    expect(savedRev).not.toBeNull();
    expect(savedRev?.text).toBe('Persisted via atomic batch');
  });

  it('ensures individual write operations reject and do not commit on transaction abort', async () => {
    const db = await openExtensionDatabase(fakeFactory);

    // Test with saveConversation when transaction aborts
    const conv: Conversation = {
      id: 'conv-abort-test',
      title: 'Should not commit',
      createdAt: 100,
      updatedAt: 100,
    };

    // Spy on db.transaction to abort the transaction after put request
    const originalTx = db.transaction.bind(db);
    db.transaction = function (storeNames: any, mode: any) {
      const tx = originalTx(storeNames, mode);
      if (mode === 'readwrite' && storeNames === STORE_CONVERSATIONS) {
        queueMicrotask(() => {
          try {
            tx.abort();
          } catch {
            // ignore if already done
          }
        });
      }
      return tx;
    } as any;

    await expect(repository.saveConversation(conv)).rejects.toThrow();

    // Restore original transaction
    db.transaction = originalTx;

    // Verify record was rolled back
    const fetched = await repository.getConversation('conv-abort-test');
    expect(fetched).toBeNull();
  });

  it('queries conversation by remoteId and messages by remoteId and compound index', async () => {
    const conv: Conversation = {
      id: 'conv-remote-test',
      remoteId: 'remote-chat-session-42',
      title: 'Remote Indexed Session',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await repository.saveConversation(conv);

    const fetchedConv = await repository.getConversationByRemoteId('remote-chat-session-42');
    expect(fetchedConv?.id).toBe('conv-remote-test');

    const msgA: Message = {
      id: 'msg-local-a',
      remoteId: 'remote-msg-1',
      conversationId: 'conv-remote-test',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 1001,
      updatedAt: 1001,
    };
    const msgB: Message = {
      id: 'msg-local-b',
      remoteId: 'remote-msg-2',
      conversationId: 'conv-remote-test',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 1002,
      updatedAt: 1002,
    };

    await repository.saveMessages([msgA, msgB]);

    const byRemote = await repository.getMessageByRemoteId('conv-remote-test', 'remote-msg-2');
    expect(byRemote?.id).toBe('msg-local-b');

    const byGlobalRemote = await repository.findMessageByRemoteId('remote-msg-1');
    expect(byGlobalRemote?.id).toBe('msg-local-a');

    const missing = await repository.getMessageByRemoteId('conv-remote-test', 'non-existent');
    expect(missing).toBeNull();
  });

  it('computes accurate archive summary counts including provisional vs reconciled and last-good', async () => {
    const conv1: Conversation = { id: 'c1', title: 'Conv 1', createdAt: 1, updatedAt: 1 };
    const conv2: Conversation = { id: 'c2', title: 'Conv 2', createdAt: 2, updatedAt: 2 };
    await repository.saveConversation(conv1);
    await repository.saveConversation(conv2);

    const m1: Message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 1,
      updatedAt: 1,
    };
    const m2: Message = {
      id: 'm2',
      conversationId: 'c1',
      role: 'assistant',
      status: 'streaming',
      identityState: 'provisional',
      createdAt: 2,
      updatedAt: 2,
    };
    await repository.saveMessages([m1, m2]);

    const r1: ResponseRevision = {
      id: 'r1',
      messageId: 'm2',
      revisionIndex: 0,
      text: 'Good uncensored response',
      source: 'network',
      capturedAt: 2,
      isFinal: false,
      isLastGood: true,
    };
    const r2: ResponseRevision = {
      id: 'r2',
      messageId: 'm2',
      revisionIndex: 1,
      text: 'Filtered response',
      source: 'network',
      capturedAt: 3,
      isFinal: true,
      isLastGood: false,
    };
    await repository.saveRevisions([r1, r2]);

    const recEvt: RecoveryEvent = {
      id: 'rec1',
      messageId: 'm2',
      kind: 'content_filter',
      detectedAt: 3,
      recoveredRevisionId: 'r1',
    };
    await repository.saveRecoveryEvent(recEvt);

    const summary = await repository.getArchiveSummary();
    expect(summary.conversationsCount).toBe(2);
    expect(summary.messagesCount).toBe(2);
    expect(summary.reconciledMessagesCount).toBe(1);
    expect(summary.provisionalMessagesCount).toBe(1);
    expect(summary.revisionsCount).toBe(2);
    expect(summary.lastGoodRevisionsCount).toBe(1);
    expect(summary.recoveryEventsCount).toBe(1);
  });

  it('saves canonical checkpoint atomically across conversation, message, revisions, and recovery events', async () => {
    const data = {
      streamKey: 'prod:stream-cp',
      checkpointSeq: 0,
      isTerminal: true,
      conversation: { id: 'conv-cp-1', title: 'Checkpoint Convo', createdAt: 10, updatedAt: 10 },
      message: {
        id: 'msg-cp-1',
        conversationId: 'conv-cp-1',
        role: 'assistant' as const,
        status: 'filtered' as const,
        identityState: 'provisional' as const,
        createdAt: 10,
        updatedAt: 20,
      },
      revisions: [
        {
          id: 'rev-cp-1',
          messageId: 'msg-cp-1',
          revisionIndex: 0,
          text: 'Uncensored text',
          source: 'network' as const,
          capturedAt: 10,
          isFinal: false,
          isLastGood: true,
        },
      ],
      recoveryEvents: [
        {
          id: 'rec-cp-1',
          messageId: 'msg-cp-1',
          kind: 'content_filter' as const,
          detectedAt: 20,
          recoveredRevisionId: 'rev-cp-1',
        },
      ],
    };

    await repository.saveCanonicalCheckpoint(data);

    const savedConv = await repository.getConversation('conv-cp-1');
    const savedMsg = await repository.getMessage('msg-cp-1');
    const savedRevs = await repository.listRevisionsByMessage('msg-cp-1');
    const savedRecs = await repository.listRecoveryEvents('msg-cp-1');

    expect(savedConv?.title).toBe('Checkpoint Convo');
    expect(savedMsg?.status).toBe('filtered');
    expect(savedRevs).toHaveLength(1);
    expect(savedRevs[0]?.isLastGood).toBe(true);
    expect(savedRecs).toHaveLength(1);
    expect(savedRecs[0]?.recoveredRevisionId).toBe('rev-cp-1');
  });

  it('applies history reconciliation plan atomically', async () => {
    const plan = {
      conversation: { id: 'conv-plan-1', remoteId: 'sess-plan', title: 'Plan Convo', createdAt: 100, updatedAt: 200 },
      messagesToPut: [
        {
          id: 'msg-plan-1',
          remoteId: 'remote-p1',
          conversationId: 'conv-plan-1',
          role: 'user' as const,
          status: 'finished' as const,
          identityState: 'reconciled' as const,
          content: 'User prompt stored in message',
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: 'msg-plan-2',
          remoteId: 'remote-p2',
          parentId: 'msg-plan-1',
          remoteParentId: 'remote-p1',
          conversationId: 'conv-plan-1',
          role: 'assistant' as const,
          status: 'finished' as const,
          identityState: 'reconciled' as const,
          createdAt: 150,
          updatedAt: 200,
        },
      ],
      revisionsToPut: [
        {
          id: 'rev-plan-2',
          messageId: 'msg-plan-2',
          revisionIndex: 0,
          text: 'Server response text',
          source: 'history' as const,
          capturedAt: 200,
          isFinal: true,
          isLastGood: false,
        },
      ],
      treeLinksResolved: 1,
    };

    await repository.applyHistoryReconciliationPlan(plan);

    const savedConv = await repository.getConversation('conv-plan-1');
    const savedMsgs = await repository.listMessagesByConversation('conv-plan-1');
    const savedRevs = await repository.listRevisionsByMessage('msg-plan-2');

    expect(savedConv?.remoteId).toBe('sess-plan');
    expect(savedMsgs).toHaveLength(2);
    expect(savedMsgs.find((m) => m.id === 'msg-plan-1')?.content).toBe('User prompt stored in message');
    expect(savedMsgs.find((m) => m.id === 'msg-plan-2')?.parentId).toBe('msg-plan-1');
    expect(savedRevs).toHaveLength(1);
  });
});
