export type RawStreamState = 'active' | 'completed' | 'aborted' | 'error' | 'degraded';

export type RawStreamIntegrity = 'intact' | 'gap_detected' | 'degraded' | 'corrupt';

export type RawJournalErrorCode =
  | 'stream_not_open'
  | 'batch_id_conflict'
  | 'batch_sequence_gap'
  | 'chunk_sequence_gap'
  | 'finalize_conflict'
  | 'invalid_stream_identity'
  | 'capacity_exceeded'
  | 'stream_identity_conflict'
  | 'quota_exceeded'
  | 'transaction_abort'
  | 'database_unavailable'
  | 'invalid_batch'
  | 'invalid_ack'
  | 'invalid_request'
  | 'unauthorized_origin'
  | 'stream_degraded';

/**
 * RawStreamRecord represents the transport-level capture metadata for an HTTP response stream.
 *
 * NOTE: `state` describes the TRANSPORT persistence lifecycle ('active' | 'completed' | 'aborted' | 'error' | 'degraded'),
 * NOT DeepSeek semantic completion of the assistant answer.
 */
export interface RawStreamRecord {
  id: string; // composite key: `${producerSessionId}:${streamId}`
  producerSessionId: string;
  streamId: string;
  transport: 'fetch' | 'xhr';
  url: string; // sanitized origin + pathname only (NO query string, NO hash)
  method: string;
  provisionalSessionId?: string;
  captureProfileId?: string;
  state: RawStreamState;
  openedAt: number;
  updatedAt: number;
  finalizedAt?: number;
  totalChunks: number;
  totalChars: number;
  totalBatches: number;
  terminalReason?: string;
  error?: string;
  droppedChars?: number;
  durabilityGap?: boolean;
  lastBatchAt?: number;
  lastPersistedBatchSeq?: number;
  lastPersistedStreamSequence?: number;
  lastPersistedAt?: number;
  integrity?: RawStreamIntegrity;
}

export interface RawStreamChunk {
  streamSequence: number;
  chunkText: string;
  timestamp: number;
}

export interface RawStreamBatch {
  id: string; // deterministic key: `${streamKey}:${batchSeq}`
  streamKey: string; // matches RawStreamRecord.id
  batchSeq: number; // 1-indexed monotonic per stream
  chunks: RawStreamChunk[];
  createdAt: number;
  charCount: number;
}

export interface StoredRawStreamBatch extends RawStreamBatch {
  persistedAt: number;
}

export interface RawJournalMetadata {
  streamCount: number;
  activeStreamCount: number;
  totalBatchesCount: number;
  totalCharsCount: number;
  lastPersistedAt?: number;
  estimatedUsage?: number;
  estimatedQuota?: number;
  storagePersistence?: 'granted' | 'not_granted' | 'unsupported' | 'unknown';
}

export type ReplayIntegrity = 'complete' | 'degraded' | 'corrupt';

export interface ReplayAuditReport {
  duplicateBatchSeq: boolean;
  duplicateStreamSequence: boolean;
  batchGap: boolean;
  chunkGap: boolean;
  foreignStreamKey: boolean;
  invalidDeterministicId: boolean;
  missingPrefix: boolean;
}

export interface ReplayTransportContext {
  transportState?: RawStreamState;
  terminalReason?: string;
  error?: string;
}

