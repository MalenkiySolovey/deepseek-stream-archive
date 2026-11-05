/**
 * Authoritative Storage Mutation & Generation Tracker.
 *
 * Backed by durable sequence records in IndexedDB (`STORE_CANONICAL_CHECKPOINTS`),
 * updated atomically in write transactions to guarantee monotonicity and
 * consistency across Service Worker restarts, multi-process contexts,
 * and BroadcastChannel delivery delays.
 */

import { STORE_CANONICAL_CHECKPOINTS } from './schema';

export const STORAGE_MUTATION_KEY = '__storage_mutation_epoch__';
const MUTATION_CHANNEL_NAME = 'streamarchive_storage_mutations';

let currentMutationEpoch = 1;
let channel: BroadcastChannel | null = null;

if (typeof BroadcastChannel !== 'undefined') {
  try {
    channel = new BroadcastChannel(MUTATION_CHANNEL_NAME);
    channel.onmessage = (event) => {
      if (event && event.data && typeof event.data.epoch === 'number') {
        if (event.data.epoch > currentMutationEpoch) {
          currentMutationEpoch = event.data.epoch;
        }
      }
    };
  } catch {
    channel = null;
  }
}

/**
 * Returns the in-memory cached storage mutation epoch.
 */
export function getStorageMutationEpoch(): number {
  return currentMutationEpoch;
}

/**
 * Synchronizes the in-memory cached epoch and broadcasts to listening windows.
 */
export function syncStorageMutationEpoch(epoch: number): void {
  if (epoch > currentMutationEpoch) {
    currentMutationEpoch = epoch;
  }
  if (channel) {
    try {
      channel.postMessage({ type: 'MUTATION_EPOCH', epoch: currentMutationEpoch });
    } catch {
      // Broadcast error should never interrupt database operations
    }
  }
}

/**
 * Increments the in-memory mutation epoch and notifies listeners.
 */
export function recordStorageMutation(): number {
  currentMutationEpoch++;
  if (channel) {
    try {
      channel.postMessage({ type: 'MUTATION_EPOCH', epoch: currentMutationEpoch });
    } catch {
      // Broadcast error should never interrupt database write transactions
    }
  }
  return currentMutationEpoch;
}

/**
 * Resets or sets the mutation epoch (primarily for isolated test fixtures).
 */
export function resetStorageMutationEpoch(epoch = 1): void {
  currentMutationEpoch = epoch;
}

/**
 * Queries the authoritative durable storage mutation epoch directly from IndexedDB.
 * Guarantees recovery of true generation sequence across Service Worker cold-starts.
 */
export function getDurableStorageMutationEpoch(db: IDBDatabase): Promise<number> {
  return new Promise((resolve) => {
    try {
      if (!db.objectStoreNames.contains(STORE_CANONICAL_CHECKPOINTS)) {
        return resolve(currentMutationEpoch);
      }
      const tx = db.transaction(STORE_CANONICAL_CHECKPOINTS, 'readonly');
      const store = tx.objectStore(STORE_CANONICAL_CHECKPOINTS);
      const req = store.get(STORAGE_MUTATION_KEY);
      req.onsuccess = () => {
        const record = req.result;
        const seq = typeof record?.lastCommittedCheckpointSeq === 'number'
          ? record.lastCommittedCheckpointSeq
          : null;
        if (seq !== null) {
          syncStorageMutationEpoch(seq);
          resolve(seq);
        } else {
          resolve(currentMutationEpoch);
        }
      };
      req.onerror = () => {
        resolve(currentMutationEpoch);
      };
    } catch {
      resolve(currentMutationEpoch);
    }
  });
}

/**
 * Atomically increments the durable mutation sequence inside an active write transaction.
 * Must be called inside a transaction that includes `STORE_CANONICAL_CHECKPOINTS` in readwrite mode.
 */
export function touchDurableMutationEpoch(tx: IDBTransaction): void {
  try {
    if (!tx.db.objectStoreNames.contains(STORE_CANONICAL_CHECKPOINTS)) return;
    if (!tx.objectStoreNames.contains(STORE_CANONICAL_CHECKPOINTS)) return;

    const store = tx.objectStore(STORE_CANONICAL_CHECKPOINTS);
    const getReq = store.get(STORAGE_MUTATION_KEY);
    getReq.onsuccess = () => {
      const prev = getReq.result;
      const prevSeq = typeof prev?.lastCommittedCheckpointSeq === 'number'
        ? prev.lastCommittedCheckpointSeq
        : 0;
      const nextSeq = Math.max(prevSeq + 1, currentMutationEpoch + 1);
      store.put({
        streamKey: STORAGE_MUTATION_KEY,
        lastCommittedCheckpointSeq: nextSeq,
        updatedAt: Date.now(),
        isTerminal: false,
      });

      if (typeof tx.addEventListener === 'function') {
        tx.addEventListener('complete', () => {
          syncStorageMutationEpoch(nextSeq);
        });
      } else {
        const origOnComplete = tx.oncomplete;
        tx.oncomplete = (e) => {
          syncStorageMutationEpoch(nextSeq);
          if (typeof origOnComplete === 'function') {
            origOnComplete.call(tx, e);
          }
        };
      }
    };
  } catch {
    // Fail-safe: ensure no unhandled error prevents transaction initialization
  }
}
