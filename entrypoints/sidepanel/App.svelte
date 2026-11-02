<script lang="ts">
  import ArchiveBrowser from './components/ArchiveBrowser.svelte';
  import ConversationView from './components/ConversationView.svelte';
  import DiagnosticsView from './components/DiagnosticsView.svelte';
  import { translations, type SupportedLocale } from './components/i18n';
  import {
    MESSAGE_CREATE_PORTABLE_BACKUP_SNAPSHOT,
    MESSAGE_GET_STORAGE_USAGE_ESTIMATE,
    MESSAGE_RESTORE_PREVIEW,
    MESSAGE_EXECUTE_RESTORE,
    type CreatePortableBackupSnapshotResponse,
    type GetStorageUsageEstimateResponse,
    type RestorePreviewResponse,
    type ExecuteRestoreResponse,
  } from '../../src/bridge/messages';
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

  function switchTab(tab: ActiveTab) {
    activeTab = tab;
    if (tab === 'settings') {
      loadStorageEstimate();
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
      <span class="brand-icon">📦</span>
      <h1 class="brand-title">StreamArchive</h1>
    </div>

    <nav class="tab-nav">
      <button
        class="tab-btn"
        class:active={activeTab === 'archive'}
        type="button"
        onclick={() => switchTab('archive')}
      >
        {t.tabArchive}
      </button>
      <button
        class="tab-btn"
        class:active={activeTab === 'diagnostics'}
        type="button"
        onclick={() => switchTab('diagnostics')}
      >
        {t.tabDiagnostics}
      </button>
      <button
        class="tab-btn"
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
    font-size: 1.125rem;
    line-height: 1;
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
</style>
