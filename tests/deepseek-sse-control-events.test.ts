import { describe, it, expect } from 'vitest';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';
import { MAX_ARRAY_INDEX } from '../src/adapters/deepseek/protocol/patch-applier';
import type { SseEvent } from '../src/transport/sse/types';

describe('DeepSeek SSE Control Events & Status Authority', () => {
  it('ready event does not become patch and extracts message ID safely', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-ready-1', 'session-1');

    const events = decoder.feed({
      event: 'ready',
      data: JSON.stringify({
        request_message_id: 'req-100',
        response_message_id: 'msg-200',
        model_type: 'deepseek-chat',
      }),
    });

    const diag = decoder.getDiagnostics();
    expect(diag.parsedFramesCount).toBe(0); // Not counted as data frame
    expect(diag.operationsCount.set).toBe(0);
    expect(diag.operationsCount.append).toBe(0);
    expect(diag.activeMessageId).toBe('msg-200');

    // Emits stream_start and message_id_identified
    expect(events.map((e) => e.type)).toContain('stream_start');
    expect(events.map((e) => e.type)).toContain('message_id_identified');
  });

  it('update_session and title events do not alter answer or thinking', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-update-1');

    decoder.feed({
      data: JSON.stringify({
        p: 'response/fragments',
        o: 'APPEND',
        v: [{ id: 1, type: 'RESPONSE', content: 'Initial answer.' }],
      }),
    });

    // Feed update_session
    decoder.feed({
      event: 'update_session',
      data: JSON.stringify({ updated_at: 1728320000 }),
    });

    // Feed title
    decoder.feed({
      event: 'title',
      data: JSON.stringify({ title: 'New Conversation Title' }),
    });

    const content = decoder.getProjectedContent();
    expect(content.answer).toBe('Initial answer.');
    expect(content.thinking).toBe('');
    expect(content.answer).not.toContain('Title');
    expect(content.answer).not.toContain('1728320000');
  });

  it('quasi_status = FINISHED does NOT prematurely terminate stream', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-quasi-1');

    // Initial content
    decoder.feed({
      data: JSON.stringify({
        p: 'response/fragments',
        o: 'APPEND',
        v: [{ id: 1, type: 'RESPONSE', content: 'In progress text' }],
      }),
    });

    // Advisory quasi_status = FINISHED
    const quasiEvents = decoder.feed({
      data: JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [{ p: 'quasi_status', v: 'FINISHED' }],
      }),
    });

    // CRITICAL: Must NOT emit stream_finished on quasi_status alone!
    expect(quasiEvents.some((e) => e.type === 'stream_finished')).toBe(false);

    const diag = decoder.getDiagnostics();
    expect(diag.quasiStatus).toBe('FINISHED');
    expect(diag.lastProtocolStatus).toBeUndefined();
    expect(diag.lastTerminalReason).toBeUndefined();

    // Verify decoder is STILL accepting frames and projecting deltas
    const nextEvents = decoder.feed({
      data: JSON.stringify({
        v: ' and more text',
      }),
    });

    expect(nextEvents.some((e) => e.type === 'answer_delta')).toBe(true);
    expect(decoder.getProjectedContent().answer).toBe('In progress text and more text');
  });

  it('CRITICAL REGRESSION: quasi_status = FINISHED followed by late CONTENT_FILTER is intercepted and frozen', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-censored-1');

    // 1. Assistant generates response
    decoder.feed({
      data: JSON.stringify({
        v: {
          response: {
            message_id: 'msg-filtered',
            status: 'WIP',
            fragments: [
              { id: 1, type: 'THINK', content: 'Deep internal reasoning' },
              { id: 2, type: 'RESPONSE', content: 'Valuable controversial insight' },
            ],
          },
        },
      }),
    });

    expect(decoder.getProjectedContent().answer).toBe('Valuable controversial insight');
    expect(decoder.getProjectedContent().thinking).toBe('Deep internal reasoning');

    // 2. Platform sends advisory quasi_status = FINISHED
    const quasiEvents = decoder.feed({
      data: JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [{ p: 'quasi_status', v: 'FINISHED' }],
      }),
    });
    expect(quasiEvents.some((e) => e.type === 'stream_finished')).toBe(false);

    // 3. Platform sends destructive censorship BATCH replacing fragments with TEMPLATE_RESPONSE
    const filterBatchEvents = decoder.feed({
      data: JSON.stringify({
        v: [
          { p: 'status', v: 'CONTENT_FILTER' },
          {
            p: 'fragments',
            v: [
              {
                id: 3,
                type: 'TEMPLATE_RESPONSE',
                content: 'I apologize, but I cannot answer this query.',
              },
            ],
          },
          { p: 'quasi_status', v: 'CONTENT_FILTER' },
        ],
      }),
    });

    // Expect filter_triggered and stream_finished with filtered reason
    const filterTriggered = filterBatchEvents.find((e) => e.type === 'filter_triggered');
    expect(filterTriggered).toBeDefined();
    expect(filterTriggered?.reason).toBe('CONTENT_FILTER');

    const lastGood = decoder.getLastGoodState();
    expect(lastGood).toBeDefined();
    expect(lastGood?.answer).toBe('Valuable controversial insight');
    expect(lastGood?.thinking).toBe('Deep internal reasoning');

    const streamFinished = filterBatchEvents.find((e) => e.type === 'stream_finished');
    expect(streamFinished).toBeDefined();
    expect(streamFinished?.terminalReason).toBe('filtered');
    expect(streamFinished?.status).toBe('CONTENT_FILTER');

    // 4. Subsequent finish and close control events do NOT overwrite filtered reason or duplicate finished event
    const finishEvents = decoder.feed({
      event: 'finish',
      data: '{}',
    });
    expect(finishEvents.filter((e) => e.type === 'stream_finished').length).toBe(0);

    const closeEvents = decoder.feed({
      event: 'close',
      data: JSON.stringify({ click_behavior: 'none' }),
    });
    expect(closeEvents.filter((e) => e.type === 'stream_finished').length).toBe(0);

    const diag = decoder.getDiagnostics();
    expect(diag.lastTerminalReason).toBe('filtered');
    expect(diag.finishControlObserved).toBe(true);
    expect(diag.closeControlObserved).toBe(true);
    expect(diag.eventsAfterTerminalCount).toBe(0); // Trailing control events are legal!
  });

  it('quasi_status = FINISHED followed by authoritative status = FINISHED completes on authoritative status', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-normal-status-1');

    decoder.feed({
      data: JSON.stringify({
        p: 'response/fragments',
        o: 'APPEND',
        v: [{ id: 1, type: 'RESPONSE', content: 'Normal complete response.' }],
      }),
    });

    // 1. quasi_status FINISHED
    const qEvts = decoder.feed({
      data: JSON.stringify({
        p: 'response/quasi_status',
        v: 'FINISHED',
      }),
    });
    expect(qEvts.some((e) => e.type === 'stream_finished')).toBe(false);

    // 2. Authoritative status FINISHED
    const finishEvts = decoder.feed({
      data: JSON.stringify({
        p: 'response/status',
        v: 'FINISHED',
      }),
    });
    const finishedEvent = finishEvts.find((e) => e.type === 'stream_finished');
    expect(finishedEvent).toBeDefined();
    expect(finishedEvent?.terminalReason).toBe('completed');

    // 3. Trailing finish and close
    decoder.feed({ event: 'finish', data: '{}' });
    decoder.feed({ event: 'close', data: '{}' });

    const diag = decoder.getDiagnostics();
    expect(diag.lastTerminalReason).toBe('completed');
    expect(diag.eventsAfterTerminalCount).toBe(0);
  });

  it('legal trailing control events after terminal are not counted as post-terminal violations', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-trailing-1');

    decoder.feed({
      data: JSON.stringify({
        v: {
          response: {
            status: 'FINISHED',
            fragments: [{ id: 1, type: 'RESPONSE', content: 'Done.' }],
          },
        },
      }),
    });

    const diagBefore = decoder.getDiagnostics();
    expect(diagBefore.lastTerminalReason).toBe('completed');
    expect(diagBefore.eventsAfterTerminalCount).toBe(0);

    // Trailing legal control events
    decoder.feed({ event: 'finish', data: '{}' });
    decoder.feed({ event: 'update_session', data: '{"updated_at": 1}' });
    decoder.feed({ event: 'title', data: '{"title": "Chat Title"}' });
    decoder.feed({ event: 'close', data: '{"click_behavior":"none"}' });

    const diagAfter = decoder.getDiagnostics();
    expect(diagAfter.eventsAfterTerminalCount).toBe(0);
    expect(diagAfter.finishControlObserved).toBe(true);
    expect(diagAfter.closeControlObserved).toBe(true);

    // An actual message payload arriving after terminal DOES increment eventsAfterTerminalCount
    decoder.feed({
      event: 'message',
      data: JSON.stringify({ v: 'unexpected extra text' }),
    });

    const diagFinal = decoder.getDiagnostics();
    expect(diagFinal.eventsAfterTerminalCount).toBe(1);
  });

  it('unknown SSE event names do not crash and are recorded diagnostically', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-unknown-ev-1');

    const events = decoder.feed({
      event: 'custom_ping_signal',
      data: JSON.stringify({ ping: true }),
    });

    expect(events.length).toBe(0); // Not emitted as semantic domain event

    const diag = decoder.getDiagnostics();
    expect(diag.unknownSseEventNames).toContain('custom_ping_signal');
    expect(diag.protocolWarningsCount).toBeGreaterThan(0);
    expect(diag.recentWarnings.some((w) => w.includes('unknown_sse_event_name'))).toBe(true);
  });

  it('Reference-Derived Realistic Normal Sequence Fixture', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-ref-normal');

    // 1. ready
    decoder.feed({
      event: 'ready',
      data: JSON.stringify({
        request_message_id: 1,
        response_message_id: 42,
        model_type: 'default',
      }),
    });

    // 2. update_session
    decoder.feed({
      event: 'update_session',
      data: JSON.stringify({ updated_at: 100 }),
    });

    // 3. Initial WIP state
    decoder.feed({
      data: JSON.stringify({
        v: {
          response: {
            message_id: 42,
            status: 'WIP',
            fragments: [{ id: 1, type: 'THINK', content: 'Step 1', elapsed_secs: 1.2 }],
          },
        },
      }),
    });

    // 4. Fragments append
    decoder.feed({
      data: JSON.stringify({
        p: 'response/fragments',
        o: 'APPEND',
        v: [{ id: 2, type: 'RESPONSE', content: 'Hello world.' }],
      }),
    });

    // 5. quasi_status FINISHED
    decoder.feed({
      data: JSON.stringify({
        p: 'response',
        o: 'BATCH',
        v: [{ p: 'quasi_status', v: 'FINISHED' }],
      }),
    });

    // 6. status FINISHED
    const statusEvts = decoder.feed({
      data: JSON.stringify({
        p: 'response/status',
        v: 'FINISHED',
      }),
    });

    expect(statusEvts.some((e) => e.type === 'stream_finished')).toBe(true);

    // 7. Trailing finish, update_session, title, close
    decoder.feed({ event: 'finish', data: '{}' });
    decoder.feed({ event: 'update_session', data: '{"updated_at": 200}' });
    decoder.feed({ event: 'title', data: '{"title": "Greeting"}' });
    decoder.feed({ event: 'close', data: '{"click_behavior":"none"}' });

    const content = decoder.getProjectedContent();
    expect(content.answer).toBe('Hello world.');
    expect(content.thinking).toBe('Step 1');

    const diag = decoder.getDiagnostics();
    expect(diag.activeMessageId).toBe('42');
    expect(diag.lastTerminalReason).toBe('completed');
    expect(diag.finishControlObserved).toBe(true);
    expect(diag.closeControlObserved).toBe(true);
    expect(diag.eventsAfterTerminalCount).toBe(0);
  });

  it('Reference-Derived Realistic Filtered Sequence Fixture (liuxd test-rebuild SYNTH)', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-ref-synth-filtered');

    // 'event: ready'
    decoder.feed({
      event: 'ready',
      data: '{"request_message_id":1,"response_message_id":2,"model_type":"default"}',
    });

    // initial WIP state
    decoder.feed({
      data: '{"v":{"response":{"message_id":2,"status":"WIP","accumulated_token_usage":10,"fragments":[{"id":2,"type":"THINK","content":"","stage_id":1}]}}}',
    });

    // THINK content
    decoder.feed({
      data: '{"p":"response/fragments/-1/content","o":"APPEND","v":"思考"}',
    });
    decoder.feed({
      data: '{"v":"继续"}',
    });
    decoder.feed({
      data: '{"p":"response/fragments/-1/elapsed_secs","o":"SET","v":1.5}',
    });

    // RESPONSE content
    decoder.feed({
      data: '{"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"正文","stage_id":1}]}',
    });
    decoder.feed({
      data: '{"p":"response/fragments/-1/content","v":"更多"}',
    });
    decoder.feed({
      data: '{"v":"。"}',
    });

    // quasi_status = FINISHED
    decoder.feed({
      data: '{"p":"response","o":"BATCH","v":[{"p":"quasi_status","v":"FINISHED"}]}',
    });

    // BATCH with status: CONTENT_FILTER and TEMPLATE_RESPONSE
    const filterEvts = decoder.feed({
      data: '{"v":[{"p":"status","v":"CONTENT_FILTER"},{"p":"fragments","v":[{"id":4,"type":"TEMPLATE_RESPONSE","content":"模板话术"}]},{"p":"quasi_status","v":"CONTENT_FILTER"}]}',
    });

    expect(filterEvts.some((e) => e.type === 'filter_triggered')).toBe(true);
    expect(filterEvts.some((e) => e.type === 'stream_finished')).toBe(true);

    // Trailing update_session & close
    decoder.feed({
      event: 'update_session',
      data: '{"updated_at":1}',
    });
    decoder.feed({
      event: 'close',
      data: '{"click_behavior":"none"}',
    });

    const lastGood = decoder.getLastGoodState();
    expect(lastGood).toBeDefined();
    expect(lastGood?.answer).toBe('正文更多。');
    expect(lastGood?.thinking).toBe('思考继续');

    const diag = decoder.getDiagnostics();
    expect(diag.lastTerminalReason).toBe('filtered');
    expect(diag.closeControlObserved).toBe(true);
    expect(diag.eventsAfterTerminalCount).toBe(0);
  });

  it('transport complete with quasi_status FINISHED but without authoritative status concludes as transport_ended', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-quasi-transport-ended');

    // 1. RESPONSE = "valuable text"
    decoder.feed({
      data: JSON.stringify({
        p: 'response/fragments',
        o: 'APPEND',
        v: [{ id: 1, type: 'RESPONSE', content: 'valuable text' }],
      }),
    });

    // 2. quasi_status = FINISHED
    decoder.feed({
      data: JSON.stringify({
        p: 'response/quasi_status',
        v: 'FINISHED',
      }),
    });

    // 3. Transport completes normally, but authoritative response.status never arrived!
    const finishEvents = decoder.finish();

    // Expected: NOT stream_finished(completed)
    expect(finishEvents.some((e) => e.type === 'stream_finished')).toBe(false);

    // Instead: stream_transport_ended (unresolved transport terminal)
    const transportEnded = finishEvents.find((e) => e.type === 'stream_transport_ended');
    expect(transportEnded).toBeDefined();
    expect(transportEnded?.terminalReason).toBe('transport_ended');

    // Diagnostics
    const diag = decoder.getDiagnostics();
    expect(diag.quasiStatus).toBe('FINISHED');
    expect(diag.lastProtocolStatus).toBeUndefined();
    expect(diag.lastTerminalReason).toBe('transport_ended');
    expect(decoder.getProjectedContent().answer).toBe('valuable text');
  });

  it('atomically rolls back snapshot if fragments exceed limit: preserves answer, WIP status, and prevents stream_finished', () => {
    const decoder = new DeepSeekProtocolDecoder('stream-snapshot-atomic');

    // 1. Initial valid state: answer = "old answer", status = WIP
    decoder.feed({
      data: JSON.stringify({
        v: {
          response: {
            status: 'WIP',
            fragments: [{ id: 1, type: 'RESPONSE', content: 'old answer' }],
          },
        },
      }),
    });

    expect(decoder.getProjectedContent().answer).toBe('old answer');
    expect(decoder.getDiagnostics().lastProtocolStatus).toBe('WIP');

    // 2. Incoming corrupted snapshot: oversized fragments + status FINISHED
    const oversized = Array.from({ length: MAX_ARRAY_INDEX + 10 }, (_, i) => ({
      id: i,
      type: 'RESPONSE',
      content: `Item ${i}`,
    }));

    const events = decoder.feed({
      data: JSON.stringify({
        v: {
          response: {
            status: 'FINISHED',
            fragments: oversized,
          },
        },
      }),
    });

    // 3. Entire snapshot must be rejected atomically!
    // No stream_finished event!
    expect(events.some((e) => e.type === 'stream_finished')).toBe(false);

    // State remains completely unchanged!
    expect(decoder.getProjectedContent().answer).toBe('old answer');
    const diag = decoder.getDiagnostics();
    expect(diag.lastProtocolStatus).toBe('WIP');
    expect(diag.lastTerminalReason).toBeUndefined();
    expect(diag.compatibilityState).toBe('degraded');
  });
});
