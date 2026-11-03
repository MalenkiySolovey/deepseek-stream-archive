import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installFetchCapture } from '../src/transport/fetch/capture';
import { installXhrCapture } from '../src/transport/xhr/capture';
import { saveContextContinuitySettings } from '../src/context-continuity/settings';
import { buildContextContinuityPlan } from '../src/context-continuity/planner';
import type { Message, ResponseRevision, RecoveryEvent } from '../src/core/models';

describe('Passive Transport Byte-Identity Invariant (Milestone 2D.5A)', () => {
  let uninstallFetch: () => void = () => {};
  let uninstallXhr: () => void = () => {};
  let originalGlobalWindow: any;

  beforeEach(() => {
    originalGlobalWindow = (globalThis as any).window;
    (globalThis as any).window = globalThis;
  });

  afterEach(() => {
    uninstallFetch();
    uninstallXhr();
    (globalThis as any).window = originalGlobalWindow;
    vi.restoreAllMocks();
  });

  describe('Fetch Request Byte-Identity Proof (Section 90)', () => {
    it('preserves exact byte-for-byte body with Context Continuity OFF', async () => {
      const originalFetch = vi.fn().mockImplementation((input, init) => {
        return Promise.resolve(new Response('data: test\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }));
      });
      window.fetch = originalFetch;

      uninstallFetch = installFetchCapture({
        producerSessionId: 'sess-identity-1',
        onEvent: () => {},
        nextSequence: () => 1,
      });

      const ORIGINAL_BODY = JSON.stringify({
        chat_session_id: 'session-alpha',
        prompt: 'Explain quantum computing in detail.',
        model: 'deepseek-chat',
      });

      await window.fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: ORIGINAL_BODY,
      });

      expect(originalFetch).toHaveBeenCalledTimes(1);
      const [, passedInit] = originalFetch.mock.calls[0]!;
      expect(passedInit.body).toBe(ORIGINAL_BODY);
      expect(typeof passedInit.body).toBe('string');
      expect(passedInit.body).toHaveLength(ORIGINAL_BODY.length);
    });

    it('preserves exact byte-for-byte body with Context Continuity ON and plan prepared', async () => {
      // 1. Configure settings ON
      await saveContextContinuitySettings({ enabled: true, includeThinking: true });

      // 2. Prepare an active continuity plan
      const testMsg: Message = {
        id: 'msg-rec-1',
        conversationId: 'conv-1',
        role: 'assistant',
        status: 'filtered',
        identityState: 'provisional',
        projectionState: 'logical',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const testRev: ResponseRevision = {
        id: 'rev-1',
        messageId: 'msg-rec-1',
        revisionIndex: 0,
        text: 'Locally preserved assistant text that should remain completely local.',
        source: 'network',
        capturedAt: 1000,
        isFinal: true,
        isLastGood: true,
      };
      const testPlan = buildContextContinuityPlan({
        conversationId: 'conv-1',
        messages: [testMsg],
        revisionsMap: new Map([[testMsg.id, [testRev]]]),
        settings: { enabled: true, includeThinking: true },
      });
      expect(testPlan.eligibleBlockCount).toBe(1);
      expect(testPlan.formattedPreview.length).toBeGreaterThan(0);

      // 3. Install fetch tap
      const originalFetch = vi.fn().mockImplementation((input, init) => {
        return Promise.resolve(new Response('data: test\n\n', {
          headers: { 'content-type': 'text/event-stream' },
        }));
      });
      window.fetch = originalFetch;

      uninstallFetch = installFetchCapture({
        producerSessionId: 'sess-identity-2',
        onEvent: () => {},
        nextSequence: () => 1,
      });

      const ORIGINAL_BODY = JSON.stringify({
        chat_session_id: 'session-alpha',
        prompt: 'User next prompt without any context augmentation',
        stream: true,
      });

      // 4. Execute fetch
      await window.fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: ORIGINAL_BODY,
      });

      // 5. Invariant Assertion: native fetch MUST receive the exact untouched body
      expect(originalFetch).toHaveBeenCalledTimes(1);
      const [, passedInit] = originalFetch.mock.calls[0]!;
      expect(passedInit.body).toBe(ORIGINAL_BODY);
      expect(passedInit.body).not.toContain('StreamArchive');
      expect(passedInit.body).not.toContain('Locally preserved assistant text');
    });

    it('preserves exact ArrayBuffer and binary payload representation', async () => {
      const originalFetch = vi.fn().mockResolvedValue(new Response('ok'));
      window.fetch = originalFetch;

      uninstallFetch = installFetchCapture({
        producerSessionId: 'sess-binary',
        onEvent: () => {},
        nextSequence: () => 1,
      });

      const binaryData = new Uint8Array([0x01, 0x02, 0x03, 0xff, 0xfe]);

      await window.fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        body: binaryData,
      });

      expect(originalFetch).toHaveBeenCalledTimes(1);
      const [, passedInit] = originalFetch.mock.calls[0]!;
      expect(passedInit.body).toBe(binaryData);
    });
  });

  describe('XHR Request Byte-Identity Proof (Section 91)', () => {
    it('preserves exact unmodified string argument to native xhr.send', async () => {
      const nativeSend = vi.fn();
      const nativeOpen = vi.fn();

      class MockXHR {
        open = nativeOpen;
        send = nativeSend;
        setRequestHeader = vi.fn();
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
        getResponseHeader = vi.fn();
      }

      (window as any).XMLHttpRequest = MockXHR;

      uninstallXhr = installXhrCapture({
        producerSessionId: 'xhr-identity-1',
        onEvent: () => {},
        nextSequence: () => 1,
      });

      const ORIGINAL_BODY = JSON.stringify({
        chat_session_id: 'session-xhr',
        message: 'Original XHR message body',
      });

      const xhr = new (window as any).XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion');
      xhr.send(ORIGINAL_BODY);

      expect(nativeSend).toHaveBeenCalledTimes(1);
      expect(nativeSend).toHaveBeenCalledWith(ORIGINAL_BODY);
      expect(nativeSend.mock.calls[0]![0]).toBe(ORIGINAL_BODY);
    });

    it('preserves null or undefined argument to native xhr.send without coercion', async () => {
      const nativeSend = vi.fn();

      class MockXHR {
        open = vi.fn();
        send = nativeSend;
        setRequestHeader = vi.fn();
        addEventListener = vi.fn();
        removeEventListener = vi.fn();
        getResponseHeader = vi.fn();
      }

      (window as any).XMLHttpRequest = MockXHR;

      uninstallXhr = installXhrCapture({
        producerSessionId: 'xhr-identity-2',
        onEvent: () => {},
        nextSequence: () => 1,
      });

      const xhr = new (window as any).XMLHttpRequest();
      xhr.open('GET', 'https://chat.deepseek.com/api/v0/chat/history_messages');
      xhr.send(null);

      expect(nativeSend).toHaveBeenCalledTimes(1);
      expect(nativeSend).toHaveBeenCalledWith(null);
    });
  });
});
