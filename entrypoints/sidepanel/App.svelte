<script lang="ts">
  import { onMount } from 'svelte';
  import ArchiveBrowser from './components/ArchiveBrowser.svelte';
  import ConversationView from './components/ConversationView.svelte';
  import DiagnosticsView from './components/DiagnosticsView.svelte';
  import { translations, type SupportedLocale } from './components/i18n';
  import {
    type RecoveryPresentationSettings,
    type RecoveryDisplayMode,
    DEFAULT_RECOVERY_PRESENTATION_SETTINGS,
    getRecoveryPresentationSettings,
    saveRecoveryPresentationSettings,
  } from '../../src/presentation/settings';
  import {
    type ContextContinuitySettings,
    DEFAULT_CONTEXT_CONTINUITY_SETTINGS,
    getContextContinuitySettings,
    saveContextContinuitySettings,
  } from '../../src/context-continuity';

  import {
    MESSAGE_CREATE_PORTABLE_BACKUP_SNAPSHOT,
    MESSAGE_GET_STORAGE_USAGE_ESTIMATE,
    MESSAGE_RESTORE_PREVIEW,
    MESSAGE_EXECUTE_RESTORE,
    MESSAGE_GET_STORAGE_MAINTENANCE_STATUS,
    MESSAGE_REQUEST_STORAGE_PERSISTENCE,
    MESSAGE_GET_RETENTION_SETTINGS,
    MESSAGE_SET_RETENTION_SETTINGS,
    MESSAGE_PREVIEW_RAW_RETENTION,
    MESSAGE_EXECUTE_RAW_RETENTION,
    MESSAGE_CLEAR_RAW_EVIDENCE,
    MESSAGE_CLEAR_ENTIRE_ARCHIVE,
    type CreatePortableBackupSnapshotResponse,
    type GetStorageUsageEstimateResponse,
    type RestorePreviewResponse,
    type ExecuteRestoreResponse,
    type GetStorageMaintenanceStatusResponse,
    type RequestStoragePersistenceResponse,
    type SetRetentionSettingsResponse,
    type PreviewRawRetentionResponse,
    type ExecuteRawRetentionResponse,
    type ClearRawEvidenceResponse,
    type ClearEntireArchiveResponse,
  } from '../../src/bridge/messages';
  import type {
    StorageMaintenanceStatus,
    RawRetentionMode,
    RawRetentionPlan,
    ArchiveCleanupResult,
  } from '../../src/storage/retention';
  import {
    buildCompressedBackup,
    PORTABLE_BACKUP_EXTENSION,
    PORTABLE_BACKUP_MIME_TYPE,
  } from '../../src/backup';
  import type { RestoreMode, RestorePreflight, RestoreResult } from '../../src/restore';
  import { formatDateUtc } from '../../src/export';
  import { saveLocalFile } from '../../src/backup/save-file';

  type ActiveTab = 'archive' | 'diagnostics' | 'settings';

  let activeTab = $state<ActiveTab>('archive');
  let selectedConversationId = $state<string | null>(null);
  let locale = $state<SupportedLocale>('en');

  let t = $derived(translations[locale]);

  // Milestone 2E.1: Backup State in Settings
  type BackupProgressState = 'idle' | 'preparing' | 'compressing' | 'saving' | 'complete' | 'error';
  let backupState = $state<BackupProgressState>('idle');
  let backupError = $state<string | null>(null);
  let storageUsageBytes = $state<number | null>(null);
  let backupSummary = $state<{
    conversations: number;
    messages: number;
    revisions: number;
    rawStreams: number;
    rawBatches: number;
    compressedBytes: number;
  } | null>(null);

  // Milestone 2E.2: Restore State in Settings
  type RestoreProgressState = 'idle' | 'reading' | 'validating' | 'ready' | 'restoring' | 'verifying' | 'complete' | 'error';
  let restoreState = $state<RestoreProgressState>('idle');
  let restoreMode = $state<RestoreMode>('replace');
  let restoreError = $state<string | null>(null);
  let restorePreflightId = $state<string | null>(null);
  let restorePreflight = $state<RestorePreflight | null>(null);
  let replaceConfirmed = $state<boolean>(false);
  let restoreResult = $state<RestoreResult | null>(null);
  let selectedBackupFileName = $state<string | null>(null);
  let cachedBackupBytes = $state<Uint8Array | null>(null);

  // Milestone 2E.3: Storage & Retention State
  let maintenanceStatus = $state<StorageMaintenanceStatus | null>(null);
  let maintenanceLoading = $state<boolean>(false);
  let maintenanceError = $state<string | null>(null);

  // Retention cleanup preview modal
  let showCleanupModal = $state<boolean>(false);
  let cleanupPlan = $state<RawRetentionPlan | null>(null);
  let cleanupLoading = $state<boolean>(false);
  let cleanupFeedback = $state<string | null>(null);

  // Purge raw evidence modal
  let showPurgeRawModal = $state<boolean>(false);
  let purgeRawLoading = $state<boolean>(false);
  let purgeRawFeedback = $state<string | null>(null);

  // Clear all archive modal
  let showClearArchiveModal = $state<boolean>(false);
  let clearArchiveConfirmed = $state<boolean>(false);
  let clearArchiveLoading = $state<boolean>(false);
  let clearArchiveFeedback = $state<string | null>(null);

  // Milestone 2D.4: Recovery Presentation State in Settings
  let recoverySettings = $state<RecoveryPresentationSettings>({ ...DEFAULT_RECOVERY_PRESENTATION_SETTINGS });

  // Milestone 2D.5A: Context Continuity Settings State
  let continuitySettings = $state<ContextContinuitySettings>({ ...DEFAULT_CONTEXT_CONTINUITY_SETTINGS });

  onMount(() => {
    loadRecoverySettings();
    loadContinuitySettings();
  });

  async function loadRecoverySettings() {
    try {
      recoverySettings = await getRecoveryPresentationSettings();
    } catch {
      // default
    }
  }

  async function loadContinuitySettings() {
    try {
      continuitySettings = await getContextContinuitySettings();
    } catch {
      // default
    }
  }

  async function handleDisplayModeChange(mode: RecoveryDisplayMode) {
    recoverySettings = { ...recoverySettings, displayMode: mode };
    await saveRecoveryPresentationSettings(recoverySettings);
  }

  async function handleShowThinkingInlineChange(show: boolean) {
    recoverySettings = { ...recoverySettings, showThinkingInline: show };
    await saveRecoveryPresentationSettings(recoverySettings);
  }

  async function handleContinuityEnabledChange(enabled: boolean) {
    continuitySettings = { ...continuitySettings, enabled };
    await saveContextContinuitySettings(continuitySettings);
  }

  async function handleContinuityIncludeThinkingChange(includeThinking: boolean) {
    continuitySettings = { ...continuitySettings, includeThinking };
    await saveContextContinuitySettings(continuitySettings);
  }

  async function handleContinuityDeliveryModeChange(deliveryMode: 'automatic' | 'manual_next') {
    continuitySettings = { ...continuitySettings, deliveryMode };
    await saveContextContinuitySettings(continuitySettings);
  }

  function switchTab(tab: ActiveTab) {
    activeTab = tab;
    if (tab === 'settings') {
      loadStorageEstimate();
      loadMaintenanceStatus();
      loadRecoverySettings();
      loadContinuitySettings();
    }
  }


  function loadMaintenanceStatus() {
    maintenanceLoading = true;
    maintenanceError = null;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        { type: MESSAGE_GET_STORAGE_MAINTENANCE_STATUS },
        (res: GetStorageMaintenanceStatusResponse) => {
          if (res && res.success && res.status) {
            maintenanceStatus = res.status;
            if (res.status.storageEstimate.usageBytes !== undefined) {
              storageUsageBytes = res.status.storageEstimate.usageBytes;
            }
          } else {
            maintenanceError = res?.error || 'Failed to load storage status';
          }
          maintenanceLoading = false;
        }
      );
    } else {
      maintenanceLoading = false;
    }
  }

  function handleRetentionModeChange(newMode: RawRetentionMode) {
    if (!maintenanceStatus) return;
    maintenanceStatus.rawRetention = newMode;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: MESSAGE_SET_RETENTION_SETTINGS,
          settings: { rawRetention: newMode },
        },
        (res: SetRetentionSettingsResponse) => {
          if (res && res.success && res.settings && maintenanceStatus) {
            maintenanceStatus.rawRetention = res.settings.rawRetention;
          }
        }
      );
    }
  }

  function handleRequestPersistence() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        { type: MESSAGE_REQUEST_STORAGE_PERSISTENCE },
        (res: RequestStoragePersistenceResponse) => {
          if (res && res.success && maintenanceStatus) {
            maintenanceStatus.persistenceStatus = res.persistenceStatus || (res.granted ? 'granted' : 'not_granted');
          }
        }
      );
    }
  }

  function handleOpenCleanupModal() {
    cleanupLoading = true;
    cleanupFeedback = null;
    cleanupPlan = null;
    showCleanupModal = true;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        {
          type: MESSAGE_PREVIEW_RAW_RETENTION,
          mode: maintenanceStatus?.rawRetention,
        },
        (res: PreviewRawRetentionResponse) => {
          cleanupLoading = false;
          if (res && res.success && res.plan) {
            cleanupPlan = res.plan;
          } else {
            cleanupFeedback = res?.error || 'Failed to build retention plan';
          }
        }
      );
    } else {
      cleanupLoading = false;
    }
  }

  function handleExecuteCleanup() {
    if (!cleanupPlan) return;
    cleanupLoading = true;
    cleanupFeedback = null;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        { type: MESSAGE_EXECUTE_RAW_RETENTION, plan: cleanupPlan },
        (res: ExecuteRawRetentionResponse) => {
          cleanupLoading = false;
          if (res && res.success && res.result) {
            cleanupFeedback = t.cleanupSuccess
              .replace('{streams}', String(res.result.deletedStreamCount))
              .replace('{batches}', String(res.result.deletedBatchCount));
            loadMaintenanceStatus();
          } else {
            cleanupFeedback = res?.error || 'Failed to execute cleanup';
          }
        }
      );
    } else {
      cleanupLoading = false;
    }
  }

  function handleExecutePurgeRaw() {
    purgeRawLoading = true;
    purgeRawFeedback = null;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        { type: MESSAGE_CLEAR_RAW_EVIDENCE },
        (res: ClearRawEvidenceResponse) => {
          purgeRawLoading = false;
          if (res && res.success) {
            purgeRawFeedback = t.purgeRawSuccess;
            loadMaintenanceStatus();
          } else {
            purgeRawFeedback = res?.error || 'Failed to purge raw evidence';
          }
        }
      );
    } else {
      purgeRawLoading = false;
    }
  }

  function handleExecuteClearArchive() {
    if (!clearArchiveConfirmed) return;
    clearArchiveLoading = true;
    clearArchiveFeedback = null;
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        { type: MESSAGE_CLEAR_ENTIRE_ARCHIVE },
        (res: ClearEntireArchiveResponse) => {
          clearArchiveLoading = false;
          if (res && res.success) {
            clearArchiveFeedback = t.clearArchiveSuccess;
            loadMaintenanceStatus();
          } else {
            clearArchiveFeedback = res?.error || 'Failed to clear archive';
          }
        }
      );
    } else {
      clearArchiveLoading = false;
    }
  }

  function toggleLanguage() {
    locale = locale === 'en' ? 'ru' : 'en';
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function loadStorageEstimate() {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        { type: MESSAGE_GET_STORAGE_USAGE_ESTIMATE },
        (res: GetStorageUsageEstimateResponse) => {
          if (res && res.success && typeof res.usageBytes === 'number') {
            storageUsageBytes = res.usageBytes;
          }
        }
      );
    }
  }

  async function handleCreateBackup() {
    backupState = 'preparing';
    backupError = null;
    backupSummary = null;

    try {
      const res = await new Promise<CreatePortableBackupSnapshotResponse>((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage(
            { type: MESSAGE_CREATE_PORTABLE_BACKUP_SNAPSHOT },
            (r) => resolve(r || { success: false, error: 'No response from background worker' })
          );
        } else {
          resolve({ success: false, error: 'Extension runtime unavailable' });
        }
      });

      if (!res.success || !res.snapshot) {
        backupState = 'error';
        backupError = res.error || 'Failed to create backup snapshot';
        return;
      }

      backupState = 'compressing';
      const compressedBytes = await buildCompressedBackup(res.snapshot);

      backupState = 'saving';
      const dateStr = formatDateUtc();
      const suggestedName = `deepseek-streamarchive-backup_${dateStr}.${PORTABLE_BACKUP_EXTENSION}`;

      const saveRes = await saveLocalFile({
        suggestedName,
        mimeType: PORTABLE_BACKUP_MIME_TYPE,
        data: compressedBytes,
        description: 'StreamArchive Backup Archive',
        extension: PORTABLE_BACKUP_EXTENSION,
      });

      if (saveRes.success) {
        backupState = 'complete';
        backupSummary = {
          conversations: res.snapshot.footer.counts.conversations,
          messages: res.snapshot.footer.counts.messages,
          revisions: res.snapshot.footer.counts.revisions,
          rawStreams: res.snapshot.footer.counts.raw_streams,
          rawBatches: res.snapshot.footer.counts.raw_stream_batches,
          compressedBytes: compressedBytes.length,
        };
      } else if (saveRes.canceled) {
        backupState = 'idle';
      } else {
        backupState = 'error';
        backupError = saveRes.error || 'Failed to save backup file';
      }
    } catch (err) {
      backupState = 'error';
      backupError = (err as Error).message;
    }
  }

  // Milestone 2E.2: Restore Functions

  async function handleFileSelected(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target?.files?.[0];
    if (!file) return;

    selectedBackupFileName = file.name;
    restoreState = 'reading';
    restoreError = null;
    restorePreflight = null;
    restorePreflightId = null;
    replaceConfirmed = false;
    restoreResult = null;

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      cachedBackupBytes = bytes;

      restoreState = 'validating';

      const arrayData = Array.from(bytes);
      const res = await new Promise<RestorePreviewResponse>((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage(
            {
              type: MESSAGE_RESTORE_PREVIEW,
              data: arrayData,
              mode: restoreMode,
            },
            (r) => resolve(r || { success: false, error: 'No response from background worker' })
          );
        } else {
          resolve({ success: false, error: 'Extension runtime unavailable' });
        }
      });

      if (!res.success || !res.preflight) {
        restoreState = 'error';
        const firstErr = res.preflight?.validationErrors?.[0]?.message;
        restoreError = res.error || firstErr || 'Failed to validate backup archive';
        return;
      }

      restorePreflight = res.preflight;
      restorePreflightId = res.preflightId || null;
      restoreState = 'ready';
    } catch (err) {
      restoreState = 'error';
      restoreError = (err as Error).message;
    }
  }

  async function handleModeChange(newMode: RestoreMode) {
    restoreMode = newMode;
    replaceConfirmed = false;
    if (cachedBackupBytes && restoreState === 'ready') {
      restoreState = 'validating';
      try {
        const arrayData = Array.from(cachedBackupBytes);
        const res = await new Promise<RestorePreviewResponse>((resolve) => {
          if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
            chrome.runtime.sendMessage(
              {
                type: MESSAGE_RESTORE_PREVIEW,
                data: arrayData,
                mode: newMode,
              },
              (r) => resolve(r || { success: false, error: 'No response from background worker' })
            );
          } else {
            resolve({ success: false, error: 'Extension runtime unavailable' });
          }
        });
        if (res.success && res.preflight) {
          restorePreflight = res.preflight;
          restorePreflightId = res.preflightId || null;
          restoreState = 'ready';
        }
      } catch (err) {
        restoreState = 'error';
        restoreError = (err as Error).message;
      }
    }
  }

  async function handleExecuteRestore() {
    if (restoreMode === 'replace' && !replaceConfirmed) {
      return;
    }

    restoreState = 'restoring';
    restoreError = null;

    try {
      const res = await new Promise<ExecuteRestoreResponse>((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          chrome.runtime.sendMessage(
            {
              type: MESSAGE_EXECUTE_RESTORE,
              preflightId: restorePreflightId,
              mode: restoreMode,
            },
            (r) => resolve(r || { success: false, error: 'No response from background worker' })
          );
        } else {
          resolve({ success: false, error: 'Extension runtime unavailable' });
        }
      });

      if (!res.success || !res.result) {
        restoreState = 'error';
        restoreError = res.error || 'Restore failed';
        return;
      }

      restoreResult = res.result;
      restoreState = 'complete';

      // Refresh data
      loadStorageEstimate();
      selectedConversationId = null;
    } catch (err) {
      restoreState = 'error';
      restoreError = (err as Error).message;
    }
  }

  function handleResetRestore() {
    restoreState = 'idle';
    restoreError = null;
    restorePreflight = null;
    restorePreflightId = null;
    replaceConfirmed = false;
    restoreResult = null;
    selectedBackupFileName = null;
    cachedBackupBytes = null;
  }

  function handleCreateSafetyBackupFirst() {
    handleCreateBackup();
  }
</script>

<div class="sidepanel-root">
  <header class="app-header">
    <div class="header-brand">
      <img class="brand-icon" src="/icons/icon-32.png" alt="StreamArchive" width="20" height="20" />
      <h1 class="brand-title">StreamArchive</h1>
    </div>

    <nav class="tab-nav">
      <button
        class="tab-btn"
        id="tab-archive"
        class:active={activeTab === 'archive'}
        type="button"
        onclick={() => switchTab('archive')}
      >
        {t.tabArchive}
      </button>
      <button
        class="tab-btn"
        id="tab-diagnostics"
        class:active={activeTab === 'diagnostics'}
        type="button"
        onclick={() => switchTab('diagnostics')}
      >
        {t.tabDiagnostics}
      </button>
      <button
        class="tab-btn"
        id="tab-settings"
        class:active={activeTab === 'settings'}
        type="button"
        onclick={() => switchTab('settings')}
      >
        {t.tabSettings}
      </button>
    </nav>

    <button
      class="locale-btn"
      type="button"
      onclick={toggleLanguage}
      title={t.languageSelect}
    >
      {locale.toUpperCase()}
    </button>
  </header>

  <main class="app-body">
    {#if activeTab === 'archive'}
      {#if selectedConversationId}
        <ConversationView
          conversationId={selectedConversationId}
          {locale}
          onBack={() => (selectedConversationId = null)}
        />
      {:else}
        <ArchiveBrowser
          {locale}
          onSelectConversation={(id) => (selectedConversationId = id)}
        />
      {/if}
    {:else if activeTab === 'diagnostics'}
      <DiagnosticsView {locale} />
    {:else if activeTab === 'settings'}
      <div class="settings-view">
        <h2 class="settings-title">{t.settingsTitle}</h2>

        <div class="settings-card">
          <label class="setting-item">
            <span class="setting-label">{t.languageSelect}</span>
            <select class="setting-select" bind:value={locale}>
              <option value="en">English (en)</option>
              <option value="ru">Русский (ru)</option>
            </select>
          </label>
        </div>

        <!-- Milestone 2D.4: Recovery Presentation Settings -->
        <div class="settings-card recovery-presentation-card">
          <h3 class="card-subtitle">🛡️ {t.recoveryPresentationTitle}</h3>
          <p class="about-desc">{t.recoveryPresentationDesc}</p>

          <div class="setting-radio-group">
            <span class="setting-label">{t.recoveryDisplayMode}</span>
            <label class="setting-radio-item">
              <input
                type="radio"
                name="recoveryDisplayMode"
                value="overlay"
                checked={recoverySettings.displayMode === 'overlay'}
                onchange={() => handleDisplayModeChange('overlay')}
              />
              <div class="radio-content">
                <strong>{t.recoveryDisplayOverlay}</strong>
                <span class="setting-hint">{t.recoveryDisplayOverlayDesc}</span>
              </div>
            </label>

            <label class="setting-radio-item">
              <input
                type="radio"
                name="recoveryDisplayMode"
                value="inline"
                checked={recoverySettings.displayMode === 'inline'}
                onchange={() => handleDisplayModeChange('inline')}
              />
              <div class="radio-content">
                <strong>{t.recoveryDisplayInline}</strong>
                <span class="setting-hint">{t.recoveryDisplayInlineDesc}</span>
              </div>
            </label>
          </div>

          {#if recoverySettings.displayMode === 'inline'}
            <div class="setting-checkbox-item">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  checked={recoverySettings.showThinkingInline}
                  onchange={(e) => handleShowThinkingInlineChange(e.currentTarget.checked)}
                />
                <span class="checkbox-text">
                  <strong>{t.recoveryShowThinkingInline}</strong>
                  <span class="setting-hint">{t.recoveryShowThinkingInlineDesc}</span>
                </span>
              </label>
            </div>
          {/if}
        </div>

        <!-- Milestone 2D.5A: Context Continuity Settings -->
        <div class="settings-card context-continuity-card">
          <div class="card-header-badge">
            <h3 class="card-subtitle">🔄 {t.contextContinuityTitle}</h3>
            <span class="experimental-pill">{t.contextContinuityExperimental}</span>
          </div>
          <p class="about-desc">{t.contextContinuityDesc}</p>

          <div class="setting-checkbox-item">
            <label class="checkbox-label" for="toggle-context-continuity">
              <input
                id="toggle-context-continuity"
                type="checkbox"
                checked={continuitySettings.enabled}
                onchange={(e) => handleContinuityEnabledChange(e.currentTarget.checked)}
              />
              <span class="checkbox-text">
                <strong>{t.enableContextContinuity}</strong>
                <span class="setting-hint">{t.contextContinuityPhaseNotice}</span>
              </span>
            </label>
          </div>

          {#if continuitySettings.enabled}
            <div class="delivery-mode-selection">
              <span class="delivery-mode-title">⚙️ {t.contextContinuityDeliveryMode}</span>
              <label class="radio-label">
                <input
                  type="radio"
                  name="continuity-delivery-mode"
                  value="manual_next"
                  checked={continuitySettings.deliveryMode === 'manual_next'}
                  onchange={() => handleContinuityDeliveryModeChange('manual_next')}
                />
                <span class="radio-text">
                  <strong>{t.deliveryModeManualNext}</strong>
                  <span class="setting-hint">{t.deliveryModeManualNextDesc}</span>
                </span>
              </label>

              <label class="radio-label">
                <input
                  type="radio"
                  name="continuity-delivery-mode"
                  value="automatic"
                  checked={continuitySettings.deliveryMode === 'automatic'}
                  onchange={() => handleContinuityDeliveryModeChange('automatic')}
                />
                <span class="radio-text">
                  <strong>{t.deliveryModeAutomatic}</strong>
                  <span class="setting-hint">{t.deliveryModeAutomaticDesc}</span>
                </span>
              </label>
            </div>

            <div class="setting-checkbox-item continuity-suboption">
              <label class="checkbox-label" for="toggle-include-thinking">
                <input
                  id="toggle-include-thinking"
                  type="checkbox"
                  checked={continuitySettings.includeThinking}
                  onchange={(e) => handleContinuityIncludeThinkingChange(e.currentTarget.checked)}
                />
                <span class="checkbox-text">
                  <strong>{t.contextContinuityIncludeThinking}</strong>
                  <span class="setting-hint">{t.contextContinuityIncludeThinkingDesc}</span>
                </span>
              </label>
            </div>
          {/if}
        </div>


        <!-- Milestone 2E.1: Data Export & Portable Backup -->
        <div class="settings-card backup-card">
          <h3 class="card-subtitle">📦 {t.backupSectionTitle}</h3>
          <p class="about-desc">{t.backupCardDesc}</p>

          {#if storageUsageBytes !== null}
            <div class="storage-estimate-badge">
              💾 <strong>{t.backupStorageUsage}:</strong> ~{formatBytes(storageUsageBytes)} ({t.backupApproximate})
            </div>
          {/if}

          <div class="backup-privacy-warning">
            <span class="warning-icon">🛡️</span>
            <div class="warning-text">
              <p>{t.backupPrivacyNotice}</p>
              <span class="backup-format-tag">{t.backupFormatInfo}</span>
            </div>
          </div>

          <div class="backup-action-row">
            <button
              class="backup-btn primary"
              type="button"
              disabled={backupState === 'preparing' || backupState === 'compressing' || backupState === 'saving'}
              onclick={handleCreateBackup}
            >
              {#if backupState === 'preparing'}
                ⏳ {t.backupPreparing}
              {:else if backupState === 'compressing'}
                🗜️ {t.backupCompressing}
              {:else if backupState === 'saving'}
                💾 {t.backupSaving}
              {:else}
                📥 {t.backupCreateBtn}
              {/if}
            </button>
          </div>

          {#if backupError}
            <div class="backup-error-banner">
              ⚠️ {backupError}
            </div>
          {/if}

          {#if backupSummary && backupState === 'complete'}
            <div class="backup-summary-box">
              <div class="summary-header">
                <span class="summary-icon">✅</span>
                <strong>{t.backupComplete}</strong>
              </div>
              <div class="summary-grid">
                <div class="summary-item">
                  <span class="summary-val">{backupSummary.conversations}</span>
                  <span class="summary-lbl">{t.backupSummaryConvs}</span>
                </div>
                <div class="summary-item">
                  <span class="summary-val">{backupSummary.messages}</span>
                  <span class="summary-lbl">{t.backupSummaryMsgs}</span>
                </div>
                <div class="summary-item">
                  <span class="summary-val">{backupSummary.revisions}</span>
                  <span class="summary-lbl">{t.backupSummaryRevs}</span>
                </div>
                <div class="summary-item">
                  <span class="summary-val">{backupSummary.rawStreams}</span>
                  <span class="summary-lbl">{t.backupSummaryStreams}</span>
                </div>
                <div class="summary-item">
                  <span class="summary-val">{backupSummary.rawBatches}</span>
                  <span class="summary-lbl">{t.backupSummaryBatches}</span>
                </div>
                <div class="summary-item">
                  <span class="summary-val">{formatBytes(backupSummary.compressedBytes)}</span>
                  <span class="summary-lbl">{t.backupSummarySize}</span>
                </div>
              </div>
            </div>
          {/if}
        </div>

        <!-- Milestone 2E.2: Restore Archive Card -->
        <div class="settings-card" id="restore-settings-card">
          <h3 class="card-subtitle">{t.restoreCardTitle}</h3>
          <p class="about-desc">{t.restoreCardDesc}</p>

          {#if restoreState === 'idle'}
            <div class="restore-picker-row">
              <label class="file-picker-label" for="backup-file-input">
                📂 {t.restoreChooseFile}
              </label>
              <input
                id="backup-file-input"
                class="hidden-file-input"
                type="file"
                accept=".streamarchive.jsonl.gz,application/gzip"
                onchange={handleFileSelected}
              />
            </div>
          {:else if restoreState === 'reading' || restoreState === 'validating'}
            <div class="restore-progress-banner" id="restore-progress-banner">
              ⏳ {restoreState === 'reading' ? t.restoreReading : t.restoreValidating}
            </div>
          {:else if restoreState === 'ready' && restorePreflight}
            <div class="restore-preview-box" id="restore-preview-box">
              <div class="preview-header">
                <span class="preview-icon">📦</span>
                <div>
                  <strong>{t.restoreValidTitle}</strong>
                  <div class="preview-filename">{selectedBackupFileName}</div>
                </div>
              </div>

              <div class="preview-meta-row">
                <span>{t.restoreCreated}: {new Date(restorePreflight.manifest.createdAt).toLocaleDateString()}</span>
                <span>{t.restoreAppVersion}: {restorePreflight.manifest.appVersion}</span>
                <span>{t.restoreDbVersion}: v{restorePreflight.manifest.sourceDatabaseVersion}</span>
              </div>

              <!-- Store Counts Comparison Table -->
              <div class="restore-counts-table">
                <div class="counts-row header-row">
                  <span>Store</span>
                  <span>{t.restoreSummaryCurrent}</span>
                  <span>{t.restoreSummaryBackup}</span>
                </div>
                <div class="counts-row">
                  <span>{t.backupSummaryConvs}</span>
                  <span>{restorePreflight.currentCounts.conversations}</span>
                  <span class="backup-val">{restorePreflight.backupCounts.conversations}</span>
                </div>
                <div class="counts-row">
                  <span>{t.backupSummaryMsgs}</span>
                  <span>{restorePreflight.currentCounts.messages}</span>
                  <span class="backup-val">{restorePreflight.backupCounts.messages}</span>
                </div>
                <div class="counts-row">
                  <span>{t.backupSummaryRevs}</span>
                  <span>{restorePreflight.currentCounts.revisions}</span>
                  <span class="backup-val">{restorePreflight.backupCounts.revisions}</span>
                </div>
                <div class="counts-row">
                  <span>{t.backupSummaryStreams}</span>
                  <span>{restorePreflight.currentCounts.raw_streams}</span>
                  <span class="backup-val">{restorePreflight.backupCounts.raw_streams}</span>
                </div>
                <div class="counts-row">
                  <span>{t.backupSummaryBatches}</span>
                  <span>{restorePreflight.currentCounts.raw_stream_batches}</span>
                  <span class="backup-val">{restorePreflight.backupCounts.raw_stream_batches}</span>
                </div>
              </div>

              <!-- Mode selector -->
              <div class="restore-mode-selector">
                <span class="mode-title">{t.restoreModeTitle}:</span>
                <label class="mode-option" class:selected={restoreMode === 'replace'}>
                  <input
                    type="radio"
                    name="restoreMode"
                    value="replace"
                    checked={restoreMode === 'replace'}
                    onchange={() => handleModeChange('replace')}
                  />
                  <div>
                    <strong>{t.restoreModeReplace}</strong>
                    <p class="mode-desc">{t.restoreModeReplaceDesc}</p>
                  </div>
                </label>
                <label class="mode-option" class:selected={restoreMode === 'merge'}>
                  <input
                    type="radio"
                    name="restoreMode"
                    value="merge"
                    checked={restoreMode === 'merge'}
                    onchange={() => handleModeChange('merge')}
                  />
                  <div>
                    <strong>{t.restoreModeMerge}</strong>
                    <p class="mode-desc">{t.restoreModeMergeDesc}</p>
                  </div>
                </label>
              </div>

              <!-- Replace Warning Box & Safety Backup -->
              {#if restoreMode === 'replace'}
                <div class="replace-warning-box">
                  <div class="warning-text">
                    <p>⚠️ {t.restoreReplaceWarning}</p>
                  </div>
                  <div class="safety-backup-action">
                    <button
                      class="backup-btn secondary"
                      type="button"
                      onclick={handleCreateSafetyBackupFirst}
                    >
                      💾 {t.restoreCreateSafetyBackup}
                    </button>
                  </div>
                  <label class="confirm-checkbox-label">
                    <input
                      type="checkbox"
                      id="confirm-replace-checkbox"
                      bind:checked={replaceConfirmed}
                    />
                    <span>{t.restoreReplaceConfirmCheck}</span>
                  </label>
                </div>
              {/if}

              <!-- Active streams warning -->
              {#if restorePreflight.activeStreamsCount > 0}
                <div class="restore-error-banner">
                  ⚠️ {t.restoreCloseActiveGeneration}
                </div>
              {/if}

              <!-- Preflight conflicts (in merge) -->
              {#if restorePreflight.plan && !restorePreflight.plan.valid}
                <div class="restore-error-banner">
                  {#each restorePreflight.plan.conflicts as c}
                    <div>⚠️ [{c.store}] {c.message}</div>
                  {/each}
                </div>
              {/if}

              <!-- Action buttons -->
              <div class="restore-actions-row">
                <button
                  class="backup-btn primary"
                  id="execute-restore-btn"
                  type="button"
                  disabled={!restorePreflight.canRestore || (restoreMode === 'replace' && !replaceConfirmed)}
                  onclick={handleExecuteRestore}
                >
                  🚀 {t.restoreBtn}
                </button>
                <button
                  class="backup-btn secondary"
                  type="button"
                  onclick={handleResetRestore}
                >
                  {t.restoreCancel}
                </button>
              </div>
            </div>
          {:else if restoreState === 'restoring' || restoreState === 'verifying'}
            <div class="restore-progress-banner" id="restore-progress-banner">
              ⏳ {restoreState === 'restoring' ? t.restoreRestoring : t.restoreVerifying}
            </div>
          {:else if restoreState === 'complete' && restoreResult}
            <div class="restore-summary-box" id="restore-summary-box">
              <div class="summary-header">
                <span class="summary-icon">✅</span>
                <strong>{t.restoreComplete}</strong>
              </div>
              <p class="reload-notice">{t.restoreReloadTabsNotice}</p>
              <div class="summary-grid">
                <div class="summary-item">
                  <span class="summary-val">{restoreResult.insertedCounts.conversations}</span>
                  <span class="summary-lbl">{t.backupSummaryConvs} (+{restoreResult.insertedCounts.conversations})</span>
                </div>
                <div class="summary-item">
                  <span class="summary-val">{restoreResult.insertedCounts.messages}</span>
                  <span class="summary-lbl">{t.backupSummaryMsgs} (+{restoreResult.insertedCounts.messages})</span>
                </div>
                <div class="summary-item">
                  <span class="summary-val">{restoreResult.insertedCounts.revisions}</span>
                  <span class="summary-lbl">{t.backupSummaryRevs} (+{restoreResult.insertedCounts.revisions})</span>
                </div>
                {#if restoreMode === 'merge'}
                  <div class="summary-item">
                    <span class="summary-val">{restoreResult.skippedCounts.conversations}</span>
                    <span class="summary-lbl">{t.restoreSummarySkipped} ({t.backupSummaryConvs})</span>
                  </div>
                  <div class="summary-item">
                    <span class="summary-val">{restoreResult.skippedCounts.messages}</span>
                    <span class="summary-lbl">{t.restoreSummarySkipped} ({t.backupSummaryMsgs})</span>
                  </div>
                  <div class="summary-item">
                    <span class="summary-val">{restoreResult.skippedCounts.revisions}</span>
                    <span class="summary-lbl">{t.restoreSummarySkipped} ({t.backupSummaryRevs})</span>
                  </div>
                {/if}
              </div>
              <div class="restore-actions-row" style="margin-top: 0.75rem;">
                <button class="backup-btn secondary" type="button" onclick={handleResetRestore}>
                  {t.refresh}
                </button>
              </div>
            </div>
          {/if}

          {#if restoreError}
            <div class="restore-error-banner" id="restore-error-banner">
              ⚠️ {restoreError}
              <div class="restore-actions-row" style="margin-top: 0.5rem;">
                <button class="backup-btn secondary" type="button" onclick={handleResetRestore}>
                  {t.restoreCancel}
                </button>
              </div>
            </div>
          {/if}
        </div>

        <!-- Milestone 2E.3: Storage & Retention Management -->
        <div class="settings-card" id="storage-management-card">
          <h3 class="card-subtitle">💾 {t.storageManagementTitle}</h3>
          <p class="about-desc">{t.storageManagementDesc}</p>

          {#if maintenanceStatus}
            <!-- Storage Usage & Quota Bar -->
            <div class="storage-stats-container">
              <div class="stat-row">
                <span class="stat-label">📊 {t.storageUsageLabel}:</span>
                <span class="stat-value">
                  {#if maintenanceStatus.storageEstimate.usageBytes !== undefined}
                    ~{formatBytes(maintenanceStatus.storageEstimate.usageBytes)}
                    {#if maintenanceStatus.storageEstimate.quotaBytes !== undefined}
                      / {formatBytes(maintenanceStatus.storageEstimate.quotaBytes)}
                    {/if}
                    {#if maintenanceStatus.storageEstimate.percentage !== undefined}
                      ({maintenanceStatus.storageEstimate.percentage}% {t.storageQuotaPercent})
                    {/if}
                  {:else}
                    N/A
                  {/if}
                </span>
              </div>

              <!-- Persistence Status Badge -->
              <div class="stat-row" style="margin-top: 0.5rem;">
                <span class="stat-label">🛡️ {t.storagePersistenceLabel}:</span>
                <div class="persistence-status-box">
                  {#if maintenanceStatus.persistenceStatus === 'granted'}
                    <span class="badge success">✓ {t.storagePersistenceGranted}</span>
                  {:else if maintenanceStatus.persistenceStatus === 'not_granted'}
                    <span class="badge warning">⚠️ {t.storagePersistenceNotGranted}</span>
                    <button
                      class="backup-btn secondary small"
                      id="request-persistence-btn"
                      type="button"
                      onclick={handleRequestPersistence}
                    >
                      {t.storageRequestPersistenceBtn}
                    </button>
                  {:else}
                    <span class="badge neutral">{t.storagePersistenceUnsupported}</span>
                  {/if}
                </div>
              </div>

              <div class="storage-approx-notice">
                ℹ️ {t.storageApproximateNotice}
              </div>

              <!-- Composition Breakdown Grid -->
              <div class="archive-composition-box">
                <h4 class="comp-title">{t.storageCanonicalVsRawTitle}</h4>
                <div class="comp-grid">
                  <div class="comp-card canonical">
                    <span class="comp-tag">{t.storageCanonicalRecords}</span>
                    <div class="comp-item">
                      <span>{t.backupSummaryConvs}:</span>
                      <strong>{maintenanceStatus.counts.conversations}</strong>
                    </div>
                    <div class="comp-item">
                      <span>{t.backupSummaryMsgs}:</span>
                      <strong>{maintenanceStatus.counts.messages}</strong>
                    </div>
                    <div class="comp-item">
                      <span>{t.backupSummaryRevs}:</span>
                      <strong>{maintenanceStatus.counts.revisions}</strong>
                    </div>
                  </div>
                  <div class="comp-card raw">
                    <span class="comp-tag">{t.storageRawRecords}</span>
                    <div class="comp-item">
                      <span>{t.backupSummaryStreams}:</span>
                      <strong>{maintenanceStatus.counts.raw_streams}</strong>
                    </div>
                    <div class="comp-item">
                      <span>{t.backupSummaryBatches}:</span>
                      <strong>{maintenanceStatus.counts.raw_stream_batches}</strong>
                    </div>
                    <div class="comp-item">
                      <span>{t.storageTotalChars}:</span>
                      <strong>{maintenanceStatus.totalRawCharacters.toLocaleString()}</strong>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <!-- Retention Policy Controls -->
            <div class="retention-policy-box">
              <h4 class="comp-title">{t.retentionSectionTitle}</h4>
              <p class="about-desc">{t.retentionSectionDesc}</p>

              <div class="retention-radio-group">
                <label class="radio-label">
                  <input
                    type="radio"
                    name="rawRetentionMode"
                    value="forever"
                    checked={maintenanceStatus.rawRetention === 'forever'}
                    onchange={() => handleRetentionModeChange('forever')}
                  />
                  <span>{t.retentionModeForever}</span>
                </label>
                <label class="radio-label">
                  <input
                    type="radio"
                    name="rawRetentionMode"
                    value="30"
                    checked={maintenanceStatus.rawRetention === '30'}
                    onchange={() => handleRetentionModeChange('30')}
                  />
                  <span>{t.retentionMode30}</span>
                </label>
                <label class="radio-label">
                  <input
                    type="radio"
                    name="rawRetentionMode"
                    value="90"
                    checked={maintenanceStatus.rawRetention === '90'}
                    onchange={() => handleRetentionModeChange('90')}
                  />
                  <span>{t.retentionMode90}</span>
                </label>
                <label class="radio-label">
                  <input
                    type="radio"
                    name="rawRetentionMode"
                    value="180"
                    checked={maintenanceStatus.rawRetention === '180'}
                    onchange={() => handleRetentionModeChange('180')}
                  />
                  <span>{t.retentionMode180}</span>
                </label>
              </div>

              <div class="retention-meta-row">
                <span class="meta-label">
                  🕒 {t.retentionLastCleanup}: {maintenanceStatus.lastAutomaticCleanupAt ? new Date(maintenanceStatus.lastAutomaticCleanupAt).toLocaleString() : t.retentionNeverCleaned}
                </span>
                {#if maintenanceStatus.rawRetention !== 'forever'}
                  <button
                    class="backup-btn secondary small"
                    id="cleanup-now-btn"
                    type="button"
                    onclick={handleOpenCleanupModal}
                  >
                    🧹 {t.retentionCleanNowBtn}
                  </button>
                {/if}
              </div>
            </div>

            <!-- Destructive Maintenance Actions -->
            <div class="destructive-actions-box">
              <div class="action-card">
                <div>
                  <strong>{t.purgeRawTitle}</strong>
                  <p class="about-desc">{t.purgeRawDesc}</p>
                </div>
                <button
                  class="backup-btn secondary warning-btn"
                  id="delete-raw-evidence-btn"
                  type="button"
                  onclick={() => { showPurgeRawModal = true; purgeRawFeedback = null; }}
                >
                  🗑️ {t.purgeRawBtn}
                </button>
              </div>

              <div class="action-card danger-card">
                <div>
                  <strong>{t.clearArchiveTitle}</strong>
                  <p class="about-desc">{t.clearArchiveDesc}</p>
                </div>
                <button
                  class="backup-btn danger"
                  id="clear-all-archive-btn"
                  type="button"
                  onclick={() => { showClearArchiveModal = true; clearArchiveConfirmed = false; clearArchiveFeedback = null; }}
                >
                  ⚠️ {t.clearArchiveBtn}
                </button>
              </div>
            </div>
          {/if}
        </div>

        <div class="settings-card">
          <h3 class="card-subtitle">{t.aboutTitle}</h3>
          <p class="about-desc">{t.aboutDesc}</p>
          <div class="invariants-list">
            <div class="invariant-item">
              <span class="inv-bullet">✓</span>
              <span><strong>Manifest MV3:</strong> storage + sidePanel strictly</span>
            </div>
            <div class="invariant-item">
              <span class="inv-bullet">✓</span>
              <span><strong>Host bounds:</strong> https://chat.deepseek.com/* strictly</span>
            </div>
            <div class="invariant-item">
              <span class="inv-bullet">✓</span>
              <span>{t.storageNotice}</span>
            </div>
          </div>
        </div>
      </div>
    {/if}

    <!-- Milestone 2E.3: Maintenance Modals -->
    {#if showCleanupModal}
      <div
        class="modal-backdrop"
        role="presentation"
        onclick={() => (showCleanupModal = false)}
        onkeydown={(e) => { if (e.key === 'Escape') showCleanupModal = false; }}
      >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="modal-card"
          id="retention-cleanup-modal"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          onclick={(e) => e.stopPropagation()}
        >
          <div class="modal-header">
            <h3 class="modal-title">🧹 {t.cleanupModalTitle}</h3>
            <button class="modal-close" type="button" onclick={() => (showCleanupModal = false)}>✕</button>
          </div>
          <div class="modal-body">
            <p class="about-desc">{t.cleanupModalDesc}</p>

            {#if cleanupLoading}
              <div class="restore-progress-banner">⏳ Loading retention plan…</div>
            {:else if cleanupPlan}
              {#if cleanupPlan.candidateStreamKeys.length === 0}
                <div class="cleanup-empty-notice">
                  ℹ️ {t.cleanupNoCandidates}
                </div>
              {:else}
                <div class="cleanup-plan-stats">
                  <div class="stat-pill">
                    <span class="pill-val">{cleanupPlan.candidateStreamKeys.length}</span>
                    <span class="pill-lbl">{t.cleanupCandidatesCount}</span>
                  </div>
                  <div class="stat-pill">
                    <span class="pill-val">{cleanupPlan.candidateBatchCount}</span>
                    <span class="pill-lbl">{t.cleanupBatchesCount}</span>
                  </div>
                  <div class="stat-pill">
                    <span class="pill-val">{cleanupPlan.protectedStreamCount}</span>
                    <span class="pill-lbl">{t.cleanupProtectedCount}</span>
                  </div>
                </div>
              {/if}
            {/if}

            {#if cleanupFeedback}
              <div class="modal-feedback-banner">
                {cleanupFeedback}
              </div>
            {/if}
          </div>
          <div class="modal-footer">
            <button
              class="backup-btn secondary"
              type="button"
              onclick={() => (showCleanupModal = false)}
              disabled={cleanupLoading}
            >
              {t.exportCancel}
            </button>
            {#if cleanupPlan && cleanupPlan.candidateStreamKeys.length > 0}
              <button
                class="backup-btn primary"
                id="confirm-cleanup-btn"
                type="button"
                onclick={handleExecuteCleanup}
                disabled={cleanupLoading}
              >
                {t.cleanupConfirmBtn}
              </button>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    {#if showPurgeRawModal}
      <div
        class="modal-backdrop"
        role="presentation"
        onclick={() => (showPurgeRawModal = false)}
        onkeydown={(e) => { if (e.key === 'Escape') showPurgeRawModal = false; }}
      >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="modal-card"
          id="purge-raw-modal"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          onclick={(e) => e.stopPropagation()}
        >
          <div class="modal-header">
            <h3 class="modal-title">🗑️ {t.purgeRawTitle}</h3>
            <button class="modal-close" type="button" onclick={() => (showPurgeRawModal = false)}>✕</button>
          </div>
          <div class="modal-body">
            <div class="modal-warning-banner">
              ⚠️ {t.purgeRawWarning}
            </div>

            <div class="safety-backup-action" style="margin-top: 1rem;">
              <button
                class="backup-btn secondary"
                type="button"
                onclick={handleCreateBackup}
                disabled={purgeRawLoading}
              >
                💾 {t.restoreCreateSafetyBackup}
              </button>
            </div>

            {#if purgeRawFeedback}
              <div class="modal-feedback-banner">
                {purgeRawFeedback}
              </div>
            {/if}
          </div>
          <div class="modal-footer">
            <button
              class="backup-btn secondary"
              type="button"
              onclick={() => (showPurgeRawModal = false)}
              disabled={purgeRawLoading}
            >
              {t.exportCancel}
            </button>
            <button
              class="backup-btn danger"
              id="confirm-purge-raw-btn"
              type="button"
              onclick={handleExecutePurgeRaw}
              disabled={purgeRawLoading}
            >
              {t.purgeRawConfirmBtn}
            </button>
          </div>
        </div>
      </div>
    {/if}

    {#if showClearArchiveModal}
      <div
        class="modal-backdrop"
        role="presentation"
        onclick={() => (showClearArchiveModal = false)}
        onkeydown={(e) => { if (e.key === 'Escape') showClearArchiveModal = false; }}
      >
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <div
          class="modal-card"
          id="clear-archive-modal"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          onclick={(e) => e.stopPropagation()}
        >
          <div class="modal-header">
            <h3 class="modal-title">⚠️ {t.clearArchiveTitle}</h3>
            <button class="modal-close" type="button" onclick={() => (showClearArchiveModal = false)}>✕</button>
          </div>
          <div class="modal-body">
            <div class="modal-danger-banner">
              🛑 {t.clearArchiveWarning}
            </div>

            <div class="safety-backup-action" style="margin-top: 1rem;">
              <button
                class="backup-btn secondary"
                type="button"
                onclick={handleCreateBackup}
                disabled={clearArchiveLoading}
              >
                💾 {t.restoreCreateSafetyBackup}
              </button>
            </div>

            <label class="confirm-checkbox-label" style="margin-top: 1rem;">
              <input
                type="checkbox"
                id="confirm-clear-archive-checkbox"
                bind:checked={clearArchiveConfirmed}
              />
              <span>{t.clearArchiveConfirmCheckbox}</span>
            </label>

            {#if clearArchiveFeedback}
              <div class="modal-feedback-banner">
                {clearArchiveFeedback}
              </div>
            {/if}
          </div>
          <div class="modal-footer">
            <button
              class="backup-btn secondary"
              type="button"
              onclick={() => (showClearArchiveModal = false)}
              disabled={clearArchiveLoading}
            >
              {t.exportCancel}
            </button>
            <button
              class="backup-btn danger"
              id="confirm-clear-archive-btn"
              type="button"
              onclick={handleExecuteClearArchive}
              disabled={!clearArchiveConfirmed || clearArchiveLoading}
            >
              {t.clearArchiveConfirmBtn}
            </button>
          </div>
        </div>
      </div>
    {/if}
  </main>
</div>

<style>
  :global(*) {
    box-sizing: border-box;
  }

  .sidepanel-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: #0b0f19;
    color: #f8fafc;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    overflow: hidden;
  }

  .app-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 0.75rem;
    background: #070a12;
    border-bottom: 1px solid #1e293b;
    gap: 0.5rem;
  }

  .header-brand {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .brand-icon {
    width: 20px;
    height: 20px;
    object-fit: contain;
    border-radius: 4px;
    flex-shrink: 0;
  }

  .brand-title {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 700;
    color: #f8fafc;
    letter-spacing: -0.02em;
  }

  .tab-nav {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background: #0f172a;
    padding: 0.15rem;
    border-radius: 0.375rem;
    border: 1px solid #1e293b;
  }

  .tab-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 0.75rem;
    font-weight: 500;
    padding: 0.25rem 0.6rem;
    border-radius: 0.25rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .tab-btn:hover {
    color: #f8fafc;
  }

  .tab-btn.active {
    background: #1e293b;
    color: #38bdf8;
    font-weight: 600;
  }

  .locale-btn {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 0.25rem;
    color: #cbd5e1;
    font-size: 0.6875rem;
    font-weight: 600;
    padding: 0.2rem 0.45rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .locale-btn:hover {
    background: #334155;
    color: #f8fafc;
  }

  .app-body {
    flex: 1;
    overflow: hidden;
    position: relative;
  }

  .settings-view {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    overflow-y: auto;
    height: 100%;
  }

  .settings-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: #f8fafc;
  }

  .settings-card {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 0.5rem;
    padding: 1rem;
  }

  .recovery-presentation-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .setting-radio-group {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .setting-radio-item {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.5rem 0.625rem;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: border-color 0.15s, background-color 0.15s;
  }

  .setting-radio-item:hover {
    border-color: #475569;
    background: #243248;
  }

  .setting-radio-item input[type='radio'] {
    margin-top: 0.1875rem;
    cursor: pointer;
    accent-color: #38bdf8;
  }

  .radio-content {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .radio-content strong {
    font-size: 0.8125rem;
    color: #f1f5f9;
  }

  .setting-hint {
    font-size: 0.71875rem;
    color: #94a3b8;
    line-height: 1.35;
  }

  .setting-checkbox-item {
    margin-top: 0.25rem;
    padding-top: 0.5rem;
    border-top: 1px dashed #334155;
  }

  .checkbox-label {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    cursor: pointer;
  }

  .checkbox-label input[type='checkbox'] {
    margin-top: 0.1875rem;
    cursor: pointer;
    accent-color: #38bdf8;
  }

  .checkbox-text {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
  }

  .checkbox-text strong {
    font-size: 0.8125rem;
    color: #f1f5f9;
  }

  .setting-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .setting-label {
    font-size: 0.8125rem;
    color: #cbd5e1;
  }

  .setting-select {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 0.25rem;
    color: #f8fafc;
    font-size: 0.75rem;
    padding: 0.25rem 0.5rem;
    outline: none;
    cursor: pointer;
  }

  .card-subtitle {
    margin: 0 0 0.5rem 0;
    font-size: 0.875rem;
    font-weight: 600;
    color: #f8fafc;
  }

  .about-desc {
    margin: 0 0 0.75rem 0;
    font-size: 0.75rem;
    color: #94a3b8;
    line-height: 1.5;
  }

  .invariants-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: #cbd5e1;
  }

  .invariant-item {
    display: flex;
    align-items: flex-start;
    gap: 0.4rem;
  }

  .inv-bullet {
    color: #34d399;
    font-weight: bold;
  }

  /* Milestone 2E.1: Backup Styles */
  .storage-estimate-badge {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 4px;
    padding: 0.35rem 0.6rem;
    font-size: 0.75rem;
    color: #e2e8f0;
    margin-bottom: 0.75rem;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }

  .backup-privacy-warning {
    background: #1e1b4b;
    border: 1px solid #4338ca;
    border-radius: 6px;
    padding: 0.65rem 0.75rem;
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.875rem;
  }

  .warning-icon {
    font-size: 1.1rem;
    flex-shrink: 0;
  }

  .warning-text p {
    margin: 0 0 0.35rem 0;
    font-size: 0.75rem;
    line-height: 1.4;
    color: #c7d2fe;
  }

  .backup-format-tag {
    display: block;
    font-size: 0.6875rem;
    color: #a5b4fc;
    font-family: monospace;
  }

  .backup-action-row {
    display: flex;
    margin-bottom: 0.5rem;
  }

  .backup-btn {
    padding: 0.45rem 0.9rem;
    border-radius: 4px;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: background 0.15s;
  }

  .backup-btn.primary {
    background: #0284c7;
    color: white;
  }

  .backup-btn.primary:hover:not(:disabled) {
    background: #0369a1;
  }

  .backup-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .backup-error-banner {
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: #450a0a;
    border: 1px solid #7f1d1d;
    border-radius: 4px;
    color: #f87171;
    font-size: 0.75rem;
  }

  .backup-summary-box {
    margin-top: 0.75rem;
    background: #064e3b;
    border: 1px solid #059669;
    border-radius: 6px;
    padding: 0.75rem;
  }

  .summary-header {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: #a7f3d0;
    font-size: 0.8125rem;
    margin-bottom: 0.5rem;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
  }

  .summary-item {
    background: rgba(0, 0, 0, 0.2);
    padding: 0.35rem;
    border-radius: 4px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .summary-val {
    font-size: 0.875rem;
    font-weight: 600;
    color: #ecfdf5;
  }

  .summary-lbl {
    font-size: 0.6875rem;
    color: #6ee7b7;
  }

  /* Milestone 2E.2: Restore Styles */
  .backup-btn.secondary {
    background: #334155;
    color: #f8fafc;
    border: 1px solid #475569;
  }

  .backup-btn.secondary:hover:not(:disabled) {
    background: #475569;
  }

  .restore-picker-row {
    margin-top: 0.5rem;
  }

  .file-picker-label {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.45rem 0.9rem;
    border-radius: 4px;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    background: #1e293b;
    border: 1px solid #3b82f6;
    color: #93c5fd;
    transition: background 0.15s;
  }

  .file-picker-label:hover {
    background: #2563eb;
    color: white;
  }

  .hidden-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    border: 0;
  }

  .restore-progress-banner {
    margin-top: 0.75rem;
    padding: 0.6rem 0.75rem;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 6px;
    font-size: 0.8125rem;
    color: #93c5fd;
  }

  .restore-preview-box {
    margin-top: 0.75rem;
    background: #131d31;
    border: 1px solid #1e3a5f;
    border-radius: 6px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .preview-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #e2e8f0;
  }

  .preview-icon {
    font-size: 1.25rem;
  }

  .preview-filename {
    font-size: 0.6875rem;
    color: #94a3b8;
    font-family: monospace;
  }

  .preview-meta-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.6875rem;
    color: #64748b;
    border-bottom: 1px solid #1e293b;
    padding-bottom: 0.5rem;
  }

  .restore-counts-table {
    display: flex;
    flex-direction: column;
    border: 1px solid #1e293b;
    border-radius: 4px;
    font-size: 0.75rem;
    overflow: hidden;
  }

  .counts-row {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr;
    padding: 0.35rem 0.6rem;
    border-bottom: 1px solid #1e293b;
    color: #cbd5e1;
  }

  .counts-row:last-child {
    border-bottom: none;
  }

  .counts-row.header-row {
    background: #0f172a;
    font-weight: 600;
    color: #94a3b8;
  }

  .backup-val {
    color: #38bdf8;
    font-weight: 500;
  }

  .restore-mode-selector {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .mode-title {
    font-size: 0.75rem;
    font-weight: 600;
    color: #e2e8f0;
  }

  .mode-option {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 0.5rem 0.6rem;
    cursor: pointer;
    font-size: 0.75rem;
  }

  .mode-option.selected {
    border-color: #38bdf8;
    background: #0b1f38;
  }

  .mode-desc {
    margin: 0.2rem 0 0 0;
    font-size: 0.6875rem;
    color: #94a3b8;
    line-height: 1.35;
  }

  .replace-warning-box {
    background: #451a03;
    border: 1px solid #b45309;
    border-radius: 6px;
    padding: 0.65rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .replace-warning-box p {
    margin: 0;
    font-size: 0.75rem;
    color: #fed7aa;
    line-height: 1.35;
  }

  .safety-backup-action {
    display: flex;
  }

  .confirm-checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    color: #fef08a;
    cursor: pointer;
    margin-top: 0.25rem;
  }

  .restore-actions-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .restore-error-banner {
    margin-top: 0.75rem;
    padding: 0.6rem 0.75rem;
    background: #450a0a;
    border: 1px solid #991b1b;
    border-radius: 6px;
    color: #fca5a5;
    font-size: 0.75rem;
    line-height: 1.4;
  }

  .restore-summary-box {
    margin-top: 0.75rem;
    background: #064e3b;
    border: 1px solid #059669;
    border-radius: 6px;
    padding: 0.75rem;
  }

  .reload-notice {
    font-size: 0.75rem;
    color: #a7f3d0;
    margin: 0 0 0.5rem 0;
  }

  /* Milestone 2D.5A: Context Continuity Styles */
  .card-header-badge {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .experimental-pill {
    padding: 0.15rem 0.45rem;
    border-radius: 9999px;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    background: rgba(168, 85, 247, 0.15);
    color: #c084fc;
    border: 1px solid rgba(168, 85, 247, 0.3);
  }

  .continuity-suboption {
    margin-left: 1.5rem;
    padding-top: 0.25rem;
  }

  .delivery-mode-selection {
    margin-left: 1.5rem;
    margin-top: 0.5rem;
    margin-bottom: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .delivery-mode-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Milestone 2E.3: Storage & Retention Management Styles */

  .storage-stats-container {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 0.75rem;
    margin-top: 0.75rem;
  }

  .stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 0.8125rem;
  }

  .stat-label {
    color: #94a3b8;
  }

  .stat-value {
    color: #e2e8f0;
    font-weight: 600;
  }

  .persistence-status-box {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .badge {
    padding: 0.2rem 0.5rem;
    border-radius: 4px;
    font-size: 0.7rem;
    font-weight: 600;
  }

  .badge.success {
    background: rgba(34, 197, 94, 0.15);
    color: #4ade80;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .badge.warning {
    background: rgba(245, 158, 11, 0.15);
    color: #fbbf24;
    border: 1px solid rgba(245, 158, 11, 0.3);
  }

  .badge.neutral {
    background: #1e293b;
    color: #94a3b8;
    border: 1px solid #334155;
  }

  .backup-btn.small {
    padding: 0.25rem 0.5rem;
    font-size: 0.72rem;
  }

  .storage-approx-notice {
    font-size: 0.7rem;
    color: #64748b;
    margin-top: 0.5rem;
    line-height: 1.35;
    border-top: 1px dashed #1e293b;
    padding-top: 0.5rem;
  }

  .archive-composition-box {
    margin-top: 0.75rem;
  }

  .comp-title {
    font-size: 0.8125rem;
    color: #cbd5e1;
    margin: 0 0 0.5rem 0;
  }

  .comp-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
  }

  .comp-card {
    background: #131d31;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .comp-tag {
    font-size: 0.6875rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #38bdf8;
    margin-bottom: 0.2rem;
  }

  .comp-card.raw .comp-tag {
    color: #a78bfa;
  }

  .comp-item {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
    color: #94a3b8;
  }

  .comp-item strong {
    color: #f1f5f9;
  }

  .retention-policy-box {
    margin-top: 1rem;
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 0.75rem;
  }

  .retention-radio-group {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .retention-meta-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 0.75rem;
    padding-top: 0.5rem;
    border-top: 1px solid #1e293b;
  }

  .meta-label {
    font-size: 0.72rem;
    color: #94a3b8;
  }

  .destructive-actions-box {
    margin-top: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .action-card {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 0.75rem;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 1rem;
  }

  .action-card.danger-card {
    border-color: rgba(239, 68, 68, 0.3);
  }

  .backup-btn.warning-btn {
    color: #fbbf24;
    border-color: rgba(245, 158, 11, 0.4);
    background: rgba(245, 158, 11, 0.1);
  }

  .backup-btn.warning-btn:hover {
    background: rgba(245, 158, 11, 0.2);
  }

  .backup-btn.danger {
    background: #dc2626;
    color: white;
    border: 1px solid #b91c1c;
  }

  .backup-btn.danger:hover:not(:disabled) {
    background: #b91c1c;
  }

  .backup-btn.danger:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Modals */
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 1rem;
  }

  .modal-card {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    width: 100%;
    max-width: 440px;
    overflow: hidden;
    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.5);
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    border-bottom: 1px solid #1e293b;
    background: #090d16;
  }

  .modal-title {
    font-size: 0.9rem;
    margin: 0;
    color: #f1f5f9;
  }

  .modal-close {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 1.1rem;
    cursor: pointer;
  }

  .modal-body {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-top: 1px solid #1e293b;
    background: #090d16;
  }

  .modal-warning-banner {
    background: rgba(245, 158, 11, 0.12);
    border: 1px solid rgba(245, 158, 11, 0.3);
    border-radius: 6px;
    padding: 0.75rem;
    color: #fde68a;
    font-size: 0.8125rem;
    line-height: 1.4;
  }

  .modal-danger-banner {
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: 6px;
    padding: 0.75rem;
    color: #fca5a5;
    font-size: 0.8125rem;
    line-height: 1.4;
    font-weight: 500;
  }

  .modal-feedback-banner {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 4px;
    padding: 0.5rem;
    color: #38bdf8;
    font-size: 0.8rem;
  }

  .cleanup-empty-notice {
    background: #1e293b;
    border-radius: 6px;
    padding: 0.75rem;
    color: #94a3b8;
    font-size: 0.8125rem;
    text-align: center;
  }

  .cleanup-plan-stats {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 0.5rem;
  }

  .stat-pill {
    background: #131d31;
    border: 1px solid #1e293b;
    border-radius: 6px;
    padding: 0.5rem;
    text-align: center;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .pill-val {
    font-size: 1.1rem;
    font-weight: 700;
    color: #38bdf8;
  }

  .pill-lbl {
    font-size: 0.6875rem;
    color: #94a3b8;
  }
</style>
