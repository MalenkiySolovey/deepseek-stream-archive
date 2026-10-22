import { describe, it, expect } from 'vitest';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';
import type { SseEvent } from '../src/transport/sse/types';

describe('Stream Sequence & Lifecycle Integrity', () => {
  it('detects and records sequence gaps, marking compatibility as degraded', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_seq_1');
    expect(decoder.getDiagnostics().compatibilityState).toBe('not_observed');

    // Initial normal frame
    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'RESPONSE', content: 'Normal start' }],
      }),
    });

    const diagBefore = decoder.getDiagnostics();
    expect(diagBefore.sequenceGapsCount).toBe(0);
    expect(diagBefore.compatibilityState).toBe('live_observed');

    // Simulate sequence gap anomaly
    decoder.recordSequenceGap();

    const diagAfter = decoder.getDiagnostics();
    expect(diagAfter.sequenceGapsCount).toBe(1);
    expect(diagAfter.compatibilityState).toBe('degraded');
    expect(diagAfter.recentWarnings.some((w) => w.includes('stream_sequence_gap'))).toBe(true);
  });

  it('detects and records duplicate open events', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_seq_2');

    decoder.recordDuplicateOpen();

    const diag = decoder.getDiagnostics();
    expect(diag.duplicateOpensCount).toBe(1);
    expect(diag.recentWarnings.some((w) => w.includes('duplicate_open'))).toBe(true);
  });

  it('rejects events fed after stream terminal state', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_seq_3');

    // Feed normal chunk
    decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'SET',
        v: 'Hello',
      }),
    });

    // Complete stream via [DONE]
    const doneEvents = decoder.feed({ data: '[DONE]' });
    expect(doneEvents.some((e) => e.type === 'stream_finished')).toBe(true);

    // Feed event after terminal finish
    const postTerminalEvents = decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'APPEND',
        v: ' post terminal content',
      }),
    });

    // Must be completely rejected
    expect(postTerminalEvents).toHaveLength(0);

    const diag = decoder.getDiagnostics();
    expect(diag.eventsAfterTerminalCount).toBe(1);
    expect(diag.recentWarnings.some((w) => w.includes('event_after_terminal'))).toBe(true);
    expect(diag.currentAnswerLength).toBe(5); // Still 'Hello', not modified
  });

  it('handles finish() called after stream has already completed via [DONE] idempotently', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_seq_4');

    decoder.feed({ data: '[DONE]' });

    // Calling finish() after [DONE] should return empty array and not emit duplicate terminal
    const extraFinishEvents = decoder.finish({ kind: 'transport_complete' });
    expect(extraFinishEvents).toHaveLength(0);
  });
});
