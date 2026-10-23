import {
  BRIDGE_SOURCE_TAG,
  BRIDGE_PROTOCOL_VERSION,
  type BridgeEventType,
  type StreamArchiveBridgeEnvelope,
  type SyntheticTestPayload,
} from './protocol';
import type { TransportEvent, TransportKind, TransportEventType } from '../transport/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ALLOWED_TYPES = new Set<BridgeEventType>([
  'bridge.ready',
  'stream.chunk',
  'stream.complete',
  'stream.abort',
  'transport.event',
  'synthetic.test',
  'history.observation',
  'history.open',
  'history.chunk',
  'history.complete',
  'history.abort',
]);

const VALID_TRANSPORTS = new Set<TransportKind>(['fetch', 'xhr']);
const VALID_EVENT_TYPES = new Set<TransportEventType>(['open', 'chunk', 'complete', 'abort', 'error']);

export const MAX_ID_CHARS = 128;
export const MAX_METHOD_CHARS = 16;
export const MAX_URL_CHARS = 1024;
export const MAX_REASON_CHARS = 256;

export function validateBridgeEnvelope(raw: unknown): StreamArchiveBridgeEnvelope | null {
  if (!isRecord(raw)) return null;

  if (raw.source !== BRIDGE_SOURCE_TAG) return null;
  if (raw.protocolVersion !== BRIDGE_PROTOCOL_VERSION) return null;
  if (
    typeof raw.eventId !== 'string' ||
    raw.eventId.trim().length === 0 ||
    raw.eventId.length > MAX_ID_CHARS
  ) {
    return null;
  }
  if (typeof raw.type !== 'string' || !ALLOWED_TYPES.has(raw.type as BridgeEventType)) return null;
  if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp) || raw.timestamp <= 0) return null;
  if (!('payload' in raw)) return null;

  return {
    source: BRIDGE_SOURCE_TAG,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    eventId: raw.eventId,
    type: raw.type as BridgeEventType,
    timestamp: raw.timestamp,
    payload: raw.payload,
  };
}

export function validateSyntheticPayload(payload: unknown): SyntheticTestPayload | null {
  if (!isRecord(payload)) return null;

  if (typeof payload.testId !== 'string' || payload.testId.trim().length === 0) return null;
  if (typeof payload.conversationTitle !== 'string' || payload.conversationTitle.trim().length === 0) return null;
  if (typeof payload.promptText !== 'string') return null;
  if (typeof payload.responseText !== 'string' || payload.responseText.trim().length === 0) return null;
  if (payload.source !== 'synthetic') return null;

  return {
    testId: payload.testId,
    conversationTitle: payload.conversationTitle,
    promptText: payload.promptText,
    responseText: payload.responseText,
    source: 'synthetic',
  };
}

export function validateTransportEventPayload(payload: unknown): TransportEvent | null {
  if (!isRecord(payload)) return null;

  if (
    typeof payload.producerSessionId !== 'string' ||
    payload.producerSessionId.trim().length === 0 ||
    payload.producerSessionId.length > MAX_ID_CHARS ||
    payload.producerSessionId.includes(':')
  ) {
    return null;
  }
  if (
    typeof payload.streamId !== 'string' ||
    payload.streamId.trim().length === 0 ||
    payload.streamId.length > MAX_ID_CHARS ||
    payload.streamId.includes(':')
  ) {
    return null;
  }
  if (
    typeof payload.sequence !== 'number' ||
    !Number.isInteger(payload.sequence) ||
    payload.sequence < 0
  ) {
    return null;
  }
  if (typeof payload.timestamp !== 'number' || !Number.isFinite(payload.timestamp) || payload.timestamp <= 0) {
    return null;
  }
  if (typeof payload.transport !== 'string' || !VALID_TRANSPORTS.has(payload.transport as TransportKind)) {
    return null;
  }
  if (typeof payload.type !== 'string' || !VALID_EVENT_TYPES.has(payload.type as TransportEventType)) {
    return null;
  }

  if (
    typeof payload.streamSequence !== 'number' ||
    !Number.isInteger(payload.streamSequence) ||
    payload.streamSequence < 0
  ) {
    return null;
  }

  const result: TransportEvent = {
    producerSessionId: payload.producerSessionId,
    streamId: payload.streamId,
    sequence: payload.sequence,
    streamSequence: payload.streamSequence,
    timestamp: payload.timestamp,
    transport: payload.transport as TransportKind,
    type: payload.type as TransportEventType,
  };

  if (payload.type === 'chunk') {
    if (typeof payload.chunkText !== 'string' || payload.chunkText.length > MAX_BRIDGE_CHUNK_CHARS) return null;
    result.chunkText = payload.chunkText;
  }

  if (payload.metadata !== undefined) {
    if (!isRecord(payload.metadata)) return null;
    if (
      typeof payload.metadata.method !== 'string' ||
      payload.metadata.method.trim().length === 0 ||
      payload.metadata.method.length > MAX_METHOD_CHARS ||
      typeof payload.metadata.url !== 'string' ||
      payload.metadata.url.trim().length === 0 ||
      payload.metadata.url.length > MAX_URL_CHARS
    ) {
      return null;
    }
    result.metadata = {
      method: payload.metadata.method,
      url: payload.metadata.url,
      status: typeof payload.metadata.status === 'number' ? payload.metadata.status : undefined,
      statusText: typeof payload.metadata.statusText === 'string' ? payload.metadata.statusText : undefined,
      contentType: typeof payload.metadata.contentType === 'string' ? payload.metadata.contentType : undefined,
    };
  }

  if (payload.reason !== undefined) {
    if (typeof payload.reason !== 'string' || payload.reason.length > MAX_REASON_CHARS) return null;
    result.reason = payload.reason;
  }

  return result;
}

export const MAX_RAW_BATCH_CHARS = 131072; // 128 KiB
export const MAX_RAW_BATCH_CHUNKS = 500;
export const MAX_RAW_CHUNK_CHARS = 65536; // 64 KiB
export const MAX_BRIDGE_CHUNK_CHARS = 65536; // 64 KiB

export function sanitizeStreamUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, 'https://chat.deepseek.com');
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return rawUrl.split('?')[0]?.split('#')[0] || rawUrl;
  }
}

export function validateRawStreamChunk(raw: unknown): import('../storage/raw-journal/types').RawStreamChunk | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.streamSequence !== 'number' || !Number.isInteger(raw.streamSequence) || raw.streamSequence < 0) return null;
  if (typeof raw.chunkText !== 'string' || raw.chunkText.length > MAX_RAW_CHUNK_CHARS) return null;
  if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp) || raw.timestamp <= 0) return null;

  return {
    streamSequence: raw.streamSequence,
    chunkText: raw.chunkText,
    timestamp: raw.timestamp,
  };
}


export function validateRawStreamBatch(raw: unknown): import('../storage/raw-journal/types').RawStreamBatch | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0) return null;
  if (typeof raw.streamKey !== 'string' || raw.streamKey.trim().length === 0) return null;
  if (typeof raw.batchSeq !== 'number' || !Number.isInteger(raw.batchSeq) || raw.batchSeq <= 0) return null;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt) || raw.createdAt <= 0) return null;
  if (typeof raw.charCount !== 'number' || !Number.isInteger(raw.charCount) || raw.charCount < 0) return null;

  // Invariant: Deterministic ID must equal `${streamKey}:${batchSeq}`
  if (raw.id !== `${raw.streamKey}:${raw.batchSeq}`) return null;

  // Composite key format: exactly one colon separating producer and stream id
  const keyParts = raw.streamKey.split(':');
  if (
    keyParts.length !== 2 ||
    !keyParts[0] ||
    !keyParts[1] ||
    keyParts[0].length > MAX_ID_CHARS ||
    keyParts[1].length > MAX_ID_CHARS
  ) {
    return null;
  }

  // Invariant: Hard bounds on batch size
  if (raw.charCount > MAX_RAW_BATCH_CHARS) return null;
  if (!Array.isArray(raw.chunks) || raw.chunks.length === 0 || raw.chunks.length > MAX_RAW_BATCH_CHUNKS) return null;

  const validChunks: import('../storage/raw-journal/types').RawStreamChunk[] = [];
  let calculatedChars = 0;
  let prevSequence = -1;

  for (let i = 0; i < raw.chunks.length; i++) {
    const chunk = validateRawStreamChunk(raw.chunks[i]);
    if (!chunk) return null;

    // Invariant: Sequences within a batch must be strictly increasing
    if (i > 0 && chunk.streamSequence <= prevSequence) {
      return null;
    }

    prevSequence = chunk.streamSequence;
    calculatedChars += chunk.chunkText.length;
    validChunks.push(chunk);
  }

  // Invariant: charCount must exactly equal sum of chunks' chunkText lengths
  if (raw.charCount !== calculatedChars) return null;

  return {
    id: raw.id,
    streamKey: raw.streamKey,
    batchSeq: raw.batchSeq,
    chunks: validChunks,
    createdAt: raw.createdAt,
    charCount: raw.charCount,
  };
}

export function validatePersistRawStreamOpenRequest(
  raw: unknown
): import('./messages').PersistRawStreamOpenRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN') return null;
  if (
    typeof raw.producerSessionId !== 'string' ||
    raw.producerSessionId.trim().length === 0 ||
    raw.producerSessionId.length > MAX_ID_CHARS ||
    raw.producerSessionId.includes(':')
  ) {
    return null;
  }
  if (
    typeof raw.streamId !== 'string' ||
    raw.streamId.trim().length === 0 ||
    raw.streamId.length > MAX_ID_CHARS ||
    raw.streamId.includes(':')
  ) {
    return null;
  }
  if (typeof raw.transport !== 'string' || !VALID_TRANSPORTS.has(raw.transport as TransportKind)) return null;
  if (typeof raw.url !== 'string' || raw.url.trim().length === 0 || raw.url.length > MAX_URL_CHARS) return null;
  if (typeof raw.method !== 'string' || raw.method.trim().length === 0 || raw.method.length > MAX_METHOD_CHARS) return null;
  if (typeof raw.openedAt !== 'number' || !Number.isFinite(raw.openedAt) || raw.openedAt <= 0) return null;

  const provisionalSessionId =
    typeof raw.provisionalSessionId === 'string' &&
    raw.provisionalSessionId.trim().length > 0 &&
    raw.provisionalSessionId.length <= MAX_ID_CHARS
      ? raw.provisionalSessionId
      : undefined;

  const captureProfileId =
    typeof raw.captureProfileId === 'string' &&
    raw.captureProfileId.trim().length > 0 &&
    raw.captureProfileId.length <= MAX_ID_CHARS
      ? raw.captureProfileId
      : undefined;

  const streamSequence =
    typeof raw.streamSequence === 'number' && Number.isInteger(raw.streamSequence) && raw.streamSequence >= 0
      ? raw.streamSequence
      : undefined;

  const integrity =
    typeof raw.integrity === 'string' &&
    VALID_RAW_STREAM_INTEGRITIES.has(raw.integrity as import('../storage/raw-journal/types').RawStreamIntegrity)
      ? (raw.integrity as import('../storage/raw-journal/types').RawStreamIntegrity)
      : undefined;

  return {
    type: 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN',
    producerSessionId: raw.producerSessionId,
    streamId: raw.streamId,
    transport: raw.transport as TransportKind,
    url: sanitizeStreamUrl(raw.url),
    method: raw.method,
    provisionalSessionId,
    captureProfileId,
    openedAt: raw.openedAt,
    streamSequence,
    integrity,
  };
}

export function validatePersistRawBatchRequest(
  raw: unknown
): import('./messages').PersistRawBatchRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_PERSIST_RAW_BATCH') return null;

  const batch = validateRawStreamBatch(raw.batch);
  if (!batch) return null;

  return {
    type: 'STREAMARCHIVE_PERSIST_RAW_BATCH',
    batch,
  };
}

const VALID_RAW_STREAM_STATES = new Set<import('../storage/raw-journal/types').RawStreamState>([
  'active',
  'completed',
  'aborted',
  'error',
  'degraded',
]);

const VALID_RAW_STREAM_INTEGRITIES = new Set<import('../storage/raw-journal/types').RawStreamIntegrity>([
  'intact',
  'gap_detected',
  'degraded',
  'corrupt',
]);

export function validateFinalizeRawStreamRequest(
  raw: unknown
): import('./messages').FinalizeRawStreamRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_FINALIZE_RAW_STREAM') return null;
  if (typeof raw.streamKey !== 'string' || raw.streamKey.trim().length === 0) return null;

  const keyParts = raw.streamKey.split(':');
  if (
    keyParts.length !== 2 ||
    !keyParts[0] ||
    !keyParts[1] ||
    keyParts[0].length > MAX_ID_CHARS ||
    keyParts[1].length > MAX_ID_CHARS
  ) {
    return null;
  }

  if (
    typeof raw.finalState !== 'string' ||
    !VALID_RAW_STREAM_STATES.has(raw.finalState as import('../storage/raw-journal/types').RawStreamState)
  ) {
    return null;
  }

  if (typeof raw.terminalReason === 'string' && raw.terminalReason.length > MAX_REASON_CHARS) {
    return null;
  }
  if (typeof raw.error === 'string' && raw.error.length > MAX_REASON_CHARS) {
    return null;
  }

  const terminalReason = typeof raw.terminalReason === 'string' ? raw.terminalReason : undefined;
  const error = typeof raw.error === 'string' ? raw.error : undefined;
  const droppedChars =
    typeof raw.droppedChars === 'number' && Number.isFinite(raw.droppedChars) && raw.droppedChars >= 0
      ? raw.droppedChars
      : undefined;
  const durabilityGap = typeof raw.durabilityGap === 'boolean' ? raw.durabilityGap : undefined;
  const integrity =
    typeof raw.integrity === 'string' &&
    VALID_RAW_STREAM_INTEGRITIES.has(raw.integrity as import('../storage/raw-journal/types').RawStreamIntegrity)
      ? (raw.integrity as import('../storage/raw-journal/types').RawStreamIntegrity)
      : undefined;

  return {
    type: 'STREAMARCHIVE_FINALIZE_RAW_STREAM',
    streamKey: raw.streamKey,
    finalState: raw.finalState as import('../storage/raw-journal/types').RawStreamState,
    terminalReason,
    error,
    droppedChars,
    durabilityGap,
    integrity,
  };
}

export function validatePersistRawStreamOpenResponse(
  raw: unknown
): import('./messages').PersistRawStreamOpenResponse | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.success !== 'boolean') return null;
  const streamKey = typeof raw.streamKey === 'string' ? raw.streamKey : '';
  if (streamKey.length > MAX_ID_CHARS * 2 + 1) return null;
  const openedAt = typeof raw.openedAt === 'number' && Number.isFinite(raw.openedAt) ? raw.openedAt : undefined;
  const errorCode = typeof raw.errorCode === 'string' ? (raw.errorCode as import('../storage/raw-journal/types').RawJournalErrorCode) : undefined;
  const error = typeof raw.error === 'string' ? raw.error : undefined;

  return {
    success: raw.success,
    streamKey,
    openedAt,
    errorCode,
    error,
  };
}

export function validatePersistRawBatchResponse(
  raw: unknown
): import('./messages').PersistRawBatchResponse | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.success !== 'boolean') return null;
  const streamKey = typeof raw.streamKey === 'string' ? raw.streamKey : '';
  if (streamKey.length > MAX_ID_CHARS * 2 + 1) return null;
  const batchSeq = typeof raw.batchSeq === 'number' && Number.isInteger(raw.batchSeq) ? raw.batchSeq : -1;
  const persistedAt = typeof raw.persistedAt === 'number' && Number.isFinite(raw.persistedAt) ? raw.persistedAt : undefined;
  const errorCode = typeof raw.errorCode === 'string' ? (raw.errorCode as import('../storage/raw-journal/types').RawJournalErrorCode) : undefined;
  const error = typeof raw.error === 'string' ? raw.error : undefined;

  return {
    success: raw.success,
    streamKey,
    batchSeq,
    persistedAt,
    errorCode,
    error,
  };
}

export function validateFinalizeRawStreamResponse(
  raw: unknown
): import('./messages').FinalizeRawStreamResponse | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.success !== 'boolean') return null;
  const streamKey = typeof raw.streamKey === 'string' ? raw.streamKey : '';
  if (streamKey.length > MAX_ID_CHARS * 2 + 1) return null;
  const finalState = typeof raw.finalState === 'string' && VALID_RAW_STREAM_STATES.has(raw.finalState as any) ? (raw.finalState as import('../storage/raw-journal/types').RawStreamState) : undefined;
  const finalizedAt = typeof raw.finalizedAt === 'number' && Number.isFinite(raw.finalizedAt) ? raw.finalizedAt : undefined;
  const errorCode = typeof raw.errorCode === 'string' ? (raw.errorCode as import('../storage/raw-journal/types').RawJournalErrorCode) : undefined;
  const error = typeof raw.error === 'string' ? raw.error : undefined;

  return {
    success: raw.success,
    streamKey,
    finalState,
    finalizedAt,
    errorCode,
    error,
  };
}

export function validateHistoryObservationPayload(
  raw: unknown
): import('./protocol').HistoryObservationPayload | null {
  if (!isRecord(raw)) return null;

  if (typeof raw.url !== 'string' || raw.url.length === 0 || raw.url.length > MAX_URL_CHARS) {
    return null;
  }
  if (
    typeof raw.sessionId !== 'string' ||
    raw.sessionId.length === 0 ||
    raw.sessionId.length > MAX_ID_CHARS
  ) {
    return null;
  }
  if (typeof raw.status !== 'number' || !Number.isInteger(raw.status)) {
    return null;
  }
  if (typeof raw.body !== 'string' || raw.body.length > 25 * 1024 * 1024) {
    return null;
  }
  if (
    typeof raw.timestamp !== 'number' ||
    !Number.isFinite(raw.timestamp) ||
    raw.timestamp <= 0
  ) {
    return null;
  }

  return {
    url: raw.url,
    sessionId: raw.sessionId,
    status: raw.status,
    body: raw.body,
    timestamp: raw.timestamp,
  };
}

export const MAX_HISTORY_CHUNK_CHARS = 65536; // 64 KiB
export const MAX_HISTORY_TOTAL_CHARS = 25 * 1024 * 1024; // 25 MB
export const MAX_HISTORY_CHUNKS_COUNT = 1000;

export function validateHistoryStreamOpenPayload(
  raw: unknown
): import('./protocol').HistoryStreamOpenPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.historyId !== 'string' || raw.historyId.trim().length === 0 || raw.historyId.length > MAX_ID_CHARS) return null;
  if (typeof raw.url !== 'string' || raw.url.length === 0 || raw.url.length > MAX_URL_CHARS) return null;
  if (typeof raw.sessionId !== 'string' || raw.sessionId.length > MAX_ID_CHARS) return null;
  if (typeof raw.status !== 'number' || !Number.isInteger(raw.status)) return null;
  if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp) || raw.timestamp <= 0) return null;
  const totalChars = typeof raw.totalChars === 'number' && Number.isInteger(raw.totalChars) && raw.totalChars >= 0 ? raw.totalChars : undefined;
  if (totalChars !== undefined && totalChars > MAX_HISTORY_TOTAL_CHARS) return null;

  return {
    historyId: raw.historyId.trim(),
    url: raw.url,
    sessionId: raw.sessionId.trim(),
    status: raw.status,
    timestamp: raw.timestamp,
    totalChars,
  };
}

export function validateHistoryStreamChunkPayload(
  raw: unknown
): import('./protocol').HistoryStreamChunkPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.historyId !== 'string' || raw.historyId.trim().length === 0 || raw.historyId.length > MAX_ID_CHARS) return null;
  if (typeof raw.chunkIndex !== 'number' || !Number.isInteger(raw.chunkIndex) || raw.chunkIndex < 0 || raw.chunkIndex >= MAX_HISTORY_CHUNKS_COUNT) return null;
  if (typeof raw.chunkText !== 'string' || raw.chunkText.length > MAX_HISTORY_CHUNK_CHARS) return null;

  return {
    historyId: raw.historyId.trim(),
    chunkIndex: raw.chunkIndex,
    chunkText: raw.chunkText,
  };
}

export function validateHistoryStreamCompletePayload(
  raw: unknown
): import('./protocol').HistoryStreamCompletePayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.historyId !== 'string' || raw.historyId.trim().length === 0 || raw.historyId.length > MAX_ID_CHARS) return null;
  if (typeof raw.totalChars !== 'number' || !Number.isInteger(raw.totalChars) || raw.totalChars < 0 || raw.totalChars > MAX_HISTORY_TOTAL_CHARS) return null;
  if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp) || raw.timestamp <= 0) return null;

  return {
    historyId: raw.historyId.trim(),
    totalChars: raw.totalChars,
    timestamp: raw.timestamp,
  };
}

export function validateHistoryStreamAbortPayload(
  raw: unknown
): import('./protocol').HistoryStreamAbortPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.historyId !== 'string' || raw.historyId.trim().length === 0 || raw.historyId.length > MAX_ID_CHARS) return null;
  const reason = typeof raw.reason === 'string' && raw.reason.length <= MAX_REASON_CHARS ? raw.reason : undefined;

  return {
    historyId: raw.historyId.trim(),
    reason,
  };
}

export function validateConversation(raw: unknown): import('../core/models').Conversation | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0 || raw.id.length > MAX_ID_CHARS) return null;
  if (typeof raw.title !== 'string' || raw.title.length > 500) return null;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt) || raw.createdAt <= 0) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt <= 0) return null;
  const remoteId = typeof raw.remoteId === 'string' && raw.remoteId.trim().length > 0 && raw.remoteId.length <= MAX_ID_CHARS ? raw.remoteId.trim() : undefined;

  return {
    id: raw.id.trim(),
    title: raw.title,
    remoteId,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

const VALID_MESSAGE_ROLES = new Set<import('../core/models').MessageRole>([
  'user',
  'assistant',
  'system',
  'unknown',
]);

const VALID_MESSAGE_STATUSES = new Set<import('../core/models').MessageStatus>([
  'streaming',
  'finished',
  'filtered',
  'incomplete',
  'interrupted',
  'timeout',
  'context_length_exceeded',
  'degraded',
  'unknown',
]);

const VALID_IDENTITY_STATES = new Set<import('../core/models').MessageIdentityState>([
  'provisional',
  'reconciled',
]);

export function validateMessage(raw: unknown): import('../core/models').Message | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0 || raw.id.length > MAX_ID_CHARS) return null;
  if (typeof raw.conversationId !== 'string' || raw.conversationId.trim().length === 0 || raw.conversationId.length > MAX_ID_CHARS) return null;
  if (typeof raw.role !== 'string' || !VALID_MESSAGE_ROLES.has(raw.role as any)) return null;
  if (typeof raw.status !== 'string' || !VALID_MESSAGE_STATUSES.has(raw.status as any)) return null;
  if (typeof raw.identityState !== 'string' || !VALID_IDENTITY_STATES.has(raw.identityState as any)) return null;
  if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt) || raw.createdAt <= 0) return null;
  if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt) || raw.updatedAt <= 0) return null;

  const remoteId = typeof raw.remoteId === 'string' && raw.remoteId.trim().length > 0 && raw.remoteId.length <= MAX_ID_CHARS ? raw.remoteId.trim() : undefined;
  const parentId = typeof raw.parentId === 'string' && raw.parentId.trim().length > 0 && raw.parentId.length <= MAX_ID_CHARS ? raw.parentId.trim() : undefined;
  const remoteParentId = typeof raw.remoteParentId === 'string' && raw.remoteParentId.trim().length > 0 && raw.remoteParentId.length <= MAX_ID_CHARS ? raw.remoteParentId.trim() : undefined;
  const sourceRawStreamKey = typeof raw.sourceRawStreamKey === 'string' && raw.sourceRawStreamKey.trim().length > 0 && raw.sourceRawStreamKey.length <= MAX_ID_CHARS * 2 + 1 ? raw.sourceRawStreamKey.trim() : undefined;
  const content = typeof raw.content === 'string' ? raw.content : undefined;
  const remoteCreatedAt = typeof raw.remoteCreatedAt === 'number' && Number.isFinite(raw.remoteCreatedAt) ? raw.remoteCreatedAt : undefined;

  return {
    id: raw.id.trim(),
    conversationId: raw.conversationId.trim(),
    role: raw.role as import('../core/models').MessageRole,
    status: raw.status as import('../core/models').MessageStatus,
    identityState: raw.identityState as import('../core/models').MessageIdentityState,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    remoteId,
    parentId,
    remoteParentId,
    sourceRawStreamKey,
    content,
    remoteCreatedAt,
  };
}

const VALID_REVISION_SOURCES = new Set<import('../core/models').CaptureSource>([
  'network',
  'history',
  'replay',
  'synthetic',
]);

export function validateResponseRevision(raw: unknown): import('../core/models').ResponseRevision | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0 || raw.id.length > MAX_ID_CHARS) return null;
  if (typeof raw.messageId !== 'string' || raw.messageId.trim().length === 0 || raw.messageId.length > MAX_ID_CHARS) return null;
  if (typeof raw.revisionIndex !== 'number' || !Number.isInteger(raw.revisionIndex) || raw.revisionIndex < 0) return null;
  if (typeof raw.text !== 'string') return null;
  if (typeof raw.source !== 'string' || !VALID_REVISION_SOURCES.has(raw.source as any)) return null;
  if (typeof raw.capturedAt !== 'number' || !Number.isFinite(raw.capturedAt) || raw.capturedAt <= 0) return null;
  if (typeof raw.isFinal !== 'boolean') return null;
  if (typeof raw.isLastGood !== 'boolean') return null;

  const thinking = typeof raw.thinking === 'string' ? raw.thinking : undefined;
  const contentFingerprint =
    typeof raw.contentFingerprint === 'string' && raw.contentFingerprint.trim().length <= MAX_ID_CHARS
      ? raw.contentFingerprint.trim()
      : undefined;

  return {
    id: raw.id.trim(),
    messageId: raw.messageId.trim(),
    revisionIndex: raw.revisionIndex,
    text: raw.text,
    thinking,
    source: raw.source as import('../core/models').CaptureSource,
    capturedAt: raw.capturedAt,
    isFinal: raw.isFinal,
    isLastGood: raw.isLastGood,
    contentFingerprint,
  };
}

const VALID_RECOVERY_EVENT_KINDS = new Set<import('../core/models').RecoveryKind>([
  'content_filter',
  'template_response',
  'network_interruption',
  'dom_replacement',
  'synthetic',
]);

export function validateRecoveryEvent(raw: unknown): import('../core/models').RecoveryEvent | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || raw.id.trim().length === 0 || raw.id.length > MAX_ID_CHARS) return null;
  if (typeof raw.messageId !== 'string' || raw.messageId.trim().length === 0 || raw.messageId.length > MAX_ID_CHARS) return null;
  if (typeof raw.kind !== 'string' || !VALID_RECOVERY_EVENT_KINDS.has(raw.kind as any)) return null;
  if (typeof raw.detectedAt !== 'number' || !Number.isFinite(raw.detectedAt) || raw.detectedAt <= 0) return null;
  if (typeof raw.recoveredRevisionId !== 'string' || raw.recoveredRevisionId.trim().length === 0 || raw.recoveredRevisionId.length > MAX_ID_CHARS) return null;

  const reason = typeof raw.reason === 'string' && raw.reason.length <= MAX_REASON_CHARS ? raw.reason : undefined;

  return {
    id: raw.id.trim(),
    messageId: raw.messageId.trim(),
    kind: raw.kind as import('../core/models').RecoveryKind,
    detectedAt: raw.detectedAt,
    recoveredRevisionId: raw.recoveredRevisionId.trim(),
    reason,
  };
}

export function validatePersistCanonicalCheckpointRequest(
  raw: unknown
): import('./messages').PersistCanonicalCheckpointRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_PERSIST_CANONICAL_CHECKPOINT') return null;
  if (!isRecord(raw.checkpoint)) return null;

  const cp = raw.checkpoint;
  if (typeof cp.streamKey !== 'string' || cp.streamKey.trim().length === 0 || cp.streamKey.length > MAX_ID_CHARS * 2 + 1) return null;
  if (typeof cp.checkpointSeq !== 'number' || !Number.isInteger(cp.checkpointSeq) || cp.checkpointSeq < 0) return null;

  const message = validateMessage(cp.message);
  if (!message) return null;

  const conversation =
    cp.conversation !== undefined
      ? validateConversation(cp.conversation) || undefined
      : undefined;
  if (cp.conversation !== undefined && !conversation) return null;

  if (!Array.isArray(cp.revisions)) return null;
  const revisions: import('../core/models').ResponseRevision[] = [];
  for (const r of cp.revisions) {
    const validRev = validateResponseRevision(r);
    if (!validRev) return null;
    revisions.push(validRev);
  }

  let recoveryEvents: import('../core/models').RecoveryEvent[] | undefined = undefined;
  if (Array.isArray(cp.recoveryEvents)) {
    recoveryEvents = [];
    for (const ev of cp.recoveryEvents) {
      const validEv = validateRecoveryEvent(ev);
      if (!validEv) return null;
      recoveryEvents.push(validEv);
    }
  }

  const isTerminal = typeof cp.isTerminal === 'boolean' ? cp.isTerminal : typeof (cp as any).isFinal === 'boolean' ? (cp as any).isFinal : undefined;

  return {
    type: 'STREAMARCHIVE_PERSIST_CANONICAL_CHECKPOINT',
    checkpoint: {
      streamKey: cp.streamKey.trim(),
      checkpointSeq: cp.checkpointSeq,
      isTerminal,
      conversation,
      message,
      revisions,
      recoveryEvents,
    },
  };
}

export function validatePersistCanonicalCheckpointResponse(
  raw: unknown
): import('./messages').PersistCanonicalCheckpointResponse | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.success !== 'boolean') return null;
  const streamKey = typeof raw.streamKey === 'string' ? raw.streamKey : '';
  const checkpointSeq = typeof raw.checkpointSeq === 'number' && Number.isInteger(raw.checkpointSeq) ? raw.checkpointSeq : -1;
  const persistedAt = typeof raw.persistedAt === 'number' && Number.isFinite(raw.persistedAt) ? raw.persistedAt : undefined;
  const error = typeof raw.error === 'string' ? raw.error : undefined;

  return {
    success: raw.success,
    streamKey,
    checkpointSeq,
    persistedAt,
    error,
  };
}

export function validateListArchiveConversationsRequest(
  raw: unknown
): import('./messages').ListArchiveConversationsRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_LIST_ARCHIVE_CONVERSATIONS') return null;

  let options: { limit?: number; cursor?: string } | undefined = undefined;
  if (isRecord(raw.options)) {
    const limit = typeof raw.options.limit === 'number' && Number.isInteger(raw.options.limit)
      ? Math.max(1, Math.min(raw.options.limit, 100))
      : undefined;
    const cursor = typeof raw.options.cursor === 'string' && raw.options.cursor.trim().length > 0
      ? raw.options.cursor.trim()
      : undefined;
    options = { limit, cursor };
  }

  return {
    type: 'STREAMARCHIVE_LIST_ARCHIVE_CONVERSATIONS',
    options,
  };
}

export function validateGetArchiveConversationRequest(
  raw: unknown
): import('./messages').GetArchiveConversationRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_GET_ARCHIVE_CONVERSATION') return null;
  if (typeof raw.conversationId !== 'string' || raw.conversationId.trim().length === 0 || raw.conversationId.length > MAX_ID_CHARS) return null;

  return {
    type: 'STREAMARCHIVE_GET_ARCHIVE_CONVERSATION',
    conversationId: raw.conversationId.trim(),
  };
}

export function validateGetRevisionContentRequest(
  raw: unknown
): import('./messages').GetRevisionContentRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_GET_REVISION_CONTENT') return null;
  if (typeof raw.revisionId !== 'string' || raw.revisionId.trim().length === 0 || raw.revisionId.length > MAX_ID_CHARS) return null;

  return {
    type: 'STREAMARCHIVE_GET_REVISION_CONTENT',
    revisionId: raw.revisionId.trim(),
  };
}

export function validateHistoryIngestOpenRequest(
  raw: unknown
): import('./messages').HistoryIngestOpenRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_HISTORY_INGEST_OPEN') return null;
  if (typeof raw.stagingId !== 'string' || raw.stagingId.trim().length === 0) return null;
  if (typeof raw.sessionId !== 'string' || raw.sessionId.trim().length === 0) return null;
  if (typeof raw.totalBatches !== 'number' || !Number.isInteger(raw.totalBatches) || raw.totalBatches < 1) return null;
  if (typeof raw.totalMessages !== 'number' || !Number.isInteger(raw.totalMessages) || raw.totalMessages < 0) return null;
  if (typeof raw.timestamp !== 'number' || !Number.isFinite(raw.timestamp)) return null;

  return {
    type: 'STREAMARCHIVE_HISTORY_INGEST_OPEN',
    stagingId: raw.stagingId.trim(),
    sessionId: raw.sessionId.trim(),
    totalBatches: raw.totalBatches,
    totalMessages: raw.totalMessages,
    timestamp: raw.timestamp,
  };
}

export function validateHistoryIngestBatchRequest(
  raw: unknown
): import('./messages').HistoryIngestBatchRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_HISTORY_INGEST_BATCH') return null;
  if (typeof raw.stagingId !== 'string' || raw.stagingId.trim().length === 0) return null;
  if (typeof raw.batchIndex !== 'number' || !Number.isInteger(raw.batchIndex) || raw.batchIndex < 0) return null;
  if (!Array.isArray(raw.messages)) return null;

  return {
    type: 'STREAMARCHIVE_HISTORY_INGEST_BATCH',
    stagingId: raw.stagingId.trim(),
    batchIndex: raw.batchIndex,
    session: raw.session as any,
    messages: raw.messages as any,
  };
}

export function validateHistoryIngestCommitRequest(
  raw: unknown
): import('./messages').HistoryIngestCommitRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_HISTORY_INGEST_COMMIT') return null;
  if (typeof raw.stagingId !== 'string' || raw.stagingId.trim().length === 0) return null;

  return {
    type: 'STREAMARCHIVE_HISTORY_INGEST_COMMIT',
    stagingId: raw.stagingId.trim(),
  };
}

export function validateHistoryIngestAbortRequest(
  raw: unknown
): import('./messages').HistoryIngestAbortRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_HISTORY_INGEST_ABORT') return null;
  if (typeof raw.stagingId !== 'string' || raw.stagingId.trim().length === 0) return null;

  return {
    type: 'STREAMARCHIVE_HISTORY_INGEST_ABORT',
    stagingId: raw.stagingId.trim(),
    reason: typeof raw.reason === 'string' ? raw.reason : undefined,
  };
}

export function validateGetPageRecoverySummaryRequest(
  raw: unknown
): import('./messages').GetPageRecoverySummaryRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_GET_PAGE_RECOVERY_SUMMARY') return null;
  const currentRouteSessionId =
    typeof raw.currentRouteSessionId === 'string' && raw.currentRouteSessionId.trim().length > 0
      ? raw.currentRouteSessionId.trim()
      : undefined;

  return {
    type: 'STREAMARCHIVE_GET_PAGE_RECOVERY_SUMMARY',
    currentRouteSessionId,
  };
}

export function validateGetPageRecoveryContentRequest(
  raw: unknown
): import('./messages').GetPageRecoveryContentRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.type !== 'STREAMARCHIVE_GET_PAGE_RECOVERY_CONTENT') return null;
  if (typeof raw.currentRouteSessionId !== 'string' || !raw.currentRouteSessionId.trim()) return null;
  if (typeof raw.messageId !== 'string' || !raw.messageId.trim()) return null;

  return {
    type: 'STREAMARCHIVE_GET_PAGE_RECOVERY_CONTENT',
    currentRouteSessionId: raw.currentRouteSessionId.trim(),
    messageId: raw.messageId.trim(),
    recoveryEventId: typeof raw.recoveryEventId === 'string' && raw.recoveryEventId.trim() ? raw.recoveryEventId.trim() : undefined,
  };
}



