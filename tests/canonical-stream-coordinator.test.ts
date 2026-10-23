import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CanonicalStreamCoordinator,
  type CanonicalCheckpointDto,
  type CanonicalCheckpointAck,
} from '../src/core/recorder/canonical-stream-coordinator';

describe('CanonicalStreamCoordinator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('orchestrates checkpoints with monotonic sequence numbering and ACK verification', async () => {
    const receivedCheckpoints: CanonicalCheckpointDto[] = [];

    const coordinator = new CanonicalStreamCoordinator({
      producerSessionId: 'prod-coord-1',
      streamId: 'stream-coord-1',
      provisionalSessionId: 'sess-coord-1',
      conversationTitle: 'Coordinator Test Chat',
      onCheckpoint: async (cp) => {
        receivedCheckpoints.push(cp);
        return {
          success: true,
          streamKey: cp.streamKey,
          checkpointSeq: cp.checkpointSeq,
          persistedAt: Date.now(),
        };
      },
      debounceMs: 200,
    });

    expect(coordinator.getRawStreamKey()).toBe('prod-coord-1:stream-coord-1');
    expect(coordinator.getProvisionalSessionId()).toBe('sess-coord-1');

    // 1. Delta chunk (debounced)
    coordinator.feedSemanticEvent({
      streamId: 'stream-coord-1',
      sequence: 1,
      timestamp: 100,
      type: 'answer_delta',
      delta: 'Hello world from streaming coordinator.',
    });

    expect(receivedCheckpoints).toHaveLength(0);

    // Fast-forward debounce timer
    await vi.advanceTimersByTimeAsync(250);

    expect(receivedCheckpoints).toHaveLength(1);
    expect(receivedCheckpoints[0]!.checkpointSeq).toBe(0);
    expect(receivedCheckpoints[0]!.isFinal).toBe(false);
    expect(receivedCheckpoints[0]!.conversation?.title).toBe('Coordinator Test Chat');
    expect(receivedCheckpoints[0]!.revisions[0]!.text).toBe('Hello world from streaming coordinator.');
    expect(coordinator.getLastAckedSeq()).toBe(0);

    // 2. Immediate event: message_id_identified flushes immediately without waiting for debounce
    coordinator.feedSemanticEvent({
      streamId: 'stream-coord-1',
      sequence: 2,
      timestamp: 200,
      type: 'message_id_identified',
      messageId: 'remote-msg-authoritative-99',
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(receivedCheckpoints).toHaveLength(2);
    expect(receivedCheckpoints[1]!.checkpointSeq).toBe(1);
    expect(receivedCheckpoints[1]!.message.remoteId).toBe('remote-msg-authoritative-99');
    expect(coordinator.getLastAckedSeq()).toBe(1);

    // 3. Terminal event triggers final checkpoint
    coordinator.feedSemanticEvent({
      streamId: 'stream-coord-1',
      sequence: 3,
      timestamp: 300,
      type: 'stream_finished',
      terminalReason: 'completed',
    });

    await vi.runAllTimersAsync();

    expect(receivedCheckpoints).toHaveLength(3);
    expect(receivedCheckpoints[2]!.checkpointSeq).toBe(2);
    expect(receivedCheckpoints[2]!.isFinal).toBe(true);
    expect(receivedCheckpoints[2]!.message.status).toBe('finished');
    expect(coordinator.getLastAckedSeq()).toBe(2);

    coordinator.dispose();
  });

  it('rejects mismatched ACK and reports warning without advancing lastAckedSeq', async () => {
    let callCount = 0;
    const coordinator = new CanonicalStreamCoordinator({
      producerSessionId: 'prod-mismatch',
      streamId: 'stream-mismatch',
      onCheckpoint: async (cp) => {
        callCount++;
        // Return mismatched streamKey
        return {
          success: true,
          streamKey: 'WRONG_PRODUCER:WRONG_STREAM',
          checkpointSeq: cp.checkpointSeq,
        };
      },
      debounceMs: 50,
    });

    coordinator.feedSemanticEvent({
      streamId: 'stream-mismatch',
      sequence: 1,
      timestamp: 100,
      type: 'answer_delta',
      delta: 'Test content',
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(callCount).toBe(1);
    // lastAckedSeq remains -1 due to key mismatch
    expect(coordinator.getLastAckedSeq()).toBe(-1);

    coordinator.dispose();
  });

  it('handles immediate filter_triggered events with lastGood state preservation', async () => {
    const receivedCheckpoints: CanonicalCheckpointDto[] = [];

    const coordinator = new CanonicalStreamCoordinator({
      producerSessionId: 'p-filter',
      streamId: 's-filter',
      onCheckpoint: async (cp) => {
        receivedCheckpoints.push(cp);
        return {
          success: true,
          streamKey: cp.streamKey,
          checkpointSeq: cp.checkpointSeq,
        };
      },
    });

    coordinator.feedSemanticEvent({
      streamId: 's-filter',
      sequence: 1,
      timestamp: 100,
      type: 'answer_delta',
      delta: 'Uncensored sensitive data that triggered policy',
    });

    coordinator.feedSemanticEvent({
      streamId: 's-filter',
      sequence: 2,
      timestamp: 150,
      type: 'filter_triggered',
      lastGood: {
        answer: 'Uncensored sensitive data that triggered policy',
        thinking: '',
        capturedAt: 150,
        reason: 'CONTENT_FILTER',
        projectionSource: 'top_level',
      },
    });

    expect(receivedCheckpoints).toHaveLength(1);
    const cp = receivedCheckpoints[0]!;
    expect(cp.revisions.some((r) => r.isLastGood && r.text.includes('Uncensored sensitive data'))).toBe(true);
    expect(cp.recoveryEvents).toHaveLength(1);
    expect(cp.recoveryEvents[0]!.kind).toBe('content_filter');

    coordinator.dispose();
  });
});
