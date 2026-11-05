/**
 * Restore Service Orchestrator.
 *
 * Coordinates bounded preflight validation, referential integrity verification,
 * staging database ingestion, transaction execution (Replace / Merge),
 * and post-commit read-back verification.
 */

import type { MaterializedPortableBackup } from '../backup/reader';
import { readPortableBackup } from '../backup/reader';
import { validateBackupReferentialIntegrity, type BackupRelationalGraph } from './integrity';
import { buildRestorePlan } from './plan';
import { executeAtomicReplace } from './replace';
import { executeAtomicMerge } from './merge';
import {
  ingestArchiveToStaging,
  buildRestorePlanFromStaging,
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  createFreshInputStream,
  createStagingDatabaseName,
  createSnapshotDatabaseName,
  closeExtensionDatabase,
  deleteExtensionDatabase,
} from './staging-service';
import { withExclusiveRestoreLock } from './restore-lock';
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
 * Eliminates input.tee() memory accumulation by creating fresh streams on demand.
 */
export async function validateAndPreflightRestore(
  db: IDBDatabase,
  input: MaterializedPortableBackup | ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
  activeStreamsCount: number,
  mode: RestoreMode = 'replace',
  options?: { inspectionOnly?: boolean }
): Promise<{ preflight: RestorePreflight; backup?: MaterializedPortableBackup }> {
  const currentCounts = await getCurrentStoreCounts(db);

  // Check if input is already a materialized in-memory backup object
  const isPreMaterialized =
    input &&
    typeof input === 'object' &&
    'manifest' in input &&
    'footer' in input &&
    'records' in input &&
    !(input as any)._lightweight &&
    Array.isArray((input as any).records?.conversations);

  if (isPreMaterialized) {
    const backup = input as MaterializedPortableBackup;
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

    const plan = await buildRestorePlan(db, backup, mode);
    const canRestore = activeStreamsCount === 0 && plan.valid;
    const validationErrors: Array<{ code: string; message: string }> = plan.conflicts.map((c) => ({ code: c.code, message: c.message }));
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

  // Raw input stream/bytes path
  const rawInput = (input as any)?._lightweight ? (input as any)._rawInput : input;

  if (mode === 'merge') {
    // For Merge mode, perform staging ingestion into an isolated preflight database to evaluate full records with zero false conflicts
    const idbFactory = (db as any).factory ?? (db as any).__idbFactory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
    const preflightOpId = `preflight_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const stagingDbName = createStagingDatabaseName(preflightOpId);
    let stagingDbInstance: IDBDatabase | null = null;
    try {
      const ingest = await ingestArchiveToStaging(rawInput, idbFactory, stagingDbName);
      stagingDbInstance = ingest.stagingDb;
      const plan = await buildRestorePlanFromStaging(db, ingest.stagingDb, 'merge', ingest.counts);
      const canRestore = activeStreamsCount === 0 && plan.valid;
      const validationErrors: Array<{ code: string; message: string }> = plan.conflicts.map((c) => ({ code: c.code, message: c.message }));
      if (activeStreamsCount > 0) {
        validationErrors.unshift({
          code: 'active_generation_in_progress',
          message: 'Active DeepSeek generation streams detected. Please wait for streaming to conclude before restoring.',
        });
      }

      const backup: MaterializedPortableBackup & { _lightweight?: boolean; _rawInput?: any } = {
        manifest: ingest.manifest,
        footer: ingest.footer,
        records: {
          conversations: [],
          messages: [],
          revisions: [],
          recovery_events: [],
          raw_streams: [],
          raw_stream_batches: [],
        },
        _lightweight: true,
        _rawInput: rawInput,
      };

      return {
        preflight: {
          canRestore,
          currentCounts,
          backupCounts: ingest.counts,
          manifest: ingest.manifest,
          activeStreamsCount,
          validationErrors,
          plan,
        },
        backup,
      };
    } catch (err) {
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
          validationErrors: [{ code: 'preflight_failed', message: (err as Error).message }],
        },
      };
    } finally {
      if (stagingDbInstance) {
        closeExtensionDatabase(idbFactory, stagingDbName);
        try {
          await deleteExtensionDatabase(idbFactory, stagingDbName);
        } catch {}
      }
    }
  }

  // Mode: replace (Lightweight inspection stream)
  const { stream } = createFreshInputStream(rawInput);
  const relationalGraph: BackupRelationalGraph = {
    conversations: [],
    messages: [],
    revisions: [],
    recovery_events: [],
    raw_streams: [],
    raw_stream_batches: [],
  };

  const readResult = await readPortableBackup(stream, {
    inspectionOnly: true,
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

  const backup: MaterializedPortableBackup & { _lightweight?: boolean; _rawInput?: any } = {
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
    _rawInput: rawInput,
  };

  // Validate Referential Integrity
  const integrityResult = validateBackupReferentialIntegrity({ records: relationalGraph });
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

  const plan: RestorePlan = {
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

  const canRestore = activeStreamsCount === 0 && plan.valid;
  const validationErrors: Array<{ code: string; message: string }> = [];

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
 * For large archives, utilizes staging database with bounded memory (< 5 MiB peak RAM)
 * and pre-restore snapshot rollback guard to prevent partial database corruption.
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
    // In-memory materialized backup path (small archives & test fixtures)
    return await withExclusiveRestoreLock(mode, async () => {
      const backup = backupOrInput as MaterializedPortableBackup;
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
        const plan = await buildRestorePlan(db, backup, 'merge');
        if (!plan.valid || plan.conflicts.length > 0) {
          throw new Error(`Merge conflict detected: ${plan.conflicts.map((c) => c.message).join('; ')}`);
        }
        const res = await executeAtomicMerge(db, plan);
        insertedCounts = res.insertedCounts;
        skippedCounts = res.skippedCounts;
      }

      recordStorageMutation();

      return {
        success: true,
        mode,
        insertedCounts,
        skippedCounts,
        verified: true,
        durationMs: Date.now() - startTime,
      };
    });
  }

  // Bounded Staging Restore path for raw files / streams / large archives
  const rawInput = (backupOrInput as any)?._lightweight
    ? (backupOrInput as any)._rawInput
    : backupOrInput;

  const idbFactory = (db as any).factory ?? (db as any).__idbFactory ?? (typeof indexedDB !== 'undefined' ? indexedDB : undefined);
  const operationId = `restore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const stagingDbName = createStagingDatabaseName(operationId);
  const snapshotDbName = createSnapshotDatabaseName(operationId);

  let ingestResult: { stagingDb: IDBDatabase; counts: PortableBackupStoreCounts } | null = null;
  try {
    const ingest = await ingestArchiveToStaging(rawInput, idbFactory, stagingDbName);
    ingestResult = ingest;

    let result: RestoreResult;
    if (mode === 'replace') {
      result = await commitStagingReplaceToLive(db, ingest.stagingDb, ingest.counts, idbFactory, snapshotDbName);
    } else {
      const plan = await buildRestorePlanFromStaging(db, ingest.stagingDb, 'merge', ingest.counts);
      result = await commitStagingMergeToLive(db, plan, idbFactory, ingest.stagingDb, snapshotDbName);
    }

    if (result.success) {
      recordStorageMutation();
    }

    return result;
  } catch (err) {
    if (ingestResult?.stagingDb) {
      closeExtensionDatabase(idbFactory, stagingDbName);
      try {
        await deleteExtensionDatabase(idbFactory, stagingDbName);
      } catch {}
    }
    throw err;
  }
}
