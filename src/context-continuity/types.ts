import type { Message, ResponseRevision, RecoveryEvent } from '../core/models';

/**
 * Structural reasons for why a message is either eligible or excluded
 * from participation in Context Continuity.
 */
export type ContinuityDecisionReason =
  | 'eligible'
  | 'wrong_branch'
  | 'not_logical_assistant'
  | 'no_usable_revision'
  | 'already_in_server_history'
  | 'already_bridged'
  | 'duplicate_identity'
  | 'conversation_mismatch';

/**
 * Known recovery causes representing historical / forensic provenance.
 * INVARIANT: Recovery cause is forensic metadata, NOT an eligibility filter!
 */
export type ContinuityRecoveryCause =
  | 'content_filter'
  | 'template_response'
  | 'network_interruption'
  | 'user_stop'
  | 'client_abort'
  | 'other'
  | 'unknown';

/**
 * Result of evaluating a single message for Context Continuity eligibility.
 */
export interface ContinuityEligibilityResult {
  eligible: boolean;
  reason: ContinuityDecisionReason;
  recoveryCause: ContinuityRecoveryCause;
  candidateRevision?: ResponseRevision;
}

/**
 * A single eligible response block prepared for inclusion in the continuity plan.
 */
export interface ContextContinuityBlock {
  sourceMessageId: string;
  sourceRevisionId: string;
  assistantText: string;
  thinkingText?: string;
  recoveryCause: ContinuityRecoveryCause;
  branchDepth: number;
  truncated?: boolean;
  originalTextLength: number;
  originalThinkingLength: number;
}

/**
 * A message that was considered but excluded from the continuity plan.
 */
export interface ContextContinuityExclusion {
  sourceMessageId: string;
  reason: Exclude<ContinuityDecisionReason, 'eligible'>;
  recoveryCause: ContinuityRecoveryCause;
}

/**
 * Derived, non-durable plan describing which recovered responses belong to the
 * active branch and what context would be supplied to future continuations.
 */
export interface ContextContinuityPlan {
  conversationId: string;
  branchLeafId: string | null;
  eligibleBlocks: ContextContinuityBlock[];
  excludedBlocks: ContextContinuityExclusion[];
  eligibleBlockCount: number;
  excludedBlockCount: number;
  totalTextChars: number;
  totalThinkingChars: number;
  truncated: boolean;
  omittedBlockCount: number;
  formattedPreview: string;
  createdAt: number;
}

export type ContinuityDeliveryMode = 'automatic' | 'manual_next';

export type ContinuityReceiptState = 'dispatched' | 'response_observed' | 'bridged' | 'failed';

/**
 * Operational ledger record tracking the lifecycle of an explicit context delivery.
 */
export interface ContextContinuityReceipt {
  id: string; // deliveryId
  conversationId: string;
  remoteConversationId: string;
  parentMessageId: string | null;
  sourceMessageIds: string[];
  sourceRevisionIds: string[];
  deliveryMode: ContinuityDeliveryMode;
  state: ContinuityReceiptState;
  createdAt: number;
  updatedAt: number;
  rawStreamKey?: string;
  resultingMessageId?: string;
  error?: string;
}

/**
 * User-configurable settings for Context Continuity.
 * Defaults strictly to OFF.
 */
export interface ContextContinuitySettings {
  enabled: boolean;
  includeThinking: boolean;
  deliveryMode: ContinuityDeliveryMode;
}

export const DEFAULT_CONTEXT_CONTINUITY_SETTINGS: ContextContinuitySettings = {
  enabled: false,
  includeThinking: false,
  deliveryMode: 'manual_next',
};

/**
 * Bounds controlling maximum context inclusion to avoid model context overflow.
 */
export interface ContextContinuityLimits {
  maxBlocks: number;
  maxTextChars: number;
  maxThinkingChars: number;
}

export const DEFAULT_CONTINUITY_LIMITS: ContextContinuityLimits = {
  maxBlocks: 4,
  maxTextChars: 12000,
  maxThinkingChars: 6000,
};
