import { defineBackground } from 'wxt/utils/define-background';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { RawStreamRepository } from '../src/storage/raw-journal/repository';
import {
  MESSAGE_SAVE_SYNTHETIC_BATCH,
  MESSAGE_GET_FOUNDATION_STATUS,
  MESSAGE_LIST_SYNTHETIC_REVISIONS,
  MESSAGE_TRIGGER_DIAGNOSTIC_SYNTHETIC,
  MESSAGE_FORWARD_TRANSPORT_EVENT,
  MESSAGE_FORWARD_SEMANTIC_BATCH,
  MESSAGE_NOTIFY_BRIDGE_OBSERVED,
  MESSAGE_RECORD_PROTOCOL_OBSERVATION,
  MESSAGE_PERSIST_RAW_STREAM_OPEN,
  MESSAGE_PERSIST_RAW_BATCH,
  MESSAGE_FINALIZE_RAW_STREAM,
  MESSAGE_GET_RAW_JOURNAL_STATUS,
  MESSAGE_FORWARD_HISTORY_OBSERVATION,
  MESSAGE_PERSIST_USER_TURN,
  MESSAGE_GET_ARCHIVE_SUMMARY,
  MESSAGE_PERSIST_CANONICAL_CHECKPOINT,
  MESSAGE_LIST_ARCHIVE_CONVERSATIONS,
  MESSAGE_GET_ARCHIVE_CONVERSATION,
  MESSAGE_GET_REVISION_CONTENT,
  MESSAGE_HISTORY_INGEST_OPEN,
  MESSAGE_HISTORY_INGEST_BATCH,
  MESSAGE_HISTORY_INGEST_COMMIT,
  MESSAGE_HISTORY_INGEST_ABORT,
  MESSAGE_GET_PAGE_RECOVERY_SUMMARY,
  MESSAGE_GET_PAGE_RECOVERY_CONTENT,
  MESSAGE_GET_CONVERSATION_EXPORT,
  MESSAGE_CREATE_PORTABLE_BACKUP_SNAPSHOT,
  MESSAGE_GET_STORAGE_USAGE_ESTIMATE,
  MESSAGE_RESTORE_PREVIEW,
  MESSAGE_EXECUTE_RESTORE,
  MESSAGE_GET_STORAGE_MAINTENANCE_STATUS,
  MESSAGE_REQUEST_STORAGE_PERSISTENCE,
  MESSAGE_GET_RETENTION_SETTINGS,
  MESSAGE_SET_RETENTION_SETTINGS,
  MESSAGE_PREVIEW_CONVERSATION_DELETE,
  MESSAGE_DELETE_CONVERSATION,
  MESSAGE_PREVIEW_RAW_RETENTION,
  MESSAGE_EXECUTE_RAW_RETENTION,
  MESSAGE_CLEAR_RAW_EVIDENCE,
  MESSAGE_CLEAR_ENTIRE_ARCHIVE,
  MESSAGE_GET_CONTEXT_CONTINUITY_SETTINGS,
  MESSAGE_SET_CONTEXT_CONTINUITY_SETTINGS,
  MESSAGE_BUILD_CONTEXT_CONTINUITY_PLAN,
  MESSAGE_GET_CONTEXT_CONTINUITY_STATUS,
  MESSAGE_RECORD_CONTINUITY_RECEIPT,
  MESSAGE_GET_CONTINUITY_RECEIPTS,
  MESSAGE_ARM_CONTINUITY_DELIVERY,
  MESSAGE_REVOKE_CONTINUITY_DELIVERY,
  MESSAGE_RECORD_RECOVERY_DIAGNOSTIC,

  type SaveSyntheticBatchRequest,
  type SaveSyntheticBatchResponse,
  type FoundationStatusResponse,
  type ListSyntheticRevisionsResponse,
  type ForwardTransportEventRequest,
  type ForwardTransportEventResponse,
  type ForwardSemanticBatchRequest,
  type ForwardSemanticBatchResponse,
  type TriggerDiagnosticSyntheticResponse,
  type RecordProtocolObservationRequest,
  type RecordProtocolObservationResponse,
  type PersistRawStreamOpenRequest,
  type PersistRawStreamOpenResponse,
  type PersistRawBatchRequest,
  type PersistRawBatchResponse,
  type FinalizeRawStreamRequest,
  type FinalizeRawStreamResponse,
  type GetRawJournalStatusRequest,
  type GetRawJournalStatusResponse,
  type ForwardHistoryObservationRequest,
  type ForwardHistoryObservationResponse,
  type GetArchiveSummaryRequest,
  type GetArchiveSummaryResponse,
  type PersistUserTurnRequest,
  type PersistUserTurnResponse,
  type PersistCanonicalCheckpointRequest,
  type PersistCanonicalCheckpointResponse,
  type ListArchiveConversationsResponse,
  type GetArchiveConversationResponse,
  type GetRevisionContentResponse,
  type ObservationState,
} from '../src/bridge/messages';
import {
  validatePersistRawStreamOpenRequest,
  validatePersistRawBatchRequest,
  validateFinalizeRawStreamRequest,
  validatePersistUserTurnRequest,
  validatePersistCanonicalCheckpointRequest,
  validateListArchiveConversationsRequest,
  validateGetArchiveConversationRequest,
  validateGetRevisionContentRequest,
  validateHistoryIngestOpenRequest,
  validateHistoryIngestBatchRequest,
  validateHistoryIngestCommitRequest,
  validateHistoryIngestAbortRequest,
  validateGetPageRecoverySummaryRequest,
  validateGetPageRecoveryContentRequest,
  validateGetConversationExportRequest,
  validateCreatePortableBackupSnapshotRequest,
  validateRestorePreviewRequest,
  validateExecuteRestoreRequest,
  validatePreviewConversationDeleteRequest,
  validateDeleteConversationRequest,
  validatePreviewRawRetentionRequest,
  validateExecuteRawRetentionRequest,
  validateSetRetentionSettingsRequest,
  validateGetContextContinuitySettingsRequest,
  validateSetContextContinuitySettingsRequest,
  validateBuildContextContinuityPlanRequest,
  validateGetContextContinuityStatusRequest,
  validateRecordContinuityReceiptRequest,
  validateRecordRecoveryDiagnosticRequest,
  validateGetContinuityReceiptsRequest,
  validateArmContinuityDeliveryRequest,
  validateRevokeContinuityDeliveryRequest,
} from '../src/bridge/validation';
import type { ContextDeliveryEnvelope } from '../src/adapters/deepseek/request/types';
import {
  getContextContinuitySettings,
  saveContextContinuitySettings,
} from '../src/context-continuity';

import {
  getRetentionSettings,
  saveRetentionSettings,
  recordAutomaticCleanup,
  requestStoragePersistence,
} from '../src/storage/retention';
import type { MaterializedPortableBackup } from '../src/backup/reader';
import type { DeepSeekProtocolDiagnosticsData } from '../src/adapters/deepseek/protocol/types';
import { DEFAULT_DEEPSEEK_PROFILE } from '../src/adapters/deepseek/compatibility/profiles';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { DeepSeekHistoryParser } from '../src/adapters/deepseek/history/parser';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';
import type { PageRecoverySummary, PageRecoveryMessageSummary } from '../src/adapters/deepseek/dom/types';
import { logger } from '../src/shared/logger';


export function isAuthorizedSender(sender: chrome.runtime.MessageSender): boolean {
  const url = sender.url || sender.tab?.url;
  if (!url) return true; // Direct internal extension calls, unit tests
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'chrome-extension:') return true;
    if (parsed.origin === 'https://chat.deepseek.com') return true;
  } catch {
    return false;
  }
  return false;
}

const MAX_TRACKED_STREAMS = 100;

export default defineBackground(() => {
  logger.info('Background Service Worker initialized in extension origin');

  const storageRepo = new IndexedDbStorageRepository();
  const rawStreamRepo = new RawStreamRepository();
  const historyReconciler = new HistoryReconciler(storageRepo);

  // Transient in-memory runtime diagnostics (reset on Service Worker restart)
  const runtimeEpochId = `epoch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runtimeStartedAt = Date.now();

  const pendingRestoreBackups = new Map<string, { backup: MaterializedPortableBackup; expiresAt: number }>();

  let runtimeRawBatchesCount = 0;
  let runtimeRawStreamsCount = 0;
  let runtimeCanonicalCheckpointsCount = 0;
  let runtimeRevisionsCommittedCount = 0;
  let runtimeHistoryObservationsCount = 0;
  let runtimeHistoryReconciliationsCount = 0;

  const runtimeRecoveryDiagnostics: import('../src/bridge/messages').RuntimeRecoveryDiagnostics = {
    successfulInlineRendersCount: 0,
    fallbackRenderCount: 0,
    domMappingErrorsCount: 0,
  };

  let bridgeState: ObservationState = 'not_observed';
  const activeTransportStreams = new Set<string>(); // composite keys: `${producerSessionId}:${streamId}`
  const seenFetchStreams = new Set<string>();
  const seenXhrStreams = new Set<string>();
  let transportErrorsCount = 0;
  let lastObservedAt: number | undefined = undefined;
  let lastPersistedAt: number | undefined = undefined;
  let historyObservationsCount = 0;
  let lastHistoryObservedAt: number | undefined = undefined;
  const historyQueuesBySessionId = new Map<string, Promise<void>>();

  const globalUnknownSseEndpoints = new Set<string>();
  const globalRecentWarnings = new Set<string>();

  // Stream-isolated protocol diagnostics map to prevent cumulative double-counting
  const streamDiagnosticsMap = new Map<string, DeepSeekProtocolDiagnosticsData>();

  function aggregateProtocolDiagnostics(): DeepSeekProtocolDiagnosticsData {
    const agg: DeepSeekProtocolDiagnosticsData = {
      activeProfileId: DEFAULT_DEEPSEEK_PROFILE.id,
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
      activeMessageId: undefined,
      activeSessionId: undefined,
      currentAnswerLength: 0,
      currentThinkingLength: 0,
      filterEventsCount: 0,
      lastFilterEvent: undefined,
      lastTerminalReason: undefined,
      lastProtocolStatus: undefined,
      quasiStatus: undefined,
      hasPendingFragment: undefined,
      incompleteMessage: undefined,
      finishControlObserved: false,
      closeControlObserved: false,
      sequenceGapsCount: 0,
      orphanEventsCount: 0,
      duplicateOpensCount: 0,
      eventsAfterTerminalCount: 0,
      protocolWarningsCount: 0,
      unknownSseEndpoints: [],
      unknownSseEventNames: [],
      recentWarnings: [],
    };

    const unknownEndpointsSet = new Set<string>(globalUnknownSseEndpoints);
    const unknownEventNamesSet = new Set<string>();
    const warningsSet = new Set<string>(globalRecentWarnings);
    let hasLiveObserved = false;
    let hasDegraded = false;

    for (const d of streamDiagnosticsMap.values()) {
      agg.activeProfileId = d.activeProfileId || agg.activeProfileId;
      agg.parsedFramesCount += d.parsedFramesCount;
      agg.operationsCount.set += d.operationsCount.set;
      agg.operationsCount.append += d.operationsCount.append;
      agg.operationsCount.replace += d.operationsCount.replace;
      agg.operationsCount.batch += d.operationsCount.batch;
      agg.operationsCount.other += d.operationsCount.other;

      if (d.activeMessageId) agg.activeMessageId = d.activeMessageId;
      if (d.activeSessionId) agg.activeSessionId = d.activeSessionId;
      if (d.currentAnswerLength > 0) agg.currentAnswerLength = d.currentAnswerLength;
      if (d.currentThinkingLength > 0) agg.currentThinkingLength = d.currentThinkingLength;
      if (d.projectionSource && d.projectionSource !== 'none') {
        agg.projectionSource = d.projectionSource;
      }

      if (d.lastProtocolStatus) agg.lastProtocolStatus = d.lastProtocolStatus;
      if (d.quasiStatus) agg.quasiStatus = d.quasiStatus;
      if (d.lastTerminalReason) agg.lastTerminalReason = d.lastTerminalReason;
      if (d.finishControlObserved) agg.finishControlObserved = true;
      if (d.closeControlObserved) agg.closeControlObserved = true;

      agg.filterEventsCount += d.filterEventsCount;
      if (d.lastFilterEvent) {
        if (!agg.lastFilterEvent || d.lastFilterEvent.timestamp > agg.lastFilterEvent.timestamp) {
          agg.lastFilterEvent = d.lastFilterEvent;
        }
      }

      agg.sequenceGapsCount += d.sequenceGapsCount;
      agg.orphanEventsCount = Math.max(agg.orphanEventsCount, d.orphanEventsCount);
      agg.duplicateOpensCount += d.duplicateOpensCount;
      agg.eventsAfterTerminalCount = Math.max(agg.eventsAfterTerminalCount, d.eventsAfterTerminalCount);
      agg.protocolWarningsCount += d.protocolWarningsCount;

      if (d.compatibilityState === 'degraded') {
        hasDegraded = true;
      } else if (d.compatibilityState === 'live_observed') {
        hasLiveObserved = true;
      }

      for (const ep of d.unknownSseEndpoints) unknownEndpointsSet.add(ep);
      if (d.unknownSseEventNames) {
        for (const evName of d.unknownSseEventNames) unknownEventNamesSet.add(evName);
      }
      for (const w of d.recentWarnings) warningsSet.add(w);
    }

    if (hasDegraded || agg.sequenceGapsCount > 0) {
      agg.compatibilityState = 'degraded';
    } else if (hasLiveObserved) {
      agg.compatibilityState = 'live_observed';
    } else {
      agg.compatibilityState = 'not_observed';
    }

    agg.unknownSseEndpoints = Array.from(unknownEndpointsSet);
    agg.unknownSseEventNames = Array.from(unknownEventNamesSet);
    agg.recentWarnings = Array.from(warningsSet).slice(-10);

    return agg;
  }

  // Configure Chrome Side Panel to open automatically when user clicks extension action icon
  if (typeof chrome !== 'undefined' && chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((err) => {
      logger.warn('Failed to set Side Panel behavior', err);
    });
  }

  // Opportunistic rate-limited automatic retention check (at most once every 24 hours, no alarms permission)
  async function runOpportunisticRetentionCheck(): Promise<void> {
    try {
      const settings = await getRetentionSettings();
      if (settings.rawRetention === 'forever') {
        return;
      }
      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;
      if (settings.lastAutomaticCleanupAt && now - settings.lastAutomaticCleanupAt < oneDayMs) {
        return;
      }
      if (activeTransportStreams.size > 0) {
        return;
      }
      const plan = await storageRepo.buildRawRetentionPlan(settings.rawRetention, activeTransportStreams, now);
      if (plan.candidateStreamKeys.length > 0) {
        await storageRepo.executeRawRetentionPlan(plan, activeTransportStreams);
        logger.info(`Opportunistic retention cleanup pruned ${plan.candidateStreamKeys.length} raw streams`);
      }
      await recordAutomaticCleanup(now);
    } catch (err) {
      logger.warn('Opportunistic retention check skipped/failed', err);
    }
  }

  // Trigger opportunistic cleanup on background worker startup
  runOpportunisticRetentionCheck().catch(() => {});

  // Handle incoming internal extension messages
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (!isAuthorizedSender(_sender)) {
      sendResponse({ success: false, error: 'unauthorized_sender' });
      return false;
    }

    // 1. Bridge Observed Notification from Content Script
    if (message.type === MESSAGE_NOTIFY_BRIDGE_OBSERVED) {
      bridgeState = 'observed';
      lastObservedAt = Date.now();
      sendResponse({ ok: true });
      return false;
    }

    // 2. Generic Transport Event Forwarded from Content Script
    if (message.type === MESSAGE_FORWARD_TRANSPORT_EVENT) {
      const req = message as ForwardTransportEventRequest;
      const event = req.event;
      bridgeState = 'observed';
      lastObservedAt = event.timestamp;
      const compositeKey = `${event.producerSessionId}:${event.streamId}`;

      if (event.type === 'open') {
        activeTransportStreams.add(compositeKey);
        if (event.transport === 'fetch') {
          seenFetchStreams.add(compositeKey);
        } else if (event.transport === 'xhr') {
          seenXhrStreams.add(compositeKey);
        }
      } else if (
        event.type === 'complete' ||
        event.type === 'abort' ||
        event.type === 'error'
      ) {
        activeTransportStreams.delete(compositeKey);
        if (event.type === 'abort' || event.type === 'error') {
          transportErrorsCount++;
        }
      }

      const res: ForwardTransportEventResponse = { received: true };
      sendResponse(res);
      return false;
    }

    // 2b. Recovery Diagnostic Recorded from Content Script
    if (message.type === MESSAGE_RECORD_RECOVERY_DIAGNOSTIC) {
      const req = validateRecordRecoveryDiagnosticRequest(message);
      if (req) {
        if (req.kind === 'inline_success') {
          runtimeRecoveryDiagnostics.successfulInlineRendersCount++;
        } else if (req.kind === 'fallback_render') {
          runtimeRecoveryDiagnostics.fallbackRenderCount++;
        } else if (req.kind === 'dom_mapping_error') {
          runtimeRecoveryDiagnostics.domMappingErrorsCount++;
        }
        sendResponse({ received: true });
      } else {
        sendResponse({ received: false });
      }
      return false;
    }

    // 3. Forward Semantic Batch from Content Script
    if (message.type === MESSAGE_FORWARD_SEMANTIC_BATCH) {
      const req = message as ForwardSemanticBatchRequest;
      bridgeState = 'observed';
      lastObservedAt = Date.now();
      const compositeKey = `${req.batch.producerSessionId}:${req.batch.streamId}`;

      // Store absolute snapshot per stream to avoid cumulative double counting
      if (req.diagnostics) {
        if (streamDiagnosticsMap.size >= MAX_TRACKED_STREAMS && !streamDiagnosticsMap.has(compositeKey)) {
          const firstKey = streamDiagnosticsMap.keys().next().value;
          if (firstKey) streamDiagnosticsMap.delete(firstKey);
        }
        streamDiagnosticsMap.set(compositeKey, req.diagnostics);
      }

      // Log significant protocol events (e.g. filter trigger, completion)
      for (const evt of req.batch.events) {
        if (evt.type === 'filter_triggered') {
          logger.warn('⚠️ DeepSeek censorship event detected on stream', {
            streamId: evt.streamId,
            reason: evt.reason,
            lastGoodAnswerLength: evt.lastGood?.answer.length,
            lastGoodThinkingLength: evt.lastGood?.thinking.length,
            projectionSource: evt.projectionSource,
          });
        }
      }

      const res: ForwardSemanticBatchResponse = { received: true };
      sendResponse(res);
      return false;
    }

    // 4. Handle Lightweight Protocol Observation (e.g. unclassified SSE, warnings)
    if (message.type === MESSAGE_RECORD_PROTOCOL_OBSERVATION) {
      const req = message as RecordProtocolObservationRequest;
      bridgeState = 'observed';
      lastObservedAt = req.timestamp || Date.now();
      if (req.kind === 'unclassified_sse' && req.sanitizedPathname) {
        globalUnknownSseEndpoints.add(req.sanitizedPathname);
      }
      if (req.warning) {
        globalRecentWarnings.add(req.warning);
      }
      const res: RecordProtocolObservationResponse = { received: true };
      sendResponse(res);
      return false;
    }

    // 4. Handle Synthetic Batch Persistence from Content Script (ACK Pipeline)
    if (message.type === MESSAGE_SAVE_SYNTHETIC_BATCH) {
      const req = message as SaveSyntheticBatchRequest;

      storageRepo
        .saveSyntheticBatch(req.data)
        .then(() => {
          lastPersistedAt = Date.now();
          const ack: SaveSyntheticBatchResponse = {
            success: true,
            batchSeq: req.batchSeq,
            persistedAt: lastPersistedAt,
          };
          sendResponse(ack);
        })
        .catch((err) => {
          const nack: SaveSyntheticBatchResponse = {
            success: false,
            batchSeq: req.batchSeq,
            persistedAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(nack);
        });

      return true; // Keep channel open for async response
    }

    // 5. Handle Status Query from Side Panel
    if (message.type === MESSAGE_GET_FOUNDATION_STATUS) {
      Promise.all([
        storageRepo.listConversations(),
        rawStreamRepo.getJournalMetadata().catch(() => ({
          streamCount: 0,
          activeStreamCount: 0,
          totalBatchesCount: 0,
          totalCharsCount: 0,
          lastPersistedAt: undefined,
        })),
      ])
        .then(async ([conversations, rawMeta]) => {
          let totalMessages = 0;
          let revCount = 0;
          let reconciledCount = 0;
          for (const conv of conversations) {
            const msgs = await storageRepo.listMessagesByConversation(conv.id);
            totalMessages += msgs.length;
            for (const msg of msgs) {
              if (msg.identityState === 'reconciled') reconciledCount++;
              const revs = await storageRepo.listRevisionsByMessage(msg.id);
              revCount += revs.length;
            }
          }

          const aggProtocol = aggregateProtocolDiagnostics();

          const pipelineStages: import('../src/bridge/messages').PipelineDiagnosticStage[] = [
            {
              id: 'bg_reachable',
              name: 'Background Service Worker Reachable',
              status: 'healthy',
              details: `Active MV3 service worker (epoch: ${runtimeEpochId.slice(0, 14)})`,
            },
            {
              id: 'isolated_content',
              name: 'ISOLATED Content Script Loaded',
              status:
                bridgeState === 'observed' || seenFetchStreams.size > 0 || seenXhrStreams.size > 0
                  ? 'observed'
                  : 'not_observed',
              lastObservedAt,
            },
            {
              id: 'main_interceptor',
              name: 'MAIN-World Interceptor Loaded',
              status: bridgeState === 'observed' ? 'observed' : 'not_observed',
              lastObservedAt,
            },
            {
              id: 'bridge_handshake',
              name: 'Bridge Handshake Observed',
              status: bridgeState === 'observed' ? 'healthy' : 'not_observed',
              lastObservedAt,
            },
            {
              id: 'fetch_hook',
              name: 'Fetch Hook Installed & Active',
              status:
                seenFetchStreams.size > 0
                  ? 'healthy'
                  : bridgeState === 'observed'
                  ? 'observed'
                  : 'not_observed',
              details: `${seenFetchStreams.size} stream(s) observed`,
            },
            {
              id: 'xhr_hook',
              name: 'XHR Hook Installed & Active',
              status:
                seenXhrStreams.size > 0
                  ? 'healthy'
                  : bridgeState === 'observed'
                  ? 'observed'
                  : 'not_observed',
              details: `${seenXhrStreams.size} stream(s) observed`,
            },
            {
              id: 'generation_candidate',
              name: 'Generation Candidate Observed',
              status: seenFetchStreams.size + seenXhrStreams.size > 0 ? 'healthy' : 'not_observed',
              details: `${seenFetchStreams.size + seenXhrStreams.size} candidate(s)`,
            },
            {
              id: 'raw_chunk_observed',
              name: 'Raw Journal Chunk Observed',
              status: runtimeRawBatchesCount > 0 ? 'healthy' : 'not_observed',
              details: `${runtimeRawBatchesCount} batch(es) this runtime`,
            },
            {
              id: 'raw_journal_ack',
              name: 'Raw Journal ACK Confirmed',
              status: runtimeRawStreamsCount > 0 ? 'healthy' : 'not_observed',
              details: `${runtimeRawStreamsCount} stream(s) this runtime`,
            },
            {
              id: 'protocol_frame_decoded',
              name: 'Protocol Frame Decoded',
              status: aggProtocol.parsedFramesCount > 0 ? 'healthy' : 'not_observed',
              details: `${aggProtocol.parsedFramesCount} SSE frame(s)`,
            },
            {
              id: 'canonical_checkpoint_ack',
              name: 'Canonical Checkpoint ACK Confirmed',
              status: runtimeCanonicalCheckpointsCount > 0 ? 'healthy' : 'not_observed',
              details: `${runtimeRevisionsCommittedCount} revision(s) this runtime`,
            },
            {
              id: 'history_observation',
              name: 'History Observation Seen',
              status: runtimeHistoryObservationsCount > 0 ? 'observed' : 'not_observed',
              details: `${runtimeHistoryObservationsCount} observation(s) this runtime`,
            },
            {
              id: 'history_reconciliation',
              name: 'History Reconciliation Succeeded',
              status:
                runtimeHistoryReconciliationsCount > 0
                  ? 'healthy'
                  : runtimeHistoryObservationsCount > 0
                  ? 'observed'
                  : 'not_observed',
              details: `${runtimeHistoryReconciliationsCount} reconciliation(s) this runtime`,
            },
            {
              id: 'compatibility_profile',
              name: 'Compatibility Profile State',
              status:
                aggProtocol.protocolWarningsCount > 0
                  ? 'degraded'
                  : aggProtocol.compatibilityState === 'live_observed'
                  ? 'healthy'
                  : aggProtocol.parsedFramesCount > 0
                  ? 'observed'
                  : 'not_observed',
              details: `Profile: ${DEFAULT_DEEPSEEK_PROFILE.id}`,
            },
          ];

          const durableArchiveEvidence: import('../src/bridge/messages').DurableArchiveEvidence = {
            totalRawStreams: rawMeta.streamCount,
            totalBatches: rawMeta.totalBatchesCount,
            totalConversations: conversations.length,
            totalMessages,
            totalRevisions: revCount,
            reconciledMessages: reconciledCount,
            lastPersistedAt,
          };

          const status: FoundationStatusResponse = {
            bridgeState,
            backgroundAlive: true,
            storageOperational: true,
            persistedCount: revCount,
            lastPersistedAt,
            transport: {
              fetchStreamsCount: seenFetchStreams.size,
              xhrStreamsCount: seenXhrStreams.size,
              activeStreamsCount: activeTransportStreams.size,
              sseEventsDecodedCount: aggProtocol.parsedFramesCount,
              transportErrorsCount,
              lastObservedAt,
            },
            protocol: aggProtocol,
            pipelineStages,
            runtimeEpochId,
            runtimeStartedAt,
            durableArchiveEvidence,
            runtimeRecovery: { ...runtimeRecoveryDiagnostics },
          };
          sendResponse(status);
        })
        .catch((err) => {
          logger.error('Failed to query status', err);
          const aggProtocol = aggregateProtocolDiagnostics();
          sendResponse({
            bridgeState,
            backgroundAlive: true,
            storageOperational: false,
            persistedCount: 0,
            transport: {
              fetchStreamsCount: seenFetchStreams.size,
              xhrStreamsCount: seenXhrStreams.size,
              activeStreamsCount: activeTransportStreams.size,
              sseEventsDecodedCount: aggProtocol.parsedFramesCount,
              transportErrorsCount,
              lastObservedAt,
            },
            protocol: aggProtocol,
            pipelineStages: [
              {
                id: 'bg_reachable',
                name: 'Background Service Worker Reachable',
                status: 'healthy',
                details: 'Active MV3 service worker',
              },
              {
                id: 'storage_operational',
                name: 'IndexedDB Storage Operational',
                status: 'failed',
                details: err instanceof Error ? err.message : String(err),
              },
            ],
            runtimeEpochId,
            runtimeStartedAt,
            runtimeRecovery: { ...runtimeRecoveryDiagnostics },
          });
        });

      return true;
    }

    // 6. Handle List Revisions for Side Panel
    if (message.type === MESSAGE_LIST_SYNTHETIC_REVISIONS) {
      (async () => {
        try {
          const conversations = await storageRepo.listConversations();
          const allMessages = [];
          const allRevisions = [];

          for (const conv of conversations) {
            const msgs = await storageRepo.listMessagesByConversation(conv.id);
            allMessages.push(...msgs);
            for (const msg of msgs) {
              const revs = await storageRepo.listRevisionsByMessage(msg.id);
              allRevisions.push(...revs);
            }
          }

          const res: ListSyntheticRevisionsResponse = {
            conversations,
            messages: allMessages,
            revisions: allRevisions,
          };
          sendResponse(res);
        } catch {
          sendResponse({ conversations: [], messages: [], revisions: [] });
        }
      })();

      return true;
    }

    // 7. Handle Explicit Trigger for Diagnostic Synthetic Test
    if (message.type === MESSAGE_TRIGGER_DIAGNOSTIC_SYNTHETIC) {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        chrome.tabs.query({ url: '*://chat.deepseek.com/*' }, (tabs) => {
          if (tabs.length === 0) {
            const res: TriggerDiagnosticSyntheticResponse = {
              success: false,
              message: 'No open DeepSeek tab found. Open chat.deepseek.com first.',
            };
            sendResponse(res);
            return;
          }

          const targetTabId = tabs[0]?.id;
          if (targetTabId) {
            chrome.tabs.sendMessage(targetTabId, {
              type: 'STREAMARCHIVE_REQUEST_PAGE_SYNTHETIC',
            });
            const res: TriggerDiagnosticSyntheticResponse = {
              success: true,
              message: 'Triggered diagnostic test on active DeepSeek tab.',
            };
            sendResponse(res);
          } else {
            sendResponse({ success: false, message: 'Could not target active tab.' });
          }
        });
      } else {
        sendResponse({ success: false, message: 'Tabs API not available.' });
      }

      return true;
    }

    // 8. Handle Raw Stream Open from Content Script
    if (message.type === MESSAGE_PERSIST_RAW_STREAM_OPEN) {
      const validated = validatePersistRawStreamOpenRequest(message);
      if (!validated) {
        const errRes: PersistRawStreamOpenResponse = {
          success: false,
          streamKey: '',
          errorCode: 'invalid_request',
          error: 'Invalid open request payload',
        };
        sendResponse(errRes);
        return false;
      }

      rawStreamRepo
        .openStream({
          producerSessionId: validated.producerSessionId,
          streamId: validated.streamId,
          transport: validated.transport,
          url: validated.url,
          method: validated.method,
          provisionalSessionId: validated.provisionalSessionId,
          captureProfileId: validated.captureProfileId,
          openedAt: validated.openedAt,
          streamSequence: validated.streamSequence,
          integrity: validated.integrity,
        })
        .then((record) => {
          runtimeRawStreamsCount++;
          const res: PersistRawStreamOpenResponse = {
            success: true,
            streamKey: record.id,
            openedAt: record.openedAt,
          };
          sendResponse(res);
        })
        .catch((err) => {
          const errCode = (err as any)?.code || 'database_unavailable';
          const res: PersistRawStreamOpenResponse = {
            success: false,
            streamKey: `${validated.producerSessionId}:${validated.streamId}`,
            errorCode: errCode,
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(res);
        });

      return true;
    }

    // 9. Handle Raw Batch Persistence with strict tx.oncomplete ACK
    if (message.type === MESSAGE_PERSIST_RAW_BATCH) {
      const validated = validatePersistRawBatchRequest(message);
      if (!validated) {
        const errRes: PersistRawBatchResponse = {
          success: false,
          streamKey: '',
          batchSeq: -1,
          errorCode: 'invalid_batch',
          error: 'Invalid raw batch payload',
        };
        sendResponse(errRes);
        return false;
      }

      rawStreamRepo
        .persistBatch(validated.batch)
        .then((ack) => {
          runtimeRawBatchesCount++;
          lastPersistedAt = ack.persistedAt;
          const res: PersistRawBatchResponse = {
            success: true,
            streamKey: validated.batch.streamKey,
            batchSeq: ack.batchSeq,
            persistedAt: ack.persistedAt,
          };
          sendResponse(res);
        })
        .catch((err) => {
          const errCode = (err as any)?.code || 'database_unavailable';
          const res: PersistRawBatchResponse = {
            success: false,
            streamKey: validated.batch.streamKey,
            batchSeq: validated.batch.batchSeq,
            errorCode: errCode,
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(res);
        });

      return true;
    }

    // 10. Handle Raw Stream Finalize
    if (message.type === MESSAGE_FINALIZE_RAW_STREAM) {
      const validated = validateFinalizeRawStreamRequest(message);
      if (!validated) {
        const errRes: FinalizeRawStreamResponse = {
          success: false,
          streamKey: '',
          errorCode: 'invalid_request',
          error: 'Invalid finalize request payload',
        };
        sendResponse(errRes);
        return false;
      }

      rawStreamRepo
        .finalizeStream(
          validated.streamKey,
          validated.finalState,
          validated.terminalReason,
          validated.error,
          validated.droppedChars,
          validated.durabilityGap,
          validated.integrity
        )
        .then((result) => {
          const res: FinalizeRawStreamResponse = {
            success: true,
            streamKey: validated.streamKey,
            finalState: result.finalState,
            finalizedAt: result.finalizedAt,
          };
          sendResponse(res);
          runOpportunisticRetentionCheck().catch(() => {});
        })
        .catch((err) => {
          const errCode = (err as any)?.code || 'database_unavailable';
          const res: FinalizeRawStreamResponse = {
            success: false,
            streamKey: validated.streamKey,
            errorCode: errCode,
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(res);
        });

      return true;
    }

    // 11. Handle Raw Journal Status Query
    if (message.type === MESSAGE_GET_RAW_JOURNAL_STATUS) {
      Promise.all([rawStreamRepo.getJournalMetadata(), rawStreamRepo.listStreams(20)])
        .then(([metadata, recentStreams]) => {
          const res: GetRawJournalStatusResponse = {
            metadata,
            recentStreams,
          };
          sendResponse(res);
        })
        .catch((err) => {
          logger.error('Failed to get raw journal status', err);
          const emptyRes: GetRawJournalStatusResponse = {
            metadata: {
              streamCount: 0,
              activeStreamCount: 0,
              totalBatchesCount: 0,
              totalCharsCount: 0,
            },
            recentStreams: [],
          };
          sendResponse(emptyRes);
        });

      return true;
    }

    // 12. Handle Forward History Observation from Content Script (Deprecated legacy path)
    if (message.type === MESSAGE_FORWARD_HISTORY_OBSERVATION) {
      const req = message as ForwardHistoryObservationRequest;
      if (req.payload?.body && req.payload.body.length > 65536) {
        logger.warn('[StreamArchive] Legacy history observation exceeds 64KB bound, rejected in favor of chunked staging');
        sendResponse({
          success: false,
          error: 'legacy_unbounded_history_rejected: payload exceeds 64KB, use bounded chunked staging',
        });
        return false;
      }

      const parsed = DeepSeekHistoryParser.parse(req.payload?.body, {
        expectedSessionId: req.payload?.sessionId,
        observedAt: req.payload?.timestamp,
      });
      if (!parsed) {
        const errRes: ForwardHistoryObservationResponse = {
          success: false,
          error: 'Failed to parse DeepSeek history payload: malformed schema or invalid code',
        };
        sendResponse(errRes);
        return false;
      }

      historyObservationsCount++;
      runtimeHistoryObservationsCount++;
      lastHistoryObservedAt = Date.now();

      const sessionId = parsed.session.sessionId;
      const prevQueue = historyQueuesBySessionId.get(sessionId) || Promise.resolve();

      const runReconciliation = async () => {
        try {
          const result = await historyReconciler.reconcile(parsed);
          runtimeHistoryReconciliationsCount++;
          const res: ForwardHistoryObservationResponse = {
            success: true,
            reconciled: true,
            conversationId: result.conversationId,
            messagesCreated: result.messagesCreated,
            messagesUpdated: result.messagesUpdated,
            revisionsCreated: result.revisionsCreated,
            treeLinksResolved: result.treeLinksResolved,
          };
          sendResponse(res);
        } catch (err) {
          logger.error('Failed to reconcile history', err);
          const errRes: ForwardHistoryObservationResponse = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(errRes);
        }
      };

      const newQueue = prevQueue.then(runReconciliation, runReconciliation).finally(() => {
        if (historyQueuesBySessionId.get(sessionId) === newQueue) {
          historyQueuesBySessionId.delete(sessionId);
        }
      });
      historyQueuesBySessionId.set(sessionId, newQueue);

      return true;
    }

    // 12b. Handle Bounded History Ingestion: Open
    if (message.type === MESSAGE_HISTORY_INGEST_OPEN) {
      const validated = validateHistoryIngestOpenRequest(message);
      if (!validated) {
        sendResponse({ success: false, stagingId: '', error: 'invalid_ingest_open_request' });
        return false;
      }

      (async () => {
        try {
          await storageRepo.cleanupStaleHistoryStaging();
          await storageRepo.saveHistoryStagingManifest({
            stagingId: validated.stagingId,
            sessionId: validated.sessionId,
            expectedBatchCount: validated.totalBatches,
            expectedMessageCount: validated.totalMessages,
            receivedBatchCount: 0,
            state: 'open',
            createdAt: validated.timestamp || Date.now(),
            updatedAt: Date.now(),
          });
          sendResponse({ success: true, stagingId: validated.stagingId });
        } catch (err) {
          sendResponse({
            success: false,
            stagingId: validated.stagingId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();
      return true;
    }

    // 12c. Handle Bounded History Ingestion: Batch
    if (message.type === MESSAGE_HISTORY_INGEST_BATCH) {
      const validated = validateHistoryIngestBatchRequest(message);
      if (!validated) {
        sendResponse({
          success: false,
          stagingId: '',
          batchIndex: -1,
          error: 'invalid_ingest_batch_request',
        });
        return false;
      }

      storageRepo
        .saveHistoryStagingBatch({
          id: `${validated.stagingId}:${validated.batchIndex}`,
          stagingId: validated.stagingId,
          batchIndex: validated.batchIndex,
          session: validated.session,
          messages: validated.messages,
          createdAt: Date.now(),
        })
        .then(() => {
          sendResponse({
            success: true,
            stagingId: validated.stagingId,
            batchIndex: validated.batchIndex,
          });
        })
        .catch((err) => {
          sendResponse({
            success: false,
            stagingId: validated.stagingId,
            batchIndex: validated.batchIndex,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }

    // 12d. Handle Bounded History Ingestion: Commit
    if (message.type === MESSAGE_HISTORY_INGEST_COMMIT) {
      const validated = validateHistoryIngestCommitRequest(message);
      if (!validated) {
        sendResponse({ success: false, stagingId: '', error: 'invalid_ingest_commit_request' });
        return false;
      }

      (async () => {
        try {
          const batches = await storageRepo.listHistoryStagingBatches(validated.stagingId);
          if (batches.length === 0) {
            sendResponse({
              success: false,
              stagingId: validated.stagingId,
              error: 'no_staging_batches_found',
            });
            return;
          }

          let session: any = undefined;
          const allMessages: any[] = [];
          for (const b of batches) {
            if (b.session && !session) session = b.session;
            allMessages.push(...b.messages);
          }

          if (!session) {
            sendResponse({
              success: false,
              stagingId: validated.stagingId,
              error: 'missing_session_in_staging',
            });
            return;
          }

          const parsed: DeepSeekParsedHistory = {
            session,
            messages: allMessages,
          };

          const sessionId = session.sessionId;
          const prevQueue = historyQueuesBySessionId.get(sessionId) || Promise.resolve();

          const runCommit = async () => {
            const { plan, result } = await historyReconciler.createPlan(parsed);
            await storageRepo.commitHistoryStagingPlan(validated.stagingId, plan);

            historyObservationsCount++;
            runtimeHistoryObservationsCount++;
            runtimeHistoryReconciliationsCount++;
            lastHistoryObservedAt = Date.now();

            sendResponse({
              success: true,
              stagingId: validated.stagingId,
              conversationId: result.conversationId,
              messagesCreated: result.messagesCreated,
              messagesUpdated: result.messagesUpdated,
              revisionsCreated: result.revisionsCreated,
              treeLinksResolved: result.treeLinksResolved,
            });
          };

          const newQueue = prevQueue
            .then(runCommit, (err) => {
              logger.error('Failed to commit history staging', err);
              sendResponse({
                success: false,
                stagingId: validated.stagingId,
                error: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => {
              if (historyQueuesBySessionId.get(sessionId) === newQueue) {
                historyQueuesBySessionId.delete(sessionId);
              }
            });
          historyQueuesBySessionId.set(sessionId, newQueue);
        } catch (err) {
          logger.error('Failed to process history ingest commit', err);
          sendResponse({
            success: false,
            stagingId: validated.stagingId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return true;
    }

    // 12e. Handle Bounded History Ingestion: Abort
    if (message.type === MESSAGE_HISTORY_INGEST_ABORT) {
      const validated = validateHistoryIngestAbortRequest(message);
      if (!validated) {
        sendResponse({ success: false, stagingId: '', error: 'invalid_ingest_abort_request' });
        return false;
      }

      storageRepo
        .clearHistoryStaging(validated.stagingId)
        .then(() => {
          sendResponse({ success: true, stagingId: validated.stagingId });
        })
        .catch((err) => {
          sendResponse({
            success: false,
            stagingId: validated.stagingId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }

    // 12b. Handle Immediate User Turn Persistence (Section 6)
    if (message.type === MESSAGE_PERSIST_USER_TURN) {
      const validated = validatePersistUserTurnRequest(message);
      if (!validated) {
        sendResponse({
          success: false,
          messageId: '',
          error: 'Invalid user turn payload',
        } as PersistUserTurnResponse);
        return false;
      }

      const userMsg = validated.userMessage;
      Promise.all([
        storageRepo.getConversation(userMsg.conversationId),
        storageRepo.getConversationByRemoteId(userMsg.conversationId),
      ])
        .then(async ([existingById, existingByRemote]) => {
          let existingConv = existingById || existingByRemote;
          if (!existingConv) {
            await storageRepo.saveConversation({
              id: userMsg.conversationId,
              remoteId: userMsg.conversationId,
              title: userMsg.content?.slice(0, 40).trim() || 'DeepSeek Chat',
              createdAt: userMsg.createdAt,
              updatedAt: userMsg.updatedAt,
            });
          } else {
            userMsg.conversationId = existingConv.id;
            await storageRepo.saveConversation({
              ...existingConv,
              remoteId: existingConv.remoteId || userMsg.conversationId,
              updatedAt: userMsg.updatedAt,
            });
          }
          await storageRepo.saveMessages([userMsg]);
          sendResponse({
            success: true,
            messageId: userMsg.id,
            persistedAt: Date.now(),
          } as PersistUserTurnResponse);
        })
        .catch((err) => {
          sendResponse({
            success: false,
            messageId: userMsg.id,
            error: err instanceof Error ? err.message : String(err),
          } as PersistUserTurnResponse);
        });
      return true;
    }

    // 13. Handle Canonical Checkpoint Persistence
    if (message.type === MESSAGE_PERSIST_CANONICAL_CHECKPOINT) {
      const validated = validatePersistCanonicalCheckpointRequest(message);
      if (!validated) {
        const errRes: PersistCanonicalCheckpointResponse = {
          success: false,
          streamKey: (message as any)?.checkpoint?.streamKey || '',
          checkpointSeq: (message as any)?.checkpoint?.checkpointSeq ?? -1,
          error: 'Invalid canonical checkpoint payload',
        };
        sendResponse(errRes);
        return false;
      }

      storageRepo
        .saveCanonicalCheckpoint(validated.checkpoint)
        .then(() => {
          runtimeCanonicalCheckpointsCount++;
          runtimeRevisionsCommittedCount += validated.checkpoint.revisions.length;
          lastPersistedAt = Date.now();

          // Advance continuity receipt lifecycle on canonical checkpoint
          const targetConvId =
            validated.checkpoint.conversation?.id || validated.checkpoint.message.conversationId;
          storageRepo
            .getContinuityReceiptsForConversation(targetConvId)
            .then((receipts) => {
              const pending = receipts
                .filter((r) => r.state === 'dispatched' || r.state === 'response_observed')
                .at(-1);
              if (!pending) return;

              if (validated.checkpoint.isTerminal) {
                const assistantMsg =
                  validated.checkpoint.message.role === 'assistant'
                    ? validated.checkpoint.message
                    : undefined;
                storageRepo
                  .updateContinuityReceipt(pending.id, {
                    state: 'bridged',
                    rawStreamKey: validated.checkpoint.streamKey,
                    resultingMessageId: assistantMsg?.id,
                  })
                  .catch(() => {});
              } else if (pending.state === 'dispatched') {
                storageRepo
                  .updateContinuityReceipt(pending.id, {
                    state: 'response_observed',
                    rawStreamKey: validated.checkpoint.streamKey,
                  })
                  .catch(() => {});
              }
            })
            .catch(() => {});

          const res: PersistCanonicalCheckpointResponse = {
            success: true,
            streamKey: validated.checkpoint.streamKey,
            checkpointSeq: validated.checkpoint.checkpointSeq,
            persistedAt: lastPersistedAt,
          };
          sendResponse(res);
        })
        .catch((err) => {
          logger.error('Failed to persist canonical checkpoint', err);
          const res: PersistCanonicalCheckpointResponse = {
            success: false,
            streamKey: validated.checkpoint.streamKey,
            checkpointSeq: validated.checkpoint.checkpointSeq,
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(res);
        });

      return true;
    }

    // 13. Handle Archive Summary Query from Side Panel
    if (message.type === MESSAGE_GET_ARCHIVE_SUMMARY) {
      storageRepo
        .getArchiveSummary()
        .then((summary) => {
          const res: GetArchiveSummaryResponse = {
            summary,
            historyObservationsCount,
            lastHistoryObservedAt,
          };
          sendResponse(res);
        })
        .catch((err) => {
          logger.error('Failed to get archive summary', err);
          sendResponse({
            summary: {
              conversationsCount: 0,
              messagesCount: 0,
              provisionalMessagesCount: 0,
              reconciledMessagesCount: 0,
              revisionsCount: 0,
              lastGoodRevisionsCount: 0,
              recoveryEventsCount: 0,
            },
            historyObservationsCount,
            lastHistoryObservedAt,
          });
        });

      return true;
    }

    // 14. Handle List Archive Conversations Query
    if (message.type === MESSAGE_LIST_ARCHIVE_CONVERSATIONS) {
      const validated = validateListArchiveConversationsRequest(message);
      if (!validated) {
        const res: ListArchiveConversationsResponse = {
          success: false,
          error: 'Invalid list archive conversations request payload',
        };
        sendResponse(res);
        return false;
      }

      storageRepo
        .listArchiveConversations(validated.options)
        .then((data) => {
          const res: ListArchiveConversationsResponse = {
            success: true,
            data,
          };
          sendResponse(res);
        })
        .catch((err) => {
          logger.error('Failed to list archive conversations', err);
          const res: ListArchiveConversationsResponse = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(res);
        });

      return true;
    }

    // 15. Handle Get Archive Conversation Detail Query
    if (message.type === MESSAGE_GET_ARCHIVE_CONVERSATION) {
      const validated = validateGetArchiveConversationRequest(message);
      if (!validated) {
        const res: GetArchiveConversationResponse = {
          success: false,
          error: 'Invalid get archive conversation request payload',
        };
        sendResponse(res);
        return false;
      }

      storageRepo
        .getArchiveConversation(validated.conversationId)
        .then((data) => {
          const res: GetArchiveConversationResponse = {
            success: true,
            data,
          };
          sendResponse(res);
        })
        .catch((err) => {
          logger.error('Failed to get archive conversation', err);
          const res: GetArchiveConversationResponse = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(res);
        });

      return true;
    }

    // 16. Handle Get Revision Content Query
    if (message.type === MESSAGE_GET_REVISION_CONTENT) {
      const validated = validateGetRevisionContentRequest(message);
      if (!validated) {
        const res: GetRevisionContentResponse = {
          success: false,
          error: 'Invalid get revision content request payload',
        };
        sendResponse(res);
        return false;
      }

      storageRepo
        .getRevisionContent(validated.revisionId)
        .then((data) => {
          const res: GetRevisionContentResponse = {
            success: true,
            data,
          };
          sendResponse(res);
        })
        .catch((err) => {
          logger.error('Failed to get revision content', err);
          const res: GetRevisionContentResponse = {
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
          sendResponse(res);
        });

      return true;
    }

    // 16. Handle Page Recovery Summary Query for Content Script Overlay
    if (message.type === MESSAGE_GET_PAGE_RECOVERY_SUMMARY) {
      const validated = validateGetPageRecoverySummaryRequest(message);
      if (!validated) {
        sendResponse({ success: false, summary: null, error: 'invalid_request' });
        return false;
      }

      (async () => {
        try {
          const routeSessionId = validated.currentRouteSessionId;
          // Privacy invariant: Page overlay requires exact session match.
          // Homepage (no session ID) or un-archived routes must return null. Never fall back to latest conversation!
          if (!routeSessionId) {
            sendResponse({ success: true, summary: null });
            return;
          }

          let conv = await storageRepo.getConversationByRemoteId(routeSessionId);
          if (!conv) {
            conv = await storageRepo.getConversation(routeSessionId);
          }

          if (!conv) {
            sendResponse({ success: true, summary: null });
            return;
          }

          const recoverable = await storageRepo.getRecoveryMetadataForConversation(conv.id);

          const summary: PageRecoverySummary = {
            conversationId: conv.id,
            remoteSessionId: conv.remoteId,
            recoverableCount: recoverable.length,
            messages: recoverable,
          };

          sendResponse({ success: true, summary });
        } catch (err) {
          logger.error('Failed to get page recovery summary', err);
          sendResponse({
            success: false,
            summary: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return true;
    }

    // 17. Handle Dedicated Page Recovery Content Query
    if (message.type === MESSAGE_GET_PAGE_RECOVERY_CONTENT) {
      const validated = validateGetPageRecoveryContentRequest(message);
      if (!validated) {
        sendResponse({ success: false, data: null, error: 'invalid_recovery_content_request' });
        return false;
      }

      (async () => {
        try {
          let conv = await storageRepo.getConversationByRemoteId(validated.currentRouteSessionId);
          if (!conv) {
            conv = await storageRepo.getConversation(validated.currentRouteSessionId);
          }
          if (!conv) {
            sendResponse({ success: false, data: null, error: 'conversation_not_found' });
            return;
          }

          const msg = await storageRepo.getMessage(validated.messageId);
          if (!msg || msg.conversationId !== conv.id) {
            sendResponse({ success: false, data: null, error: 'message_mismatch' });
            return;
          }

          if (validated.recoveryEventId) {
            const event = await storageRepo.getRecoveryEvent(validated.recoveryEventId);
            if (!event || event.messageId !== msg.id || !event.recoveredRevisionId) {
              sendResponse({ success: false, data: null, error: 'recovery_event_invalid' });
              return;
            }
            let rev = await storageRepo.getRevision(event.recoveredRevisionId);
            const isMeaningful = rev && (rev.text.trim().length > 0 || (rev.thinking && rev.thinking.trim().length > 0));

            if (!rev || !isMeaningful) {
              // Read-time legacy repair: locate latest meaningful network revision for msg
              const revs = await storageRepo.listRevisionsByMessage(msg.id);
              const repaired = [...revs].reverse().find(
                (r) => r.source === 'network' && (r.text.trim().length > 0 || (r.thinking && r.thinking.trim().length > 0))
              );
              if (repaired) {
                rev = repaired;
              }
            }

            if (!rev || rev.messageId !== msg.id || (rev.text.trim().length === 0 && (!rev.thinking || rev.thinking.trim().length === 0))) {
              sendResponse({ success: false, data: null, error: 'recovered_revision_invalid' });
              return;
            }
            sendResponse({
              success: true,
              data: {
                text: rev.text,
                thinking: rev.thinking,
                source: rev.source,
                capturedAt: rev.capturedAt,
                recoveryKind: 'authoritative_recovery',
              },
            });
            return;
          }

          // Fallback for partial network capture
          const revs = await storageRepo.listRevisionsByMessage(msg.id);
          const netRev = [...revs].reverse().find((r) => r.source === 'network');
          if (!netRev) {
            sendResponse({ success: false, data: null, error: 'revision_not_found' });
            return;
          }

          sendResponse({
            success: true,
            data: {
              text: netRev.text,
              thinking: netRev.thinking,
              source: netRev.source,
              capturedAt: netRev.capturedAt,
              recoveryKind: 'partial_capture',
            },
          });
        } catch (err) {
          logger.error('Failed to get page recovery content', err);
          sendResponse({
            success: false,
            data: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })();

      return true;
    }

    // 21. Handle Get Conversation Export Model
    if (message.type === MESSAGE_GET_CONVERSATION_EXPORT) {
      const validated = validateGetConversationExportRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid get conversation export request payload' });
        return false;
      }
      storageRepo
        .getConversationExportModel(validated.conversationId)
        .then((exportModel) => {
          if (!exportModel) {
            sendResponse({ success: false, error: 'conversation_not_found' });
          } else {
            sendResponse({ success: true, exportModel });
          }
        })
        .catch((err) => {
          logger.error('Failed to get conversation export model', err);
          sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    }

    // 22. Handle Create Portable Backup Snapshot
    if (message.type === MESSAGE_CREATE_PORTABLE_BACKUP_SNAPSHOT) {
      const validated = validateCreatePortableBackupSnapshotRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid create backup snapshot request payload' });
        return false;
      }
      storageRepo
        .createPortableBackupSnapshot({ maxBytes: validated.maxBytes })
        .then((snapshot) => {
          sendResponse({ success: true, snapshot });
        })
        .catch((err) => {
          logger.error('Failed to create portable backup snapshot', err);
          sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    }

    // 23. Handle Get Storage Usage Estimate
    if (message.type === MESSAGE_GET_STORAGE_USAGE_ESTIMATE) {
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
        navigator.storage
          .estimate()
          .then((estimate) => {
            sendResponse({
              success: true,
              usageBytes: estimate.usage,
              quotaBytes: estimate.quota,
            });
          })
          .catch((err) => {
            sendResponse({ success: false, error: String(err) });
          });
      } else {
        sendResponse({ success: false, error: 'Storage estimate API unavailable' });
      }
      return true;
    }

    // 24. Handle Restore Preview & Preflight
    if (message.type === MESSAGE_RESTORE_PREVIEW) {
      const validated = validateRestorePreviewRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid restore preview request payload' });
        return false;
      }

      // Cleanup expired preflights
      const now = Date.now();
      for (const [key, item] of pendingRestoreBackups.entries()) {
        if (item.expiresAt < now) pendingRestoreBackups.delete(key);
      }

      const activeStreamsCount = activeTransportStreams.size;
      storageRepo
        .validateAndPreflightRestore(validated.data, activeStreamsCount, validated.mode)
        .then(({ preflight, backup }) => {
          if (backup) {
            const preflightId = `pfl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
            pendingRestoreBackups.set(preflightId, {
              backup,
              expiresAt: Date.now() + 15 * 60 * 1000, // 15 mins TTL
            });
            sendResponse({ success: true, preflightId, preflight });
          } else {
            sendResponse({ success: false, preflight });
          }
        })
        .catch((err) => {
          logger.error('Failed to preflight restore', err);
          sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    }

    // 25. Handle Execute Restore
    if (message.type === MESSAGE_EXECUTE_RESTORE) {
      const validated = validateExecuteRestoreRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid execute restore request payload' });
        return false;
      }

      const activeStreamsCount = activeTransportStreams.size;
      if (activeStreamsCount > 0) {
        sendResponse({
          success: false,
          error: 'Cannot restore archive while active DeepSeek generation streams are running. Please wait for completion.',
        });
        return false;
      }

      let backup = validated.backup;
      if (!backup && validated.preflightId) {
        const cached = pendingRestoreBackups.get(validated.preflightId);
        if (cached) {
          backup = cached.backup;
        }
      }

      if (!backup) {
        sendResponse({
          success: false,
          error: 'Restore preflight expired or not found. Please re-validate the backup file before restoring.',
        });
        return false;
      }

      storageRepo
        .executeRestore(backup, validated.mode, activeStreamsCount)
        .then((result) => {
          if (validated.preflightId) {
            pendingRestoreBackups.delete(validated.preflightId);
          }
          sendResponse({ success: result.success, result, error: result.error });
        })
        .catch((err) => {
          logger.error('Failed to execute restore', err);
          sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
        });
      return true;
    }

    // ── Retention, Cleanup & Safe Deletion Handlers ──

    if (message.type === MESSAGE_GET_STORAGE_MAINTENANCE_STATUS) {
      storageRepo
        .getStorageMaintenanceStatus()
        .then((status) => sendResponse({ success: true, status }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_REQUEST_STORAGE_PERSISTENCE) {
      requestStoragePersistence()
        .then((res) => sendResponse({ success: true, granted: res.granted, persistenceStatus: res.persistenceStatus }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_GET_RETENTION_SETTINGS) {
      getRetentionSettings()
        .then((settings) => sendResponse({ success: true, settings }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_SET_RETENTION_SETTINGS) {
      const validated = validateSetRetentionSettingsRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid retention settings payload' });
        return false;
      }
      saveRetentionSettings(validated.settings)
        .then((settings) => {
          sendResponse({ success: true, settings });
        })
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_PREVIEW_CONVERSATION_DELETE) {
      const validated = validatePreviewConversationDeleteRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid preview conversation delete payload' });
        return false;
      }
      storageRepo
        .buildConversationDeletionPlan(validated.conversationId, activeTransportStreams)
        .then((plan) => sendResponse({ success: true, plan }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_DELETE_CONVERSATION) {
      const validated = validateDeleteConversationRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid delete conversation payload' });
        return false;
      }
      storageRepo
        .deleteConversationCascade(validated.plan, activeTransportStreams)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_PREVIEW_RAW_RETENTION) {
      const validated = validatePreviewRawRetentionRequest(message);
      const mode = validated?.mode;
      const getModePromise = mode ? Promise.resolve(mode) : getRetentionSettings().then((s) => s.rawRetention);
      getModePromise
        .then((effMode) => storageRepo.buildRawRetentionPlan(effMode, activeTransportStreams))
        .then((plan) => sendResponse({ success: true, plan }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_EXECUTE_RAW_RETENTION) {
      const validated = validateExecuteRawRetentionRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid execute raw retention payload' });
        return false;
      }
      storageRepo
        .executeRawRetentionPlan(validated.plan, activeTransportStreams)
        .then((result) => sendResponse({ success: result.success, result, error: result.error }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_CLEAR_RAW_EVIDENCE) {
      storageRepo
        .clearRawEvidence(activeTransportStreams.size)
        .then((result) => sendResponse({ success: result.success, result, error: result.error }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_CLEAR_ENTIRE_ARCHIVE) {
      storageRepo
        .clearEntireArchive(activeTransportStreams.size)
        .then((res) => sendResponse({ success: res.success, durationMs: res.durationMs }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    // ── Context Continuity Handlers ──

    if (message.type === MESSAGE_GET_CONTEXT_CONTINUITY_SETTINGS) {
      getContextContinuitySettings()
        .then((settings) => sendResponse({ success: true, settings }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_SET_CONTEXT_CONTINUITY_SETTINGS) {
      const validated = validateSetContextContinuitySettingsRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid context continuity settings payload' });
        return false;
      }
      saveContextContinuitySettings(validated.settings)
        .then((settings) => sendResponse({ success: true, settings }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_BUILD_CONTEXT_CONTINUITY_PLAN) {
      const validated = validateBuildContextContinuityPlanRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid build context continuity plan payload' });
        return false;
      }
      storageRepo
        .buildContextContinuityPlan(validated.conversationId, {
          leafMessageId: validated.leafMessageId,
          branchSelections: validated.branchSelections,
        })
        .then((plan) => {
          if (!plan) {
            sendResponse({ success: false, error: 'Conversation not found' });
          } else {
            sendResponse({ success: true, plan });
          }
        })
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_GET_CONTEXT_CONTINUITY_STATUS) {
      const validated = validateGetContextContinuityStatusRequest(message);
      getContextContinuitySettings()
        .then(async (settings) => {
          if (!settings.enabled) {
            sendResponse({
              success: true,
              status: {
                enabled: false,
                includeThinking: settings.includeThinking,
                status: 'disabled',
              },
            });
            return;
          }

          if (validated?.conversationId) {
            const plan = await storageRepo.buildContextContinuityPlan(validated.conversationId, { settings });
            if (!plan || plan.eligibleBlockCount === 0) {
              sendResponse({
                success: true,
                status: {
                  enabled: true,
                  includeThinking: settings.includeThinking,
                  status: 'no_eligible_context',
                  eligibleBlocksCount: 0,
                  excludedBlocksCount: plan?.excludedBlockCount ?? 0,
                  totalTextChars: 0,
                  totalThinkingChars: 0,
                },
              });
            } else {
              sendResponse({
                success: true,
                status: {
                  enabled: true,
                  includeThinking: settings.includeThinking,
                  status: plan.truncated ? 'truncated' : 'ready',
                  eligibleBlocksCount: plan.eligibleBlockCount,
                  excludedBlocksCount: plan.excludedBlockCount,
                  totalTextChars: plan.totalTextChars,
                  totalThinkingChars: plan.totalThinkingChars,
                },
              });
            }
          } else {
            sendResponse({
              success: true,
              status: {
                enabled: true,
                includeThinking: settings.includeThinking,
                status: 'ready',
              },
            });
          }
        })
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    // ── Continuity Delivery Receipts & Arming ──

    if (message.type === MESSAGE_RECORD_CONTINUITY_RECEIPT) {
      const validated = validateRecordContinuityReceiptRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid record continuity receipt payload' });
        return false;
      }
      storageRepo
        .recordContinuityReceipt(validated.receipt)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_GET_CONTINUITY_RECEIPTS) {
      const validated = validateGetContinuityReceiptsRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid get continuity receipts payload' });
        return false;
      }
      storageRepo
        .getContinuityReceiptsForConversation(validated.conversationId)
        .then((receipts) => sendResponse({ success: true, receipts }))
        .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
      return true;
    }

    if (message.type === MESSAGE_ARM_CONTINUITY_DELIVERY) {
      const validated = validateArmContinuityDeliveryRequest(message);
      if (!validated) {
        sendResponse({ success: false, error: 'Invalid arm continuity delivery payload' });
        return false;
      }
      (async () => {
        const settings = await getContextContinuitySettings();
        const plan = await storageRepo.buildContextContinuityPlan(validated.conversationId, {
          leafMessageId: validated.leafMessageId,
          branchSelections: validated.branchSelections,
          settings,
        });
        if (!plan || plan.eligibleBlockCount === 0) {
          return sendResponse({ success: false, error: 'No eligible context to deliver' });
        }
        const conv = await storageRepo.getConversation(validated.conversationId);
        const remoteId = conv?.remoteId || validated.conversationId;
        const leafMsg = plan.branchLeafId ? await storageRepo.getMessage(plan.branchLeafId) : null;
        const expectedParent = leafMsg?.remoteId || plan.branchLeafId;

        const deliveryId =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `deliv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

        const envelope: ContextDeliveryEnvelope = {
          deliveryId,
          conversationId: validated.conversationId,
          remoteConversationId: remoteId,
          expectedParentMessageId: expectedParent,
          formattedContext: plan.formattedPreview,
          sourceMessageIds: plan.eligibleBlocks.map((b) => b.sourceMessageId),
          sourceRevisionIds: plan.eligibleBlocks.map((b) => b.sourceRevisionId),
          deliveryMode: settings.deliveryMode,
          createdAt: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000, // 5 min validity
        };

        if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
          chrome.tabs.query({ url: '*://chat.deepseek.com/*' }, (tabs) => {
            for (const tab of tabs || []) {
              if (tab.id) {
                chrome.tabs.sendMessage(tab.id, {
                  type: 'STREAMARCHIVE_DISPATCH_ARM_TO_MAIN',
                  envelope,
                }).catch(() => {});
              }
            }
          });
        }

        sendResponse({ success: true, envelope });
      })().catch((err) =>
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) })
      );
      return true;
    }

    if (message.type === MESSAGE_REVOKE_CONTINUITY_DELIVERY) {
      if (typeof chrome !== 'undefined' && chrome.tabs && chrome.tabs.query) {
        chrome.tabs.query({ url: '*://chat.deepseek.com/*' }, (tabs) => {
          for (const tab of tabs || []) {
            if (tab.id) {
              chrome.tabs.sendMessage(tab.id, {
                type: 'STREAMARCHIVE_DISPATCH_REVOKE_TO_MAIN',
              }).catch(() => {});
            }
          }
        });
      }
      sendResponse({ success: true });
      return true;
    }

    return false;

  });
});

