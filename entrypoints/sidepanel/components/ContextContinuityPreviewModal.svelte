<script lang="ts">
  import type { ContextContinuityPlan } from '../../../src/context-continuity/types';
  import { translations, type SupportedLocale } from './i18n';

  interface Props {
    isOpen: boolean;
    plan: ContextContinuityPlan | null;
    isLoading: boolean;
    error: string | null;
    locale?: SupportedLocale;
    onClose: () => void;
  }

  let { isOpen, plan, isLoading, error, locale = 'en', onClose }: Props = $props();

  let t = $derived(translations[locale]);
  let copied = $state(false);

  async function handleCopy() {
    if (!plan || !plan.formattedPreview) return;
    try {
      await navigator.clipboard.writeText(plan.formattedPreview);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 2000);
    } catch (err) {
      console.warn('[StreamArchive] Failed to copy continuity preview to clipboard:', err);
    }
  }

  function getReasonLabel(reason: string): string {
    switch (reason) {
      case 'wrong_branch':
        return t.continuityReasonWrongBranch;
      case 'already_in_server_history':
        return t.continuityReasonAlreadyInHistory;
      case 'already_bridged':
        return t.continuityReasonAlreadyBridged;
      case 'no_usable_revision':
        return t.continuityReasonNoUsableResponse;
      case 'not_logical_assistant':
        return t.continuityReasonNotLogicalAssistant;
      case 'conversation_mismatch':
        return t.continuityReasonConversationMismatch;
      case 'duplicate_identity':
        return t.continuityReasonDuplicateIdentity;
      default:
        return reason;
    }
  }
</script>

{#if isOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-backdrop" onclick={onClose} role="dialog" aria-modal="true" tabindex="-1">
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="modal-card"
      onclick={(e) => e.stopPropagation()}
      role="document"
      tabindex="-1"
    >
      <div class="modal-header">
        <div class="header-title-group">
          <span class="header-icon">🔄</span>
          <h2 class="modal-title">{t.contextContinuityModalTitle}</h2>
          <span class="experimental-pill">{t.contextContinuityExperimental}</span>
        </div>
        <button class="close-btn" onclick={onClose} title={t.continuityClose}>✕</button>
      </div>

      <div class="disclaimer-banner">
        <span class="banner-icon">🛡️</span>
        <div class="banner-text">
          <p class="banner-bold">{t.contextContinuityDisclaimer}</p>
          <p class="banner-sub">{t.contextContinuityPhaseNotice}</p>
        </div>
      </div>

      {#if isLoading}
        <div class="loading-box">
          <div class="spinner"></div>
          <span>Building continuity plan…</span>
        </div>
      {:else if error}
        <div class="error-box">
          <span class="error-icon">⚠️</span>
          <span>{error}</span>
        </div>
      {:else if plan}
        <div class="stats-grid">
          <div class="stat-item">
            <span class="stat-number">{plan.eligibleBlockCount}</span>
            <span class="stat-desc">{t.continuityEligibleCount}</span>
          </div>
          <div class="stat-item">
            <span class="stat-number">{plan.totalTextChars.toLocaleString()}</span>
            <span class="stat-desc">{t.continuityAssistantTextChars}</span>
          </div>
          <div class="stat-item">
            <span class="stat-number">{plan.totalThinkingChars > 0 ? plan.totalThinkingChars.toLocaleString() : 'OFF'}</span>
            <span class="stat-desc">{t.continuityDeepThinkStatus}</span>
          </div>
          <div class="stat-item">
            <span class="stat-number">{plan.omittedBlockCount}</span>
            <span class="stat-desc">{t.continuityOmittedCount}</span>
          </div>
        </div>

        {#if plan.truncated}
          <div class="limit-warning">
            <span>⚠️ {t.continuityLimitReached}</span>
          </div>
        {/if}

        {#if plan.eligibleBlockCount === 0}
          <div class="empty-state">
            <p>{t.continuityNoEligible}</p>
          </div>
        {:else}
          <div class="preview-section">
            <div class="preview-header">
              <span class="section-label">Payload Preview</span>
              <button class="copy-btn" onclick={handleCopy}>
                {copied ? t.continuityCopied : t.continuityCopyPreview}
              </button>
            </div>
            <pre class="preview-box">{plan.formattedPreview}</pre>
          </div>
        {/if}

        {#if plan.excludedBlocks.length > 0}
          <div class="exclusions-section">
            <details class="exclusions-details">
              <summary class="exclusions-summary">
                {t.continuityExcludedCount} ({plan.excludedBlocks.length})
              </summary>
              <ul class="exclusions-list">
                {#each plan.excludedBlocks as ex}
                  <li class="exclusion-item">
                    <span class="msg-id">#{ex.sourceMessageId.slice(0, 8)}</span>
                    <span class="cause-tag">{ex.recoveryCause}</span>
                    <span class="reason-text">— {getReasonLabel(ex.reason)}</span>
                  </li>
                {/each}
              </ul>
            </details>
          </div>
        {/if}
      {/if}

      <div class="modal-footer">
        <button class="btn-secondary" onclick={onClose}>{t.continuityClose}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.75);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 1rem;
    backdrop-filter: blur(2px);
  }

  .modal-card {
    background: #0f172a;
    border: 1px solid #334155;
    border-radius: 8px;
    width: 100%;
    max-width: 600px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.875rem 1rem;
    border-bottom: 1px solid #1e293b;
  }

  .header-title-group {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .header-icon {
    font-size: 1.1rem;
  }

  .modal-title {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: #f8fafc;
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

  .close-btn {
    background: transparent;
    border: none;
    color: #94a3b8;
    font-size: 1.1rem;
    cursor: pointer;
    padding: 0.25rem;
    line-height: 1;
    border-radius: 4px;
  }

  .close-btn:hover {
    color: #f8fafc;
    background: #1e293b;
  }

  .disclaimer-banner {
    display: flex;
    gap: 0.625rem;
    padding: 0.75rem 1rem;
    background: rgba(59, 130, 246, 0.08);
    border-bottom: 1px solid rgba(59, 130, 246, 0.2);
  }

  .banner-icon {
    font-size: 1.25rem;
    flex-shrink: 0;
  }

  .banner-text {
    font-size: 0.75rem;
    line-height: 1.35;
  }

  .banner-bold {
    margin: 0 0 0.25rem 0;
    font-weight: 600;
    color: #93c5fd;
  }

  .banner-sub {
    margin: 0;
    color: #cbd5e1;
  }

  .loading-box {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.75rem;
    padding: 2.5rem 1rem;
    color: #94a3b8;
    font-size: 0.875rem;
  }

  .spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #334155;
    border-top-color: #3b82f6;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .error-box {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 1rem;
    margin: 1rem;
    background: rgba(239, 68, 68, 0.15);
    border: 1px solid rgba(239, 68, 68, 0.3);
    border-radius: 6px;
    color: #fca5a5;
    font-size: 0.8125rem;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0.5rem;
    padding: 0.875rem 1rem;
    background: #090d16;
    border-bottom: 1px solid #1e293b;
  }

  .stat-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .stat-number {
    font-size: 1.125rem;
    font-weight: 700;
    color: #38bdf8;
  }

  .stat-desc {
    font-size: 0.6875rem;
    color: #94a3b8;
    margin-top: 0.15rem;
  }

  .limit-warning {
    padding: 0.4rem 1rem;
    background: rgba(245, 158, 11, 0.12);
    border-bottom: 1px solid rgba(245, 158, 11, 0.25);
    color: #fbbf24;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .empty-state {
    padding: 2.5rem 1rem;
    text-align: center;
    color: #94a3b8;
    font-size: 0.875rem;
  }

  .preview-section {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 0.875rem 1rem;
  }

  .preview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .section-label {
    font-size: 0.75rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .copy-btn {
    padding: 0.25rem 0.625rem;
    font-size: 0.75rem;
    font-weight: 500;
    background: #1e293b;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 4px;
    cursor: pointer;
  }

  .copy-btn:hover {
    background: #334155;
    color: #ffffff;
  }

  .preview-box {
    flex: 1;
    margin: 0;
    padding: 0.75rem;
    background: #050811;
    border: 1px solid #1e293b;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.75rem;
    line-height: 1.45;
    color: #e2e8f0;
    white-space: pre-wrap;
    word-break: break-word;
    overflow-y: auto;
    max-height: 280px;
  }

  .exclusions-section {
    padding: 0.5rem 1rem;
    border-top: 1px solid #1e293b;
    background: #090d16;
  }

  .exclusions-summary {
    font-size: 0.75rem;
    color: #94a3b8;
    cursor: pointer;
    user-select: none;
  }

  .exclusions-summary:hover {
    color: #cbd5e1;
  }

  .exclusions-list {
    margin: 0.5rem 0 0 0;
    padding: 0;
    list-style: none;
    font-size: 0.75rem;
    max-height: 100px;
    overflow-y: auto;
  }

  .exclusion-item {
    padding: 0.2rem 0;
    display: flex;
    align-items: center;
    gap: 0.35rem;
    color: #cbd5e1;
  }

  .msg-id {
    font-family: ui-monospace, SFMono-Regular, monospace;
    color: #64748b;
  }

  .cause-tag {
    padding: 0.05rem 0.3rem;
    background: #1e293b;
    border-radius: 3px;
    font-size: 0.6875rem;
    color: #94a3b8;
  }

  .reason-text {
    color: #94a3b8;
  }

  .modal-footer {
    display: flex;
    justify-content: flex-end;
    padding: 0.75rem 1rem;
    border-top: 1px solid #1e293b;
    background: #0b1120;
  }

  .btn-secondary {
    padding: 0.4rem 0.875rem;
    background: #1e293b;
    color: #e2e8f0;
    border: 1px solid #334155;
    border-radius: 4px;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-secondary:hover {
    background: #334155;
    color: #ffffff;
  }
</style>
