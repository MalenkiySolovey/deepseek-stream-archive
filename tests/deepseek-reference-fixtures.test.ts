import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GenericSseDecoder } from '../src/transport/sse/decoder';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';
import type { DeepSeekSemanticEvent } from '../src/adapters/deepseek/protocol/types';

describe('DeepSeek Reference Fixture Replay Tests', () => {
  const fixturesDir = path.resolve(__dirname, 'fixtures/deepseek/reference');

  it('accurately replays normal-completion.sse.txt fixture', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'normal-completion.sse.txt'), 'utf-8');
    const sseDecoder = new GenericSseDecoder();
    const protocolDecoder = new DeepSeekProtocolDecoder('stream_fix_1');

    const events: DeepSeekSemanticEvent[] = [];
    for (const sse of sseDecoder.feed(raw)) {
      events.push(...protocolDecoder.feed(sse));
    }
    events.push(...protocolDecoder.finish());

    expect(events.find((e) => e.type === 'message_id_identified')?.messageId).toBe('msg_fix_001');

    const diag = protocolDecoder.getDiagnostics();
    expect(diag.currentAnswerLength).toBe('Hello, DeepSeek StreamArchive!'.length);
    expect(events.find((e) => e.type === 'stream_finished')?.status).toBe('FINISHED');
    expect(diag.filterEventsCount).toBe(0);
  });

  it('accurately replays reasoning-completion.sse.txt fixture', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'reasoning-completion.sse.txt'), 'utf-8');
    const sseDecoder = new GenericSseDecoder();
    const protocolDecoder = new DeepSeekProtocolDecoder('stream_fix_2');

    const events: DeepSeekSemanticEvent[] = [];
    for (const sse of sseDecoder.feed(raw)) {
      events.push(...protocolDecoder.feed(sse));
    }
    events.push(...protocolDecoder.finish());

    const diag = protocolDecoder.getDiagnostics();
    expect(diag.currentThinkingLength).toBe(
      "Let's analyze the input parameters. All constraints satisfied.".length
    );
    expect(diag.currentAnswerLength).toBe('Execution verified and complete.'.length);
    expect(diag.activeMessageId).toBe('msg_fix_002');
  });

  it('accurately replays censored-completion.sse.txt and captures pre-censorship state', () => {
    const raw = fs.readFileSync(path.join(fixturesDir, 'censored-completion.sse.txt'), 'utf-8');
    const sseDecoder = new GenericSseDecoder();
    const protocolDecoder = new DeepSeekProtocolDecoder('stream_fix_3');

    const events: DeepSeekSemanticEvent[] = [];
    for (const sse of sseDecoder.feed(raw)) {
      events.push(...protocolDecoder.feed(sse));
    }
    events.push(...protocolDecoder.finish());

    const filterEvt = events.find((e) => e.type === 'filter_triggered');
    expect(filterEvt).toBeDefined();
    expect(filterEvt?.lastGood?.answer).toBe('Original unredacted response text.');
    expect(filterEvt?.lastGood?.thinking).toBe('Private chain of thought before moderation.');
    expect(filterEvt?.lastGood?.messageId).toBe('msg_fix_003');

    const diag = protocolDecoder.getDiagnostics();
    expect(diag.filterEventsCount).toBe(1);
    expect(diag.lastFilterEvent?.reason).toBe('CONTENT_FILTER');
  });
});
