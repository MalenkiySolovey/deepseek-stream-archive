import { describe, it, expect } from 'vitest';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';
import type { SseEvent } from '../src/transport/sse/types';

describe('DeepSeek Censorship & Filter Detection (Detect-Before-Apply)', () => {
  it('freezes lastGood state BEFORE patch clears fragments on TEMPLATE_RESPONSE', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_filter_1', 'session_abc');

    // 1. Initial valid response stream
    const initEvent: SseEvent = {
      data: JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [
          {
            p: 'message_id',
            v: 'msg_censored_01',
          },
          {
            p: 'fragments',
            o: 'SET',
            v: [
              { type: 'THINK', content: 'Detailed confidential reasoning.' },
              { type: 'RESPONSE', content: 'Uncensored valuable reply before censorship.' },
            ],
          },
        ],
      }),
    };
    decoder.feed(initEvent);

    // 2. Censorship patch arrives: wipes fragments and replaces with TEMPLATE_RESPONSE
    const censorEvent: SseEvent = {
      data: JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [
          {
            p: 'fragments',
            o: 'SET',
            v: [
              {
                type: 'TEMPLATE_RESPONSE',
                content: "I'm sorry, but I cannot fulfill this request based on safety guidelines.",
              },
            ],
          },
          {
            p: 'status',
            o: 'SET',
            v: 'CONTENT_FILTER',
          },
        ],
      }),
    };

    const events = decoder.feed(censorEvent);

    // Verify filter_triggered event was emitted
    const filterEvt = events.find((e) => e.type === 'filter_triggered');
    expect(filterEvt).toBeDefined();
    expect(filterEvt?.reason).toBe('CONTENT_FILTER');

    // Verify detect-before-apply: lastGood captures the complete un-censored content!
    const lastGood = filterEvt?.lastGood;
    expect(lastGood).toBeDefined();
    expect(lastGood?.answer).toBe('Uncensored valuable reply before censorship.');
    expect(lastGood?.thinking).toBe('Detailed confidential reasoning.');
    expect(lastGood?.messageId).toBe('msg_censored_01');
    expect(lastGood?.sessionId).toBe('session_abc');
    expect(lastGood?.fragments).toHaveLength(2);

    // Verify decoder's stored lastGood state
    expect(decoder.getLastGoodState()?.answer).toBe('Uncensored valuable reply before censorship.');
  });

  it('detects CONTENT_FILTER in direct status patch', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_filter_2');

    // Feed normal chunk
    decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'SET',
        v: 'Early content',
      }),
    });

    // Feed direct CONTENT_FILTER status patch
    const events = decoder.feed({
      data: JSON.stringify({
        p: 'status',
        o: 'SET',
        v: 'CONTENT_FILTER',
      }),
    });

    const filterEvt = events.find((e) => e.type === 'filter_triggered');
    expect(filterEvt).toBeDefined();
    expect(filterEvt?.reason).toBe('CONTENT_FILTER');
    expect(filterEvt?.lastGood?.answer).toBe('Early content');
  });

  it('detects TEMPLATE_RESPONSE in direct fragments append', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_filter_3');

    decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'SET',
        v: 'Legitimate generated content',
      }),
    });

    const events = decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'APPEND',
        v: [{ type: 'TEMPLATE_RESPONSE', content: 'Blocked content' }],
      }),
    });

    const filterEvt = events.find((e) => e.type === 'filter_triggered');
    expect(filterEvt).toBeDefined();
    expect(filterEvt?.reason).toBe('TEMPLATE_RESPONSE');
    expect(filterEvt?.lastGood?.answer).toBe('Legitimate generated content');
  });

  it('does not trigger false positive filter events on normal stream patches', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_clean');

    const events1 = decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'SET',
        v: 'Normal answer token',
      }),
    });
    expect(events1.some((e) => e.type === 'filter_triggered')).toBe(false);

    const events2 = decoder.feed({
      data: JSON.stringify({
        p: 'status',
        o: 'SET',
        v: 'FINISHED',
      }),
    });
    expect(events2.some((e) => e.type === 'filter_triggered')).toBe(false);
    expect(decoder.getLastGoodState()).toBeUndefined();
  });

  it('does not trigger false positive when assistant generated content contains literal CONTENT_FILTER string', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_literal_filter');

    const events = decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'SET',
        v: 'The server constant is CONTENT_FILTER in the codebase.',
      }),
    });

    expect(events.some((e) => e.type === 'filter_triggered')).toBe(false);
    expect(decoder.getLastGoodState()).toBeUndefined();
    expect(decoder.getProjectedContent().answer).toBe('The server constant is CONTENT_FILTER in the codebase.');
  });
});
