import type { RequestCandidateMetadata, TransportEvent, TransportMetadata } from '../types';
import { sanitizeUrl } from '../types';
import { Utf8StreamDecoder } from '../utf8/decoder';
import { splitSafeUtf16 } from '../safe-slice';

export type TransportEventEmitter = (event: TransportEvent) => void;

export type HistoryStreamCaptureEvent =
  | { type: 'open'; historyId: string; url: string; status: number; timestamp: number }
  | { type: 'chunk'; historyId: string; chunkIndex: number; chunkText: string }
  | { type: 'complete'; historyId: string; totalChars: number; timestamp: number }
  | { type: 'abort'; historyId: string; reason: string };

export interface FetchCaptureOptions {
  producerSessionId: string;
  onEvent: TransportEventEmitter;
  nextSequence: () => number;
  maxChunkChars?: number;
  isCandidate?: (metadata: RequestCandidateMetadata) => boolean;
  onHistoryObservation?: (observation: { url: string; status: number; body: string }) => void;
  onHistoryStreamEvent?: (event: HistoryStreamCaptureEvent) => void;
  isHistoryCandidate?: (url: string) => boolean;
}

const DEFAULT_MAX_CHUNK_CHARS = 64 * 1024; // 64K characters safeguard limit
const FETCH_HOOK_INSTALLED = Symbol.for('streamarchive.fetch.installed');

/**
 * Installs a passive window.fetch observer.
 * - Captures if response is standard text/event-stream OR custom candidate predicate matches.
 * - Synchronously clones response body, returning original Response immediately to the page.
 * - Emits 'open' ONLY after response.clone() succeeds.
 * - Monotonically advances streamSequence per stream.
 * - Safe UTF-16 chunk splitting prevents cutting surrogate pairs.
 * - Fail-open: internal capture issues never reject or disrupt page-side fetch.
 */
export function installFetchCapture(options: FetchCaptureOptions): () => void {
  const target = typeof window !== 'undefined' ? window : (globalThis as unknown as Window & typeof globalThis);
  const originalFetch = target.fetch;
  if (!originalFetch) {
    return () => {};
  }

  if ((target as any)[FETCH_HOOK_INSTALLED]) {
    return () => {};
  }
  (target as any)[FETCH_HOOK_INSTALLED] = true;

  const {
    producerSessionId,
    onEvent,
    nextSequence,
    maxChunkChars = DEFAULT_MAX_CHUNK_CHARS,
    isCandidate: customIsCandidate,
  } = options;

  target.fetch = async function (
    this: any,
    ...args: any[]
  ): Promise<Response> {
    // Invoke original fetch preserving this and arguments
    const response = await (originalFetch as Function).apply(this, args);
    const input = args[0];
    const init = args[1];

    try {
      const contentType = response.headers.get('content-type') || '';
      const method = (init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
      const rawUrl = typeof input === 'string' ? input : 'url' in input ? input.url : input.toString();

      const isSse = contentType.toLowerCase().includes('text/event-stream');
      const isKnownCandidate = customIsCandidate
        ? customIsCandidate({ url: rawUrl, method, contentType })
        : false;

      // Passive history observation (cloning without mutating response to page)
      const hasHistoryObserver = Boolean(options.onHistoryStreamEvent || options.onHistoryObservation);
      if (hasHistoryObserver && options.isHistoryCandidate && options.isHistoryCandidate(rawUrl)) {
        if (response.status === 200 && response.body) {
          try {
            const histClone = response.clone();
            const historyId =
              typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `hist_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

            if (histClone.body && typeof histClone.body.getReader === 'function') {
              const reader = histClone.body.getReader();
              const decoder = new TextDecoder('utf-8');
              const MAX_HISTORY_BYTES = 25 * 1024 * 1024;
              let totalBytes = 0;
              let totalChars = 0;
              let chunkIndex = 0;
              let accumulatedText = options.onHistoryObservation ? '' : undefined;

              if (options.onHistoryStreamEvent) {
                options.onHistoryStreamEvent({
                  type: 'open',
                  historyId,
                  url: rawUrl,
                  status: response.status,
                  timestamp: Date.now(),
                });
              }

              (async () => {
                try {
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) {
                      totalBytes += value.byteLength;
                      if (totalBytes > MAX_HISTORY_BYTES) {
                        try {
                          await reader.cancel();
                        } catch {
                          // ignore
                        }
                        if (options.onHistoryStreamEvent) {
                          options.onHistoryStreamEvent({
                            type: 'abort',
                            historyId,
                            reason: 'max_bytes_exceeded',
                          });
                        }
                        return;
                      }
                      const chunkText = decoder.decode(value, { stream: true });
                      if (chunkText.length > 0) {
                        totalChars += chunkText.length;
                        if (options.onHistoryStreamEvent) {
                          options.onHistoryStreamEvent({
                            type: 'chunk',
                            historyId,
                            chunkIndex: chunkIndex++,
                            chunkText,
                          });
                        }
                        if (accumulatedText !== undefined) {
                          accumulatedText += chunkText;
                        }
                      }
                    }
                  }
                  const finalTail = decoder.decode();
                  if (finalTail.length > 0) {
                    totalChars += finalTail.length;
                    if (options.onHistoryStreamEvent) {
                      options.onHistoryStreamEvent({
                        type: 'chunk',
                        historyId,
                        chunkIndex: chunkIndex++,
                        chunkText: finalTail,
                      });
                    }
                    if (accumulatedText !== undefined) {
                      accumulatedText += finalTail;
                    }
                  }

                  if (options.onHistoryStreamEvent) {
                    options.onHistoryStreamEvent({
                      type: 'complete',
                      historyId,
                      totalChars,
                      timestamp: Date.now(),
                    });
                  }

                  if (options.onHistoryObservation && accumulatedText !== undefined) {
                    options.onHistoryObservation({
                      url: rawUrl,
                      status: response.status,
                      body: accumulatedText,
                    });
                  }
                } catch {
                  // fail-open
                }
              })().catch(() => {});
            } else {
              histClone.text().then((bodyText: string) => {
                if (options.onHistoryStreamEvent) {
                  options.onHistoryStreamEvent({
                    type: 'open',
                    historyId,
                    url: rawUrl,
                    status: response.status,
                    timestamp: Date.now(),
                  });
                  options.onHistoryStreamEvent({
                    type: 'chunk',
                    historyId,
                    chunkIndex: 0,
                    chunkText: bodyText,
                  });
                  options.onHistoryStreamEvent({
                    type: 'complete',
                    historyId,
                    totalChars: bodyText.length,
                    timestamp: Date.now(),
                  });
                }
                if (options.onHistoryObservation) {
                  options.onHistoryObservation({
                    url: rawUrl,
                    status: response.status,
                    body: bodyText,
                  });
                }
              }).catch(() => {});
            }
          } catch {
            // fail-open
          }
        }
      }

      // Capture if standard SSE OR marked as candidate endpoint
      const shouldCapture = isSse || isKnownCandidate;

      if (!shouldCapture || !response.body) {
        return response;
      }

      // 1. Clone response synchronously before emitting any events
      let clone: Response;
      try {
        clone = response.clone();
      } catch {
        // If clone fails (e.g. body already locked/used), fail-open gracefully WITHOUT emitting open event
        return response;
      }

      // 2. Generate local collision-safe stream identity and track per-stream sequence
      const streamId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `stream_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      let currentStreamSeq = 0;

      const metadata: TransportMetadata = {
        method,
        url: sanitizeUrl(rawUrl),
        status: response.status,
        statusText: response.statusText,
        contentType,
      };

      // 3. Emit stream 'open' event only after clone succeeded
      onEvent({
        producerSessionId,
        streamId,
        sequence: nextSequence(),
        streamSequence: currentStreamSeq++,
        timestamp: Date.now(),
        transport: 'fetch',
        type: 'open',
        metadata,
      });

      // 4. Asynchronously drain cloned body in background without blocking caller
      consumeClonedSseBody(
        clone,
        streamId,
        producerSessionId,
        onEvent,
        nextSequence,
        maxChunkChars,
        currentStreamSeq
      ).catch(() => {
        // Suppress any uncaught rejection in background reader
      });
    } catch {
      // Fail-open: never propagate capture setup exceptions to page
    }

    // Always return original response immediately to page
    return response;
  };

  // Return uninstallation function
  return () => {
    delete (target as any)[FETCH_HOOK_INSTALLED];
    target.fetch = originalFetch;
  };
}

async function consumeClonedSseBody(
  clone: Response,
  streamId: string,
  producerSessionId: string,
  onEvent: TransportEventEmitter,
  nextSequence: () => number,
  maxChunkChars: number,
  initialStreamSeq: number
): Promise<void> {
  let streamSeq = initialStreamSeq;

  if (!clone.body) {
    onEvent({
      producerSessionId,
      streamId,
      sequence: nextSequence(),
      streamSequence: streamSeq++,
      timestamp: Date.now(),
      transport: 'fetch',
      type: 'complete',
    });
    return;
  }

  const reader = clone.body.getReader();
  const utf8Decoder = new Utf8StreamDecoder();
  let terminalEmitted = false;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        const remaining = utf8Decoder.flush();
        if (remaining.length > 0) {
          streamSeq = emitChunkSafe(
            remaining,
            streamId,
            producerSessionId,
            onEvent,
            nextSequence,
            maxChunkChars,
            streamSeq
          );
        }
        break;
      }

      if (value && value.byteLength > 0) {
        const text = utf8Decoder.decode(value);
        if (text.length > 0) {
          streamSeq = emitChunkSafe(
            text,
            streamId,
            producerSessionId,
            onEvent,
            nextSequence,
            maxChunkChars,
            streamSeq
          );
        }
      }
    }

    terminalEmitted = true;
    onEvent({
      producerSessionId,
      streamId,
      sequence: nextSequence(),
      streamSequence: streamSeq++,
      timestamp: Date.now(),
      transport: 'fetch',
      type: 'complete',
    });
  } catch (err) {
    if (!terminalEmitted) {
      terminalEmitted = true;
      onEvent({
        producerSessionId,
        streamId,
        sequence: nextSequence(),
        streamSequence: streamSeq++,
        timestamp: Date.now(),
        transport: 'fetch',
        type: 'abort',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function emitChunkSafe(
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
      transport: 'fetch',
      type: 'chunk',
      chunkText: chunk,
    });
  }

  return seq;
}
