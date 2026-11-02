/**
 * Types and interfaces for Milestone 2E.3: Retention, Cleanup & Safe Deletion.
 */

import type { PortableBackupStoreCounts } from '../../backup/format';
import type { RawStreamIntegrity, RawStreamRecord, RawStreamState } from '../raw-journal/types';

export type RawRetentionMode = 'forever' | '30' | '90' | '180';

export type StoragePersistenceStatus = 'granted' | 'not_granted' | 'unsupported' | 'error';

export interface RetentionSettings {
  rawRetention: RawRetentionMode;
  lastAutomaticCleanupAt?: number;
}

export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  rawRetention: 'forever',
};

export type RetentionExclusionReason =
  | 'too_recent'
  | 'active'
  | 'recovery_protected'
  | 'forensic_protected'
  | 'retention_disabled'
  | 'expired_safe';

export interface RawRetentionDecision {
  eligible: boolean;
  reason: RetentionExclusionReason;
  streamKey: string;
}

export interface RawRetentionPlan {
  mode: RawRetentionMode;
  cutoffTimestamp?: number;
  candidateStreamKeys: string[];
  candidateBatchCount: number;
  protectedStreamCount: number;
  totalStreamsScanned: number;
  estimatedFreedBatches: number;
  oldestCandidateTimestamp?: number;
  newestCandidateTimestamp?: number;
}

export interface ConversationDeletionPlan {
  conversationId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  revisionCount: number;
  recoveryEventCount: number;
  rawStreamCount: number;
  rawBatchCount: number;
  rawStreamKeys: string[];
}

export interface ArchiveCleanupResult {
  success: boolean;
  deletedStreamCount: number;
  deletedBatchCount: number;
  durationMs: number;
  error?: string;
}

export interface StorageMaintenanceStatus {
  storageEstimate: {
    usageBytes?: number;
    quotaBytes?: number;
    percentage?: number;
  };
  persistenceStatus: StoragePersistenceStatus;
  counts: PortableBackupStoreCounts;
  totalCanonicalMessages: number;
  totalRawCharacters: number;
  rawRetention: RawRetentionMode;
  lastAutomaticCleanupAt?: number;
}
