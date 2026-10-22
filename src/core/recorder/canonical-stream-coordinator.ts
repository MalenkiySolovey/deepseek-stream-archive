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
}

export class CanonicalStreamCoordinator {
  private readonly producerSessionId: string;
  private readonly streamId: string;
  private readonly rawStreamKey: string;
  private readonly provisionalSessionId: string;
  private readonly conversationTitle?: string;
  private readonly onCheckpoint: (checkpoint: CanonicalCheckpointDto) => Promise<CanonicalCheckpointAck>;
  private readonly debounceMs: number;

  private readonly recorder: CanonicalRevisionRecorder;
  private checkpointSeq = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private inFlightCheckpoint: Promise<CanonicalCheckpointAck | null> | null = null;
  private lastAckedSeq = -1;
  private lastAckedRevisionCount = 0;
  private lastAckedRecoveryEventCount = 0;
  private lastAckedRemoteId?: string;
  private lastAckedStatus?: import('../models').MessageStatus;
  private isDisposed = false;
  private initialConversationSent = false;

  constructor(config: CanonicalStreamCoordinatorConfig) {
    this.producerSessionId = config.producerSessionId;
    this.streamId = config.streamId;
    this.rawStreamKey = `${config.producerSessionId}:${config.streamId}`;
    this.provisionalSessionId =
      config.provisionalSessionId || `conv_${config.producerSessionId}_${config.streamId}`;
    this.conversationTitle = config.conversationTitle;
    this.onCheckpoint = config.onCheckpoint;
    this.debounceMs = config.debounceMs ?? 500;

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

  feedSemanticEvent(event: DeepSeekSemanticEvent): void {
    if (this.isDisposed) return;

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
      this.triggerCheckpoint(
        event.type === 'stream_finished' ||
          event.type === 'stream_transport_ended' ||
          event.type === 'stream_interrupted' ||
          event.type === 'stream_degraded' ||
          event.type === 'stream_error'
      );
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
    if (this.debounceTimer || this.isDisposed) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.triggerCheckpoint(false);
    }, this.debounceMs);
  }

  async triggerCheckpoint(isFinal = false): Promise<CanonicalCheckpointAck | null> {
    if (this.isDisposed && !isFinal) return null;

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

    const seq = this.checkpointSeq++;
    const dto: CanonicalCheckpointDto = {
      streamKey: this.rawStreamKey,
      checkpointSeq: seq,
      conversation,
      message: messageSnapshot,
      revisions: newRevisions,
      recoveryEvents: newRecoveryEvents,
      isFinal,
    };

    try {
      const ack = await this.onCheckpoint(dto);

      if (
        ack &&
        ack.success &&
        ack.streamKey === this.rawStreamKey &&
        ack.checkpointSeq === seq
      ) {
        this.lastAckedSeq = seq;
        this.lastAckedRevisionCount = allRevisions.length;
        this.lastAckedRecoveryEventCount = allRecoveryEvents.length;
        this.lastAckedRemoteId = messageSnapshot.remoteId;
        this.lastAckedStatus = messageSnapshot.status;
        if (conversation) {
          this.initialConversationSent = true;
        }
        return ack;
      } else {
        logger.warn('Mismatched or rejected canonical checkpoint ACK', {
          expectedKey: this.rawStreamKey,
          expectedSeq: seq,
          receivedKey: ack?.streamKey,
          receivedSeq: ack?.checkpointSeq,
          error: ack?.error,
        });
        return ack || null;
      }
    } catch (err) {
      logger.warn('Failed to send canonical checkpoint', {
        streamKey: this.rawStreamKey,
        seq,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
