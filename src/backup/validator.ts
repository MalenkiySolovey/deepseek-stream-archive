import { readPortableBackup, type BackupValidationError } from './reader';
import type { PortableBackupStoreCounts } from './format';

export type { BackupValidationError };

export interface BackupValidationResult {
  valid: boolean;
  format?: string;
  formatVersion?: number;
  createdAt?: number;
  appVersion?: string;
  sourceDatabaseVersion?: number;
  counts?: PortableBackupStoreCounts;
  totalRecords?: number;
  errors: BackupValidationError[];
}

/**
 * Pure, read-only validator for portable backup archives (.streamarchive.jsonl.gz).
 * Does NOT write to IndexedDB.
 * Delegates directly to readPortableBackup for unified parsing, envelope validation,
 * and decompression bomb protection.
 */
export async function validatePortableBackup(
  input: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>
): Promise<BackupValidationResult> {
  const result = await readPortableBackup(input);

  const manifest = result.backup?.manifest;
  const counts = result.backup?.footer?.counts ?? (result.errors.length === 0 ? undefined : {
    conversations: result.backup?.records.conversations.length ?? 0,
    messages: result.backup?.records.messages.length ?? 0,
    revisions: result.backup?.records.revisions.length ?? 0,
    recovery_events: result.backup?.records.recovery_events.length ?? 0,
    raw_streams: result.backup?.records.raw_streams.length ?? 0,
    raw_stream_batches: result.backup?.records.raw_stream_batches.length ?? 0,
  });

  return {
    valid: result.success,
    format: manifest?.format,
    formatVersion: manifest?.formatVersion,
    createdAt: manifest?.createdAt,
    appVersion: manifest?.appVersion,
    sourceDatabaseVersion: manifest?.sourceDatabaseVersion,
    counts,
    totalRecords: result.totalRecords,
    errors: result.errors,
  };
}
