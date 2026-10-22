import type { Conversation, Message, ResponseRevision } from '../models';
import type { SseEvent } from '../../transport/sse/types';

export interface SemanticStreamDelta {
  textDelta?: string;
  thinkingDelta?: string;
  isFinished?: boolean;
  isFiltered?: boolean;
  remoteMessageId?: string;
}

export interface PlatformAdapter {
  readonly platformId: string;
  readonly displayName: string;
  
  isCandidateStream(url: string, headers?: Record<string, string>): boolean;
  
  /**
   * Translates a cleanly parsed generic SSE event into platform semantic deltas.
   * Frame-level decoding (UTF-8, newlines, SSE field parsing) is handled upstream by generic transport.
   */
  parseSseEvent(event: SseEvent): SemanticStreamDelta | null;

  reconcileHistory?(historyPayload: unknown): {
    conversations: Conversation[];
    messages: Message[];
    revisions: ResponseRevision[];
  };
}
