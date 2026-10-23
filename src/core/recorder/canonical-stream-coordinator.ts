import { CanonicalRevisionRecorder } from './canonical-recorder';
import type { DeepSeekSemanticEvent } from '../../adapters/deepseek/protocol/types';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../models';
import { makeProvisionalMessageId } from '../models';
import { logger } from '../../shared/logger';

export interface CanonicalCheckpointDto {
  streamKey: string;
  checkpointSeq: number;
  conversation?: Conversation;
  message: Message;
  revisions: ResponseRevision[];
  recoveryEvents: RecoveryEvent[];
  isFinal: boolean;
}

export interface SealedCanonicalCheckpoint extends CanonicalCheckpointDto {
  sealedAt: number;
  attempts: number;
}

export interface CanonicalCheckpointAck {
  success: boolean;
  streamKey: string;
  checkpointSeq: number;
  persistedAt?: number;
  error?: string;
}

export type FinalPersistenceResult =
  | { state: 'committed'; checkpointSeq: number }
  | { state: 'failed'; reason: string; checkpointSeq?: number };

export type CoordinatorState =
  | 'idle'
  | 'sealed_pending'
  | 'in_flight'
  | 'backoff_wait'
  | 'committed'
  | 'failed';

export interface CanonicalStreamCoordinatorConfig {
  producerSessionId: string;
  streamId: string;
  provisionalSessionId?: string;
  conversationTitle?: string;
  onCheckpoint: (checkpoint: CanonicalCheckpointDto) => Promise<CanonicalCheckpointAck>;
  debounceMs?: number;
  minCharsForFlush?: number;
  retryBackoffMs?: number[];
  maxRetryAttempts?: number;
}

export interface CanonicalCoordinatorDiagnostics {
  streamKey: string;
  state: CoordinatorState;
  lastAckedSeq: number;
  nextCheckpointSeq: number;
  hasPendingCheckpoint: boolean;
  pendingCheckpointSeq?: number;
  pendingCheckpointAttempts: number;
  retryAttempts: number;
  isTerminalLocked: boolean;
  isTerminalCommitted: boolean;
  unackedRevisionsCount: number;
  unackedRecoveryEventsCount: number;
  lastAttemptError?: string;
}

const DEFAULT_RETRY_BACKOFF_MS = [250, 1000, 4000, 10000, 30000];

export class CanonicalStreamCoordinator {
  private readonly producerSessionId: string;
  private readonly streamId: string;
  private readonly rawStreamKey: string;
  private readonly provisionalSessionId: string;
  private readonly conversationTitle?: string;
  private readonly onCheckpoint: (checkpoint: CanonicalCheckpointDto) => Promise<CanonicalCheckpointAck>;
  private readonly debounceMs: number;
  private readonly retryBackoffMs: number[];
  private readonly maxRetryAttempts: number;

  private readonly recorder: CanonicalRevisionRecorder;
  private state: CoordinatorState = 'idle';
  private nextCheckpointSeq = 0;
  private pendingCheckpoint: SealedCanonicalCheckpoint | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightPromise: Promise<CanonicalCheckpointAck | null> | null = null;
  private lastAckedSeq = -1;
  private lastAckedRevisionCount = 0;
  private lastAckedRecoveryEventCount = 0;
  private lastAckedRemoteId?: string;
  private lastAckedStatus?: import('../models').MessageStatus;
  private isDisposed = false;
  private initialConversationSent = false;
  private isTerminalLocked = false;
  private isTerminalRequested = false;
  private isTerminalCommitted = false;
  private needsFollowup = false;
  private retryAttempts = 0;
  private lastAttemptError?: string;
  private readonly finalPersistenceWaiters: Array<(result: FinalPersistenceResult) => void> = [];

  constructor(config: CanonicalStreamCoordinatorConfig) {
    this.producerSessionId = config.producerSessionId;
    this.streamId = config.streamId;
    this.rawStreamKey = `${config.producerSessionId}:${config.streamId}`;
    this.provisionalSessionId =
      config.provisionalSessionId || `conv_${config.producerSessionId}_${config.streamId}`;
    this.conversationTitle = config.conversationTitle;
    this.onCheckpoint = config.onCheckpoint;
    this.debounceMs = config.debounceMs ?? 500;
    this.retryBackoffMs = config.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.maxRetryAttempts = config.maxRetryAttempts ?? 10;

    const deterministicMessageId = makeProvisionalMessageId(this.rawStreamKey);
    this.recorder = new CanonicalRevisionRecorder({
      conversationId: this.provisionalSessionId,
      messageId: deterministicMessageId,
      sourceRawStreamKey: this.rawStreamKey,
      flushIntervalMs: this.debounceMs,
      minCharsForFlush: config.minCharsForFlush ?? 50,
    });
  }

  getRawStreamKey(): string {
    return this.rawStreamKey;
  }

  getProvisionalSessionId(): string {
    return this.provisionalSessionId;
  }

  getRecorder(): CanonicalRevisionRecorder {
    return this.recorder;
  }

  getLastAckedSeq(): number {
    return this.lastAckedSeq;
  }

  getNextCheckpointSeq(): number {
    return this.nextCheckpointSeq;
  }

  hasPendingCheckpoint(): boolean {
    return this.pendingCheckpoint !== null;
  }

  getState(): CoordinatorState {
    return this.state;
  }

  getDiagnostics(): CanonicalCoordinatorDiagnostics {
    return {
      streamKey: this.rawStreamKey,
      state: this.state,
      lastAckedSeq: this.lastAckedSeq,
      nextCheckpointSeq: this.nextCheckpointSeq,
      hasPendingCheckpoint: this.pendingCheckpoint !== null,
      pendingCheckpointSeq: this.pendingCheckpoint?.checkpointSeq,
      pendingCheckpointAttempts: this.pendingCheckpoint?.attempts ?? 0,
      retryAttempts: this.retryAttempts,
      isTerminalLocked: this.isTerminalLocked,
      isTerminalCommitted: this.isTerminalCommitted,
      unackedRevisionsCount: this.recorder.getRevisions().length - this.lastAckedRevisionCount,
      unackedRecoveryEventsCount: this.recorder.getRecoveryEvents().length - this.lastAckedRecoveryEventCount,
      lastAttemptError: this.lastAttemptError,
    };
  }

  feedSemanticEvent(event: DeepSeekSemanticEvent): void {
    if (this.isDisposed || this.isTerminalCommitted || this.state === 'failed') return;

    this.recorder.feedSemanticEvent(event);

    const isTerminal =
      event.type === 'stream_finished' ||
      event.type === 'stream_transport_ended' ||
      event.type === 'stream_interrupted' ||
      event.type === 'stream_degraded' ||
      event.type === 'stream_error';

    if (isTerminal) {
      this.isTerminalRequested = true;
      this.isTerminalLocked = true;
    }

    // Invariant: If a checkpoint is in-flight or waiting in backoff,
    // do NOT issue an immediate send that bypasses the backoff schedule.
    if (this.state === 'in_flight' || this.state === 'backoff_wait') {
      this.needsFollowup = true;
      return;
    }

    const isImmediate =
      isTerminal ||
      event.type === 'message_id_identified' ||
      event.type === 'answer_replace' ||
      event.type === 'thinking_replace' ||
      event.type === 'filter_triggered';

    if (isImmediate) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.triggerCheckpoint(isTerminal);
    } else if (this.recorder.shouldFlush()) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      this.triggerCheckpoint(false);
    } else {
      this.scheduleDebounce();
    }
  }

  private scheduleDebounce(): void {
    if (this.debounceTimer || this.isDisposed || this.isTerminalLocked || this.state !== 'idle') return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.triggerCheckpoint(false);
    }, this.debounceMs);
  }

  async triggerCheckpoint(isFinal = false): Promise<CanonicalCheckpointAck | null> {
    if (this.isDisposed && !isFinal) return null;
    if (this.isTerminalCommitted) return null;

    if (isFinal) {
      this.isTerminalRequested = true;
      this.isTerminalLocked = true;
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
    }

    if (this.state === 'in_flight' || this.state === 'backoff_wait') {
      this.needsFollowup = true;
      return this.inFlightPromise;
    }

    if (this.state === 'failed') {
      return null;
    }

    return this.executeCheckpoint(isFinal || this.isTerminalRequested);
  }

  async awaitFinalPersistence(timeoutMs = 35000): Promise<FinalPersistenceResult> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.isTerminalRequested = true;
    this.isTerminalLocked = true;

    if (this.isTerminalCommitted) {
      return { state: 'committed', checkpointSeq: this.lastAckedSeq };
    }

    if (this.state === 'failed') {
      return {
        state: 'failed',
        reason: this.lastAttemptError || 'retry_exhausted',
        checkpointSeq: this.pendingCheckpoint?.checkpointSeq,
      };
    }

    if (this.state === 'idle') {
      this.executeCheckpoint(true).catch(() => {});
    }

    return new Promise<FinalPersistenceResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const waiter = (res: FinalPersistenceResult) => {
        if (timer) clearTimeout(timer);
        resolve(res);
      };
      this.finalPersistenceWaiters.push(waiter);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const idx = this.finalPersistenceWaiters.indexOf(waiter);
          if (idx >= 0) {
            this.finalPersistenceWaiters.splice(idx, 1);
          }
          resolve({
            state: 'failed',
            reason: 'await_final_persistence_timeout',
            checkpointSeq: this.pendingCheckpoint?.checkpointSeq,
          });
        }, timeoutMs);
      }
    });
  }

  private resolveWaiters(result: FinalPersistenceResult): void {
    const waiters = [...this.finalPersistenceWaiters];
    this.finalPersistenceWaiters.length = 0;
    for (const w of waiters) {
      try {
        w(result);
      } catch {
        // ignore waiter errors
      }
    }
  }

  private async executeCheckpoint(isFinal: boolean): Promise<CanonicalCheckpointAck | null> {
    if (this.isTerminalCommitted) return null;

    // 1. If we already have a sealed pending checkpoint that failed previously,
    // retry this exact sealed checkpoint without altering sequence or content.
    let sealedToDeliver = this.pendingCheckpoint;

    if (!sealedToDeliver) {
      this.recorder.flush(isFinal);

      const allRevisions = this.recorder.getRevisions();
      const allRecoveryEvents = this.recorder.getRecoveryEvents();
      const messageSnapshot = this.recorder.buildMessageSnapshot();

      const newRevisions = allRevisions.slice(this.lastAckedRevisionCount);
      const newRecoveryEvents = allRecoveryEvents.slice(this.lastAckedRecoveryEventCount);

      const hasNewRevisions = newRevisions.length > 0;
      const hasNewRecoveryEvents = newRecoveryEvents.length > 0;
      const hasNewRemoteId =
        messageSnapshot.remoteId !== undefined &&
        messageSnapshot.remoteId !== this.lastAckedRemoteId;
      const hasStatusChange =
        this.lastAckedStatus !== undefined &&
        messageSnapshot.status !== this.lastAckedStatus;

      if (this.lastAckedSeq < 0 && !hasNewRevisions && !hasNewRecoveryEvents && !isFinal) {
        return null;
      }

      if (
        this.lastAckedSeq >= 0 &&
        !hasNewRevisions &&
        !hasNewRecoveryEvents &&
        !hasNewRemoteId &&
        !hasStatusChange &&
        !isFinal
      ) {
        return null;
      }

      let conversation: Conversation | undefined = undefined;
      if (!this.initialConversationSent) {
        const now = Date.now();
        conversation = {
          id: this.provisionalSessionId,
          remoteId: this.provisionalSessionId.startsWith('conv_')
            ? undefined
            : this.provisionalSessionId,
          title: this.conversationTitle || `Chat ${this.provisionalSessionId.slice(0, 8)}`,
          createdAt: now,
          updatedAt: now,
        };
      }

      // Seal the checkpoint immutably
      const seq = this.nextCheckpointSeq;
      sealedToDeliver = {
        streamKey: this.rawStreamKey,
        checkpointSeq: seq,
        conversation,
        message: messageSnapshot,
        revisions: newRevisions,
        recoveryEvents: newRecoveryEvents,
        isFinal,
        sealedAt: Date.now(),
        attempts: 0,
      };

      this.pendingCheckpoint = sealedToDeliver;
      this.state = 'sealed_pending';
    } else if (isFinal && !sealedToDeliver.isFinal) {
      // Elevate terminal flag if requested
      sealedToDeliver.isFinal = true;
    }

    this.state = 'in_flight';
    sealedToDeliver.attempts++;

    const runPromise: Promise<CanonicalCheckpointAck | null> = (async () => {
      try {
        const ack = await this.onCheckpoint(sealedToDeliver!);

        if (
          ack &&
          ack.success &&
          ack.streamKey === this.rawStreamKey &&
          ack.checkpointSeq === sealedToDeliver!.checkpointSeq
        ) {
          // Authoritative positive ACK
          this.lastAckedSeq = sealedToDeliver!.checkpointSeq;
          this.nextCheckpointSeq = sealedToDeliver!.checkpointSeq + 1;
          this.lastAckedRevisionCount += sealedToDeliver!.revisions.length;
          this.lastAckedRecoveryEventCount += sealedToDeliver!.recoveryEvents.length;
          this.lastAckedRemoteId = sealedToDeliver!.message.remoteId;
          this.lastAckedStatus = sealedToDeliver!.message.status;
          if (sealedToDeliver!.conversation) {
            this.initialConversationSent = true;
          }

          this.pendingCheckpoint = null;
          this.retryAttempts = 0;
          this.lastAttemptError = undefined;

          if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
          }

          if (sealedToDeliver!.isFinal) {
            this.isTerminalCommitted = true;
            this.isTerminalLocked = true;
            this.state = 'committed';
            this.resolveWaiters({ state: 'committed', checkpointSeq: sealedToDeliver!.checkpointSeq });
            return ack;
          }

          this.state = 'idle';

          // If new semantic events or terminal was queued while sending, trigger next checkpoint
          if (this.needsFollowup || this.isTerminalRequested) {
            this.needsFollowup = false;
            return this.executeCheckpoint(this.isTerminalRequested);
          }

          return ack;
        } else {
          const errorMsg = ack?.error || 'checkpoint_nack_or_mismatch';
          this.handleDeliveryFailure(sealedToDeliver!, errorMsg);
          return ack || null;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.handleDeliveryFailure(sealedToDeliver!, errorMsg);
        return null;
      }
    })();

    this.inFlightPromise = runPromise;
    runPromise.finally(() => {
      if (this.inFlightPromise === runPromise) {
        this.inFlightPromise = null;
      }
    });

    return runPromise;
  }

  private handleDeliveryFailure(checkpoint: SealedCanonicalCheckpoint, error: string): void {
    this.retryAttempts++;
    this.lastAttemptError = error;

    logger.warn('Canonical checkpoint delivery failed; will retry with backoff', {
      streamKey: this.rawStreamKey,
      seq: checkpoint.checkpointSeq,
      attempts: checkpoint.attempts,
      retryAttempts: this.retryAttempts,
      error,
    });

    if (this.retryAttempts > this.maxRetryAttempts) {
      logger.error('Canonical checkpoint exceeded maximum retry attempts', {
        streamKey: this.rawStreamKey,
        seq: checkpoint.checkpointSeq,
        attempts: checkpoint.attempts,
      });
      this.state = 'failed';
      this.resolveWaiters({
        state: 'failed',
        reason: `max_retries_exhausted:${error}`,
        checkpointSeq: checkpoint.checkpointSeq,
      });
      return;
    }

    this.state = 'backoff_wait';

    const isTerminalPending = checkpoint.isFinal || this.isTerminalRequested;

    if (!this.retryTimer && (!this.isDisposed || isTerminalPending)) {
      const delay =
        this.retryBackoffMs[
          Math.min(this.retryAttempts - 1, this.retryBackoffMs.length - 1)
        ] ?? 1000;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.executeCheckpoint(checkpoint.isFinal || this.isTerminalRequested);
      }, delay);
    }
  }

  dispose(): void {
    const isTerminalPending =
      (this.isTerminalRequested || this.pendingCheckpoint?.isFinal) &&
      !this.isTerminalCommitted &&
      this.state !== 'failed';

    this.isDisposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    // Terminal invariant: Never destroy retry timer or abort waiters if a terminal checkpoint
    // is in-flight or retrying! Let the retry backoff run to its committed or failed conclusion.
    if (!isTerminalPending) {
      if (this.retryTimer) {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      if (this.finalPersistenceWaiters.length > 0) {
        this.resolveWaiters({
          state: 'failed',
          reason: 'coordinator_disposed',
          checkpointSeq: this.pendingCheckpoint?.checkpointSeq,
        });
      }
    }
  }
}
