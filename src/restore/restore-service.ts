/**
 * Restore Service Orchestrator.
 *
 * Coordinates preflight validation, referential integrity verification,
 * transaction execution (Replace / Merge), and post-commit read-back verification.
 */

import type { MaterializedPortableBackup } from '../backup/reader';
import { readPortableBackup } from '../backup/reader';
import { validateBackupReferentialIntegrity, type BackupRelationalGraph } from './integrity';
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
import { recordStorageMutation } from '../storage/mutation-tracker';

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
 * Uses bounded inspectionOnly mode to prevent materializing large multi-megabyte archives in memory.
 */
export async function validateAndPreflightRestore(
  db: IDBDatabase,
  input: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
  activeStreamsCount: number,
  mode: RestoreMode = 'replace',
  options?: { inspectionOnly?: boolean }
): Promise<{ preflight: RestorePreflight; backup?: MaterializedPortableBackup }> {
  const currentCounts = await getCurrentStoreCounts(db);
  const inspectionOnly = options?.inspectionOnly ?? true;

  let preflightInput = input;
  let executionInput = input;
  if (input instanceof ReadableStream) {
    const [s1, s2] = input.tee();
    preflightInput = s1;
    executionInput = s2;
  }

  const relationalGraph: BackupRelationalGraph = {
    conversations: [],
    messages: [],
    revisions: [],
    recovery_events: [],
    raw_streams: [],
    raw_stream_batches: [],
  };

  // 1. Read & Validate Archive Envelope & Records with Bounded Memory
  const readResult = await readPortableBackup(preflightInput, {
    inspectionOnly,
    onRecord: (store, record) => {
      switch (store) {
        case 'conversations':
          relationalGraph.conversations.push({
            id: record.id as string,
            remoteId: record.remoteId as string | undefined,
          });
          break;
        case 'messages':
          relationalGraph.messages.push({
            id: record.id as string,
            conversationId: record.conversationId as string,
            parentId: record.parentId as string | undefined,
            projectionState: record.projectionState as string | undefined,
          });
          break;
        case 'revisions':
          relationalGraph.revisions.push({
            id: record.id as string,
            messageId: record.messageId as string,
            isLastGood: record.isLastGood as boolean | undefined,
          });
          break;
        case 'recovery_events':
          relationalGraph.recovery_events.push({
            id: record.id as string,
            messageId: record.messageId as string,
            recoveredRevisionId: record.recoveredRevisionId as string | undefined,
          });
          break;
        case 'raw_streams':
          relationalGraph.raw_streams.push({
            id: record.id as string,
          });
          break;
        case 'raw_stream_batches':
          relationalGraph.raw_stream_batches.push({
            id: record.id as string,
            streamKey: record.streamKey as string,
          });
          break;
      }
    },
  });

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

  const backup: MaterializedPortableBackup & { _lightweight?: boolean; _rawInput?: any } = inspectionOnly
    ? {
        manifest: readResult.backup.manifest,
        footer: readResult.backup.footer,
        records: {
          conversations: relationalGraph.conversations as any,
          messages: relationalGraph.messages as any,
          revisions: relationalGraph.revisions as any,
          recovery_events: relationalGraph.recovery_events as any,
          raw_streams: relationalGraph.raw_streams as any,
          raw_stream_batches: relationalGraph.raw_stream_batches as any,
        },
        _lightweight: true,
        _rawInput: executionInput,
      }
    : readResult.backup;

  // 2. Validate Referential Integrity
  const integrityResult = validateBackupReferentialIntegrity(inspectionOnly ? { records: relationalGraph } : backup);
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
    if (inspectionOnly && mode === 'replace') {
      plan = {
        mode: 'replace',
        valid: true,
        toInsert: {
          conversations: relationalGraph.conversations as any,
          messages: relationalGraph.messages as any,
          revisions: relationalGraph.revisions as any,
          recovery_events: relationalGraph.recovery_events as any,
          raw_streams: relationalGraph.raw_streams as any,
          raw_stream_batches: relationalGraph.raw_stream_batches as any,
        },
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
    } else {
      plan = await buildRestorePlan(db, backup, mode);
    }
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
 * Supports both pre-materialized backup records and streaming raw input.
 */
export async function executeRestore(
  db: IDBDatabase,
  backupOrInput: MaterializedPortableBackup | ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
  mode: RestoreMode,
  activeStreamsCount: number
): Promise<RestoreResult> {
  const startTime = Date.now();

  if (activeStreamsCount > 0) {
    throw new Error('Cannot restore archive while active generation streams are running.');
  }

  let backup: MaterializedPortableBackup;

  const isPreMaterialized =
    backupOrInput &&
    typeof backupOrInput === 'object' &&
    'manifest' in backupOrInput &&
    'footer' in backupOrInput &&
    'records' in backupOrInput &&
    !(backupOrInput as any)._lightweight &&
    Array.isArray((backupOrInput as any).records?.conversations) &&
    ((backupOrInput as any).records?.revisions?.length > 0 ||
      (backupOrInput as any).footer?.counts?.revisions === 0 ||
      ((backupOrInput as any).footer?.counts?.raw_stream_batches > 0 && (backupOrInput as any).records?.raw_stream_batches?.length > 0));

  if (isPreMaterialized) {
    backup = backupOrInput as MaterializedPortableBackup;
  } else {
    // Read and materialize records on demand for execution
    const rawToRead = (backupOrInput as any)?._lightweight
      ? (backupOrInput as any)._rawInput
      : backupOrInput;
    const readResult = await readPortableBackup(rawToRead as any, { inspectionOnly: false });
    if (!readResult.success || !readResult.backup) {
      throw new Error(`Failed to read backup archive for restore: ${readResult.errors.map((e) => e.message).join('; ')}`);
    }
    backup = readResult.backup;
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

  // Increment storage mutation sequence so observers/backups are notified
  recordStorageMutation();

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
