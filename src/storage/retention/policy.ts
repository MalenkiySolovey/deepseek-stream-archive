/**
 * Pure Raw Evidence Retention Policy Engine.
 *
 * Implements deterministic evaluation with zero side-effects and clock injection.
 * Protects pre-filter recovery provenance and forensic anomalies indefinitely.
 */

import type { RawStreamRecord } from '../raw-journal/types';
import type { RawRetentionDecision, RawRetentionMode } from './types';

export interface RetentionEvaluationContext {
  mode: RawRetentionMode;
  now: number;
  isActive: boolean;
  hasFilterStatus?: boolean;
  hasRecoveryEvent?: boolean;
  hasLastGoodRevision?: boolean;
  isUnmatchedCapture?: boolean;
}

/**
 * Calculates the exact millisecond cutoff boundary for a given retention mode.
 * Returns undefined if retention is disabled ('forever').
 */
export function getCutoffTimestamp(mode: RawRetentionMode, now: number): number | undefined {
  if (mode === 'forever') {
    return undefined;
  }
  const days = Number.parseInt(mode, 10);
  if (Number.isNaN(days) || days <= 0) {
    return undefined;
  }
  return now - days * 24 * 60 * 60 * 1000;
}

/**
 * Evaluates whether a raw stream is eligible for automatic age-pruning.
 *
 * Protected Evidence Shield:
 * - Active streams: ALWAYS PROTECTED.
 * - Recovery provenance (filtered status, RecoveryEvent, isLastGood): ALWAYS PROTECTED.
 * - Forensic anomalies (degraded integrity, durability gap, dropped chars, aborts, errors, unmatched captures): ALWAYS PROTECTED.
 * - Streams younger than cutoff: PROTECTED.
 * - Streams older than cutoff with intact integrity and no anomalies: ELIGIBLE.
 */
export function evaluateRawStreamRetention(
  stream: RawStreamRecord,
  context: RetentionEvaluationContext
): RawRetentionDecision {
  const streamKey = stream.id;

  // 1. Retention disabled (forever default)
  if (context.mode === 'forever') {
    return {
      eligible: false,
      reason: 'retention_disabled',
      streamKey,
    };
  }

  // 2. Active stream shield
  if (context.isActive || stream.state === 'active') {
    return {
      eligible: false,
      reason: 'active',
      streamKey,
    };
  }

  // 3. Recovery provenance shield
  if (context.hasFilterStatus || context.hasRecoveryEvent || context.hasLastGoodRevision) {
    return {
      eligible: false,
      reason: 'recovery_protected',
      streamKey,
    };
  }

  // 4. Forensic anomaly & integrity shield
  const hasIntegrityAnomaly = stream.integrity && stream.integrity !== 'intact';
  const hasDurabilityGap = stream.durabilityGap === true;
  const hasDroppedChars = (stream.droppedChars ?? 0) > 0;
  const hasTerminalErrorState =
    stream.state === 'aborted' ||
    stream.state === 'error' ||
    stream.state === 'degraded';
  const hasRecordedError = Boolean(stream.error && stream.error.trim().length > 0);
  const isUnmatched = context.isUnmatchedCapture === true;

  if (
    hasIntegrityAnomaly ||
    hasDurabilityGap ||
    hasDroppedChars ||
    hasTerminalErrorState ||
    hasRecordedError ||
    isUnmatched
  ) {
    return {
      eligible: false,
      reason: 'forensic_protected',
      streamKey,
    };
  }

  // 5. Age evaluation against cutoff
  const cutoff = getCutoffTimestamp(context.mode, context.now);
  if (cutoff === undefined || stream.openedAt > cutoff) {
    return {
      eligible: false,
      reason: 'too_recent',
      streamKey,
    };
  }

  // 6. Eligible for pruning
  return {
    eligible: true,
    reason: 'expired_safe',
    streamKey,
  };
}
