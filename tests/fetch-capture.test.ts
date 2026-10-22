import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchCapture } from '../src/transport/fetch/capture';
import type { TransportEvent } from '../src/transport/types';

describe('Fetch Passive Capture Tap', () => {
  let uninstall: () => void = () => {};
  let emittedEvents: TransportEvent[] = [];
  let seq = 0;

  let originalGlobalWindow: any;

  beforeEach(() => {
    emittedEvents = [];
    seq = 0;
    originalGlobalWindow = (globalThis as any).window;
    (globalThis as any).window = globalThis;
  });

  afterEach(() => {
    uninstall();
    (globalThis as any).window = originalGlobalWindow;
  });

  it('leaves non-SSE responses completely untouched and emits no events', async () => {
    const jsonBody = JSON.stringify({ status: 'ok', data: 123 });
    const originalFetch = vi.fn().mockResolvedValue(
      new Response(jsonBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    window.fetch = originalFetch;

    uninstall = installFetchCapture({
      producerSessionId: 'test-session',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
    });

    const res = await window.fetch('https://chat.deepseek.com/api/v0/users/current');
    const text = await res.text();

    expect(text).toBe(jsonBody);
    expect(emittedEvents).toHaveLength(0);
  });

  it('captures text/event-stream responses while preserving page response readability', async () => {
    const sseBody = 'data: hello stream\n\ndata: second chunk\n\n';
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: hello stream\n\n'));
        controller.enqueue(encoder.encode('data: second chunk\n\n'));
        controller.close();
      },
    });

    window.fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })
    );

    uninstall = installFetchCapture({
      producerSessionId: 'test-session',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
    });

    const pageResponse = await window.fetch('https://chat.deepseek.com/api/v0/chat/completion');
    // Ensure the page can consume its own body completely and immediately
    const pageText = await pageResponse.text();
    expect(pageText).toBe(sseBody);

    // Wait microtask tick for async background clone drain
    await new Promise((r) => setTimeout(r, 50));

    // Verify emitted transport events
    expect(emittedEvents.length).toBeGreaterThanOrEqual(2);

    const openEvent = emittedEvents[0];
    expect(openEvent?.type).toBe('open');
    expect(openEvent?.streamSequence).toBe(0);
    expect(openEvent?.transport).toBe('fetch');
    expect(openEvent?.metadata?.contentType).toContain('text/event-stream');

    const terminalEvent = emittedEvents.at(-1);
    expect(terminalEvent?.type).toBe('complete');
    expect(terminalEvent?.streamSequence).toBe(emittedEvents.length - 1);

    // Verify streamSequence is strictly monotonic per stream
    for (let i = 0; i < emittedEvents.length; i++) {
      expect(emittedEvents[i]?.streamSequence).toBe(i);
    }

    // Aggregate chunk texts
    const chunkTexts = emittedEvents
      .filter((e) => e.type === 'chunk')
      .map((e) => e.chunkText)
      .join('');
    expect(chunkTexts).toBe(sseBody);
  });

  it('fails open without emitting open event if response.clone() throws', async () => {
    const mockResponse = new Response('data: body\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
    // Force clone to throw (e.g. locked body or security restriction)
    mockResponse.clone = () => {
      throw new Error('Clone restricted or already locked');
    };

    window.fetch = vi.fn().mockResolvedValue(mockResponse);

    uninstall = installFetchCapture({
      producerSessionId: 'test-session',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
    });

    const res = await window.fetch('https://chat.deepseek.com/api/v0/chat/stream');
    expect(res).toBe(mockResponse);
    expect(emittedEvents).toHaveLength(0); // Open event must NOT be emitted
  });

  it('fails open if clone reader fails, without disrupting caller fetch', async () => {
    // Create a response where cloning works, but reading clone throws
    const faultyStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: start\n\n'));
        controller.error(new Error('Simulated network disruption'));
      },
    });

    window.fetch = vi.fn().mockResolvedValue(
      new Response(faultyStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    uninstall = installFetchCapture({
      producerSessionId: 'test-session',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
    });

    // Caller fetch should resolve normally
    const res = await window.fetch('https://chat.deepseek.com/api/v0/chat/stream');
    expect(res).toBeDefined();

    await new Promise((r) => setTimeout(r, 50));

    // Terminal event must be abort
    const terminal = emittedEvents.at(-1);
    expect(terminal?.type).toBe('abort');
    expect(terminal?.reason).toContain('Simulated network disruption');
  });

  it('preserves surrogate pairs when splitting chunks across size boundaries', async () => {
    // Construct text where a 4-byte emoji sits exactly on the chunk boundary
    // e.g. 5 bytes text + 1 emoji (2 chars)
    const emoji = '🚀'; // length 2: \uD83D\uDE80
    const text = '1234' + emoji + 'tail'; // at maxChunkBytes = 5, cut would land on index 5 (between \uD83D and \uDE80)

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });

    window.fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    uninstall = installFetchCapture({
      producerSessionId: 'test-session',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
      maxChunkChars: 5,
    });

    await window.fetch('https://chat.deepseek.com/stream');
    await new Promise((r) => setTimeout(r, 50));

    const chunks = emittedEvents.filter((e) => e.type === 'chunk').map((e) => e.chunkText);
    expect(chunks.length).toBeGreaterThan(1);
    // Neither chunk should contain an unpaired surrogate
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/); // No lone low surrogate at start
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/); // No lone high surrogate at end
    }
    // Reassembled text must match original
    expect(chunks.join('')).toBe(text);
  });

  it('safely splits multiple consecutive emojis around chunk boundaries', async () => {
    // 3 emojis in a row: 6 code units. With chunk length 3, cuts will land inside surrogate pairs
    const emojis = '🚀🎉✨'; // 6 code units total
    const text = 'ab' + emojis + 'cd'; // 2 + 6 + 2 = 10 code units

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });

    window.fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    );

    uninstall = installFetchCapture({
      producerSessionId: 'test-session',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
      maxChunkChars: 3,
    });

    await window.fetch('https://chat.deepseek.com/stream');
    await new Promise((r) => setTimeout(r, 50));

    const chunks = emittedEvents.filter((e) => e.type === 'chunk').map((e) => e.chunkText);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('captures known candidate endpoints even if Content-Type is not yet text/event-stream', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: custom\n\n'));
        controller.close();
      },
    });

    // Content-Type is application/octet-stream (not standard SSE)
    window.fetch = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      })
    );

    uninstall = installFetchCapture({
      producerSessionId: 'test-session',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
      isCandidate: (meta) => meta.url.includes('/allowed-endpoint'),
    });

    // Ignored endpoint (non-SSE and not candidate)
    await window.fetch('https://chat.deepseek.com/ignored-endpoint');
    await new Promise((r) => setTimeout(r, 20));
    expect(emittedEvents).toHaveLength(0);

    // Allowed candidate endpoint (captured despite non-SSE content-type header)
    await window.fetch('https://chat.deepseek.com/allowed-endpoint');
    await new Promise((r) => setTimeout(r, 50));
    expect(emittedEvents.length).toBeGreaterThan(0);
  });

  it('propagates network fetch rejections directly to page caller', async () => {
    window.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    uninstall = installFetchCapture({
      producerSessionId: 'test-session',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
    });

    await expect(window.fetch('https://chat.deepseek.com/broken')).rejects.toThrow(
      'Failed to fetch'
    );
    expect(emittedEvents).toHaveLength(0);
  });
});
