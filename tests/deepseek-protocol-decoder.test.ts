import { describe, it, expect } from 'vitest';
import { GenericSseDecoder } from '../src/transport/sse/decoder';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';
import type { DeepSeekSemanticEvent } from '../src/adapters/deepseek/protocol/types';

describe('DeepSeek Protocol Decoder End-to-End', () => {
  it('decodes a standard streaming response end-to-end from raw SSE chunks', () => {
    const sseDecoder = new GenericSseDecoder();
    const protocolDecoder = new DeepSeekProtocolDecoder('stream_e2e_1', 'session_123');

    const rawSseStream = [
      'data: {"p":"response/message_id","o":"SET","v":"msg_e2e_99"}\n\n',
      'data: {"p":"response/fragments/0","o":"SET","v":{"type":"RESPONSE","content":"Hello"}}\n\n',
      'data: {"p":"response/fragments/0/content","o":"APPEND","v":" world!"}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
      'data: [DONE]\n\n',
    ];

    const emittedSemantics: DeepSeekSemanticEvent[] = [];

    for (const chunk of rawSseStream) {
      const sseEvents = sseDecoder.feed(chunk);
      for (const sse of sseEvents) {
        emittedSemantics.push(...protocolDecoder.feed(sse));
      }
    }
    emittedSemantics.push(...protocolDecoder.finish());

    expect(emittedSemantics.length).toBeGreaterThanOrEqual(4);

    // 1. stream_start
    expect(emittedSemantics[0]?.type).toBe('stream_start');
    expect(emittedSemantics[0]?.sessionId).toBe('session_123');

    // 2. message_id_identified
    const msgIdEvt = emittedSemantics.find((e) => e.type === 'message_id_identified');
    expect(msgIdEvt?.messageId).toBe('msg_e2e_99');

    // 3. answer_delta
    const answerDeltas = emittedSemantics.filter((e) => e.type === 'answer_delta');
    expect(answerDeltas.length).toBeGreaterThanOrEqual(2);
    expect(answerDeltas[0]?.delta).toBe('Hello');
    expect(answerDeltas[1]?.delta).toBe(' world!');

    // 4. stream_finished
    const finishedEvt = emittedSemantics.find((e) => e.type === 'stream_finished');
    expect(finishedEvt?.status).toBe('FINISHED');

    // Diagnostics
    const diag = protocolDecoder.getDiagnostics();
    expect(diag.activeMessageId).toBe('msg_e2e_99');
    expect(diag.currentAnswerLength).toBe('Hello world!'.length);
    expect(diag.parsedFramesCount).toBe(4); // 4 JSON frames + [DONE]
  });

  it('decodes reasoning tokens (thinking_delta) before answer tokens (answer_delta)', () => {
    const sseDecoder = new GenericSseDecoder();
    const protocolDecoder = new DeepSeekProtocolDecoder('stream_reasoning', 'session_456');

    const rawSseStream = [
      'data: {"p":"response/message_id","o":"SET","v":"msg_r1"}\n\n',
      'data: {"p":"response/fragments/0","o":"SET","v":{"type":"THINK","content":"Let me calculate..."}}\n\n',
      'data: {"p":"response/fragments/0/content","o":"APPEND","v":" got it."}\n\n',
      'data: {"p":"response/fragments/1","o":"SET","v":{"type":"RESPONSE","content":"The answer is 42."}}\n\n',
      'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
    ];

    const emitted: DeepSeekSemanticEvent[] = [];
    for (const chunk of rawSseStream) {
      for (const sse of sseDecoder.feed(chunk)) {
        emitted.push(...protocolDecoder.feed(sse));
      }
    }

    const thinkingDeltas = emitted.filter((e) => e.type === 'thinking_delta');
    const answerDeltas = emitted.filter((e) => e.type === 'answer_delta');

    expect(thinkingDeltas.length).toBeGreaterThanOrEqual(2);
    expect(thinkingDeltas[0]?.delta).toBe('Let me calculate...');
    expect(thinkingDeltas[1]?.delta).toBe(' got it.');

    expect(answerDeltas).toHaveLength(1);
    expect(answerDeltas[0]?.delta).toBe('The answer is 42.');

    const diag = protocolDecoder.getDiagnostics();
    expect(diag.currentThinkingLength).toBe('Let me calculate... got it.'.length);
    expect(diag.currentAnswerLength).toBe('The answer is 42.'.length);
  });

  it('fails open on unknown operations or corrupted SSE JSON', () => {
    const protocolDecoder = new DeepSeekProtocolDecoder('stream_corrupted');

    // Invalid JSON
    expect(() => protocolDecoder.feed({ data: 'not { a { json' })).not.toThrow();

    // Unknown operation
    expect(() =>
      protocolDecoder.feed({
        data: JSON.stringify({ p: 'invalid', o: 'UNKNOWN_OP', v: null }),
      })
    ).not.toThrow();
  });
});
