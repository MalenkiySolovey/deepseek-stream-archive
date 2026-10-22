import type { RawStreamRecord } from './types';
import type { ReplayResult } from './replay';

export type CanonicalPromotionIneligibilityReason =
  | 'raw_stream_not_intact'
  | 'durability_gap_present'
  | 'replay_integrity_compromised'
  | 'replay_sequence_anomalies'
  | 'missing_raw_batches';

export interface CanonicalPromotionEvaluation {
  eligible: boolean;
  reason?: CanonicalPromotionIneligibilityReason;
  streamKey: string;
  isCensored: boolean;
  terminalOutcome: 'finished' | 'filtered' | 'interrupted' | 'incomplete' | 'unknown';
  candidateText: string;
  candidateThinking: string;
  lastGoodText?: string;
  lastGoodThinking?: string;
}

/**
 * Evaluates whether a persisted raw stream is eligible for automatic promotion
 * into canonical Conversation/Message/ResponseRevision entities.
 *
 * Automatic promotion requires evidence to be intact with zero durability gaps
 * and clean replay continuity. Degraded or corrupted streams remain preserved
 * as forensic evidence in IndexedDB, but are not automatically promoted.
 *
 * Note: Terminal semantic conditions (e.g. CONTENT_FILTER) do NOT disqualify
 * an intact stream from canonical promotion; an intact filtered stream is the
 * primary candidate for anti-recall canonical recovery!
 */
export function evaluateCanonicalPromotion(
  rawStream: RawStreamRecord,
  replayResult: ReplayResult
): CanonicalPromotionEvaluation {
  const isCensored = replayResult.filterTriggered;

  // Classify semantic terminal outcome
  let terminalOutcome: 'finished' | 'filtered' | 'interrupted' | 'incomplete' | 'unknown' = 'unknown';
  if (isCensored) {
    terminalOutcome = 'filtered';
  } else if (rawStream.state === 'aborted') {
    terminalOutcome = 'interrupted';
  } else if (rawStream.state === 'error') {
    terminalOutcome = 'incomplete';
  } else if (replayResult.isComplete) {
    terminalOutcome = 'finished';
  } else {
    terminalOutcome = 'incomplete';
  }

  // Extract preserved last-good state if filtered
  let lastGoodText: string | undefined = undefined;
  let lastGoodThinking: string | undefined = undefined;
  if (isCensored) {
    for (const evt of replayResult.semanticEvents) {
      if (evt.type === 'filter_triggered' && evt.lastGood) {
        lastGoodText = evt.lastGood.answer;
        lastGoodThinking = evt.lastGood.thinking;
        break;
      }
    }
  }

  // 1. Raw stream integrity must be intact
  if (rawStream.integrity && rawStream.integrity !== 'intact') {
    return {
      eligible: false,
      reason: 'raw_stream_not_intact',
      streamKey: rawStream.id,
      isCensored,
      terminalOutcome,
      candidateText: replayResult.projectedAnswer,
      candidateThinking: replayResult.projectedThinking,
      lastGoodText,
      lastGoodThinking,
    };
  }

  // 2. Durability gap must be false/unset
  if (rawStream.durabilityGap) {
    return {
      eligible: false,
      reason: 'durability_gap_present',
      streamKey: rawStream.id,
      isCensored,
      terminalOutcome,
      candidateText: replayResult.projectedAnswer,
      candidateThinking: replayResult.projectedThinking,
      lastGoodText,
      lastGoodThinking,
    };
  }

  // 3. Replay integrity must be complete
  if (replayResult.integrity !== 'complete') {
    return {
      eligible: false,
      reason: 'replay_integrity_compromised',
      streamKey: rawStream.id,
      isCensored,
      terminalOutcome,
      candidateText: replayResult.projectedAnswer,
      candidateThinking: replayResult.projectedThinking,
      lastGoodText,
      lastGoodThinking,
    };
  }

  // 4. Audit anomalies check
  if (
    replayResult.audit &&
    (replayResult.audit.duplicateBatchSeq ||
      replayResult.audit.duplicateStreamSequence ||
      replayResult.audit.batchGap ||
      replayResult.audit.chunkGap ||
      replayResult.audit.foreignStreamKey ||
      replayResult.audit.invalidDeterministicId ||
      replayResult.audit.missingPrefix)
  ) {
    return {
      eligible: false,
      reason: 'replay_sequence_anomalies',
      streamKey: rawStream.id,
      isCensored,
      terminalOutcome,
      candidateText: replayResult.projectedAnswer,
      candidateThinking: replayResult.projectedThinking,
      lastGoodText,
      lastGoodThinking,
    };
  }

  return {
    eligible: true,
    streamKey: rawStream.id,
    isCensored,
    terminalOutcome,
    candidateText: replayResult.projectedAnswer,
    candidateThinking: replayResult.projectedThinking,
    lastGoodText,
    lastGoodThinking,
  };
}
