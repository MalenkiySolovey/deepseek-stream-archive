/**
 * Bounded Staging Restore Engine & Crash Resilience Guard.
 *
 * Implements low-memory, crash-resilient restoration of large archives:
 * 1. Streams records into an isolated staging database (`StreamArchiveDB_restore_staging`) in small batches (< 5 MiB RAM).
 * 2. Enforces line-by-line schema validation, store ordering, and referential integrity directly in IndexedDB.
 * 3. Builds Merge and Replace plans directly against staging records with full semantic fidelity (0 false conflicts, no getAll()).
 * 4. Executes atomic Replace and Merge with pre-restore snapshot rollback guard and persistent crash-recovery journal.
 * 5. Guarantees that no error or browser crash can irreversibly destroy user data.
 */

import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_CONTEXT_CONTINUITY_RECEIPTS,
  DB_VERSION,
  configureDatabaseSchema,
} from '../storage/schema';
import {
  INCLUDED_BACKUP_STORES,
  type IncludedBackupStoreName,
  type PortableBackupStoreCounts,
} from '../backup/format';
import { readPortableBackup, type MaterializedPortableBackup } from '../backup/reader';
import type { IntegrityValidationError, IntegrityValidationResult } from './integrity';
import { isRecordSemanticallyIdentical, deepEqualRecords } from '../backup/record-validation';
import {
  openExtensionDatabase,
  closeExtensionDatabase,
  deleteExtensionDatabase,
  createDurableWriteTransaction,
} from '../storage/db';
export {
  openExtensionDatabase,
  closeExtensionDatabase,
  deleteExtensionDatabase,
  createDurableWriteTransaction,
};
import {
  withExclusiveRestoreLock,
  acquireRestoreLock,
  isRestoreLocked,
  type RestoreLockHandle,
} from './restore-lock';
import type { RestorePlan, RestoreResult, RestoreMode, RestoreConflict, RestoreCleanupStatus } from './types';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../core/models';
import { isValidRoleParentage } from '../core/parentage/parent-resolver';
import type { RawStreamRecord, RawStreamBatch } from '../storage/raw-journal/types';
import { ALL_NINE_STORES } from './replace';
import { computeSha256, canonicalStringify } from '../shared/crypto';

export const RESTORE_STAGING_DB_NAME = 'StreamArchiveDB_restore_staging' as const;
export const RESTORE_SNAPSHOT_DB_NAME = 'StreamArchiveDB_pre_restore_snapshot' as const;
export const RESTORE_JOURNAL_DB_NAME = 'StreamArchiveDB_restore_journal' as const;
export const RESTORE_JOURNAL_STORE_NAME = 'restore_journal_markers' as const;

export type RecoveryCheckResetHook = (factory?: IDBFactory) => void;
let onRecoveryCheckReset: RecoveryCheckResetHook | null = null;

export function registerRecoveryCheckResetHook(hook: RecoveryCheckResetHook | null): void {
  onRecoveryCheckReset = hook;
}

export function notifyRecoveryCheckReset(factory?: IDBFactory): void {
  if (onRecoveryCheckReset) {
    try {
      onRecoveryCheckReset(factory);
    } catch (err) {
      console.warn('[RecoveryCheck] Error in recovery check reset hook:', err);
    }
  }
}

const activeTemporaryDatabases = new Set<string>();

export function registerActiveTemporaryDatabase(dbName: string): () => void {
  activeTemporaryDatabases.add(dbName);
  return () => {
    activeTemporaryDatabases.delete(dbName);
  };
}

export function isTemporaryDatabaseActive(dbName: string): boolean {
  return activeTemporaryDatabases.has(dbName);
}

/**
 * Creates a unique staging database name for an isolated restore operation.
 * Prevents concurrent operations from colliding or deleting each other's temporary data.
 */
export function createStagingDatabaseName(operationId?: string): string {
  const id = operationId || `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return `${RESTORE_STAGING_DB_NAME}_${id}`;
}

/**
 * Creates a unique snapshot database name for an isolated rollback snapshot.
 */
export function createSnapshotDatabaseName(operationId?: string): string {
  const id = operationId || `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return `${RESTORE_SNAPSHOT_DB_NAME}_${id}`;
}

export type JournalMarkerStatus =
  | { status: 'marker_present'; marker: RestoreJournalMarker }
  | { status: 'marker_absent' }
  | { status: 'read_failed'; error: string }
  | { status: 'marker_corrupt'; error: string };

export const SIX_DURABLE_STORES: readonly IncludedBackupStoreName[] = [
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
] as const;

export const EIGHT_SNAPSHOT_STORES: readonly string[] = [
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_CONTEXT_CONTINUITY_RECEIPTS,
] as const;

const BATCH_SIZE = 200;

let activeRestoreLock = false;

export type RecoveryStatus =
  | { state: 'not_required' }
  | { state: 'recovered'; durationMs?: number; details?: string }
  | { state: 'blocked'; reason: string; snapshotPreserved?: boolean }
  | { state: 'failed'; reason: string; snapshotPreserved: boolean };

export type RestoreJournalStage =
  | 'idle'
  | 'preparing_snapshot'
  | 'snapshot_verified'
  | 'commit_started'
  | 'transfer_completed'
  | 'verifying'
  | 'commit_verified'
  | 'cleanup_pending'
  | 'completed'
  | 'rollback_required'
  | 'rollback_in_progress'
  | 'recovery_verified'
  // Legacy backward compatibility
  | 'snapshot_ready'
  | 'transferring'
  | 'commit_completed'
  | 'rolling_back';

export interface RestoreJournalMarker {
  type: 'replace' | 'merge';
  stage: RestoreJournalStage;
  liveDbName: string;
  snapshotDbName: string;
  stagingDbName: string;
  timestamp: number;
  operationId?: string;
  expectedCounts?: PortableBackupStoreCounts;
  snapshotCounts?: Record<string, number>;
  liveStoreChecksums?: Record<string, string>;
  liveStoreCounts?: Record<string, number>;
}

export type RestoreInterruptionPoint =
  | 'after_snapshot_created'
  | 'after_journal_persisted'
  | 'after_live_db_cleared'
  | 'after_first_batch'
  | 'mid_transfer'
  | 'after_full_transfer'
  | 'before_journal_deletion'
  | 'after_journal_deletion'
  | 'before_snapshot_deletion';

let testRestoreInterruptionHook: ((point: RestoreInterruptionPoint) => void | Promise<void>) | null = null;

export function setTestRestoreInterruptionHook(
  hook: ((point: RestoreInterruptionPoint) => void | Promise<void>) | null
): void {
  testRestoreInterruptionHook = hook;
}

async function triggerInterruptionPoint(point: RestoreInterruptionPoint): Promise<void> {
  if (testRestoreInterruptionHook) {
    await testRestoreInterruptionHook(point);
  }
}

export type SnapshotOpenStatus =
  | { state: 'opened'; db: IDBDatabase }
  | { state: 'not_found'; reason: string }
  | { state: 'version_incompatible'; reason: string; error: Error }
  | { state: 'access_blocked'; reason: string; error: Error }
  | { state: 'read_error'; reason: string; error: Error }
  | { state: 'invalid_schema'; reason: string; missingStores: string[]; error?: Error };

export interface SnapshotOpenDetailedResult {
  db: IDBDatabase | null;
  status: SnapshotOpenStatus;
}

/**
 * Safely inspects and opens an existing snapshot database WITHOUT auto-creating an empty database.
 * Strictly avoids deleting existing databases upon open error (VersionError, quota, lock, etc.).
 */
export async function openExistingSnapshotDetailed(
  idbFactory?: IDBFactory,
  snapshotDbName?: string,
  expectedVersion: number = DB_VERSION
): Promise<SnapshotOpenDetailedResult> {
  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!factory || !snapshotDbName) {
    return {
      db: null,
      status: { state: 'not_found', reason: 'IndexedDB factory or database name missing' },
    };
  }

  if (typeof (factory as any).databases === 'function') {
    try {
      const dbs: Array<{ name?: string; version?: number }> = await (factory as any).databases();
      const exists = dbs.some((db) => db.name === snapshotDbName);
      if (!exists) {
        return {
          db: null,
          status: { state: 'not_found', reason: `Database "${snapshotDbName}" does not exist in databases() list` },
        };
      }
    } catch {
      // non-fatal fallback
    }
  }

  return new Promise<SnapshotOpenDetailedResult>((resolve) => {
    let wasCreated = false;
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(snapshotDbName, expectedVersion);
    } catch (err: any) {
      return resolve({
        db: null,
        status: { state: 'read_error', reason: `open() threw synchronously: ${err?.message}`, error: err },
      });
    }

    req.onupgradeneeded = (e) => {
      if (e.oldVersion === 0) {
        wasCreated = true;
        try {
          req.transaction?.abort();
        } catch {
          // ignore
        }
      } else {
        // CRITICAL INVARIANT: Existing snapshots must NEVER be automatically migrated or altered
        try {
          req.transaction?.abort();
        } catch {
          // ignore
        }
      }
    };

    req.onsuccess = () => {
      if (wasCreated) {
        const db = req.result;
        try { db.close(); } catch {}
        try { factory.deleteDatabase(snapshotDbName); } catch {}
        return resolve({
          db: null,
          status: { state: 'not_found', reason: `Database "${snapshotDbName}" was newly created (oldVersion 0)` },
        });
      }

      const db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch {}
      };

      const missingStores: string[] = [];
      for (const st of EIGHT_SNAPSHOT_STORES) {
        if (!db.objectStoreNames.contains(st)) {
          missingStores.push(st);
        }
      }

      if (missingStores.length > 0) {
        try { db.close(); } catch {}
        return resolve({
          db: null,
          status: {
            state: 'invalid_schema',
            missingStores,
            reason: `Snapshot database "${snapshotDbName}" is missing required stores: ${missingStores.join(', ')}`,
          },
        });
      }

      return resolve({
        db,
        status: { state: 'opened', db },
      });
    };

    req.onerror = () => {
      const err = req.error;
      const errName = err?.name || 'UnknownError';

      if (wasCreated) {
        try { factory.deleteDatabase(snapshotDbName); } catch {}
        return resolve({
          db: null,
          status: { state: 'not_found', reason: `Database "${snapshotDbName}" does not exist (created during open)` },
        });
      }

      // CRITICAL SAFETY INVARIANT: If wasCreated is false, the database already existed prior to open()
      // or encountered an access/version error. We MUST NEVER call factory.deleteDatabase()!
      if (errName === 'VersionError') {
        return resolve({
          db: null,
          status: {
            state: 'version_incompatible',
            error: err || new Error('VersionError: requested version incompatible with existing snapshot'),
            reason: `Database "${snapshotDbName}" has incompatible version: ${err?.message || errName}`,
          },
        });
      }

      if (errName === 'SecurityError' || errName === 'InvalidStateError') {
        return resolve({
          db: null,
          status: {
            state: 'access_blocked',
            error: err || new Error(errName),
            reason: `Database "${snapshotDbName}" access blocked: ${err?.message || errName}`,
          },
        });
      }

      return resolve({
        db: null,
        status: {
          state: 'read_error',
          error: err || new Error(errName),
          reason: `Database "${snapshotDbName}" open failed with error: ${err?.message || errName}`,
        },
      });
    };
  });
}

/**
 * Safely opens an existing snapshot database WITHOUT auto-creating an empty database if it does not exist.
 * Returns null if the snapshot database does not exist, was just created by open(), or is missing required stores.
 * NEVER deletes an existing database when open fails.
 */
export async function openExistingSnapshotWithoutCreating(
  idbFactory?: IDBFactory,
  snapshotDbName?: string,
  expectedVersion: number = DB_VERSION
): Promise<IDBDatabase | null> {
  const detailed = await openExistingSnapshotDetailed(idbFactory, snapshotDbName, expectedVersion);
  if (detailed.status.state !== 'opened') {
    console.warn(`[openExistingSnapshotWithoutCreating] Could not open "${snapshotDbName}": ${detailed.status.reason}`);
  }
  return detailed.db;
}

export interface PostCommitCleanupResult {
  success: boolean;
  journalDeleted: boolean;
  snapshotDeleted: boolean;
  stagingDeleted: boolean;
  errors: Error[];
}

/**
 * Safely cleans up temporary snapshot, staging databases, and the restore journal marker
 * AFTER a commit has been confirmed and verified. Any error in deleting temporary resources
 * is caught and recorded as a non-fatal warning so it NEVER causes a destructive rollback.
 *
 * CRITICAL INVARIANT:
 * If deletion of the restore journal marker fails, snapshotDb and stagingDb MUST NOT be deleted.
 * Cleanup halts immediately to preserve the safety snapshots until journal state is resolved.
 */
export async function performPostCommitCleanup(options: {
  idbFactory?: IDBFactory;
  snapshotDbName: string;
  stagingDbName: string;
  shouldCleanupStaging: boolean;
}): Promise<PostCommitCleanupResult> {
  const { idbFactory, snapshotDbName, stagingDbName, shouldCleanupStaging } = options;
  const errors: Error[] = [];
  let journalDeleted = false;
  let snapshotDeleted = false;
  let stagingDeleted = false;

  await triggerInterruptionPoint('before_journal_deletion');

  // Attempt journal marker deletion with retries (up to 3 attempts with exponential backoff)
  const MAX_JOURNAL_DELETE_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_JOURNAL_DELETE_ATTEMPTS; attempt++) {
    try {
      await setRestoreJournalMarker(null, idbFactory);
      journalDeleted = true;
      break;
    } catch (err) {
      if (attempt === MAX_JOURNAL_DELETE_ATTEMPTS) {
        console.warn(`[PostCommitCleanup] Failed to delete restore journal marker after ${attempt} attempts:`, err);
        errors.push(err instanceof Error ? err : new Error(String(err)));
      } else {
        await new Promise((r) => setTimeout(r, attempt * 50));
      }
    }
  }

  await triggerInterruptionPoint('after_journal_deletion');

  // CRITICAL INVARIANT:
  // If deletion of the authoritative restore journal failed, WE MUST NOT delete snapshotDb or stagingDb!
  // Preserving the safety snapshot and staging data is mandatory while the journal state is indeterminate.
  // We must halt cleanup immediately and signal that the recovery check must be re-evaluated.
  if (!journalDeleted) {
    notifyRecoveryCheckReset(idbFactory);
    return {
      success: false,
      journalDeleted: false,
      snapshotDeleted: false,
      stagingDeleted: false,
      errors,
    };
  }

  // Journal is confirmed deleted. The commit is now 100% durable and cannot be rolled back.
  // It is now safe to delete the safety snapshot.
  await triggerInterruptionPoint('before_snapshot_deletion');
  try {
    closeExtensionDatabase(idbFactory, snapshotDbName);
    await deleteExtensionDatabase(idbFactory, snapshotDbName);
    snapshotDeleted = true;
  } catch (err) {
    console.warn(`[PostCommitCleanup] Failed to delete snapshot database "${snapshotDbName}":`, err);
    errors.push(err instanceof Error ? err : new Error(String(err)));
  }

  if (shouldCleanupStaging) {
    try {
      closeExtensionDatabase(idbFactory, stagingDbName);
      await deleteExtensionDatabase(idbFactory, stagingDbName);
      stagingDeleted = true;
    } catch (err) {
      console.warn(`[PostCommitCleanup] Failed to delete staging database "${stagingDbName}":`, err);
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  } else {
    stagingDeleted = true;
  }

  return {
    success: errors.length === 0,
    journalDeleted,
    snapshotDeleted,
    stagingDeleted,
    errors,
  };
}

/**
 * Retries a pending post-commit cleanup safely inside an exclusive Web Lock.
 *
 * Requirements:
 * 1. Obtains exclusive Web Lock across all Chrome contexts.
 * 2. Re-reads authoritative restore journal under the lock.
 * 3. Verifies operation stage and verifies that liveDb still matches confirmed operation / baseline.
 * 4. Refuses to delete snapshot if liveDb fails baseline verification.
 * 5. Safely handles concurrent retries or completed cleanups across windows.
 */
export async function retryPendingRestoreCleanup(
  idbFactory?: IDBFactory
): Promise<PostCommitCleanupResult> {
  return await withExclusiveRestoreLock('retry_cleanup', async (): Promise<PostCommitCleanupResult> => {
    const marker = await getRestoreJournalMarker(idbFactory);
    if (!marker) {
      notifyRecoveryCheckReset(idbFactory);
      return {
        success: true,
        journalDeleted: true,
        snapshotDeleted: true,
        stagingDeleted: true,
        errors: [],
      };
    }

    let normalizedStage: RestoreJournalStage = marker.stage;
    if (marker.stage === ('commit_completed' as any)) normalizedStage = 'commit_verified';

    if (normalizedStage !== 'commit_verified' && normalizedStage !== 'cleanup_pending' && normalizedStage !== 'completed') {
      throw new Error(`Cannot retry cleanup: restore operation is at pre-commit stage "${marker.stage}".`);
    }

    // Verify liveDb before deleting anything!
    let liveDb: IDBDatabase | null = null;
    try {
      liveDb = await openExtensionDatabase(idbFactory, marker.liveDbName);

      // Fast path: exact checksum match
      let exactMatch = false;
      if (marker.liveStoreChecksums && marker.liveStoreCounts) {
        let countsMatch = true;
        for (const store of SIX_DURABLE_STORES) {
          const exp = marker.liveStoreCounts[store] ?? 0;
          const act = await getStoreRecordCount(liveDb, store);
          if (act !== exp) {
            countsMatch = false;
            break;
          }
        }
        if (countsMatch) {
          const currentChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
          exactMatch = true;
          for (const store of SIX_DURABLE_STORES) {
            if (currentChecksums[store] !== marker.liveStoreChecksums[store]) {
              exactMatch = false;
              break;
            }
          }
        }
      }

      let liveVerified = false;
      if (exactMatch) {
        const integrity = await validateStagingReferentialIntegrity(liveDb);
        liveVerified = integrity.valid;
      } else {
        const baselineCheck = await verifyRestoredBaselinePreserved(liveDb, marker, idbFactory);
        liveVerified = baselineCheck.valid;
        if (!liveVerified) {
          console.error('[Retry Cleanup] Baseline verification failed:', baselineCheck.reason);
        }
      }

      if (!liveVerified) {
        return {
          success: false,
          journalDeleted: false,
          snapshotDeleted: false,
          stagingDeleted: false,
          errors: [new Error('Live database failed integrity verification. Snapshot preserved for emergency recovery.')],
        };
      }
    } finally {
      if (liveDb) {
        try { liveDb.close(); } catch {}
      }
    }

    const result = await performPostCommitCleanup({
      idbFactory,
      snapshotDbName: marker.snapshotDbName,
      stagingDbName: marker.stagingDbName,
      shouldCleanupStaging: true,
    });

    if (result.journalDeleted) {
      notifyRecoveryCheckReset(idbFactory);
    }

    return result;
  });
}

export const STALE_TEMPORARY_DB_AGE_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Sweeps and removes orphaned temporary staging/snapshot databases left behind by crashed processes.
 * Protects databases referenced by any active restore journal marker, actively running operations,
 * or created within the safety age threshold (15 minutes).
 */
export async function cleanupStaleTemporaryDatabases(
  idbFactory?: IDBFactory
): Promise<string[]> {
  if (activeRestoreLock || (await isRestoreLocked())) {
    console.info('[CleanupStale] Restore lock is currently held; postponing stale cleanup.');
    return [];
  }

  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!factory || typeof (factory as any).databases !== 'function') return [];

  const deleted: string[] = [];
  try {
    const activeMarker = await getRestoreJournalMarker(idbFactory);
    const protectedNames = new Set<string>();
    if (activeMarker) {
      if (activeMarker.snapshotDbName) protectedNames.add(activeMarker.snapshotDbName);
      if (activeMarker.stagingDbName) protectedNames.add(activeMarker.stagingDbName);
      if (activeMarker.liveDbName) protectedNames.add(activeMarker.liveDbName);
    }

    const dbs: Array<{ name?: string }> = await (factory as any).databases();
    const now = Date.now();

    for (const db of dbs) {
      const name = db.name;
      if (!name) continue;
      const isStaging = name.startsWith(RESTORE_STAGING_DB_NAME + '_');
      const isSnapshot = name.startsWith(RESTORE_SNAPSHOT_DB_NAME + '_');
      if (!isStaging && !isSnapshot) continue;

      // 1. Protect actively registered temporary databases (e.g. running in-flight preflights or restores)
      if (activeTemporaryDatabases.has(name)) continue;

      // 2. Protect databases referenced by active journal marker
      if (protectedNames.has(name)) continue;

      // 3. Protect databases created recently (age threshold: 15 minutes)
      const tsMatch = name.match(/_(?:op|preflight|restore|_)?(\d{10,13})(?:_|$)/);
      if (tsMatch && tsMatch[1]) {
        const timestamp = parseInt(tsMatch[1], 10);
        if (!isNaN(timestamp)) {
          const ageMs = now - timestamp;
          if (ageMs >= 0 && ageMs < STALE_TEMPORARY_DB_AGE_THRESHOLD_MS) {
            // Database is younger than threshold, likely active or recent
            continue;
          }
        }
      }

      try {
        closeExtensionDatabase(idbFactory, name);
        await deleteExtensionDatabase(idbFactory, name);
        deleted.push(name);
      } catch (err) {
        console.warn(`[cleanupStaleTemporaryDatabases] Could not delete orphaned temporary database "${name}":`, err);
      }
    }
  } catch (err) {
    console.warn('[cleanupStaleTemporaryDatabases] Error scanning databases:', err);
  }
  return deleted;
}

/**
 * Persists or clears the crash-recovery marker in authoritative IndexedDB and diagnostic chrome.storage.local.
 * IndexedDB is the authoritative source of truth. If writing or deleting in IndexedDB fails, this function throws
 * to ensure that destructive operations fail-closed before touching user data.
 */
export async function setRestoreJournalMarker(
  marker: RestoreJournalMarker | null,
  idbFactory?: IDBFactory
): Promise<void> {
  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);

  // 1. Authoritative IndexedDB persistence FIRST!
  if (factory) {
    if (marker === null) {
      const globalObj = typeof window !== 'undefined' ? (window as any) : (globalThis as any);
      if (globalObj?.__failJournalMarkerDeletion) {
        throw new Error('EBUSY: simulated persistent lock on restore journal deletion');
      }
      await new Promise<void>((resolve, reject) => {
        try {
          const req = factory.open(RESTORE_JOURNAL_DB_NAME, 1);
          req.onupgradeneeded = (e) => {
            const db = (e.target as IDBOpenDBRequest).result;
            if (!db.objectStoreNames.contains(RESTORE_JOURNAL_STORE_NAME)) {
              db.createObjectStore(RESTORE_JOURNAL_STORE_NAME, { keyPath: 'id' });
            }
          };
          req.onsuccess = () => {
            const db = req.result;
            try {
              const tx = db.transaction([RESTORE_JOURNAL_STORE_NAME], 'readwrite');
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = () => {
                db.close();
                reject(tx.error || new Error('Transaction error while deleting crash recovery journal marker'));
              };
              tx.onabort = () => {
                db.close();
                reject(tx.error || new Error('Transaction aborted while deleting crash recovery journal marker'));
              };
              const delReq = tx.objectStore(RESTORE_JOURNAL_STORE_NAME).delete('active');
              delReq.onerror = () => {
                reject(delReq.error || new Error('Failed to delete active crash recovery journal marker'));
              };
            } catch (err) {
              db.close();
              reject(err);
            }
          };
          req.onerror = () => reject(req.error || new Error('Failed to open crash recovery journal database for deletion'));
        } catch (err) {
          reject(err);
        }
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        const req = factory.open(RESTORE_JOURNAL_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(RESTORE_JOURNAL_STORE_NAME)) {
            db.createObjectStore(RESTORE_JOURNAL_STORE_NAME, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction([RESTORE_JOURNAL_STORE_NAME], 'readwrite');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error || new Error('Failed to persist crash recovery journal marker transaction'));
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error || new Error('Crash recovery journal marker transaction aborted'));
          };
          tx.objectStore(RESTORE_JOURNAL_STORE_NAME).put({ id: 'active', ...marker });
        };
        req.onerror = () => reject(req.error || new Error('Failed to open crash recovery journal database'));
      });
    }
  }

  // 2. Secondary diagnostic mirror in chrome.storage.local
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      if (marker) {
        await chrome.storage.local.set({ __streamarchive_restore_marker__: marker });
      } else {
        await chrome.storage.local.remove('__streamarchive_restore_marker__');
      }
    }
  } catch {
    // Non-blocking diagnostic mirror
  }
}

/**
 * Reads the authoritative journal marker state from IndexedDB.
 * Distinguishes marker_present, marker_absent, read_failed, and marker_corrupt.
 */
export async function readAuthoritativeJournalMarkerState(
  idbFactory?: IDBFactory
): Promise<JournalMarkerStatus> {
  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);

  if (factory) {
    try {
      const result = await new Promise<JournalMarkerStatus>((resolve) => {
        let req: IDBOpenDBRequest;
        try {
          req = factory.open(RESTORE_JOURNAL_DB_NAME, 1);
        } catch (err) {
          return resolve({ status: 'read_failed', error: (err as Error).message });
        }

        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains(RESTORE_JOURNAL_STORE_NAME)) {
            db.createObjectStore(RESTORE_JOURNAL_STORE_NAME, { keyPath: 'id' });
          }
        };

        req.onsuccess = () => {
          const db = req.result;
          try {
            if (!db.objectStoreNames.contains(RESTORE_JOURNAL_STORE_NAME)) {
              db.close();
              return resolve({ status: 'marker_absent' });
            }

            const tx = db.transaction([RESTORE_JOURNAL_STORE_NAME], 'readonly');
            tx.onerror = () => {
              db.close();
              resolve({ status: 'read_failed', error: tx.error?.message || 'Transaction error reading journal' });
            };
            tx.onabort = () => {
              db.close();
              resolve({ status: 'read_failed', error: tx.error?.message || 'Transaction aborted reading journal' });
            };

            const getReq = tx.objectStore(RESTORE_JOURNAL_STORE_NAME).get('active');
            getReq.onsuccess = () => {
              const res = getReq.result;
              db.close();
              if (res) {
                if (typeof res === 'object' && res.type && res.stage && typeof res.liveDbName === 'string') {
                  resolve({ status: 'marker_present', marker: res as RestoreJournalMarker });
                } else {
                  resolve({ status: 'marker_corrupt', error: 'Marker shape is corrupt or missing required fields' });
                }
              } else {
                resolve({ status: 'marker_absent' });
              }
            };
            getReq.onerror = () => {
              db.close();
              resolve({ status: 'read_failed', error: getReq.error?.message || 'Failed to query active marker' });
            };
          } catch (err) {
            db.close();
            resolve({ status: 'read_failed', error: (err as Error).message });
          }
        };

        req.onerror = () => {
          resolve({ status: 'read_failed', error: req.error?.message || 'Failed to open restore journal database' });
        };
      });

      if (result.status === 'marker_present') {
        // Sync to chrome.storage.local diagnostic mirror
        try {
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.set({ __streamarchive_restore_marker__: result.marker }).catch(() => {});
          }
        } catch {}
        return result;
      }

      if (result.status === 'marker_absent') {
        // Authoritative IndexedDB is clean! Purge any stale chrome.storage.local mirror to prevent resurrection
        try {
          if (typeof chrome !== 'undefined' && chrome.storage?.local) {
            chrome.storage.local.remove('__streamarchive_restore_marker__').catch(() => {});
          }
        } catch {}
        return result;
      }

      // If read_failed or marker_corrupt, return directly
      return result;
    } catch (err) {
      return { status: 'read_failed', error: (err as Error).message };
    }
  }

  // Fallback ONLY when indexedDB factory is unavailable (e.g. non-browser environment without IDB)
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get('__streamarchive_restore_marker__');
      if (stored && stored.__streamarchive_restore_marker__) {
        return { status: 'marker_present', marker: stored.__streamarchive_restore_marker__ as RestoreJournalMarker };
      }
    }
  } catch {}

  return { status: 'marker_absent' };
}

/**
 * Reads the active crash-recovery marker. IndexedDB is the authoritative source of truth.
 * If IndexedDB and chrome.storage.local are desynchronized, IndexedDB unconditionally wins.
 * Throws explicit errors on read failure or corruption so callers do not mistake errors for marker absence.
 */
export async function getRestoreJournalMarker(idbFactory?: IDBFactory): Promise<RestoreJournalMarker | null> {
  const state = await readAuthoritativeJournalMarkerState(idbFactory);

  if (state.status === 'marker_present') {
    return state.marker;
  }
  if (state.status === 'marker_absent') {
    return null;
  }
  if (state.status === 'read_failed') {
    throw new Error(`Failed to read authoritative restore journal from IndexedDB: ${state.error}`);
  }
  if (state.status === 'marker_corrupt') {
    throw new Error(`Authoritative restore journal marker is corrupt: ${state.error}`);
  }

  return null;
}

/**
 * Counts records in an object store. Rejects on error or missing store; never returns 0 on failure.
 */
export async function getStoreRecordCount(db: IDBDatabase, storeName: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    try {
      if (!db.objectStoreNames.contains(storeName)) {
        return reject(new Error(`Object store "${storeName}" does not exist in database "${db.name}"`));
      }
      const tx = db.transaction(storeName, 'readonly');
      tx.onerror = () => reject(tx.error || new Error(`Transaction error while counting store "${storeName}"`));
      tx.onabort = () => reject(tx.error || new Error(`Transaction aborted while counting store "${storeName}"`));
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => resolve(req.result ?? 0);
      req.onerror = () => reject(req.error || new Error(`Failed to count store "${storeName}"`));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Recovers live database from snapshot if a previous restore was interrupted by a browser crash or kill.
 */
export async function recoverIncompleteRestoreIfAny(idbFactory?: IDBFactory): Promise<RecoveryStatus> {
  const initialMarker = await getRestoreJournalMarker(idbFactory);
  if (!initialMarker) return { state: 'not_required' };

  const startTime = Date.now();

  try {
    return await withExclusiveRestoreLock('recovery', async (): Promise<RecoveryStatus> => {
      // Re-read authoritative marker INSIDE the exclusive lock to prevent racing with another active context
      const marker = await getRestoreJournalMarker(idbFactory);
      if (!marker) return { state: 'not_required' };

      let normalizedStage: RestoreJournalStage = marker.stage;
      if (marker.stage === ('snapshot_ready' as any)) normalizedStage = 'snapshot_verified';
      else if (marker.stage === ('transferring' as any)) normalizedStage = 'commit_started';
      else if (marker.stage === ('commit_completed' as any)) normalizedStage = 'commit_verified';
      else if (marker.stage === ('rolling_back' as any)) normalizedStage = 'rollback_in_progress';

      // If restore was interrupted BEFORE liveDb was modified, liveDb is 100% intact!
      if (
        normalizedStage === 'idle' ||
        normalizedStage === 'preparing_snapshot' ||
        normalizedStage === 'snapshot_verified' ||
        normalizedStage === 'completed'
      ) {
        console.info(`[Crash Recovery] Interrupted restore was in safe stage "${normalizedStage}". Live database was untouched. Cleaning temporary markers...`);
        await setRestoreJournalMarker(null, idbFactory);
        try {
          closeExtensionDatabase(idbFactory, marker.snapshotDbName);
          await deleteExtensionDatabase(idbFactory, marker.snapshotDbName);
        } catch {}
        try {
          closeExtensionDatabase(idbFactory, marker.stagingDbName);
          await deleteExtensionDatabase(idbFactory, marker.stagingDbName);
        } catch {}
        return { state: 'not_required' };
      }

      console.warn(`[Crash Recovery] Detected unfinished restore from crash (stage: ${normalizedStage}, started: ${marker.timestamp}). Recovering live database...`);

      let snapshotDb: IDBDatabase | null = null;
      let liveDb: IDBDatabase | null = null;
      try {
        // If commit was already verified before crash, verify liveDb directly.
        // We do NOT require snapshotDb to exist because it might have already been deleted during cleanup!
        if (normalizedStage === 'commit_verified' || normalizedStage === 'cleanup_pending') {
          liveDb = await openExtensionDatabase(idbFactory, marker.liveDbName);
          let verifiedCommit = false;

          if (marker.type === 'replace') {
            // Replace mode: liveDb should match stagingDb exactly
            let stagingDb: IDBDatabase | null = null;
            try {
              stagingDb = await openExistingSnapshotWithoutCreating(idbFactory, marker.stagingDbName);
            } catch {}

            if (stagingDb) {
              try {
                verifiedCommit = await verifyDatabaseEquality(stagingDb, liveDb, SIX_DURABLE_STORES);
              } catch {
                verifiedCommit = false;
              } finally {
                try { stagingDb.close(); } catch {}
              }
            }
            
            // If stagingDb was absent OR verifyDatabaseEquality failed (e.g. because subsequent legitimate
            // writes occurred before crash recovery ran): verify via liveStoreCounts, checksums, and baseline preservation
            if (!verifiedCommit) {
              let exactChecksumMatch = false;
              if (marker.liveStoreChecksums && marker.liveStoreCounts) {
                let countsMatch = true;
                for (const store of SIX_DURABLE_STORES) {
                  const exp = marker.liveStoreCounts[store] ?? 0;
                  const act = await getStoreRecordCount(liveDb, store);
                  if (act !== exp) {
                    countsMatch = false;
                    break;
                  }
                }
                if (countsMatch) {
                  const currentChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
                  exactChecksumMatch = true;
                  for (const store of SIX_DURABLE_STORES) {
                    if (currentChecksums[store] !== marker.liveStoreChecksums[store]) {
                      exactChecksumMatch = false;
                      break;
                    }
                  }
                }
              }

              if (exactChecksumMatch) {
                const integrity = await validateStagingReferentialIntegrity(liveDb);
                verifiedCommit = integrity.valid;
              } else {
                // Must verify that all restored records are preserved in liveDb without mutation
                const baselineCheck = await verifyRestoredBaselinePreserved(liveDb, marker, idbFactory);
                verifiedCommit = baselineCheck.valid;
                if (!verifiedCommit) {
                  console.error('[Crash Recovery] Replace baseline verification failed:', baselineCheck.reason);
                } else {
                  console.info('[Crash Recovery] Replace baseline verified: all restored records preserved, subsequent writes valid.');
                }
              }
            }
          } else {
            // Merge mode: liveDb must be verified as the correct union of snapshotDb + stagingDb!
            let stagingDb: IDBDatabase | null = null;
            let snapDbForCheck: IDBDatabase | null = null;
            try {
              stagingDb = await openExistingSnapshotWithoutCreating(idbFactory, marker.stagingDbName);
            } catch {}
            try {
              snapDbForCheck = await openExistingSnapshotWithoutCreating(idbFactory, marker.snapshotDbName);
            } catch {}

            if (stagingDb && snapDbForCheck) {
              try {
                const mergeVerify = await verifyMergeDatabaseIntegrity(snapDbForCheck, stagingDb, liveDb, marker.expectedCounts);
                verifiedCommit = mergeVerify.valid;
                if (!verifiedCommit) {
                  console.error('[Crash Recovery] Merge verification failed:', mergeVerify.error);
                }
              } catch (err) {
                console.error('[Crash Recovery] Error during merge verification:', err);
                verifiedCommit = false;
              } finally {
                try { stagingDb.close(); } catch {}
                try { snapDbForCheck.close(); } catch {}
              }
            }

            if (!verifiedCommit) {
              let exactChecksumMatch = false;
              if (marker.liveStoreChecksums && marker.liveStoreCounts) {
                let countsMatch = true;
                for (const store of SIX_DURABLE_STORES) {
                  const exp = marker.liveStoreCounts[store] ?? 0;
                  const act = await getStoreRecordCount(liveDb, store);
                  if (act !== exp) {
                    countsMatch = false;
                    break;
                  }
                }
                if (countsMatch) {
                  const currentChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
                  exactChecksumMatch = true;
                  for (const store of SIX_DURABLE_STORES) {
                    if (currentChecksums[store] !== marker.liveStoreChecksums[store]) {
                      exactChecksumMatch = false;
                      break;
                    }
                  }
                }
              }

              if (exactChecksumMatch) {
                const integrity = await validateStagingReferentialIntegrity(liveDb);
                verifiedCommit = integrity.valid;
              } else {
                const baselineCheck = await verifyRestoredBaselinePreserved(liveDb, marker, idbFactory);
                verifiedCommit = baselineCheck.valid;
                if (!verifiedCommit) {
                  console.error('[Crash Recovery] Merge baseline verification failed:', baselineCheck.reason);
                } else {
                  console.info('[Crash Recovery] Merge baseline verified: all merged records preserved, subsequent writes valid.');
                }
              }
            }
          }

          if (!verifiedCommit) {
            console.error(
              `[Crash Recovery] CRITICAL ERROR: Live database "${marker.liveDbName}" failed verification at stage "${normalizedStage}"! ` +
              `Preserving snapshot "${marker.snapshotDbName}".`
            );
            const checkSnap = await openExistingSnapshotDetailed(idbFactory, marker.snapshotDbName);
            return {
              state: 'failed',
              reason: `Live database failed verification at stage "${normalizedStage}". Snapshot preserved.`,
              snapshotPreserved: checkSnap.status.state !== 'not_found',
            };
          }

          console.info(`[Crash Recovery] Commit was verified before crash (stage: ${normalizedStage}). Completing cleanup without rollback...`);
          
          let journalRemoved = false;
          try {
            await setRestoreJournalMarker(null, idbFactory);
            journalRemoved = true;
          } catch (journalErr) {
            console.warn('[Crash Recovery] Failed to delete restore journal marker during recovery:', journalErr);
          }

          if (!journalRemoved) {
            console.error('[Crash Recovery] Failed to clear restore journal marker during cleanup. Halting cleanup; snapshot preserved.');
            return {
              state: 'blocked',
              reason: 'Restore commit was verified, but removing the restore journal marker failed. Snapshot preserved. Writes temporarily blocked until cleanup completes.',
              snapshotPreserved: true,
            };
          }

          closeExtensionDatabase(idbFactory, marker.snapshotDbName);
          try {
            await deleteExtensionDatabase(idbFactory, marker.snapshotDbName);
          } catch {}
          closeExtensionDatabase(idbFactory, marker.stagingDbName);
          try {
            await deleteExtensionDatabase(idbFactory, marker.stagingDbName);
          } catch {}

          return {
            state: 'recovered',
            durationMs: Date.now() - startTime,
            details: 'Commit was verified before crash. Completed temporary database cleanup without rollback.',
          };
        }

        // Pre-commit stage: Rollback from snapshot is required!
        const snapResult = await openExistingSnapshotDetailed(idbFactory, marker.snapshotDbName);
        if (snapResult.status.state !== 'opened') {
          console.error(
            `[Crash Recovery] CRITICAL ERROR: Snapshot database "${marker.snapshotDbName}" could not be opened (${snapResult.status.reason})! ` +
            `Refusing to touch live database "${marker.liveDbName}" to prevent data destruction.`
          );
          return {
            state: 'failed',
            reason: `Snapshot database "${marker.snapshotDbName}" could not be opened: ${snapResult.status.reason}`,
            snapshotPreserved: snapResult.status.state !== 'not_found',
          };
        }
        if (!snapResult.db) {
          return {
            state: 'failed',
            reason: `Snapshot database "${marker.snapshotDbName}" handle was null`,
            snapshotPreserved: true,
          };
        }
        snapshotDb = snapResult.db;

        // Validate snapshot non-emptiness & authenticity
        let snapshotTotal = 0;
        for (const store of EIGHT_SNAPSHOT_STORES) {
          if (snapshotDb.objectStoreNames.contains(store)) {
            const count = await getStoreRecordCount(snapshotDb, store);
            snapshotTotal += count;
          }
        }

        let expectedTotal = 0;
        if (marker.expectedCounts) {
          for (const k of Object.keys(marker.expectedCounts)) {
            expectedTotal += (marker.expectedCounts as any)[k] || 0;
          }
        }

        liveDb = await openExtensionDatabase(idbFactory, marker.liveDbName);
        let liveTotal = 0;
        for (const store of SIX_DURABLE_STORES) {
          if (liveDb.objectStoreNames.contains(store)) {
            const count = await getStoreRecordCount(liveDb, store);
            liveTotal += count;
          }
        }

        // If snapshot has 0 records but expected data > 0 OR liveDb had records:
        if (snapshotTotal === 0 && (expectedTotal > 0 || liveTotal > 0)) {
          console.error(
            `[Crash Recovery] CRITICAL ERROR: Snapshot database "${marker.snapshotDbName}" has 0 records while data was expected! ` +
            `Refusing to touch live database "${marker.liveDbName}" to prevent data destruction.`
          );
          return {
            state: 'failed',
            reason: `Snapshot database "${marker.snapshotDbName}" has 0 records while data was expected`,
            snapshotPreserved: true,
          };
        }

        // Unverified stage: rollback to snapshot
        await setRestoreJournalMarker({
          ...marker,
          stage: 'rollback_in_progress',
        }, idbFactory);

        const storesToClear = (ALL_NINE_STORES as unknown as string[]).filter((s) => liveDb!.objectStoreNames.contains(s));
        await new Promise<void>((resolve, reject) => {
          const tx = liveDb!.transaction(storesToClear, 'readwrite');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error || new Error('Live DB clear aborted during recovery'));
          tx.onerror = () => reject(tx.error || new Error('Live DB clear error during recovery'));
          for (const store of storesToClear) {
            tx.objectStore(store).clear();
          }
        });

        const snapshotStores = EIGHT_SNAPSHOT_STORES.filter((s) => liveDb!.objectStoreNames.contains(s));
        for (const store of snapshotStores) {
          if (snapshotDb.objectStoreNames.contains(store)) {
            await copyStoreRecords(snapshotDb, liveDb!, store, false);
          }
        }

        const verified = await verifyDatabaseEquality(snapshotDb, liveDb!, snapshotStores);
        if (!verified) {
          return {
            state: 'failed',
            reason: 'Crash recovery verification mismatch between snapshot and restored live database.',
            snapshotPreserved: true,
          };
        }

        await setRestoreJournalMarker(null, idbFactory);
        if (snapshotDb) {
          try { snapshotDb.close(); } catch {}
          snapshotDb = null;
        }
        closeExtensionDatabase(idbFactory, marker.snapshotDbName);
        await deleteExtensionDatabase(idbFactory, marker.snapshotDbName);
        closeExtensionDatabase(idbFactory, marker.stagingDbName);
        await deleteExtensionDatabase(idbFactory, marker.stagingDbName);

        console.info('[Crash Recovery] Live database successfully recovered and verified from snapshot.');
        return {
          state: 'recovered',
          durationMs: Date.now() - startTime,
          details: 'Live database safely rolled back and verified from pre-crash snapshot.',
        };
      } catch (err: any) {
        console.error('[Crash Recovery] Failed to recover from crash snapshot:', err);
        return {
          state: 'failed',
          reason: err?.message || 'Unknown error during crash recovery',
          snapshotPreserved: true,
        };
      } finally {
        if (snapshotDb) {
          try { snapshotDb.close(); } catch {}
        }
      }
    }, 30_000);
  } catch (lockErr: any) {
    console.warn('[Crash Recovery] Recovery lock could not be acquired (another context active):', lockErr);
    return {
      state: 'blocked',
      reason: lockErr?.message || 'Recovery lock could not be acquired',
    };
  }
}

/**
 * Creates a fresh, isolated stream from input without accumulating memory via tee().
 */
export function createFreshInputStream(
  input: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>
): { stream: ReadableStream<Uint8Array>; isSingleUse: boolean } {
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return { stream: input.stream(), isSingleUse: false };
  }
  if (input instanceof ArrayBuffer) {
    const u8 = new Uint8Array(input);
    return {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(u8);
          controller.close();
        },
      }),
      isSingleUse: false,
    };
  }
  if (input instanceof Uint8Array) {
    return {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(input);
          controller.close();
        },
      }),
      isSingleUse: false,
    };
  }
  if (input instanceof ReadableStream) {
    return { stream: input, isSingleUse: true };
  }
  throw new Error('Unsupported backup archive input type.');
}

/**
 * Writes a batch of heterogeneous records into the staging database.
 */
async function flushBatchToStaging(
  stagingDb: IDBDatabase,
  items: Array<{ store: IncludedBackupStoreName; record: unknown }>
): Promise<void> {
  if (items.length === 0) return;

  const storesInBatch = Array.from(new Set(items.map((i) => i.store)));
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = stagingDb.transaction(storesInBatch, 'readwrite');
    } catch (err) {
      return reject(new Error(`Failed to open staging transaction: ${(err as Error).message}`));
    }

    tx.onabort = () => reject(new Error(`Staging write transaction aborted: ${tx.error?.message || 'Aborted'}`));
    tx.onerror = () => reject(new Error(`Staging write transaction failed: ${tx.error?.message || 'Error'}`));
    tx.oncomplete = () => resolve();

    for (const item of items) {
      const store = tx.objectStore(item.store);
      store.put(item.record);
    }
  });
}

/**
 * Fetches a single batch of records from an IndexedDB object store using a key cursor.
 */
async function fetchStoreBatch(
  db: IDBDatabase,
  storeName: string,
  lastKey: IDBValidKey | null,
  limit = BATCH_SIZE
): Promise<Array<{ key: IDBValidKey; value: any }>> {
  const keyRangeClass = typeof IDBKeyRange !== 'undefined' ? IDBKeyRange : (globalThis as any)?.IDBKeyRange;
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, 'readonly');
    } catch (err) {
      return reject(err);
    }
    const store = tx.objectStore(storeName);
    const range = lastKey !== null && keyRangeClass ? keyRangeClass.lowerBound(lastKey, true) : null;
    const req = store.openCursor(range);
    const items: Array<{ key: IDBValidKey; value: any }> = [];

    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && items.length < limit) {
        items.push({ key: cursor.key, value: cursor.value });
        cursor.continue();
      } else {
        resolve(items);
      }
    };
  });
}

/**
 * Safely fetches multiple records by primary key within a single transaction tick.
 * Eliminates TransactionInactiveError in genuine Chromium by enqueuing all get requests
 * synchronously before yielding control to the microtask loop.
 */
export async function batchGetKeys(
  db: IDBDatabase,
  storeName: string,
  keys: readonly IDBValidKey[]
): Promise<Map<IDBValidKey, any>> {
  if (keys.length === 0) return new Map();
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, 'readonly');
    } catch (err) {
      return reject(new Error(`Failed to open readonly transaction for "${storeName}": ${(err as Error).message}`));
    }
    const store = tx.objectStore(storeName);
    const map = new Map<IDBValidKey, any>();
    let count = 0;
    let errored = false;

    for (const key of keys) {
      const req = store.get(key);
      req.onsuccess = () => {
        if (!errored) {
          map.set(key, req.result !== undefined ? req.result : null);
          count++;
          if (count === keys.length) resolve(map);
        }
      };
      req.onerror = () => {
        if (!errored) {
          errored = true;
          reject(req.error || new Error(`Failed to read record for key "${String(key)}" from "${storeName}"`));
        }
      };
    }
  });
}

/**
 * Validates referential integrity directly against the staging database using cursor batches.
 * Peak memory consumption is strictly bounded (< 2 MiB RAM) without accumulating in-memory graphs.
 */
/**
 * Robustly verifies that all restored records from the confirmed baseline (stagingDb in Replace mode,
 * snapshotDb + stagingDb in Merge mode) remain 100% intact and uncorrupted in liveDb, even when
 * subsequent legitimate writes or new conversation turns have been appended.
 *
 * Catches:
 * - Silent mutation of historical revisions (e.g. text/thinking corruption)
 * - Loss or deletion of existing restored records
 * - In-place replacement of records under identical IDs with conflicting content
 * - Broken referential integrity in subsequent writes
 */
export async function verifyRestoredBaselinePreserved(
  liveDb: IDBDatabase,
  marker: RestoreJournalMarker,
  idbFactory?: IDBFactory
): Promise<{ valid: boolean; reason?: string }> {
  // 1. Relational integrity of liveDb is always a prerequisite
  const relResult = await validateStagingReferentialIntegrity(liveDb);
  if (!relResult.valid) {
    return {
      valid: false,
      reason: `Relational integrity violated in live database: ${relResult.errors.map((e) => e.message).join('; ')}`,
    };
  }

  // Helper to compare an individual record against baseline
  const checkBaselineRecordPreserved = async (
    storeName: string,
    baselineRecord: any,
    liveRecord: any,
    liveDb: IDBDatabase
  ): Promise<{ preserved: boolean; reason?: string }> => {
    if (!liveRecord) {
      return { preserved: false, reason: 'Record does not exist in live database' };
    }

    if (
      storeName === STORE_REVISIONS ||
      storeName === STORE_RECOVERY_EVENTS ||
      storeName === STORE_RAW_STREAMS ||
      storeName === STORE_RAW_STREAM_BATCHES
    ) {
      // Revisions, recovery events, and raw stream records are STRICTLY IMMUTABLE!
      if (!deepEqualRecords(storeName, baselineRecord, liveRecord)) {
        return {
          preserved: false,
          reason: `Immutable record "${String(baselineRecord.id)}" in store "${storeName}" has been modified or corrupted in live database`,
        };
      }
      return { preserved: true };
    }

    if (storeName === STORE_MESSAGES) {
      // 1. Core immutable identifiers
      if (liveRecord.id !== baselineRecord.id) {
        return { preserved: false, reason: `Message id mismatch: "${liveRecord.id}" !== "${baselineRecord.id}"` };
      }
      if (liveRecord.conversationId !== baselineRecord.conversationId) {
        return { preserved: false, reason: `Message "${baselineRecord.id}" conversationId mismatch: "${liveRecord.conversationId}" !== "${baselineRecord.conversationId}"` };
      }
      if (liveRecord.role !== baselineRecord.role) {
        return { preserved: false, reason: `Message "${baselineRecord.id}" role mismatch: "${liveRecord.role}" !== "${baselineRecord.role}"` };
      }
      if (liveRecord.createdAt !== baselineRecord.createdAt) {
        return { preserved: false, reason: `Message "${baselineRecord.id}" createdAt mismatch: ${liveRecord.createdAt} !== ${baselineRecord.createdAt}` };
      }
      if (baselineRecord.remoteCreatedAt !== undefined && liveRecord.remoteCreatedAt !== baselineRecord.remoteCreatedAt) {
        return { preserved: false, reason: `Message "${baselineRecord.id}" remoteCreatedAt mismatch: ${liveRecord.remoteCreatedAt} !== ${baselineRecord.remoteCreatedAt}` };
      }

      // 2. Authoritative server identity
      if (baselineRecord.remoteId !== undefined && liveRecord.remoteId !== baselineRecord.remoteId) {
        return { preserved: false, reason: `Message "${baselineRecord.id}" confirmed remoteId changed from "${baselineRecord.remoteId}" to "${liveRecord.remoteId}"` };
      }
      if (baselineRecord.remoteParentId !== undefined && liveRecord.remoteParentId !== baselineRecord.remoteParentId) {
        return { preserved: false, reason: `Message "${baselineRecord.id}" confirmed remoteParentId changed from "${baselineRecord.remoteParentId}" to "${liveRecord.remoteParentId}"` };
      }

      // 3. Raw stream linkage & continuity receipts
      if (baselineRecord.sourceRawStreamKey !== undefined && liveRecord.sourceRawStreamKey !== baselineRecord.sourceRawStreamKey) {
        return { preserved: false, reason: `Message "${baselineRecord.id}" sourceRawStreamKey changed from "${baselineRecord.sourceRawStreamKey}" to "${liveRecord.sourceRawStreamKey}"` };
      }
      if (baselineRecord.contextContinuityDeliveryId !== undefined && liveRecord.contextContinuityDeliveryId !== baselineRecord.contextContinuityDeliveryId) {
        return { preserved: false, reason: `Message "${baselineRecord.id}" contextContinuityDeliveryId changed from "${baselineRecord.contextContinuityDeliveryId}" to "${liveRecord.contextContinuityDeliveryId}"` };
      }

      // 4. Identity state promotion: 'reconciled' is terminal
      if (baselineRecord.identityState === 'reconciled' && liveRecord.identityState !== 'reconciled') {
        return { preserved: false, reason: `Message "${baselineRecord.id}" identityState downgraded from "reconciled" to "${liveRecord.identityState}"` };
      }

      // 5. Projection state invariants:
      // - Confirmed 'logical' must NEVER be downgraded to 'attempt_only' or 'unmatched_capture'
      // - 'provisional_logical' may advance to 'logical', but cannot be degraded to 'attempt_only' or 'unmatched_capture'
      if (baselineRecord.projectionState === 'logical') {
        if (liveRecord.projectionState !== 'logical') {
          return { preserved: false, reason: `Message "${baselineRecord.id}" projectionState changed from "logical" to "${liveRecord.projectionState}"` };
        }
      } else if (baselineRecord.projectionState === 'provisional_logical') {
        if (liveRecord.projectionState !== 'provisional_logical' && liveRecord.projectionState !== 'logical') {
          return { preserved: false, reason: `Message "${baselineRecord.id}" projectionState degraded from "provisional_logical" to "${liveRecord.projectionState}"` };
        }
      } else if (baselineRecord.projectionState === undefined) {
        if (baselineRecord.identityState === 'reconciled' || baselineRecord.role === 'user') {
          if (liveRecord.projectionState === 'attempt_only' || liveRecord.projectionState === 'unmatched_capture') {
            return { preserved: false, reason: `Message "${baselineRecord.id}" implicitly logical turn degraded to "${liveRecord.projectionState}"` };
          }
        }
      }

      // 6. Status preservation invariants:
      // - Filtered response MUST retain 'filtered' status (core StreamArchive guarantee)
      if (baselineRecord.status === 'filtered' && liveRecord.status !== 'filtered') {
        return { preserved: false, reason: `Filtered message "${baselineRecord.id}" lost its filtered status (current: "${liveRecord.status}")` };
      }
      // - Finished message must not be degraded to streaming or incomplete
      if (baselineRecord.status === 'finished') {
        if (liveRecord.status === 'streaming' || liveRecord.status === 'incomplete') {
          return { preserved: false, reason: `Finished message "${baselineRecord.id}" degraded to "${liveRecord.status}"` };
        }
      }

      // 7. Message content preservation:
      if (baselineRecord.role === 'user' || baselineRecord.role === 'system') {
        if (typeof baselineRecord.content === 'string') {
          if (liveRecord.content !== baselineRecord.content) {
            return {
              preserved: false,
              reason: `User message "${baselineRecord.id}" content mismatch: expected "${baselineRecord.content.slice(0, 40)}...", got "${(liveRecord.content ?? '').slice(0, 40)}..."`,
            };
          }
        }
      } else if (baselineRecord.role === 'assistant') {
        if (typeof baselineRecord.content === 'string' && baselineRecord.content.length > 0) {
          if (typeof liveRecord.content !== 'string') {
            return { preserved: false, reason: `Assistant message "${baselineRecord.id}" content was wiped or removed` };
          }
          if (liveRecord.content !== baselineRecord.content) {
            const wasStreaming = baselineRecord.status === 'streaming' || baselineRecord.status === 'incomplete';
            if (wasStreaming && liveRecord.content.startsWith(baselineRecord.content)) {
              // Legitimate streaming continuation
            } else {
              return {
                preserved: false,
                reason: `Assistant message "${baselineRecord.id}" content was mutated without legitimate streaming continuation`,
              };
            }
          }
        }
      }

      // 8. parentId resolution and preservation:
      if (baselineRecord.parentId === liveRecord.parentId) {
        // Preserved!
      } else {
        if (baselineRecord.parentId !== undefined) {
          const wasRawRemoteId = baselineRecord.remoteParentId && baselineRecord.parentId === baselineRecord.remoteParentId;
          if (wasRawRemoteId && liveRecord.parentId) {
            const parentMap = await batchGetKeys(liveDb, STORE_MESSAGES, [liveRecord.parentId]);
            const parent = parentMap.get(liveRecord.parentId) as Message | undefined;
            if (!parent || parent.remoteId !== baselineRecord.remoteParentId || !isValidRoleParentage(liveRecord.role, parent.role)) {
              return {
                preserved: false,
                reason: `Message "${baselineRecord.id}" parentId was substituted from raw remoteParentId "${baselineRecord.remoteParentId}" to an invalid or unconfirmed parent "${liveRecord.parentId}"`,
              };
            }
          } else {
            return {
              preserved: false,
              reason: `Message "${baselineRecord.id}" parentId was substituted from "${baselineRecord.parentId}" to "${liveRecord.parentId}" without history resolution`,
            };
          }
        } else {
          // Baseline had parentId === undefined (was root or unresolved provisional message).
          if (liveRecord.parentId) {
            const expectedRemoteParent = baselineRecord.remoteParentId || liveRecord.remoteParentId;
            if (!expectedRemoteParent) {
              return {
                preserved: false,
                reason: `Root message "${baselineRecord.id}" without remoteParentId was arbitrarily assigned parentId "${liveRecord.parentId}"`,
              };
            }
            const parentMap = await batchGetKeys(liveDb, STORE_MESSAGES, [liveRecord.parentId]);
            const parent = parentMap.get(liveRecord.parentId) as Message | undefined;
            if (!parent || parent.remoteId !== expectedRemoteParent || !isValidRoleParentage(liveRecord.role, parent.role)) {
              return {
                preserved: false,
                reason: `Message "${baselineRecord.id}" parentId "${liveRecord.parentId}" does not resolve to confirmed remoteParentId "${expectedRemoteParent}"`,
              };
            }
          }
        }
      }

      // 9. Time monotonicity
      if (typeof liveRecord.updatedAt === 'number' && typeof baselineRecord.updatedAt === 'number') {
        if (liveRecord.updatedAt < baselineRecord.updatedAt) {
          return { preserved: false, reason: `Message "${baselineRecord.id}" updatedAt went backward: ${liveRecord.updatedAt} < ${baselineRecord.updatedAt}` };
        }
      }

      return { preserved: true };
    }

    if (storeName === STORE_CONVERSATIONS) {
      if (liveRecord.id !== baselineRecord.id) {
        return { preserved: false, reason: `Conversation id mismatch: "${liveRecord.id}" !== "${baselineRecord.id}"` };
      }
      if (liveRecord.createdAt !== baselineRecord.createdAt) {
        return { preserved: false, reason: `Conversation "${baselineRecord.id}" createdAt mismatch: ${liveRecord.createdAt} !== ${baselineRecord.createdAt}` };
      }
      if (baselineRecord.remoteId !== undefined && liveRecord.remoteId !== baselineRecord.remoteId) {
        return { preserved: false, reason: `Conversation "${baselineRecord.id}" remoteId changed from "${baselineRecord.remoteId}" to "${liveRecord.remoteId}"` };
      }

      // Title: must remain non-empty string if baseline title was non-empty
      if (typeof liveRecord.title !== 'string') {
        return { preserved: false, reason: `Conversation "${baselineRecord.id}" title is not a string` };
      }
      if (typeof baselineRecord.title === 'string' && baselineRecord.title.trim().length > 0) {
        if (liveRecord.title.trim().length === 0) {
          return { preserved: false, reason: `Conversation "${baselineRecord.id}" title was wiped or emptied` };
        }
      }

      // currentMessageId:
      if (baselineRecord.currentMessageId !== undefined && liveRecord.currentMessageId === undefined) {
        return { preserved: false, reason: `Conversation "${baselineRecord.id}" currentMessageId was cleared or lost` };
      }
      if (liveRecord.currentMessageId) {
        const msgMap = await batchGetKeys(liveDb, STORE_MESSAGES, [liveRecord.currentMessageId]);
        const currentMsg = msgMap.get(liveRecord.currentMessageId) as Message | undefined;
        if (!currentMsg) {
          return { preserved: false, reason: `Conversation "${baselineRecord.id}" currentMessageId "${liveRecord.currentMessageId}" does not exist in messages store` };
        }
        if (currentMsg.conversationId !== liveRecord.id) {
          return { preserved: false, reason: `Conversation "${baselineRecord.id}" currentMessageId "${liveRecord.currentMessageId}" belongs to another conversation "${currentMsg.conversationId}"` };
        }
      }

      // Time monotonicity
      if (typeof liveRecord.updatedAt === 'number' && typeof baselineRecord.updatedAt === 'number') {
        if (liveRecord.updatedAt < baselineRecord.updatedAt) {
          return { preserved: false, reason: `Conversation "${baselineRecord.id}" updatedAt went backward: ${liveRecord.updatedAt} < ${baselineRecord.updatedAt}` };
        }
      }

      return { preserved: true };
    }

    if (!deepEqualRecords(storeName, baselineRecord, liveRecord)) {
      return {
        preserved: false,
        reason: `Record "${String(baselineRecord.id)}" in store "${storeName}" has been modified or corrupted in live database`,
      };
    }
    return { preserved: true };
  };

  if (marker.type === 'replace') {
    let stagingDb: IDBDatabase | null = null;
    try {
      stagingDb = await openExistingSnapshotWithoutCreating(idbFactory, marker.stagingDbName);
    } catch {
      return {
        valid: false,
        reason: `Cannot verify replace baseline: staging database "${marker.stagingDbName}" cannot be opened`,
      };
    }
    if (!stagingDb) {
      return {
        valid: false,
        reason: `Cannot verify replace baseline: staging database "${marker.stagingDbName}" was not found`,
      };
    }

    try {
      for (const storeName of SIX_DURABLE_STORES) {
        if (!stagingDb.objectStoreNames.contains(storeName)) continue;
        if (!liveDb.objectStoreNames.contains(storeName)) {
          return {
            valid: false,
            reason: `Mandatory store "${storeName}" missing in live database`,
          };
        }

        let lastKey: IDBValidKey | null = null;
        while (true) {
          const batch = await fetchStoreBatch(stagingDb, storeName, lastKey, BATCH_SIZE);
          if (batch.length === 0) break;
          lastKey = batch[batch.length - 1]!.key;

          const keys = batch.map((item) => item.key);
          const liveMap = await batchGetKeys(liveDb, storeName, keys);

          for (const item of batch) {
            const liveRecord = liveMap.get(item.key);
            if (!liveRecord) {
              return {
                valid: false,
                reason: `Restored record "${String(item.key)}" in store "${storeName}" was lost or deleted from live database`,
              };
            }
            const check = await checkBaselineRecordPreserved(storeName, item.value, liveRecord, liveDb);
            if (!check.preserved) {
              return {
                valid: false,
                reason: `Restored record "${String(item.key)}" in store "${storeName}" was mutated or corrupted: ${check.reason}`,
              };
            }
          }

          if (batch.length < BATCH_SIZE) break;
        }
      }
    } finally {
      try { stagingDb.close(); } catch {}
    }

    return { valid: true };
  } else {
    // Mode: Merge
    let snapshotDb: IDBDatabase | null = null;
    let stagingDb: IDBDatabase | null = null;

    try {
      snapshotDb = await openExistingSnapshotWithoutCreating(idbFactory, marker.snapshotDbName);
    } catch {
      return {
        valid: false,
        reason: `Cannot verify merge baseline: snapshot database "${marker.snapshotDbName}" cannot be opened`,
      };
    }
    if (!snapshotDb) {
      return {
        valid: false,
        reason: `Cannot verify merge baseline: snapshot database "${marker.snapshotDbName}" was not found`,
      };
    }

    try {
      stagingDb = await openExistingSnapshotWithoutCreating(idbFactory, marker.stagingDbName);
    } catch {
      try { snapshotDb.close(); } catch {}
      return {
        valid: false,
        reason: `Cannot verify merge baseline: staging database "${marker.stagingDbName}" cannot be opened`,
      };
    }
    if (!stagingDb) {
      try { snapshotDb.close(); } catch {}
      return {
        valid: false,
        reason: `Cannot verify merge baseline: staging database "${marker.stagingDbName}" was not found`,
      };
    }

    try {
      for (const storeName of SIX_DURABLE_STORES) {
        if (!liveDb.objectStoreNames.contains(storeName)) {
          return { valid: false, reason: `Store "${storeName}" missing in live database` };
        }

        // 1. Every pre-merge record in snapshotDb must exist and be preserved in liveDb
        if (snapshotDb.objectStoreNames.contains(storeName)) {
          let lastKey: IDBValidKey | null = null;
          while (true) {
            const batch = await fetchStoreBatch(snapshotDb, storeName, lastKey, BATCH_SIZE);
            if (batch.length === 0) break;
            lastKey = batch[batch.length - 1]!.key;

            const keys = batch.map((item) => item.key);
            const liveMap = await batchGetKeys(liveDb, storeName, keys);

            for (const item of batch) {
              const liveRecord = liveMap.get(item.key);
              if (!liveRecord) {
                return {
                  valid: false,
                  reason: `Pre-existing record "${String(item.key)}" in store "${storeName}" was lost or deleted from live database`,
                };
              }
              const check = await checkBaselineRecordPreserved(storeName, item.value, liveRecord, liveDb);
              if (!check.preserved) {
                return {
                  valid: false,
                  reason: `Pre-existing record "${String(item.key)}" in store "${storeName}" was mutated or corrupted: ${check.reason}`,
                };
              }
            }

            if (batch.length < BATCH_SIZE) break;
          }
        }

        // 2. Every non-conflicting record imported from stagingDb must exist and be preserved in liveDb
        if (stagingDb.objectStoreNames.contains(storeName)) {
          let lastKey: IDBValidKey | null = null;
          while (true) {
            const batch = await fetchStoreBatch(stagingDb, storeName, lastKey, BATCH_SIZE);
            if (batch.length === 0) break;
            lastKey = batch[batch.length - 1]!.key;

            const keys = batch.map((item) => item.key);
            const [liveMap, snapMap] = await Promise.all([
              batchGetKeys(liveDb, storeName, keys),
              snapshotDb.objectStoreNames.contains(storeName)
                ? batchGetKeys(snapshotDb, storeName, keys)
                : Promise.resolve(new Map()),
            ]);

            for (const item of batch) {
              const liveRecord = liveMap.get(item.key);
              if (!liveRecord) {
                return {
                  valid: false,
                  reason: `Imported record "${String(item.key)}" in store "${storeName}" was lost or missing from live database`,
                };
              }
              const inSnap = snapMap.get(item.key);
              if (!inSnap) {
                // Was newly inserted during merge: must match imported staging record
                const check = await checkBaselineRecordPreserved(storeName, item.value, liveRecord, liveDb);
                if (!check.preserved) {
                  return {
                    valid: false,
                    reason: `Imported record "${String(item.key)}" in store "${storeName}" was mutated or corrupted: ${check.reason}`,
                  };
                }
              }
            }

            if (batch.length < BATCH_SIZE) break;
          }
        }
      }
    } finally {
      try { snapshotDb.close(); } catch {}
      try { stagingDb.close(); } catch {}
    }

    return { valid: true };
  }
}

export async function validateStagingReferentialIntegrity(
  stagingDb: IDBDatabase
): Promise<IntegrityValidationResult> {
  const errors: IntegrityValidationError[] = [];

  // 1. Messages referential integrity
  if (stagingDb.objectStoreNames.contains(STORE_MESSAGES) && stagingDb.objectStoreNames.contains(STORE_CONVERSATIONS)) {
    let lastKey: IDBValidKey | null = null;
    while (true) {
      const batch = await fetchStoreBatch(stagingDb, STORE_MESSAGES, lastKey, BATCH_SIZE);
      if (batch.length === 0) break;
      lastKey = batch[batch.length - 1]!.key;

      const convIds = Array.from(new Set(batch.map((item) => (item.value as Message).conversationId)));
      const parentIds = Array.from(
        new Set(
          batch
            .map((item) => (item.value as Message).parentId)
            .filter((pid): pid is string => Boolean(pid))
        )
      );

      const [convMap, parentMap] = await Promise.all([
        batchGetKeys(stagingDb, STORE_CONVERSATIONS, convIds),
        batchGetKeys(stagingDb, STORE_MESSAGES, parentIds),
      ]);

      for (const item of batch) {
        const msg = item.value as Message;
        // Check conversationId
        const conv = convMap.get(msg.conversationId);
        if (!conv) {
          errors.push({
            code: 'orphan_message',
            message: `Message "${msg.id}" references non-existent conversation "${msg.conversationId}".`,
            entityId: msg.id,
            relatedId: msg.conversationId,
          });
        }

        // Check parentId
        if (msg.parentId) {
          if (msg.parentId === msg.id) {
            errors.push({
              code: 'self_parent_cycle',
              message: `Message "${msg.id}" has parentId pointing to itself.`,
              entityId: msg.id,
            });
          } else {
            const parent = parentMap.get(msg.parentId);
            if (!parent) {
              errors.push({
                code: 'missing_parent_message',
                message: `Message "${msg.id}" references non-existent parent message "${msg.parentId}".`,
                entityId: msg.id,
                relatedId: msg.parentId,
              });
            } else if (parent.conversationId !== msg.conversationId) {
              errors.push({
                code: 'cross_conversation_parent',
                message: `Message "${msg.id}" (conv: "${msg.conversationId}") has parent "${parent.id}" in a different conversation ("${parent.conversationId}").`,
                entityId: msg.id,
                relatedId: parent.id,
              });
            } else if (!isValidRoleParentage(msg.role, parent.role)) {
              errors.push({
                code: 'invalid_role_parentage',
                message: `Message "${msg.id}" (role: "${msg.role}") has parent "${parent.id}" with invalid role "${parent.role}".`,
                entityId: msg.id,
                relatedId: parent.id,
              });
            }
          }
        }
      }
      if (batch.length < BATCH_SIZE) break;
    }
  }

  // 1b. Conversations currentMessageId referential integrity
  if (stagingDb.objectStoreNames.contains(STORE_CONVERSATIONS) && stagingDb.objectStoreNames.contains(STORE_MESSAGES)) {
    let lastKey: IDBValidKey | null = null;
    while (true) {
      const batch = await fetchStoreBatch(stagingDb, STORE_CONVERSATIONS, lastKey, BATCH_SIZE);
      if (batch.length === 0) break;
      lastKey = batch[batch.length - 1]!.key;

      const currentMsgIds = Array.from(
        new Set(
          batch
            .map((item) => (item.value as Conversation).currentMessageId)
            .filter((id): id is string => Boolean(id))
        )
      );

      const msgMap = await batchGetKeys(stagingDb, STORE_MESSAGES, currentMsgIds);

      for (const item of batch) {
        const conv = item.value as Conversation;
        if (conv.currentMessageId) {
          const targetMsg = msgMap.get(conv.currentMessageId);
          if (!targetMsg) {
            errors.push({
              code: 'missing_current_message',
              message: `Conversation "${conv.id}" references non-existent currentMessageId "${conv.currentMessageId}".`,
              entityId: conv.id,
              relatedId: conv.currentMessageId,
            });
          } else if (targetMsg.conversationId !== conv.id) {
            errors.push({
              code: 'cross_conversation_current_message',
              message: `Conversation "${conv.id}" references currentMessageId "${conv.currentMessageId}" belonging to conversation "${targetMsg.conversationId}".`,
              entityId: conv.id,
              relatedId: conv.currentMessageId,
            });
          }
        }
      }
      if (batch.length < BATCH_SIZE) break;
    }
  }

  // 2. Revisions referential integrity
  if (stagingDb.objectStoreNames.contains(STORE_REVISIONS) && stagingDb.objectStoreNames.contains(STORE_MESSAGES)) {
    let lastKey: IDBValidKey | null = null;
    while (true) {
      const batch = await fetchStoreBatch(stagingDb, STORE_REVISIONS, lastKey, BATCH_SIZE);
      if (batch.length === 0) break;
      lastKey = batch[batch.length - 1]!.key;

      const msgIds = Array.from(new Set(batch.map((item) => (item.value as ResponseRevision).messageId)));
      const msgMap = await batchGetKeys(stagingDb, STORE_MESSAGES, msgIds);

      for (const item of batch) {
        const rev = item.value as ResponseRevision;
        const msg = msgMap.get(rev.messageId);
        if (!msg) {
          errors.push({
            code: 'orphan_revision',
            message: `Revision "${rev.id}" references non-existent message "${rev.messageId}".`,
            entityId: rev.id,
            relatedId: rev.messageId,
          });
        }
      }
      if (batch.length < BATCH_SIZE) break;
    }
  }

  // 3. Raw stream batches referential integrity
  if (stagingDb.objectStoreNames.contains(STORE_RAW_STREAM_BATCHES) && stagingDb.objectStoreNames.contains(STORE_RAW_STREAMS)) {
    let lastKey: IDBValidKey | null = null;
    while (true) {
      const batch = await fetchStoreBatch(stagingDb, STORE_RAW_STREAM_BATCHES, lastKey, BATCH_SIZE);
      if (batch.length === 0) break;
      lastKey = batch[batch.length - 1]!.key;

      const streamKeys = Array.from(new Set(batch.map((item) => (item.value as RawStreamBatch).streamKey)));
      const streamMap = await batchGetKeys(stagingDb, STORE_RAW_STREAMS, streamKeys);

      for (const item of batch) {
        const b = item.value as RawStreamBatch;
        const raw = streamMap.get(b.streamKey);
        if (!raw) {
          errors.push({
            code: 'orphan_raw_batch',
            message: `Raw stream batch "${b.id}" references non-existent raw stream "${b.streamKey}".`,
            entityId: b.id,
            relatedId: b.streamKey,
          });
        }
      }
      if (batch.length < BATCH_SIZE) break;
    }
  }

  // 4. Recovery events referential integrity
  if (stagingDb.objectStoreNames.contains(STORE_RECOVERY_EVENTS)) {
    let lastKey: IDBValidKey | null = null;
    const hasMessages = stagingDb.objectStoreNames.contains(STORE_MESSAGES);
    const hasRevisions = stagingDb.objectStoreNames.contains(STORE_REVISIONS);

    while (true) {
      const batch = await fetchStoreBatch(stagingDb, STORE_RECOVERY_EVENTS, lastKey, BATCH_SIZE);
      if (batch.length === 0) break;
      lastKey = batch[batch.length - 1]!.key;

      const msgIds = hasMessages
        ? Array.from(new Set(batch.map((item) => (item.value as RecoveryEvent).messageId).filter(Boolean) as string[]))
        : [];
      const revIds = hasRevisions
        ? Array.from(new Set(batch.map((item) => (item.value as RecoveryEvent).recoveredRevisionId).filter(Boolean) as string[]))
        : [];

      const [msgMap, revMap] = await Promise.all([
        hasMessages ? batchGetKeys(stagingDb, STORE_MESSAGES, msgIds) : Promise.resolve(new Map()),
        hasRevisions ? batchGetKeys(stagingDb, STORE_REVISIONS, revIds) : Promise.resolve(new Map()),
      ]);

      for (const item of batch) {
        const ev = item.value as RecoveryEvent;
        if (ev.messageId && hasMessages) {
          const m = msgMap.get(ev.messageId);
          if (!m) {
            errors.push({
              code: 'orphan_recovery_event',
              message: `Recovery event "${ev.id}" references non-existent message "${ev.messageId}".`,
              entityId: ev.id,
              relatedId: ev.messageId,
            });
          }
        }

        if (ev.recoveredRevisionId && hasRevisions) {
          const r = revMap.get(ev.recoveredRevisionId);
          if (!r) {
            errors.push({
              code: 'orphan_recovery_event_revision',
              message: `Recovery event "${ev.id}" references non-existent revision "${ev.recoveredRevisionId}".`,
              entityId: ev.id,
              relatedId: ev.recoveredRevisionId,
            });
          }
        }
      }
      if (batch.length < BATCH_SIZE) break;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface IngestStagingResult {
  stagingDb: IDBDatabase;
  stagingDbName: string;
  manifest: import('../backup/format').PortableBackupManifestRecord;
  footer: import('../backup/format').PortableBackupFooterRecord;
  counts: PortableBackupStoreCounts;
}

/**
 * Ingests an archive stream chunk-by-chunk into the staging database.
 * Memory consumption is strictly bounded (< 5 MiB RAM) regardless of archive size.
 * Uses an isolated staging database per operation to prevent concurrent collisions.
 */
export async function ingestArchiveToStaging(
  input: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
  idbFactory?: IDBFactory,
  customStagingDbName?: string
): Promise<IngestStagingResult> {
  const stagingDbName = customStagingDbName || createStagingDatabaseName();
  const { stream } = createFreshInputStream(input);

  // Clean prior staging database if any existed with this name
  await deleteExtensionDatabase(idbFactory, stagingDbName);
  const stagingDb = await openExtensionDatabase(idbFactory, stagingDbName);

  const buffer: Array<{ store: IncludedBackupStoreName; record: unknown }> = [];

  const readResult = await readPortableBackup(stream, {
    inspectionOnly: true,
    onRecord: async (store, record) => {
      // Buffer record and flush periodically in batches of BATCH_SIZE
      buffer.push({ store, record });
      if (buffer.length >= BATCH_SIZE) {
        const toFlush = buffer.splice(0, buffer.length);
        await flushBatchToStaging(stagingDb, toFlush);
      }
    },
  });

  // Flush remaining records
  if (buffer.length > 0) {
    const toFlush = buffer.splice(0, buffer.length);
    await flushBatchToStaging(stagingDb, toFlush);
  }

  if (!readResult.success || !readResult.backup) {
    closeExtensionDatabase(idbFactory, stagingDbName);
    await deleteExtensionDatabase(idbFactory, stagingDbName);
    throw new Error(`Failed to read backup archive: ${readResult.errors.map((e) => e.message).join('; ')}`);
  }

  // Validate referential integrity directly against stagingDb
  const integrity = await validateStagingReferentialIntegrity(stagingDb);
  if (!integrity.valid) {
    closeExtensionDatabase(idbFactory, stagingDbName);
    await deleteExtensionDatabase(idbFactory, stagingDbName);
    throw new Error(`Referential integrity failed: ${integrity.errors.map((e) => e.message).join('; ')}`);
  }

  return {
    stagingDb,
    stagingDbName,
    manifest: readResult.backup.manifest,
    footer: readResult.backup.footer,
    counts: readResult.backup.footer.counts,
  };
}

/**
 * Builds a restore plan by comparing records in stagingDb with liveDb using cursor batches.
 * Eliminates getAll() to guarantee memory boundedness (< 5 MiB RAM).
 */
export async function buildRestorePlanFromStaging(
  liveDb: IDBDatabase,
  stagingDb: IDBDatabase,
  mode: RestoreMode,
  stagingCounts: PortableBackupStoreCounts
): Promise<RestorePlan> {
  if (mode === 'replace') {
    return {
      mode: 'replace',
      valid: true,
      toInsert: {
        conversations: [],
        messages: [],
        revisions: [],
        recovery_events: [],
        raw_streams: [],
        raw_stream_batches: [],
      },
      toInsertCounts: { ...stagingCounts },
      toSkip: {
        conversations: 0,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      conflicts: [],
    };
  }

  // Mode: merge
  const conflicts: RestoreConflict[] = [];
  const toSkip: PortableBackupStoreCounts = {
    conversations: 0,
    messages: 0,
    revisions: 0,
    recovery_events: 0,
    raw_streams: 0,
    raw_stream_batches: 0,
  };
  const toInsertCounts: PortableBackupStoreCounts = {
    conversations: 0,
    messages: 0,
    revisions: 0,
    recovery_events: 0,
    raw_streams: 0,
    raw_stream_batches: 0,
  };
  const toInsert: RestorePlan['toInsert'] = {
    conversations: [],
    messages: [],
    revisions: [],
    recovery_events: [],
    raw_streams: [],
    raw_stream_batches: [],
  };

  for (const storeName of SIX_DURABLE_STORES) {
    let lastKey: IDBValidKey | null = null;

    while (true) {
      // 1. Fetch batch from stagingDb via cursor (strictly bounded BATCH_SIZE = 200, NO getAll()!)
      const stagingBatch = await fetchStoreBatch(stagingDb, storeName, lastKey, BATCH_SIZE);
      if (stagingBatch.length === 0) break;
      lastKey = stagingBatch[stagingBatch.length - 1]!.key;

      // 2. Query corresponding live records using individual IDB get requests in a single transaction
      await new Promise<void>((resolve, reject) => {
        let liveTx: IDBTransaction;
        try {
          liveTx = liveDb.transaction(storeName, 'readonly');
        } catch (err) {
          return reject(err);
        }
        const liveStore = liveTx.objectStore(storeName);
        let completed = 0;
        let hasError = false;

        const checkFinish = () => {
          completed++;
          if (completed === stagingBatch.length && !hasError) {
            resolve();
          }
        };

        for (const item of stagingBatch) {
          const incoming = item.value;
          const getReq = liveStore.get(incoming.id);
          getReq.onerror = () => {
            if (!hasError) {
              hasError = true;
              reject(getReq.error);
            }
          };
          getReq.onsuccess = () => {
            const local = getReq.result;

            // Check semantic identity collision if remoteId exists
            if (storeName === 'conversations' && incoming.remoteId && liveStore.indexNames.contains('remoteId')) {
              const remoteReq = liveStore.index('remoteId').get(incoming.remoteId);
              remoteReq.onsuccess = () => {
                const matchedRemote = remoteReq.result;
                if (matchedRemote && matchedRemote.id !== incoming.id) {
                  conflicts.push({
                    code: 'semantic_identity_collision',
                    store: storeName,
                    id: incoming.id,
                    message: `Conversation remoteId "${incoming.remoteId}" already exists locally under ID "${matchedRemote.id}". Incoming ID "${incoming.id}" conflicts with local identity.`,
                  });
                }
                evaluatePrimaryMatch(local, incoming);
                checkFinish();
              };
              remoteReq.onerror = () => {
                evaluatePrimaryMatch(local, incoming);
                checkFinish();
              };
              return;
            }

            if (storeName === 'messages' && incoming.remoteId && liveStore.indexNames.contains('conversationId_remoteId')) {
              const remoteReq = liveStore.index('conversationId_remoteId').get([incoming.conversationId, incoming.remoteId]);
              remoteReq.onsuccess = () => {
                const matchedRemote = remoteReq.result;
                if (matchedRemote && matchedRemote.id !== incoming.id) {
                  conflicts.push({
                    code: 'semantic_identity_collision',
                    store: storeName,
                    id: incoming.id,
                    message: `Message remoteId "${incoming.remoteId}" in conversation "${incoming.conversationId}" already exists locally under ID "${matchedRemote.id}". Incoming ID "${incoming.id}" conflicts with local identity.`,
                  });
                }
                evaluatePrimaryMatch(local, incoming);
                checkFinish();
              };
              remoteReq.onerror = () => {
                evaluatePrimaryMatch(local, incoming);
                checkFinish();
              };
              return;
            }

            evaluatePrimaryMatch(local, incoming);
            checkFinish();
          };
        }

        function evaluatePrimaryMatch(local: any, incoming: any) {
          if (!local) {
            (toInsertCounts as Record<IncludedBackupStoreName, number>)[storeName]++;
            const arr = (toInsert as Record<IncludedBackupStoreName, any[]>)[storeName];
            if (arr.length < 100) {
              arr.push(incoming);
            }
          } else {
            if (isRecordSemanticallyIdentical(storeName, local, incoming)) {
              (toSkip as Record<IncludedBackupStoreName, number>)[storeName]++;
            } else {
              conflicts.push({
                code: 'primary_key_conflict',
                store: storeName,
                id: incoming.id,
                message: `${storeName} ID "${incoming.id}" already exists locally with differing content.`,
              });
            }
          }
        }
      });

      if (stagingBatch.length < BATCH_SIZE) break;
    }
  }

  return {
    mode: 'merge',
    valid: conflicts.length === 0,
    toInsert,
    toInsertCounts,
    toSkip,
    conflicts,
  };
}

/**
 * Copies all records from one database to another store-by-store in cursor batches.
 */
async function copyStoreRecords(
  srcDb: IDBDatabase,
  destDb: IDBDatabase,
  storeName: string,
  useDurable = false
): Promise<number> {
  let count = 0;
  let lastKey: IDBValidKey | null = null;

  while (true) {
    const batch = await fetchStoreBatch(srcDb, storeName, lastKey, BATCH_SIZE);
    if (batch.length === 0) break;
    lastKey = batch[batch.length - 1]!.key;

    await new Promise<void>((resolve, reject) => {
      let tx: IDBTransaction;
      try {
        tx = useDurable
          ? createDurableWriteTransaction(destDb, storeName, 'strict')
          : destDb.transaction(storeName, 'readwrite');
      } catch (err) {
        return reject(err);
      }
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();

      const store = tx.objectStore(storeName);
      for (const item of batch) {
        store.put(item.value);
        count++;
      }
    });

    if (batch.length < BATCH_SIZE) break;
  }

  return count;
}

/**
 * Verifies deep equality between two databases across given stores.
 * - Fails if any mandatory store in `stores` is missing in either database.
 * - Passes if both stores exist and are empty (count 0).
 * - Verifies key existence and deep record equality via batch key lookups, independent of cursor iteration order.
 */
export async function verifyDatabaseEquality(
  dbA: IDBDatabase,
  dbB: IDBDatabase,
  stores: readonly string[]
): Promise<boolean> {
  for (const storeName of stores) {
    const hasA = dbA.objectStoreNames.contains(storeName);
    const hasB = dbB.objectStoreNames.contains(storeName);

    if (!hasA || !hasB) {
      console.error(
        `[verifyDatabaseEquality] Mandatory object store "${storeName}" missing in database comparison: dbA=${hasA}, dbB=${hasB}`
      );
      return false;
    }

    // 1. Check count equality
    const countA = await getStoreRecordCount(dbA, storeName);
    const countB = await getStoreRecordCount(dbB, storeName);

    if (countA !== countB) {
      console.error(`[verifyDatabaseEquality] Count mismatch in store "${storeName}": dbA=${countA}, dbB=${countB}`);
      return false;
    }

    // Both exist and both are empty: identical empty store
    if (countA === 0) {
      continue;
    }

    // 2. Fetch records from dbA in batches and verify existence & deep equality in dbB by primary key
    let startKey: IDBValidKey | null = null;
    while (true) {
      const batchA = await fetchStoreBatch(dbA, storeName, startKey, BATCH_SIZE);
      if (batchA.length === 0) break;

      const keysA = batchA.map((item) => item.key);
      const bMap = await batchGetKeys(dbB, storeName, keysA);

      for (const itemA of batchA) {
        const itemBValue = bMap.get(itemA.key);
        if (itemBValue === undefined || itemBValue === null) {
          console.error(`[verifyDatabaseEquality] Key "${String(itemA.key)}" in "${storeName}" exists in dbA but missing in dbB.`);
          return false;
        }
        if (!deepEqualRecords(storeName, itemA.value, itemBValue)) {
          console.error(`[verifyDatabaseEquality] Content mismatch in "${storeName}" for key "${String(itemA.key)}".`);
          return false;
        }
      }

      startKey = batchA[batchA.length - 1]!.key;
      if (batchA.length < BATCH_SIZE) break;
    }
  }
  return true;
}

/**
 * Verifies that liveDb is the exact semantic union of pre-merge snapshotDb and stagingDb:
 * 1. Every record in snapshotDb is intact and semantically identical in liveDb (no mutations or deletions of existing data).
 * 2. Every non-conflicting record in stagingDb is present in liveDb and matches imported content.
 * 3. Store record counts strictly match the union: liveCount == snapshotCount + newlyInsertedCount.
 * 4. Referential / relational integrity holds across all stores (no orphan messages, revisions, or recovery events).
 */
export async function verifyMergeDatabaseIntegrity(
  snapshotDb: IDBDatabase,
  stagingDb: IDBDatabase,
  liveDb: IDBDatabase,
  expectedInsertedCounts?: PortableBackupStoreCounts
): Promise<{ valid: boolean; error?: string }> {
  for (const store of SIX_DURABLE_STORES) {
    if (!liveDb.objectStoreNames.contains(store)) {
      return { valid: false, error: `Store "${store}" is missing in live database post-merge.` };
    }
    if (!snapshotDb.objectStoreNames.contains(store)) {
      return { valid: false, error: `Store "${store}" is missing in pre-merge snapshot.` };
    }
    if (!stagingDb.objectStoreNames.contains(store)) {
      return { valid: false, error: `Store "${store}" is missing in staging database.` };
    }

    const snapCount = await getStoreRecordCount(snapshotDb, store);
    const liveCount = await getStoreRecordCount(liveDb, store);

    if (expectedInsertedCounts) {
      const expInsert = (expectedInsertedCounts as any)[store] ?? 0;
      if (liveCount !== snapCount + expInsert) {
        return {
          valid: false,
          error: `Store "${store}" count mismatch: live (${liveCount}) !== snapshot (${snapCount}) + expected inserts (${expInsert})`,
        };
      }
    } else {
      if (liveCount < snapCount) {
        return {
          valid: false,
          error: `Store "${store}" count decreased after merge: live (${liveCount}) < snapshot (${snapCount})`,
        };
      }
    }

    // 1. Every record in snapshotDb must exist in liveDb and be semantically identical
    let snapKey: IDBValidKey | null = null;
    while (true) {
      const snapBatch = await fetchStoreBatch(snapshotDb, store, snapKey, BATCH_SIZE);
      if (snapBatch.length === 0) break;
      snapKey = snapBatch[snapBatch.length - 1]!.key;

      const snapKeys = snapBatch.map((item) => item.key);
      const liveResults = await batchGetKeys(liveDb, store, snapKeys);

      for (const item of snapBatch) {
        const liveRecord = liveResults.get(item.key);
        if (!liveRecord) {
          return {
            valid: false,
            error: `Pre-existing record "${String(item.key)}" in store "${store}" was deleted during merge.`,
          };
        }

        if (!deepEqualRecords(store, liveRecord, item.value)) {
          return {
            valid: false,
            error: `Pre-existing record "${String(item.key)}" in store "${store}" was mutated during merge.`,
          };
        }
      }

      if (snapBatch.length < BATCH_SIZE) break;
    }

    // 2. Every non-conflicting record in stagingDb must exist in liveDb
    let stagingKey: IDBValidKey | null = null;
    while (true) {
      const stagingBatch = await fetchStoreBatch(stagingDb, store, stagingKey, BATCH_SIZE);
      if (stagingBatch.length === 0) break;
      stagingKey = stagingBatch[stagingBatch.length - 1]!.key;

      const stagingKeys = stagingBatch.map((item) => item.key);
      const [liveMap, snapMap] = await Promise.all([
        batchGetKeys(liveDb, store, stagingKeys),
        batchGetKeys(snapshotDb, store, stagingKeys),
      ]);

      for (const item of stagingBatch) {
        const liveRecord = liveMap.get(item.key);
        if (!liveRecord) {
          return {
            valid: false,
            error: `Imported record "${String(item.key)}" in store "${store}" is missing from live database.`,
          };
        }

        const inSnap = snapMap.get(item.key);
        if (!inSnap) {
          // Newly inserted record must exactly match staging record!
          if (!deepEqualRecords(store, liveRecord, item.value)) {
            return {
              valid: false,
              error: `Imported record "${String(item.key)}" in store "${store}" does not match staging content in live database.`,
            };
          }
        } else {
          // Existing record: in a valid conservative merge, overlapping keys between snapshot and staging
          // MUST be identical. If staging has conflicting content for the same ID, it is a conflict!
          if (!deepEqualRecords(store, inSnap, item.value)) {
            return {
              valid: false,
              error: `Conflicting record "${String(item.key)}" in store "${store}": staging content differs from pre-merge snapshot.`,
            };
          }
        }
      }

      if (stagingBatch.length < BATCH_SIZE) break;
    }
  }

  // 3. Relational integrity check on liveDb post-merge
  const relResult = await validateStagingReferentialIntegrity(liveDb);
  if (!relResult.valid) {
    return {
      valid: false,
      error: `Relational integrity violated in live database post-merge: ${relResult.errors.map((e) => e.message).join('; ')}`,
    };
  }

  return { valid: true };
}

/**
 * Computes a deterministic SHA-256 fingerprint for all records within an object store.
 * Traverses primary key batches in bounded memory (< 1 MiB RAM).
 */
export async function computeStoreContentChecksum(
  db: IDBDatabase,
  storeName: string
): Promise<string> {
  let lastKey: IDBValidKey | null = null;
  const batchHashes: string[] = [];
  while (true) {
    const batch = await fetchStoreBatch(db, storeName, lastKey, BATCH_SIZE);
    if (batch.length === 0) break;
    lastKey = batch[batch.length - 1]!.key;

    let batchContent = '';
    for (const item of batch) {
      batchContent += `${JSON.stringify(item.key)}|${canonicalStringify(item.value)}\n`;
    }
    const bHash = await computeSha256(batchContent);
    batchHashes.push(bHash);

    if (batch.length < BATCH_SIZE) break;
  }
  if (batchHashes.length === 0) return 'empty';
  return await computeSha256(batchHashes.join(':'));
}

/**
 * Computes store-level deterministic checksums across durable stores.
 */
export async function computeDatabaseStoreChecksums(
  db: IDBDatabase,
  stores: readonly string[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const store of stores) {
    if (db.objectStoreNames.contains(store)) {
      result[store] = await computeStoreContentChecksum(db, store);
    }
  }
  return result;
}

/**
 * Executes safe Replace restoration from stagingDb to liveDb with pre-restore snapshot rollback guard.
 */
export async function commitStagingReplaceToLive(
  liveDb: IDBDatabase,
  stagingDb: IDBDatabase,
  expectedCounts: PortableBackupStoreCounts,
  idbFactory?: IDBFactory,
  customSnapshotDbName?: string
): Promise<RestoreResult> {
  if (activeRestoreLock) {
    throw new Error('Another restore operation is already in progress.');
  }
  activeRestoreLock = true;

  try {
    return await withExclusiveRestoreLock('replace', async (): Promise<RestoreResult> => {
      const startTime = Date.now();
      const operationId = `replace-${startTime}-${Math.random().toString(36).slice(2, 7)}`;
      const stagingDbName = stagingDb.name || RESTORE_STAGING_DB_NAME;
      const snapshotDbName = customSnapshotDbName || RESTORE_SNAPSHOT_DB_NAME;
      const shouldCleanupStaging = stagingDbName.startsWith(RESTORE_STAGING_DB_NAME);
      let snapshotDb: IDBDatabase | null = null;
      let snapshotCreated = false;
      let commitConfirmed = false;

      // Calculate initial store counts of liveDb for snapshot verification
      const snapshotCounts: Record<string, number> = {};
      for (const store of EIGHT_SNAPSHOT_STORES) {
        if (liveDb.objectStoreNames.contains(store)) {
          snapshotCounts[store] = await getStoreRecordCount(liveDb, store);
        }
      }

      try {
        // Step 1: Create rollback snapshot covering all 8 persistent stores
        await setRestoreJournalMarker({
          type: 'replace',
          stage: 'preparing_snapshot',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
          expectedCounts,
          snapshotCounts,
        }, idbFactory);

        await deleteExtensionDatabase(idbFactory, snapshotDbName);
        snapshotDb = await openExtensionDatabase(idbFactory, snapshotDbName);

        const snapshotStores = EIGHT_SNAPSHOT_STORES.filter((s) => liveDb.objectStoreNames.contains(s));
        for (const store of snapshotStores) {
          await copyStoreRecords(liveDb, snapshotDb, store, false);
        }

        await triggerInterruptionPoint('after_snapshot_created');

        // Deep-verify snapshot before clearing live database
        const snapVerified = await verifyDatabaseEquality(liveDb, snapshotDb, snapshotStores);
        if (!snapVerified) {
          throw new Error('Pre-restore snapshot verification failed. Aborting to protect existing archive.');
        }
        snapshotCreated = true;

        // Persist crash recovery marker
        await setRestoreJournalMarker({
          type: 'replace',
          stage: 'snapshot_verified',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
          expectedCounts,
          snapshotCounts,
        }, idbFactory);

        await triggerInterruptionPoint('after_journal_persisted');

        // Transition to commit_started
        await setRestoreJournalMarker({
          type: 'replace',
          stage: 'commit_started',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
          expectedCounts,
          snapshotCounts,
        }, idbFactory);

        // Verification of authoritative journal write before touching liveDb
        const verifiedJournalMarker = await getRestoreJournalMarker(idbFactory);
        if (!verifiedJournalMarker || verifiedJournalMarker.stage !== 'commit_started' || verifiedJournalMarker.operationId !== operationId) {
          throw new Error('Authoritative journal marker verification failed before commit. Aborting replace to protect live database.');
        }

        // Step 2: Clear live database
        try {
          const storesToClear = (ALL_NINE_STORES as unknown as string[]).filter((s) => liveDb.objectStoreNames.contains(s));
          if (storesToClear.length > 0) {
            await new Promise<void>((resolve, reject) => {
              let tx: IDBTransaction;
              try {
                tx = createDurableWriteTransaction(liveDb, storesToClear, 'strict');
              } catch (err) {
                return reject(err);
              }
              tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
              tx.onerror = () => reject(tx.error || new Error('Transaction error'));
              tx.oncomplete = () => resolve();

              for (const storeName of storesToClear) {
                tx.objectStore(storeName).clear();
              }
            });
          }
        } catch (clearErr) {
          throw new Error(`Failed to clear live database for replace: ${(clearErr as Error).message}`);
        }

        await triggerInterruptionPoint('after_live_db_cleared');

        // Step 3: Copy from stagingDb to liveDb store-by-store in batches
        const insertedCounts: PortableBackupStoreCounts = {
          conversations: 0,
          messages: 0,
          revisions: 0,
          recovery_events: 0,
          raw_streams: 0,
          raw_stream_batches: 0,
        };
        const insertedCountsMap = insertedCounts as Record<IncludedBackupStoreName, number>;
        const expectedCountsMap = expectedCounts as Record<IncludedBackupStoreName, number>;

        let transferError: Error | null = null;
        let batchIndex = 0;
        for (let sIdx = 0; sIdx < SIX_DURABLE_STORES.length; sIdx++) {
          const store = SIX_DURABLE_STORES[sIdx];
          if (!store) continue;
          try {
            const c = await copyStoreRecords(stagingDb, liveDb, store, true);
            insertedCountsMap[store] = c;
            batchIndex++;
            if (batchIndex === 1) {
              await triggerInterruptionPoint('after_first_batch');
            }
            if (sIdx === Math.floor(SIX_DURABLE_STORES.length / 2)) {
              await triggerInterruptionPoint('mid_transfer');
            }
          } catch (err) {
            transferError = err as Error;
            break;
          }
        }

        await setRestoreJournalMarker({
          type: 'replace',
          stage: 'transfer_completed',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
          expectedCounts,
          snapshotCounts,
        }, idbFactory);

        await triggerInterruptionPoint('after_full_transfer');

        // Step 4: Verify post-commit store counts and deep equality
        await setRestoreJournalMarker({
          type: 'replace',
          stage: 'verifying',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
          expectedCounts,
          snapshotCounts,
        }, idbFactory);

        let verified = transferError === null;
        if (verified) {
          for (const store of SIX_DURABLE_STORES) {
            if (insertedCountsMap[store] !== expectedCountsMap[store]) {
              verified = false;
              transferError = new Error(
                `Store count mismatch in "${store}": expected ${expectedCountsMap[store]}, got ${insertedCountsMap[store]}`
              );
              break;
            }
          }
        }

        if (verified) {
          const deepMatch = await verifyDatabaseEquality(stagingDb, liveDb, SIX_DURABLE_STORES);
          if (!deepMatch) {
            verified = false;
            transferError = new Error('Post-replace deep content verification mismatch between staging and live databases.');
          }
        }

        if (!verified) {
          // ROLLBACK GUARD: Restore liveDb from snapshotDb!
          console.error(`[Staging Replace] Transfer failed or verification failed (${transferError?.message}). Executing rollback snapshot...`);
          let rollbackSucceeded = false;
          try {
            await setRestoreJournalMarker({
              type: 'replace',
              stage: 'rollback_in_progress',
              liveDbName: liveDb.name,
              snapshotDbName,
              stagingDbName,
              timestamp: Date.now(),
              operationId,
              expectedCounts,
              snapshotCounts,
            }, idbFactory);

            await new Promise<void>((resolve, reject) => {
              const tx = liveDb.transaction(ALL_NINE_STORES as unknown as string[], 'readwrite');
              for (const storeName of ALL_NINE_STORES) {
                if (liveDb.objectStoreNames.contains(storeName)) {
                  tx.objectStore(storeName).clear();
                }
              }
              tx.oncomplete = () => resolve();
              tx.onabort = () => reject(tx.error || new Error('Rollback clear transaction aborted'));
              tx.onerror = () => reject(tx.error || new Error('Rollback clear transaction error'));
            });

            for (const store of EIGHT_SNAPSHOT_STORES) {
              if (liveDb.objectStoreNames.contains(store) && snapshotDb.objectStoreNames.contains(store)) {
                await copyStoreRecords(snapshotDb, liveDb, store, false);
              }
            }

            rollbackSucceeded = await verifyDatabaseEquality(snapshotDb, liveDb, snapshotStores);
          } catch (rollbackErr) {
            console.error('[Staging Replace] Rollback snapshot encountered error:', rollbackErr);
            rollbackSucceeded = false;
          }

          if (rollbackSucceeded) {
            await setRestoreJournalMarker(null, idbFactory);
            closeExtensionDatabase(idbFactory, snapshotDbName);
            await deleteExtensionDatabase(idbFactory, snapshotDbName);
            if (shouldCleanupStaging) {
              closeExtensionDatabase(idbFactory, stagingDbName);
              await deleteExtensionDatabase(idbFactory, stagingDbName);
            }

            return {
              success: false,
              mode: 'replace',
              insertedCounts,
              skippedCounts: {
                conversations: 0,
                messages: 0,
                revisions: 0,
                recovery_events: 0,
                raw_streams: 0,
                raw_stream_batches: 0,
              },
              verified: false,
              durationMs: Date.now() - startTime,
              error: `Restore aborted and rolled back: ${transferError?.message || 'Verification failed'}`,
            };
          } else {
            console.error('[Staging Replace] Rollback failed! Snapshot preserved for emergency recovery.');
            return {
              success: false,
              mode: 'replace',
              insertedCounts,
              skippedCounts: {
                conversations: 0,
                messages: 0,
                revisions: 0,
                recovery_events: 0,
                raw_streams: 0,
                raw_stream_batches: 0,
              },
              verified: false,
              durationMs: Date.now() - startTime,
              error: `Rollback verification failed! Your original database is preserved in snapshot "${snapshotDbName}".`,
            };
          }
        }

        // Step 5: Success! Mark commit confirmed before entering cleanup
        commitConfirmed = true;

        let liveStoreChecksums: Record<string, string> | undefined;
        const liveStoreCounts: Record<string, number> = {};
        try {
          liveStoreChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
          for (const store of SIX_DURABLE_STORES) {
            liveStoreCounts[store] = await getStoreRecordCount(liveDb, store);
          }

          await setRestoreJournalMarker({
            type: 'replace',
            stage: 'commit_verified',
            liveDbName: liveDb.name,
            snapshotDbName,
            stagingDbName,
            timestamp: Date.now(),
            operationId,
            expectedCounts,
            snapshotCounts,
            liveStoreChecksums,
            liveStoreCounts,
          }, idbFactory);

          await setRestoreJournalMarker({
            type: 'replace',
            stage: 'cleanup_pending',
            liveDbName: liveDb.name,
            snapshotDbName,
            stagingDbName,
            timestamp: Date.now(),
            operationId,
            expectedCounts,
            snapshotCounts,
            liveStoreChecksums,
            liveStoreCounts,
          }, idbFactory);
        } catch (markerErr) {
          console.warn('[Staging Replace] Failed to record commit_verified or cleanup_pending marker:', markerErr);
        }

        // Step 6: Post-commit cleanup phase (isolated from rollback)
        const cleanupResult = await performPostCommitCleanup({
          idbFactory,
          snapshotDbName,
          stagingDbName,
          shouldCleanupStaging,
        });

        let cleanupStatus: RestoreCleanupStatus = 'completed';
        let cleanupWarning: string | undefined;
        let journalError: string | undefined;

        if (!cleanupResult.journalDeleted) {
          cleanupStatus = 'journal_unresolved';
          journalError = cleanupResult.errors[0]?.message || 'Failed to remove restore journal marker';
          cleanupWarning = `Restore succeeded and verified, but finalizing the restore journal failed (${journalError}). Safety snapshot preserved. Normal writes are temporarily blocked until cleanup completes.`;
        } else if (cleanupResult.errors.length > 0) {
          cleanupStatus = 'temporary_leftover';
          cleanupWarning = `Restore succeeded and verified, but cleanup of temporary databases encountered: ${cleanupResult.errors.map(e => e.message).join('; ')}. They will be swept automatically.`;
        }

        return {
          success: true,
          mode: 'replace',
          insertedCounts,
          skippedCounts: {
            conversations: 0,
            messages: 0,
            revisions: 0,
            recovery_events: 0,
            raw_streams: 0,
            raw_stream_batches: 0,
          },
          verified: true,
          durationMs: Date.now() - startTime,
          cleanupStatus,
          cleanupWarning,
          journalError,
        };
      } catch (err) {
        if (!commitConfirmed && snapshotCreated && snapshotDb) {
          console.error('[Staging Replace] Restore aborted before commit confirmation, executing emergency rollback:', err);
          try {
            await new Promise<void>((resolve, reject) => {
              const tx = liveDb.transaction(ALL_NINE_STORES as unknown as string[], 'readwrite');
              for (const s of ALL_NINE_STORES) {
                if (liveDb.objectStoreNames.contains(s)) {
                  tx.objectStore(s).clear();
                }
              }
              tx.oncomplete = () => resolve();
              tx.onabort = () => reject(tx.error || new Error('Emergency rollback clear aborted'));
              tx.onerror = () => reject(tx.error || new Error('Emergency rollback clear error'));
            });

            const snapshotStores = EIGHT_SNAPSHOT_STORES.filter((store) => liveDb.objectStoreNames.contains(store));
            for (const store of snapshotStores) {
              if (snapshotDb.objectStoreNames.contains(store)) {
                await copyStoreRecords(snapshotDb, liveDb, store, false);
              }
            }

            const rollbackVerified = await verifyDatabaseEquality(snapshotDb, liveDb, snapshotStores);
            if (rollbackVerified) {
              await setRestoreJournalMarker(null, idbFactory);
              closeExtensionDatabase(idbFactory, snapshotDbName);
              await deleteExtensionDatabase(idbFactory, snapshotDbName);
              if (shouldCleanupStaging) {
                closeExtensionDatabase(idbFactory, stagingDbName);
                await deleteExtensionDatabase(idbFactory, stagingDbName);
              }
            }
          } catch (rErr) {
            console.error('[Staging Replace] Error in emergency rollback:', rErr);
          }
        } else if (commitConfirmed) {
          console.warn('[Staging Replace] Error occurred after commit was confirmed and verified. Live database is intact. Refusing destructive rollback:', err);
        }
        throw err;
      }
    });
  } finally {
    activeRestoreLock = false;
  }
}

/**
 * Executes Merge restoration from plan records into liveDb using durable write transactions.
 * Includes pre-merge snapshot guard, modification collision detection, and automatic rollback if midway failure occurs.
 */
export async function commitStagingMergeToLive(
  liveDb: IDBDatabase,
  plan: RestorePlan,
  idbFactory?: IDBFactory,
  customStagingDb?: IDBDatabase,
  customSnapshotDbName?: string
): Promise<RestoreResult> {
  if (activeRestoreLock) {
    throw new Error('Another restore operation is already in progress.');
  }
  activeRestoreLock = true;

  try {
    return await withExclusiveRestoreLock('merge', async (): Promise<RestoreResult> => {
      const startTime = Date.now();
      const operationId = `merge-${startTime}-${Math.random().toString(36).slice(2, 7)}`;
      const stagingDb = customStagingDb || (await openExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME));
      const stagingDbName = stagingDb.name || RESTORE_STAGING_DB_NAME;
      const snapshotDbName = customSnapshotDbName || RESTORE_SNAPSHOT_DB_NAME;
      const shouldCleanupStaging = stagingDbName.startsWith(RESTORE_STAGING_DB_NAME);
      let snapshotDb: IDBDatabase | null = null;
      let snapshotCreated = false;
      let commitConfirmed = false;

      try {
        if (!plan.valid || plan.conflicts.length > 0) {
          throw new Error(`Merge conflict detected: ${plan.conflicts.map((c) => c.message).join('; ')}`);
        }

        // Step 1: Re-check conflicts immediately before applying to account for concurrent live changes
        const recheckPlan = await buildRestorePlanFromStaging(liveDb, stagingDb, 'merge', plan.toInsertCounts || {
          conversations: 0,
          messages: 0,
          revisions: 0,
          recovery_events: 0,
          raw_streams: 0,
          raw_stream_batches: 0,
        });
        if (!recheckPlan.valid || recheckPlan.conflicts.length > 0) {
          throw new Error(
            `Merge aborted: database was modified concurrently since preflight. Conflicts: ${recheckPlan.conflicts.map((c) => c.message).join('; ')}`
          );
        }

        // Step 2: Create pre-merge rollback snapshot of all 8 persistent stores
        await setRestoreJournalMarker({
          type: 'merge',
          stage: 'preparing_snapshot',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
        }, idbFactory);

        await deleteExtensionDatabase(idbFactory, snapshotDbName);
        snapshotDb = await openExtensionDatabase(idbFactory, snapshotDbName);
        const snapshotStores = EIGHT_SNAPSHOT_STORES.filter((store) => liveDb.objectStoreNames.contains(store));
        for (const store of snapshotStores) {
          await copyStoreRecords(liveDb, snapshotDb, store, false);
        }

        await triggerInterruptionPoint('after_snapshot_created');

        const snapVerified = await verifyDatabaseEquality(liveDb, snapshotDb, snapshotStores);
        if (!snapVerified) {
          throw new Error('Pre-merge rollback snapshot verification failed.');
        }
        snapshotCreated = true;

        // Persist crash-recovery marker
        await setRestoreJournalMarker({
          type: 'merge',
          stage: 'snapshot_verified',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
        }, idbFactory);

        await triggerInterruptionPoint('after_journal_persisted');

        await setRestoreJournalMarker({
          type: 'merge',
          stage: 'commit_started',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
        }, idbFactory);

        // Verification of authoritative journal write before touching liveDb
        const verifiedMergeMarker = await getRestoreJournalMarker(idbFactory);
        if (!verifiedMergeMarker || verifiedMergeMarker.stage !== 'commit_started' || verifiedMergeMarker.operationId !== operationId) {
          throw new Error('Authoritative journal marker verification failed before merge commit. Aborting merge to protect live database.');
        }

        // Step 3: Stream non-conflicting records from stagingDb into liveDb in batches
        const insertedCounts: PortableBackupStoreCounts = {
          conversations: 0,
          messages: 0,
          revisions: 0,
          recovery_events: 0,
          raw_streams: 0,
          raw_stream_batches: 0,
        };
        const insertedCountsMap = insertedCounts as Record<IncludedBackupStoreName, number>;

        let batchCount = 0;
        for (let sIdx = 0; sIdx < SIX_DURABLE_STORES.length; sIdx++) {
          const store = SIX_DURABLE_STORES[sIdx];
          if (!store) continue;
          let lastKey: IDBValidKey | null = null;
          while (true) {
            const batch = await fetchStoreBatch(stagingDb, store, lastKey, BATCH_SIZE);
            if (batch.length === 0) break;
            lastKey = batch[batch.length - 1]!.key;

            await new Promise<void>((resolve, reject) => {
              let tx: IDBTransaction;
              try {
                tx = createDurableWriteTransaction(liveDb, store, 'strict');
              } catch (err) {
                return reject(err);
              }
              let hasConflict = false;
              tx.onabort = () => {
                if (hasConflict) {
                  reject(new Error(`Merge conflict detected: Concurrent modification on store "${store}".`));
                } else {
                  reject(tx.error || new Error('Transaction aborted'));
                }
              };
              tx.onerror = () => reject(tx.error || new Error('Transaction error'));
              tx.oncomplete = () => resolve();

              const liveStore = tx.objectStore(store);
              for (const item of batch) {
                const incoming = item.value;
                const getReq = liveStore.get(incoming.id);
                getReq.onsuccess = () => {
                  const existing = getReq.result;
                  if (!existing) {
                    liveStore.put(incoming);
                    insertedCountsMap[store]++;
                  } else {
                    // Key exists: check whether existing is identical or conflicting
                    if (!deepEqualRecords(store, existing, incoming)) {
                      hasConflict = true;
                      tx.abort();
                    }
                  }
                };
              }
            });

            batchCount++;
            if (batchCount === 1) {
              await triggerInterruptionPoint('after_first_batch');
            }
            if (sIdx === Math.floor(SIX_DURABLE_STORES.length / 2)) {
              await triggerInterruptionPoint('mid_transfer');
            }

            if (batch.length < BATCH_SIZE) break;
          }
        }

        await setRestoreJournalMarker({
          type: 'merge',
          stage: 'transfer_completed',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
          expectedCounts: insertedCounts,
        }, idbFactory);

        await triggerInterruptionPoint('after_full_transfer');

        await setRestoreJournalMarker({
          type: 'merge',
          stage: 'verifying',
          liveDbName: liveDb.name,
          snapshotDbName,
          stagingDbName,
          timestamp: Date.now(),
          operationId,
          expectedCounts: insertedCounts,
        }, idbFactory);

        // Step 4: Strict semantic verification of Merge result:
        // LiveDB must be the exact correct union of pre-merge snapshotDb and stagingDb
        const mergeCheck = await verifyMergeDatabaseIntegrity(snapshotDb, stagingDb, liveDb, insertedCounts);
        if (!mergeCheck.valid) {
          throw new Error(`Merge verification failed: ${mergeCheck.error || 'Live database is not the correct union of snapshot and staging.'}`);
        }

        // Step 5: Success! Mark commit confirmed before entering cleanup
        commitConfirmed = true;

        let liveStoreChecksums: Record<string, string> | undefined;
        const liveStoreCounts: Record<string, number> = {};
        try {
          liveStoreChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
          for (const store of SIX_DURABLE_STORES) {
            liveStoreCounts[store] = await getStoreRecordCount(liveDb, store);
          }

          await setRestoreJournalMarker({
            type: 'merge',
            stage: 'commit_verified',
            liveDbName: liveDb.name,
            snapshotDbName,
            stagingDbName,
            timestamp: Date.now(),
            operationId,
            expectedCounts: insertedCounts,
            liveStoreChecksums,
            liveStoreCounts,
          }, idbFactory);

          await setRestoreJournalMarker({
            type: 'merge',
            stage: 'cleanup_pending',
            liveDbName: liveDb.name,
            snapshotDbName,
            stagingDbName,
            timestamp: Date.now(),
            operationId,
            expectedCounts: insertedCounts,
            liveStoreChecksums,
            liveStoreCounts,
          }, idbFactory);
        } catch (markerErr) {
          console.warn('[Staging Merge] Failed to record commit_verified or cleanup_pending marker:', markerErr);
        }

        // Step 6: Post-commit cleanup phase (isolated from rollback)
        const cleanupResult = await performPostCommitCleanup({
          idbFactory,
          snapshotDbName,
          stagingDbName,
          shouldCleanupStaging,
        });

        let cleanupStatus: RestoreCleanupStatus = 'completed';
        let cleanupWarning: string | undefined;
        let journalError: string | undefined;

        if (!cleanupResult.journalDeleted) {
          cleanupStatus = 'journal_unresolved';
          journalError = cleanupResult.errors[0]?.message || 'Failed to remove restore journal marker';
          cleanupWarning = `Restore succeeded and verified, but finalizing the restore journal failed (${journalError}). Safety snapshot preserved. Normal writes are temporarily blocked until cleanup completes.`;
        } else if (cleanupResult.errors.length > 0) {
          cleanupStatus = 'temporary_leftover';
          cleanupWarning = `Merge succeeded and verified, but cleanup of temporary databases encountered: ${cleanupResult.errors.map(e => e.message).join('; ')}. They will be swept automatically.`;
        }

        return {
          success: true,
          mode: 'merge',
          insertedCounts,
          skippedCounts: { ...plan.toSkip },
          verified: true,
          durationMs: Date.now() - startTime,
          cleanupStatus,
          cleanupWarning,
          journalError,
        };
      } catch (err) {
        if (!commitConfirmed && snapshotCreated && snapshotDb) {
          console.error('[Staging Merge] Merge encountered error before commit confirmation, executing rollback guard:', err);
          try {
            await new Promise<void>((resolve, reject) => {
              const tx = liveDb.transaction(ALL_NINE_STORES as unknown as string[], 'readwrite');
              for (const s of ALL_NINE_STORES) {
                if (liveDb.objectStoreNames.contains(s)) {
                  tx.objectStore(s).clear();
                }
              }
              tx.oncomplete = () => resolve();
              tx.onabort = () => reject(tx.error || new Error('Merge rollback clear aborted'));
              tx.onerror = () => reject(tx.error || new Error('Merge rollback clear error'));
            });

            const snapshotStores = EIGHT_SNAPSHOT_STORES.filter((store) => liveDb.objectStoreNames.contains(store));
            for (const store of snapshotStores) {
              if (snapshotDb.objectStoreNames.contains(store)) {
                await copyStoreRecords(snapshotDb, liveDb, store, false);
              }
            }

            const rollbackVerified = await verifyDatabaseEquality(snapshotDb, liveDb, snapshotStores);
            if (rollbackVerified) {
              await setRestoreJournalMarker(null, idbFactory);
              closeExtensionDatabase(idbFactory, snapshotDbName);
              await deleteExtensionDatabase(idbFactory, snapshotDbName);
              if (shouldCleanupStaging) {
                closeExtensionDatabase(idbFactory, stagingDbName);
                await deleteExtensionDatabase(idbFactory, stagingDbName);
              }
              console.info('[Staging Merge] Rollback to pre-merge state succeeded completely.');
            } else {
              console.error('[Staging Merge] Rollback verification failed! Snapshot preserved.');
            }
          } catch (rollbackErr) {
            console.error('[Staging Merge] Catastrophic error during merge rollback:', rollbackErr);
          }
        } else if (commitConfirmed) {
          console.warn('[Staging Merge] Error occurred after merge commit was confirmed and verified. Live database is intact. Refusing destructive rollback:', err);
        }
        throw err;
      }
    });
  } finally {
    activeRestoreLock = false;
  }
}

