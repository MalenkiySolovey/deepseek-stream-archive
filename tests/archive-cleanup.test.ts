import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import {
  buildRawRetentionPlan,
  executeRawRetentionPlan,
  clearRawEvidence,
  clearEntireArchive,
} from '../src/storage/retention/cleanup';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_HISTORY_STAGING,
  STORE_HISTORY_STAGING_MANIFESTS,
} from '../src/storage/schema';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';
import type { RawStreamRecord, RawStreamBatch } from '../src/storage/raw-journal/types';

describe('Archive Maintenance & Safe Cleanup Engine (Milestone 2E.3)', () => {
  let db: IDBDatabase;
  const NOW = 10000000000; // Reference clock
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    closeExtensionDatabase();
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase();
  });

  async function seedArchiveForRetention() {
    const tx = db.transaction(
      [
        STORE_CONVERSATIONS,
        STORE_MESSAGES,
        STORE_REVISIONS,
        STORE_RECOVERY_EVENTS,
        STORE_RAW_STREAMS,
        STORE_RAW_STREAM_BATCHES,
        STORE_CANONICAL_CHECKPOINTS,
      ],
      'readwrite'
    );

    // 1. Conversation
    const conv: Conversation = {
      id: 'conv-main',
      title: 'Main Chat',
      createdAt: NOW - 60 * 24 * 60 * 60 * 1000,
      updatedAt: NOW - 60 * 24 * 60 * 60 * 1000,
    };
    tx.objectStore(STORE_CONVERSATIONS).put(conv);

    // 2. Old Healthy Stream (older than 30 days) -> SHOULD BE PRUNED
    const oldHealthyStream: RawStreamRecord = {
      id: 'p-old:s-old',
      producerSessionId: 'p-old',
      streamId: 's-old',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/chat/completion',
      method: 'POST',
      state: 'completed',
      openedAt: NOW - 40 * 24 * 60 * 60 * 1000, // 40 days old
      updatedAt: NOW - 40 * 24 * 60 * 60 * 1000,
      finalizedAt: NOW - 40 * 24 * 60 * 60 * 1000,
      totalChunks: 5,
      totalChars: 150,
      totalBatches: 2,
      integrity: 'intact',
    };
    tx.objectStore(STORE_RAW_STREAMS).put(oldHealthyStream);

    const oldBatch1: RawStreamBatch = {
      id: 'p-old:s-old:1',
      streamKey: 'p-old:s-old',
      batchSeq: 1,
      chunks: [{ streamSequence: 0, chunkText: 'batch1', timestamp: oldHealthyStream.openedAt }],
      createdAt: oldHealthyStream.openedAt,
      charCount: 6,
    };
    const oldBatch2: RawStreamBatch = {
      id: 'p-old:s-old:2',
      streamKey: 'p-old:s-old',
      batchSeq: 2,
      chunks: [{ streamSequence: 1, chunkText: 'batch2', timestamp: oldHealthyStream.openedAt }],
      createdAt: oldHealthyStream.openedAt,
      charCount: 6,
    };
    tx.objectStore(STORE_RAW_STREAM_BATCHES).put(oldBatch1);
    tx.objectStore(STORE_RAW_STREAM_BATCHES).put(oldBatch2);

    // Message for old stream (normal reconciled message)
    const oldMsg: Message = {
      id: 'msg-old',
      conversationId: 'conv-main',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      sourceRawStreamKey: 'p-old:s-old',
      createdAt: oldHealthyStream.openedAt,
      updatedAt: oldHealthyStream.openedAt,
    };
    tx.objectStore(STORE_MESSAGES).put(oldMsg);

    // 3. Recent Healthy Stream (< 30 days) -> SHIELDED (too_recent)
    const recentHealthyStream: RawStreamRecord = {
      id: 'p-rec:s-rec',
      producerSessionId: 'p-rec',
      streamId: 's-rec',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/chat/completion',
      method: 'POST',
      state: 'completed',
      openedAt: NOW - 10 * 24 * 60 * 60 * 1000, // 10 days old
      updatedAt: NOW - 10 * 24 * 60 * 60 * 1000,
      finalizedAt: NOW - 10 * 24 * 60 * 60 * 1000,
      totalChunks: 2,
      totalChars: 80,
      totalBatches: 1,
      integrity: 'intact',
    };
    tx.objectStore(STORE_RAW_STREAMS).put(recentHealthyStream);

    const recBatch: RawStreamBatch = {
      id: 'p-rec:s-rec:1',
      streamKey: 'p-rec:s-rec',
      batchSeq: 1,
      chunks: [{ streamSequence: 0, chunkText: 'recent', timestamp: recentHealthyStream.openedAt }],
      createdAt: recentHealthyStream.openedAt,
      charCount: 6,
    };
    tx.objectStore(STORE_RAW_STREAM_BATCHES).put(recBatch);

    const recentMsg: Message = {
      id: 'msg-rec',
      conversationId: 'conv-main',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      sourceRawStreamKey: 'p-rec:s-rec',
      createdAt: recentHealthyStream.openedAt,
      updatedAt: recentHealthyStream.openedAt,
    };
    tx.objectStore(STORE_MESSAGES).put(recentMsg);

    // 4. Old Protected Recovery Stream (50 days old, BUT tied to filtered message & recovery event) -> SHIELDED
    const recoveryStream: RawStreamRecord = {
      id: 'p-filter:s-filter',
      producerSessionId: 'p-filter',
      streamId: 's-filter',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/chat/completion',
      method: 'POST',
      state: 'completed',
      openedAt: NOW - 50 * 24 * 60 * 60 * 1000, // 50 days old
      updatedAt: NOW - 50 * 24 * 60 * 60 * 1000,
      finalizedAt: NOW - 50 * 24 * 60 * 60 * 1000,
      totalChunks: 3,
      totalChars: 120,
      totalBatches: 1,
      integrity: 'intact',
    };
    tx.objectStore(STORE_RAW_STREAMS).put(recoveryStream);

    const filterBatch: RawStreamBatch = {
      id: 'p-filter:s-filter:1',
      streamKey: 'p-filter:s-filter',
      batchSeq: 1,
      chunks: [{ streamSequence: 0, chunkText: 'shielded filter', timestamp: recoveryStream.openedAt }],
      createdAt: recoveryStream.openedAt,
      charCount: 15,
    };
    tx.objectStore(STORE_RAW_STREAM_BATCHES).put(filterBatch);

    const filterMsg: Message = {
      id: 'msg-filter',
      conversationId: 'conv-main',
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      sourceRawStreamKey: 'p-filter:s-filter',
      createdAt: recoveryStream.openedAt,
      updatedAt: recoveryStream.openedAt,
    };
    tx.objectStore(STORE_MESSAGES).put(filterMsg);

    const lastGoodRev: ResponseRevision = {
      id: 'rev-lg',
      messageId: 'msg-filter',
      revisionIndex: 0,
      text: 'uncensored truth',
      source: 'network',
      capturedAt: recoveryStream.openedAt,
      isFinal: true,
      isLastGood: true,
    };
    tx.objectStore(STORE_REVISIONS).put(lastGoodRev);

    const recEvent: RecoveryEvent = {
      id: 'rec-event-1',
      messageId: 'msg-filter',
      kind: 'content_filter',
      detectedAt: recoveryStream.openedAt,
      recoveredRevisionId: 'rev-lg',
    };
    tx.objectStore(STORE_RECOVERY_EVENTS).put(recEvent);

    // 5. Old Forensic Degraded Stream (60 days old, BUT durabilityGap = true) -> SHIELDED
    const degradedStream: RawStreamRecord = {
      id: 'p-deg:s-deg',
      producerSessionId: 'p-deg',
      streamId: 's-deg',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/chat/completion',
      method: 'POST',
      state: 'completed',
      openedAt: NOW - 60 * 24 * 60 * 60 * 1000,
      updatedAt: NOW - 60 * 24 * 60 * 60 * 1000,
      finalizedAt: NOW - 60 * 24 * 60 * 60 * 1000,
      totalChunks: 1,
      totalChars: 50,
      totalBatches: 1,
      durabilityGap: true,
      integrity: 'degraded',
    };
    tx.objectStore(STORE_RAW_STREAMS).put(degradedStream);

    const degBatch: RawStreamBatch = {
      id: 'p-deg:s-deg:1',
      streamKey: 'p-deg:s-deg',
      batchSeq: 1,
      chunks: [{ streamSequence: 0, chunkText: 'deg', timestamp: degradedStream.openedAt }],
      createdAt: degradedStream.openedAt,
      charCount: 3,
    };
    tx.objectStore(STORE_RAW_STREAM_BATCHES).put(degBatch);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  it('builds raw retention plan correctly identifying only eligible streams while shielding protected streams', async () => {
    await seedArchiveForRetention();

    const activeStreams = new Set<string>();
    const plan = await buildRawRetentionPlan(db, '30', activeStreams, NOW);

    expect(plan.mode).toBe('30');
    expect(plan.cutoffTimestamp).toBe(NOW - THIRTY_DAYS_MS);
    // Only p-old:s-old is eligible (p-rec is <30d, p-filter is recovery protected, p-deg has durabilityGap)
    expect(plan.candidateStreamKeys).toEqual(['p-old:s-old']);
    expect(plan.candidateBatchCount).toBe(2);
    expect(plan.protectedStreamCount).toBe(3);
    expect(plan.totalStreamsScanned).toBe(4);
  });

  it('executes raw retention plan: deletes only candidate streams and preserves all canonical records', async () => {
    await seedArchiveForRetention();

    const activeStreams = new Set<string>();
    const plan = await buildRawRetentionPlan(db, '30', activeStreams, NOW);

    const result = await executeRawRetentionPlan(db, plan, activeStreams);
    expect(result.success).toBe(true);
    expect(result.deletedStreamCount).toBe(1);
    expect(result.deletedBatchCount).toBe(2);

    // Verify raw stores
    const tx = db.transaction([STORE_RAW_STREAMS, STORE_RAW_STREAM_BATCHES, STORE_MESSAGES], 'readonly');
    const oldStreamReq = tx.objectStore(STORE_RAW_STREAMS).get('p-old:s-old');
    const oldBatchesReq = tx.objectStore(STORE_RAW_STREAM_BATCHES).index('streamKey').getAll('p-old:s-old');
    const recStreamReq = tx.objectStore(STORE_RAW_STREAMS).get('p-rec:s-rec');
    const filterStreamReq = tx.objectStore(STORE_RAW_STREAMS).get('p-filter:s-filter');
    const degStreamReq = tx.objectStore(STORE_RAW_STREAMS).get('p-deg:s-deg');
    const oldMsgReq = tx.objectStore(STORE_MESSAGES).get('msg-old');

    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });

    // Old candidate stream is pruned
    expect(oldStreamReq.result).toBeUndefined();
    expect(oldBatchesReq.result).toHaveLength(0);

    // Protected streams survive
    expect(recStreamReq.result).toBeDefined();
    expect(filterStreamReq.result).toBeDefined();
    expect(degStreamReq.result).toBeDefined();

    // Canonical message survives untouched!
    expect(oldMsgReq.result).toBeDefined();
    expect(oldMsgReq.result.id).toBe('msg-old');
  });

  it('clearRawEvidence purges 100% of raw streams and batches while keeping all canonical history', async () => {
    await seedArchiveForRetention();

    // Purge raw evidence
    const result = await clearRawEvidence(db, 0);
    expect(result.success).toBe(true);
    expect(result.deletedStreamCount).toBe(4);
    expect(result.deletedBatchCount).toBe(5);

    // Verify raw stores are empty
    const tx = db.transaction(
      [
        STORE_RAW_STREAMS,
        STORE_RAW_STREAM_BATCHES,
        STORE_CONVERSATIONS,
        STORE_MESSAGES,
        STORE_REVISIONS,
        STORE_RECOVERY_EVENTS,
      ],
      'readonly'
    );

    const streamCountReq = tx.objectStore(STORE_RAW_STREAMS).count();
    const batchCountReq = tx.objectStore(STORE_RAW_STREAM_BATCHES).count();
    const convCountReq = tx.objectStore(STORE_CONVERSATIONS).count();
    const msgCountReq = tx.objectStore(STORE_MESSAGES).count();
    const revCountReq = tx.objectStore(STORE_REVISIONS).count();
    const recCountReq = tx.objectStore(STORE_RECOVERY_EVENTS).count();

    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
    });

    // Raw stores are 0
    expect(streamCountReq.result).toBe(0);
    expect(batchCountReq.result).toBe(0);

    // Canonical stores remain 100% intact!
    expect(convCountReq.result).toBe(1);
    expect(msgCountReq.result).toBe(3);
    expect(revCountReq.result).toBe(1);
    expect(recCountReq.result).toBe(1);
  });

  it('clearRawEvidence rejects if active streams exist', async () => {
    await expect(clearRawEvidence(db, 1)).rejects.toThrow('active_stream_in_progress');
  });

  it('clearEntireArchive clears all 9 stores in ONE atomic transaction', async () => {
    await seedArchiveForRetention();

    // Also put records in ephemeral stores
    const txInit = db.transaction(
      [STORE_CANONICAL_CHECKPOINTS, STORE_HISTORY_STAGING, STORE_HISTORY_STAGING_MANIFESTS],
      'readwrite'
    );
    txInit.objectStore(STORE_CANONICAL_CHECKPOINTS).put({
      streamKey: 'cp:1',
      lastCommittedCheckpointSeq: 1,
      isTerminal: true,
      updatedAt: 100,
    });
    txInit.objectStore(STORE_HISTORY_STAGING).put({
      id: 'stg:1',
      stagingId: 'stg',
      batchIndex: 0,
      messages: [],
      createdAt: 100,
    });
    txInit.objectStore(STORE_HISTORY_STAGING_MANIFESTS).put({
      stagingId: 'stg',
      sessionId: 'sess',
      expectedBatchCount: 1,
      expectedMessageCount: 1,
      receivedBatchCount: 1,
      state: 'open',
      createdAt: 100,
      updatedAt: 100,
    });
    await new Promise<void>((resolve) => {
      txInit.oncomplete = () => resolve();
    });

    // Execute clearEntireArchive
    const result = await clearEntireArchive(db, 0);
    expect(result.success).toBe(true);

    // Verify all 9 stores are empty
    const txCheck = db.transaction(
      [
        STORE_CONVERSATIONS,
        STORE_MESSAGES,
        STORE_REVISIONS,
        STORE_RECOVERY_EVENTS,
        STORE_RAW_STREAMS,
        STORE_RAW_STREAM_BATCHES,
        STORE_CANONICAL_CHECKPOINTS,
        STORE_HISTORY_STAGING,
        STORE_HISTORY_STAGING_MANIFESTS,
      ],
      'readonly'
    );

    const counts = await Promise.all([
      new Promise<number>((res) => { txCheck.objectStore(STORE_CONVERSATIONS).count().onsuccess = (e) => res((e.target as any).result); }),
      new Promise<number>((res) => { txCheck.objectStore(STORE_MESSAGES).count().onsuccess = (e) => res((e.target as any).result); }),
      new Promise<number>((res) => { txCheck.objectStore(STORE_REVISIONS).count().onsuccess = (e) => res((e.target as any).result); }),
      new Promise<number>((res) => { txCheck.objectStore(STORE_RECOVERY_EVENTS).count().onsuccess = (e) => res((e.target as any).result); }),
      new Promise<number>((res) => { txCheck.objectStore(STORE_RAW_STREAMS).count().onsuccess = (e) => res((e.target as any).result); }),
      new Promise<number>((res) => { txCheck.objectStore(STORE_RAW_STREAM_BATCHES).count().onsuccess = (e) => res((e.target as any).result); }),
      new Promise<number>((res) => { txCheck.objectStore(STORE_CANONICAL_CHECKPOINTS).count().onsuccess = (e) => res((e.target as any).result); }),
      new Promise<number>((res) => { txCheck.objectStore(STORE_HISTORY_STAGING).count().onsuccess = (e) => res((e.target as any).result); }),
      new Promise<number>((res) => { txCheck.objectStore(STORE_HISTORY_STAGING_MANIFESTS).count().onsuccess = (e) => res((e.target as any).result); }),
    ]);

    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('clearEntireArchive rejects if active streams exist', async () => {
    await expect(clearEntireArchive(db, 2)).rejects.toThrow('active_stream_in_progress');
  });
});
