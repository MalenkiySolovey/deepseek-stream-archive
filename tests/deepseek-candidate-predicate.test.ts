import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createDeepSeekCandidatePredicate,
  isDeepSeekGenerationEndpoint,
  normalizePathname,
} from '../src/adapters/deepseek/compatibility/candidate-policy';
import { installFetchCapture } from '../src/transport/fetch/capture';
import { installXhrCapture } from '../src/transport/xhr/capture';
import type { TransportEvent } from '../src/transport/types';

class MockXMLHttpRequest {
  readyState = 0;
  status = 0;
  statusText = '';
  responseText = '';
  responseType = '';
  responseURL = '';
  headers: Record<string, string> = {};
  private listeners: Record<string, (() => void)[]> = {};

  open(method: string, url: string) {
    this.readyState = 1;
    this.responseURL = url;
  }

  send(body?: any) {}

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

describe('DeepSeek Candidate Predicate & Transport Integration', () => {
  describe('createDeepSeekCandidatePredicate() logic', () => {
    const predicate = createDeepSeekCandidatePredicate();

    it('identifies generation endpoints regardless of content-type', () => {
      // Modern DeepSeek streams can return application/octet-stream or custom types
      expect(predicate({
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        method: 'POST',
        contentType: 'application/octet-stream',
      })).toBe(true);

      expect(predicate({
        url: 'https://chat.deepseek.com/api/v0/chat/edit_message',
        method: 'POST',
        contentType: 'application/json',
      })).toBe(true);

      expect(predicate({
        url: '/api/v0/chat/regenerate?session_id=123',
        method: 'POST',
        contentType: '',
      })).toBe(true);

      expect(predicate({
        url: '/api/v0/chat/continue',
        method: 'POST',
      })).toBe(true);

      expect(predicate({
        url: '/api/v0/chat/resume_stream',
        method: 'POST',
        contentType: 'text/plain',
      })).toBe(true);
    });

    it('rejects non-generation endpoints even if JSON or other content-type', () => {
      expect(predicate({
        url: 'https://chat.deepseek.com/api/v0/chat/history_messages',
        method: 'GET',
        contentType: 'application/json',
      })).toBe(false);

      expect(predicate({
        url: 'https://chat.deepseek.com/api/v0/users/current',
        method: 'GET',
        contentType: 'application/json',
      })).toBe(false);

      expect(predicate({
        url: 'https://chat.deepseek.com/static/bundle.js',
        method: 'GET',
      })).toBe(false);
    });
  });

  describe('Integration with installFetchCapture', () => {
    let originalWindow: any;
    let seq = 0;

    beforeEach(() => {
      seq = 0;
      originalWindow = (globalThis as any).window;
      (globalThis as any).window = globalThis;
    });

    afterEach(() => {
      (globalThis as any).window = originalWindow;
    });

    it('captures generation stream with application/octet-stream when using candidate predicate', async () => {
      const capturedEvents: TransportEvent[] = [];
      const predicate = createDeepSeekCandidatePredicate();

      // Mock fetch returning readable stream with octet-stream header
      const mockStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"p": "status", "v": "FINISHED"}\n\n'));
          controller.close();
        },
      });

      (globalThis as any).window.fetch = vi.fn().mockResolvedValue(
        new Response(mockStream, {
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      );

      const restore = installFetchCapture({
        producerSessionId: 'fetch-test-session',
        onEvent: (evt) => capturedEvents.push(evt),
        nextSequence: () => ++seq,
        isCandidate: predicate,
      });

      const response = await (globalThis as any).window.fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
      });

      // Read through response body
      const reader = response.body?.getReader();
      if (reader) {
        while (!(await reader.read()).done) {}
      }

      restore();

      const openEvent = capturedEvents.find((e) => e.type === 'open');
      expect(openEvent).toBeDefined();
      expect(openEvent?.metadata?.url).toBe('https://chat.deepseek.com/api/v0/chat/completion');
      expect(openEvent?.metadata?.contentType).toBe('application/octet-stream');

      const chunkEvent = capturedEvents.find((e) => e.type === 'chunk');
      expect(chunkEvent).toBeDefined();
      expect(chunkEvent?.chunkText).toContain('FINISHED');
    });
  });

  describe('Integration with installXhrCapture', () => {
    let originalXhr: any;
    let seq = 0;

    beforeEach(() => {
      seq = 0;
      originalXhr = (globalThis as any).XMLHttpRequest;
      (globalThis as any).XMLHttpRequest = MockXMLHttpRequest;
    });

    afterEach(() => {
      (globalThis as any).XMLHttpRequest = originalXhr;
    });

    it('captures generation XHR with application/octet-stream when using candidate predicate', () => {
      const capturedEvents: TransportEvent[] = [];
      const predicate = createDeepSeekCandidatePredicate();

      const restore = installXhrCapture({
        producerSessionId: 'xhr-test-session',
        onEvent: (evt) => capturedEvents.push(evt),
        nextSequence: () => ++seq,
        isCandidate: predicate,
      });

      const xhr = new (globalThis as any).XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion');
      xhr.setRequestHeader('Content-Type', 'application/json');
      (xhr as any).headers['content-type'] = 'application/octet-stream';
      xhr.send('{}');

      // Set response status and initial chunk
      xhr.status = 200;
      xhr.statusText = 'OK';
      xhr.readyState = 3;
      xhr.responseText = 'data: {"p": "status", "v": "WIP"}\n\n';

      xhr.trigger('readystatechange');
      xhr.trigger('progress');

      // Complete
      xhr.readyState = 4;
      xhr.trigger('readystatechange');
      xhr.trigger('load');

      restore();

      const openEvent = capturedEvents.find((e) => e.type === 'open');
      expect(openEvent).toBeDefined();
      expect(openEvent?.transport).toBe('xhr');
      expect(openEvent?.metadata?.url).toBe('https://chat.deepseek.com/api/v0/chat/completion');

      const chunkEvent = capturedEvents.find((e) => e.type === 'chunk');
      expect(chunkEvent).toBeDefined();
      expect(chunkEvent?.chunkText).toContain('WIP');
    });
  });
});
