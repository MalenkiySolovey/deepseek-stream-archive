/**
 * Maintenance & Cleanup Engine for Raw Evidence and Local Archive.
 *
 * Implements:
 * 1. buildRawRetentionPlan / executeRawRetentionPlan (age-based pruning with Protected Evidence Shield).
 * 2. clearRawEvidence (purges raw_streams and raw_stream_batches, keeping 100% of canonical records).
 * 3. clearEntireArchive (atomic purge across all 9 stores with rollback on failure).
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
} from '../schema';
import { ALL_NINE_STORES } from '../../restore/replace';
import type { Message, ResponseRevision, RecoveryEvent } from '../../core/models';
import type { RawStreamRecord } from '../raw-journal/types';
import { evaluateRawStreamRetention, getCutoffTimestamp } from './policy';
import type { ArchiveCleanupResult, RawRetentionMode, RawRetentionPlan } from './types';
import { createDurableWriteTransaction } from '../db';
import { STORAGE_MUTATION_KEY, recordStorageMutation } from '../mutation-tracker';

function makeKeyRange(key: IDBValidKey): IDBKeyRange | IDBValidKey {
  return typeof IDBKeyRange !== 'undefined' ? IDBKeyRange.only(key) : key;
}

const RETENTION_PLAN_STORES = [
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
] as const;

/**
 * Builds an age-based retention plan protecting recovery provenance and anomalies.
 */
export async function buildRawRetentionPlan(
  db: IDBDatabase,
  mode: RawRetentionMode,
  activeStreamKeys: Set<string>,
  now: number = Date.now()
): Promise<RawRetentionPlan> {
  if (mode === 'forever') {
    return {
      mode: 'forever',
      candidateStreamKeys: [],
      candidateBatchCount: 0,
      protectedStreamCount: 0,
      totalStreamsScanned: 0,
      estimatedFreedBatches: 0,
    };
  }

  const cutoff = getCutoffTimestamp(mode, now);

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(RETENTION_PLAN_STORES as unknown as string[], 'readonly');
    } catch (err) {
      return reject(new Error(`Failed to open retention plan transaction: ${(err as Error).message}`));
    }

    const rawStreamsStore = tx.objectStore(STORE_RAW_STREAMS);
    const msgStore = tx.objectStore(STORE_MESSAGES);
    const revStore = tx.objectStore(STORE_REVISIONS);
    const recStore = tx.objectStore(STORE_RECOVERY_EVENTS);

    let recDone = false;
    let revDone = false;
    let msgDone = false;
    let streamsDone = false;

    let recoveryEvents: RecoveryEvent[] = [];
    let allRevisions: ResponseRevision[] = [];
    let allMessages: Message[] = [];
    let allStreams: RawStreamRecord[] = [];

    const checkAllComplete = () => {
      if (!recDone || !revDone || !msgDone || !streamsDone) return;

      const protectedRecoveryKeys = new Set<string>();
      const protectedFilterKeys = new Set<string>();
      const protectedLastGoodKeys = new Set<string>();
      const protectedUnmatchedKeys = new Set<string>();

      // 1. Recovery events
      const recoveryMsgIds = new Set(recoveryEvents.map((r) => r.messageId));

      // 2. LastGood revisions
      const lastGoodMsgIds = new Set<string>();
      for (const rev of allRevisions) {
        if (rev.isLastGood === true) {
          lastGoodMsgIds.add(rev.messageId);
        }
      }

      // 3. Messages mapping
      for (const msg of allMessages) {
        if (!msg.sourceRawStreamKey) continue;
        if (msg.status === 'filtered') {
          protectedFilterKeys.add(msg.sourceRawStreamKey);
        }
        if (recoveryMsgIds.has(msg.id)) {
          protectedRecoveryKeys.add(msg.sourceRawStreamKey);
        }
        if (lastGoodMsgIds.has(msg.id)) {
          protectedLastGoodKeys.add(msg.sourceRawStreamKey);
        }
        if (msg.projectionState === 'unmatched_capture') {
          protectedUnmatchedKeys.add(msg.sourceRawStreamKey);
        }
      }

      // 4. Evaluate each stream
      const candidateKeys: string[] = [];
      let candidateBatchCount = 0;
      let protectedCount = 0;
      let oldestTs: number | undefined;
      let newestTs: number | undefined;

      for (const stream of allStreams) {
        const streamKey = stream.id;
        const decision = evaluateRawStreamRetention(stream, {
          mode,
          now,
          isActive: activeStreamKeys.has(streamKey),
          hasFilterStatus: protectedFilterKeys.has(streamKey),
          hasRecoveryEvent: protectedRecoveryKeys.has(streamKey),
          hasLastGoodRevision: protectedLastGoodKeys.has(streamKey),
          isUnmatchedCapture: protectedUnmatchedKeys.has(streamKey),
        });

        if (decision.eligible) {
          candidateKeys.push(streamKey);
          candidateBatchCount += stream.totalBatches || 0;
          if (oldestTs === undefined || stream.openedAt < oldestTs) {
            oldestTs = stream.openedAt;
          }
          if (newestTs === undefined || stream.openedAt > newestTs) {
            newestTs = stream.openedAt;
          }
        } else {
          protectedCount++;
        }
      }

      resolve({
        mode,
        cutoffTimestamp: cutoff,
        candidateStreamKeys: candidateKeys,
        candidateBatchCount,
        protectedStreamCount: protectedCount,
        totalStreamsScanned: allStreams.length,
        estimatedFreedBatches: candidateBatchCount,
        oldestCandidateTimestamp: oldestTs,
        newestCandidateTimestamp: newestTs,
      });
    };

    // Parallel requests initiated in the same transaction turn
    const recReq = recStore.getAll();
    recReq.onerror = () => reject(new Error(recReq.error?.message || 'Failed to read recovery events'));
    recReq.onsuccess = () => {
      recoveryEvents = (recReq.result || []) as RecoveryEvent[];
      recDone = true;
      checkAllComplete();
    };

    const revReq = revStore.getAll();
    revReq.onerror = () => reject(new Error(revReq.error?.message || 'Failed to read revisions'));
    revReq.onsuccess = () => {
      allRevisions = (revReq.result || []) as ResponseRevision[];
      revDone = true;
      checkAllComplete();
    };

    const msgReq = msgStore.getAll();
    msgReq.onerror = () => reject(new Error(msgReq.error?.message || 'Failed to read messages'));
    msgReq.onsuccess = () => {
      allMessages = (msgReq.result || []) as Message[];
      msgDone = true;
      checkAllComplete();
    };

    const streamsReq = rawStreamsStore.getAll();
    streamsReq.onerror = () => reject(new Error(streamsReq.error?.message || 'Failed to read raw streams'));
    streamsReq.onsuccess = () => {
      allStreams = (streamsReq.result || []) as RawStreamRecord[];
      streamsDone = true;
      checkAllComplete();
    };
  });
}

/**
 * Executes a raw retention plan in ONE readwrite transaction across raw_streams and raw_stream_batches.
 */
export async function executeRawRetentionPlan(
  db: IDBDatabase,
  plan: RawRetentionPlan,
  activeStreamKeys: Set<string>
): Promise<ArchiveCleanupResult> {
  const startTime = Date.now();

  // Filter out any streams that became active between preview and execution
  const keysToDelete = plan.candidateStreamKeys.filter((k) => !activeStreamKeys.has(k));

  if (keysToDelete.length === 0) {
    return {
      success: true,
      deletedStreamCount: 0,
      deletedBatchCount: 0,
      durationMs: Date.now() - startTime,
    };
  }

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = createDurableWriteTransaction(db, [STORE_RAW_STREAMS, STORE_RAW_STREAM_BATCHES], 'strict');
    } catch (err) {
      return reject(new Error(`Failed to open retention cleanup transaction: ${(err as Error).message}`));
    }

    let settled = false;

    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(new Error(`Retention cleanup transaction aborted: ${tx.error?.message || 'Transaction aborted'}`));
      }
    };

    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error(`Retention cleanup transaction failed: ${tx.error?.message || 'Unknown transaction error'}`));
      }
    };

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve({
          success: true,
          deletedStreamCount: keysToDelete.length,
          deletedBatchCount: plan.candidateBatchCount,
          durationMs: Date.now() - startTime,
        });
      }
    };

    try {
      const rawStreamsStore = tx.objectStore(STORE_RAW_STREAMS);
      const rawBatchesStore = tx.objectStore(STORE_RAW_STREAM_BATCHES);
      const batchIndex = rawBatchesStore.index('streamKey');

      for (const sKey of keysToDelete) {
        rawStreamsStore.delete(sKey);

        const cursorReq = batchIndex.openCursor(makeKeyRange(sKey));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          }
        };
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      }
    }
  });
}

/**
 * Purges ALL raw streams and raw stream batches while leaving 100% of canonical
 * conversations, messages, revisions, and recovery events intact.
 */
export async function clearRawEvidence(
  db: IDBDatabase,
  activeStreamCount: number
): Promise<ArchiveCleanupResult> {
  if (activeStreamCount > 0) {
    throw new Error('active_stream_in_progress');
  }

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = createDurableWriteTransaction(db, [STORE_RAW_STREAMS, STORE_RAW_STREAM_BATCHES], 'strict');
    } catch (err) {
      return reject(new Error(`Failed to open clearRawEvidence transaction: ${(err as Error).message}`));
    }

    let settled = false;
    let streamCount = 0;
    let batchCount = 0;

    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(new Error(`clearRawEvidence transaction aborted: ${tx.error?.message || 'Transaction aborted'}`));
      }
    };

    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error(`clearRawEvidence transaction failed: ${tx.error?.message || 'Unknown transaction error'}`));
      }
    };

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve({
          success: true,
          deletedStreamCount: streamCount,
          deletedBatchCount: batchCount,
          durationMs: Date.now() - startTime,
        });
      }
    };

    try {
      const rawStreamsStore = tx.objectStore(STORE_RAW_STREAMS);
      const rawBatchesStore = tx.objectStore(STORE_RAW_STREAM_BATCHES);

      const countStreamReq = rawStreamsStore.count();
      countStreamReq.onsuccess = () => {
        streamCount = countStreamReq.result;
        rawStreamsStore.clear();
      };

      const countBatchReq = rawBatchesStore.count();
      countBatchReq.onsuccess = () => {
        batchCount = countBatchReq.result;
        rawBatchesStore.clear();
      };
    } catch (err) {
      if (!settled) {
        settled = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      }
    }
  });
}

/**
 * Clears ALL 9 IndexedDB stores in ONE atomic readwrite transaction.
 * Preserves user settings (UI language, theme, retention preferences in chrome.storage.local).
 */
export async function clearEntireArchive(
  db: IDBDatabase,
  activeStreamCount: number
): Promise<{ success: boolean; durationMs: number }> {
  if (activeStreamCount > 0) {
    throw new Error('active_stream_in_progress');
  }

  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(ALL_NINE_STORES as unknown as string[], 'readwrite');
    } catch (err) {
      return reject(new Error(`Failed to open clearEntireArchive transaction: ${(err as Error).message}`));
    }

    let settled = false;

    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(new Error(`clearEntireArchive transaction aborted: ${tx.error?.message || 'Transaction aborted'}`));
      }
    };

    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(new Error(`clearEntireArchive transaction failed: ${tx.error?.message || 'Unknown transaction error'}`));
      }
    };

    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve({
          success: true,
          durationMs: Date.now() - startTime,
        });
      }
    };

    try {
      for (const storeName of ALL_NINE_STORES) {
        const store = tx.objectStore(storeName);
        store.clear();
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        try {
          tx.abort();
        } catch {
          // ignore
        }
        reject(err);
      }
    }
  });
}
