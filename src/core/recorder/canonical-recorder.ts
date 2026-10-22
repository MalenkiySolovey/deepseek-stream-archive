import type { RevisionRecorder, RevisionBufferState } from '../contracts/revision-recorder';
import type {
  Conversation,
  Message,
  MessageRole,
  MessageStatus,
  ResponseRevision,
  RecoveryEvent,
  CaptureSource,
} from '../models';
import { computeContentFingerprint } from '../models';
import type { DeepSeekSemanticEvent } from '../../adapters/deepseek/protocol/types';

export interface CanonicalRecorderConfig {
  conversationId: string;
  messageId: string;
  remoteMessageId?: string;
  parentId?: string;
  remoteParentId?: string;
  sourceRawStreamKey?: string;
  source?: CaptureSource;
  flushIntervalMs?: number;
  minCharsForFlush?: number;
}

export class CanonicalRevisionRecorder implements RevisionRecorder {
  private readonly conversationId: string;
  private readonly messageId: string;
  private remoteMessageId?: string;
  private readonly parentId?: string;
  private readonly remoteParentId?: string;
  private readonly sourceRawStreamKey?: string;
  private readonly source: CaptureSource;
  private readonly flushIntervalMs: number;
  private readonly minCharsForFlush: number;

  private accumulatedText = '';
  private accumulatedThinking = '';
  private status: MessageStatus = 'streaming';
  private revisionCount = 0;
  private lastFlushedAt = 0;
  private lastFlushedText = '';
  private lastFlushedThinking = '';

  private lastGoodRevision: ResponseRevision | null = null;
  private recoveryEvents: RecoveryEvent[] = [];
  private allRevisions: ResponseRevision[] = [];

  constructor(config: CanonicalRecorderConfig) {
    this.conversationId = config.conversationId;
    this.messageId = config.messageId;
    this.remoteMessageId = config.remoteMessageId;
    this.parentId = config.parentId;
    this.remoteParentId = config.remoteParentId;
    this.sourceRawStreamKey = config.sourceRawStreamKey;
    this.source = config.source || 'network';
    this.flushIntervalMs = config.flushIntervalMs ?? 500;
    this.minCharsForFlush = config.minCharsForFlush ?? 50;
    this.lastFlushedAt = Date.now();
  }

  getBufferState(): RevisionBufferState {
    return {
      currentMessageId: this.messageId,
      accumulatedText: this.accumulatedText,
      accumulatedThinking: this.accumulatedThinking,
      revisionCount: this.revisionCount,
      lastFlushedAt: this.lastFlushedAt,
    };
  }

  getCurrentStatus(): MessageStatus {
    return this.status;
  }

  getRemoteMessageId(): string | undefined {
    return this.remoteMessageId;
  }

  setRemoteMessageId(id: string): void {
    if (id && typeof id === 'string' && id.trim().length > 0) {
      this.remoteMessageId = id.trim();
    }
  }

  feedDelta(delta: { text?: string; thinking?: string }): void {
    if (delta.text) {
      this.accumulatedText += delta.text;
    }
    if (delta.thinking) {
      this.accumulatedThinking += delta.thinking;
    }
  }

  feedSemanticEvent(event: DeepSeekSemanticEvent): void {
    switch (event.type) {
      case 'message_id_identified':
        if (event.messageId) {
          this.setRemoteMessageId(event.messageId);
        }
        break;

      case 'answer_delta':
        if (event.delta) {
          this.accumulatedText += event.delta;
        }
        break;

      case 'answer_replace':
        if (event.fullText !== undefined) {
          this.accumulatedText = event.fullText;
        }
        break;

      case 'thinking_delta':
        if (event.delta) {
          this.accumulatedThinking += event.delta;
        }
        break;

      case 'thinking_replace':
        if (event.fullText !== undefined) {
          this.accumulatedThinking = event.fullText;
        }
        break;

      case 'filter_triggered':
        this.status = 'filtered';
        if (this.lastGoodRevision) {
          // Duplicate protection: filter incident already recorded for this stream
          break;
        }
        if (event.lastGood) {
          this.recordLastGoodSnapshot(event.lastGood.answer, event.lastGood.thinking, event.reason);
        } else {
          this.markLastGood();
        }
        break;

      case 'stream_finished':
        this.mapTerminalStatus(event);
        break;

      case 'stream_transport_ended':
        if (event.status) {
          this.mapProtocolStatus(event.status);
        } else if (this.status !== 'filtered') {
          // Closed without authoritative completion status -> incomplete (never finished!)
          this.status = 'incomplete';
        }
        break;

      case 'stream_interrupted':
        if (this.status !== 'filtered') {
          this.status = 'interrupted';
        }
        break;

      case 'stream_degraded':
        if (this.status !== 'filtered') {
          this.status = 'degraded';
        }
        break;

      case 'stream_error':
        if (this.status !== 'filtered') {
          this.status = 'interrupted';
        }
        break;
    }
  }

  private mapTerminalStatus(event: { status?: string; terminalReason?: string }): void {
    const raw = (event.terminalReason || event.status || '').toLowerCase();
    if (raw === 'completed' || raw === 'finished') {
      this.status = 'finished';
    } else if (raw === 'filtered' || raw === 'content_filter') {
      this.status = 'filtered';
    } else if (raw === 'truncated_context_limit' || raw === 'context_length_exceeded') {
      this.status = 'context_length_exceeded';
    } else if (raw === 'incomplete') {
      this.status = 'incomplete';
    } else if (raw === 'timeout') {
      this.status = 'timeout';
    } else if (raw === 'transport_abort' || raw === 'transport_error') {
      this.status = 'interrupted';
    } else if (raw === 'stream_degraded' || raw === 'degraded') {
      this.status = 'degraded';
    } else if (event.status) {
      this.mapProtocolStatus(event.status);
    } else {
      this.status = 'unknown';
    }
  }

  private mapProtocolStatus(status: string): void {
    const upper = status.toUpperCase();
    if (upper === 'CONTENT_FILTER') {
      this.status = 'filtered';
    } else if (upper === 'FINISHED') {
      this.status = 'finished';
    } else if (upper === 'INCOMPLETE') {
      this.status = 'incomplete';
    } else if (upper === 'TIMEOUT') {
      this.status = 'timeout';
    } else if (upper === 'CONTEXT_LENGTH_EXCEEDED') {
      this.status = 'context_length_exceeded';
    } else {
      this.status = 'unknown';
    }
  }

  shouldFlush(): boolean {
    const hasUnsavedChanges =
      this.accumulatedText !== this.lastFlushedText ||
      this.accumulatedThinking !== this.lastFlushedThinking;

    if (!hasUnsavedChanges) return false;

    const timeElapsed = Date.now() - this.lastFlushedAt;
    const charsChanged =
      Math.abs(this.accumulatedText.length - this.lastFlushedText.length) +
      Math.abs(this.accumulatedThinking.length - this.lastFlushedThinking.length);

    return timeElapsed >= this.flushIntervalMs || charsChanged >= this.minCharsForFlush;
  }

  flush(isFinal = false): ResponseRevision | null {
    const hasChanges =
      this.accumulatedText !== this.lastFlushedText ||
      this.accumulatedThinking !== this.lastFlushedThinking ||
      isFinal;

    if (!hasChanges && this.allRevisions.length > 0) {
      return null;
    }

    const now = Date.now();
    const revIdx = this.revisionCount++;
    const revision: ResponseRevision = {
      id: `rev_${this.messageId}_${revIdx}`,
      messageId: this.messageId,
      revisionIndex: revIdx,
      text: this.accumulatedText,
      thinking: this.accumulatedThinking.length > 0 ? this.accumulatedThinking : undefined,
      source: this.source,
      capturedAt: now,
      isFinal,
      isLastGood: false,
      contentFingerprint: computeContentFingerprint(this.accumulatedText, this.accumulatedThinking),
    };

    this.lastFlushedAt = now;
    this.lastFlushedText = this.accumulatedText;
    this.lastFlushedThinking = this.accumulatedThinking;
    this.allRevisions.push(revision);

    return revision;
  }

  recordLastGoodSnapshot(answer: string, thinking: string, reason?: string): ResponseRevision {
    if (this.lastGoodRevision) {
      return this.lastGoodRevision;
    }
    const now = Date.now();
    const revIdx = this.revisionCount++;
    const revision: ResponseRevision = {
      id: `rev_lastgood_${this.messageId}_${revIdx}`,
      messageId: this.messageId,
      revisionIndex: revIdx,
      text: answer,
      thinking: thinking.length > 0 ? thinking : undefined,
      source: this.source,
      capturedAt: now,
      isFinal: false,
      isLastGood: true,
      contentFingerprint: computeContentFingerprint(answer, thinking),
    };

    this.lastGoodRevision = revision;
    this.allRevisions.push(revision);

    const recoveryEvent: RecoveryEvent = {
      id: `rec_${this.messageId}_${revIdx}`,
      messageId: this.messageId,
      kind: 'content_filter',
      detectedAt: now,
      recoveredRevisionId: revision.id,
      reason: reason || 'DeepSeek content filter triggered; pre-filter text preserved',
    };
    this.recoveryEvents.push(recoveryEvent);

    return revision;
  }

  markLastGood(): ResponseRevision | null {
    if (this.accumulatedText.length === 0 && this.accumulatedThinking.length === 0) {
      return null;
    }
    return this.recordLastGoodSnapshot(this.accumulatedText, this.accumulatedThinking);
  }

  buildMessageSnapshot(): Message {
    const now = Date.now();
    return {
      id: this.messageId,
      remoteId: this.remoteMessageId,
      conversationId: this.conversationId,
      parentId: this.parentId,
      remoteParentId: this.remoteParentId,
      sourceRawStreamKey: this.sourceRawStreamKey,
      identityState: this.remoteMessageId ? 'provisional' : 'provisional',
      role: 'assistant',
      status: this.status,
      createdAt: this.lastFlushedAt || now,
      updatedAt: now,
    };
  }

  getRevisions(): ResponseRevision[] {
    return [...this.allRevisions];
  }

  getLastGoodRevision(): ResponseRevision | null {
    return this.lastGoodRevision;
  }

  getRecoveryEvents(): RecoveryEvent[] {
    return [...this.recoveryEvents];
  }

  reset(): void {
    this.accumulatedText = '';
    this.accumulatedThinking = '';
    this.status = 'streaming';
    this.revisionCount = 0;
    this.lastFlushedAt = 0;
    this.lastFlushedText = '';
    this.lastFlushedThinking = '';
    this.lastGoodRevision = null;
    this.recoveryEvents = [];
    this.allRevisions = [];
  }
}
