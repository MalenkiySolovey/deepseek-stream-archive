import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RawJournalBuffer } from '../src/storage/raw-journal/buffer';
import type {
  ExtensionInternalMessage,
  PersistRawBatchRequest,
  PersistRawStreamOpenRequest,
  FinalizeRawStreamRequest,
} from '../src/bridge/messages';
import type { TransportEvent } from '../src/transport/types';

describe('RawJournalBuffer (Content Script Raw Batching & ACK Retention)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sanitizes URL and dispatches open message when stream begins', async () => {
    const sentMessages: ExtensionInternalMessage[] = [];
    const buffer = new RawJournalBuffer({
      messageSender: async (msg) => {
        sentMessages.push(msg);
        const streamKey = (msg as any).streamKey || (msg as any).batch?.streamKey || `${(msg as any).producerSessionId}:${(msg as any).streamId}`;
        return { success: true, streamKey };
      },
    });

    const openEvent: TransportEvent = {
      producerSessionId: 'prod_1',
      streamId: 'str_1',
      sequence: 1,
      streamSequence: 0,
      timestamp: 1000,
      transport: 'fetch',
      type: 'open',
      metadata: {
        method: 'POST',
        url: 'https://chat.deepseek.com/api/v0/chat/completion?token=secret123#anchor',
      },
    };

    await buffer.handleOpen(openEvent, 'route_sess_99');

    expect(sentMessages).toHaveLength(1);
    const openReq = sentMessages[0] as PersistRawStreamOpenRequest;
    expect(openReq.type).toBe('STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN');
    expect(openReq.producerSessionId).toBe('prod_1');
    expect(openReq.streamId).toBe('str_1');
    expect(openReq.url).toBe('https://chat.deepseek.com/api/v0/chat/completion');
    expect(openReq.provisionalSessionId).toBe('route_sess_99');

    buffer.destroy();
  });

  it('flushes batch immediately when size threshold is reached', async () => {
    const sentMessages: ExtensionInternalMessage[] = [];
    const buffer = new RawJournalBuffer({
      maxBatchChars: 50, // Small threshold for testing
      flushDelayMs: 500,
      messageSender: async (msg) => {
        sentMessages.push(msg);
        const streamKey = (msg as any).streamKey || (msg as any).batch?.streamKey || `${(msg as any).producerSessionId}:${(msg as any).streamId}`;
        return { success: true, streamKey, batchSeq: (msg as any).batch?.batchSeq, persistedAt: Date.now() };
      },
    });

    await buffer.handleOpen({
      producerSessionId: 'p1',
      streamId: 's1',
      sequence: 1,
      streamSequence: 0,
      timestamp: 100,
      transport: 'fetch',
      type: 'open',
    });

    // Chunk 1: 30 chars (under 50)
    buffer.handleChunk({
      producerSessionId: 'p1',
      streamId: 's1',
      sequence: 2,
      streamSequence: 1,
      timestamp: 110,
      transport: 'fetch',
      type: 'chunk',
      chunkText: '123456789012345678901234567890',
    });

    expect(sentMessages).toHaveLength(1); // Only open message sent so far

    // Chunk 2: 25 chars (total 55 >= 50) -> triggers immediate flush
    buffer.handleChunk({
      producerSessionId: 'p1',
      streamId: 's1',
      sequence: 3,
      streamSequence: 2,
      timestamp: 120,
      transport: 'fetch',
      type: 'chunk',
      chunkText: 'abcdefghijklmnopqrstuvwxy',
    });

    // Flush should happen synchronously without advancing timer
    expect(sentMessages).toHaveLength(2);
    const batchReq = sentMessages[1] as PersistRawBatchRequest;
    expect(batchReq.type).toBe('STREAMARCHIVE_PERSIST_RAW_BATCH');
    expect(batchReq.batch.batchSeq).toBe(1);
    expect(batchReq.batch.charCount).toBe(55);
    expect(batchReq.batch.chunks).toHaveLength(2);

    buffer.destroy();
  });

  it('flushes batch on timer threshold when chunks are below size threshold', async () => {
    const sentMessages: ExtensionInternalMessage[] = [];
    const buffer = new RawJournalBuffer({
      maxBatchChars: 1000,
      flushDelayMs: 300,
      messageSender: async (msg) => {
        sentMessages.push(msg);
        const streamKey = (msg as any).streamKey || (msg as any).batch?.streamKey || `${(msg as any).producerSessionId}:${(msg as any).streamId}`;
        return { success: true, streamKey, batchSeq: (msg as any).batch?.batchSeq ?? 1, persistedAt: Date.now() };
      },
    });

    await buffer.handleOpen({
      producerSessionId: 'p1',
      streamId: 's1',
      sequence: 1,
      streamSequence: 0,
      timestamp: 100,
      transport: 'fetch',
      type: 'open',
    });

    buffer.handleChunk({
      producerSessionId: 'p1',
      streamId: 's1',
      sequence: 2,
      streamSequence: 1,
      timestamp: 110,
      transport: 'fetch',
      type: 'chunk',
      chunkText: 'small chunk',
    });

    expect(sentMessages).toHaveLength(1);

    // Advance time by 200ms (below 300ms)
    vi.advanceTimersByTime(200);
    expect(sentMessages).toHaveLength(1);

    // Advance remaining 100ms -> timer triggers flush
    vi.advanceTimersByTime(100);
    expect(sentMessages).toHaveLength(2);
    const batchReq = sentMessages[1] as PersistRawBatchRequest;
    expect(batchReq.type).toBe('STREAMARCHIVE_PERSIST_RAW_BATCH');
    expect(batchReq.batch.batchSeq).toBe(1);
    expect(batchReq.batch.chunks[0]?.chunkText).toBe('small chunk');

    buffer.destroy();
  });

  it('flushes pending chunks immediately on terminal event and sends finalize', async () => {
    const sentMessages: ExtensionInternalMessage[] = [];
    const buffer = new RawJournalBuffer({
      maxBatchChars: 1000,
      flushDelayMs: 500,
      messageSender: async (msg) => {
        sentMessages.push(msg);
        const streamKey = (msg as any).streamKey || (msg as any).batch?.streamKey || `${(msg as any).producerSessionId}:${(msg as any).streamId}`;
        return { success: true, streamKey, batchSeq: (msg as any).batch?.batchSeq ?? 1, persistedAt: Date.now() };
      },
    });

    await buffer.handleOpen({
      producerSessionId: 'p_term',
      streamId: 's_term',
      sequence: 1,
      streamSequence: 0,
      timestamp: 100,
      transport: 'fetch',
      type: 'open',
    });

    buffer.handleChunk({
      producerSessionId: 'p_term',
      streamId: 's_term',
      sequence: 2,
      streamSequence: 1,
      timestamp: 110,
      transport: 'fetch',
      type: 'chunk',
      chunkText: 'final chunk before complete',
    });

    // Complete arrives without timer advancing
    await buffer.handleTerminal({
      producerSessionId: 'p_term',
      streamId: 's_term',
      sequence: 3,
      streamSequence: 2,
      timestamp: 120,
      transport: 'fetch',
      type: 'complete',
    });

    expect(sentMessages).toHaveLength(3);
    const batchReq = sentMessages[1] as PersistRawBatchRequest;
    const finalizeReq = sentMessages[2] as FinalizeRawStreamRequest;

    expect(batchReq.type).toBe('STREAMARCHIVE_PERSIST_RAW_BATCH');
    expect(batchReq.batch.chunks[0]?.chunkText).toBe('final chunk before complete');

    expect(finalizeReq.type).toBe('STREAMARCHIVE_FINALIZE_RAW_STREAM');
    expect(finalizeReq.finalState).toBe('completed');

    buffer.destroy();
  });

  it('retains un-ACKed batch and retries with backoff on failure', async () => {
    let callCount = 0;
    const buffer = new RawJournalBuffer({
      maxBatchChars: 50,
      retryDelaysMs: [100, 500],
      messageSender: async (msg) => {
        const streamKey = (msg as any).streamKey || (msg as any).batch?.streamKey || `${(msg as any).producerSessionId}:${(msg as any).streamId}`;
        if (msg.type === 'STREAMARCHIVE_PERSIST_RAW_BATCH') {
          callCount++;
          if (callCount === 1) {
            // First attempt fails
            return { success: false, streamKey, error: 'Database locked' };
          }
          // Second attempt succeeds
          return { success: true, streamKey, batchSeq: 1, persistedAt: Date.now() };
        }
        return { success: true, streamKey };
      },
    });

    await buffer.handleOpen({
      producerSessionId: 'p_retry',
      streamId: 's_retry',
      sequence: 1,
      streamSequence: 0,
      timestamp: 100,
      transport: 'fetch',
      type: 'open',
    });

    buffer.handleChunk({
      producerSessionId: 'p_retry',
      streamId: 's_retry',
      sequence: 2,
      streamSequence: 1,
      timestamp: 110,
      transport: 'fetch',
      type: 'chunk',
      chunkText: 'over threshold chunk 1234567890123456789012345678901234567890',
    });

    // Immediate attempt made
    expect(callCount).toBe(1);

    // Let the promise rejection microtask run
    await Promise.resolve();
    await Promise.resolve();

    // Check buffer state shows 1 pending batch
    const stateBefore = buffer.getStreamState('p_retry:s_retry');
    expect(stateBefore?.pendingBatchesCount).toBe(1);

    // Advance timer by first retry delay (100ms)
    await vi.advanceTimersByTimeAsync(100);

    // Retry succeeded on attempt 2
    expect(callCount).toBe(2);

    await Promise.resolve();
    await Promise.resolve();

    const stateAfter = buffer.getStreamState('p_retry:s_retry');
    expect(stateAfter?.pendingBatchesCount).toBe(0);

    buffer.destroy();
  });

  it('degrades stream gracefully when memory limit is exceeded', async () => {
    const buffer = new RawJournalBuffer({
      maxBatchChars: 10,
      maxPendingChars: 30, // Very low ceiling
      messageSender: async () => {
        // Never ACKs (simulating offline or broken DB)
        return { success: false };
      },
    });

    await buffer.handleOpen({
      producerSessionId: 'p_deg',
      streamId: 's_deg',
      sequence: 1,
      streamSequence: 0,
      timestamp: 100,
      transport: 'fetch',
      type: 'open',
    });

    // Send chunks accumulating pending chars
    buffer.handleChunk({
      producerSessionId: 'p_deg',
      streamId: 's_deg',
      sequence: 2,
      streamSequence: 1,
      timestamp: 110,
      transport: 'fetch',
      type: 'chunk',
      chunkText: '123456789012345', // 15 chars
    });

    buffer.handleChunk({
      producerSessionId: 'p_deg',
      streamId: 's_deg',
      sequence: 3,
      streamSequence: 2,
      timestamp: 120,
      transport: 'fetch',
      type: 'chunk',
      chunkText: '12345678901234567890', // 20 chars (total 35 > 30)
    });

    const state = buffer.getStreamState('p_deg:s_deg');
    expect(state?.state).toBe('degraded');

    buffer.destroy();
  });
});
