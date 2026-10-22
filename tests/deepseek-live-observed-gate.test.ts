import { describe, it, expect } from 'vitest';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';

describe('DeepSeek Live Runtime Observed Acceptance Gate', () => {
  it('starts at not_observed initially', () => {
    const decoder = new DeepSeekProtocolDecoder('gate_stream_0');
    expect(decoder.getDiagnostics().compatibilityState).toBe('not_observed');
    expect(decoder.getDiagnostics().parsedFramesCount).toBe(0);
  });

  it('remains not_observed on empty or whitespace frames', () => {
    const decoder = new DeepSeekProtocolDecoder('gate_stream_1');

    decoder.feed({ data: '' });
    decoder.feed({ data: '   ' });

    expect(decoder.getDiagnostics().compatibilityState).toBe('not_observed');
  });

  it('transitions to degraded on malformed JSON frame threatening protocol integrity', () => {
    const decoder = new DeepSeekProtocolDecoder('gate_stream_2');

    decoder.feed({ data: '{ not json ' });

    expect(decoder.getDiagnostics().compatibilityState).toBe('degraded');
    expect(decoder.getDiagnostics().protocolWarningsCount).toBe(1);
  });

  it('remains not_observed if frame parsed but no recognized content or terminal exists', () => {
    const decoder = new DeepSeekProtocolDecoder('gate_stream_3');

    // A patch modifying an irrelevant unknown object
    decoder.feed({
      data: JSON.stringify({
        p: 'unrelated_field',
        o: 'SET',
        v: 12345,
      }),
    });

    // Valid frame parsed, valid patch op, but no answer/thinking projection and not terminal
    expect(decoder.getDiagnostics().compatibilityState).toBe('not_observed');
  });

  it('promotes to live_observed when valid frame has recognized content projection', () => {
    const decoder = new DeepSeekProtocolDecoder('gate_stream_4');

    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'RESPONSE', content: 'First live token' }],
      }),
    });

    expect(decoder.getDiagnostics().compatibilityState).toBe('live_observed');
    expect(decoder.getProjectedContent().answer).toBe('First live token');
  });

  it('promotes to live_observed when stream finishes cleanly via status patch', () => {
    const decoder = new DeepSeekProtocolDecoder('gate_stream_5');

    decoder.feed({
      data: JSON.stringify({
        p: 'status',
        o: 'SET',
        v: 'FINISHED',
      }),
    });

    expect(decoder.getDiagnostics().compatibilityState).toBe('live_observed');
  });

  it('promotes to live_observed via thinking projection', () => {
    const decoder = new DeepSeekProtocolDecoder('gate_stream_6');

    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'THINK', content: 'Reasoning process starting...' }],
      }),
    });

    expect(decoder.getDiagnostics().compatibilityState).toBe('live_observed');
    expect(decoder.getProjectedContent().thinking).toBe('Reasoning process starting...');
  });

  it('transitions to degraded on sequence gap and locks against downgrade or promotion', () => {
    const decoder = new DeepSeekProtocolDecoder('gate_stream_7');

    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'RESPONSE', content: 'Normal start' }],
      }),
    });

    expect(decoder.getDiagnostics().compatibilityState).toBe('live_observed');

    // Sequence gap detected
    decoder.recordSequenceGap();
    expect(decoder.getDiagnostics().compatibilityState).toBe('degraded');

    // Subsequent valid frames must remain degraded
    decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'APPEND',
        v: ' more tokens',
      }),
    });

    expect(decoder.getDiagnostics().compatibilityState).toBe('degraded');
  });
});
