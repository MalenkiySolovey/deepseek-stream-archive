import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installXhrCapture } from '../src/transport/xhr/capture';

describe('XHR Native Overload & Arguments Preservation', () => {
  let originalOpen: any;
  let originalSend: any;
  let recordedOpenCalls: any[][] = [];
  let recordedSendCalls: any[][] = [];
  let uninstall: () => void;

  beforeEach(() => {
    recordedOpenCalls = [];
    recordedSendCalls = [];

    // Mock native XMLHttpRequest prototype
    originalOpen = vi.fn(function (this: any, ...args: any[]) {
      recordedOpenCalls.push([...args]);
    });
    originalSend = vi.fn(function (this: any, ...args: any[]) {
      recordedSendCalls.push([...args]);
    });

    (globalThis as any).XMLHttpRequest = class MockXMLHttpRequest {
      readyState = 1;
      status = 200;
      responseType = '';
      responseText = '';
      addEventListener = vi.fn();
      removeEventListener = vi.fn();
      getResponseHeader = vi.fn(() => 'text/event-stream');
    };

    (globalThis as any).XMLHttpRequest.prototype.open = originalOpen;
    (globalThis as any).XMLHttpRequest.prototype.send = originalSend;

    uninstall = installXhrCapture({
      producerSessionId: 'prod-test',
      onEvent: () => {},
      nextSequence: () => 1,
    });
  });

  afterEach(() => {
    if (uninstall) uninstall();
  });

  it('preserves exact argument count on open(method, url) - 2 arguments', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('GET', '/api/test');

    expect(recordedOpenCalls.length).toBe(1);
    expect(recordedOpenCalls[0]?.length).toBe(2);
    expect(recordedOpenCalls[0]).toEqual(['GET', '/api/test']);
  });

  it('preserves exact argument count on open(method, url, false) - 3 arguments', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('POST', '/api/test', false);

    expect(recordedOpenCalls.length).toBe(1);
    expect(recordedOpenCalls[0]?.length).toBe(3);
    expect(recordedOpenCalls[0]).toEqual(['POST', '/api/test', false]);
  });

  it('preserves exact argument count on open(method, url, true, user, pass) - 5 arguments', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('GET', '/api/test', true, 'alice', 'secret');

    expect(recordedOpenCalls.length).toBe(1);
    expect(recordedOpenCalls[0]?.length).toBe(5);
    expect(recordedOpenCalls[0]).toEqual(['GET', '/api/test', true, 'alice', 'secret']);
  });

  it('preserves exact argument count on send() with 0 arguments', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('GET', '/api/test');
    xhr.send();

    expect(recordedSendCalls.length).toBe(1);
    expect(recordedSendCalls[0]?.length).toBe(0);
  });

  it('preserves exact argument count on send(null) with 1 argument', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('GET', '/api/test');
    xhr.send(null);

    expect(recordedSendCalls.length).toBe(1);
    expect(recordedSendCalls[0]?.length).toBe(1);
    expect(recordedSendCalls[0]?.[0]).toBeNull();
  });

  it('preserves exact argument count on send(body) with 1 argument', () => {
    const xhr = new (globalThis as any).XMLHttpRequest();
    xhr.open('POST', '/api/test');
    xhr.send('{"prompt":"hello"}');

    expect(recordedSendCalls.length).toBe(1);
    expect(recordedSendCalls[0]?.length).toBe(1);
    expect(recordedSendCalls[0]?.[0]).toBe('{"prompt":"hello"}');
  });
});
