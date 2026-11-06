/**
 * Field-level record validation and canonical equality for Backup v1 records.
 *
 * Validates untrusted imported records against actual DB v8 schema requirements.
 * Rejects corrupt types, malformed structures, impossible numbers, and invalid enums.
 */

import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../core/models';
import type { RawStreamRecord, RawStreamBatch } from '../storage/raw-journal/types';
import type { IncludedBackupStoreName } from './format';

export interface RecordValidationResult<T> {
  valid: boolean;
  error?: string;
  record?: T;
}

const VALID_MESSAGE_ROLES = new Set(['user', 'assistant', 'system', 'unknown']);
const VALID_MESSAGE_STATUSES = new Set([
  'streaming',
  'finished',
  'filtered',
  'incomplete',
  'timeout',
  'context_length_exceeded',
  'interrupted',
  'degraded',
  'unknown',
]);
const VALID_IDENTITY_STATES = new Set(['provisional', 'reconciled']);
const VALID_PROJECTION_STATES = new Set([
  'logical',
  'provisional_logical',
  'unmatched_capture',
  'attempt_only',
]);
const VALID_CAPTURE_SOURCES = new Set(['network', 'history', 'dom', 'replay', 'synthetic']);
const VALID_RECOVERY_KINDS = new Set([
  'content_filter',
  'template_response',
  'network_interruption',
  'dom_replacement',
  'synthetic',
]);
const VALID_STREAM_TRANSPORTS = new Set(['fetch', 'xhr']);
const VALID_STREAM_STATES = new Set(['active', 'completed', 'aborted', 'error', 'degraded']);
const VALID_STREAM_INTEGRITIES = new Set(['intact', 'gap_detected', 'degraded', 'corrupt']);

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

function isPositiveNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val > 0;
}

function isNonNegativeNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

function isNonEmptyString(val: unknown): val is string {
  return typeof val === 'string' && val.trim().length > 0;
}

// ── Record Validators ──

export function validateConversationRecord(val: unknown): RecordValidationResult<Conversation> {
  if (!isObject(val)) return { valid: false, error: 'Conversation record must be an object' };
  if (!isNonEmptyString(val.id)) return { valid: false, error: 'Conversation requires non-empty string id' };
  if (typeof val.title !== 'string') return { valid: false, error: 'Conversation requires string title' };
  if (!isPositiveNumber(val.createdAt)) return { valid: false, error: 'Conversation requires positive finite createdAt' };
  if (!isNonNegativeNumber(val.updatedAt)) return { valid: false, error: 'Conversation requires non-negative finite updatedAt' };
  if (val.remoteId !== undefined && typeof val.remoteId !== 'string') {
    return { valid: false, error: 'Conversation remoteId must be string when defined' };
  }
  return { valid: true, record: val as unknown as Conversation };
}

export function validateMessageRecord(val: unknown): RecordValidationResult<Message> {
  if (!isObject(val)) return { valid: false, error: 'Message record must be an object' };
  if (!isNonEmptyString(val.id)) return { valid: false, error: 'Message requires non-empty string id' };
  if (!isNonEmptyString(val.conversationId)) return { valid: false, error: 'Message requires non-empty string conversationId' };
  if (typeof val.role !== 'string' || !VALID_MESSAGE_ROLES.has(val.role)) {
    return { valid: false, error: `Message invalid role: "${String(val.role)}"` };
  }
  if (typeof val.status !== 'string' || !VALID_MESSAGE_STATUSES.has(val.status)) {
    return { valid: false, error: `Message invalid status: "${String(val.status)}"` };
  }
  if (typeof val.identityState !== 'string' || !VALID_IDENTITY_STATES.has(val.identityState)) {
    return { valid: false, error: `Message invalid identityState: "${String(val.identityState)}"` };
  }
  if (!isPositiveNumber(val.createdAt)) return { valid: false, error: 'Message requires positive finite createdAt' };
  if (!isNonNegativeNumber(val.updatedAt)) return { valid: false, error: 'Message requires non-negative finite updatedAt' };

  if (val.parentId !== undefined && typeof val.parentId !== 'string') {
    return { valid: false, error: 'Message parentId must be string when defined' };
  }
  if (val.remoteId !== undefined && typeof val.remoteId !== 'string') {
    return { valid: false, error: 'Message remoteId must be string when defined' };
  }
  if (val.remoteParentId !== undefined && typeof val.remoteParentId !== 'string') {
    return { valid: false, error: 'Message remoteParentId must be string when defined' };
  }
  if (val.sourceRawStreamKey !== undefined && typeof val.sourceRawStreamKey !== 'string') {
    return { valid: false, error: 'Message sourceRawStreamKey must be string when defined' };
  }
  if (val.projectionState !== undefined && (typeof val.projectionState !== 'string' || !VALID_PROJECTION_STATES.has(val.projectionState))) {
    return { valid: false, error: `Message invalid projectionState: "${String(val.projectionState)}"` };
  }
  if (val.content !== undefined && typeof val.content !== 'string') {
    return { valid: false, error: 'Message content must be string when defined' };
  }
  if (val.remoteCreatedAt !== undefined && !isNonNegativeNumber(val.remoteCreatedAt)) {
    return { valid: false, error: 'Message remoteCreatedAt must be non-negative finite number when defined' };
  }

  return { valid: true, record: val as unknown as Message };
}

export function validateRevisionRecord(val: unknown): RecordValidationResult<ResponseRevision> {
  if (!isObject(val)) return { valid: false, error: 'Revision record must be an object' };
  if (!isNonEmptyString(val.id)) return { valid: false, error: 'Revision requires non-empty string id' };
  if (!isNonEmptyString(val.messageId)) return { valid: false, error: 'Revision requires non-empty string messageId' };
  if (typeof val.revisionIndex !== 'number' || !Number.isInteger(val.revisionIndex) || val.revisionIndex < 0) {
    return { valid: false, error: 'Revision requires non-negative integer revisionIndex' };
  }
  if (typeof val.text !== 'string') return { valid: false, error: 'Revision requires string text' };
  if (val.thinking !== undefined && typeof val.thinking !== 'string') {
    return { valid: false, error: 'Revision thinking must be string when defined' };
  }
  if (typeof val.source !== 'string' || !VALID_CAPTURE_SOURCES.has(val.source)) {
    return { valid: false, error: `Revision invalid source: "${String(val.source)}"` };
  }
  if (!isPositiveNumber(val.capturedAt)) return { valid: false, error: 'Revision requires positive finite capturedAt' };
  if (typeof val.isFinal !== 'boolean') return { valid: false, error: 'Revision requires boolean isFinal' };
  if (typeof val.isLastGood !== 'boolean') return { valid: false, error: 'Revision requires boolean isLastGood' };
  if (val.contentFingerprint !== undefined && typeof val.contentFingerprint !== 'string') {
    return { valid: false, error: 'Revision contentFingerprint must be string when defined' };
  }

  return { valid: true, record: val as unknown as ResponseRevision };
}

export function validateRecoveryEventRecord(val: unknown): RecordValidationResult<RecoveryEvent> {
  if (!isObject(val)) return { valid: false, error: 'RecoveryEvent record must be an object' };
  if (!isNonEmptyString(val.id)) return { valid: false, error: 'RecoveryEvent requires non-empty string id' };
  if (!isNonEmptyString(val.messageId)) return { valid: false, error: 'RecoveryEvent requires non-empty string messageId' };
  if (typeof val.kind !== 'string' || !VALID_RECOVERY_KINDS.has(val.kind)) {
    return { valid: false, error: `RecoveryEvent invalid kind: "${String(val.kind)}"` };
  }
  if (!isPositiveNumber(val.detectedAt)) return { valid: false, error: 'RecoveryEvent requires positive finite detectedAt' };
  if (!isNonEmptyString(val.recoveredRevisionId)) {
    return { valid: false, error: 'RecoveryEvent requires non-empty string recoveredRevisionId' };
  }
  if (val.reason !== undefined && typeof val.reason !== 'string') {
    return { valid: false, error: 'RecoveryEvent reason must be string when defined' };
  }

  return { valid: true, record: val as unknown as RecoveryEvent };
}

export function validateRawStreamRecord(val: unknown): RecordValidationResult<RawStreamRecord> {
  if (!isObject(val)) return { valid: false, error: 'RawStream record must be an object' };
  if (!isNonEmptyString(val.id)) return { valid: false, error: 'RawStream requires non-empty string id' };
  if (!isNonEmptyString(val.producerSessionId)) return { valid: false, error: 'RawStream requires non-empty producerSessionId' };
  if (!isNonEmptyString(val.streamId)) return { valid: false, error: 'RawStream requires non-empty streamId' };
  if (typeof val.transport !== 'string' || !VALID_STREAM_TRANSPORTS.has(val.transport)) {
    return { valid: false, error: `RawStream invalid transport: "${String(val.transport)}"` };
  }
  if (typeof val.url !== 'string') return { valid: false, error: 'RawStream requires string url' };
  if (typeof val.method !== 'string') return { valid: false, error: 'RawStream requires string method' };
  if (typeof val.state !== 'string' || !VALID_STREAM_STATES.has(val.state)) {
    return { valid: false, error: `RawStream invalid state: "${String(val.state)}"` };
  }
  if (!isPositiveNumber(val.openedAt)) return { valid: false, error: 'RawStream requires positive finite openedAt' };
  if (!isNonNegativeNumber(val.updatedAt)) return { valid: false, error: 'RawStream requires non-negative finite updatedAt' };
  if (!isNonNegativeNumber(val.totalChunks)) return { valid: false, error: 'RawStream requires non-negative finite totalChunks' };
  if (!isNonNegativeNumber(val.totalChars)) return { valid: false, error: 'RawStream requires non-negative finite totalChars' };
  if (!isNonNegativeNumber(val.totalBatches)) return { valid: false, error: 'RawStream requires non-negative finite totalBatches' };

  if (val.integrity !== undefined && (typeof val.integrity !== 'string' || !VALID_STREAM_INTEGRITIES.has(val.integrity))) {
    return { valid: false, error: `RawStream invalid integrity: "${String(val.integrity)}"` };
  }

  return { valid: true, record: val as unknown as RawStreamRecord };
}

export function validateRawStreamBatchRecord(val: unknown): RecordValidationResult<RawStreamBatch> {
  if (!isObject(val)) return { valid: false, error: 'RawStreamBatch record must be an object' };
  if (!isNonEmptyString(val.id)) return { valid: false, error: 'RawStreamBatch requires non-empty string id' };
  if (!isNonEmptyString(val.streamKey)) return { valid: false, error: 'RawStreamBatch requires non-empty string streamKey' };
  if (typeof val.batchSeq !== 'number' || !Number.isInteger(val.batchSeq) || val.batchSeq < 0) {
    return { valid: false, error: 'RawStreamBatch requires non-negative integer batchSeq' };
  }
  if (!Array.isArray(val.chunks)) return { valid: false, error: 'RawStreamBatch requires chunks array' };
  for (let c = 0; c < val.chunks.length; c++) {
    const chunk = val.chunks[c];
    if (!isObject(chunk)) return { valid: false, error: `RawStreamBatch chunk at ${c} must be an object` };
    if (typeof chunk.streamSequence !== 'number' || !Number.isInteger(chunk.streamSequence) || chunk.streamSequence < 0) {
      return { valid: false, error: `RawStreamBatch chunk at ${c} requires non-negative integer streamSequence` };
    }
    if (typeof chunk.chunkText !== 'string') return { valid: false, error: `RawStreamBatch chunk at ${c} requires string chunkText` };
    if (!isPositiveNumber(chunk.timestamp)) return { valid: false, error: `RawStreamBatch chunk at ${c} requires positive finite timestamp` };
  }
  if (!isPositiveNumber(val.createdAt)) return { valid: false, error: 'RawStreamBatch requires positive finite createdAt' };
  if (!isNonNegativeNumber(val.charCount)) return { valid: false, error: 'RawStreamBatch requires non-negative finite charCount' };

  return { valid: true, record: val as unknown as RawStreamBatch };
}

export function validateStoreRecord(
  store: IncludedBackupStoreName,
  value: unknown
): RecordValidationResult<unknown> {
  switch (store) {
    case 'conversations':
      return validateConversationRecord(value);
    case 'messages':
      return validateMessageRecord(value);
    case 'revisions':
      return validateRevisionRecord(value);
    case 'recovery_events':
      return validateRecoveryEventRecord(value);
    case 'raw_streams':
      return validateRawStreamRecord(value);
    case 'raw_stream_batches':
      return validateRawStreamBatchRecord(value);
    default:
      return { valid: false, error: `Unknown store "${String(store)}"` };
  }
}

// ── Canonical Semantic Equality ──

/**
 * Deterministic deep semantic equality check between two records of the same store.
 * Used during Merge to identify exact duplicates (to skip) versus conflicting updates (to reject).
 */
export function isRecordSemanticallyIdentical(
  store: IncludedBackupStoreName,
  a: unknown,
  b: unknown
): boolean {
  if (a === b) return true;
  if (!isObject(a) || !isObject(b)) return false;

  switch (store) {
    case 'conversations': {
      const convA = a as unknown as Conversation;
      const convB = b as unknown as Conversation;
      return (
        convA.id === convB.id &&
        (convA.remoteId ?? null) === (convB.remoteId ?? null) &&
        convA.title === convB.title &&
        convA.createdAt === convB.createdAt &&
        convA.updatedAt === convB.updatedAt
      );
    }

    case 'messages': {
      const msgA = a as unknown as Message;
      const msgB = b as unknown as Message;
      return (
        msgA.id === msgB.id &&
        msgA.conversationId === msgB.conversationId &&
        (msgA.remoteId ?? null) === (msgB.remoteId ?? null) &&
        (msgA.parentId ?? null) === (msgB.parentId ?? null) &&
        (msgA.remoteParentId ?? null) === (msgB.remoteParentId ?? null) &&
        (msgA.sourceRawStreamKey ?? null) === (msgB.sourceRawStreamKey ?? null) &&
        msgA.identityState === msgB.identityState &&
        (msgA.projectionState ?? null) === (msgB.projectionState ?? null) &&
        msgA.role === msgB.role &&
        msgA.status === msgB.status &&
        (msgA.content ?? null) === (msgB.content ?? null) &&
        msgA.createdAt === msgB.createdAt &&
        msgA.updatedAt === msgB.updatedAt
      );
    }

    case 'revisions': {
      const revA = a as unknown as ResponseRevision;
      const revB = b as unknown as ResponseRevision;
      return (
        revA.id === revB.id &&
        revA.messageId === revB.messageId &&
        revA.revisionIndex === revB.revisionIndex &&
        revA.text === revB.text &&
        (revA.thinking ?? null) === (revB.thinking ?? null) &&
        revA.source === revB.source &&
        revA.capturedAt === revB.capturedAt &&
        revA.isFinal === revB.isFinal &&
        revA.isLastGood === revB.isLastGood &&
        (revA.contentFingerprint ?? null) === (revB.contentFingerprint ?? null)
      );
    }

    case 'recovery_events': {
      const recA = a as unknown as RecoveryEvent;
      const recB = b as unknown as RecoveryEvent;
      return (
        recA.id === recB.id &&
        recA.messageId === recB.messageId &&
        recA.kind === recB.kind &&
        recA.detectedAt === recB.detectedAt &&
        recA.recoveredRevisionId === recB.recoveredRevisionId &&
        (recA.reason ?? null) === (recB.reason ?? null)
      );
    }

    case 'raw_streams': {
      const streamA = a as unknown as RawStreamRecord;
      const streamB = b as unknown as RawStreamRecord;
      return (
        streamA.id === streamB.id &&
        streamA.producerSessionId === streamB.producerSessionId &&
        streamA.streamId === streamB.streamId &&
        streamA.transport === streamB.transport &&
        streamA.url === streamB.url &&
        streamA.method === streamB.method &&
        streamA.state === streamB.state &&
        streamA.openedAt === streamB.openedAt &&
        streamA.totalChunks === streamB.totalChunks &&
        streamA.totalChars === streamB.totalChars &&
        streamA.totalBatches === streamB.totalBatches &&
        (streamA.terminalReason ?? null) === (streamB.terminalReason ?? null)
      );
    }

    case 'raw_stream_batches': {
      const batchA = a as unknown as RawStreamBatch;
      const batchB = b as unknown as RawStreamBatch;
      if (
        batchA.id !== batchB.id ||
        batchA.streamKey !== batchB.streamKey ||
        batchA.batchSeq !== batchB.batchSeq ||
        batchA.createdAt !== batchB.createdAt ||
        batchA.charCount !== batchB.charCount ||
        batchA.chunks.length !== batchB.chunks.length
      ) {
        return false;
      }
      for (let i = 0; i < batchA.chunks.length; i++) {
        const cA = batchA.chunks[i]!;
        const cB = batchB.chunks[i]!;
        if (
          cA.streamSequence !== cB.streamSequence ||
          cA.chunkText !== cB.chunkText ||
          cA.timestamp !== cB.timestamp
        ) {
          return false;
        }
      }
      return true;
    }

    default:
      return false;
  }
}

/**
 * Fast canonical deep structural equality comparison.
 * Compares objects, arrays, and primitive fields deterministically without allocating full string buffers.
 */
export function fastCanonicalEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) {
    return a === b;
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!fastCanonicalEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (Array.isArray(b)) return false;

  const recA = a as Record<string, unknown>;
  const recB = b as Record<string, unknown>;

  const keysA = Object.keys(recA).filter((k) => recA[k] !== undefined);
  const keysB = Object.keys(recB).filter((k) => recB[k] !== undefined);
  if (keysA.length !== keysB.length) return false;

  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(recB, k)) return false;
    if (!fastCanonicalEqual(recA[k], recB[k])) return false;
  }

  return true;
}

/**
 * Comprehensive deterministic deep equality for any database store record.
 * Validates domain-specific semantic invariants as well as full field-level structural parity.
 */
export function deepEqualRecords(store: string, a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isObject(a) || !isObject(b)) return a === b;

  if (
    store === 'conversations' ||
    store === 'messages' ||
    store === 'revisions' ||
    store === 'recovery_events' ||
    store === 'raw_streams' ||
    store === 'raw_stream_batches'
  ) {
    if (!isRecordSemanticallyIdentical(store, a, b)) {
      return false;
    }
  }

  return fastCanonicalEqual(a, b);
}
