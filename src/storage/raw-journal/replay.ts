import { GenericSseDecoder } from '../../transport/sse/decoder';
import { DeepSeekProtocolDecoder } from '../../adapters/deepseek/protocol/decoder';
import type {
  DeepSeekSemanticEvent,
  DeepSeekProtocolDiagnosticsData,
} from '../../adapters/deepseek/protocol/types';
import type {
  RawStreamBatch,
  RawStreamChunk,
  RawStreamRecord,
  ReplayIntegrity,
  ReplayAuditReport,
  ReplayTransportContext,
} from './types';

export interface ReplayOptions {
  provisionalSessionId?: string;
  transportContext?: ReplayTransportContext;
  streamRecord?: RawStreamRecord;
}

export interface ReplayResult {
  streamKey?: string;
  totalChunks: number;
  totalChars: number;
  sequenceGapsCount: number;
  integrity: ReplayIntegrity;
  audit: ReplayAuditReport;
  semanticEvents: DeepSeekSemanticEvent[];
  diagnostics: DeepSeekProtocolDiagnosticsData;
  projectedAnswer: string;
  projectedThinking: string;
  isComplete: boolean;
  filterTriggered: boolean;
}

/**
 * Pure, deterministic replay utility.
 * Reconstructs semantic events, text projection, and protocol diagnostics
 * directly from raw persisted journal batches by replaying through SSE & DeepSeek decoders.
 *
 * Enforces strict completion semantics:
 * - quasi_status is an intermediate status and NEVER marks a stream complete.
 * - Respects transportContext (aborts, errors, degraded flags).
 * - Validates batch and chunk sequence integrity in exact persisted order ('complete' | 'degraded' | 'corrupt').
 * - NEVER sorts away corruption or gaps.
 */
export function replayRawBatches(
  batches: RawStreamBatch[],
  options?: string | ReplayOptions
): ReplayResult {
  const provisionalSessionId =
    typeof options === 'string'
      ? options
      : options?.provisionalSessionId;
  const transportContext =
    typeof options === 'object' && options !== null
      ? options.transportContext
      : undefined;
  const streamRecord =
    typeof options === 'object' && options !== null
      ? options.streamRecord
      : undefined;

  const emptyAudit: ReplayAuditReport = {
    duplicateBatchSeq: false,
    duplicateStreamSequence: false,
    batchGap: false,
    chunkGap: false,
    foreignStreamKey: false,
    invalidDeterministicId: false,
    missingPrefix: false,
  };

  if (!batches || batches.length === 0) {
    return {
      streamKey: streamRecord?.id,
      totalChunks: 0,
      totalChars: 0,
      sequenceGapsCount: 0,
      integrity: 'complete',
      audit: emptyAudit,
      semanticEvents: [],
      diagnostics: {
        activeProfileId: 'deepseek-web-reference-2026-10',
        compatibilityState: 'not_observed',
        projectionSource: 'none',
        parsedFramesCount: 0,
        operationsCount: { set: 0, append: 0, replace: 0, batch: 0, other: 0 },
        currentAnswerLength: 0,
        currentThinkingLength: 0,
        filterEventsCount: 0,
        sequenceGapsCount: 0,
        orphanEventsCount: 0,
        duplicateOpensCount: 0,
        eventsAfterTerminalCount: 0,
        protocolWarningsCount: 0,
        finishControlObserved: false,
        closeControlObserved: false,
        unknownSseEndpoints: [],
        unknownSseEventNames: [],
        recentWarnings: [],
      },
      projectedAnswer: '',
      projectedThinking: '',
      isComplete: false,
      filterTriggered: false,
    };
  }

  // 1. Sort batches strictly by batchSeq (journal order) and audit integrity
  const sortedBatches = [...batches].sort((a, b) => a.batchSeq - b.batchSeq);
  const streamKey = streamRecord ? streamRecord.id : sortedBatches[0]?.streamKey;
  const streamId = streamRecord
    ? streamRecord.streamId
    : streamKey
      ? streamKey.split(':')[1] || streamKey
      : 'replay-stream';

  const audit: ReplayAuditReport = {
    duplicateBatchSeq: false,
    duplicateStreamSequence: false,
    batchGap: false,
    chunkGap: false,
    foreignStreamKey: false,
    invalidDeterministicId: false,
    missingPrefix: false,
  };

  if (sortedBatches.length > 0 && sortedBatches[0]?.batchSeq !== 1) {
    audit.missingPrefix = true;
  }

  const seenBatchSeqs = new Set<number>();
  for (let i = 0; i < sortedBatches.length; i++) {
    const b = sortedBatches[i]!;
    if (b.streamKey !== streamKey) {
      audit.foreignStreamKey = true;
    }
    if (b.id !== `${b.streamKey}:${b.batchSeq}`) {
      audit.invalidDeterministicId = true;
    }
    if (seenBatchSeqs.has(b.batchSeq)) {
      audit.duplicateBatchSeq = true;
    }
    seenBatchSeqs.add(b.batchSeq);

    if (i > 0) {
      const prevSeq = sortedBatches[i - 1]?.batchSeq ?? 0;
      if (b.batchSeq > prevSeq + 1) {
        audit.batchGap = true;
      }
    }
  }

  // 2. Extract chunks in exact persisted order without sorting corruption away!
  const allChunks: RawStreamChunk[] = [];
  let totalChars = 0;
  for (const b of sortedBatches) {
    totalChars += b.charCount;
    for (const chunk of b.chunks) {
      allChunks.push(chunk);
    }
  }

  // 3. Audit chunk sequence continuity in natural persisted order
  if (allChunks.length > 0 && allChunks[0]?.streamSequence !== 1) {
    audit.missingPrefix = true;
  }

  let sequenceGaps = 0;
  const seenStreamSeqs = new Set<number>();
  for (let i = 0; i < allChunks.length; i++) {
    const curr = allChunks[i]!;
    if (seenStreamSeqs.has(curr.streamSequence)) {
      audit.duplicateStreamSequence = true;
    }
    seenStreamSeqs.add(curr.streamSequence);

    if (i > 0) {
      const prev = allChunks[i - 1]!;
      if (curr.streamSequence !== prev.streamSequence + 1) {
        audit.chunkGap = true;
        sequenceGaps++;
      }
    }
  }

  // Determine integrity
  let integrity: ReplayIntegrity = 'complete';
  if (
    audit.foreignStreamKey ||
    audit.duplicateBatchSeq ||
    audit.duplicateStreamSequence ||
    streamRecord?.integrity === 'corrupt'
  ) {
    integrity = 'corrupt';
  } else if (
    audit.invalidDeterministicId ||
    audit.batchGap ||
    audit.chunkGap ||
    audit.missingPrefix ||
    sequenceGaps > 0 ||
    transportContext?.transportState === 'degraded' ||
    transportContext?.transportState === 'error' ||
    transportContext?.transportState === 'aborted' ||
    streamRecord?.state === 'degraded' ||
    streamRecord?.durabilityGap === true ||
    streamRecord?.integrity === 'gap_detected'
  ) {
    integrity = 'degraded';
  }

  // 4. Initialize decoders
  const sseDecoder = new GenericSseDecoder();
  const protocolDecoder = new DeepSeekProtocolDecoder(streamId, provisionalSessionId);

  const semanticEvents: DeepSeekSemanticEvent[] = [];
  let filterTriggered = false;

  // 5. Feed raw chunks sequentially
  for (const chunk of allChunks) {
    const sseFrames = sseDecoder.feed(chunk.chunkText);
    for (const frame of sseFrames) {
      const decodedEvents = protocolDecoder.feed(frame);
      for (const ev of decodedEvents) {
        semanticEvents.push(ev);
        if (ev.type === 'filter_triggered') {
          filterTriggered = true;
        }
      }
    }
  }

  // 6. Complete SSE & protocol streams
  const finalSse = sseDecoder.finish();
  for (const frame of finalSse) {
    const decodedEvents = protocolDecoder.feed(frame);
    for (const ev of decodedEvents) {
      semanticEvents.push(ev);
      if (ev.type === 'filter_triggered') {
        filterTriggered = true;
      }
    }
  }

  // Finalize protocol decoder according to authoritative transport context
  let terminalEvents: DeepSeekSemanticEvent[] = [];
  if (transportContext?.transportState === 'aborted') {
    terminalEvents = protocolDecoder.finish({
      kind: 'transport_abort',
      reason: transportContext.terminalReason || 'Transport aborted',
    });
  } else if (transportContext?.transportState === 'error') {
    terminalEvents = protocolDecoder.finish({
      kind: 'transport_error',
      error: transportContext.error || transportContext.terminalReason || 'Transport error',
    });
  } else if (transportContext?.transportState === 'degraded' || integrity === 'degraded') {
    terminalEvents = protocolDecoder.finish({
      kind: 'degraded',
      reason: transportContext?.terminalReason || 'Degraded stream integrity',
    });
  } else {
    terminalEvents = protocolDecoder.finish({ kind: 'transport_complete' });
  }

  for (const ev of terminalEvents) {
    semanticEvents.push(ev);
    if (ev.type === 'filter_triggered') {
      filterTriggered = true;
    }
  }

  const diagnostics = protocolDecoder.getDiagnostics();
  const projection = protocolDecoder.getProjectedContent();

  // Authoritative completion: strictly requires stream_finished with completed status
  // or authoritative protocol status 'FINISHED' without content filter recall.
  // CRITICAL: quasiStatus === 'FINISHED' NEVER indicates completion!
  const isComplete =
    !filterTriggered &&
    (semanticEvents.some(
      (e) => e.type === 'stream_finished' && e.status === 'completed' && e.terminalReason !== 'filtered'
    ) ||
      diagnostics.lastProtocolStatus === 'FINISHED');

  return {
    streamKey,
    totalChunks: allChunks.length,
    totalChars,
    sequenceGapsCount: sequenceGaps,
    integrity,
    audit,
    semanticEvents,
    diagnostics,
    projectedAnswer: projection.answer,
    projectedThinking: projection.thinking,
    isComplete,
    filterTriggered,
  };
}

/**
 * Replay utility taking a RawStreamRecord directly, avoiding fragile string-splitting on streamKey.
 */
export function replayRawStream(
  streamRecord: RawStreamRecord,
  batches: RawStreamBatch[],
  options?: Omit<ReplayOptions, 'streamRecord'>
): ReplayResult {
  return replayRawBatches(batches, {
    ...options,
    streamRecord,
  });
}
