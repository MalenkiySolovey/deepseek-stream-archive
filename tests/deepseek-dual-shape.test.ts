import { describe, it, expect } from 'vitest';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';

describe('DeepSeek Dual Shape Support (Variant A vs Variant B)', () => {
  it('correctly processes and tags Variant A (fragments[]) stream', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_variant_a');

    const events = decoder.feed({
      data: JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [
          {
            p: 'fragments',
            o: 'SET',
            v: [
              { type: 'THINK', content: 'Variant A thinking token.' },
              { type: 'RESPONSE', content: 'Variant A answer token.' },
            ],
          },
        ],
      }),
    });

    const answerEvt = events.find((e) => e.type === 'answer_delta');
    expect(answerEvt).toBeDefined();
    expect(answerEvt?.delta).toBe('Variant A answer token.');
    expect(answerEvt?.projectionSource).toBe('fragments');

    const thinkingEvt = events.find((e) => e.type === 'thinking_delta');
    expect(thinkingEvt).toBeDefined();
    expect(thinkingEvt?.delta).toBe('Variant A thinking token.');
    expect(thinkingEvt?.projectionSource).toBe('fragments');

    expect(decoder.getDiagnostics().projectionSource).toBe('fragments');
  });

  it('correctly processes and tags Variant B (top-level response content) stream', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_variant_b');

    // 1. Initial content token
    const events1 = decoder.feed({
      data: JSON.stringify({
        p: 'response/content',
        o: 'SET',
        v: 'Variant B first sentence.',
      }),
    });

    const answerEvt1 = events1.find((e) => e.type === 'answer_delta');
    expect(answerEvt1).toBeDefined();
    expect(answerEvt1?.delta).toBe('Variant B first sentence.');
    expect(answerEvt1?.projectionSource).toBe('top_level');

    // 2. Append thinking_content
    const events2 = decoder.feed({
      data: JSON.stringify({
        p: 'response/thinking_content',
        o: 'SET',
        v: 'Reasoning from Variant B.',
      }),
    });

    const thinkingEvt = events2.find((e) => e.type === 'thinking_delta');
    expect(thinkingEvt).toBeDefined();
    expect(thinkingEvt?.delta).toBe('Reasoning from Variant B.');
    expect(thinkingEvt?.projectionSource).toBe('top_level');

    // 3. Append to content
    const events3 = decoder.feed({
      data: JSON.stringify({
        p: 'response/content',
        o: 'APPEND',
        v: ' Second sentence.',
      }),
    });

    const answerEvt2 = events3.find((e) => e.type === 'answer_delta');
    expect(answerEvt2).toBeDefined();
    expect(answerEvt2?.delta).toBe(' Second sentence.');
    expect(answerEvt2?.fullText).toBe('Variant B first sentence. Second sentence.');
    expect(answerEvt2?.projectionSource).toBe('top_level');

    expect(decoder.getDiagnostics().projectionSource).toBe('top_level');
  });

  it('prioritizes fragments[] when both shapes are present in a patch', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_variant_hybrid');

    const events = decoder.feed({
      data: JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [
          {
            p: 'content',
            o: 'SET',
            v: 'Top-level content text',
          },
          {
            p: 'fragments',
            o: 'SET',
            v: [{ type: 'RESPONSE', content: 'Fragments priority text' }],
          },
        ],
      }),
    });

    const answerEvt = events.find((e) => e.type === 'answer_delta');
    expect(answerEvt).toBeDefined();
    expect(answerEvt?.fullText).toBe('Fragments priority text');
    expect(answerEvt?.projectionSource).toBe('fragments');
  });
});
