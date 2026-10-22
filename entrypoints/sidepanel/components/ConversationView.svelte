<script lang="ts">
  import { onMount } from 'svelte';
  import {
    MESSAGE_GET_ARCHIVE_CONVERSATION,
    MESSAGE_GET_REVISION_CONTENT,
    type GetArchiveConversationRequest,
    type GetArchiveConversationResponse,
    type GetRevisionContentRequest,
    type GetRevisionContentResponse,
  } from '../../../src/bridge/messages';
  import type {
    ArchiveConversationDetail,
    ArchiveMessageSummary,
    ArchiveRevisionMetadata,
  } from '../../../src/core/contracts';
  import type { ResponseRevision } from '../../../src/core/models';
  import SafeMarkdown from './SafeMarkdown.svelte';
  import { translations, type SupportedLocale } from './i18n';

  interface Props {
    conversationId: string;
    locale: SupportedLocale;
    onBack: () => void;
  }

  let { conversationId, locale, onBack } = $props<Props>();

  let t = $derived(translations[locale]);
  let detail = $state<ArchiveConversationDetail | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  // Active revision override per message (if user clicked a timeline revision)
  let activeRevisions = $state<Record<string, { text: string; thinking?: string; id: string }>>({});
  // Revisions history drawer toggle per message
  let expandedRevisionDrawers = $state<Record<string, boolean>>({});
  // Copied feedback per message
  let copiedId = $state<string | null>(null);

  // Branch index per parent grouping
  let branchSelections = $state<Record<string, number>>({});

  onMount(() => {
    loadConversation();
  });

  async function loadConversation() {
    loading = true;
    error = null;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const req: GetArchiveConversationRequest = {
          type: MESSAGE_GET_ARCHIVE_CONVERSATION,
          conversationId,
        };
        const res = await chrome.runtime.sendMessage<
          GetArchiveConversationRequest,
          GetArchiveConversationResponse
        >(req);
        if (res && res.success && res.data) {
          detail = res.data;
        } else {
          error = res?.error || 'Failed to load conversation details';
        }
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      loading = false;
    }
  }

  // Branching grouping: group siblings by parentId/remoteParentId
  interface SiblingGroup {
    parentKey: string;
    messages: ArchiveMessageSummary[];
  }

  let visibleMessages = $derived<ArchiveMessageSummary[]>(() => {
    if (!detail) return [];
    const all = detail.messages;

    // Group siblings by parentId (or root)
    const groups = new Map<string, ArchiveMessageSummary[]>();
    for (const msg of all) {
      const parentKey = msg.parentId || msg.remoteParentId || '__root__';
      if (!groups.has(parentKey)) {
        groups.set(parentKey, []);
      }
      groups.get(parentKey)!.push(msg);
    }

    // Filter to selected branch per group
    const result: ArchiveMessageSummary[] = [];
    for (const msg of all) {
      const parentKey = msg.parentId || msg.remoteParentId || '__root__';
      const siblings = groups.get(parentKey)!;
      if (siblings.length > 1) {
        const activeIdx = branchSelections[parentKey] ?? 0;
        if (siblings[activeIdx]?.id === msg.id) {
          result.push(msg);
        }
      } else {
        result.push(msg);
      }
    }

    return result;
  });

  function getSiblingInfo(msg: ArchiveMessageSummary) {
    if (!detail) return { count: 1, current: 1, key: '' };
    const parentKey = msg.parentId || msg.remoteParentId || '__root__';
    const siblings = detail.messages.filter(
      (m) => (m.parentId || m.remoteParentId || '__root__') === parentKey
    );
    const activeIdx = branchSelections[parentKey] ?? 0;
    return {
      count: siblings.length,
      current: activeIdx + 1,
      key: parentKey,
    };
  }

  function switchBranch(key: string, delta: number, total: number) {
    const current = branchSelections[key] ?? 0;
    const next = (current + delta + total) % total;
    branchSelections[key] = next;
  }

  function getActiveContent(msg: ArchiveMessageSummary): { text: string; thinking?: string } {
    if (activeRevisions[msg.id]) {
      return activeRevisions[msg.id]!;
    }
    if (msg.preferredRevision) {
      return {
        text: msg.preferredRevision.text,
        thinking: msg.preferredRevision.thinking,
      };
    }
    return {
      text: msg.content || '',
      thinking: undefined,
    };
  }

  async function selectRevision(msgId: string, revMeta: ArchiveRevisionMetadata) {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const req: GetRevisionContentRequest = {
          type: MESSAGE_GET_REVISION_CONTENT,
          revisionId: revMeta.id,
        };
        const res = await chrome.runtime.sendMessage<
          GetRevisionContentRequest,
          GetRevisionContentResponse
        >(req);
        if (res && res.success && res.data) {
          activeRevisions[msgId] = {
            id: revMeta.id,
            text: res.data.text,
            thinking: res.data.thinking,
          };
        }
      }
    } catch {
      // ignore
    }
  }

  function toggleRevisionsDrawer(msgId: string) {
    expandedRevisionDrawers[msgId] = !expandedRevisionDrawers[msgId];
  }

  async function copyToClipboard(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedId = id;
      setTimeout(() => {
        if (copiedId === id) {
          copiedId = null;
        }
      }, 2000);
    } catch {
      // ignore
    }
  }

  function formatDate(ts: number): string {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toLocaleDateString(locale)} ${d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  }
</script>

<div class="conversation-view">
  <div class="view-header">
    <button class="back-btn" type="button" onclick={onBack}>
      ← {t.backToList}
    </button>
    <div class="header-titles">
      <h2 class="convo-title">{detail?.conversation.title || t.conversationDetail}</h2>
      <div class="convo-meta">
        <span class="meta-item">ID: {detail?.conversation.id.slice(0, 16)}</span>
        {#if detail?.conversation.remoteId}
          <span class="meta-item remote">Remote: {detail.conversation.remoteId}</span>
        {/if}
        <span class="meta-item">{detail?.messages.length || 0} {t.messagesCount}</span>
      </div>
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
  {:else if !detail || detail.messages.length === 0}
    <div class="empty-state">
      <p>{t.noMessages}</p>
    </div>
  {:else}
    <div class="messages-thread">
      {#each visibleMessages() as msg (msg.id)}
        {@const branchInfo = getSiblingInfo(msg)}
        {@const activeData = getActiveContent(msg)}
        {@const isAssistant = msg.role === 'assistant'}
        {@const lastGoodRev = msg.preferredRevision?.isLastGood ? msg.preferredRevision : undefined}

        <div class="message-card" class:assistant={isAssistant} class:user={!isAssistant}>
          <div class="message-header">
            <div class="role-wrapper">
              <span class="role-badge" class:asst={isAssistant} class:usr={!isAssistant}>
                {isAssistant ? t.roleAssistant : t.roleUser}
              </span>
              {#if isAssistant}
                <span class="status-pill status-{msg.status}">
                  {msg.status}
                </span>
                <span class="identity-pill" class:reconciled={msg.identityState === 'reconciled'}>
                  {msg.identityState === 'reconciled' ? t.reconciled : t.provisional}
                </span>
              {/if}
            </div>

            <div class="header-actions">
              {#if branchInfo.count > 1}
                <div class="branch-controls">
                  <span class="branch-label">{t.branchXofY} {branchInfo.current} {t.of} {branchInfo.count}</span>
                  <button
                    class="branch-nav-btn"
                    type="button"
                    title={t.prevBranch}
                    onclick={() => switchBranch(branchInfo.key, -1, branchInfo.count)}
                  >
                    ‹
                  </button>
                  <button
                    class="branch-nav-btn"
                    type="button"
                    title={t.nextBranch}
                    onclick={() => switchBranch(branchInfo.key, 1, branchInfo.count)}
                  >
                    ›
                  </button>
                </div>
              {/if}

              <button
                class="copy-btn"
                type="button"
                onclick={() => copyToClipboard(activeData.text, msg.id)}
              >
                {copiedId === msg.id ? t.copiedText : t.copyText}
              </button>
            </div>
          </div>

          {#if msg.remoteParentId && !msg.parentId}
            <div class="unresolved-parent-notice">
              ⚠️ {t.unresolvedParent} ({msg.remoteParentId})
            </div>
          {/if}

          <!-- Recovery Preview Card for Filtered / Censored Messages -->
          {#if isAssistant && (msg.status === 'filtered' || msg.recoveryEvents.length > 0 || lastGoodRev)}
            <div class="recovery-preview-card">
              <div class="recovery-card-header">
                <span class="recovery-icon">🛡️</span>
                <div class="recovery-card-text">
                  <div class="recovery-card-title">{t.recoveryCardTitle}</div>
                  <div class="recovery-card-desc">{t.recoveryCardDesc}</div>
                </div>
                {#if lastGoodRev}
                  <button
                    class="copy-recovery-btn"
                    type="button"
                    onclick={() => copyToClipboard(lastGoodRev.text, `rec_${msg.id}`)}
                  >
                    {copiedId === `rec_${msg.id}` ? t.copiedText : t.copyPreservedText}
                  </button>
                {/if}
              </div>

              {#if lastGoodRev}
                <div class="recovered-text-box">
                  <div class="recovered-text-label">{t.lastGoodBadge} ({lastGoodRev.text.length} chars):</div>
                  <SafeMarkdown content={lastGoodRev.text} />
                </div>
              {/if}
            </div>
          {/if}

          <!-- Thinking block -->
          {#if isAssistant && activeData.thinking}
            <details class="thinking-details">
              <summary class="thinking-summary">
                💭 {t.thinkingTitle} ({activeData.thinking.length} {t.thinkingChars})
              </summary>
              <div class="thinking-content">
                <SafeMarkdown content={activeData.thinking} />
              </div>
            </details>
          {/if}

          <!-- Response text -->
          <div class="message-content">
            <SafeMarkdown content={activeData.text} />
          </div>

          <!-- Revision history drawer for assistant -->
          {#if isAssistant && msg.revisions.length > 0}
            <div class="revisions-section">
              <button
                class="toggle-revisions-btn"
                type="button"
                onclick={() => toggleRevisionsDrawer(msg.id)}
              >
                <span>{t.revisionsTitle} ({msg.revisions.length})</span>
                <span class="drawer-arrow">{expandedRevisionDrawers[msg.id] ? '▲' : '▼'}</span>
              </button>

              {#if expandedRevisionDrawers[msg.id]}
                <div class="revisions-list">
                  {#each msg.revisions as revMeta}
                    {@const isActive = (activeRevisions[msg.id]?.id || msg.preferredRevision?.id) === revMeta.id}
                    <div class="revision-item" class:active={isActive}>
                      <div class="rev-left">
                        <span class="rev-idx">#{revMeta.revisionIndex}</span>
                        <span class="rev-source source-{revMeta.source}">{revMeta.source}</span>
                        {#if revMeta.isLastGood}
                          <span class="rev-badge last-good">{t.lastGoodBadge}</span>
                        {/if}
                        {#if revMeta.isFinal}
                          <span class="rev-badge final">{t.finalBadge}</span>
                        {/if}
                        <span class="rev-time">{formatDate(revMeta.capturedAt)}</span>
                        <span class="rev-len">{revMeta.textLength} chars</span>
                      </div>
                      <div class="rev-right">
                        {#if isActive}
                          <span class="active-tag">✓ {t.activeRevision}</span>
                        {:else}
                          <button
                            class="view-rev-btn"
                            type="button"
                            onclick={() => selectRevision(msg.id, revMeta)}
                          >
                            {t.viewRevision}
                          </button>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .conversation-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow-y: auto;
  }

  .view-header {
    padding: 0.75rem 1rem;
    background: #090d16;
    border-bottom: 1px solid #1e293b;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .back-btn {
    background: transparent;
    border: none;
    color: #38bdf8;
    font-size: 0.8125rem;
    padding: 0;
    margin-bottom: 0.5rem;
    cursor: pointer;
    display: flex;
    align-items: center;
  }

  .back-btn:hover {
    text-decoration: underline;
  }

  .convo-title {
    margin: 0 0 0.25rem 0;
    font-size: 1rem;
    font-weight: 600;
    color: #f8fafc;
  }

  .convo-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: #94a3b8;
  }

  .meta-item.remote {
    color: #a78bfa;
  }

  .loading-state,
  .empty-state {
    padding: 3rem 1rem;
    text-align: center;
    color: #94a3b8;
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

  .messages-thread {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .message-card {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 0.5rem;
    padding: 0.875rem 1rem;
  }

  .message-card.user {
    background: #121c2f;
    border-color: #1e3a5f;
  }

  .message-card.assistant {
    background: #0d1527;
    border-color: #1e293b;
  }

  .message-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.75rem;
    font-size: 0.75rem;
  }

  .role-wrapper {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .role-badge {
    padding: 0.15rem 0.5rem;
    border-radius: 0.25rem;
    font-weight: 600;
  }

  .role-badge.asst {
    background: #1e293b;
    color: #38bdf8;
  }

  .role-badge.usr {
    background: #1e3a8a;
    color: #93c5fd;
  }

  .status-pill {
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    font-size: 0.6875rem;
    text-transform: lowercase;
  }

  .status-pill.status-finished {
    background: #064e3b;
    color: #6ee7b7;
  }

  .status-pill.status-streaming {
    background: #713f12;
    color: #fde047;
  }

  .status-pill.status-filtered {
    background: #7f1d1d;
    color: #fca5a5;
  }

  .status-pill.status-degraded,
  .status-pill.status-interrupted {
    background: #4c1d95;
    color: #c4b5fd;
  }

  .identity-pill {
    padding: 0.1rem 0.4rem;
    border-radius: 0.25rem;
    font-size: 0.6875rem;
    background: #1e293b;
    color: #94a3b8;
  }

  .identity-pill.reconciled {
    background: #14532d;
    color: #86efac;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .branch-controls {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background: #1e293b;
    padding: 0.1rem 0.35rem;
    border-radius: 0.25rem;
  }

  .branch-label {
    font-size: 0.6875rem;
    color: #cbd5e1;
  }

  .branch-nav-btn {
    background: transparent;
    border: none;
    color: #38bdf8;
    font-size: 0.875rem;
    font-weight: bold;
    cursor: pointer;
    padding: 0 0.25rem;
    line-height: 1;
  }

  .branch-nav-btn:hover {
    color: #7dd3fc;
  }

  .copy-btn {
    background: transparent;
    border: 1px solid #334155;
    border-radius: 0.25rem;
    color: #94a3b8;
    font-size: 0.6875rem;
    padding: 0.15rem 0.45rem;
    cursor: pointer;
    transition: all 0.15s;
  }

  .copy-btn:hover {
    background: #1e293b;
    color: #f8fafc;
  }

  .unresolved-parent-notice {
    margin-bottom: 0.75rem;
    font-size: 0.75rem;
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.1);
    padding: 0.35rem 0.6rem;
    border-radius: 0.25rem;
  }

  /* Recovery Preview Card */
  .recovery-preview-card {
    margin: 0.75rem 0;
    padding: 0.75rem;
    background: rgba(16, 185, 129, 0.08);
    border: 1px solid #059669;
    border-radius: 0.375rem;
  }

  .recovery-card-header {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .recovery-icon {
    font-size: 1.125rem;
    line-height: 1;
  }

  .recovery-card-text {
    flex: 1;
  }

  .recovery-card-title {
    font-weight: 600;
    color: #34d399;
    font-size: 0.8125rem;
  }

  .recovery-card-desc {
    color: #a7f3d0;
    font-size: 0.75rem;
    margin-top: 0.15rem;
  }

  .copy-recovery-btn {
    background: #065f46;
    border: 1px solid #10b981;
    border-radius: 0.25rem;
    color: #ecfdf5;
    font-size: 0.7rem;
    padding: 0.25rem 0.6rem;
    cursor: pointer;
    font-weight: 500;
    white-space: nowrap;
  }

  .copy-recovery-btn:hover {
    background: #047857;
  }

  .recovered-text-box {
    margin-top: 0.5rem;
    padding: 0.5rem;
    background: #064e3b;
    border-radius: 0.25rem;
    font-size: 0.8125rem;
  }

  .recovered-text-label {
    font-size: 0.6875rem;
    color: #a7f3d0;
    margin-bottom: 0.35rem;
    font-weight: 600;
  }

  /* Thinking Box */
  .thinking-details {
    margin: 0.75rem 0;
    border: 1px solid #312e81;
    border-radius: 0.375rem;
    background: rgba(49, 46, 129, 0.2);
    overflow: hidden;
  }

  .thinking-summary {
    padding: 0.35rem 0.65rem;
    font-size: 0.75rem;
    font-weight: 500;
    color: #a5b4fc;
    cursor: pointer;
    user-select: none;
    outline: none;
  }

  .thinking-summary:hover {
    background: rgba(49, 46, 129, 0.4);
  }

  .thinking-content {
    padding: 0.5rem 0.75rem;
    border-top: 1px solid #312e81;
    font-size: 0.8125rem;
    color: #c7d2fe;
    font-style: italic;
  }

  /* Revisions Section */
  .revisions-section {
    margin-top: 0.75rem;
    padding-top: 0.5rem;
    border-top: 1px dashed #1e293b;
  }

  .toggle-revisions-btn {
    background: transparent;
    border: none;
    color: #64748b;
    font-size: 0.6875rem;
    padding: 0;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .toggle-revisions-btn:hover {
    color: #94a3b8;
  }

  .drawer-arrow {
    font-size: 0.6rem;
  }

  .revisions-list {
    margin-top: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }

  .revision-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.35rem 0.5rem;
    background: #090d16;
    border: 1px solid #1e293b;
    border-radius: 0.25rem;
    font-size: 0.6875rem;
  }

  .revision-item.active {
    border-color: #0284c7;
    background: #0c1a2e;
  }

  .rev-left {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
  }

  .rev-idx {
    font-weight: 600;
    color: #f8fafc;
  }

  .rev-source {
    padding: 0.05rem 0.3rem;
    border-radius: 0.2rem;
    font-size: 0.625rem;
  }

  .rev-source.source-network {
    background: #0284c7;
    color: #e0f2fe;
  }

  .rev-source.source-history {
    background: #7c3aed;
    color: #ede9fe;
  }

  .rev-source.source-replay {
    background: #d97706;
    color: #fef3c7;
  }

  .rev-badge {
    padding: 0.05rem 0.3rem;
    border-radius: 0.2rem;
    font-size: 0.625rem;
  }

  .rev-badge.last-good {
    background: #059669;
    color: #ecfdf5;
  }

  .rev-badge.final {
    background: #334155;
    color: #cbd5e1;
  }

  .rev-time,
  .rev-len {
    color: #64748b;
  }

  .active-tag {
    color: #38bdf8;
    font-weight: 600;
  }

  .view-rev-btn {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 0.2rem;
    color: #cbd5e1;
    font-size: 0.625rem;
    padding: 0.1rem 0.4rem;
    cursor: pointer;
  }

  .view-rev-btn:hover {
    background: #334155;
    color: #f8fafc;
  }
</style>
