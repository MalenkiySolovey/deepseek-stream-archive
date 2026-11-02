/**
 * Storage Observability & Persistence Truth Gate.
 *
 * Provides real browser storage estimation and storage persistence controls
 * with truthful reporting of unsupported, granted, and not_granted states.
 * No fake byte breakdowns by store.
 */

import type { StoragePersistenceStatus } from './types';

export interface StorageObservabilityResult {
  usageBytes?: number;
  quotaBytes?: number;
  percentage?: number;
  persistenceStatus: StoragePersistenceStatus;
}

export async function getStorageObservability(): Promise<StorageObservabilityResult> {
  let usageBytes: number | undefined;
  let quotaBytes: number | undefined;
  let percentage: number | undefined;
  let persistenceStatus: StoragePersistenceStatus = 'unsupported';

  // 1. Storage Estimate API
  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.estimate === 'function'
  ) {
    try {
      const estimate = await navigator.storage.estimate();
      usageBytes = estimate.usage;
      quotaBytes = estimate.quota;
      if (usageBytes !== undefined && quotaBytes !== undefined && quotaBytes > 0) {
        percentage = Number(((usageBytes / quotaBytes) * 100).toFixed(2));
      }
    } catch {
      // ignore
    }
  }

  // 2. Storage Persistence API
  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.persisted === 'function'
  ) {
    try {
      const isPersisted = await navigator.storage.persisted();
      persistenceStatus = isPersisted ? 'granted' : 'not_granted';
    } catch {
      persistenceStatus = 'error';
    }
  }

  return {
    usageBytes,
    quotaBytes,
    percentage,
    persistenceStatus,
  };
}

export async function requestStoragePersistence(): Promise<{
  granted: boolean;
  persistenceStatus: StoragePersistenceStatus;
}> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.persist === 'function'
  ) {
    try {
      const granted = await navigator.storage.persist();
      return {
        granted,
        persistenceStatus: granted ? 'granted' : 'not_granted',
      };
    } catch {
      return {
        granted: false,
        persistenceStatus: 'error',
      };
    }
  }

  return {
    granted: false,
    persistenceStatus: 'unsupported',
  };
}
