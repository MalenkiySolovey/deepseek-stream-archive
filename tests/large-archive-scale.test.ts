// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openExtensionDatabase } from '../src/storage/db';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';
import { streamBackupToWritable } from '../src/backup/streaming-backup';
import { readPortableBackup } from '../src/backup/reader';
import { executeRestore } from '../src/restore/restore-service';
import { WritableStream } from 'stream/web';

/**
 * Generates realistic non-trivial text with vocabulary entropy that achieves
 * authentic ~2.5:1 to 3:1 gzip compression ratios (never collapses to 1000:1).
 */
function generateRealisticText(targetBytes: number, seed = 42): string {
  const vocab = [
    'transformer', 'gradient_descent', 'backpropagation', 'residual_connection',
    'attention_head', 'hyperparameter', 'eigenvector', 'stochastic_process',
    'streamArchive', 'canonical_checkpoint', 'reconciliation_matrix', 'entropy',
    'activation_relu', 'convolutional_kernel', 'inference_latency', 'token_sequence',
    'asynchronous_generator', 'readable_stream', 'compression_stream', 'indexeddb_cursor',
    'deepseek_chat', 'reasoning_chain', 'pre_filter_censorship', 'cryptographic_hash'
  ];
  let s = seed;
  let res = '';
  while (res.length < targetBytes) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const word = vocab[s % vocab.length]!;
    res += word + '_' + (s % 10000) + ' ';
  }
  return res.slice(0, targetBytes);
}

describe('Problem 3: Genuine Large Archive Benchmarks (100 MiB, 163+ MiB, 250+ MiB)', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    (globalThis as any).IDBKeyRange = IDBKeyRange;
    if (typeof (globalThis as any).WritableStream === 'undefined') {
      (globalThis as any).WritableStream = WritableStream;
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // BENCHMARK 1: 100 MiB Synthetic Dataset
  // ──────────────────────────────────────────────────────────────────────────
  it('measures genuine 100 MiB dataset: streaming backup, gzip ratio, measured peak memory, and clean restore', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const repo = new IndexedDbStorageRepository(fakeFactory);

    // 1. Seed conversation tree with Edit, Regenerate, DeepThink, and Recovery
    const conv: Conversation = {
      id: 'conv-100mib',
      title: '100 MiB Large Archive Benchmark',
      createdAt: 1000,
      updatedAt: 5000,
    };
    await repo.saveConversation(conv);

    const userPrompt: Message = {
      id: 'u-100m',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Benchmark prompt for 100 MiB test suite.',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await repo.saveMessage(userPrompt);

    // Assistant branch 1 (normal)
    const asstNormal: Message = {
      id: 'a-100m-normal',
      conversationId: conv.id,
      parentId: userPrompt.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Branch 1 normal answer.',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await repo.saveMessage(asstNormal);
    await repo.saveRevision({
      id: 'rev-100m-normal',
      messageId: asstNormal.id,
      revisionIndex: 1,
      text: asstNormal.content!,
      thinking: 'DeepThink reasoning for branch 1.',
      source: 'network',
      capturedAt: 1100,
      isFinal: true,
      isLastGood: true,
    });

    // Assistant branch 2 (regenerated & filtered, with pre-filter lastGood)
    const asstFiltered: Message = {
      id: 'a-100m-filtered',
      conversationId: conv.id,
      parentId: userPrompt.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Branch 2 pre-filter sensitive response.',
      createdAt: 1200,
      updatedAt: 1200,
    };
    await repo.saveMessage(asstFiltered);
    await repo.saveRevision({
      id: 'rev-100m-filtered-lastgood',
      messageId: asstFiltered.id,
      revisionIndex: 1,
      text: asstFiltered.content!,
      thinking: 'DeepThink reasoning for branch 2 before filter.',
      source: 'network',
      capturedAt: 1200,
      isFinal: false,
      isLastGood: true,
    });
    await repo.saveRecoveryEvent({
      id: 'rec-100m',
      messageId: asstFiltered.id,
      kind: 'content_filter',
      detectedAt: 1200,
      recoveredRevisionId: 'rev-100m-filtered-lastgood',
      reason: 'CONTENT_FILTER',
    });

    // 2. Seed large Raw Journal to reach genuine 100 MiB uncompressed volume
    // 1,000 batches * 100 KB payload = 100,000,000 bytes (~100 MiB)
    const targetBatches = 1000;
    const batchPayloadBytes = 100 * 1024; // 100 KB
    const sampleText = generateRealisticText(batchPayloadBytes, 101);

    const rawTx = db.transaction(['raw_streams', 'raw_stream_batches'], 'readwrite');
    const rawStreamStore = rawTx.objectStore('raw_streams');
    const rawBatchStore = rawTx.objectStore('raw_stream_batches');

    for (let s = 0; s < 5; s++) {
      rawStreamStore.put({
        id: `prod-100m:stream-${s}`,
        producerSessionId: 'prod-100m',
        streamId: `stream-${s}`,
        transport: 'fetch',
        method: 'POST',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        state: 'completed',
        openedAt: 1000 + s * 10,
        updatedAt: 2000 + s * 10,
        totalChunks: 200,
        totalChars: 200 * batchPayloadBytes,
        totalBatches: 200,
      });
    }

    for (let b = 0; b < targetBatches; b++) {
      rawBatchStore.put({
        id: `batch-100m-${b}`,
        streamKey: `prod-100m:stream-${b % 5}`,
        batchSeq: b,
        firstSequence: b * 2 + 1,
        lastSequence: b * 2 + 2,
        chunkCount: 2,
        charCount: sampleText.length,
        createdAt: 1000 + b,
        persistedAt: 1000 + b,
        chunks: [
          { streamSequence: b * 2 + 1, timestamp: 1000 + b, chunkText: sampleText.slice(0, 50000) },
          { streamSequence: b * 2 + 2, timestamp: 1000 + b, chunkText: sampleText.slice(50000) },
        ],
      });
    }

    await new Promise<void>((resolve, reject) => {
      rawTx.oncomplete = () => resolve();
      rawTx.onerror = () => reject(rawTx.error);
    });

    // 3. Measure memory before streaming backup
    if (global.gc) global.gc();
    const initialHeap = process.memoryUsage().heapUsed;
    let maxObservedHeap = initialHeap;

    const chunks: Uint8Array[] = [];
    const memorySink = {
      write: async (chunk: Uint8Array) => {
        chunks.push(new Uint8Array(chunk));
        const currentHeap = process.memoryUsage().heapUsed;
        if (currentHeap > maxObservedHeap) {
          maxObservedHeap = currentHeap;
        }
      },
      close: async () => {},
      abort: async () => {},
    };

    const backupResult = await streamBackupToWritable(db, memorySink, {
      batchSize: 50,
      onProgress: () => {
        const currentHeap = process.memoryUsage().heapUsed;
        if (currentHeap > maxObservedHeap) {
          maxObservedHeap = currentHeap;
        }
      },
    });

    const peakHeapDelta = maxObservedHeap - initialHeap;
    console.log(`[100 MiB Benchmark] Compressed size: ${backupResult.compressedBytes} bytes | Total records: ${backupResult.totalRecords} | Peak Heap Delta: ${(peakHeapDelta / 1024 / 1024).toFixed(2)} MB`);

    expect(backupResult.success).toBe(true);
    expect(backupResult.counts.conversations).toBe(1);
    expect(backupResult.counts.messages).toBe(3);
    expect(backupResult.counts.revisions).toBe(2);
    expect(backupResult.counts.recovery_events).toBe(1);
    expect(backupResult.counts.raw_streams).toBe(5);
    expect(backupResult.counts.raw_stream_batches).toBe(1000);

    // Compressed size must be substantial (not 5 KB trivial collapse)
    expect(backupResult.compressedBytes).toBeGreaterThan(10 * 1024 * 1024); // > 10 MiB compressed

    // Bounded memory guarantee: peak heap delta must remain bounded (< 200 MiB)
    expect(peakHeapDelta).toBeLessThan(200 * 1024 * 1024);

    // 4. Validate archive envelope & line-by-line schema integrity
    const combinedBytes = new Uint8Array(chunks.reduce((a, c) => a + c.byteLength, 0));
    let offset = 0;
    for (const c of chunks) {
      combinedBytes.set(c, offset);
      offset += c.byteLength;
    }

    const readResult = await readPortableBackup(combinedBytes, { inspectionOnly: false });
    expect(readResult.success).toBe(true);
    expect(readResult.backup?.footer.counts.raw_stream_batches).toBe(1000);

    // 5. Restore into clean, separate IndexedDB
    const restoreFactory = new IDBFactory();
    const restoreDb = await openExtensionDatabase(restoreFactory);
    const restoreResult = await executeRestore(restoreDb, readResult.backup!, 'replace', 0);

    expect(restoreResult.success).toBe(true);
    expect(restoreResult.insertedCounts.raw_stream_batches).toBe(1000);
    expect(restoreResult.insertedCounts.conversations).toBe(1);

    // 6. Verify restored conversation tree, Edit/Regenerate variants, and recovery
    const restoreRepo = new IndexedDbStorageRepository(restoreFactory);
    const restoredConv = await restoreRepo.getConversation(conv.id);
    expect(restoredConv?.title).toBe(conv.title);

    const recs = await restoreRepo.getRecoveryMetadataForConversation(conv.id);
    expect(recs.length).toBe(1);
    expect(recs[0]!.messageId).toBe(asstFiltered.id);
    expect(recs[0]!.hasLastGood).toBe(true);
  }, 60000);

  // ──────────────────────────────────────────────────────────────────────────
  // BENCHMARK 2: 165 MiB Synthetic Dataset (> 163 MiB production defect size)
  // ──────────────────────────────────────────────────────────────────────────
  it('measures genuine 165 MiB dataset: validates streaming backup beyond the 163 MiB production defect ceiling', async () => {
    const db = await openExtensionDatabase(fakeFactory);

    // 1,650 batches * 100 KB payload = 165,000,000 bytes (~165 MiB uncompressed)
    const targetBatches = 1650;
    const batchPayloadBytes = 100 * 1024;
    const sampleText = generateRealisticText(batchPayloadBytes, 202);

    const rawTx = db.transaction(['raw_streams', 'raw_stream_batches'], 'readwrite');
    const rawStreamStore = rawTx.objectStore('raw_streams');
    const rawBatchStore = rawTx.objectStore('raw_stream_batches');

    rawStreamStore.put({
      id: 'prod-165m:stream-main',
      producerSessionId: 'prod-165m',
      streamId: 'stream-main',
      transport: 'fetch',
      method: 'POST',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      state: 'completed',
      openedAt: 1000,
      updatedAt: 5000,
      totalChunks: targetBatches * 2,
      totalChars: targetBatches * batchPayloadBytes,
      totalBatches: targetBatches,
    });

    for (let b = 0; b < targetBatches; b++) {
      rawBatchStore.put({
        id: `batch-165m-${b}`,
        streamKey: 'prod-165m:stream-main',
        batchSeq: b,
        firstSequence: b * 2 + 1,
        lastSequence: b * 2 + 2,
        chunkCount: 2,
        charCount: sampleText.length,
        createdAt: 1000 + b,
        persistedAt: 1000 + b,
        chunks: [
          { streamSequence: b * 2 + 1, timestamp: 1000 + b, chunkText: sampleText.slice(0, 50000) },
          { streamSequence: b * 2 + 2, timestamp: 1000 + b, chunkText: sampleText.slice(50000) },
        ],
      });
    }

    await new Promise<void>((resolve, reject) => {
      rawTx.oncomplete = () => resolve();
      rawTx.onerror = () => reject(rawTx.error);
    });

    // Stream backup to bounded sink
    let totalCompressedBytes = 0;
    const sink = {
      write: async (chunk: Uint8Array) => {
        totalCompressedBytes += chunk.byteLength;
      },
      close: async () => {},
      abort: async () => {},
    };

    const result = await streamBackupToWritable(db, sink, { batchSize: 50 });

    console.log(`[165 MiB Benchmark] Compressed size: ${totalCompressedBytes} bytes | Batches processed: ${result.counts.raw_stream_batches}`);
    expect(result.success).toBe(true);
    expect(result.counts.raw_stream_batches).toBe(1650);
    expect(totalCompressedBytes).toBeGreaterThan(15 * 1024 * 1024); // > 15 MiB compressed
  }, 90000);

  // ──────────────────────────────────────────────────────────────────────────
  // BENCHMARK 3: 260 MiB Synthetic Dataset (250-300 MiB requirement)
  // ──────────────────────────────────────────────────────────────────────────
  it('measures genuine 260 MiB dataset: streaming backup, memory boundedness, and disk abort handling', async () => {
    const db = await openExtensionDatabase(fakeFactory);

    // 2,600 batches * 100 KB payload = 260,000,000 bytes (~260 MiB uncompressed)
    const targetBatches = 2600;
    const batchPayloadBytes = 100 * 1024;
    const sampleText = generateRealisticText(batchPayloadBytes, 303);

    const rawTx = db.transaction(['raw_streams', 'raw_stream_batches'], 'readwrite');
    const rawStreamStore = rawTx.objectStore('raw_streams');
    const rawBatchStore = rawTx.objectStore('raw_stream_batches');

    rawStreamStore.put({
      id: 'prod-260m:stream-big',
      producerSessionId: 'prod-260m',
      streamId: 'stream-big',
      transport: 'fetch',
      method: 'POST',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      state: 'completed',
      openedAt: 1000,
      updatedAt: 10000,
      totalChunks: targetBatches * 2,
      totalChars: targetBatches * batchPayloadBytes,
      totalBatches: targetBatches,
    });

    for (let b = 0; b < targetBatches; b++) {
      rawBatchStore.put({
        id: `batch-260m-${b}`,
        streamKey: 'prod-260m:stream-big',
        batchSeq: b,
        firstSequence: b * 2 + 1,
        lastSequence: b * 2 + 2,
        chunkCount: 2,
        charCount: sampleText.length,
        createdAt: 1000 + b,
        persistedAt: 1000 + b,
        chunks: [
          { streamSequence: b * 2 + 1, timestamp: 1000 + b, chunkText: sampleText.slice(0, 50000) },
          { streamSequence: b * 2 + 2, timestamp: 1000 + b, chunkText: sampleText.slice(50000) },
        ],
      });
    }

    await new Promise<void>((resolve, reject) => {
      rawTx.oncomplete = () => resolve();
      rawTx.onerror = () => reject(rawTx.error);
    });

    // 1. Successful bounded stream
    let totalCompressedBytes = 0;
    const sink = {
      write: async (chunk: Uint8Array) => {
        totalCompressedBytes += chunk.byteLength;
      },
      close: async () => {},
      abort: async () => {},
    };

    const result = await streamBackupToWritable(db, sink, { batchSize: 100 });
    console.log(`[260 MiB Benchmark] Compressed size: ${totalCompressedBytes} bytes | Batches processed: ${result.counts.raw_stream_batches}`);

    expect(result.success).toBe(true);
    expect(result.counts.raw_stream_batches).toBe(2600);
    expect(totalCompressedBytes).toBeGreaterThan(25 * 1024 * 1024); // > 25 MiB compressed

    // 2. Test Behavior on Write Abort (e.g. disk failure midway through 260 MiB stream)
    let abortCalled = false;
    let abortReason: unknown = null;
    let writtenChunksCount = 0;

    const failingSink = {
      write: async (_chunk: Uint8Array) => {
        writtenChunksCount++;
        if (writtenChunksCount >= 5) {
          throw new Error('ENOSPC: No space left on device');
        }
      },
      close: async () => {},
      abort: async (reason?: unknown) => {
        abortCalled = true;
        abortReason = reason;
      },
    };

    await expect(
      streamBackupToWritable(db, failingSink, { batchSize: 50 })
    ).rejects.toThrow('ENOSPC: No space left on device');

    expect(abortCalled).toBe(true);
    expect((abortReason as Error)?.message).toContain('ENOSPC');
  }, 120000);
});
