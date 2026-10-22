import type { ResponseRevision } from '../models';

export interface RevisionBufferState {
  currentMessageId: string;
  accumulatedText: string;
  accumulatedThinking: string;
  revisionCount: number;
  lastFlushedAt: number;
}

export interface RevisionRecorder {
  feedDelta(delta: { text?: string; thinking?: string }): void;
  shouldFlush(): boolean;
  flush(): ResponseRevision | null;
  markLastGood(): ResponseRevision | null;
  reset(): void;
}
