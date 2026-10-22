import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RawJournalBuffer } from '../src/storage/raw-journal/buffer';
import { RawStreamRepository } from '../src/storage/raw-journal/repository';
import { replayRawBatches, replayRawStream } from '../src/storage/raw-journal/replay';
import { closeExtensionDatabase } from '../src/storage/db';
import { isDeepSeekGenerationEndpoint } from '../src/adapters/deepseek/compatibility/candidate-policy';
import { validateTransportEventPayload } from '../src/bridge/validation';
import type { RawStreamBatch } from '../src/storage/raw-journal/types';

describe('Evidence Integrity & Persistence Truth Gate', () => {
  let fakeFactory: IDBFactory;
  let repo: RawStreamRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    repo = new RawStreamRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
    closeExtensionDatabase();
  });

  describe('ACK Identity Verification & Robust Queue Retention', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects OPEN ACK with mismatched streamKey, leaves stream un-acked, and schedules retry', async () => {
      let openAttempts = 0;
      const buffer = new RawJournalBuffer({
        retryDelaysMs: [100, 200],
        messageSender: async (msg) => {
          if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN') {
            openAttempts++;
            if (openAttempts === 1) {
              // Wrong streamKey on attempt 1!
              return { success: true, streamKey: 'wrong_producer:wrong_stream' };
            }
            // Correct streamKey on attempt 2
            return { success: true, streamKey: 'p_open:s_open' };
          }
          return { success: true };
        },
      });

      buffer.handleOpen({
        producerSessionId: 'p_open',
        streamId: 's_open',
        sequence: 1,
        streamSequence: 0,
        timestamp: 100,
        transport: 'fetch',
        type: 'open',
      });

      // After first attempt: mismatched ACK should leave openAcked = false
      await Promise.resolve();
      await Promise.resolve();
      expect(openAttempts).toBe(1);
      const stateBefore = buffer.getStreamState('p_open:s_open');
      expect(stateBefore?.openAcked).toBe(false);

      // Advance retry timer
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();

      expect(openAttempts).toBe(2);
      const stateAfter = buffer.getStreamState('p_open:s_open');
      expect(stateAfter?.openAcked).toBe(true);

      buffer.destroy();
    });

    it('rejects BATCH ACK with mismatched streamKey or batchSeq and keeps batch pending in queue', async () => {
      let batchAttempts = 0;
      const buffer = new RawJournalBuffer({
        maxBatchChars: 10,
        retryDelaysMs: [100, 200],
        messageSender: async (msg) => {
          if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN') {
            return { success: true, streamKey: 'p_batch:s_batch' };
          }
          if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_BATCH') {
            batchAttempts++;
            if (batchAttempts === 1) {
              // Mismatched batchSeq on attempt 1!
              return { success: true, streamKey: 'p_batch:s_batch', batchSeq: 999 };
            }
            // Correct batchSeq on retry
            return { success: true, streamKey: 'p_batch:s_batch', batchSeq: 1, persistedAt: Date.now() };
          }
          return { success: true };
        },
      });

      buffer.handleOpen({
        producerSessionId: 'p_batch',
        streamId: 's_batch',
        sequence: 1,
        streamSequence: 0,
        timestamp: 100,
        transport: 'fetch',
        type: 'open',
      });

      await Promise.resolve();
      await Promise.resolve();

      buffer.handleChunk({
        producerSessionId: 'p_batch',
        streamId: 's_batch',
        sequence: 2,
        streamSequence: 1,
        timestamp: 110,
        transport: 'fetch',
        type: 'chunk',
        chunkText: 'exceed threshold 12345',
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(batchAttempts).toBe(1);

      // Invariant: batch MUST remain in queue because ACK identity was invalid!
      const stateBefore = buffer.getStreamState('p_batch:s_batch');
      expect(stateBefore?.pendingBatchesCount).toBe(1);

      // Trigger retry timer
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();

      expect(batchAttempts).toBe(2);
      const stateAfter = buffer.getStreamState('p_batch:s_batch');
      expect(stateAfter?.pendingBatchesCount).toBe(0);

      buffer.destroy();
    });

    it('rejects FINALIZE ACK with mismatched streamKey and keeps stream pending in buffer', async () => {
      let finalizeAttempts = 0;
      const buffer = new RawJournalBuffer({
        retryDelaysMs: [100],
        messageSender: async (msg) => {
          if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN') {
            return { success: true, streamKey: 'p_fin:s_fin' };
          }
          if (msg.type === 'STREAMARCHIVE_FINALIZE_RAW_STREAM') {
            finalizeAttempts++;
            if (finalizeAttempts === 1) {
              // Mismatched streamKey on attempt 1
              return { success: true, streamKey: 'wrong:key', finalState: 'completed' };
            }
            return { success: true, streamKey: 'p_fin:s_fin', finalState: 'completed' };
          }
          return { success: true };
        },
      });

      buffer.handleOpen({
        producerSessionId: 'p_fin',
        streamId: 's_fin',
        sequence: 1,
        streamSequence: 0,
        timestamp: 100,
        transport: 'fetch',
        type: 'open',
      });

      await Promise.resolve();
      await Promise.resolve();

      const termPromise = buffer.handleTerminal({
        producerSessionId: 'p_fin',
        streamId: 's_fin',
        sequence: 2,
        streamSequence: 1,
        timestamp: 110,
        transport: 'fetch',
        type: 'complete',
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(finalizeAttempts).toBe(1);

      // Stream must NOT be evicted on mismatched FINALIZE ACK!
      expect(buffer.getStreamState('p_fin:s_fin')).not.toBeNull();

      // Advance retry
      await vi.advanceTimersByTimeAsync(100);
      await termPromise;

      expect(finalizeAttempts).toBe(2);
      expect(buffer.getStreamState('p_fin:s_fin')).toBeNull();

      buffer.destroy();
    });

    it('enforces strict backoff schedule: new chunks or flushes during retry timer do NOT bypass schedule', async () => {
      let batchRequestsCount = 0;
      const buffer = new RawJournalBuffer({
        maxBatchChars: 10,
        retryDelaysMs: [5000], // 5 second backoff
        messageSender: async (msg) => {
          if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN') {
            return { success: true, streamKey: 'p_back:s_back' };
          }
          if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_BATCH') {
            batchRequestsCount++;
            return { success: false, streamKey: 'p_back:s_back', error: 'Service Unavailable' };
          }
          return { success: true };
        },
      });

      buffer.handleOpen({
        producerSessionId: 'p_back',
        streamId: 's_back',
        sequence: 1,
        streamSequence: 0,
        timestamp: 100,
        transport: 'fetch',
        type: 'open',
      });

      await Promise.resolve();
      await Promise.resolve();

      // Trigger batch 1
      buffer.handleChunk({
        producerSessionId: 'p_back',
        streamId: 's_back',
        sequence: 2,
        streamSequence: 1,
        timestamp: 110,
        transport: 'fetch',
        type: 'chunk',
        chunkText: 'batch_one_12345',
      });

      await Promise.resolve();
      await Promise.resolve();
      expect(batchRequestsCount).toBe(1);

      // While retry timer is active (scheduled for 5000ms), deliver another chunk and flush
      buffer.handleChunk({
        producerSessionId: 'p_back',
        streamId: 's_back',
        sequence: 3,
        streamSequence: 2,
        timestamp: 120,
        transport: 'fetch',
        type: 'chunk',
        chunkText: 'batch_two_67890',
      });
      buffer.flushAll();

      await Promise.resolve();
      await Promise.resolve();

      // STRICT INVARIANT: batchRequestsCount MUST NOT increase before timer fires!
      expect(batchRequestsCount).toBe(1);

      // Advance by 2000ms: still 1
      await vi.advanceTimersByTimeAsync(2000);
      expect(batchRequestsCount).toBe(1);

      // Advance remaining 3000ms: retry timer triggers attempt 2
      await vi.advanceTimersByTimeAsync(3000);
      expect(batchRequestsCount).toBe(2);

      buffer.destroy();
    });
  });

  describe('Repository Monotonic Ordering & Integrity Truth', () => {
    it('requires first batch to be #1; rejects out-of-order batchSeq with batch_sequence_gap and marks stream degraded', async () => {
      await repo.openStream({
        producerSessionId: 'p_order',
        streamId: 's_order',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
      });

      // Try persisting batch #2 directly without batch #1
      const skipBatch: RawStreamBatch = {
        id: 'p_order:s_order:2',
        streamKey: 'p_order:s_order',
        batchSeq: 2,
        chunks: [{ streamSequence: 1, chunkText: 'skipped', timestamp: 100 }],
        createdAt: 100,
        charCount: 7,
      };

      await expect(repo.persistBatch(skipBatch)).rejects.toMatchObject({
        code: 'batch_sequence_gap',
      });

      const stream = await repo.getStream('p_order:s_order');
      expect(stream?.state).toBe('degraded');
      expect(stream?.durabilityGap).toBe(true);
      expect(stream?.integrity).toBe('gap_detected');
    });

    it('rejects batch #3 following batch #1 with batch_sequence_gap', async () => {
      await repo.openStream({
        producerSessionId: 'p_seq',
        streamId: 's_seq',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
      });

      // Batch 1 succeeds
      await repo.persistBatch({
        id: 'p_seq:s_seq:1',
        streamKey: 'p_seq:s_seq',
        batchSeq: 1,
        chunks: [{ streamSequence: 1, chunkText: 'b1', timestamp: 100 }],
        createdAt: 100,
        charCount: 2,
      });

      // Batch 3 skipped batch 2
      await expect(
        repo.persistBatch({
          id: 'p_seq:s_seq:3',
          streamKey: 'p_seq:s_seq',
          batchSeq: 3,
          chunks: [{ streamSequence: 2, chunkText: 'b3', timestamp: 200 }],
          createdAt: 200,
          charCount: 2,
        })
      ).rejects.toMatchObject({
        code: 'batch_sequence_gap',
      });
    });

    it('forensically preserves chunks when chunk sequence gap is observed, marking record gap_detected', async () => {
      await repo.openStream({
        producerSessionId: 'p_chunk_gap',
        streamId: 's_chunk_gap',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
      });

      // Batch 1 has chunks 1 and 2
      await repo.persistBatch({
        id: 'p_chunk_gap:s_chunk_gap:1',
        streamKey: 'p_chunk_gap:s_chunk_gap',
        batchSeq: 1,
        chunks: [
          { streamSequence: 1, chunkText: 'part1', timestamp: 100 },
          { streamSequence: 2, chunkText: 'part2', timestamp: 110 },
        ],
        createdAt: 110,
        charCount: 10,
      });

      // Batch 2 has chunk sequence gap: expected sequence 3, but received sequence 5 (chunks 3 and 4 were lost over transport)
      const ack2 = await repo.persistBatch({
        id: 'p_chunk_gap:s_chunk_gap:2',
        streamKey: 'p_chunk_gap:s_chunk_gap',
        batchSeq: 2,
        chunks: [
          { streamSequence: 5, chunkText: 'part5', timestamp: 120 },
        ],
        createdAt: 120,
        charCount: 5,
      });

      expect(ack2.success).toBe(true);

      // Verify forensic preservation: batch 2 is stored in IndexedDB
      const storedBatches = await repo.listBatchesForStream('p_chunk_gap:s_chunk_gap');
      expect(storedBatches).toHaveLength(2);
      expect(storedBatches[1]?.chunks[0]?.chunkText).toBe('part5');

      // Verify stream is truthfully marked degraded with gap_detected
      const stream = await repo.getStream('p_chunk_gap:s_chunk_gap');
      expect(stream?.integrity).toBe('gap_detected');
      expect(stream?.durabilityGap).toBe(true);
      expect(stream?.state).toBe('degraded');
      expect(stream?.lastPersistedStreamSequence).toBe(5);
    });

    it('handles idempotent finalize without doubling droppedChars and returns original finalizedAt', async () => {
      await repo.openStream({
        producerSessionId: 'p_fin_idem',
        streamId: 's_fin_idem',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
      });

      const res1 = await repo.finalizeStream(
        'p_fin_idem:s_fin_idem',
        'completed',
        'finished',
        undefined,
        42, // 42 droppedChars
        false
      );

      expect(res1.success).toBe(true);
      expect(res1.finalizedAt).toBeGreaterThan(0);

      // Identical re-delivery (e.g. on network retry)
      const res2 = await repo.finalizeStream(
        'p_fin_idem:s_fin_idem',
        'completed',
        'finished',
        undefined,
        42,
        false
      );

      expect(res2.success).toBe(true);
      expect(res2.finalizedAt).toBe(res1.finalizedAt); // Original commit time preserved

      const stream = await repo.getStream('p_fin_idem:s_fin_idem');
      // Crucial: droppedChars MUST NOT become 84!
      expect(stream?.droppedChars).toBe(42);
    });

    it('rejects conflicting finalize metadata with finalize_conflict without mutating durable record', async () => {
      await repo.openStream({
        producerSessionId: 'p_fin_conf',
        streamId: 's_fin_conf',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
      });

      await repo.finalizeStream('p_fin_conf:s_fin_conf', 'completed', 'finished');

      // Attempt conflicting terminal state on already finalized stream
      await expect(
        repo.finalizeStream('p_fin_conf:s_fin_conf', 'aborted', 'user_abort')
      ).rejects.toMatchObject({
        code: 'finalize_conflict',
      });

      const stream = await repo.getStream('p_fin_conf:s_fin_conf');
      expect(stream?.state).toBe('completed');
      expect(stream?.terminalReason).toBe('finished');
    });

    it('verifies createdAt in batch immutable payload equality', async () => {
      await repo.openStream({
        producerSessionId: 'p_created',
        streamId: 's_created',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
      });

      await repo.persistBatch({
        id: 'p_created:s_created:1',
        streamKey: 'p_created:s_created',
        batchSeq: 1,
        chunks: [{ streamSequence: 1, chunkText: 'test', timestamp: 100 }],
        createdAt: 100,
        charCount: 4,
      });

      // Different createdAt under same batch ID
      await expect(
        repo.persistBatch({
          id: 'p_created:s_created:1',
          streamKey: 'p_created:s_created',
          batchSeq: 1,
          chunks: [{ streamSequence: 1, chunkText: 'test', timestamp: 100 }],
          createdAt: 999, // Different!
          charCount: 4,
        })
      ).rejects.toMatchObject({
        code: 'batch_id_conflict',
      });
    });

    it('forbids colon in producerSessionId and streamId', async () => {
      await expect(
        repo.openStream({
          producerSessionId: 'prod:with:colons',
          streamId: 'stream1',
          transport: 'fetch',
          url: 'https://chat.deepseek.com/api/v0/chat/completion',
        })
      ).rejects.toMatchObject({
        code: 'invalid_stream_identity',
      });

      await expect(
        repo.openStream({
          producerSessionId: 'prod1',
          streamId: 'stream:with:colons',
          transport: 'fetch',
          url: 'https://chat.deepseek.com/api/v0/chat/completion',
        })
      ).rejects.toMatchObject({
        code: 'invalid_stream_identity',
      });
    });
  });

  describe('Replay Truth & Audit Diagnostics', () => {
    it('does NOT sort corrupted chunks into validity and reports granular audit report', () => {
      // Intentionally out-of-order chunks inside batches
      const batches: RawStreamBatch[] = [
        {
          id: 'p_rep:s_rep:1',
          streamKey: 'p_rep:s_rep',
          batchSeq: 1,
          chunks: [
            { streamSequence: 2, chunkText: 'second\n\n', timestamp: 200 }, // Started at 2 instead of 1!
            { streamSequence: 1, chunkText: 'first\n\n', timestamp: 100 },  // Out of order!
          ],
          createdAt: 200,
          charCount: 15,
        },
      ];

      const result = replayRawBatches(batches);
      expect(result.integrity).toBe('degraded');
      expect(result.audit.missingPrefix).toBe(true); // First chunk was sequence 2, not 1
      expect(result.audit.chunkGap).toBe(true);
    });

    it('reports missing prefix when batch starts at #2 and marks degraded', () => {
      const batches: RawStreamBatch[] = [
        {
          id: 'p_pre:s_pre:2',
          streamKey: 'p_pre:s_pre',
          batchSeq: 2, // Missing batch 1!
          chunks: [{ streamSequence: 1, chunkText: 'data: {}\n\n', timestamp: 100 }],
          createdAt: 100,
          charCount: 11,
        },
      ];

      const result = replayRawBatches(batches);
      expect(result.integrity).toBe('degraded');
      expect(result.audit.missingPrefix).toBe(true);
    });

    it('replayRawStream accepts RawStreamRecord directly avoiding fragile string-splitting', () => {
      const streamRecord = {
        id: 'session_uuid:stream_uuid',
        producerSessionId: 'session_uuid',
        streamId: 'stream_uuid',
        transport: 'fetch' as const,
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        method: 'POST',
        state: 'completed' as const,
        openedAt: 100,
        updatedAt: 200,
        totalChunks: 1,
        totalChars: 11,
        totalBatches: 1,
      };

      const batches: RawStreamBatch[] = [
        {
          id: 'session_uuid:stream_uuid:1',
          streamKey: 'session_uuid:stream_uuid',
          batchSeq: 1,
          chunks: [{ streamSequence: 1, chunkText: 'data: {"o":"SET","p":"response/fragments/0/content","v":"hello"}\n\n', timestamp: 100 }],
          createdAt: 100,
          charCount: 74,
        },
      ];

      const result = replayRawStream(streamRecord, batches);
      expect(result.streamKey).toBe('session_uuid:stream_uuid');
      expect(result.integrity).toBe('complete');
      expect(result.projectedAnswer).toBe('hello');
    });
  });

  describe('Host Anti-Spoofing & Bridge Bounds', () => {
    it('rejects external origins with candidate generation endpoint paths', () => {
      expect(isDeepSeekGenerationEndpoint('https://evil.example.com/api/v0/chat/completion')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('https://attacker.org/api/v0/chat/completion')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('http://localhost:8080/api/v0/chat/completion')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('//evil.example.com/api/v0/chat/completion')).toBe(false);

      // Legitimate DeepSeek endpoints
      expect(isDeepSeekGenerationEndpoint('https://chat.deepseek.com/api/v0/chat/completion')).toBe(true);
      expect(isDeepSeekGenerationEndpoint('/api/v0/chat/completion')).toBe(true);
    });

    it('rejects bridge transport payloads with colons in session or stream IDs', () => {
      const invalidWithColon = {
        producerSessionId: 'session:colon',
        streamId: 'normal_stream',
        sequence: 1,
        timestamp: 100,
        transport: 'fetch',
        type: 'chunk',
        chunkText: 'hello',
      };
      expect(validateTransportEventPayload(invalidWithColon)).toBeNull();

      const invalidStreamWithColon = {
        producerSessionId: 'normal_session',
        streamId: 'stream:colon',
        sequence: 1,
        timestamp: 100,
        transport: 'fetch',
        type: 'chunk',
        chunkText: 'hello',
      };
      expect(validateTransportEventPayload(invalidStreamWithColon)).toBeNull();
    });

    it('terminating stream awaiting FINALIZE ACK is not prematurely evicted by capacity limit', async () => {
      const buffer = new RawJournalBuffer({
        maxActiveKnownStreams: 2,
        messageSender: async (msg) => {
          if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN') {
            return { success: true, streamKey: (msg as any).streamId ? `${(msg as any).producerSessionId}:${(msg as any).streamId}` : 'p:s' };
          }
          if (msg.type === 'STREAMARCHIVE_FINALIZE_RAW_STREAM') {
            // Keep finalize pending (simulating slow commit)
            return new Promise(() => {});
          }
          return { success: true };
        },
      });

      // Stream 1 opens and begins termination
      buffer.handleOpen({
        producerSessionId: 'p1',
        streamId: 's1',
        sequence: 1,
        streamSequence: 0,
        timestamp: 100,
        transport: 'fetch',
        type: 'open',
      });
      buffer.handleTerminal({
        producerSessionId: 'p1',
        streamId: 's1',
        sequence: 2,
        streamSequence: 1,
        timestamp: 110,
        transport: 'fetch',
        type: 'complete',
      });

      // Stream 2 opens
      buffer.handleOpen({
        producerSessionId: 'p2',
        streamId: 's2',
        sequence: 1,
        streamSequence: 0,
        timestamp: 100,
        transport: 'fetch',
        type: 'open',
      });

      // Try opening stream 3: capacity is 2. Stream 1 is terminating but NOT finalized.
      buffer.handleOpen({
        producerSessionId: 'p3',
        streamId: 's3',
        sequence: 1,
        streamSequence: 0,
        timestamp: 100,
        transport: 'fetch',
        type: 'open',
      });

      // Stream 1 MUST NOT have been deleted before receiving its FINALIZE ACK!
      expect(buffer.getStreamState('p1:s1')).not.toBeNull();
      // Stream 3 was rejected due to strict capacity ceiling
      expect(buffer.getStreamState('p3:s3')).toBeNull();

      buffer.destroy();
    });
  });
});
