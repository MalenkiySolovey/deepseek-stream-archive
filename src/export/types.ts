import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../core/models';

/**
 * Options controlling human conversation export generation.
 */
export interface ConversationExportOptions {
  /** Target export format */
  format: 'markdown' | 'json';
  /** Whether to export all sibling branches or only the active/primary branch */
  branches: 'all' | 'active';
  /** Whether to include DeepThink chain-of-thought reasoning */
  includeReasoning: boolean;
  /** Whether to include complete revision history */
  includeRevisions: boolean;
  /** Whether to include pre-filter recovery provenance and text */
  includeRecovery: boolean;
  /** Active branch selection map per parent message ID (used when branches === 'active') */
  branchSelections?: Record<string, number>;
}

/**
 * Internal storage representation of a complete conversation ready for export.
 */
export interface ConversationExportModel {
  conversation: Conversation;
  messages: Array<{
    message: Message;
    revisions: ResponseRevision[];
    recoveryEvents: RecoveryEvent[];
  }>;
}

/**
 * Public structured JSON export DTO (format: deepseek-streamarchive-conversation, version: 1).
 */
export interface ConversationExportV1 {
  format: 'deepseek-streamarchive-conversation';
  formatVersion: 1;
  exportedAt: string;
  exportOptions: {
    branches: 'all' | 'active';
    includeReasoning: boolean;
    includeRevisions: boolean;
    includeRecovery: boolean;
  };
  conversation: {
    id: string;
    remoteId?: string;
    title: string;
    createdAt: number;
    updatedAt: number;
  };
  messages: Array<{
    id: string;
    remoteId?: string;
    parentId?: string;
    role: import('../core/models').MessageRole;
    status: string;
    identityState: string;
    projectionState: string;
    branchIndex?: number;
    branchCount?: number;
    createdAt: number;
    updatedAt: number;
    content: string;
    thinking?: string;
    recovery?: {
      event: {
        id: string;
        kind: string;
        detectedAt: number;
        reason?: string;
      };
      lastGoodText: string;
      lastGoodThinking?: string;
    };
    revisions?: Array<{
      id: string;
      revisionIndex: number;
      source: string;
      capturedAt: number;
      isFinal: boolean;
      isLastGood: boolean;
      text: string;
      thinking?: string;
    }>;
  }>;
  unmatchedCaptures?: Array<{
    id: string;
    sourceRawStreamKey?: string;
    createdAt: number;
    text: string;
    thinking?: string;
  }>;
}
