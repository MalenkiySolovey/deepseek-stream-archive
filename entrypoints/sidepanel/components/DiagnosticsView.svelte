<script lang="ts">
  import { onMount } from 'svelte';
  import {
    MESSAGE_GET_FOUNDATION_STATUS,
    MESSAGE_TRIGGER_DIAGNOSTIC_SYNTHETIC,
    MESSAGE_GET_RAW_JOURNAL_STATUS,
    MESSAGE_GET_ARCHIVE_SUMMARY,
    type FoundationStatusResponse,
    type GetFoundationStatusRequest,
    type TriggerDiagnosticSyntheticRequest,
    type TriggerDiagnosticSyntheticResponse,
    type GetRawJournalStatusRequest,
    type GetRawJournalStatusResponse,
    type GetArchiveSummaryRequest,
    type GetArchiveSummaryResponse,
  } from '../../../src/bridge/messages';
  import type { ArchiveSummary } from '../../../src/core/contracts';
  import { translations, type SupportedLocale } from './i18n';

  interface Props {
    locale: SupportedLocale;
  }

  let { locale } = $props<Props>();
  let t = $derived(translations[locale]);

  let status = $state<FoundationStatusResponse>({
    bridgeState: 'not_observed',
    backgroundAlive: false,
    storageOperational: false,
    persistedCount: 0,
    transport: {
      fetchStreamsCount: 0,
      xhrStreamsCount: 0,
      activeStreamsCount: 0,
      sseEventsDecodedCount: 0,
      transportErrorsCount: 0,
    },
    protocol: {
      activeProfileId: 'deepseek-web-reference-2026-10',
      compatibilityState: 'not_observed',
      projectionSource: 'none',
      parsedFramesCount: 0,
      operationsCount: {
        set: 0,
        append: 0,
        replace: 0,
        batch: 0,
        other: 0,
      },
      currentAnswerLength: 0,
      currentThinkingLength: 0,
      filterEventsCount: 0,
      sequenceGapsCount: 0,
      orphanEventsCount: 0,
      duplicateOpensCount: 0,
      eventsAfterTerminalCount: 0,
      protocolWarningsCount: 0,
      finishControlObserved: false,
      closeControlObserved: false,
      unknownSseEndpoints: [],
      unknownSseEventNames: [],
      recentWarnings: [],
    },
  });

  let rawJournal = $state<GetRawJournalStatusResponse>({
    metadata: {
      streamCount: 0,
      activeStreamCount: 0,
      totalBatchesCount: 0,
      totalCharsCount: 0,
      lastPersistedAt: undefined,
    },
    recentStreams: [],
  });

  let archiveSummary = $state<ArchiveSummary>({
    conversationsCount: 0,
    messagesCount: 0,
    provisionalMessagesCount: 0,
    reconciledMessagesCount: 0,
    revisionsCount: 0,
    lastGoodRevisionsCount: 0,
    recoveryEventsCount: 0,
  });

  let historyObservationsCount = $state<number>(0);
  let lastHistoryObservedAt = $state<number | undefined>(undefined);
  let loading = $state(true);
  let diagnosticNotice = $state<string | null>(null);

  onMount(() => {
    loadDiagnostics();
  });

  async function loadDiagnostics() {
    loading = true;
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const statusReq: GetFoundationStatusRequest = { type: MESSAGE_GET_FOUNDATION_STATUS };
        const statusRes = await chrome.runtime.sendMessage<
          GetFoundationStatusRequest,
          FoundationStatusResponse
        >(statusReq);
        if (statusRes) status = statusRes;

        const rawReq: GetRawJournalStatusRequest = { type: MESSAGE_GET_RAW_JOURNAL_STATUS };
        const rawRes = await chrome.runtime.sendMessage<
          GetRawJournalStatusRequest,
          GetRawJournalStatusResponse
        >(rawReq);
        if (rawRes) rawJournal = rawRes;

        const sumReq: GetArchiveSummaryRequest = { type: MESSAGE_GET_ARCHIVE_SUMMARY };
        const sumRes = await chrome.runtime.sendMessage<
          GetArchiveSummaryRequest,
          GetArchiveSummaryResponse
        >(sumReq);
        if (sumRes) {
          archiveSummary = sumRes.summary;
          historyObservationsCount = sumRes.historyObservationsCount;
          lastHistoryObservedAt = sumRes.lastHistoryObservedAt;
        }
      }
    } catch {
      // ignore
    } finally {
      loading = false;
    }
  }

  async function triggerSyntheticDiagnostic() {
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        const req: TriggerDiagnosticSyntheticRequest = {
          type: MESSAGE_TRIGGER_DIAGNOSTIC_SYNTHETIC,
        };
        const res = await chrome.runtime.sendMessage<
          TriggerDiagnosticSyntheticRequest,
          TriggerDiagnosticSyntheticResponse
        >(req);
        if (res && res.success) {
          diagnosticNotice = res.message || 'Diagnostic synthetic batch persisted successfully!';
          await loadDiagnostics();
        } else {
          diagnosticNotice = 'Diagnostic write failed.';
        }
      }
    } catch (err) {
      diagnosticNotice = `Diagnostic write error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
</script>

<div class="diagnostics-view">
  <div class="diag-header">
    <h2 class="diag-title">{t.tabDiagnostics}</h2>
    <button class="refresh-btn" type="button" onclick={loadDiagnostics}>
      ↻ {t.refresh}
    </button>
  </div>

  {#if diagnosticNotice}
    <div class="notice-banner">
      {diagnosticNotice}
    </div>
  {/if}

  <div class="diag-sections">
    <!-- Canonical Archive Summary -->
    <div class="section-card">
      <h3 class="card-title">Canonical Archive State</h3>
      <div class="metrics-grid">
        <div class="metric-box">
          <span class="m-val">{archiveSummary.conversationsCount}</span>
          <span class="m-lbl">Conversations</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{archiveSummary.messagesCount}</span>
          <span class="m-lbl">Messages</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{archiveSummary.reconciledMessagesCount}</span>
          <span class="m-lbl">Reconciled</span>
        </div>
        <div class="metric-box">
          <span class="m-val highlight-warn">{archiveSummary.provisionalMessagesCount}</span>
          <span class="m-lbl">Provisional</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{archiveSummary.revisionsCount}</span>
          <span class="m-lbl">Revisions</span>
        </div>
        <div class="metric-box">
          <span class="m-val highlight-success">{archiveSummary.lastGoodRevisionsCount}</span>
          <span class="m-lbl">Last-Good Saved</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{historyObservationsCount}</span>
          <span class="m-lbl">History Captures</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{archiveSummary.recoveryEventsCount}</span>
          <span class="m-lbl">Recovery Events</span>
        </div>
      </div>
    </div>

    <!-- Foundation & Transport -->
    <div class="section-card">
      <h3 class="card-title">Foundation & Transport Health</h3>
      <div class="metrics-grid">
        <div class="metric-box">
          <span class="m-val" class:highlight-success={status.backgroundAlive}>
            {status.backgroundAlive ? 'ALIVE' : 'OFFLINE'}
          </span>
          <span class="m-lbl">Service Worker</span>
        </div>
        <div class="metric-box">
          <span class="m-val" class:highlight-success={status.storageOperational}>
            {status.storageOperational ? 'OK' : 'FAIL'}
          </span>
          <span class="m-lbl">IndexedDB</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{status.transport.fetchStreamsCount}</span>
          <span class="m-lbl">Fetch Streams</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{status.transport.xhrStreamsCount}</span>
          <span class="m-lbl">XHR Streams</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{status.transport.sseEventsDecodedCount}</span>
          <span class="m-lbl">SSE Frames</span>
        </div>
        <div class="metric-box">
          <span class="m-val" class:highlight-warn={status.transport.transportErrorsCount > 0}>
            {status.transport.transportErrorsCount}
          </span>
          <span class="m-lbl">Transport Errors</span>
        </div>
      </div>
    </div>

    <!-- Raw Journal Status -->
    <div class="section-card">
      <h3 class="card-title">Raw Journal Evidence Log</h3>
      <div class="metrics-grid">
        <div class="metric-box">
          <span class="m-val">{rawJournal.metadata.streamCount}</span>
          <span class="m-lbl">Raw Streams</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{rawJournal.metadata.activeStreamCount}</span>
          <span class="m-lbl">Active Streams</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{rawJournal.metadata.totalBatchesCount}</span>
          <span class="m-lbl">Raw Batches</span>
        </div>
        <div class="metric-box">
          <span class="m-val">{rawJournal.metadata.totalCharsCount.toLocaleString()}</span>
          <span class="m-lbl">Chars Buffered</span>
        </div>
      </div>
    </div>

    <!-- Pipeline Verification Chain -->
    {#if status.pipelineStages && status.pipelineStages.length > 0}
      <div class="section-card">
        <h3 class="card-title">Pipeline Verification Chain</h3>
        <div class="pipeline-list">
          {#each status.pipelineStages as stage}
            <div class="pipeline-item">
              <span class="stage-name">{stage.name}</span>
              <div class="stage-status-wrap">
                {#if stage.details}
                  <span class="stage-details">{stage.details}</span>
                {/if}
                <span class="stage-badge status-{stage.status}">
                  {stage.status.replace('_', ' ').toUpperCase()}
                </span>
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Diagnostic Action -->
    <div class="action-card">
      <button class="diag-action-btn" type="button" onclick={triggerSyntheticDiagnostic}>
        🧪 Run Diagnostic Synthetic Persistence
      </button>
    </div>
  </div>
</div>

<style>
  .diagnostics-view {
    padding: 1rem;
    overflow-y: auto;
    height: 100%;
  }

  .diag-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .diag-title {
    margin: 0;
    font-size: 1rem;
    color: #f8fafc;
  }

  .refresh-btn {
    background: transparent;
    border: 1px solid #334155;
    border-radius: 0.25rem;
    color: #94a3b8;
    font-size: 0.6875rem;
    padding: 0.2rem 0.5rem;
    cursor: pointer;
  }

  .refresh-btn:hover {
    background: #1e293b;
    color: #f8fafc;
  }

  .notice-banner {
    background: #064e3b;
    border: 1px solid #059669;
    color: #a7f3d0;
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    margin-bottom: 1rem;
  }

  .diag-sections {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .section-card {
    background: #0f172a;
    border: 1px solid #1e293b;
    border-radius: 0.5rem;
    padding: 0.875rem;
  }

  .card-title {
    margin: 0 0 0.75rem 0;
    font-size: 0.8125rem;
    font-weight: 600;
    color: #94a3b8;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 0.5rem;
  }

  .metric-box {
    background: #090d16;
    border: 1px solid #1e293b;
    border-radius: 0.375rem;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }

  .m-val {
    font-size: 1rem;
    font-weight: 700;
    color: #f8fafc;
    line-height: 1.2;
  }

  .m-lbl {
    font-size: 0.625rem;
    color: #64748b;
    margin-top: 0.2rem;
  }

  .highlight-success {
    color: #34d399;
  }

  .highlight-warn {
    color: #fbbf24;
  }

  .pipeline-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .pipeline-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #090d16;
    border: 1px solid #1e293b;
    border-radius: 0.375rem;
    padding: 0.375rem 0.625rem;
    font-size: 0.75rem;
  }

  .stage-name {
    color: #e2e8f0;
    font-weight: 500;
  }

  .stage-status-wrap {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .stage-details {
    font-size: 0.6875rem;
    color: #64748b;
  }

  .stage-badge {
    font-size: 0.625rem;
    font-weight: 600;
    padding: 0.15rem 0.4rem;
    border-radius: 0.25rem;
    letter-spacing: 0.03em;
  }

  .status-healthy {
    background: #064e3b;
    color: #34d399;
    border: 1px solid #059669;
  }

  .status-observed {
    background: #1e3a5f;
    color: #60a5fa;
    border: 1px solid #2563eb;
  }

  .status-degraded {
    background: #78350f;
    color: #fbbf24;
    border: 1px solid #d97706;
  }

  .status-failed {
    background: #7f1d1d;
    color: #f87171;
    border: 1px solid #dc2626;
  }

  .status-not_observed {
    background: #1e293b;
    color: #64748b;
    border: 1px solid #334155;
  }

  .status-not_applicable {
    background: #0f172a;
    color: #475569;
    border: 1px solid #1e293b;
  }

  .action-card {
    padding-top: 0.5rem;
  }

  .diag-action-btn {
    width: 100%;
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 0.375rem;
    color: #38bdf8;
    font-size: 0.75rem;
    padding: 0.5rem;
    cursor: pointer;
    font-weight: 500;
    transition: all 0.15s;
  }

  .diag-action-btn:hover {
    background: #334155;
    color: #7dd3fc;
  }
</style>
