/**
 * Global Storage Mutation & Generation Tracker.
 *
 * Provides monotonically increasing generation sequence / epoch tracking
 * across all write paths (messages, revisions, recovery events, raw streams,
 * raw batches, history reconciliation plans, and retention cleanups).
 *
 * Synchronizes across Extension Service Worker and Side Panel windows
 * via BroadcastChannel when available in the environment.
 */

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
 * Returns the current monotonically increasing storage mutation epoch.
 */
export function getStorageMutationEpoch(): number {
  return currentMutationEpoch;
}

/**
 * Increments the mutation epoch whenever durable storage is modified.
 * Broadcasts the new epoch to all listening extension contexts.
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
