import { CanonicalRevisionRecorder } from './canonical-recorder';
import type { DeepSeekSemanticEvent } from '../../adapters/deepseek/protocol/types';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../models';
import { makeProvisionalMessageId } from '../models';
import { logger } from '../../shared/logger';

export interface CanonicalCheckpointDto {
  streamKey: string;
  checkpointSeq: number;
  conversation?: Conversation;
  userMessage?: Message;
  message: Message;
  revisions: ResponseRevision[];
  recoveryEvents: RecoveryEvent[];
  isFinal: boolean;
}

export type DeepReadonly<T> = T extends (infer R)[]
  ? ReadonlyArray<DeepReadonly<R>>
  : T extends Function
  ? T
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

export function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  Object.freeze(obj);
  for (const key of Object.keys(obj) as Array<keyof T>) {
    const val = obj[key];
    if (val !== null && typeof val === 'object') {
      deepFreeze(val);
    }
  }
  return obj;
}

export interface SealedCheckpointState {
  readonly payload: DeepReadonly<CanonicalCheckpointDto>;
  readonly sealedAt: number;
  attempts: number;
}

export type SealedCanonicalCheckpoint = CanonicalCheckpointDto & {
  sealedAt: number;
  attempts: number;
};

export interface CanonicalCheckpointAck {
  success: boolean;
  streamKey: string;
  checkpointSeq: number;
  persistedAt?: number;
  error?: string;
}

export type FinalPersistenceResult =
  | { state: 'committed'; checkpointSeq: number }
  | { state: 'unconfirmed'; reason: string; checkpointSeq?: number }
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
  clientTurnId?: string;
  requestPrompt?: string;
  requestParentMessageId?: string | null;
  onCheckpoint: (checkpoint: CanonicalCheckpointDto) => Promise<CanonicalCheckpointAck>;
  debounceMs?: number;
  minCharsForFlush?: number;
  retryBackoffMs?: number[];
  maxRetries?: number;
  maxRetryAttempts?: number;
  checkpointAttemptTimeoutMs?: number;
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

function deepClone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export class CanonicalStreamCoordinator {
  private readonly producerSessionId: string;
  private readonly streamId: string;
  private readonly rawStreamKey: string;
  private readonly provisionalSessionId: string;
  private readonly conversationTitle?: string;
  private readonly onCheckpoint: (checkpoint: CanonicalCheckpointDto) => Promise<CanonicalCheckpointAck>;
  private readonly debounceMs: number;
  private readonly retryBackoffMs: number[];
  private readonly maxRetries: number;
  private readonly checkpointAttemptTimeoutMs: number;
  private readonly userMessage?: Message;

  private readonly recorder: CanonicalRevisionRecorder;
  private state: CoordinatorState = 'idle';
  private nextCheckpointSeq = 0;
  private pendingCheckpointState: SealedCheckpointState | null = null;
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
    this.maxRetries = config.maxRetries ?? config.maxRetryAttempts ?? 10;
    this.checkpointAttemptTimeoutMs = config.checkpointAttemptTimeoutMs ?? 15000;

    const userMessageId =
      config.clientTurnId ||
      (config.requestPrompt && config.requestPrompt.trim().length > 0
        ? `msg_user_${this.rawStreamKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
        : undefined);

    if (userMessageId && config.requestPrompt && config.requestPrompt.trim().length > 0) {
      this.userMessage = {
        id: userMessageId,
        conversationId: this.provisionalSessionId,
        remoteParentId: config.requestParentMessageId || undefined,
        role: 'user',
        status: 'finished',
        content: config.requestPrompt,
        identityState: 'provisional',
        projectionState: 'provisional_logical',
        sourceRawStreamKey: this.rawStreamKey,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    }

    const deterministicMessageId = makeProvisionalMessageId(this.rawStreamKey);
    const isNewUserTurn = Boolean(this.userMessage?.id || config.clientTurnId);
    this.recorder = new CanonicalRevisionRecorder({
      conversationId: this.provisionalSessionId,
      messageId: deterministicMessageId,
      parentId: isNewUserTurn ? (this.userMessage?.id || config.clientTurnId) : (config.requestParentMessageId || undefined),
      remoteParentId: isNewUserTurn ? undefined : (config.requestParentMessageId || undefined),
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
    return this.pendingCheckpointState !== null;
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
      hasPendingCheckpoint: this.pendingCheckpointState !== null,
      pendingCheckpointSeq: this.pendingCheckpointState?.payload.checkpointSeq,
      pendingCheckpointAttempts: this.pendingCheckpointState?.attempts ?? 0,
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

    if (event.type === 'message_id_identified' && event.requestMessageId && this.userMessage) {
      this.userMessage.remoteId = event.requestMessageId;
    }

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

  async awaitFinalPersistence(timeoutMs = 0): Promise<FinalPersistenceResult> {
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
        checkpointSeq: this.pendingCheckpointState?.payload.checkpointSeq,
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
            state: 'unconfirmed',
            reason: 'await_final_persistence_timeout',
            checkpointSeq: this.pendingCheckpointState?.payload.checkpointSeq,
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
    // Invariant: A sealed checkpoint must NEVER mutate. Terminal events arriving
    // during backoff are queued for the subsequent checkpoint seq.
    if (!this.pendingCheckpointState) {
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

      if (
        this.lastAckedSeq < 0 &&
        !hasNewRevisions &&
        !hasNewRecoveryEvents &&
        !hasNewRemoteId &&
        !hasStatusChange &&
        !isFinal
      ) {
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

      // Seal the checkpoint immutably via deep clone and deep freeze
      const seq = this.nextCheckpointSeq;
      const checkpointDto: CanonicalCheckpointDto = {
        streamKey: this.rawStreamKey,
        checkpointSeq: seq,
        conversation: conversation ? deepClone(conversation) : undefined,
        userMessage: this.userMessage ? deepClone(this.userMessage) : undefined,
        message: deepClone(messageSnapshot),
        revisions: deepClone(newRevisions),
        recoveryEvents: deepClone(newRecoveryEvents),
        isFinal,
      };

      const frozenPayload = deepFreeze(deepClone(checkpointDto));
      this.pendingCheckpointState = {
        payload: frozenPayload,
        sealedAt: Date.now(),
        attempts: 0,
      };
      this.state = 'sealed_pending';
    }

    this.state = 'in_flight';
    this.pendingCheckpointState.attempts++;

    // Defensive clone: provide a decoupled copy so callback mutations never tamper with internal sealed payload
    const targetPayload = this.pendingCheckpointState.payload;
    const deliveryClone = deepClone(targetPayload) as CanonicalCheckpointDto;
    const targetSeq = targetPayload.checkpointSeq;
    const isTargetFinal = targetPayload.isFinal;

    const runPromise: Promise<CanonicalCheckpointAck | null> = (async () => {
      try {
        const timeoutMs = this.checkpointAttemptTimeoutMs;
        let attemptTimer: ReturnType<typeof setTimeout> | null = null;
        const attemptPromise = this.onCheckpoint(deliveryClone);
        const timeoutPromise = new Promise<CanonicalCheckpointAck>((_, reject) => {
          if (timeoutMs > 0) {
            attemptTimer = setTimeout(() => {
              reject(new Error('checkpoint_attempt_timeout'));
            }, timeoutMs);
          }
        });

        let ack: CanonicalCheckpointAck;
        try {
          ack = await Promise.race([attemptPromise, timeoutPromise]);
        } finally {
          if (attemptTimer) clearTimeout(attemptTimer);
        }

        if (
          ack &&
          ack.success &&
          ack.streamKey === this.rawStreamKey &&
          ack.checkpointSeq === targetSeq
        ) {
          // Authoritative positive ACK
          this.lastAckedSeq = targetSeq;
          this.nextCheckpointSeq = targetSeq + 1;
          this.lastAckedRevisionCount += targetPayload.revisions.length;
          this.lastAckedRecoveryEventCount += targetPayload.recoveryEvents.length;
          this.lastAckedRemoteId = targetPayload.message.remoteId;
          this.lastAckedStatus = targetPayload.message.status;
          if (targetPayload.conversation) {
            this.initialConversationSent = true;
          }

          this.pendingCheckpointState = null;
          this.retryAttempts = 0;
          this.lastAttemptError = undefined;

          if (this.retryTimer) {
            clearTimeout(this.retryTimer);
            this.retryTimer = null;
          }

          if (isTargetFinal) {
            this.isTerminalCommitted = true;
            this.isTerminalLocked = true;
            this.state = 'committed';
            this.resolveWaiters({ state: 'committed', checkpointSeq: targetSeq });
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
          this.handleDeliveryFailure(errorMsg);
          return ack || null;
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.handleDeliveryFailure(errorMsg);
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

  private handleDeliveryFailure(error: string): void {
    if (!this.pendingCheckpointState) return;

    this.retryAttempts++;
    this.lastAttemptError = error;

    const seq = this.pendingCheckpointState.payload.checkpointSeq;
    const attempts = this.pendingCheckpointState.attempts;
    const isFinal = this.pendingCheckpointState.payload.isFinal;

    logger.warn('Canonical checkpoint delivery failed; will retry with backoff', {
      streamKey: this.rawStreamKey,
      seq,
      attempts,
      retryAttempts: this.retryAttempts,
      error,
    });

    if (this.retryAttempts > this.maxRetries) {
      logger.error('Canonical checkpoint exceeded maximum retry attempts', {
        streamKey: this.rawStreamKey,
        seq,
        attempts,
        maxRetries: this.maxRetries,
      });
      this.state = 'failed';
      this.resolveWaiters({
        state: 'failed',
        reason: `max_retries_exhausted:${error}`,
        checkpointSeq: seq,
      });
      return;
    }

    this.state = 'backoff_wait';

    const isTerminalPending = isFinal || this.isTerminalRequested;

    if (!this.retryTimer && (!this.isDisposed || isTerminalPending)) {
      const delay =
        this.retryBackoffMs[
          Math.min(this.retryAttempts - 1, this.retryBackoffMs.length - 1)
        ] ?? 1000;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.executeCheckpoint(isFinal);
      }, delay);
    }
  }

  dispose(): void {
    const isTerminalPending =
      (this.isTerminalRequested || this.pendingCheckpointState?.payload.isFinal) &&
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
          checkpointSeq: this.pendingCheckpointState?.payload.checkpointSeq,
        });
      }
    }
  }
}
