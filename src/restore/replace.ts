/**
 * Atomic Archive Replacement Engine.
 *
 * Replaces the current IndexedDB archive with the backup archive in a SINGLE
 * atomic readwrite transaction covering all 9 stores (6 durable + 3 ephemeral).
 *
 * Rollback Guarantee:
 * If any operation or constraint fails, the transaction aborts automatically.
 * The pre-restore archive remains completely untouched.
 */

import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_HISTORY_STAGING,
  STORE_HISTORY_STAGING_MANIFESTS,
  STORE_CONTEXT_CONTINUITY_RECEIPTS,
} from '../storage/schema';
import type { MaterializedPortableBackup } from '../backup/reader';
import type { PortableBackupStoreCounts } from '../backup/format';
import { createDurableWriteTransaction } from '../storage/db';

export const ALL_ARCHIVE_STORES = [
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_HISTORY_STAGING,
  STORE_HISTORY_STAGING_MANIFESTS,
  STORE_CONTEXT_CONTINUITY_RECEIPTS,
] as const;

export const ALL_NINE_STORES = ALL_ARCHIVE_STORES;

export interface ReplaceExecutionResult {
  success: boolean;
  insertedCounts: PortableBackupStoreCounts;
  durationMs: number;
}

/**
 * Execute atomic archive replacement in ONE readwrite transaction across all 9 stores.
 */
export async function executeAtomicReplace(
  db: IDBDatabase,
  backup: MaterializedPortableBackup
): Promise<ReplaceExecutionResult> {
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = createDurableWriteTransaction(db, ALL_NINE_STORES as unknown as string[], 'strict');
    } catch (err) {
      return reject(new Error(`Failed to open replace transaction: ${(err as Error).message}`));
    }

    tx.onabort = () => {
      reject(new Error(`Replace transaction aborted: ${tx.error?.message || 'Transaction aborted'}`));
    };

    tx.onerror = () => {
      reject(new Error(`Replace transaction failed: ${tx.error?.message || 'Unknown transaction error'}`));
    };

    tx.oncomplete = () => {
      resolve({
        success: true,
        insertedCounts: {
          conversations: backup.records.conversations.length,
          messages: backup.records.messages.length,
          revisions: backup.records.revisions.length,
          recovery_events: backup.records.recovery_events.length,
          raw_streams: backup.records.raw_streams.length,
          raw_stream_batches: backup.records.raw_stream_batches.length,
        },
        durationMs: Date.now() - startTime,
      });
    };

    try {
      // 1. Clear all 9 stores
      for (const storeName of ALL_NINE_STORES) {
        const store = tx.objectStore(storeName);
        store.clear();
      }

      // 2. Insert all backup records into the 6 durable stores
      const convStore = tx.objectStore(STORE_CONVERSATIONS);
      for (const conv of backup.records.conversations) {
        convStore.put(conv);
      }

      const msgStore = tx.objectStore(STORE_MESSAGES);
      for (const msg of backup.records.messages) {
        msgStore.put(msg);
      }

      const revStore = tx.objectStore(STORE_REVISIONS);
      for (const rev of backup.records.revisions) {
        revStore.put(rev);
      }

      const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);
      for (const rec of backup.records.recovery_events) {
        recStore.put(rec);
      }

      const rawStreamStore = tx.objectStore(STORE_RAW_STREAMS);
      for (const stream of backup.records.raw_streams) {
        rawStreamStore.put(stream);
      }

      const rawBatchStore = tx.objectStore(STORE_RAW_STREAM_BATCHES);
      for (const batch of backup.records.raw_stream_batches) {
        rawBatchStore.put(batch);
      }
    } catch (err) {
      try {
        tx.abort();
      } catch {
        // tx might already be aborted
      }
      return reject(err);
    }
  });
}
