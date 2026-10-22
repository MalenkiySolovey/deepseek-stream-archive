import type { RequestCandidateMetadata, TransportEvent, TransportMetadata } from '../types';
import { sanitizeUrl } from '../types';
import type { TransportEventEmitter } from '../fetch/capture';
import { splitSafeUtf16 } from '../safe-slice';

export interface XhrCaptureOptions {
  producerSessionId: string;
  onEvent: TransportEventEmitter;
  nextSequence: () => number;
  maxChunkChars?: number;
  isCandidate?: (metadata: RequestCandidateMetadata) => boolean;
  onHistoryObservation?: (observation: { url: string; status: number; body: string }) => void;
  isHistoryCandidate?: (url: string) => boolean;
}

interface XhrCaptureState {
  active: boolean;
  streamId: string | null;
  lastSeenLength: number;
  terminalEmitted: boolean;
  listenersAttached: boolean;
  metadata?: TransportMetadata;
  streamSequence: number;
  rawUrl?: string;
  historyObserved?: boolean;
}

const DEFAULT_MAX_CHUNK_CHARS = 64 * 1024; // 64K characters limit
const XHR_HOOK_INSTALLED = Symbol.for('streamarchive.xhr.installed');

/**
 * Installs a passive XMLHttpRequest observer.
 * - Does NOT redefine responseText getter or mutate DOM instances with enumerable properties.
 * - Tracks state cleanly via WeakMap<XMLHttpRequest, XhrCaptureState>.
 * - Prevents listener duplication and chunk doubling on XHR reuse.
 * - Progressively extracts new text via offset slicing (lastSeenLength).
 * - Monotonically increments streamSequence per stream.
 * - Preserves native function signatures and lifecycle via Reflect.apply.
 */
export function installXhrCapture(options: XhrCaptureOptions): () => void {
  if (typeof XMLHttpRequest === 'undefined' || !XMLHttpRequest.prototype) {
    return () => {};
  }

  if ((XMLHttpRequest.prototype as any)[XHR_HOOK_INSTALLED]) {
    return () => {};
  }
  (XMLHttpRequest.prototype as any)[XHR_HOOK_INSTALLED] = true;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  const {
    producerSessionId,
    onEvent,
    nextSequence,
    maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
    isCandidate: customIsCandidate,
  } = options;

  const xhrStateMap = new WeakMap<XMLHttpRequest, XhrCaptureState>();

  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, ...args: any[]) {
    const method = String(args[0] || 'GET');
    const url = args[1];

    const existing = xhrStateMap.get(this);
    const state: XhrCaptureState = existing || {
      active: false,
      streamId: null,
      lastSeenLength: 0,
      terminalEmitted: false,
      listenersAttached: false,
      streamSequence: 0,
    };

    // Reset stream state on open() for reuse safety
    state.active = false;
    state.streamId = null;
    state.lastSeenLength = 0;
    state.terminalEmitted = false;
    state.streamSequence = 0;
    state.rawUrl = typeof url === 'string' ? url : url?.toString() || '';
    state.historyObserved = false;
    state.metadata = {
      method: (method || 'GET').toUpperCase(),
      url: sanitizeUrl(state.rawUrl || ''),
    };

    xhrStateMap.set(this, state);

    return Reflect.apply(originalOpen, this, args);
  };

  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: any[]) {
    const xhr = this;
    const state = xhrStateMap.get(xhr) || {
      active: false,
      streamId: null,
      lastSeenLength: 0,
      terminalEmitted: false,
      listenersAttached: false,
      streamSequence: 0,
    };
    xhrStateMap.set(xhr, state);

    const checkCandidate = (): boolean => {
      try {
        if (xhr.readyState < 2) return false;
        const responseType = xhr.responseType;
        if (responseType !== '' && responseType !== 'text') {
          return false;
        }
        const contentType = xhr.getResponseHeader('content-type') || '';
        const isSse = contentType.toLowerCase().includes('text/event-stream');

        const isKnownCandidate = customIsCandidate
          ? customIsCandidate({
              url: state.metadata?.url || '',
              method: state.metadata?.method || 'GET',
              contentType,
            })
          : false;

        return isSse || isKnownCandidate;
      } catch {
        return false;
      }
    };

    const handleProgress = () => {
      try {
        if (!checkCandidate()) return;

        // Initialize stream on first verified candidate chunk
        if (!state.active) {
          state.active = true;
          state.streamId =
            typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : `xhr_stream_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

          const meta: TransportMetadata = {
            method: state.metadata?.method || 'GET',
            url: state.metadata?.url || 'http://localhost',
            status: xhr.status,
            statusText: xhr.statusText,
            contentType: xhr.getResponseHeader('content-type') || 'text/event-stream',
          };

          onEvent({
            producerSessionId,
            streamId: state.streamId,
            sequence: nextSequence(),
            streamSequence: state.streamSequence++,
            timestamp: Date.now(),
            transport: 'xhr',
            type: 'open',
            metadata: meta,
          });
        }

        // Incremental slicing of responseText
        const currentText: string = xhr.responseText || '';
        const lastLength = state.lastSeenLength;

        if (currentText.length > lastLength && state.streamId) {
          const delta = currentText.slice(lastLength);
          state.lastSeenLength = currentText.length;

          state.streamSequence = emitXhrChunkSafe(
            delta,
            state.streamId,
            producerSessionId,
            onEvent,
            nextSequence,
            maxChunkChars,
            state.streamSequence
          );
        }
      } catch {
        // Fail-open: ignore capture exceptions
      }
    };

    const handleTerminal = (type: 'complete' | 'abort' | 'error', reason?: string) => {
      if (!state.active || state.terminalEmitted || !state.streamId) return;
      state.terminalEmitted = true;

      // Final slice check
      try {
        const currentText: string = xhr.responseText || '';
        const lastLength = state.lastSeenLength;
        if (currentText.length > lastLength) {
          const delta = currentText.slice(lastLength);
          state.lastSeenLength = currentText.length;
          state.streamSequence = emitXhrChunkSafe(
            delta,
            state.streamId,
            producerSessionId,
            onEvent,
            nextSequence,
            maxChunkChars,
            state.streamSequence
          );
        }
      } catch {
        // ignore
      }

      onEvent({
        producerSessionId,
        streamId: state.streamId,
        sequence: nextSequence(),
        streamSequence: state.streamSequence++,
        timestamp: Date.now(),
        transport: 'xhr',
        type,
        reason,
      });
    };

    // Attach passive event listeners strictly once per XHR instance
    if (!state.listenersAttached) {
      state.listenersAttached = true;

      const checkHistory = () => {
        if (state.historyObserved) return;
        if (
          options.onHistoryObservation &&
          options.isHistoryCandidate &&
          state.rawUrl &&
          options.isHistoryCandidate(state.rawUrl)
        ) {
          if (xhr.status === 200) {
            state.historyObserved = true;
            try {
              const responseType = xhr.responseType;
              if (responseType === '' || responseType === 'text') {
                const body = typeof xhr.responseText === 'string' ? xhr.responseText : '';
                if (body.length > 0) {
                  options.onHistoryObservation({
                    url: state.rawUrl,
                    status: xhr.status,
                    body,
                  });
                }
              }
            } catch {
              // fail-open
            }
          }
        }
      };

      try {
        xhr.addEventListener('readystatechange', () => {
          handleProgress();
          if (xhr.readyState === 4) {
            checkHistory();
            if (xhr.status >= 200 && xhr.status < 300) {
              handleTerminal('complete');
            } else if (xhr.status > 0) {
              handleTerminal('error', `HTTP ${xhr.status}`);
            }
          }
        });
        xhr.addEventListener('progress', handleProgress);
        xhr.addEventListener('load', () => {
          checkHistory();
          handleTerminal('complete');
        });
        xhr.addEventListener('abort', () => handleTerminal('abort', 'User aborted'));
        xhr.addEventListener('error', () => handleTerminal('error', 'Network error'));
      } catch {
        // Fail-open
      }
    }

    return Reflect.apply(originalSend, this, args);
  };

  return () => {
    delete (XMLHttpRequest.prototype as any)[XHR_HOOK_INSTALLED];
    XMLHttpRequest.prototype.open = originalOpen;
    XMLHttpRequest.prototype.send = originalSend;
  };
}

function emitXhrChunkSafe(
  text: string,
  streamId: string,
  producerSessionId: string,
  onEvent: TransportEventEmitter,
  nextSequence: () => number,
  maxChunkChars: number,
  currentStreamSeq: number
): number {
  let seq = currentStreamSeq;
  const chunks = splitSafeUtf16(text, maxChunkChars);

  for (const chunk of chunks) {
    onEvent({
      producerSessionId,
      streamId,
      sequence: nextSequence(),
      streamSequence: seq++,
      timestamp: Date.now(),
      transport: 'xhr',
      type: 'chunk',
      chunkText: chunk,
    });
  }

  return seq;
}
