import {
  MESSAGE_PERSIST_RAW_STREAM_OPEN,
  MESSAGE_PERSIST_RAW_BATCH,
  MESSAGE_FINALIZE_RAW_STREAM,
  type PersistRawStreamOpenRequest,
  type PersistRawBatchRequest,
  type FinalizeRawStreamRequest,
  type ExtensionInternalMessage,
} from '../../bridge/messages';
import {
  sanitizeStreamUrl,
  validatePersistRawStreamOpenResponse,
  validatePersistRawBatchResponse,
  validateFinalizeRawStreamResponse,
} from '../../bridge/validation';
import type { TransportEvent } from '../../transport/types';
import type {
  RawStreamBatch,
  RawStreamChunk,
  RawStreamState,
} from './types';
import { logger } from '../../shared/logger';

export interface Scheduler {
  setTimeout(callback: () => void, ms: number): any;
  clearTimeout(timerId: any): void;
}

export const defaultScheduler: Scheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (id) => clearTimeout(id),
};

export interface RawJournalBufferOptions {
  maxBatchChars?: number;
  flushDelayMs?: number;
  maxPendingChars?: number;
  maxRetryAttempts?: number;
  retryDelaysMs?: number[];
  maxActiveKnownStreams?: number;
  messageSender?: (message: ExtensionInternalMessage) => Promise<unknown>;
  scheduler?: Scheduler;
}

export interface RawJournalBufferDestroyReport {
  pendingStreamsLost: number;
  pendingBatchesLost: number;
  pendingCharsLost: number;
}

const DEFAULT_MAX_BATCH_CHARS = 32768; // 32 KiB characters
const DEFAULT_FLUSH_DELAY_MS = 500; // 500ms debounce
const DEFAULT_MAX_PENDING_CHARS = 524288; // 512 KiB memory ceiling
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_FAST_RETRY_DELAYS_MS = [250, 1000, 4000, 10000];
const SLOW_RETRY_DELAY_MS = 30000; // 30s slow retry after fast retries
const DEFAULT_MAX_ACTIVE_KNOWN_STREAMS = 16;

interface StreamBufferState {
  streamKey: string;
  producerSessionId: string;
  streamId: string;
  transport: 'fetch' | 'xhr';
  url: string;
  method: string;
  provisionalSessionId?: string;
  captureProfileId?: string;
  openedAt: number;
  state: RawStreamState;
  nextBatchSeq: number;
  currentChunks: RawStreamChunk[];
  currentBatchChars: number;
  flushTimer: any;

  // Ordered queue states
  openAcked: boolean;
  openAttempts: number;
  openPromise: Promise<void>;
  resolveOpenPromise?: () => void;

  pendingBatchesQueue: RawStreamBatch[];
  inFlightBatch: { batch: RawStreamBatch; attempts: number } | null;

  streamSequence: number;
  integrity: import('./types').RawStreamIntegrity;

  isTerminating: boolean;
  terminalEvent?: {
    finalState: RawStreamState;
    terminalReason?: string;
    error?: string;
    integrity?: import('./types').RawStreamIntegrity;
  };
  finalizeAttempts: number;
  finalizePromise: Promise<void>;
  resolveFinalizePromise?: () => void;

  retryTimer: any;
  isProcessing: boolean;

  pendingChars: number;
  droppedChars: number;
  durabilityGap: boolean;
}

export class RawJournalBuffer {
  private readonly maxBatchChars: number;
  private readonly flushDelayMs: number;
  private readonly maxPendingChars: number;
  private readonly maxRetryAttempts: number;
  private readonly retryDelaysMs: number[];
  private readonly maxActiveKnownStreams: number;
  private readonly messageSender: (message: ExtensionInternalMessage) => Promise<unknown>;
  private readonly scheduler: Scheduler;

  private readonly streams = new Map<string, StreamBufferState>();

  constructor(options: RawJournalBufferOptions = {}) {
    this.maxBatchChars = options.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS;
    this.flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
    this.maxPendingChars = options.maxPendingChars ?? DEFAULT_MAX_PENDING_CHARS;
    this.maxRetryAttempts = options.maxRetryAttempts ?? DEFAULT_MAX_RETRIES;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FAST_RETRY_DELAYS_MS;
    this.maxActiveKnownStreams = options.maxActiveKnownStreams ?? DEFAULT_MAX_ACTIVE_KNOWN_STREAMS;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.messageSender =
      options.messageSender ??
      ((msg) => {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
          return chrome.runtime.sendMessage(msg);
        }
        return Promise.reject(new Error('chrome.runtime.sendMessage not available'));
      });
  }

  private makeStreamKey(producerSessionId: string, streamId: string): string {
    return `${producerSessionId}:${streamId}`;
  }

  /**
   * Handle stream open transport event. Enforces DoS capacity bounds and initializes
   * strictly ordered stream persistence queue starting with OPEN.
   */
  /**
   * Handle stream open transport event. Enforces DoS capacity bounds and initializes
   * strictly ordered stream persistence queue starting with OPEN. Registration-only (non-blocking).
   */
  handleOpen(
    event: TransportEvent,
    provisionalSessionId?: string,
    captureProfileId?: string
  ): void {
    const streamKey = this.makeStreamKey(event.producerSessionId, event.streamId);

    if (this.streams.has(streamKey)) {
      return;
    }

    // DoS bound on simultaneously active tracked streams (eviction happens strictly on valid FINALIZE ACK)
    if (this.streams.size >= this.maxActiveKnownStreams) {
      logger.warn('RawJournalBuffer capacity reached maximum active streams, rejecting new stream', {
        streamKey,
        max: this.maxActiveKnownStreams,
      });
      return;
    }

    const sanitizedUrl = sanitizeStreamUrl(
      event.metadata?.url || 'https://chat.deepseek.com/api/v0/chat/completion'
    );

    let resolveOpen!: () => void;
    const openPromise = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });

    let resolveFinalize!: () => void;
    const finalizePromise = new Promise<void>((resolve) => {
      resolveFinalize = resolve;
    });

    const isSequenceGap = event.streamSequence !== 0;
    const initialIntegrity: import('./types').RawStreamIntegrity = isSequenceGap ? 'gap_detected' : 'intact';

    const state: StreamBufferState = {
      streamKey,
      producerSessionId: event.producerSessionId,
      streamId: event.streamId,
      transport: event.transport,
      url: sanitizedUrl,
      method: event.metadata?.method || 'POST',
      provisionalSessionId,
      captureProfileId,
      openedAt: event.timestamp || Date.now(),
      state: isSequenceGap ? 'degraded' : 'active',
      streamSequence: event.streamSequence,
      integrity: initialIntegrity,
      nextBatchSeq: 1,
      currentChunks: [],
      currentBatchChars: 0,
      flushTimer: null,

      openAcked: false,
      openAttempts: 0,
      openPromise,
      resolveOpenPromise: resolveOpen,

      pendingBatchesQueue: [],
      inFlightBatch: null,

      isTerminating: false,
      finalizeAttempts: 0,
      finalizePromise,
      resolveFinalizePromise: resolveFinalize,

      retryTimer: null,
      isProcessing: false,

      pendingChars: 0,
      droppedChars: 0,
      durabilityGap: isSequenceGap,
    };

    this.streams.set(streamKey, state);

    // Kick off ordered processing queue asynchronously (registration-only)
    this.processStreamQueue(state);
  }

  /**
   * Returns a promise that resolves strictly upon authoritative OPEN ACK.
   */
  waitForOpenAck(streamKey: string): Promise<void> {
    const state = this.streams.get(streamKey);
    if (!state) return Promise.reject(new Error(`Stream not found: ${streamKey}`));
    return state.openPromise;
  }

  /**
   * Handle stream chunk event. Rejects orphan chunks for unknown streams.
   * If memory ceiling is exceeded (including incoming chunk), degrades stream, tracks droppedChars, and drops chunk.
   */
  handleChunk(event: TransportEvent): void {
    if (!event.chunkText) return;

    const streamKey = this.makeStreamKey(event.producerSessionId, event.streamId);
    const state = this.streams.get(streamKey);

    // STRICT INVARIANT: Never auto-open fake streams on orphan chunks
    if (!state) {
      logger.warn('RawJournalBuffer dropped chunk for unknown or un-opened stream', {
        streamKey,
        sequence: event.streamSequence,
      });
      return;
    }

    if (state.isTerminating) {
      logger.warn('RawJournalBuffer dropped chunk arriving after terminal event', {
        streamKey,
        sequence: event.streamSequence,
      });
      return;
    }

    // Memory ceiling protection: checks queued batches plus current buffer plus incoming chunk
    if (state.pendingChars + state.currentBatchChars + event.chunkText.length > this.maxPendingChars) {
      state.state = 'degraded';
      state.durabilityGap = true;
      state.droppedChars += event.chunkText.length;
      logger.warn('RawJournalBuffer pending memory limit exceeded, chunk dropped and state degraded', {
        streamKey,
        pendingChars: state.pendingChars,
        currentBatchChars: state.currentBatchChars,
        incomingLength: event.chunkText.length,
        droppedChars: state.droppedChars,
      });
      return;
    }

    const chunk: RawStreamChunk = {
      streamSequence: event.streamSequence ?? 0,
      chunkText: event.chunkText,
      timestamp: event.timestamp || Date.now(),
    };

    state.currentChunks.push(chunk);
    state.currentBatchChars += chunk.chunkText.length;

    // Trigger 1: Size threshold reached -> flush immediately
    if (state.currentBatchChars >= this.maxBatchChars) {
      this.flushStream(state);
      return;
    }

    // Trigger 2: Debounce timer threshold
    if (!state.flushTimer) {
      state.flushTimer = this.scheduler.setTimeout(() => {
        state.flushTimer = null;
        this.flushStream(state);
      }, this.flushDelayMs);
    }
  }

  /**
   * Handle stream terminal event (complete, abort, error).
   * Enforces finalization barrier: flushes final batch and enqueues FINALIZE only after all batches ACK.
   */
  async handleTerminal(
    event: TransportEvent,
    options?: { sequenceGap?: boolean }
  ): Promise<void> {
    const streamKey = this.makeStreamKey(event.producerSessionId, event.streamId);
    const state = this.streams.get(streamKey);
    if (!state || state.isTerminating) return;

    state.isTerminating = true;

    // Flush any pending chunks into final batch
    this.flushStream(state);

    if (options?.sequenceGap) {
      state.integrity = 'gap_detected';
      state.durabilityGap = true;
    }

    const finalState: RawStreamState =
      event.type === 'complete'
        ? 'completed'
        : event.type === 'abort'
          ? 'aborted'
          : 'error';

    state.state = finalState;
    state.terminalEvent = {
      finalState,
      terminalReason: event.reason,
      error: event.type === 'error' ? event.reason : undefined,
      integrity: state.integrity,
    };

    this.processStreamQueue(state);
    await state.finalizePromise;
  }

  /**
   * Flush accumulated chunks into a new RawStreamBatch and enqueue in ordered pipeline.
   */
  private flushStream(state: StreamBufferState): void {
    if (state.flushTimer) {
      this.scheduler.clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }

    if (state.currentChunks.length === 0) return;

    const batchSeq = state.nextBatchSeq++;
    const batch: RawStreamBatch = {
      id: `${state.streamKey}:${batchSeq}`,
      streamKey: state.streamKey,
      batchSeq,
      chunks: [...state.currentChunks],
      createdAt: Date.now(),
      charCount: state.currentBatchChars,
    };

    state.currentChunks = [];
    state.currentBatchChars = 0;

    state.pendingBatchesQueue.push(batch);
    state.pendingChars += batch.charCount;

    if (state.pendingChars >= this.maxPendingChars) {
      state.state = 'degraded';
      state.durabilityGap = true;
    }

    this.processStreamQueue(state);
  }

  /**
   * Best-effort flush for all tracked streams (e.g. on pagehide / visibilitychange).
   */
  flushAll(): void {
    for (const state of this.streams.values()) {
      if (state.currentChunks.length > 0) {
        this.flushStream(state);
      }
    }
  }

  /**
   * Core ordered queue loop for a stream.
   * Guarantees exact lifecycle:
   * OPEN ACK -> BATCH 1 ACK -> BATCH 2 ACK -> ... -> FINAL BATCH ACK -> FINALIZE ACK
   */
  private async processStreamQueue(state: StreamBufferState): Promise<void> {
    if (state.isProcessing || state.retryTimer != null) return;
    state.isProcessing = true;

    try {
      while (true) {
        // Step 1: Guarantee OPEN ACK before any batches are sent
        if (!state.openAcked) {
          state.openAttempts++;
          const openReq: PersistRawStreamOpenRequest = {
            type: MESSAGE_PERSIST_RAW_STREAM_OPEN,
            producerSessionId: state.producerSessionId,
            streamId: state.streamId,
            transport: state.transport,
            url: state.url,
            method: state.method,
            provisionalSessionId: state.provisionalSessionId,
            captureProfileId: state.captureProfileId,
            openedAt: state.openedAt,
            streamSequence: state.streamSequence,
            integrity: state.integrity,
          };

          let success = false;
          try {
            const rawRes = await this.messageSender(openReq);
            const validated = validatePersistRawStreamOpenResponse(rawRes);
            if (validated && validated.success && validated.streamKey === state.streamKey) {
              success = true;
            } else {
              logger.warn('Invalid or mismatched OPEN ACK received', {
                expectedKey: state.streamKey,
                receivedKey: validated?.streamKey,
                errorCode: validated?.errorCode,
              });
            }
          } catch {
            success = false;
          }

          if (success) {
            state.openAcked = true;
            state.openAttempts = 0;
            state.resolveOpenPromise?.();
            // Proceed immediately to pending batches
            continue;
          } else {
            // NACK: Never resolve openPromise on failure!
            this.scheduleRetry(state, state.openAttempts);
            return;
          }
        }

        // Step 2: Guarantee ordered batch delivery (1 at a time, strictly sequential)
        if (!state.inFlightBatch && state.pendingBatchesQueue.length > 0) {
          state.inFlightBatch = {
            batch: state.pendingBatchesQueue[0]!,
            attempts: 0,
          };
        }

        if (state.inFlightBatch) {
          const currentEntry = state.inFlightBatch;
          currentEntry.attempts++;

          const batchReq: PersistRawBatchRequest = {
            type: MESSAGE_PERSIST_RAW_BATCH,
            batch: currentEntry.batch,
          };

          let success = false;
          try {
            const rawRes = await this.messageSender(batchReq);
            const validated = validatePersistRawBatchResponse(rawRes);
            if (
              validated &&
              validated.success &&
              validated.streamKey === currentEntry.batch.streamKey &&
              validated.batchSeq === currentEntry.batch.batchSeq
            ) {
              success = true;
            } else {
              logger.warn('Invalid or mismatched BATCH ACK received', {
                expectedKey: currentEntry.batch.streamKey,
                receivedKey: validated?.streamKey,
                expectedSeq: currentEntry.batch.batchSeq,
                receivedSeq: validated?.batchSeq,
                errorCode: validated?.errorCode,
              });
            }
          } catch {
            success = false;
          }

          if (success) {
            // Remove ACKed batch from head of queue
            state.pendingBatchesQueue.shift();
            state.pendingChars = Math.max(0, state.pendingChars - currentEntry.batch.charCount);
            state.inFlightBatch = null;
            // Continue immediately to next queued batch or finalization
            continue;
          } else {
            // Stale / mismatched / failed ACK: keep batch in queue / inFlight, schedule retry
            this.scheduleRetry(state, currentEntry.attempts);
            return;
          }
        }

        // Step 3: Finalize barrier — executed ONLY after all batches have received ACK
        if (
          state.isTerminating &&
          state.terminalEvent &&
          state.pendingBatchesQueue.length === 0 &&
          !state.inFlightBatch
        ) {
          state.finalizeAttempts++;

          const expectedFinalState = state.terminalEvent.finalState;

          const finalizeReq: FinalizeRawStreamRequest = {
            type: MESSAGE_FINALIZE_RAW_STREAM,
            streamKey: state.streamKey,
            finalState: expectedFinalState,
            terminalReason: state.terminalEvent.terminalReason,
            error: state.terminalEvent.error,
            droppedChars: state.droppedChars,
            durabilityGap: state.durabilityGap,
            integrity: state.terminalEvent.integrity || (state.durabilityGap ? 'gap_detected' : 'intact'),
          };

          let success = false;
          try {
            const rawRes = await this.messageSender(finalizeReq);
            const validated = validateFinalizeRawStreamResponse(rawRes);
            if (
              validated &&
              validated.success &&
              validated.streamKey === state.streamKey &&
              (validated.finalState === undefined || validated.finalState === expectedFinalState)
            ) {
              success = true;
            } else {
              logger.warn('Invalid or mismatched FINALIZE ACK received', {
                expectedKey: state.streamKey,
                receivedKey: validated?.streamKey,
                expectedFinalState,
                receivedFinalState: validated?.finalState,
                errorCode: validated?.errorCode,
              });
            }
          } catch {
            success = false;
          }

          if (success) {
            // Full stream cycle complete and durable
            state.resolveFinalizePromise?.();
            this.streams.delete(state.streamKey);
            return;
          } else {
            this.scheduleRetry(state, state.finalizeAttempts);
            return;
          }
        }

        // Queue is idle (waiting for chunks or termination)
        return;
      }
    } finally {
      state.isProcessing = false;
    }
  }

  /**
   * Schedule retry with fast delays (250ms, 1s, 4s, 10s) and slow retry (30s) thereafter.
   */
  private scheduleRetry(state: StreamBufferState, attempts: number): void {
    if (state.retryTimer) {
      this.scheduler.clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }

    if (attempts >= this.maxRetryAttempts) {
      state.state = 'degraded';
      state.durabilityGap = true;
    }

    let delayMs: number;
    if (attempts <= this.retryDelaysMs.length) {
      delayMs = this.retryDelaysMs[attempts - 1] ?? 1000;
    } else {
      delayMs = SLOW_RETRY_DELAY_MS;
    }

    state.retryTimer = this.scheduler.setTimeout(() => {
      state.retryTimer = null;
      this.processStreamQueue(state);
    }, delayMs);
  }

  /**
   * For testing & diagnostics: inspect stream buffer state
   */
  getStreamState(streamKey: string): {
    pendingBatchesCount: number;
    pendingChars: number;
    unflushedChunksCount: number;
    state: RawStreamState;
    integrity: import('./types').RawStreamIntegrity;
    droppedChars: number;
    durabilityGap: boolean;
    openAcked: boolean;
  } | null {
    const s = this.streams.get(streamKey);
    if (!s) return null;
    return {
      pendingBatchesCount: s.pendingBatchesQueue.length,
      pendingChars: s.pendingChars,
      unflushedChunksCount: s.currentChunks.length,
      state: s.state,
      integrity: s.integrity,
      droppedChars: s.droppedChars,
      durabilityGap: s.durabilityGap,
      openAcked: s.openAcked,
    };
  }

  /**
   * Clear all active stream timers and buffers (e.g. on unload/destroy).
   * Returns honest loss window diagnostics without sensitive raw text.
   */
  destroy(): RawJournalBufferDestroyReport {
    let pendingStreamsLost = 0;
    let pendingBatchesLost = 0;
    let pendingCharsLost = 0;

    for (const state of this.streams.values()) {
      if (state.flushTimer) {
        this.scheduler.clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.retryTimer) {
        this.scheduler.clearTimeout(state.retryTimer);
        state.retryTimer = null;
      }

      const hasPending =
        state.pendingBatchesQueue.length > 0 ||
        state.currentChunks.length > 0 ||
        !state.openAcked;
      if (hasPending) {
        pendingStreamsLost++;
      }
      pendingBatchesLost += state.pendingBatchesQueue.length + (state.currentChunks.length > 0 ? 1 : 0);
      pendingCharsLost += state.pendingChars + state.currentBatchChars;
    }
    this.streams.clear();

    return {
      pendingStreamsLost,
      pendingBatchesLost,
      pendingCharsLost,
    };
  }
}
