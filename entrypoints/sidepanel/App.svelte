<script lang="ts">
  import ArchiveBrowser from './components/ArchiveBrowser.svelte';
  import ConversationView from './components/ConversationView.svelte';
  import DiagnosticsView from './components/DiagnosticsView.svelte';
  import { translations, type SupportedLocale } from './components/i18n';
  import {
    MESSAGE_CREATE_PORTABLE_BACKUP_SNAPSHOT,
    MESSAGE_GET_STORAGE_USAGE_ESTIMATE,
    type CreatePortableBackupSnapshotResponse,
    type GetStorageUsageEstimateResponse,
  } from '../../src/bridge/messages';
  import {
    buildCompressedBackup,
    PORTABLE_BACKUP_EXTENSION,
    PORTABLE_BACKUP_MIME_TYPE,
  } from '../../src/backup';
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
</style>
