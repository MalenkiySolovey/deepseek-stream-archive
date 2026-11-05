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
import { acquireRestoreLock, type RestoreLockHandle } from './restore-lock';
import type { RestorePlan, RestoreResult, RestoreMode, RestoreConflict } from './types';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../core/models';
import type { RawStreamRecord, RawStreamBatch } from '../storage/raw-journal/types';
import { ALL_NINE_STORES } from './replace';

export const RESTORE_STAGING_DB_NAME = 'StreamArchiveDB_restore_staging' as const;
export const RESTORE_SNAPSHOT_DB_NAME = 'StreamArchiveDB_pre_restore_snapshot' as const;
export const RESTORE_JOURNAL_DB_NAME = 'StreamArchiveDB_restore_journal' as const;
export const RESTORE_JOURNAL_STORE_NAME = 'restore_journal_markers' as const;

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

export type RestoreJournalStage =
  | 'idle'
  | 'preparing_snapshot'
  | 'snapshot_verified'
  | 'commit_started'
  | 'commit_completed'
  | 'rollback_required'
  | 'rollback_in_progress'
  | 'recovery_verified'
  // Legacy backward compatibility
  | 'snapshot_ready'
  | 'transferring'
  | 'verifying'
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

/**
 * Safely opens an existing snapshot database WITHOUT auto-creating an empty database if it does not exist.
 * Returns null if the snapshot database does not exist, was just created by open(), or is missing required stores.
 */
export async function openExistingSnapshotWithoutCreating(
  idbFactory?: IDBFactory,
  snapshotDbName?: string
): Promise<IDBDatabase | null> {
  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!factory || !snapshotDbName) return null;

  if (typeof (factory as any).databases === 'function') {
    try {
      const dbs: Array<{ name?: string }> = await (factory as any).databases();
      const exists = dbs.some((db) => db.name === snapshotDbName);
      if (!exists) {
        return null;
      }
    } catch {
      // non-fatal fallback
    }
  }

  return new Promise<IDBDatabase | null>((resolve) => {
    let wasCreated = false;
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(snapshotDbName, DB_VERSION);
    } catch {
      return resolve(null);
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
        const db = (e.target as IDBOpenDBRequest).result;
        const tx = (e.target as IDBOpenDBRequest).transaction;
        configureDatabaseSchema(db, tx);
      }
    };

    req.onsuccess = () => {
      if (wasCreated) {
        const db = req.result;
        try { db.close(); } catch {}
        try { factory.deleteDatabase(snapshotDbName); } catch {}
        resolve(null);
      } else {
        const db = req.result;
        db.onversionchange = () => {
          try { db.close(); } catch {}
        };
        let validStores = true;
        for (const st of EIGHT_SNAPSHOT_STORES) {
          if (!db.objectStoreNames.contains(st)) {
            validStores = false;
            break;
          }
        }
        if (!validStores) {
          try { db.close(); } catch {}
          resolve(null);
        } else {
          resolve(db);
        }
      }
    };

    req.onerror = () => {
      try { factory.deleteDatabase(snapshotDbName); } catch {}
      resolve(null);
    };
  });
}

/**
 * Persists or clears the crash-recovery marker in chrome.storage.local and dedicated IndexedDB.
 */
export async function setRestoreJournalMarker(
  marker: RestoreJournalMarker | null,
  idbFactory?: IDBFactory
): Promise<void> {
  // 1. Chrome storage local (if available)
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      if (marker) {
        await chrome.storage.local.set({ __streamarchive_restore_marker__: marker });
      } else {
        await chrome.storage.local.remove('__streamarchive_restore_marker__');
      }
    }
  } catch {
    // Non-blocking fallback
  }

  // 2. Dedicated recovery database
  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!factory) return;

  if (marker === null) {
    try {
      await deleteExtensionDatabase(idbFactory, RESTORE_JOURNAL_DB_NAME);
    } catch {
      // ignore
    }
    return;
  }

  return new Promise((resolve, reject) => {
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
        reject(tx.error);
      };
      tx.objectStore(RESTORE_JOURNAL_STORE_NAME).put({ id: 'active', ...marker });
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Reads the active crash-recovery marker if present.
 */
export async function getRestoreJournalMarker(idbFactory?: IDBFactory): Promise<RestoreJournalMarker | null> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const stored = await chrome.storage.local.get('__streamarchive_restore_marker__');
      if (stored && stored.__streamarchive_restore_marker__) {
        return stored.__streamarchive_restore_marker__ as RestoreJournalMarker;
      }
    }
  } catch {
    // ignore
  }

  const factory = idbFactory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  if (!factory) return null;

  return new Promise((resolve) => {
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
        const tx = db.transaction([RESTORE_JOURNAL_STORE_NAME], 'readonly');
        const getReq = tx.objectStore(RESTORE_JOURNAL_STORE_NAME).get('active');
        getReq.onsuccess = () => {
          const res = getReq.result;
          db.close();
          if (res && res.type) {
            resolve(res as RestoreJournalMarker);
          } else {
            resolve(null);
          }
        };
        getReq.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch {
        db.close();
        resolve(null);
      }
    };
    req.onerror = () => resolve(null);
  });
}

/**
 * Recovers live database from snapshot if a previous restore was interrupted by a browser crash or kill.
 */
export async function recoverIncompleteRestoreIfAny(idbFactory?: IDBFactory): Promise<boolean> {
  const marker = await getRestoreJournalMarker(idbFactory);
  if (!marker) return false;

  let normalizedStage: RestoreJournalStage = marker.stage;
  if (marker.stage === ('snapshot_ready' as any)) normalizedStage = 'snapshot_verified';
  else if (marker.stage === ('transferring' as any)) normalizedStage = 'commit_started';
  else if (marker.stage === ('verifying' as any)) normalizedStage = 'commit_completed';
  else if (marker.stage === ('rolling_back' as any)) normalizedStage = 'rollback_in_progress';

  // If restore was interrupted BEFORE liveDb was modified, liveDb is 100% intact!
  if (
    normalizedStage === 'idle' ||
    normalizedStage === 'preparing_snapshot' ||
    normalizedStage === 'snapshot_verified'
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
    return false;
  }

  let lock: RestoreLockHandle | null = null;
  try {
    lock = await acquireRestoreLock('recovery', 5000);
  } catch (lockErr) {
    console.warn('[Crash Recovery] Recovery lock could not be acquired (another context active):', lockErr);
    return false;
  }

  console.warn(`[Crash Recovery] Detected unfinished restore from crash (stage: ${normalizedStage}, started: ${marker.timestamp}). Recovering live database...`);

  let snapshotDb: IDBDatabase | null = null;
  let liveDb: IDBDatabase | null = null;
  try {
    snapshotDb = await openExistingSnapshotWithoutCreating(idbFactory, marker.snapshotDbName);
    if (!snapshotDb) {
      console.error(
        `[Crash Recovery] CRITICAL ERROR: Snapshot database "${marker.snapshotDbName}" does not exist or has invalid schema! ` +
        `Refusing to touch live database "${marker.liveDbName}" to prevent data destruction.`
      );
      return false;
    }

    liveDb = await openExtensionDatabase(idbFactory, marker.liveDbName);

    if (normalizedStage === 'commit_completed') {
      let hasData = false;
      try {
        const tx = liveDb.transaction(STORE_CONVERSATIONS, 'readonly');
        const count = await new Promise<number>((res, rej) => {
          const req = tx.objectStore(STORE_CONVERSATIONS).count();
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        hasData = count > 0;
      } catch {}

      if (hasData) {
        const snapMatch = await verifyDatabaseEquality(snapshotDb, liveDb, EIGHT_SNAPSHOT_STORES);
        if (snapMatch) {
          await setRestoreJournalMarker(null, idbFactory);
          if (snapshotDb) {
            try { snapshotDb.close(); } catch {}
            snapshotDb = null;
          }
          closeExtensionDatabase(idbFactory, marker.snapshotDbName);
          await deleteExtensionDatabase(idbFactory, marker.snapshotDbName);
          closeExtensionDatabase(idbFactory, marker.stagingDbName);
          await deleteExtensionDatabase(idbFactory, marker.stagingDbName);
          return true;
        }
      }
    }

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

    for (const store of EIGHT_SNAPSHOT_STORES) {
      if (snapshotDb.objectStoreNames.contains(store) && liveDb.objectStoreNames.contains(store)) {
        await copyStoreRecords(snapshotDb, liveDb, store, false);
      }
    }

    const verified = await verifyDatabaseEquality(snapshotDb, liveDb, EIGHT_SNAPSHOT_STORES);
    if (!verified) {
      throw new Error('Crash recovery verification mismatch between snapshot and restored live database.');
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
    return true;
  } catch (err) {
    console.error('[Crash Recovery] Failed to recover from crash snapshot:', err);
    return false;
  } finally {
    if (snapshotDb) {
      try { snapshotDb.close(); } catch {}
    }
    if (lock) {
      try { await lock.release(); } catch {}
    }
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
 * Validates referential integrity directly against the staging database using cursor batches.
 * Peak memory consumption is strictly bounded (< 2 MiB RAM) without accumulating in-memory graphs.
 */
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

      const tx = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readonly');
      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      const msgStore = tx.objectStore(STORE_MESSAGES);

      for (const item of batch) {
        const msg = item.value as Message;
        // Check conversationId
        const convReq = convStore.get(msg.conversationId);
        const convExists = await new Promise<boolean>((res) => {
          convReq.onsuccess = () => res(!!convReq.result);
          convReq.onerror = () => res(false);
        });
        if (!convExists) {
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
            const parentReq = msgStore.get(msg.parentId);
            const parent = await new Promise<any>((res) => {
              parentReq.onsuccess = () => res(parentReq.result);
              parentReq.onerror = () => res(null);
            });
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
            }
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

      const tx = stagingDb.transaction([STORE_MESSAGES], 'readonly');
      const msgStore = tx.objectStore(STORE_MESSAGES);
      for (const item of batch) {
        const rev = item.value as ResponseRevision;
        const msgReq = msgStore.get(rev.messageId);
        const msgExists = await new Promise<boolean>((res) => {
          msgReq.onsuccess = () => res(!!msgReq.result);
          msgReq.onerror = () => res(false);
        });
        if (!msgExists) {
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

      const tx = stagingDb.transaction([STORE_RAW_STREAMS], 'readonly');
      const rawStore = tx.objectStore(STORE_RAW_STREAMS);
      for (const item of batch) {
        const b = item.value as RawStreamBatch;
        const rawReq = rawStore.get(b.streamKey);
        const rawExists = await new Promise<boolean>((res) => {
          rawReq.onsuccess = () => res(!!rawReq.result);
          rawReq.onerror = () => res(false);
        });
        if (!rawExists) {
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

  return {
    valid: errors.length === 0,
    errors,
  };
}

export interface IngestStagingResult {
  stagingDb: IDBDatabase;
  manifest: import('../backup/format').PortableBackupManifestRecord;
  footer: import('../backup/format').PortableBackupFooterRecord;
  counts: PortableBackupStoreCounts;
}

/**
 * Ingests an archive stream chunk-by-chunk into the staging database.
 * Memory consumption is strictly bounded (< 5 MiB RAM) regardless of archive size.
 */
export async function ingestArchiveToStaging(
  input: ArrayBuffer | Uint8Array | Blob | ReadableStream<Uint8Array>,
  idbFactory?: IDBFactory
): Promise<IngestStagingResult> {
  const { stream } = createFreshInputStream(input);

  // Clean prior staging database if any existed
  await deleteExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
  const stagingDb = await openExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);

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
    closeExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
    await deleteExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
    throw new Error(`Failed to read backup archive: ${readResult.errors.map((e) => e.message).join('; ')}`);
  }

  // Validate referential integrity directly against stagingDb
  const integrity = await validateStagingReferentialIntegrity(stagingDb);
  if (!integrity.valid) {
    closeExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
    await deleteExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
    throw new Error(`Referential integrity failed: ${integrity.errors.map((e) => e.message).join('; ')}`);
  }

  return {
    stagingDb,
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
 */
export async function verifyDatabaseEquality(
  dbA: IDBDatabase,
  dbB: IDBDatabase,
  stores: readonly string[]
): Promise<boolean> {
  for (const storeName of stores) {
    if (!dbA.objectStoreNames.contains(storeName) || !dbB.objectStoreNames.contains(storeName)) {
      continue;
    }

    // 1. Check count equality
    const countA = await new Promise<number>((res, rej) => {
      const tx = dbA.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const countB = await new Promise<number>((res, rej) => {
      const tx = dbB.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).count();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });

    if (countA !== countB) {
      console.error(`[verifyDatabaseEquality] Count mismatch in store "${storeName}": dbA=${countA}, dbB=${countB}`);
      return false;
    }

    // 2. Sample key check in batches
    let startKey: IDBValidKey | null = null;
    while (true) {
      const batchA = await fetchStoreBatch(dbA, storeName, startKey, BATCH_SIZE);
      const batchB = await fetchStoreBatch(dbB, storeName, startKey, BATCH_SIZE);

      if (batchA.length !== batchB.length) {
        console.error(`[verifyDatabaseEquality] Batch length mismatch in "${storeName}": dbA=${batchA.length}, dbB=${batchB.length}`);
        return false;
      }
      if (batchA.length === 0) break;

      for (let i = 0; i < batchA.length; i++) {
        const itemA = batchA[i];
        const itemB = batchB[i];
        if (!itemA || !itemB || itemA.key !== itemB.key) {
          console.error(`[verifyDatabaseEquality] Key mismatch in "${storeName}": dbA=${itemA?.key}, dbB=${itemB?.key}`);
          return false;
        }
        if (!deepEqualRecords(storeName, itemA.value, itemB.value)) {
          console.error(`[verifyDatabaseEquality] Content mismatch in "${storeName}" for key ${itemA.key}`);
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
 * Executes safe Replace restoration from stagingDb to liveDb with pre-restore snapshot rollback guard.
 */
export async function commitStagingReplaceToLive(
  liveDb: IDBDatabase,
  stagingDb: IDBDatabase,
  expectedCounts: PortableBackupStoreCounts,
  idbFactory?: IDBFactory
): Promise<RestoreResult> {
  if (activeRestoreLock) {
    throw new Error('Another restore operation is already in progress.');
  }
  activeRestoreLock = true;
  let lock: RestoreLockHandle | null = null;

  const startTime = Date.now();
  const operationId = `replace-${startTime}-${Math.random().toString(36).slice(2, 7)}`;
  let snapshotDb: IDBDatabase | null = null;
  let snapshotCreated = false;

  try {
    lock = await acquireRestoreLock('replace');
    // Step 1: Create rollback snapshot covering all 8 persistent stores
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'preparing_snapshot',
      liveDbName: liveDb.name,
      snapshotDbName: RESTORE_SNAPSHOT_DB_NAME,
      stagingDbName: RESTORE_STAGING_DB_NAME,
      timestamp: Date.now(),
      operationId,
      expectedCounts,
    }, idbFactory);

    await deleteExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
    snapshotDb = await openExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);

    for (const store of EIGHT_SNAPSHOT_STORES) {
      if (liveDb.objectStoreNames.contains(store)) {
        await copyStoreRecords(liveDb, snapshotDb, store, false);
      }
    }

    await triggerInterruptionPoint('after_snapshot_created');

    // Deep-verify snapshot before clearing live database
    const snapVerified = await verifyDatabaseEquality(liveDb, snapshotDb, EIGHT_SNAPSHOT_STORES);
    if (!snapVerified) {
      throw new Error('Pre-restore snapshot verification failed. Aborting to protect existing archive.');
    }
    snapshotCreated = true;

    // Persist crash recovery marker
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'snapshot_verified',
      liveDbName: liveDb.name,
      snapshotDbName: RESTORE_SNAPSHOT_DB_NAME,
      stagingDbName: RESTORE_STAGING_DB_NAME,
      timestamp: Date.now(),
      operationId,
      expectedCounts,
    }, idbFactory);

    await triggerInterruptionPoint('after_journal_persisted');

    // Transition to commit_started
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'commit_started',
      liveDbName: liveDb.name,
      snapshotDbName: RESTORE_SNAPSHOT_DB_NAME,
      stagingDbName: RESTORE_STAGING_DB_NAME,
      timestamp: Date.now(),
      operationId,
      expectedCounts,
    }, idbFactory);

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
      stage: 'commit_completed',
      liveDbName: liveDb.name,
      snapshotDbName: RESTORE_SNAPSHOT_DB_NAME,
      stagingDbName: RESTORE_STAGING_DB_NAME,
      timestamp: Date.now(),
      operationId,
      expectedCounts,
    }, idbFactory);

    await triggerInterruptionPoint('after_full_transfer');

    // Step 4: Verify post-commit store counts and deep equality
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
          snapshotDbName: RESTORE_SNAPSHOT_DB_NAME,
          stagingDbName: RESTORE_STAGING_DB_NAME,
          timestamp: Date.now(),
          operationId,
          expectedCounts,
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

        rollbackSucceeded = await verifyDatabaseEquality(snapshotDb, liveDb, EIGHT_SNAPSHOT_STORES);
      } catch (rollbackErr) {
        console.error('[Staging Replace] Rollback snapshot encountered error:', rollbackErr);
        rollbackSucceeded = false;
      }

      if (rollbackSucceeded) {
        await setRestoreJournalMarker(null, idbFactory);
        closeExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
        await deleteExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
        closeExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
        await deleteExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);

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
          error: `Rollback verification failed! Your original database is preserved in snapshot "${RESTORE_SNAPSHOT_DB_NAME}".`,
        };
      }
    }

    // Step 5: Success! Clean up temporary databases
    await triggerInterruptionPoint('before_journal_deletion');
    await setRestoreJournalMarker(null, idbFactory);
    await triggerInterruptionPoint('after_journal_deletion');

    await triggerInterruptionPoint('before_snapshot_deletion');
    closeExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
    await deleteExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
    closeExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
    await deleteExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);

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
    };
  } catch (err) {
    if (snapshotCreated && snapshotDb) {
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

        for (const store of EIGHT_SNAPSHOT_STORES) {
          if (liveDb.objectStoreNames.contains(store) && snapshotDb.objectStoreNames.contains(store)) {
            await copyStoreRecords(snapshotDb, liveDb, store, false);
          }
        }

        const rollbackVerified = await verifyDatabaseEquality(snapshotDb, liveDb, EIGHT_SNAPSHOT_STORES);
        if (rollbackVerified) {
          await setRestoreJournalMarker(null, idbFactory);
          closeExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
          await deleteExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
          closeExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
          await deleteExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
        }
      } catch (rErr) {
        console.error('[Staging Replace] Error in emergency rollback:', rErr);
      }
    }
    throw err;
  } finally {
    activeRestoreLock = false;
    if (lock) {
      await lock.release();
    }
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
  customStagingDb?: IDBDatabase
): Promise<RestoreResult> {
  if (activeRestoreLock) {
    throw new Error('Another restore operation is already in progress.');
  }
  activeRestoreLock = true;
  let lock: RestoreLockHandle | null = null;

  const startTime = Date.now();
  const operationId = `merge-${startTime}-${Math.random().toString(36).slice(2, 7)}`;
  let snapshotDb: IDBDatabase | null = null;
  let snapshotCreated = false;

  try {
    lock = await acquireRestoreLock('merge');
    if (!plan.valid || plan.conflicts.length > 0) {
      throw new Error(`Merge conflict detected: ${plan.conflicts.map((c) => c.message).join('; ')}`);
    }

    const stagingDb = customStagingDb || (await openExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME));

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
      snapshotDbName: RESTORE_SNAPSHOT_DB_NAME,
      stagingDbName: RESTORE_STAGING_DB_NAME,
      timestamp: Date.now(),
      operationId,
    }, idbFactory);

    await deleteExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
    snapshotDb = await openExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
    for (const store of EIGHT_SNAPSHOT_STORES) {
      if (liveDb.objectStoreNames.contains(store)) {
        await copyStoreRecords(liveDb, snapshotDb, store, false);
      }
    }

    await triggerInterruptionPoint('after_snapshot_created');

    const snapVerified = await verifyDatabaseEquality(liveDb, snapshotDb, EIGHT_SNAPSHOT_STORES);
    if (!snapVerified) {
      throw new Error('Pre-merge rollback snapshot verification failed.');
    }
    snapshotCreated = true;

    // Persist crash-recovery marker
    await setRestoreJournalMarker({
      type: 'merge',
      stage: 'snapshot_verified',
      liveDbName: liveDb.name,
      snapshotDbName: RESTORE_SNAPSHOT_DB_NAME,
      stagingDbName: RESTORE_STAGING_DB_NAME,
      timestamp: Date.now(),
      operationId,
    }, idbFactory);

    await triggerInterruptionPoint('after_journal_persisted');

    await setRestoreJournalMarker({
      type: 'merge',
      stage: 'commit_started',
      liveDbName: liveDb.name,
      snapshotDbName: RESTORE_SNAPSHOT_DB_NAME,
      stagingDbName: RESTORE_STAGING_DB_NAME,
      timestamp: Date.now(),
      operationId,
    }, idbFactory);

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
      stage: 'commit_completed',
      liveDbName: liveDb.name,
      snapshotDbName: RESTORE_SNAPSHOT_DB_NAME,
      stagingDbName: RESTORE_STAGING_DB_NAME,
      timestamp: Date.now(),
      operationId,
    }, idbFactory);

    await triggerInterruptionPoint('after_full_transfer');

    // Step 4: Success! Clean up marker and temporary databases
    await triggerInterruptionPoint('before_journal_deletion');
    await setRestoreJournalMarker(null, idbFactory);
    await triggerInterruptionPoint('after_journal_deletion');

    await triggerInterruptionPoint('before_snapshot_deletion');
    closeExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
    await deleteExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
    closeExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
    await deleteExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);

    return {
      success: true,
      mode: 'merge',
      insertedCounts,
      skippedCounts: { ...plan.toSkip },
      verified: true,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    console.error('[Staging Merge] Merge encountered error, executing rollback guard:', err);
    if (snapshotCreated && snapshotDb) {
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

        for (const store of EIGHT_SNAPSHOT_STORES) {
          if (liveDb.objectStoreNames.contains(store) && snapshotDb.objectStoreNames.contains(store)) {
            await copyStoreRecords(snapshotDb, liveDb, store, false);
          }
        }

        const rollbackVerified = await verifyDatabaseEquality(snapshotDb, liveDb, EIGHT_SNAPSHOT_STORES);
        if (rollbackVerified) {
          await setRestoreJournalMarker(null, idbFactory);
          closeExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
          await deleteExtensionDatabase(idbFactory, RESTORE_SNAPSHOT_DB_NAME);
          closeExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
          await deleteExtensionDatabase(idbFactory, RESTORE_STAGING_DB_NAME);
          console.info('[Staging Merge] Rollback to pre-merge state succeeded completely.');
        } else {
          console.error('[Staging Merge] Rollback verification failed! Snapshot preserved.');
        }
      } catch (rollbackErr) {
        console.error('[Staging Merge] Catastrophic error during merge rollback:', rollbackErr);
      }
    }
    throw err;
  } finally {
    activeRestoreLock = false;
    if (lock) {
      await lock.release();
    }
  }
}
