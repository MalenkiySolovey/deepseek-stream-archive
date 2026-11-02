/**
 * Restore Service Orchestrator.
 *
 * Coordinates preflight validation, referential integrity verification,
 * transaction execution (Replace / Merge), and post-commit read-back verification.
 */

import type { MaterializedPortableBackup } from '../backup/reader';
import { readPortableBackup } from '../backup/reader';
import { validateBackupReferentialIntegrity } from './integrity';
import { buildRestorePlan } from './plan';
import { executeAtomicReplace } from './replace';
import { executeAtomicMerge } from './merge';
import type { RestoreMode, RestorePreflight, RestoreResult, RestorePlan } from './types';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
} from '../storage/schema';
import type { PortableBackupStoreCounts } from '../backup/format';

/**
 * Reads count of records from an IndexedDB object store.
 */
function getStoreCount(tx: IDBTransaction, storeName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const store = tx.objectStore(storeName);
    const req = store.count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error(`Failed to count store ${storeName}`));
  });
}

/**
 * Queries current record counts across all 6 durable stores.
 */
export async function getCurrentStoreCounts(db: IDBDatabase): Promise<PortableBackupStoreCounts> {
  const tx = db.transaction(
    [
      STORE_CONVERSATIONS,
      STORE_MESSAGES,
      STORE_REVISIONS,
      STORE_RECOVERY_EVENTS,
      STORE_RAW_STREAMS,
      STORE_RAW_STREAM_BATCHES,
    ],
    'readonly'
  );

  const [conversations, messages, revisions, recovery_events, raw_streams, raw_stream_batches] =
    await Promise.all([
      getStoreCount(tx, STORE_CONVERSATIONS),
      getStoreCount(tx, STORE_MESSAGES),
      getStoreCount(tx, STORE_REVISIONS),
      getStoreCount(tx, STORE_RECOVERY_EVENTS),
      getStoreCount(tx, STORE_RAW_STREAMS),
      getStoreCount(tx, STORE_RAW_STREAM_BATCHES),
    ]);

  return {
    conversations,
    messages,
    revisions,
    recovery_events,
    raw_streams,
    raw_stream_batches,
  };
}

/**
 * Validates a backup archive and builds a preflight inspection result with current DB counts.
 */
export async function validateAndPreflightRestore(
  db: IDBDatabase,
  input: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
  activeStreamsCount: number,
  mode: RestoreMode = 'replace'
): Promise<{ preflight: RestorePreflight; backup?: MaterializedPortableBackup }> {
  const currentCounts = await getCurrentStoreCounts(db);

  // 1. Read & Validate Archive Envelope & Records
  const readResult = await readPortableBackup(input);
  if (!readResult.success || !readResult.backup) {
    return {
      preflight: {
        canRestore: false,
        currentCounts,
        backupCounts: {
          conversations: 0,
          messages: 0,
          revisions: 0,
          recovery_events: 0,
          raw_streams: 0,
          raw_stream_batches: 0,
        },
        manifest: {} as any,
        activeStreamsCount,
        validationErrors: readResult.errors.map((e) => ({ code: e.code, message: e.message })),
      },
    };
  }

  const backup = readResult.backup;

  // 2. Validate Referential Integrity
  const integrityResult = validateBackupReferentialIntegrity(backup);
  if (!integrityResult.valid) {
    return {
      preflight: {
        canRestore: false,
        currentCounts,
        backupCounts: backup.footer.counts,
        manifest: backup.manifest,
        activeStreamsCount,
        validationErrors: integrityResult.errors.map((e) => ({ code: e.code, message: e.message })),
      },
      backup,
    };
  }

  // 3. Build Restore Plan
  let plan: RestorePlan;
  try {
    plan = await buildRestorePlan(db, backup, mode);
  } catch (err) {
    return {
      preflight: {
        canRestore: false,
        currentCounts,
        backupCounts: backup.footer.counts,
        manifest: backup.manifest,
        activeStreamsCount,
        validationErrors: [{ code: 'plan_build_failed', message: (err as Error).message }],
      },
      backup,
    };
  }

  const canRestore = activeStreamsCount === 0 && plan.valid;
  const validationErrors: Array<{ code: string; message: string }> = plan.conflicts.map((c) => ({
    code: c.code,
    message: c.message,
  }));

  if (activeStreamsCount > 0) {
    validationErrors.unshift({
      code: 'active_generation_in_progress',
      message: 'Active DeepSeek generation streams detected. Please wait for streaming to conclude before restoring.',
    });
  }

  return {
    preflight: {
      canRestore,
      currentCounts,
      backupCounts: backup.footer.counts,
      manifest: backup.manifest,
      activeStreamsCount,
      validationErrors,
      plan,
    },
    backup,
  };
}

/**
 * Execute restore operation and perform post-commit read-back verification.
 */
export async function executeRestore(
  db: IDBDatabase,
  backup: MaterializedPortableBackup,
  mode: RestoreMode,
  activeStreamsCount: number
): Promise<RestoreResult> {
  const startTime = Date.now();

  if (activeStreamsCount > 0) {
    throw new Error('Cannot restore archive while active generation streams are running.');
  }

  // Referential Integrity Barrier
  const integrity = validateBackupReferentialIntegrity(backup);
  if (!integrity.valid) {
    throw new Error(`Referential integrity failed: ${integrity.errors.map((e) => e.message).join('; ')}`);
  }

  let insertedCounts: PortableBackupStoreCounts;
  let skippedCounts: PortableBackupStoreCounts;

  if (mode === 'replace') {
    const res = await executeAtomicReplace(db, backup);
    insertedCounts = res.insertedCounts;
    skippedCounts = {
      conversations: 0,
      messages: 0,
      revisions: 0,
      recovery_events: 0,
      raw_streams: 0,
      raw_stream_batches: 0,
    };
  } else {
    // Mode: merge
    const plan = await buildRestorePlan(db, backup, 'merge');
    if (!plan.valid || plan.conflicts.length > 0) {
      throw new Error(`Merge conflict detected: ${plan.conflicts.map((c) => c.message).join('; ')}`);
    }
    const res = await executeAtomicMerge(db, plan);
    insertedCounts = res.insertedCounts;
    skippedCounts = res.skippedCounts;
  }

  // Post-commit read-back verification
  let verified = false;
  try {
    const finalCounts = await getCurrentStoreCounts(db);
    if (mode === 'replace') {
      verified =
        finalCounts.conversations === backup.footer.counts.conversations &&
        finalCounts.messages === backup.footer.counts.messages &&
        finalCounts.revisions === backup.footer.counts.revisions &&
        finalCounts.recovery_events === backup.footer.counts.recovery_events &&
        finalCounts.raw_streams === backup.footer.counts.raw_streams &&
        finalCounts.raw_stream_batches === backup.footer.counts.raw_stream_batches;
    } else {
      // For merge, each store count should be at least inserted count
      verified =
        finalCounts.conversations >= insertedCounts.conversations &&
        finalCounts.messages >= insertedCounts.messages &&
        finalCounts.revisions >= insertedCounts.revisions &&
        finalCounts.recovery_events >= insertedCounts.recovery_events &&
        finalCounts.raw_streams >= insertedCounts.raw_streams &&
        finalCounts.raw_stream_batches >= insertedCounts.raw_stream_batches;
    }
  } catch (err) {
    verified = false;
  }

  if (!verified) {
    return {
      success: false,
      mode,
      insertedCounts,
      skippedCounts,
      verified: false,
      durationMs: Date.now() - startTime,
      error: 'restore_committed_but_verification_failed: Post-commit store counts mismatch.',
    };
  }

  return {
    success: true,
    mode,
    insertedCounts,
    skippedCounts,
    verified: true,
    durationMs: Date.now() - startTime,
  };
}
