/**
 * Portable Backup Format v1 Specification & Types.
 *
 * File extension: .streamarchive.jsonl.gz
 * MIME type: application/gzip
 * Logical payload: UTF-8 JSON Lines (NDJSON)
 */

export const PORTABLE_BACKUP_FORMAT = 'deepseek-streamarchive-backup' as const;
export const PORTABLE_BACKUP_FORMAT_VERSION = 1 as const;
export const PORTABLE_BACKUP_EXTENSION = 'streamarchive.jsonl.gz' as const;
export const PORTABLE_BACKUP_MIME_TYPE = 'application/gzip' as const;

export const INCLUDED_BACKUP_STORES = [
  'conversations',
  'messages',
  'revisions',
  'recovery_events',
  'raw_streams',
  'raw_stream_batches',
] as const;

export type IncludedBackupStoreName = typeof INCLUDED_BACKUP_STORES[number];

export const EXCLUDED_BACKUP_STORES = [
  'canonical_checkpoints',
  'history_staging',
  'history_staging_manifests',
] as const;

export type ExcludedBackupStoreName = typeof EXCLUDED_BACKUP_STORES[number];

export interface PortableBackupManifestRecord {
  kind: 'manifest';
  format: typeof PORTABLE_BACKUP_FORMAT;
  formatVersion: typeof PORTABLE_BACKUP_FORMAT_VERSION;
  createdAt: number;
  appVersion: string;
  sourceDatabase: string;
  sourceDatabaseVersion: number;
  encoding: 'utf-8';
  compression: 'gzip';
  includedStores: readonly string[];
  excludedStores: readonly string[];
  privacy: {
    containsConversationContent: boolean;
    containsReasoning: boolean;
    containsRecoveredContent: boolean;
    containsRawNetworkEvidence: boolean;
  };
}

export interface PortableBackupStoreRecord {
  kind: 'record';
  store: IncludedBackupStoreName;
  value: Record<string, unknown>;
}

export interface PortableBackupStoreCounts {
  conversations: number;
  messages: number;
  revisions: number;
  recovery_events: number;
  raw_streams: number;
  raw_stream_batches: number;
}

export interface PortableBackupFooterRecord {
  kind: 'footer';
  complete: true;
  counts: PortableBackupStoreCounts;
}

export type PortableBackupLine =
  | PortableBackupManifestRecord
  | PortableBackupStoreRecord
  | PortableBackupFooterRecord;

/**
 * Maximum in-memory size threshold for materializing snapshot in v1.
 * Default: 100 MiB (104,857,600 bytes).
 */
export const MAX_IN_MEMORY_PORTABLE_BACKUP_SOURCE_BYTES = 100 * 1024 * 1024;
