import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installXhrCapture } from '../src/transport/xhr/capture';
import { installFetchCapture } from '../src/transport/fetch/capture';

describe('Interceptor Double-Patch Protection', () => {
  let originalFetch: any;
  let originalOpen: any;
  let originalSend: any;
  let cleanups: (() => void)[] = [];

  beforeEach(() => {
    cleanups = [];

    // Mock Fetch
    originalFetch = vi.fn().mockResolvedValue(new Response('ok'));
    (globalThis as any).fetch = originalFetch;

    // Mock XHR
    originalOpen = vi.fn();
    originalSend = vi.fn();
    (globalThis as any).XMLHttpRequest = class MockXHR {
      open = originalOpen;
      send = originalSend;
    };
    (globalThis as any).XMLHttpRequest.prototype.open = originalOpen;
    (globalThis as any).XMLHttpRequest.prototype.send = originalSend;
  });

  afterEach(() => {
    for (const fn of cleanups) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
  });

  it('prevents installFetchCapture from wrapping fetch twice', () => {
    const uninst1 = installFetchCapture({
      producerSessionId: 'sess-1',
      onEvent: () => {},
      nextSequence: () => 1,
    });
    cleanups.push(uninst1);

    const wrappedFetch1 = (globalThis as any).fetch;
    expect(wrappedFetch1).not.toBe(originalFetch);

    // Call installFetchCapture a second time
    const uninst2 = installFetchCapture({
      producerSessionId: 'sess-2',
      onEvent: () => {},
      nextSequence: () => 2,
    });
    cleanups.push(uninst2);

    const wrappedFetch2 = (globalThis as any).fetch;
    // Must remain the exact same wrapped function, not wrapped a second time!
    expect(wrappedFetch2).toBe(wrappedFetch1);
  });

  it('prevents installXhrCapture from wrapping XHR methods twice', () => {
    const uninst1 = installXhrCapture({
      producerSessionId: 'sess-1',
      onEvent: () => {},
      nextSequence: () => 1,
    });
    cleanups.push(uninst1);

    const wrappedOpen1 = (globalThis as any).XMLHttpRequest.prototype.open;
    const wrappedSend1 = (globalThis as any).XMLHttpRequest.prototype.send;
    expect(wrappedOpen1).not.toBe(originalOpen);
    expect(wrappedSend1).not.toBe(originalSend);

    // Call installXhrCapture a second time
    const uninst2 = installXhrCapture({
      producerSessionId: 'sess-2',
      onEvent: () => {},
      nextSequence: () => 2,
    });
    cleanups.push(uninst2);

    const wrappedOpen2 = (globalThis as any).XMLHttpRequest.prototype.open;
    const wrappedSend2 = (globalThis as any).XMLHttpRequest.prototype.send;

    // Must remain the exact same wrapped functions!
    expect(wrappedOpen2).toBe(wrappedOpen1);
    expect(wrappedSend2).toBe(wrappedSend1);
  });
});
