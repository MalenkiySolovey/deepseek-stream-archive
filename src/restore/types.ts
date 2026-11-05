/**
 * Types and interfaces for Backup Restore & Safe Merge.
 */

import type { IncludedBackupStoreName, PortableBackupStoreCounts, PortableBackupManifestRecord } from '../backup/format';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../core/models';
import type { RawStreamRecord, RawStreamBatch } from '../storage/raw-journal/types';

export type RestoreMode = 'replace' | 'merge';

export interface RestoreConflict {
  code: 'primary_key_conflict' | 'semantic_identity_collision' | 'restore_conflict_changed_since_preview';
  store: IncludedBackupStoreName;
  id: string;
  message: string;
}

export interface RestorePlan {
  mode: RestoreMode;
  valid: boolean;
  toInsert: {
    conversations: Conversation[];
    messages: Message[];
    revisions: ResponseRevision[];
    recovery_events: RecoveryEvent[];
    raw_streams: RawStreamRecord[];
    raw_stream_batches: RawStreamBatch[];
  };
  toInsertCounts?: PortableBackupStoreCounts;
  toSkip: PortableBackupStoreCounts;
  conflicts: RestoreConflict[];
}

export interface RestorePreflight {
  canRestore: boolean;
  currentCounts: PortableBackupStoreCounts;
  backupCounts: PortableBackupStoreCounts;
  manifest: PortableBackupManifestRecord;
  activeStreamsCount: number;
  validationErrors: Array<{ code: string; message: string }>;
  plan?: RestorePlan;
}

export interface RestoreResult {
  success: boolean;
  mode: RestoreMode;
  insertedCounts: PortableBackupStoreCounts;
  skippedCounts: PortableBackupStoreCounts;
  verified: boolean;
  durationMs: number;
  error?: string;
}
