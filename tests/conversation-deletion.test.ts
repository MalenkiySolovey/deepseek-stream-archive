import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import {
  buildConversationDeletionPlan,
  deleteConversationCascade,
} from '../src/storage/retention/deletion';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
} from '../src/storage/schema';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';
import type { RawStreamRecord, RawStreamBatch } from '../src/storage/raw-journal/types';

describe('Safe Conversation Cascade Deletion (Milestone 2E.3)', () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    closeExtensionDatabase();
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase();
  });

  async function seedConversation(id: string, suffix: string, remoteId?: string) {
    const conv: Conversation = {
      id,
      remoteId: remoteId || `remote-${suffix}`,
      title: `Conversation ${suffix}`,
      createdAt: 1000,
      updatedAt: 2000,
    };

    const streamKey = `prod-${suffix}:stream-${suffix}`;
    const rawStream: RawStreamRecord = {
      id: streamKey,
      producerSessionId: `prod-${suffix}`,
      streamId: `stream-${suffix}`,
      transport: 'fetch',
      url: 'https://chat.deepseek.com/chat/completion',
      method: 'POST',
      state: 'completed',
      openedAt: 1050,
      updatedAt: 1100,
      finalizedAt: 1100,
      totalChunks: 2,
      totalChars: 100,
      totalBatches: 2,
      integrity: 'intact',
    };

    const batch1: RawStreamBatch = {
      id: `${streamKey}:1`,
      streamKey,
      batchSeq: 1,
      chunks: [{ streamSequence: 0, chunkText: 'Hello', timestamp: 1060 }],
      createdAt: 1060,
      charCount: 5,
    };

    const batch2: RawStreamBatch = {
      id: `${streamKey}:2`,
      streamKey,
      batchSeq: 2,
      chunks: [{ streamSequence: 1, chunkText: ' World', timestamp: 1070 }],
      createdAt: 1070,
      charCount: 6,
    };

    const msgUser: Message = {
      id: `msg-u-${suffix}`,
      conversationId: id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1020,
      updatedAt: 1020,
    };

    const msgAssistant: Message = {
      id: `msg-a-${suffix}`,
      conversationId: id,
      parentId: msgUser.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      sourceRawStreamKey: streamKey,
      createdAt: 1050,
      updatedAt: 1100,
    };

    const rev: ResponseRevision = {
      id: `rev-${suffix}`,
      messageId: msgAssistant.id,
      revisionIndex: 0,
      text: 'Uncensored content',
      source: 'network',
      capturedAt: 1080,
      isFinal: true,
      isLastGood: true,
    };

    const recEvent: RecoveryEvent = {
      id: `rec-${suffix}`,
      messageId: msgAssistant.id,
      kind: 'content_filter',
      detectedAt: 1100,
      recoveredRevisionId: rev.id,
    };

    const tx = db.transaction(
      [
        STORE_CONVERSATIONS,
        STORE_MESSAGES,
        STORE_REVISIONS,
        STORE_RECOVERY_EVENTS,
        STORE_RAW_STREAMS,
        STORE_RAW_STREAM_BATCHES,
      ],
      'readwrite'
    );

    tx.objectStore(STORE_CONVERSATIONS).put(conv);
    tx.objectStore(STORE_MESSAGES).put(msgUser);
    tx.objectStore(STORE_MESSAGES).put(msgAssistant);
    tx.objectStore(STORE_REVISIONS).put(rev);
    tx.objectStore(STORE_RECOVERY_EVENTS).put(recEvent);
    tx.objectStore(STORE_RAW_STREAMS).put(rawStream);
    tx.objectStore(STORE_RAW_STREAM_BATCHES).put(batch1);
    tx.objectStore(STORE_RAW_STREAM_BATCHES).put(batch2);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    return { conv, streamKey };
  }

  it('builds an accurate deletion preview plan with exact counts', async () => {
    await seedConversation('conv-a', 'a');

    const activeStreams = new Set<string>();
    const plan = await buildConversationDeletionPlan(db, 'conv-a', activeStreams);

    expect(plan.conversationId).toBe('conv-a');
    expect(plan.title).toBe('Conversation a');
    expect(plan.updatedAt).toBe(2000);
    expect(plan.messageCount).toBe(2);
    expect(plan.revisionCount).toBe(1);
    expect(plan.recoveryEventCount).toBe(1);
    expect(plan.rawStreamCount).toBe(1);
    expect(plan.rawBatchCount).toBe(2);
    expect(plan.rawStreamKeys).toEqual(['prod-a:stream-a']);
  });

  it('fails preview if conversation does not exist', async () => {
    await expect(
      buildConversationDeletionPlan(db, 'non-existent-conv', new Set())
    ).rejects.toThrow('conversation_not_found');
  });

  it('blocks deletion preview if an active stream is tied to the conversation', async () => {
    const { streamKey } = await seedConversation('conv-active', 'act');

    const activeStreams = new Set<string>([streamKey]);
    await expect(
      buildConversationDeletionPlan(db, 'conv-active', activeStreams)
    ).rejects.toThrow('active_stream_in_progress');
  });

  it('cascades deletion across all stores while completely isolating conversation B', async () => {
    await seedConversation('conv-1', '1');
    await seedConversation('conv-2', '2');

    const activeStreams = new Set<string>();
    const plan1 = await buildConversationDeletionPlan(db, 'conv-1', activeStreams);

    // Delete conversation 1
    await deleteConversationCascade(db, plan1, activeStreams);

    // Verify conversation 1 records are completely gone
    const txVerify = db.transaction(
      [
        STORE_CONVERSATIONS,
        STORE_MESSAGES,
        STORE_REVISIONS,
        STORE_RECOVERY_EVENTS,
        STORE_RAW_STREAMS,
        STORE_RAW_STREAM_BATCHES,
      ],
      'readonly'
    );

    const conv1Req = txVerify.objectStore(STORE_CONVERSATIONS).get('conv-1');
    const msg1Req = txVerify.objectStore(STORE_MESSAGES).index('conversationId').getAll('conv-1');
    const rev1Req = txVerify.objectStore(STORE_REVISIONS).get('rev-1');
    const rec1Req = txVerify.objectStore(STORE_RECOVERY_EVENTS).get('rec-1');
    const stream1Req = txVerify.objectStore(STORE_RAW_STREAMS).get('prod-1:stream-1');
    const batch1Req = txVerify.objectStore(STORE_RAW_STREAM_BATCHES).index('streamKey').getAll('prod-1:stream-1');

    // Verify conversation 2 records are completely preserved
    const conv2Req = txVerify.objectStore(STORE_CONVERSATIONS).get('conv-2');
    const msg2Req = txVerify.objectStore(STORE_MESSAGES).index('conversationId').getAll('conv-2');
    const rev2Req = txVerify.objectStore(STORE_REVISIONS).get('rev-2');
    const rec2Req = txVerify.objectStore(STORE_RECOVERY_EVENTS).get('rec-2');
    const stream2Req = txVerify.objectStore(STORE_RAW_STREAMS).get('prod-2:stream-2');
    const batch2Req = txVerify.objectStore(STORE_RAW_STREAM_BATCHES).index('streamKey').getAll('prod-2:stream-2');

    await new Promise<void>((resolve) => {
      txVerify.oncomplete = () => resolve();
    });

    // Conv 1: All gone
    expect(conv1Req.result).toBeUndefined();
    expect(msg1Req.result).toHaveLength(0);
    expect(rev1Req.result).toBeUndefined();
    expect(rec1Req.result).toBeUndefined();
    expect(stream1Req.result).toBeUndefined();
    expect(batch1Req.result).toHaveLength(0);

    // Conv 2: 100% Intact
    expect(conv2Req.result).toBeDefined();
    expect(conv2Req.result.id).toBe('conv-2');
    expect(msg2Req.result).toHaveLength(2);
    expect(rev2Req.result).toBeDefined();
    expect(rec2Req.result).toBeDefined();
    expect(stream2Req.result).toBeDefined();
    expect(batch2Req.result).toHaveLength(2);
  });

  it('enforces stale plan guard: aborts if conversation was modified after preview was generated', async () => {
    await seedConversation('conv-stale', 'stale');

    const activeStreams = new Set<string>();
    const plan = await buildConversationDeletionPlan(db, 'conv-stale', activeStreams);

    // Mutate conversation updatedAt before deletion execution
    const txMutate = db.transaction([STORE_CONVERSATIONS], 'readwrite');
    const conv = await new Promise<Conversation>((resolve) => {
      const req = txMutate.objectStore(STORE_CONVERSATIONS).get('conv-stale');
      req.onsuccess = () => resolve(req.result);
    });
    conv.updatedAt = 9999999;
    txMutate.objectStore(STORE_CONVERSATIONS).put(conv);
    await new Promise<void>((resolve) => {
      txMutate.oncomplete = () => resolve();
    });

    // Deletion must abort
    await expect(deleteConversationCascade(db, plan, activeStreams)).rejects.toThrow(
      'delete_target_changed_since_preview'
    );

    // Verify conversation was NOT deleted
    const txCheck = db.transaction([STORE_CONVERSATIONS], 'readonly');
    const checkReq = txCheck.objectStore(STORE_CONVERSATIONS).get('conv-stale');
    await new Promise<void>((resolve) => {
      txCheck.oncomplete = () => resolve();
    });
    expect(checkReq.result).toBeDefined();
    expect(checkReq.result.updatedAt).toBe(9999999);
  });

  it('blocks execution if a stream became active between preview and deletion', async () => {
    const { streamKey } = await seedConversation('conv-active-late', 'lat');

    const activeStreams = new Set<string>();
    const plan = await buildConversationDeletionPlan(db, 'conv-active-late', activeStreams);

    // Mark stream as active
    activeStreams.add(streamKey);

    await expect(deleteConversationCascade(db, plan, activeStreams)).rejects.toThrow(
      'active_stream_in_progress'
    );
  });
});
