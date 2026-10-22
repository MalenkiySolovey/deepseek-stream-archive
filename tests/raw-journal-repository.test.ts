import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RawStreamRepository } from '../src/storage/raw-journal/repository';
import { closeExtensionDatabase, openExtensionDatabase } from '../src/storage/db';
import { STORE_RAW_STREAMS, STORE_RAW_STREAM_BATCHES } from '../src/storage/schema';
import type { RawStreamBatch } from '../src/storage/raw-journal/types';

describe('RawStreamRepository Durable Persistence', () => {
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

  it('opens new stream session idempotently and sanitizes metadata', async () => {
    const stream = await repo.openStream({
      producerSessionId: 'tab_prod_1',
      streamId: 'stream_100',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      provisionalSessionId: 'route_session_abc',
    });

    expect(stream.id).toBe('tab_prod_1:stream_100');
    expect(stream.state).toBe('active');
    expect(stream.totalChunks).toBe(0);
    expect(stream.totalChars).toBe(0);
    expect(stream.totalBatches).toBe(0);
    expect(stream.provisionalSessionId).toBe('route_session_abc');

    // Second call with same key is idempotent
    const stream2 = await repo.openStream({
      producerSessionId: 'tab_prod_1',
      streamId: 'stream_100',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
    });

    expect(stream2.id).toBe(stream.id);
    expect(stream2.provisionalSessionId).toBe('route_session_abc');
  });

  it('persists batches atomically, increments stream totals, and guarantees ACK on tx.oncomplete', async () => {
    await repo.openStream({
      producerSessionId: 'prod_1',
      streamId: 'str_1',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
    });

    const batch1: RawStreamBatch = {
      id: 'prod_1:str_1:1',
      streamKey: 'prod_1:str_1',
      batchSeq: 1,
      chunks: [
        { streamSequence: 1, chunkText: 'data: {"p":"v1"}\n\n', timestamp: 1000 },
        { streamSequence: 2, chunkText: 'data: {"p":"v2"}\n\n', timestamp: 1010 },
      ],
      createdAt: 1010,
      charCount: 36,
    };

    const ack1 = await repo.persistBatch(batch1);
    expect(ack1.success).toBe(true);
    expect(ack1.batchSeq).toBe(1);
    expect(ack1.persistedAt).toBeGreaterThan(0);

    const streamRecord = await repo.getStream('prod_1:str_1');
    expect(streamRecord).not.toBeNull();
    expect(streamRecord?.totalBatches).toBe(1);
    expect(streamRecord?.totalChunks).toBe(2);
    expect(streamRecord?.totalChars).toBe(36);

    // Persist second batch
    const batch2: RawStreamBatch = {
      id: 'prod_1:str_1:2',
      streamKey: 'prod_1:str_1',
      batchSeq: 2,
      chunks: [
        { streamSequence: 3, chunkText: 'data: {"status":"FINISHED"}\n\n', timestamp: 1050 },
      ],
      createdAt: 1050,
      charCount: 29,
    };

    const ack2 = await repo.persistBatch(batch2);
    expect(ack2.success).toBe(true);
    expect(ack2.batchSeq).toBe(2);

    const updatedStream = await repo.getStream('prod_1:str_1');
    expect(updatedStream?.totalBatches).toBe(2);
    expect(updatedStream?.totalChunks).toBe(3);
    expect(updatedStream?.totalChars).toBe(65);
  });

  it('handles batch re-delivery idempotently without inflating stream counters', async () => {
    await repo.openStream({
      producerSessionId: 'prod_idem',
      streamId: 'str_idem',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
    });

    const batch: RawStreamBatch = {
      id: 'prod_idem:str_idem:1',
      streamKey: 'prod_idem:str_idem',
      batchSeq: 1,
      chunks: [
        { streamSequence: 1, chunkText: 'data: {"chunk":1}\n\n', timestamp: 2000 },
      ],
      createdAt: 2000,
      charCount: 20,
    };

    // First delivery
    await repo.persistBatch(batch);
    // Duplicate retry delivery of identical batch
    const ack2 = await repo.persistBatch(batch);

    expect(ack2.success).toBe(true);

    const stream = await repo.getStream('prod_idem:str_idem');
    expect(stream?.totalBatches).toBe(1);
    expect(stream?.totalChunks).toBe(1);
    expect(stream?.totalChars).toBe(20);

    const batches = await repo.listBatchesForStream('prod_idem:str_idem');
    expect(batches).toHaveLength(1);
  });

  it('rolls back batch atomically when transaction aborts', async () => {
    const db = await openExtensionDatabase(fakeFactory);

    await repo.openStream({
      producerSessionId: 'prod_abort',
      streamId: 'str_abort',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
    });

    const originalTx = db.transaction.bind(db);
    db.transaction = function (storeNames: any, mode: any) {
      const tx = originalTx(storeNames, mode);
      if (mode === 'readwrite' && Array.isArray(storeNames) && storeNames.includes(STORE_RAW_STREAM_BATCHES)) {
        queueMicrotask(() => {
          try {
            tx.abort();
          } catch {
            // ignore
          }
        });
      }
      return tx;
    } as any;

    const batch: RawStreamBatch = {
      id: 'prod_abort:str_abort:1',
      streamKey: 'prod_abort:str_abort',
      batchSeq: 1,
      chunks: [{ streamSequence: 1, chunkText: 'test', timestamp: 100 }],
      createdAt: 100,
      charCount: 4,
    };

    await expect(repo.persistBatch(batch)).rejects.toThrow();

    db.transaction = originalTx;

    // Verify batch was not committed
    const batches = await repo.listBatchesForStream('prod_abort:str_abort');
    expect(batches).toHaveLength(0);

    // Verify stream stats were not mutated
    const stream = await repo.getStream('prod_abort:str_abort');
    expect(stream?.totalBatches).toBe(0);
    expect(stream?.totalChars).toBe(0);
  });

  it('finalizes streams and queries journal metadata correctly', async () => {
    await repo.openStream({
      producerSessionId: 'prod_meta',
      streamId: 'str_1',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
    });

    const batchAck = await repo.persistBatch({
      id: 'prod_meta:str_1:1',
      streamKey: 'prod_meta:str_1',
      batchSeq: 1,
      chunks: [{ streamSequence: 1, chunkText: 'ABCDEF', timestamp: 3000 }],
      createdAt: 3000,
      charCount: 6,
    });

    await repo.finalizeStream('prod_meta:str_1', 'completed', 'finished');

    const stream = await repo.getStream('prod_meta:str_1');
    expect(stream?.state).toBe('completed');
    expect(stream?.terminalReason).toBe('finished');
    expect(stream?.finalizedAt).toBeGreaterThan(0);

    const metadata = await repo.getJournalMetadata();
    expect(metadata.streamCount).toBe(1);
    expect(metadata.activeStreamCount).toBe(0);
    expect(metadata.totalBatchesCount).toBe(1);
    expect(metadata.totalCharsCount).toBe(6);
    expect(metadata.lastPersistedAt).toBe(batchAck.persistedAt);
  });

  it('preserves and retrieves data across background Service Worker cold restarts', async () => {
    // Session 1: Write data
    await repo.openStream({
      producerSessionId: 'p_cold',
      streamId: 's_cold',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
    });
    await repo.persistBatch({
      id: 'p_cold:s_cold:1',
      streamKey: 'p_cold:s_cold',
      batchSeq: 1,
      chunks: [{ streamSequence: 1, chunkText: 'cold-start chunk', timestamp: 5000 }],
      createdAt: 5000,
      charCount: 16,
    });

    // Simulate SW shutdown: close database connection
    closeExtensionDatabase(fakeFactory);

    // Session 2: Fresh repository instance representing restarted worker
    const restartedRepo = new RawStreamRepository(fakeFactory);
    const fetchedStream = await restartedRepo.getStream('p_cold:s_cold');
    const fetchedBatches = await restartedRepo.listBatchesForStream('p_cold:s_cold');

    expect(fetchedStream).not.toBeNull();
    expect(fetchedStream?.totalChars).toBe(16);
    expect(fetchedBatches).toHaveLength(1);
    expect(fetchedBatches[0]?.chunks[0]?.chunkText).toBe('cold-start chunk');
  });
});
