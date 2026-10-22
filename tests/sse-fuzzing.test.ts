import { describe, it, expect } from 'vitest';
import { GenericSseDecoder } from '../src/transport/sse/decoder';
import { Utf8StreamDecoder } from '../src/transport/utf8/decoder';
import type { SseEvent } from '../src/transport/sse/types';

// Simple deterministic Mulberry32 pseudo-random number generator
function createPrng(seed: number) {
  let s = seed;
  return function next(): number {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('SSE Chunk & Byte Fuzzing', () => {
  const CANONICAL_FIXTURE = [
    ': initial heartbeat comment',
    'id: 101',
    'event: greeting',
    'data: Привет, мир!',
    'data: 你好世界 🚀',
    '',
    ': intermediate heartbeat',
    'id: 102',
    'retry: 3000',
    'data: Multi-line chunk paragraph 1',
    'data: Multi-line chunk paragraph 2',
    'data: Final line',
    '',
    'data: Single line event without extra fields',
    '',
    ': terminal comment',
    'event: done',
    'data: [DONE]',
    '',
    '',
  ].join('\n');

  // Ground truth obtained by single-chunk feed
  const getGroundTruth = (): SseEvent[] => {
    const decoder = new GenericSseDecoder();
    const events = decoder.feed(CANONICAL_FIXTURE);
    events.push(...decoder.finish());
    return events;
  };

  const groundTruth = getGroundTruth();

  it('verifies ground truth has expected event count and structure', () => {
    expect(groundTruth).toHaveLength(4);
    expect(groundTruth[0]?.event).toBe('greeting');
    expect(groundTruth[0]?.data).toBe('Привет, мир!\n你好世界 🚀');
    expect(groundTruth[0]?.id).toBe('101');

    expect(groundTruth[1]?.id).toBe('102');
    expect(groundTruth[1]?.retry).toBe(3000);
    expect(groundTruth[1]?.data).toBe(
      'Multi-line chunk paragraph 1\nMulti-line chunk paragraph 2\nFinal line'
    );

    expect(groundTruth[2]?.data).toBe('Single line event without extra fields');
    expect(groundTruth[3]?.event).toBe('done');
    expect(groundTruth[3]?.data).toBe('[DONE]');
  });

  it('produces identical events across every single split position [0:i] and [i:N]', () => {
    for (let i = 0; i <= CANONICAL_FIXTURE.length; i++) {
      const part1 = CANONICAL_FIXTURE.slice(0, i);
      const part2 = CANONICAL_FIXTURE.slice(i);

      const decoder = new GenericSseDecoder();
      const events: SseEvent[] = [];
      events.push(...decoder.feed(part1));
      events.push(...decoder.feed(part2));
      events.push(...decoder.finish());

      expect(events).toEqual(groundTruth);
    }
  });

  it('produces identical events when fed character by character (1-char chunks)', () => {
    const decoder = new GenericSseDecoder();
    const events: SseEvent[] = [];

    for (const char of CANONICAL_FIXTURE) {
      events.push(...decoder.feed(char));
    }
    events.push(...decoder.finish());

    expect(events).toEqual(groundTruth);
  });

  it('produces identical events with fixed chunk sizes (2, 3, 5, 7, 11)', () => {
    const sizes = [2, 3, 5, 7, 11];

    for (const size of sizes) {
      const decoder = new GenericSseDecoder();
      const events: SseEvent[] = [];

      for (let i = 0; i < CANONICAL_FIXTURE.length; i += size) {
        events.push(...decoder.feed(CANONICAL_FIXTURE.slice(i, i + size)));
      }
      events.push(...decoder.finish());

      expect(events).toEqual(groundTruth);
    }
  });

  it('produces identical events under deterministic pseudo-random chunk sizes', () => {
    const prng = createPrng(42);

    for (let run = 0; run < 20; run++) {
      const decoder = new GenericSseDecoder();
      const events: SseEvent[] = [];

      let offset = 0;
      while (offset < CANONICAL_FIXTURE.length) {
        // Random chunk size between 1 and 25
        const chunkSize = Math.floor(prng() * 25) + 1;
        const chunk = CANONICAL_FIXTURE.slice(offset, offset + chunkSize);
        offset += chunkSize;

        events.push(...decoder.feed(chunk));
      }
      events.push(...decoder.finish());

      expect(events).toEqual(groundTruth);
    }
  });

  it('produces identical events under byte-level fuzzing (UTF-8 bytes -> Utf8Decoder -> SseDecoder)', () => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(CANONICAL_FIXTURE);
    const prng = createPrng(999);

    for (let run = 0; run < 25; run++) {
      const utf8Decoder = new Utf8StreamDecoder();
      const sseDecoder = new GenericSseDecoder();
      const events: SseEvent[] = [];

      let offset = 0;
      while (offset < bytes.length) {
        // Random byte chunk size between 1 and 16 (frequently cuts multi-byte characters)
        const chunkSize = Math.floor(prng() * 16) + 1;
        const byteChunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
        offset += chunkSize;

        const text = utf8Decoder.decode(byteChunk);
        if (text) {
          events.push(...sseDecoder.feed(text));
        }
      }

      const tail = utf8Decoder.flush();
      if (tail) {
        events.push(...sseDecoder.feed(tail));
      }
      events.push(...sseDecoder.finish());

      expect(events).toEqual(groundTruth);
    }
  });
});
