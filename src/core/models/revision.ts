import type { CaptureSource } from './source';

export interface ResponseRevision {
  id: string;
  messageId: string;
  revisionIndex: number;
  text: string;
  thinking?: string;
  source: CaptureSource;
  capturedAt: number;
  isFinal: boolean;
  isLastGood: boolean;
  contentFingerprint?: string;
}

export function computeContentFingerprint(
  text: string,
  thinking?: string,
  status?: string,
  source?: string
): string {
  const normText = text.trim();
  const normThinking = (thinking || '').trim();
  const normStatus = (status || '').toLowerCase().trim();
  const normSource = (source || '').toLowerCase().trim();
  const payload = `${normText}::${normThinking}::${normStatus}::${normSource}`;

  // 64-bit deterministic hash (DJB2 + SDBM combined)
  let h1 = 5381;
  let h2 = 0;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charCodeAt(i);
    h1 = ((h1 << 5) + h1 + ch) | 0;
    h2 = (ch + (h2 << 6) + (h2 << 16) - h2) | 0;
  }
  return `fp_${payload.length}_${(h1 >>> 0).toString(16)}_${(h2 >>> 0).toString(16)}`;
}

/**
 * Pure preferred revision selection policy.
 * - For filtered messages: prefers uncensored lastGood revision (recovery view) with meaningful content.
 *   Read-time legacy repair: if isLastGood revision was recorded empty due to premature destructive clearing,
 *   falls back to the latest meaningful network revision for that message.
 * - For normal messages: prefers latest valid history revision -> latest valid network revision -> replay revision.
 */
export function selectPreferredRevision(
  message: import('./message').Message,
  revisions: ResponseRevision[]
): ResponseRevision | null {
  if (!revisions || revisions.length === 0) {
    return null;
  }

  // If message was filtered, prefer uncensored lastGood revision with meaningful content
  if (message.status === 'filtered' || revisions.some((r) => r.isLastGood)) {
    // 1. Explicit uncensored lastGood with visible answer
    const lastGoodWithAnswer = revisions
      .filter((r) => r.isLastGood && r.text && r.text.trim().length > 0)
      .at(-1);
    if (lastGoodWithAnswer) {
      return lastGoodWithAnswer;
    }

    // 2. Read-time legacy repair: if lastGood was 0 chars or missing, check if earlier network revision had visible answer
    const networkWithAnswer = [...revisions]
      .reverse()
      .find((r) => r.source === 'network' && r.text && r.text.trim().length > 0);
    if (networkWithAnswer) {
      return networkWithAnswer;
    }

    // 3. Uncensored lastGood with thinking only
    const lastGoodWithThinking = revisions
      .filter((r) => r.isLastGood && r.thinking && r.thinking.trim().length > 0)
      .at(-1);
    if (lastGoodWithThinking) {
      return lastGoodWithThinking;
    }

    // 4. Network with thinking only
    const networkWithThinking = [...revisions]
      .reverse()
      .find((r) => r.source === 'network' && r.thinking && r.thinking.trim().length > 0);
    if (networkWithThinking) {
      return networkWithThinking;
    }
  }

  // 1. Latest valid history revision
  const historyRevs = revisions.filter((r) => r.source === 'history');
  if (historyRevs.length > 0) {
    return historyRevs[historyRevs.length - 1]!;
  }

  // 2. Latest valid network revision
  const networkRevs = revisions.filter((r) => r.source === 'network');
  if (networkRevs.length > 0) {
    return networkRevs[networkRevs.length - 1]!;
  }

  // 3. Eligible replay revision
  const replayRevs = revisions.filter((r) => r.source === 'replay');
  if (replayRevs.length > 0) {
    return replayRevs[replayRevs.length - 1]!;
  }

  return revisions[revisions.length - 1] || null;
}

export function isRevisionPayloadIdentical(a: ResponseRevision, b: ResponseRevision): boolean {
  return (
    a.messageId === b.messageId &&
    a.text === b.text &&
    (a.thinking || '') === (b.thinking || '') &&
    a.source === b.source &&
    a.isFinal === b.isFinal &&
    a.isLastGood === b.isLastGood
  );
}

export function isRecoveryEventIdentical(
  a: import('./recovery-event').RecoveryEvent,
  b: import('./recovery-event').RecoveryEvent
): boolean {
  return (
    a.messageId === b.messageId &&
    a.kind === b.kind &&
    a.recoveredRevisionId === b.recoveredRevisionId &&
    (a.reason || '') === (b.reason || '')
  );
}

