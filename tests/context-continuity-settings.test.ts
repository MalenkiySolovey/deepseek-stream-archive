import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  sanitizeContextContinuitySettings,
  getContextContinuitySettings,
  saveContextContinuitySettings,
  CONTEXT_CONTINUITY_SETTINGS_STORAGE_KEY,
} from '../src/context-continuity/settings';
import { DEFAULT_CONTEXT_CONTINUITY_SETTINGS } from '../src/context-continuity/types';

describe('Context Continuity Settings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('sanitizeContextContinuitySettings', () => {
    it('returns default OFF settings for null, undefined, and invalid primitives', () => {
      expect(sanitizeContextContinuitySettings(null)).toEqual(DEFAULT_CONTEXT_CONTINUITY_SETTINGS);
      expect(sanitizeContextContinuitySettings(undefined)).toEqual(DEFAULT_CONTEXT_CONTINUITY_SETTINGS);
      expect(sanitizeContextContinuitySettings('corrupt')).toEqual(DEFAULT_CONTEXT_CONTINUITY_SETTINGS);
      expect(sanitizeContextContinuitySettings(123)).toEqual(DEFAULT_CONTEXT_CONTINUITY_SETTINGS);
    });

    it('sanitizes valid booleans and falls back to defaults for invalid types', () => {
      const sanitized = sanitizeContextContinuitySettings({
        enabled: true,
        includeThinking: 'not_a_boolean',
      });
      expect(sanitized.enabled).toBe(true);
      expect(sanitized.includeThinking).toBe(false);
    });

    it('preserves valid settings', () => {
      const valid = { enabled: true, includeThinking: true };
      expect(sanitizeContextContinuitySettings(valid)).toEqual(valid);
    });
  });

  describe('Storage Round-trip with chrome.storage.local', () => {
    it('loads defaults when chrome.storage.local is unavailable', async () => {
      (globalThis as any).chrome = undefined;
      const settings = await getContextContinuitySettings();
      expect(settings).toEqual(DEFAULT_CONTEXT_CONTINUITY_SETTINGS);
    });

    it('loads and saves settings cleanly via chrome.storage.local', async () => {
      const storageStore: Record<string, unknown> = {};

      (globalThis as any).chrome = {
        storage: {
          local: {
            get: vi.fn(async (key: string) => ({ [key]: storageStore[key] })),
            set: vi.fn(async (items: Record<string, unknown>) => {
              Object.assign(storageStore, items);
            }),
          },
        },
      };

      // 1. Initial load should be default
      const initial = await getContextContinuitySettings();
      expect(initial).toEqual(DEFAULT_CONTEXT_CONTINUITY_SETTINGS);

      // 2. Save partial change: enable = true
      const updated = await saveContextContinuitySettings({ enabled: true });
      expect(updated.enabled).toBe(true);
      expect(updated.includeThinking).toBe(false);
      expect(storageStore[CONTEXT_CONTINUITY_SETTINGS_STORAGE_KEY]).toEqual({
        enabled: true,
        includeThinking: false,
      });

      // 3. Reload from storage
      const reloaded = await getContextContinuitySettings();
      expect(reloaded).toEqual({ enabled: true, includeThinking: false });

      // 4. Save second partial change: includeThinking = true
      const secondUpdate = await saveContextContinuitySettings({ includeThinking: true });
      expect(secondUpdate).toEqual({ enabled: true, includeThinking: true });
      expect(storageStore[CONTEXT_CONTINUITY_SETTINGS_STORAGE_KEY]).toEqual({
        enabled: true,
        includeThinking: true,
      });
    });

    it('fails safely to defaults if chrome.storage throws', async () => {
      (globalThis as any).chrome = {
        storage: {
          local: {
            get: vi.fn(async () => {
              throw new Error('Storage read failure');
            }),
            set: vi.fn(async () => {
              throw new Error('Storage write failure');
            }),
          },
        },
      };

      const settings = await getContextContinuitySettings();
      expect(settings).toEqual(DEFAULT_CONTEXT_CONTINUITY_SETTINGS);
    });
  });
});
