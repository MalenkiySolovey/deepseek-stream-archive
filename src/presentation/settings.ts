/**
 * Chrome Storage Manager for Recovery Presentation Settings.
 *
 * Controls whether recovered responses appear as floating overlays / side panel cards
 * or inline directly inside the DeepSeek chat window.
 *
 * Backed by chrome.storage.local with in-memory fallback for testing environments.
 */

export type RecoveryDisplayMode = 'overlay' | 'inline';

export interface RecoveryPresentationSettings {
  displayMode: RecoveryDisplayMode;
  showThinkingInline: boolean;
}

export const DEFAULT_RECOVERY_PRESENTATION_SETTINGS: RecoveryPresentationSettings = {
  displayMode: 'overlay',
  showThinkingInline: true,
};

export const STORAGE_KEY_RECOVERY_PRESENTATION = 'streamarchive_recovery_presentation_settings';

let memoryFallback: RecoveryPresentationSettings = { ...DEFAULT_RECOVERY_PRESENTATION_SETTINGS };

function isChromeStorageAvailable(): boolean {
  return typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);
}

/**
 * Validates untrusted or loaded settings objects, falling back to safe defaults.
 */
export function validateRecoveryPresentationSettings(raw: unknown): RecoveryPresentationSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_RECOVERY_PRESENTATION_SETTINGS };
  }

  const record = raw as Record<string, unknown>;
  const validModes: RecoveryDisplayMode[] = ['overlay', 'inline'];
  const displayMode: RecoveryDisplayMode =
    typeof record.displayMode === 'string' && validModes.includes(record.displayMode as RecoveryDisplayMode)
      ? (record.displayMode as RecoveryDisplayMode)
      : DEFAULT_RECOVERY_PRESENTATION_SETTINGS.displayMode;

  const showThinkingInline =
    typeof record.showThinkingInline === 'boolean'
      ? record.showThinkingInline
      : DEFAULT_RECOVERY_PRESENTATION_SETTINGS.showThinkingInline;

  return {
    displayMode,
    showThinkingInline,
  };
}

/**
 * Retrieves the current recovery presentation settings from chrome.storage.local.
 */
export async function getRecoveryPresentationSettings(): Promise<RecoveryPresentationSettings> {
  if (!isChromeStorageAvailable()) {
    return { ...memoryFallback };
  }

  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY_RECOVERY_PRESENTATION], (items) => {
      if (chrome.runtime?.lastError) {
        return resolve({ ...DEFAULT_RECOVERY_PRESENTATION_SETTINGS });
      }

      const stored = items?.[STORAGE_KEY_RECOVERY_PRESENTATION];
      resolve(validateRecoveryPresentationSettings(stored));
    });
  });
}

/**
 * Persists updated recovery presentation settings to chrome.storage.local.
 */
export async function saveRecoveryPresentationSettings(
  patch: Partial<RecoveryPresentationSettings>
): Promise<RecoveryPresentationSettings> {
  const current = await getRecoveryPresentationSettings();
  const updated: RecoveryPresentationSettings = validateRecoveryPresentationSettings({
    ...current,
    ...patch,
  });

  if (!isChromeStorageAvailable()) {
    memoryFallback = { ...updated };
    return { ...updated };
  }

  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [STORAGE_KEY_RECOVERY_PRESENTATION]: updated }, () => {
      if (chrome.runtime?.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      resolve({ ...updated });
    });
  });
}

/**
 * Resets memory fallback for clean isolation between tests.
 */
export function resetRecoveryPresentationSettingsMemoryFallback(): void {
  memoryFallback = { ...DEFAULT_RECOVERY_PRESENTATION_SETTINGS };
}
