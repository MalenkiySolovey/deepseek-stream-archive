import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_RECOVERY_PRESENTATION_SETTINGS,
  getRecoveryPresentationSettings,
  saveRecoveryPresentationSettings,
  validateRecoveryPresentationSettings,
  resetRecoveryPresentationSettingsMemoryFallback,
} from '../src/presentation/settings';

describe('Recovery Presentation Settings Engine', () => {
  beforeEach(() => {
    resetRecoveryPresentationSettingsMemoryFallback();
  });

  it('provides safe default settings (overlay by default, thinking ON)', async () => {
    const settings = await getRecoveryPresentationSettings();
    expect(settings).toEqual({
      displayMode: 'overlay',
      inlinePlacement: 'underneath',
      showThinkingInline: true,
    });
  });

  it('updates displayMode to inline and back to overlay', async () => {
    const updated = await saveRecoveryPresentationSettings({ displayMode: 'inline' });
    expect(updated.displayMode).toBe('inline');

    const reloaded = await getRecoveryPresentationSettings();
    expect(reloaded.displayMode).toBe('inline');
    expect(reloaded.showThinkingInline).toBe(true);

    const reverted = await saveRecoveryPresentationSettings({ displayMode: 'overlay' });
    expect(reverted.displayMode).toBe('overlay');
  });

  it('updates inlinePlacement toggle between underneath and replace', async () => {
    const updated = await saveRecoveryPresentationSettings({ inlinePlacement: 'replace' });
    expect(updated.inlinePlacement).toBe('replace');

    const reloaded = await getRecoveryPresentationSettings();
    expect(reloaded.inlinePlacement).toBe('replace');

    const reverted = await saveRecoveryPresentationSettings({ inlinePlacement: 'underneath' });
    expect(reverted.inlinePlacement).toBe('underneath');
  });

  it('updates showThinkingInline boolean toggle', async () => {
    const updated = await saveRecoveryPresentationSettings({ showThinkingInline: false });
    expect(updated.showThinkingInline).toBe(false);

    const reloaded = await getRecoveryPresentationSettings();
    expect(reloaded.showThinkingInline).toBe(false);
  });

  it('validates corrupted and unknown settings values, falling back to safe defaults', () => {
    expect(validateRecoveryPresentationSettings(null)).toEqual(DEFAULT_RECOVERY_PRESENTATION_SETTINGS);
    expect(validateRecoveryPresentationSettings(undefined)).toEqual(DEFAULT_RECOVERY_PRESENTATION_SETTINGS);
    expect(validateRecoveryPresentationSettings('invalid')).toEqual(DEFAULT_RECOVERY_PRESENTATION_SETTINGS);
    expect(validateRecoveryPresentationSettings({ displayMode: 'hack_mode', showThinkingInline: 'not_a_bool' })).toEqual({
      displayMode: 'overlay',
      inlinePlacement: 'underneath',
      showThinkingInline: true,
    });
  });
});
