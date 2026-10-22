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
 * - For filtered messages: prefers uncensored lastGood revision (recovery view).
 * - For normal messages: prefers latest valid history revision -> latest valid network revision -> replay revision.
 */
export function selectPreferredRevision(
  message: import('./message').Message,
  revisions: ResponseRevision[]
): ResponseRevision | null {
  if (!revisions || revisions.length === 0) {
    return null;
  }

  // If message was filtered, prefer uncensored lastGood revision
  if (message.status === 'filtered') {
    const lastGood = revisions.filter((r) => r.isLastGood).at(-1);
    if (lastGood) {
      return lastGood;
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

