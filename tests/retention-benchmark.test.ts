import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import {
  buildRawRetentionPlan,
  executeRawRetentionPlan,
} from '../src/storage/retention/cleanup';
import {
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_MESSAGES,
} from '../src/storage/schema';
import type { RawStreamRecord, RawStreamBatch } from '../src/storage/raw-journal/types';

describe('Retention Planning & Cleanup Scalability Benchmark', () => {
  let fakeFactory: IDBFactory;
  let db: IDBDatabase;
  const NOW = 100000000000;
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    fakeFactory = new IDBFactory();
    db = await openExtensionDatabase(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
  });

  it('measures retention planning and batch cleanup throughput for 500 synthetic streams', async () => {
    const streamCount = 500;
    const oldStreamCount = 300;

    // Seed 1,000 streams (600 older than 30d, 400 recent)
    const tx = db.transaction([STORE_RAW_STREAMS, STORE_RAW_STREAM_BATCHES], 'readwrite');
    const streamStore = tx.objectStore(STORE_RAW_STREAMS);
    const batchStore = tx.objectStore(STORE_RAW_STREAM_BATCHES);

    for (let i = 0; i < streamCount; i++) {
      const isOld = i < oldStreamCount;
      const openedAt = isOld ? NOW - 40 * ONE_DAY_MS : NOW - 5 * ONE_DAY_MS;
      const streamKey = `bench-prod:stream-${i}`;

      const stream: RawStreamRecord = {
        id: streamKey,
        producerSessionId: 'bench-prod',
        streamId: `stream-${i}`,
        transport: 'fetch',
        url: 'https://chat.deepseek.com/chat/completion',
        method: 'POST',
        state: 'completed',
        openedAt,
        updatedAt: openedAt + 1000,
        finalizedAt: openedAt + 1000,
        totalChunks: 3,
        totalChars: 150,
        totalBatches: 2,
        integrity: 'intact',
      };
      streamStore.put(stream);

      const b1: RawStreamBatch = {
        id: `${streamKey}:1`,
        streamKey,
        batchSeq: 1,
        chunks: [{ streamSequence: 0, chunkText: 'abc', timestamp: openedAt }],
        createdAt: openedAt,
        charCount: 3,
      };
      const b2: RawStreamBatch = {
        id: `${streamKey}:2`,
        streamKey,
        batchSeq: 2,
        chunks: [{ streamSequence: 1, chunkText: 'def', timestamp: openedAt + 500 }],
        createdAt: openedAt + 500,
        charCount: 3,
      };
      batchStore.put(b1);
      batchStore.put(b2);
    }

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Measure buildRawRetentionPlan
    const startPlan = performance.now();
    const plan = await buildRawRetentionPlan(db, '30', new Set(), NOW);
    const planDurationMs = performance.now() - startPlan;

    console.log(
      `[Benchmark 1000 Streams] Plan Duration: ${planDurationMs.toFixed(2)}ms | Candidates: ${plan.candidateStreamKeys.length} | Candidate Batches: ${plan.candidateBatchCount}`
    );

    expect(plan.candidateStreamKeys).toHaveLength(oldStreamCount);
    expect(plan.candidateBatchCount).toBe(oldStreamCount * 2);
    expect(plan.protectedStreamCount).toBe(streamCount - oldStreamCount);
    expect(planDurationMs).toBeLessThan(3000);

    // Measure executeRawRetentionPlan
    const startExec = performance.now();
    const result = await executeRawRetentionPlan(db, plan, new Set());
    const execDurationMs = performance.now() - startExec;

    console.log(
      `[Benchmark 1000 Streams] Execute Duration: ${execDurationMs.toFixed(2)}ms | Deleted Streams: ${result.deletedStreamCount} | Deleted Batches: ${result.deletedBatchCount}`
    );

    expect(result.success).toBe(true);
    expect(result.deletedStreamCount).toBe(oldStreamCount);
    expect(result.deletedBatchCount).toBe(oldStreamCount * 2);
    expect(execDurationMs).toBeLessThan(5000);

    // Verify remaining store counts
    const txCheck = db.transaction([STORE_RAW_STREAMS, STORE_RAW_STREAM_BATCHES], 'readonly');
    const remainingStreams = await new Promise<number>((res) => {
      txCheck.objectStore(STORE_RAW_STREAMS).count().onsuccess = (e) => res((e.target as any).result);
    });
    const remainingBatches = await new Promise<number>((res) => {
      txCheck.objectStore(STORE_RAW_STREAM_BATCHES).count().onsuccess = (e) => res((e.target as any).result);
    });

    expect(remainingStreams).toBe(streamCount - oldStreamCount);
    expect(remainingBatches).toBe((streamCount - oldStreamCount) * 2);
  }, 20000);
});
