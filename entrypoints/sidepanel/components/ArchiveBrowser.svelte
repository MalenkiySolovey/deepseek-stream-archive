<script lang="ts">
  import { onMount } from 'svelte';
  import {
    MESSAGE_LIST_ARCHIVE_CONVERSATIONS,
    type ListArchiveConversationsRequest,
    type ListArchiveConversationsResponse,
  } from '../../../src/bridge/messages';
  import type {
    ArchiveConversationSummary,
    PaginatedArchiveConversations,
  } from '../../../src/core/contracts';
  import { translations, type SupportedLocale } from './i18n';

  interface Props {
    locale: SupportedLocale;
    onSelectConversation: (id: string) => void;
  }

  let { locale, onSelectConversation } = $props<Props>();

  let t = $derived(translations[locale]);
  let items = $state<ArchiveConversationSummary[]>([]);
  let totalCount = $state<number>(0);
  let nextCursor = $state<string | undefined>(undefined);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let searchQuery = $state<string>('');

  let filteredItems = $derived<ArchiveConversationSummary[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(
      (c) =>
        c.title.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (c.remoteId && c.remoteId.toLowerCase().includes(q))
    );
  });

  onMount(() => {
    loadInitial();
  });

  async function loadInitial() {
    loading = true;
    error = null;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const req: ListArchiveConversationsRequest = {
          type: MESSAGE_LIST_ARCHIVE_CONVERSATIONS,
          options: { limit: 20 },
        };
        const res = await chrome.runtime.sendMessage<
          ListArchiveConversationsRequest,
          ListArchiveConversationsResponse
        >(req);
        if (res && res.success && res.data) {
          items = res.data.items;
          totalCount = res.data.totalCount;
          nextCursor = res.data.nextCursor;
        } else {
          error = res?.error || 'Failed to list conversations';
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const req: ListArchiveConversationsRequest = {
          type: MESSAGE_LIST_ARCHIVE_CONVERSATIONS,
          options: { limit: 20, cursor: nextCursor },
        };
        const res = await chrome.runtime.sendMessage<
          ListArchiveConversationsRequest,
          ListArchiveConversationsResponse
        >(req);
        if (res && res.success && res.data) {
          items = [...items, ...res.data.items];
          nextCursor = res.data.nextCursor;
        }
      }
    } catch {
      // ignore
    } finally {
      loadingMore = false;
    }
  }

  function formatDate(ts: number): string {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toLocaleDateString(locale)} ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}`;
  }
</script>

<div class="archive-browser">
  <div class="browser-header">
    <div class="header-top">
      <div class="title-wrap">
        <h2 class="section-title">{t.conversationsTitle}</h2>
        <span class="count-badge">{totalCount} {t.totalConversations}</span>
      </div>
      <button class="refresh-btn" type="button" onclick={loadInitial} title={t.refresh}>
        ↻ {t.refresh}
      </button>
    </div>

    <div class="search-wrap">
      <input
        class="search-input"
        type="text"
        bind:value={searchQuery}
        placeholder={t.searchPlaceholder}
      />
      {#if searchQuery}
        <button class="clear-search-btn" type="button" onclick={() => (searchQuery = '')}>
          ×
        </button>
      {/if}
    </div>
  </div>

  {#if loading}
    <div class="loading-state">
      <div class="spinner"></div>
      <span>{t.loading}</span>
    </div>
  {:else if error}
    <div class="error-banner">
      <strong>Error:</strong> {error}
    </div>
  {:else if filteredItems().length === 0}
    <div class="empty-state">
      <div class="empty-icon">📂</div>
      <div class="empty-title">{t.emptyConversations}</div>
      <div class="empty-desc">{t.emptyConversationsSub}</div>
    </div>
  {:else}
    <div class="conversations-list">
      {#each filteredItems() as item (item.id)}
        <button
          class="conversation-card"
          type="button"
          onclick={() => onSelectConversation(item.id)}
        >
          <div class="card-main">
            <div class="card-title-row">
              <span class="card-title">{item.title}</span>
              {#if item.recoveredCount > 0 || item.hasDegraded}
                <span class="recovery-shield-badge" title={t.hasFiltered}>
                  🛡️ {item.recoveredCount > 0 ? item.recoveredCount : ''}
                </span>
              {/if}
            </div>

            <div class="card-meta-row">
              <span class="meta-date">{formatDate(item.updatedAt)}</span>
              <span class="meta-dot">•</span>
              <span class="meta-messages">{item.messageCount} {t.messagesCount}</span>
              {#if item.remoteId}
                <span class="meta-dot">•</span>
                <span class="meta-remote">Remote</span>
              {/if}
            </div>
          </div>
          <span class="arrow-indicator">›</span>
        </button>
      {/each}

      {#if nextCursor}
        <div class="pagination-footer">
          <button
            class="load-more-btn"
            type="button"
            disabled={loadingMore}
            onclick={loadMore}
          >
            {loadingMore ? '...' : t.loadMore}
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .archive-browser {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }

  .browser-header {
    padding: 0.75rem 1rem;
    background: #090d16;
    border-bottom: 1px solid #1e293b;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .header-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .title-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .section-title {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
    color: #f8fafc;
  }

  .count-badge {
    background: #1e293b;
    color: #94a3b8;
    font-size: 0.6875rem;
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
  }

  .refresh-btn {
    background: transparent;
    border: 1px solid #334155;
    border-radius: 0.25rem;
    color: #94a3b8;
    font-size: 0.6875rem;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .refresh-btn:hover {
    background: #1e293b;
    color: #f8fafc;
  }

  .search-wrap {
    position: relative;
    display: flex;
    align-items: center;
  }

  .search-input {
    width: 100%;
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 0.375rem;
    padding: 0.35rem 1.75rem 0.35rem 0.6rem;
    font-size: 0.8125rem;
    color: #f8fafc;
    outline: none;
    transition: border-color 0.15s;
  }

  .search-input:focus {
    border-color: #38bdf8;
  }

  .search-input::placeholder {
    color: #64748b;
  }

  .clear-search-btn {
    position: absolute;
    right: 0.4rem;
    background: transparent;
    border: none;
    color: #64748b;
    font-size: 1rem;
    cursor: pointer;
    line-height: 1;
  }

  .loading-state,
  .empty-state {
    padding: 3rem 1rem;
    text-align: center;
    color: #94a3b8;
  }

  .empty-icon {
    font-size: 2rem;
    margin-bottom: 0.5rem;
  }

  .empty-title {
    font-size: 0.875rem;
    font-weight: 600;
    color: #cbd5e1;
  }

  .empty-desc {
    font-size: 0.75rem;
    color: #64748b;
    margin-top: 0.25rem;
    max-width: 260px;
    margin-left: auto;
    margin-right: auto;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 2px solid #1e293b;
    border-top-color: #38bdf8;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    margin: 0 auto 0.75rem auto;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-banner {
    margin: 1rem;
    padding: 0.75rem 1rem;
    background: #450a0a;
    border: 1px solid #7f1d1d;
    border-radius: 0.375rem;
    color: #fca5a5;
    font-size: 0.8125rem;
  }

  .conversations-list {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .conversation-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 0.875rem;
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 0.375rem;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s;
    outline: none;
  }

  .conversation-card:hover {
    background: #1e293b;
    border-color: #334155;
    transform: translateY(-1px);
  }

  .card-main {
    flex: 1;
    min-width: 0;
  }

  .card-title-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .card-title {
    font-size: 0.84375rem;
    font-weight: 500;
    color: #f8fafc;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .recovery-shield-badge {
    background: rgba(16, 185, 129, 0.15);
    border: 1px solid #059669;
    border-radius: 0.25rem;
    padding: 0.05rem 0.3rem;
    font-size: 0.6875rem;
    color: #34d399;
    white-space: nowrap;
  }

  .card-meta-row {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.6875rem;
    color: #64748b;
  }

  .meta-remote {
    color: #a78bfa;
  }

  .arrow-indicator {
    color: #475569;
    font-size: 1.125rem;
    font-weight: bold;
    padding-left: 0.5rem;
  }

  .conversation-card:hover .arrow-indicator {
    color: #38bdf8;
  }

  .pagination-footer {
    padding: 0.5rem 0;
    text-align: center;
  }

  .load-more-btn {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 0.25rem;
    color: #38bdf8;
    font-size: 0.75rem;
    padding: 0.35rem 1rem;
    cursor: pointer;
  }

  .load-more-btn:hover {
    background: #334155;
    color: #7dd3fc;
  }
</style>
