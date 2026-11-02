/**
 * Chrome Storage Manager for Retention & Maintenance Settings.
 *
 * Uses chrome.storage.local backed by MV3 'storage' permission.
 * Provides fallback in non-extension environments (e.g., node / vitest).
 */

import { DEFAULT_RETENTION_SETTINGS, type RetentionSettings, type RawRetentionMode } from './types';

export const STORAGE_KEY_RETENTION = 'streamarchive_retention_settings';
export const STORAGE_KEY_LAST_CLEANUP = 'streamarchive_last_automatic_cleanup';

let memoryFallback: RetentionSettings = { ...DEFAULT_RETENTION_SETTINGS };

function isChromeStorageAvailable(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

export async function getRetentionSettings(): Promise<RetentionSettings> {
  if (!isChromeStorageAvailable()) {
    return { ...memoryFallback };
  }

  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_RETENTION, STORAGE_KEY_LAST_CLEANUP], (items) => {
      if (chrome.runtime.lastError) {
        return resolve({ ...DEFAULT_RETENTION_SETTINGS });
      }

      const storedRetention = items?.[STORAGE_KEY_RETENTION] as RawRetentionMode | undefined;
      const lastCleanup = items?.[STORAGE_KEY_LAST_CLEANUP] as number | undefined;

      const validModes: RawRetentionMode[] = ['forever', '30', '90', '180'];
      const rawRetention: RawRetentionMode =
        storedRetention && validModes.includes(storedRetention)
          ? storedRetention
          : DEFAULT_RETENTION_SETTINGS.rawRetention;

      resolve({
        rawRetention,
        lastAutomaticCleanupAt: typeof lastCleanup === 'number' ? lastCleanup : undefined,
      });
    });
  });
}

export async function saveRetentionSettings(
  patch: Partial<RetentionSettings>
): Promise<RetentionSettings> {
  const current = await getRetentionSettings();
  const updated: RetentionSettings = {
    ...current,
    ...patch,
  };

  if (!isChromeStorageAvailable()) {
    memoryFallback = { ...updated };
    return { ...updated };
  }

  return new Promise((resolve, reject) => {
    const toStore: Record<string, unknown> = {};
    if (patch.rawRetention !== undefined) {
      toStore[STORAGE_KEY_RETENTION] = patch.rawRetention;
    }
    if (patch.lastAutomaticCleanupAt !== undefined) {
      toStore[STORAGE_KEY_LAST_CLEANUP] = patch.lastAutomaticCleanupAt;
    }

    chrome.storage.local.set(toStore, () => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve(updated);
    });
  });
}

export async function recordAutomaticCleanup(timestamp: number): Promise<void> {
  await saveRetentionSettings({ lastAutomaticCleanupAt: timestamp });
}

export function resetMemoryFallbackSettings(): void {
  memoryFallback = { ...DEFAULT_RETENTION_SETTINGS };
}
