import { describe, it, expect } from 'vitest';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';

describe('DeepSeek Protocol Terminal Semantics', () => {
  it('emits stream_finished on protocol [DONE] sentinel', () => {
    const decoder = new DeepSeekProtocolDecoder('term_stream_1');

    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'RESPONSE', content: 'Normal response text' }],
      }),
    });

    const events = decoder.feed({ data: '[DONE]' });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('stream_finished');
    expect(events[0]?.status).toBe('FINISHED');
  });

  it('emits stream_finished on explicit FINISHED status in patch', () => {
    const decoder = new DeepSeekProtocolDecoder('term_stream_2');

    const events = decoder.feed({
      data: JSON.stringify({
        p: 'status',
        o: 'SET',
        v: 'FINISHED',
      }),
    });

    const finished = events.find((e) => e.type === 'stream_finished');
    expect(finished).toBeDefined();
    expect(finished?.status).toBe('FINISHED');
  });

  it('emits stream_transport_ended when transport completes normally without protocol finish', () => {
    const decoder = new DeepSeekProtocolDecoder('term_stream_3');

    decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'SET',
        v: 'Incomplete stream before abrupt connection close',
      }),
    });

    // Transport ended normally, but no [DONE] or FINISHED status was received
    const terminalEvents = decoder.finish({ kind: 'transport_complete' });
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe('stream_transport_ended');
  });

  it('emits stream_interrupted on transport abort and NEVER triggers false filter_triggered', () => {
    const decoder = new DeepSeekProtocolDecoder('term_stream_4');

    decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'SET',
        v: 'Partial response before user clicks Stop button',
      }),
    });

    // User pressed Stop -> abort event
    const terminalEvents = decoder.finish({
      kind: 'transport_abort',
      reason: 'user_abort',
    });

    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe('stream_interrupted');
    expect(terminalEvents[0]?.reason).toBe('user_abort');

    // CRITICAL: Ensure abort is never treated as content censorship
    expect(decoder.getLastGoodState()).toBeUndefined();
    expect(decoder.getDiagnostics().filterEventsCount).toBe(0);
  });

  it('emits stream_interrupted on transport error', () => {
    const decoder = new DeepSeekProtocolDecoder('term_stream_5');

    decoder.feed({
      data: JSON.stringify({
        p: 'fragments/0/content',
        o: 'SET',
        v: 'Partial response before network drop',
      }),
    });

    const terminalEvents = decoder.finish({
      kind: 'transport_error',
      error: 'ERR_CONNECTION_RESET',
    });

    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe('stream_interrupted');
    expect(terminalEvents[0]?.error).toBe('ERR_CONNECTION_RESET');
  });

  it('emits stream_degraded when finalized in degraded condition', () => {
    const decoder = new DeepSeekProtocolDecoder('term_stream_6');

    const terminalEvents = decoder.finish({
      kind: 'degraded',
      reason: 'Sequence gap detected: chunk #4 skipped',
    });

    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]?.type).toBe('stream_degraded');
    expect(terminalEvents[0]?.reason).toContain('Sequence gap detected');
  });

  it('retains lastGood state when censorship is followed by protocol FINISHED', () => {
    const decoder = new DeepSeekProtocolDecoder('term_stream_7');

    // 1. Initial legitimate response
    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'RESPONSE', content: 'Genuine valuable knowledge.' }],
      }),
    });

    // 2. Censorship occurs via TEMPLATE_RESPONSE replacement
    const filterEvents = decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'TEMPLATE_RESPONSE', content: 'I cannot fulfill this request based on safety guidelines.' }],
      }),
    });
    expect(filterEvents.some((e) => e.type === 'filter_triggered')).toBe(true);

    // 3. Protocol completes with FINISHED
    const finishEvents = decoder.feed({
      data: JSON.stringify({
        p: 'status',
        o: 'SET',
        v: 'FINISHED',
      }),
    });

    expect(finishEvents.some((e) => e.type === 'stream_finished')).toBe(true);

    // lastGood remains intact even after FINISHED
    expect(decoder.getLastGoodState()?.answer).toBe('Genuine valuable knowledge.');
    expect(decoder.getLastGoodState()?.reason).toBe('TEMPLATE_RESPONSE');
  });

  it('treats CONTENT_FILTER status as immediate terminal event', () => {
    const decoder = new DeepSeekProtocolDecoder('term_stream_filter_terminal');

    decoder.feed({
      data: JSON.stringify({
        p: 'fragments',
        o: 'SET',
        v: [{ type: 'RESPONSE', content: 'Pre-filter legitimate tokens.' }],
      }),
    });

    const events = decoder.feed({
      data: JSON.stringify({
        p: 'status',
        o: 'SET',
        v: 'CONTENT_FILTER',
      }),
    });

    expect(events.some((e) => e.type === 'filter_triggered')).toBe(true);
    const finishEvt = events.find((e) => e.type === 'stream_finished');
    expect(finishEvt).toBeDefined();
    expect(finishEvt?.terminalReason).toBe('filtered');
    expect(decoder.getLastGoodState()?.answer).toBe('Pre-filter legitimate tokens.');
    expect(decoder.getLastGoodState()?.reason).toBe('CONTENT_FILTER');
  });
});
