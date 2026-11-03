import {
  isLogicalMessage,
  type Message,
  type ResponseRevision,
  type RecoveryEvent,
  selectPreferredRevision,
} from '../core/models';
import type {
  ContinuityDecisionReason,
  ContinuityRecoveryCause,
  ContinuityEligibilityResult,
} from './types';

export interface ContinuityEligibilityInput {
  message: Message;
  revisions: ResponseRevision[];
  recoveryEvents: RecoveryEvent[];
  activeBranchMessageIds: Set<string>;
  targetConversationId: string;
  serverHistoryAuthoritativeIds?: Set<string>;
  alreadyBridgedIds?: Set<string>;
}

/**
 * Pure forensic extractor for recovery cause.
 *
 * CRITICAL ARCHITECTURAL INVARIANT:
 * Recovery cause is informational metadata, NOT an eligibility gate.
 * Filtered, interrupted, stopped, and replaced responses are all treated
 * equally by the structural eligibility rules.
 */
export function getRecoveryCause(
  message: Message,
  recoveryEvents?: RecoveryEvent[]
): ContinuityRecoveryCause {
  // 1. Authoritative RecoveryEvent check
  if (recoveryEvents && recoveryEvents.length > 0) {
    const authEvent = recoveryEvents.find((e) => e.recoveredRevisionId) || recoveryEvents[0]!;
    if (authEvent.kind === 'content_filter') return 'content_filter';
    if (authEvent.kind === 'template_response') return 'template_response';

    const reason = (authEvent.reason || '').toLowerCase();
    if (reason.includes('user_stop') || reason.includes('stopped')) return 'user_stop';
    if (reason.includes('client_abort') || reason.includes('abort')) return 'client_abort';

    if (authEvent.kind === 'network_interruption') return 'network_interruption';
  }

  // 2. Message status check
  if (message.status === 'filtered') return 'content_filter';
  if (message.status === 'interrupted') return 'network_interruption';

  return 'unknown';
}

/**
 * Pure helper to locate the most authoritative usable revision.
 * Priority:
 * 1. Revision explicitly pointed to by authoritative RecoveryEvent.recoveredRevisionId.
 * 2. Uncensored Last-Good revision (isLastGood === true).
 * 3. Domain selectPreferredRevision policy.
 * 4. Latest revision with usable text or thinking.
 */
export function findUsableRevision(
  message: Message,
  revisions: ResponseRevision[],
  recoveryEvents?: RecoveryEvent[]
): ResponseRevision | null {
  if (!revisions || revisions.length === 0) {
    return null;
  }

  // 1. Explicit RecoveryEvent pointer
  if (recoveryEvents && recoveryEvents.length > 0) {
    for (const ev of recoveryEvents) {
      if (ev.recoveredRevisionId) {
        const rev = revisions.find((r) => r.id === ev.recoveredRevisionId);
        if (rev && (rev.text.trim().length > 0 || (rev.thinking && rev.thinking.trim().length > 0))) {
          return rev;
        }
      }
    }
  }

  // 2. Last-good revision
  const lastGood = revisions.filter((r) => r.isLastGood).at(-1);
  if (lastGood && (lastGood.text.trim().length > 0 || (lastGood.thinking && lastGood.thinking.trim().length > 0))) {
    return lastGood;
  }

  // 3. Preferred revision
  const preferred = selectPreferredRevision(message, revisions);
  if (preferred && (preferred.text.trim().length > 0 || (preferred.thinking && preferred.thinking.trim().length > 0))) {
    return preferred;
  }

  // 4. Latest revision with content
  for (let i = revisions.length - 1; i >= 0; i--) {
    const rev = revisions[i]!;
    if (rev.text.trim().length > 0 || (rev.thinking && rev.thinking.trim().length > 0)) {
      return rev;
    }
  }

  return null;
}

/**
 * Pure deterministic evaluator of Context Continuity eligibility.
 * Evaluates structural canonical invariants without side-effects or external I/O.
 */
export function evaluateContinuityEligibility(
  input: ContinuityEligibilityInput
): ContinuityEligibilityResult {
  const {
    message,
    revisions,
    recoveryEvents,
    activeBranchMessageIds,
    targetConversationId,
    serverHistoryAuthoritativeIds,
    alreadyBridgedIds,
  } = input;

  const recoveryCause = getRecoveryCause(message, recoveryEvents);

  // Condition 1: Conversation integrity
  if (message.conversationId !== targetConversationId) {
    return {
      eligible: false,
      reason: 'conversation_mismatch',
      recoveryCause,
    };
  }

  // Condition 2: Real logical assistant turn
  if (message.role !== 'assistant' || !isLogicalMessage(message)) {
    return {
      eligible: false,
      reason: 'not_logical_assistant',
      recoveryCause,
    };
  }

  // Condition 3: Active canonical branch ancestry
  if (!activeBranchMessageIds.has(message.id)) {
    return {
      eligible: false,
      reason: 'wrong_branch',
      recoveryCause,
    };
  }

  // Condition 4: Server History deduplication
  if (
    serverHistoryAuthoritativeIds?.has(message.id) ||
    (message.remoteId && serverHistoryAuthoritativeIds?.has(message.remoteId))
  ) {
    return {
      eligible: false,
      reason: 'already_in_server_history',
      recoveryCause,
    };
  }

  // Finished messages reconciled from server history already exist in DeepSeek context
  if (
    message.identityState === 'reconciled' &&
    message.status === 'finished' &&
    revisions.some((r) => r.source === 'history' && r.text.trim().length > 0)
  ) {
    return {
      eligible: false,
      reason: 'already_in_server_history',
      recoveryCause,
    };
  }

  // Condition 5: Downstream context bridging
  if (alreadyBridgedIds?.has(message.id)) {
    return {
      eligible: false,
      reason: 'already_bridged',
      recoveryCause,
    };
  }

  // Condition 6: Usable locally preserved content
  const candidateRevision = findUsableRevision(message, revisions, recoveryEvents);
  if (
    !candidateRevision ||
    (candidateRevision.text.trim().length === 0 &&
      (!candidateRevision.thinking || candidateRevision.thinking.trim().length === 0))
  ) {
    return {
      eligible: false,
      reason: 'no_usable_revision',
      recoveryCause,
    };
  }

  // All structural invariants satisfied
  return {
    eligible: true,
    reason: 'eligible',
    recoveryCause,
    candidateRevision,
  };
}
