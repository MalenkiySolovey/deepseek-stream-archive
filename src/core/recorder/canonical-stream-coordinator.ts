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
  private nextCheckpointSeq = 0;
  private pendingCheckpoint: SealedCanonicalCheckpoint | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightCheckpoint: Promise<CanonicalCheckpointAck | null> | null = null;
  private lastAckedSeq = -1;
  private lastAckedRevisionCount = 0;
  private lastAckedRecoveryEventCount = 0;
  private lastAckedRemoteId?: string;
  private lastAckedStatus?: import('../models').MessageStatus;
  private isDisposed = false;
  private initialConversationSent = false;
  private isTerminalLocked = false;
  private isTerminalCommitted = false;
  private retryAttempts = 0;
  private lastAttemptError?: string;

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

  getDiagnostics(): CanonicalCoordinatorDiagnostics {
    return {
      streamKey: this.rawStreamKey,
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
    if (this.isDisposed || this.isTerminalLocked) return;

    this.recorder.feedSemanticEvent(event);

    const isImmediate =
      event.type === 'message_id_identified' ||
      event.type === 'answer_replace' ||
      event.type === 'thinking_replace' ||
      event.type === 'filter_triggered' ||
      event.type === 'stream_finished' ||
      event.type === 'stream_transport_ended' ||
      event.type === 'stream_interrupted' ||
      event.type === 'stream_degraded' ||
      event.type === 'stream_error';

    if (isImmediate) {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
      const isTerminal =
        event.type === 'stream_finished' ||
        event.type === 'stream_transport_ended' ||
        event.type === 'stream_interrupted' ||
        event.type === 'stream_degraded' ||
        event.type === 'stream_error';
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
    if (this.debounceTimer || this.isDisposed || this.isTerminalLocked) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.triggerCheckpoint(false);
    }, this.debounceMs);
  }

  async triggerCheckpoint(isFinal = false): Promise<CanonicalCheckpointAck | null> {
    if (this.isDisposed && !isFinal) return null;
    if (this.isTerminalCommitted) return null;

    if (isFinal) {
      this.isTerminalLocked = true;
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
        this.debounceTimer = null;
      }
    }

    if (this.inFlightCheckpoint) {
      const queued = this.inFlightCheckpoint
        .catch(() => null)
        .then(() => this.executeCheckpoint(isFinal));
      this.inFlightCheckpoint = queued;
      return queued;
    }

    const current = this.executeCheckpoint(isFinal);
    this.inFlightCheckpoint = current;
    current.finally(() => {
      if (this.inFlightCheckpoint === current) {
        this.inFlightCheckpoint = null;
      }
    });
    return current;
  }

  async awaitFinalPersistence(): Promise<CanonicalCheckpointAck | null> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    return this.triggerCheckpoint(true);
  }

  private async executeCheckpoint(isFinal: boolean): Promise<CanonicalCheckpointAck | null> {
    // 1. If we already have a sealed pending checkpoint that failed previously,
    // we MUST retry this exact sealed checkpoint without altering sequence or content.
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
    }

    sealedToDeliver.attempts++;

    try {
      const ack = await this.onCheckpoint(sealedToDeliver);

      if (
        ack &&
        ack.success &&
        ack.streamKey === this.rawStreamKey &&
        ack.checkpointSeq === sealedToDeliver.checkpointSeq
      ) {
        // Successful ACK
        this.lastAckedSeq = sealedToDeliver.checkpointSeq;
        this.nextCheckpointSeq = sealedToDeliver.checkpointSeq + 1;
        this.lastAckedRevisionCount += sealedToDeliver.revisions.length;
        this.lastAckedRecoveryEventCount += sealedToDeliver.recoveryEvents.length;
        this.lastAckedRemoteId = sealedToDeliver.message.remoteId;
        this.lastAckedStatus = sealedToDeliver.message.status;
        if (sealedToDeliver.conversation) {
          this.initialConversationSent = true;
        }

        if (sealedToDeliver.isFinal) {
          this.isTerminalCommitted = true;
          this.isTerminalLocked = true;
        }

        this.pendingCheckpoint = null;
        this.retryAttempts = 0;
        this.lastAttemptError = undefined;

        if (this.retryTimer) {
          clearTimeout(this.retryTimer);
          this.retryTimer = null;
        }

        // If another flush or terminal was requested while this one was sending, trigger next checkpoint
        if (isFinal && !sealedToDeliver.isFinal) {
          return this.executeCheckpoint(true);
        }

        return ack;
      } else {
        const errorMsg = ack?.error || 'checkpoint_nack_or_mismatch';
        this.handleDeliveryFailure(sealedToDeliver, errorMsg);
        return ack || null;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.handleDeliveryFailure(sealedToDeliver, errorMsg);
      return null;
    }
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
      return;
    }

    if (!this.retryTimer && !this.isDisposed) {
      const delay =
        this.retryBackoffMs[
          Math.min(this.retryAttempts - 1, this.retryBackoffMs.length - 1)
        ] ?? 1000;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        this.triggerCheckpoint(checkpoint.isFinal || this.isTerminalLocked);
      }, delay);
    }
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }
}
