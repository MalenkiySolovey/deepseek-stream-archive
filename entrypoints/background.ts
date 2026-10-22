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
  MESSAGE_GET_ARCHIVE_SUMMARY,
  MESSAGE_PERSIST_CANONICAL_CHECKPOINT,
  MESSAGE_LIST_ARCHIVE_CONVERSATIONS,
  MESSAGE_GET_ARCHIVE_CONVERSATION,
  MESSAGE_GET_REVISION_CONTENT,
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
  validatePersistCanonicalCheckpointRequest,
  validateListArchiveConversationsRequest,
  validateGetArchiveConversationRequest,
  validateGetRevisionContentRequest,
} from '../src/bridge/validation';
import type { DeepSeekProtocolDiagnosticsData } from '../src/adapters/deepseek/protocol/types';
import { DEFAULT_DEEPSEEK_PROFILE } from '../src/adapters/deepseek/compatibility/profiles';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { DeepSeekHistoryParser } from '../src/adapters/deepseek/history/parser';
import { logger } from '../src/shared/logger';


const MAX_TRACKED_STREAMS = 100;

export default defineBackground(() => {
  logger.info('Background Service Worker initialized in extension origin');

  const storageRepo = new IndexedDbStorageRepository();
  const rawStreamRepo = new RawStreamRepository();
  const historyReconciler = new HistoryReconciler(storageRepo);

  // Transient in-memory runtime diagnostics (reset on Service Worker restart)
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

  // Handle incoming internal extension messages
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

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
      storageRepo
        .listConversations()
        .then(async (conversations) => {
          let revCount = 0;
          for (const conv of conversations) {
            const msgs = await storageRepo.listMessagesByConversation(conv.id);
            for (const msg of msgs) {
              const revs = await storageRepo.listRevisionsByMessage(msg.id);
              revCount += revs.length;
            }
          }

          const aggProtocol = aggregateProtocolDiagnostics();

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

    // 12. Handle Forward History Observation from Content Script
    if (message.type === MESSAGE_FORWARD_HISTORY_OBSERVATION) {
      const req = message as ForwardHistoryObservationRequest;
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
      lastHistoryObservedAt = Date.now();

      const sessionId = parsed.session.sessionId;
      const prevQueue = historyQueuesBySessionId.get(sessionId) || Promise.resolve();

      const runReconciliation = async () => {
        try {
          const result = await historyReconciler.reconcile(parsed);
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
          lastPersistedAt = Date.now();
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

    return false;
  });
});

