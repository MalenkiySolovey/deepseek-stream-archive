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
  private remoteParentId?: string;
  private readonly sourceRawStreamKey?: string;
  private readonly source: CaptureSource;
  private readonly flushIntervalMs: number;
  private readonly minCharsForFlush: number;

  private accumulatedText = '';
  private accumulatedThinking = '';
  private lastMeaningfulText = '';
  private lastMeaningfulThinking = '';
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

  setRemoteParentId(id: string): void {
    if (id && typeof id === 'string' && id.trim().length > 0) {
      this.remoteParentId = id.trim();
    }
  }

  feedDelta(delta: { text?: string; thinking?: string }): void {
    if (delta.text) {
      this.accumulatedText += delta.text;
      if (this.accumulatedText.trim().length > 0) {
        this.lastMeaningfulText = this.accumulatedText;
      }
    }
    if (delta.thinking) {
      this.accumulatedThinking += delta.thinking;
      if (this.accumulatedThinking.trim().length > 0) {
        this.lastMeaningfulThinking = this.accumulatedThinking;
      }
    }
  }

  feedSemanticEvent(event: DeepSeekSemanticEvent): void {
    switch (event.type) {
      case 'message_id_identified':
        if (event.messageId) {
          this.setRemoteMessageId(event.messageId);
        }
        if (event.requestMessageId) {
          this.setRemoteParentId(event.requestMessageId);
        }
        break;

      case 'answer_delta':
        if (event.delta) {
          this.accumulatedText += event.delta;
          if (this.accumulatedText.trim().length > 0) {
            this.lastMeaningfulText = this.accumulatedText;
          }
        }
        break;

      case 'answer_replace':
        if (event.fullText !== undefined) {
          this.accumulatedText = event.fullText;
          if (this.accumulatedText.trim().length > 0) {
            this.lastMeaningfulText = this.accumulatedText;
          }
        }
        break;

      case 'thinking_delta':
        if (event.delta) {
          this.accumulatedThinking += event.delta;
          if (this.accumulatedThinking.trim().length > 0) {
            this.lastMeaningfulThinking = this.accumulatedThinking;
          }
        }
        break;

      case 'thinking_replace':
        if (event.fullText !== undefined) {
          this.accumulatedThinking = event.fullText;
          if (this.accumulatedThinking.trim().length > 0) {
            this.lastMeaningfulThinking = this.accumulatedThinking;
          }
        }
        break;

      case 'filter_triggered':
        this.status = 'filtered';
        if (this.lastGoodRevision) {
          // Duplicate protection: filter incident already recorded for this stream
          break;
        }

        {
          let candidateAnswer = '';
          let candidateThinking = '';

          const eventHasAnswer = Boolean(event.lastGood?.answer && event.lastGood.answer.trim().length > 0);
          const eventHasThinking = Boolean(event.lastGood?.thinking && event.lastGood.thinking.trim().length > 0);

          if (eventHasAnswer) {
            candidateAnswer = event.lastGood!.answer;
            candidateThinking = event.lastGood!.thinking || '';
          } else {
            // Priority 2: search earlier revisions for latest meaningful visible answer
            const revsWithAnswer = this.allRevisions.filter((r) => r.text && r.text.trim().length > 0);
            if (revsWithAnswer.length > 0) {
              const bestRev = revsWithAnswer[revsWithAnswer.length - 1]!;
              candidateAnswer = bestRev.text;
              candidateThinking =
                bestRev.thinking ||
                (eventHasThinking
                  ? event.lastGood!.thinking!
                  : this.accumulatedThinking || this.lastMeaningfulThinking);
            } else if (this.accumulatedText.trim().length > 0) {
              candidateAnswer = this.accumulatedText;
              candidateThinking = this.accumulatedThinking;
            } else if (this.lastMeaningfulText.trim().length > 0) {
              candidateAnswer = this.lastMeaningfulText;
              candidateThinking = this.lastMeaningfulThinking;
            } else if (eventHasThinking) {
              // Thinking-only candidate
              candidateAnswer = '';
              candidateThinking = event.lastGood!.thinking!;
            } else {
              // Priority 3: earlier revisions with thinking only
              const revsWithThinking = this.allRevisions.filter((r) => r.thinking && r.thinking.trim().length > 0);
              if (revsWithThinking.length > 0) {
                const bestRev = revsWithThinking[revsWithThinking.length - 1]!;
                candidateAnswer = '';
                candidateThinking = bestRev.thinking!;
              } else if (this.accumulatedThinking.trim().length > 0) {
                candidateAnswer = '';
                candidateThinking = this.accumulatedThinking;
              } else if (this.lastMeaningfulThinking.trim().length > 0) {
                candidateAnswer = '';
                candidateThinking = this.lastMeaningfulThinking;
              }
            }
          }

          if (candidateAnswer.trim().length > 0 || candidateThinking.trim().length > 0) {
            this.recordLastGoodSnapshot(candidateAnswer, candidateThinking, event.reason);
          }
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
    if (this.status === 'filtered') {
      return;
    }
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
    if (this.status === 'filtered') {
      return;
    }
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
    // Invariant: Empty stream attempts must NEVER produce 0-char ResponseRevision records
    if (this.accumulatedText === '' && this.accumulatedThinking === '') {
      return null;
    }

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

  recordLastGoodSnapshot(answer: string, thinking: string, reason?: string): ResponseRevision | null {
    if (this.lastGoodRevision) {
      return this.lastGoodRevision;
    }
    const cleanAnswer = (answer || '').trim();
    const cleanThinking = (thinking || '').trim();
    if (cleanAnswer.length === 0 && cleanThinking.length === 0) {
      return null;
    }

    const now = Date.now();
    const revIdx = this.revisionCount++;
    const revision: ResponseRevision = {
      id: `rev_lastgood_${this.messageId}_${revIdx}`,
      messageId: this.messageId,
      revisionIndex: revIdx,
      text: answer,
      thinking: cleanThinking.length > 0 ? thinking : undefined,
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
    if (this.accumulatedText.trim().length > 0 || this.accumulatedThinking.trim().length > 0) {
      return this.recordLastGoodSnapshot(this.accumulatedText, this.accumulatedThinking);
    }
    if (this.lastMeaningfulText.trim().length > 0 || this.lastMeaningfulThinking.trim().length > 0) {
      return this.recordLastGoodSnapshot(this.lastMeaningfulText, this.lastMeaningfulThinking);
    }
    return null;
  }

  buildMessageSnapshot(): Message {
    const now = Date.now();
    const hasContent = this.accumulatedText.length > 0 || this.accumulatedThinking.length > 0;
    const isTerminalAttempt =
      this.status === 'interrupted' ||
      this.status === 'degraded' ||
      this.status === 'incomplete' ||
      this.status === 'unknown';

    let projectionState: import('../models').MessageProjectionState;
    if (!hasContent && !this.remoteMessageId && this.recoveryEvents.length === 0 && isTerminalAttempt) {
      projectionState = 'attempt_only';
    } else {
      projectionState = 'provisional_logical';
    }

    return {
      id: this.messageId,
      remoteId: this.remoteMessageId,
      conversationId: this.conversationId,
      parentId: projectionState === 'attempt_only' ? undefined : this.parentId,
      remoteParentId: this.remoteParentId,
      sourceRawStreamKey: this.sourceRawStreamKey,
      identityState: 'provisional',
      projectionState,
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
    this.lastMeaningfulText = '';
    this.lastMeaningfulThinking = '';
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
