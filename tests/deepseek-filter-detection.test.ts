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

  // --- Milestone v0.1.0 Core Correctness Regressions ---

  it('preserves meaningful answer across intermediate destructive patch that clears content before CONTENT_FILTER status arrives', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_destructive_intermediate', 'sess_live_bug');

    // 1. Initial valid assistant response (e.g. 11038 chars in live session)
    const usefulReply = 'REAL PRE-FILTER RESPONSE: Here is a detailed 11038 character answer with crucial derivations.';
    decoder.feed({
      data: JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [
          { p: 'message_id', v: 'msg_filtered_live' },
          {
            p: 'fragments',
            o: 'SET',
            v: [
              { type: 'THINK', content: 'Detailed thinking process before filter.' },
              { type: 'RESPONSE', content: usefulReply },
            ],
          },
        ],
      }),
    });

    expect(decoder.getProjectedContent().answer).toBe(usefulReply);

    // 2. Intermediate destructive patch: DeepSeek clears/empties fragments BEFORE sending status marker!
    const clearEvents = decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [],
      }),
    });

    // Content is now 0 chars in projection
    expect(decoder.getProjectedContent().answer).toBe('');
    expect(clearEvents.some((e) => e.type === 'answer_replace' && e.fullText === '')).toBe(true);

    // 3. Subsequent event: CONTENT_FILTER arrives in separate status patch
    const filterEvents = decoder.feed({
      data: JSON.stringify({
        p: 'status',
        o: 'SET',
        v: 'CONTENT_FILTER',
      }),
    });

    const filterEvt = filterEvents.find((e) => e.type === 'filter_triggered');
    expect(filterEvt).toBeDefined();
    expect(filterEvt?.reason).toBe('CONTENT_FILTER');

    // Invariant: Last Good MUST be the real pre-filter text, NOT ""!
    expect(filterEvt?.lastGood).toBeDefined();
    expect(filterEvt?.lastGood?.answer).toBe(usefulReply);
    expect(filterEvt?.lastGood?.thinking).toBe('Detailed thinking process before filter.');
    expect(filterEvt?.lastGood?.messageId).toBe('msg_filtered_live');
    expect(decoder.getLastGoodState()?.answer).toBe(usefulReply);
  });

  it('handles genuine input-filter with no fabricated lastGood state or recovery', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_genuine_input_filter');

    // Feed message_id and immediate CONTENT_FILTER without any generated content
    const events = decoder.feed({
      data: JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [
          { p: 'message_id', v: 'msg_input_filtered' },
          { p: 'status', o: 'SET', v: 'CONTENT_FILTER' },
        ],
      }),
    });

    const filterEvt = events.find((e) => e.type === 'filter_triggered');
    expect(filterEvt).toBeDefined();
    expect(filterEvt?.reason).toBe('CONTENT_FILTER');

    // Invariant: No fabricated lastGood state when no text ever reached the browser!
    expect(filterEvt?.lastGood).toBeUndefined();
    expect(decoder.getLastGoodState()).toBeUndefined();
  });

  it('preserves reasoning in thinking-only stream before CONTENT_FILTER', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_thinking_only_filter');

    // Stream reasoning tokens only
    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'THINK', content: 'Step-by-step reasoning on policy edge case.' }],
      }),
    });

    // Content filter triggers
    const events = decoder.feed({
      data: JSON.stringify({
        p: 'status',
        o: 'SET',
        v: 'CONTENT_FILTER',
      }),
    });

    const filterEvt = events.find((e) => e.type === 'filter_triggered');
    expect(filterEvt).toBeDefined();
    expect(filterEvt?.lastGood).toBeDefined();
    expect(filterEvt?.lastGood?.answer).toBe('');
    expect(filterEvt?.lastGood?.thinking).toBe('Step-by-step reasoning on policy edge case.');
  });

  it('preserves pre-replacement response when intermediate patch replaces response with native refusal template', () => {
    const decoder = new DeepSeekProtocolDecoder('stream_template_intermediate');

    const usefulAnswer = 'Useful technical information before policy replacement.';
    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'RESPONSE', content: usefulAnswer }],
      }),
    });

    // Native refusal replacement
    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'TEMPLATE_RESPONSE', content: "Sorry, that's beyond my current scope. Let's talk about something else." }],
      }),
    });

    // Close event with CONTENT_FILTER
    const finishEvents = decoder.feed({
      event: 'finish',
      data: '',
    });

    const lastGood = decoder.getLastGoodState();
    expect(lastGood).toBeDefined();
    expect(lastGood?.answer).toBe(usefulAnswer);
  });
});
