import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RawJournalBuffer } from '../src/storage/raw-journal/buffer';
import { RawStreamRepository } from '../src/storage/raw-journal/repository';
import { replayRawBatches } from '../src/storage/raw-journal/replay';
import { closeExtensionDatabase } from '../src/storage/db';
import type {
  ExtensionInternalMessage,
  PersistRawStreamOpenRequest,
  PersistRawBatchRequest,
  FinalizeRawStreamRequest,
} from '../src/bridge/messages';
import type { TransportEvent } from '../src/transport/types';
import type { RawStreamBatch } from '../src/storage/raw-journal/types';

describe('Raw Journal Integrity & Crash-Durability Gate', () => {
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

  describe('Strict Ordered Queue & ACK Pipeline', () => {
    it('guarantees OPEN ACK -> BATCH 1 ACK -> BATCH 2 ACK -> FINAL BATCH ACK -> FINALIZE ACK', async () => {
      const messageLog: string[] = [];
      const ackLog: string[] = [];

      let resolveOpenAck: ((val: any) => void) | null = null;
      let resolveBatch1Ack: ((val: any) => void) | null = null;
      let resolveBatch2Ack: ((val: any) => void) | null = null;
      let resolveFinalizeAck: ((val: any) => void) | null = null;

      const buffer = new RawJournalBuffer({
        maxBatchChars: 20,
        flushDelayMs: 50,
        messageSender: (msg) => {
          messageLog.push(msg.type);
          if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN') {
            return new Promise((resolve) => {
              resolveOpenAck = () => {
                ackLog.push('ACK_OPEN');
                resolve({ success: true, streamKey: 'p:s' });
              };
            });
          }
          if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_BATCH') {
            const batch = (msg as PersistRawBatchRequest).batch;
            return new Promise((resolve) => {
              if (batch.batchSeq === 1) {
                resolveBatch1Ack = () => {
                  ackLog.push(`ACK_BATCH_${batch.batchSeq}`);
                  resolve({ success: true, streamKey: 'p:s', batchSeq: 1, persistedAt: 100 });
                };
              } else {
                resolveBatch2Ack = () => {
                  ackLog.push(`ACK_BATCH_${batch.batchSeq}`);
                  resolve({ success: true, streamKey: 'p:s', batchSeq: 2, persistedAt: 200 });
                };
              }
            });
          }
          if (msg.type === 'STREAMARCHIVE_FINALIZE_RAW_STREAM') {
            return new Promise((resolve) => {
              resolveFinalizeAck = () => {
                ackLog.push('ACK_FINALIZE');
                resolve({ success: true, streamKey: 'p:s', finalState: 'completed' });
              };
            });
          }
          return Promise.resolve({ success: true });
        },
      });

      // 1. Initiate Open
      const openPromise = buffer.handleOpen({
        producerSessionId: 'p',
        streamId: 's',
        sequence: 1,
        streamSequence: 0,
        timestamp: 10,
        transport: 'fetch',
        type: 'open',
      });

      // Only OPEN request is dispatched
      expect(messageLog).toEqual(['STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN']);
      expect(ackLog).toEqual([]);

      // 2. Feed chunk 1 & 2 while OPEN is still awaiting ACK
      buffer.handleChunk({
        producerSessionId: 'p',
        streamId: 's',
        sequence: 2,
        streamSequence: 1,
        timestamp: 20,
        transport: 'fetch',
        type: 'chunk',
        chunkText: '123456789012345678901', // 21 chars > 20 threshold
      });

      buffer.handleChunk({
        producerSessionId: 'p',
        streamId: 's',
        sequence: 3,
        streamSequence: 2,
        timestamp: 30,
        transport: 'fetch',
        type: 'chunk',
        chunkText: 'abcdefghijklmnopqrstuv', // 22 chars > 20 threshold
      });

      // Crucial invariant: Batches MUST NOT be sent before OPEN is ACKed!
      expect(messageLog).toEqual(['STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN']);

      // 3. ACK OPEN
      resolveOpenAck!({});
      await openPromise;
      await Promise.resolve();
      await Promise.resolve();

      // Now BATCH 1 should be sent, but NOT BATCH 2!
      expect(messageLog).toEqual([
        'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN',
        'STREAMARCHIVE_PERSIST_RAW_BATCH',
      ]);
      expect(ackLog).toEqual(['ACK_OPEN']);

      // 4. Send Terminal complete
      const terminalPromise = buffer.handleTerminal({
        producerSessionId: 'p',
        streamId: 's',
        sequence: 4,
        streamSequence: 3,
        timestamp: 40,
        transport: 'fetch',
        type: 'complete',
      });

      // Crucial invariant: FINALIZE MUST NOT be sent while batches are in flight!
      expect(messageLog).toEqual([
        'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN',
        'STREAMARCHIVE_PERSIST_RAW_BATCH',
      ]);

      // 5. ACK BATCH 1
      resolveBatch1Ack!({});
      await Promise.resolve();
      await Promise.resolve();

      // Now BATCH 2 is dispatched, FINALIZE still waits
      expect(messageLog).toEqual([
        'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN',
        'STREAMARCHIVE_PERSIST_RAW_BATCH',
        'STREAMARCHIVE_PERSIST_RAW_BATCH',
      ]);
      expect(ackLog).toEqual(['ACK_OPEN', 'ACK_BATCH_1']);

      // 6. ACK BATCH 2
      resolveBatch2Ack!({});
      await Promise.resolve();
      await Promise.resolve();

      // Now FINALIZE is finally dispatched!
      expect(messageLog).toEqual([
        'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN',
        'STREAMARCHIVE_PERSIST_RAW_BATCH',
        'STREAMARCHIVE_PERSIST_RAW_BATCH',
        'STREAMARCHIVE_FINALIZE_RAW_STREAM',
      ]);
      expect(ackLog).toEqual(['ACK_OPEN', 'ACK_BATCH_1', 'ACK_BATCH_2']);

      // 7. ACK FINALIZE
      resolveFinalizeAck!({});
      await terminalPromise;
      await Promise.resolve();
      await Promise.resolve();

      expect(ackLog).toEqual(['ACK_OPEN', 'ACK_BATCH_1', 'ACK_BATCH_2', 'ACK_FINALIZE']);
      // Buffer cleaned up after complete durable lifecycle
      expect(buffer.getStreamState('p:s')).toBeNull();

      buffer.destroy();
    });
  });

  describe('Repository Durability & Invariants', () => {
    it('never synthesizes placeholder streams for orphan batches or orphan finalizations', async () => {
      const orphanBatch: RawStreamBatch = {
        id: 'orphan:stream:1',
        streamKey: 'orphan:stream',
        batchSeq: 1,
        chunks: [{ streamSequence: 1, chunkText: 'orphan', timestamp: 100 }],
        createdAt: 100,
        charCount: 6,
      };

      // Calling persistBatch on unopened stream must reject with 'stream_not_open'
      await expect(repo.persistBatch(orphanBatch)).rejects.toThrow('Stream not open');

      // Calling finalizeStream on unopened stream must reject with 'stream_not_open'
      await expect(repo.finalizeStream('orphan:stream', 'completed')).rejects.toThrow('Stream not open');

      // Verify no fake stream records were synthesized in IndexedDB
      const streamRecord = await repo.getStream('orphan:stream');
      expect(streamRecord).toBeNull();
    });

    it('rejects duplicate open with conflicting stream identity', async () => {
      await repo.openStream({
        producerSessionId: 'prod_ident',
        streamId: 'str_ident',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
      });

      // Conflicting URL
      await expect(
        repo.openStream({
          producerSessionId: 'prod_ident',
          streamId: 'str_ident',
          transport: 'fetch',
          url: 'https://chat.deepseek.com/api/v0/other_endpoint',
        })
      ).rejects.toThrow('Stream identity conflict');

      // Conflicting transport
      await expect(
        repo.openStream({
          producerSessionId: 'prod_ident',
          streamId: 'str_ident',
          transport: 'xhr',
          url: 'https://chat.deepseek.com/api/v0/chat/completion',
        })
      ).rejects.toThrow('Stream identity conflict');
    });

    it('rejects batch ID conflict with different payload and marks stream degraded without overwriting', async () => {
      await repo.openStream({
        producerSessionId: 'prod_conf',
        streamId: 'str_conf',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
      });

      const originalBatch: RawStreamBatch = {
        id: 'prod_conf:str_conf:1',
        streamKey: 'prod_conf:str_conf',
        batchSeq: 1,
        chunks: [{ streamSequence: 1, chunkText: 'ORIGINAL_DATA', timestamp: 100 }],
        createdAt: 100,
        charCount: 13,
      };

      await repo.persistBatch(originalBatch);

      // Different payload under the exact same batch ID
      const conflictingBatch: RawStreamBatch = {
        id: 'prod_conf:str_conf:1',
        streamKey: 'prod_conf:str_conf',
        batchSeq: 1,
        chunks: [{ streamSequence: 1, chunkText: 'CONFLICTING_DATA', timestamp: 200 }],
        createdAt: 200,
        charCount: 16,
      };

      await expect(repo.persistBatch(conflictingBatch)).rejects.toThrow('Batch ID conflict');

      // Verify original batch data was NOT overwritten
      const batches = await repo.listBatchesForStream('prod_conf:str_conf');
      expect(batches).toHaveLength(1);
      expect(batches[0]?.chunks[0]?.chunkText).toBe('ORIGINAL_DATA');

      // Verify stream was marked degraded and durabilityGap set
      const stream = await repo.getStream('prod_conf:str_conf');
      expect(stream?.state).toBe('degraded');
      expect(stream?.durabilityGap).toBe(true);
    });

    it('queries metadata and lists streams without loading all batches into memory', async () => {
      // Create 3 streams
      for (let i = 1; i <= 3; i++) {
        await repo.openStream({
          producerSessionId: `prod_${i}`,
          streamId: `str_${i}`,
          transport: 'fetch',
          url: 'https://chat.deepseek.com/api/v0/chat/completion',
          openedAt: 1000 + i * 100,
        });

        await repo.persistBatch({
          id: `prod_${i}:str_${i}:1`,
          streamKey: `prod_${i}:str_${i}`,
          batchSeq: 1,
          chunks: [{ streamSequence: 1, chunkText: `CHUNK_${i}`, timestamp: 1000 + i * 100 }],
          createdAt: 1000 + i * 100,
          charCount: 7,
        });
      }

      // listStreams should use cursor on openedAt index, returning in descending order
      const streams = await repo.listStreams(2);
      expect(streams).toHaveLength(2);
      expect(streams[0]?.streamId).toBe('str_3');
      expect(streams[1]?.streamId).toBe('str_2');

      const metadata = await repo.getJournalMetadata();
      expect(metadata.streamCount).toBe(3);
      expect(metadata.activeStreamCount).toBe(3);
      expect(metadata.totalBatchesCount).toBe(3);
      expect(metadata.totalCharsCount).toBe(21);
    });
  });

  describe('Buffer Memory Ceiling & Dropped Chunks', () => {
    it('stops accepting chunks and records droppedChars and durabilityGap when memory ceiling is reached', async () => {
      const buffer = new RawJournalBuffer({
        maxBatchChars: 20,
        maxPendingChars: 30, // 30 char ceiling
        messageSender: () => Promise.resolve({ success: false }), // Simulates offline / un-acked
      });

      await buffer.handleOpen({
        producerSessionId: 'p_ceil',
        streamId: 's_ceil',
        sequence: 1,
        streamSequence: 0,
        timestamp: 100,
        transport: 'fetch',
        type: 'open',
      });

      // Chunk 1: 25 chars -> flushed into pending queue (pendingChars = 25)
      buffer.handleChunk({
        producerSessionId: 'p_ceil',
        streamId: 's_ceil',
        sequence: 2,
        streamSequence: 1,
        timestamp: 110,
        transport: 'fetch',
        type: 'chunk',
        chunkText: '1234567890123456789012345',
      });

      // Chunk 2: 10 chars -> causes pendingChars = 35 > 30 ceiling
      buffer.handleChunk({
        producerSessionId: 'p_ceil',
        streamId: 's_ceil',
        sequence: 3,
        streamSequence: 2,
        timestamp: 120,
        transport: 'fetch',
        type: 'chunk',
        chunkText: '1234567890',
      });

      // Chunk 3: 15 chars -> MUST BE DROPPED because ceiling is exceeded
      buffer.handleChunk({
        producerSessionId: 'p_ceil',
        streamId: 's_ceil',
        sequence: 4,
        streamSequence: 3,
        timestamp: 130,
        transport: 'fetch',
        type: 'chunk',
        chunkText: 'SHOULD_BE_DROP!',
      });

      const state = buffer.getStreamState('p_ceil:s_ceil');
      expect(state?.state).toBe('degraded');
      expect(state?.durabilityGap).toBe(true);
      expect(state?.droppedChars).toBe(25);

      buffer.destroy();
    });

    it('rejects chunks for un-opened streams and does not create ghost buffer entries', () => {
      const buffer = new RawJournalBuffer();

      // Chunk without preceding handleOpen
      buffer.handleChunk({
        producerSessionId: 'p_ghost',
        streamId: 's_ghost',
        sequence: 2,
        streamSequence: 1,
        timestamp: 100,
        transport: 'fetch',
        type: 'chunk',
        chunkText: 'ghost chunk',
      });

      expect(buffer.getStreamState('p_ghost:s_ghost')).toBeNull();
      buffer.destroy();
    });
  });

  describe('Replay Completion & Integrity Gate', () => {
    it('does NOT mark replay complete on quasi_status alone', () => {
      const batches: RawStreamBatch[] = [
        {
          id: 's_quasi:1',
          streamKey: 'p:s_quasi',
          batchSeq: 1,
          chunks: [
            {
              streamSequence: 1,
              // Only quasi_status is sent, NOT response/status: FINISHED, NOT event: finish
              chunkText: 'data: {"o":"SET","p":"response/quasi_status","v":"FINISHED"}\n\n',
              timestamp: 100,
            },
          ],
          createdAt: 100,
          charCount: 65,
        },
      ];

      const result = replayRawBatches(batches);
      expect(result.diagnostics.quasiStatus).toBe('FINISHED');
      // CRITICAL GATE: quasi_status is NOT authoritative completion
      expect(result.isComplete).toBe(false);
    });

    it('respects transportContext aborted and marks integrity degraded', () => {
      const batches: RawStreamBatch[] = [
        {
          id: 's_aborted:1',
          streamKey: 'p:s_aborted',
          batchSeq: 1,
          chunks: [
            {
              streamSequence: 1,
              chunkText: 'data: {"o":"SET","p":"response/fragments/0/content","v":"Partial response"}\n\n',
              timestamp: 100,
            },
          ],
          createdAt: 100,
          charCount: 80,
        },
      ];

      const result = replayRawBatches(batches, {
        transportContext: {
          transportState: 'aborted',
          terminalReason: 'User clicked stop generation',
        },
      });

      expect(result.isComplete).toBe(false);
      const interruptEvt = result.semanticEvents.find((e) => e.type === 'stream_interrupted');
      expect(interruptEvt).toBeDefined();
      expect(interruptEvt?.terminalReason).toBe('transport_abort');
      expect(result.integrity).toBe('degraded');
    });

    it('flags integrity as corrupt when batches contain conflicting stream keys', () => {
      const batches: RawStreamBatch[] = [
        {
          id: 'b1:1',
          streamKey: 'stream_A',
          batchSeq: 1,
          chunks: [{ streamSequence: 1, chunkText: 'data: {}\n\n', timestamp: 100 }],
          createdAt: 100,
          charCount: 11,
        },
        {
          id: 'b2:2',
          streamKey: 'stream_B', // Conflicting stream key!
          batchSeq: 2,
          chunks: [{ streamSequence: 2, chunkText: 'data: {}\n\n', timestamp: 200 }],
          createdAt: 200,
          charCount: 11,
        },
      ];

      const result = replayRawBatches(batches);
      expect(result.integrity).toBe('corrupt');
    });
  });
});
