import { describe, it, expect, vi } from 'vitest';
import { installXhrCapture } from '../src/transport/xhr/capture';
import { installFetchCapture } from '../src/transport/fetch/capture';
import type { TransportEvent } from '../src/transport/types';

describe('Transport Timing & Parentage Integrity Gate', () => {
  it('XHR: executes onRequest BEFORE onRequestMetadata ensuring clientTurnId is present in open event', () => {
    const callOrder: string[] = [];
    const bodyToTurnIdMap = new Map<unknown, string>();
    const emittedEvents: TransportEvent[] = [];

    // Mock XMLHttpRequest
    const originalXhr = (globalThis as any).XMLHttpRequest;
    class MockXhr {
      readyState = 0;
      status = 200;
      statusText = 'OK';
      responseType = '';
      responseText = 'data: {"test": true}\n\n';
      listeners = new Map<string, Function[]>();

      addEventListener(event: string, handler: Function) {
        if (!this.listeners.has(event)) {
          this.listeners.set(event, []);
        }
        this.listeners.get(event)!.push(handler);
      }

      getResponseHeader(name: string) {
        if (name.toLowerCase() === 'content-type') return 'text/event-stream';
        return null;
      }

      open(method: string, url: string) {
        this.readyState = 1;
      }

      send(body: any) {
        this.readyState = 3; // progress
        const progressHandlers = this.listeners.get('progress') || [];
        for (const h of progressHandlers) h();
        this.readyState = 4; // done
        const loadHandlers = this.listeners.get('load') || [];
        for (const h of loadHandlers) h();
      }
    }

    (globalThis as any).XMLHttpRequest = MockXhr;

    let seq = 0;
    const uninstall = installXhrCapture({
      producerSessionId: 'prod_xhr_test',
      nextSequence: () => ++seq,
      isCandidate: () => true,
      onEvent: (event) => {
        emittedEvents.push(event);
      },
      onRequest(ctx) {
        callOrder.push('onRequest');
        const generatedTurnId = 'turn_user_test_uuid_123';
        bodyToTurnIdMap.set(ctx.body, generatedTurnId);
        return undefined;
      },
      onRequestMetadata(ctx) {
        callOrder.push('onRequestMetadata');
        const clientTurnId = bodyToTurnIdMap.get(ctx.body);
        return {
          clientTurnId,
          requestPrompt: 'Hello DeepSeek',
        };
      },
    });

    try {
      const xhr = new (globalThis as any).XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion');
      const testBody = JSON.stringify({ prompt: 'Hello DeepSeek' });
      xhr.send(testBody);

      // Verify strict call order
      expect(callOrder).toEqual(['onRequest', 'onRequestMetadata']);

      // Verify clientTurnId was captured in 'open' transport event
      const openEvent = emittedEvents.find((e) => e.type === 'open');
      expect(openEvent).toBeDefined();
      expect(openEvent?.metadata?.clientTurnId).toBe('turn_user_test_uuid_123');
      expect(openEvent?.metadata?.requestPrompt).toBe('Hello DeepSeek');
    } finally {
      uninstall();
      (globalThis as any).XMLHttpRequest = originalXhr;
    }
  });

  it('Fetch: passes transformed body and maintains clientTurnId in open event metadata', async () => {
    const callOrder: string[] = [];
    const bodyToTurnIdMap = new Map<unknown, string>();
    const emittedEvents: TransportEvent[] = [];

    const originalFetch = globalThis.fetch;
    const mockFetch = vi.fn().mockImplementation(async (input, init) => {
      return new Response('data: {"test": true}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    globalThis.fetch = mockFetch;

    let seq = 0;
    const uninstall = installFetchCapture({
      producerSessionId: 'prod_fetch_test',
      nextSequence: () => ++seq,
      isCandidate: () => true,
      onEvent: (event) => {
        emittedEvents.push(event);
      },
      onRequest(input, init) {
        callOrder.push('onRequest');
        const generatedTurnId = 'turn_user_fetch_456';
        bodyToTurnIdMap.set(init?.body, generatedTurnId);
        return undefined;
      },
      onRequestMetadata(ctx) {
        callOrder.push('onRequestMetadata');
        const clientTurnId = bodyToTurnIdMap.get(ctx.body);
        return {
          clientTurnId,
          requestPrompt: 'Fetch prompt',
        };
      },
    });

    try {
      const body = JSON.stringify({ prompt: 'Fetch prompt' });
      await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        body,
      });

      expect(callOrder).toEqual(['onRequest', 'onRequestMetadata']);
      const openEvent = emittedEvents.find((e) => e.type === 'open');
      expect(openEvent).toBeDefined();
      expect(openEvent?.metadata?.clientTurnId).toBe('turn_user_fetch_456');
    } finally {
      uninstall();
      globalThis.fetch = originalFetch;
    }
  });
});
