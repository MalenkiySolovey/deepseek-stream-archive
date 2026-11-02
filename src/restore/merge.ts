/**
 * Conservative, Conflict-Safe Archive Merge Engine.
 *
 * Implements strict primary-key preserving union across the 6 durable stores.
 * Inside a single readwrite transaction, re-verifies conflicts against the live database,
 * skips identical records, and aborts completely if any conflicting records are encountered.
 */

import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
} from '../storage/schema';
import type { RestorePlan, RestoreResult } from './types';
import type { PortableBackupStoreCounts } from '../backup/format';
import { isRecordSemanticallyIdentical } from '../backup/record-validation';

export const SIX_DURABLE_STORES = [
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
] as const;

export interface MergeExecutionResult {
  success: boolean;
  insertedCounts: PortableBackupStoreCounts;
  skippedCounts: PortableBackupStoreCounts;
  durationMs: number;
}

/**
 * Execute conservative safe merge in ONE readwrite transaction across the 6 durable stores.
 */
export async function executeAtomicMerge(
  db: IDBDatabase,
  plan: RestorePlan
): Promise<MergeExecutionResult> {
  const startTime = Date.now();

  if (!plan.valid || plan.conflicts.length > 0) {
    throw new Error(`Cannot execute invalid merge plan: ${plan.conflicts.map((c) => c.message).join('; ')}`);
  }

  const insertedCounts: PortableBackupStoreCounts = {
    conversations: 0,
    messages: 0,
    revisions: 0,
    recovery_events: 0,
    raw_streams: 0,
    raw_stream_batches: 0,
  };

  const skippedCounts: PortableBackupStoreCounts = { ...plan.toSkip };

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(SIX_DURABLE_STORES as unknown as string[], 'readwrite');
    } catch (err) {
      return reject(new Error(`Failed to open merge transaction: ${(err as Error).message}`));
    }

    let abortedDueToConflict = false;

    tx.onabort = () => {
      reject(new Error(`Merge transaction aborted: ${tx.error?.message || (abortedDueToConflict ? 'Conflict detected during commit' : 'Transaction aborted')}`));
    };

    tx.onerror = () => {
      reject(new Error(`Merge transaction failed: ${tx.error?.message || 'Unknown transaction error'}`));
    };

    tx.oncomplete = () => {
      resolve({
        success: true,
        insertedCounts,
        skippedCounts,
        durationMs: Date.now() - startTime,
      });
    };

    // Helper to put with concurrency check inside transaction
    const processStore = (
      storeName: (typeof SIX_DURABLE_STORES)[number],
      items: Array<{ id: string }>,
      countKey: keyof PortableBackupStoreCounts
    ) => {
      const store = tx.objectStore(storeName);

      for (const item of items) {
        // Read existing inside write transaction
        const getReq = store.get(item.id);
        getReq.onsuccess = () => {
          const existing = getReq.result;
          if (!existing) {
            store.put(item);
            insertedCounts[countKey]++;
          } else {
            // Re-verify semantic equality
            if (isRecordSemanticallyIdentical(storeName, existing, item)) {
              skippedCounts[countKey]++;
            } else {
              // Concurrency conflict! Abort transaction immediately
              abortedDueToConflict = true;
              tx.abort();
            }
          }
        };
      }
    };

    try {
      processStore(STORE_CONVERSATIONS, plan.toInsert.conversations, 'conversations');
      processStore(STORE_MESSAGES, plan.toInsert.messages, 'messages');
      processStore(STORE_REVISIONS, plan.toInsert.revisions, 'revisions');
      processStore(STORE_RECOVERY_EVENTS, plan.toInsert.recovery_events, 'recovery_events');
      processStore(STORE_RAW_STREAMS, plan.toInsert.raw_streams, 'raw_streams');
      processStore(STORE_RAW_STREAM_BATCHES, plan.toInsert.raw_stream_batches, 'raw_stream_batches');
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
