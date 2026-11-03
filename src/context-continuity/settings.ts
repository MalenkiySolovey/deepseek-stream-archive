import {
  type ContextContinuitySettings,
  DEFAULT_CONTEXT_CONTINUITY_SETTINGS,
} from './types';

export const CONTEXT_CONTINUITY_SETTINGS_STORAGE_KEY =
  'streamarchive_context_continuity_settings' as const;

/**
 * Validates and sanitizes raw input into strict ContextContinuitySettings.
 * Fails safe to default OFF settings if value is corrupt or missing.
 */
export function sanitizeContextContinuitySettings(raw: unknown): ContextContinuitySettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_CONTEXT_CONTINUITY_SETTINGS };
  }

  const obj = raw as Record<string, unknown>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : DEFAULT_CONTEXT_CONTINUITY_SETTINGS.enabled;
  const includeThinking =
    typeof obj.includeThinking === 'boolean'
      ? obj.includeThinking
      : DEFAULT_CONTEXT_CONTINUITY_SETTINGS.includeThinking;

  return {
    enabled,
    includeThinking,
  };
}

/**
 * Loads Context Continuity settings from chrome.storage.local.
 * Defaults strictly to OFF.
 */
export async function getContextContinuitySettings(): Promise<ContextContinuitySettings> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return { ...DEFAULT_CONTEXT_CONTINUITY_SETTINGS };
  }

  try {
    const res = await chrome.storage.local.get(CONTEXT_CONTINUITY_SETTINGS_STORAGE_KEY);
    return sanitizeContextContinuitySettings(res[CONTEXT_CONTINUITY_SETTINGS_STORAGE_KEY]);
  } catch (err) {
    console.warn('[StreamArchive] Failed to load context continuity settings from storage, using defaults:', err);
    return { ...DEFAULT_CONTEXT_CONTINUITY_SETTINGS };
  }
}

/**
 * Persists updated Context Continuity settings to chrome.storage.local.
 */
export async function saveContextContinuitySettings(
  partial: Partial<ContextContinuitySettings>
): Promise<ContextContinuitySettings> {
  const current = await getContextContinuitySettings();
  const next: ContextContinuitySettings = sanitizeContextContinuitySettings({
    ...current,
    ...partial,
  });

  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    try {
      await chrome.storage.local.set({
        [CONTEXT_CONTINUITY_SETTINGS_STORAGE_KEY]: next,
      });
    } catch (err) {
      console.warn('[StreamArchive] Failed to save context continuity settings to storage:', err);
    }
  }

  return next;
}
