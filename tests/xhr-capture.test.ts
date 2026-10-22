import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { installXhrCapture } from '../src/transport/xhr/capture';
import type { TransportEvent } from '../src/transport/types';

// Mock minimal XMLHttpRequest implementation for Node environment
class MockXMLHttpRequest {
  public readyState = 0;
  public status = 0;
  public statusText = '';
  public responseText = '';
  public responseType: XMLHttpRequestResponseType = '';
  public headers: Record<string, string> = {};
  public listeners: Record<string, Array<() => void>> = {};

  open(method: string, url: string) {
    this.readyState = 1;
  }

  send(body?: any) {
    // will be simulated by tests
  }

  setRequestHeader(header: string, value: string) {
    this.headers[header.toLowerCase()] = value;
  }

  getResponseHeader(header: string): string | null {
    return this.headers[header.toLowerCase()] ?? null;
  }

  addEventListener(type: string, listener: () => void) {
    if (!this.listeners[type]) {
      this.listeners[type] = [];
    }
    this.listeners[type]?.push(listener);
  }

  trigger(type: string) {
    const list = this.listeners[type] || [];
    for (const fn of [...list]) {
      fn();
    }
  }
}

describe('XMLHttpRequest Passive Capture Tap', () => {
  let uninstall: () => void = () => {};
  let emittedEvents: TransportEvent[] = [];
  let seq = 0;
  let originalXhr: any;

  beforeEach(() => {
    emittedEvents = [];
    seq = 0;
    originalXhr = (globalThis as any).XMLHttpRequest;
    (globalThis as any).XMLHttpRequest = MockXMLHttpRequest;

    uninstall = installXhrCapture({
      producerSessionId: 'xhr-session',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
    });
  });

  afterEach(() => {
    uninstall();
    (globalThis as any).XMLHttpRequest = originalXhr;
  });

  it('progressively extracts responseText deltas with monotonic streamSequence', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat');
    xhr.headers['content-type'] = 'text/event-stream';
    xhr.send('{}');

    xhr.readyState = 3;
    xhr.status = 200;

    // Simulate chunk 1
    xhr.responseText = 'data: first\n\n';
    xhr.trigger('readystatechange');
    xhr.trigger('progress');

    // Simulate chunk 2
    xhr.responseText = 'data: first\n\ndata: second\n\n';
    xhr.trigger('progress');

    // Simulate stream completion
    xhr.readyState = 4;
    xhr.trigger('readystatechange');
    xhr.trigger('load');

    expect(emittedEvents.length).toBeGreaterThanOrEqual(3);

    const openEvt = emittedEvents[0];
    expect(openEvt?.type).toBe('open');
    expect(openEvt?.streamSequence).toBe(0);
    expect(openEvt?.transport).toBe('xhr');

    const chunks = emittedEvents.filter((e) => e.type === 'chunk');
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.chunkText).toBe('data: first\n\n');
    expect(chunks[0]?.streamSequence).toBe(1);
    expect(chunks[1]?.chunkText).toBe('data: second\n\n');
    expect(chunks[1]?.streamSequence).toBe(2);

    const terminalEvt = emittedEvents.at(-1);
    expect(terminalEvt?.type).toBe('complete');
    expect(terminalEvt?.streamSequence).toBe(3);
  });

  it('handles XHR instance reuse safely without duplicate listeners or chunk doubling', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();

    // Call 1
    xhr.open('POST', 'https://chat.deepseek.com/stream-1');
    xhr.headers['content-type'] = 'text/event-stream';
    xhr.send();
    xhr.readyState = 3;
    xhr.status = 200;
    xhr.responseText = 'chunk1';
    xhr.trigger('progress');
    xhr.readyState = 4;
    xhr.trigger('load');

    const firstEventsCount = emittedEvents.length;
    expect(firstEventsCount).toBeGreaterThan(0);

    // Call 2 on same XHR instance
    xhr.open('POST', 'https://chat.deepseek.com/stream-2');
    xhr.headers['content-type'] = 'text/event-stream';
    xhr.send();
    xhr.readyState = 3;
    xhr.status = 200;
    xhr.responseText = 'chunk2';
    xhr.trigger('progress');
    xhr.readyState = 4;
    xhr.trigger('load');

    const secondEvents = emittedEvents.slice(firstEventsCount);
    const secondChunks = secondEvents.filter((e) => e.type === 'chunk');
    // Exactly 1 chunk emitted for the second call, not duplicated
    expect(secondChunks).toHaveLength(1);
    expect(secondChunks[0]?.chunkText).toBe('chunk2');
  });

  it('ignores non-SSE XHR traffic completely', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('GET', 'https://chat.deepseek.com/api/v0/profile');
    xhr.headers['content-type'] = 'application/json';
    xhr.send();

    xhr.readyState = 3;
    xhr.status = 200;
    xhr.responseText = '{"user": "test"}';
    xhr.trigger('progress');

    xhr.readyState = 4;
    xhr.trigger('readystatechange');
    xhr.trigger('load');

    expect(emittedEvents).toHaveLength(0);
  });

  it('ignores unsupported responseTypes such as blob', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('GET', 'https://chat.deepseek.com/stream');
    xhr.headers['content-type'] = 'text/event-stream';
    xhr.responseType = 'blob';
    xhr.send();

    xhr.readyState = 3;
    xhr.status = 200;
    xhr.trigger('progress');

    expect(emittedEvents).toHaveLength(0);
  });

  it('splits long responseText using maxChunkChars without cutting emojis', () => {
    uninstall();
    uninstall = installXhrCapture({
      producerSessionId: 'xhr-session-chunk',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
      maxChunkChars: 4,
    });

    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('POST', 'https://chat.deepseek.com/stream');
    xhr.headers['content-type'] = 'text/event-stream';
    xhr.send();

    xhr.readyState = 3;
    xhr.status = 200;
    xhr.responseText = 'ab' + '🚀🎉' + 'cd';
    xhr.trigger('progress');

    const chunks = emittedEvents.filter((e) => e.type === 'chunk').map((e) => e.chunkText);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
    }
    expect(chunks.join('')).toBe('ab🚀🎉cd');
  });

  it('captures known candidate endpoint even if content-type is non-standard', () => {
    uninstall();
    uninstall = installXhrCapture({
      producerSessionId: 'xhr-candidate-test',
      onEvent: (evt) => emittedEvents.push(evt),
      nextSequence: () => ++seq,
      isCandidate: (meta) => meta.url.includes('/api/v0/chat/completion'),
    });

    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion');
    xhr.headers['content-type'] = 'application/octet-stream';
    xhr.send();

    xhr.readyState = 3;
    xhr.status = 200;
    xhr.responseText = 'data: custom\n\n';
    xhr.trigger('progress');

    expect(emittedEvents.length).toBeGreaterThan(0);
    expect(emittedEvents[0]?.type).toBe('open');
  });
});
