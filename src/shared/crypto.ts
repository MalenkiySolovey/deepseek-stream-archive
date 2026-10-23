/**
 * Cryptographic helpers for StreamArchive.
 * Provides standard, deterministic SHA-256 calculation and canonical checkpoint serialization.
 * Uses Web Crypto API (globalThis.crypto.subtle) conforming to FIPS 180-4 and WHATWG Encoding standards.
 */

export async function computeSha256(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const hashBuf = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(hashBuf));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Deterministic JSON serialization ensuring stable property ordering for canonical fingerprinting.
 * Arrays preserve their semantic order; object keys are sorted alphabetically.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    if (obj[k] !== undefined) {
      entries.push(`${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
    }
  }
  return `{${entries.join(',')}}`;
}

export interface PersistedCanonicalCheckpointPayload {
  streamKey: string;
  checkpointSeq: number;
  isTerminal?: boolean;
  isFinal?: boolean;
  conversation?: {
    id: string;
    remoteId?: string;
    title?: string;
    createdAt?: number;
    updatedAt?: number;
  };
  message: {
    id: string;
    conversationId: string;
    remoteId?: string;
    role: string;
    status: string;
    content?: string;
    parentId?: string;
    remoteParentId?: string;
    identityState?: string;
    sourceRawStreamKey?: string;
    remoteCreatedAt?: number;
    createdAt?: number;
    updatedAt?: number;
  };
  revisions: Array<{
    id: string;
    messageId: string;
    revisionIndex: number;
    text: string;
    thinking?: string;
    source: string;
    capturedAt: number;
    isFinal: boolean;
    isLastGood: boolean;
    contentFingerprint?: string;
  }>;
  recoveryEvents?: Array<{
    id: string;
    messageId: string;
    kind: string;
    detectedAt: number;
    recoveredRevisionId?: string;
    reason?: string;
  }>;
}

export function serializeCanonicalCheckpointForFingerprint(
  input: PersistedCanonicalCheckpointPayload
): string {
  const normalized = {
    streamKey: input.streamKey,
    checkpointSeq: input.checkpointSeq,
    isTerminal: Boolean(input.isTerminal ?? input.isFinal),
    conversation: input.conversation
      ? {
          id: input.conversation.id,
          remoteId: input.conversation.remoteId ?? null,
          title: input.conversation.title ?? null,
          createdAt: input.conversation.createdAt ?? null,
          updatedAt: input.conversation.updatedAt ?? null,
        }
      : null,
    message: {
      id: input.message.id,
      conversationId: input.message.conversationId,
      remoteId: input.message.remoteId ?? null,
      role: input.message.role,
      status: input.message.status,
      content: input.message.content ?? null,
      parentId: input.message.parentId ?? null,
      remoteParentId: input.message.remoteParentId ?? null,
      identityState: input.message.identityState ?? null,
      sourceRawStreamKey: input.message.sourceRawStreamKey ?? null,
      remoteCreatedAt: input.message.remoteCreatedAt ?? null,
      createdAt: input.message.createdAt ?? null,
      updatedAt: input.message.updatedAt ?? null,
    },
    revisions: input.revisions.map((r) => ({
      id: r.id,
      messageId: r.messageId,
      revisionIndex: r.revisionIndex,
      text: r.text,
      thinking: r.thinking ?? null,
      source: r.source,
      capturedAt: r.capturedAt,
      isFinal: Boolean(r.isFinal),
      isLastGood: Boolean(r.isLastGood),
      contentFingerprint: r.contentFingerprint ?? null,
    })),
    recoveryEvents: (input.recoveryEvents || []).map((e) => ({
      id: e.id,
      messageId: e.messageId,
      kind: e.kind,
      detectedAt: e.detectedAt,
      recoveredRevisionId: e.recoveredRevisionId ?? null,
      reason: e.reason ?? null,
    })),
  };

  return canonicalStringify(normalized);
}

export async function computeCanonicalCheckpointFingerprint(
  input: PersistedCanonicalCheckpointPayload
): Promise<string> {
  const serialized = serializeCanonicalCheckpointForFingerprint(input);
  return computeSha256(serialized);
}

export function serializeHistoryStagingBatchForFingerprint(batch: {
  stagingId: string;
  batchIndex: number;
  session?: unknown;
  messages: unknown[];
}): string {
  return canonicalStringify({
    stagingId: batch.stagingId,
    batchIndex: batch.batchIndex,
    session: batch.session ?? null,
    messages: batch.messages,
  });
}

