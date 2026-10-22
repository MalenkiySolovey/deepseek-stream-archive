<script lang="ts">
  import ArchiveBrowser from './components/ArchiveBrowser.svelte';
  import ConversationView from './components/ConversationView.svelte';
  import DiagnosticsView from './components/DiagnosticsView.svelte';
  import { translations, type SupportedLocale } from './components/i18n';

  type ActiveTab = 'archive' | 'diagnostics' | 'settings';

  let activeTab = $state<ActiveTab>('archive');
  let selectedConversationId = $state<string | null>(null);
  let locale = $state<SupportedLocale>('en');

  let t = $derived(translations[locale]);

  function switchTab(tab: ActiveTab) {
    activeTab = tab;
    if (tab === 'archive') {
      // Stay on current conversation or list
    }
  }

  function toggleLanguage() {
    locale = locale === 'en' ? 'ru' : 'en';
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
</style>
