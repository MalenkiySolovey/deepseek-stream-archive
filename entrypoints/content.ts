import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  STREAMARCHIVE_BRIDGE_EVENT,
  type SyntheticTestPayload,
} from '../src/bridge/protocol';
import {
  validateBridgeEnvelope,
  validateSyntheticPayload,
  validateTransportEventPayload,
  validateHistoryObservationPayload,
  validateHistoryStreamOpenPayload,
  validateHistoryStreamChunkPayload,
  validateHistoryStreamCompletePayload,
  validateHistoryStreamAbortPayload,
  MAX_HISTORY_TOTAL_CHARS,
  MAX_HISTORY_CHUNKS_COUNT,
} from '../src/bridge/validation';
import {
  MESSAGE_SAVE_SYNTHETIC_BATCH,
  MESSAGE_FORWARD_TRANSPORT_EVENT,
  MESSAGE_FORWARD_SEMANTIC_BATCH,
  MESSAGE_NOTIFY_BRIDGE_OBSERVED,
  MESSAGE_RECORD_PROTOCOL_OBSERVATION,
  MESSAGE_FORWARD_HISTORY_OBSERVATION,
  MESSAGE_PERSIST_CANONICAL_CHECKPOINT,
  MESSAGE_HISTORY_INGEST_OPEN,
  MESSAGE_HISTORY_INGEST_BATCH,
  MESSAGE_HISTORY_INGEST_COMMIT,
  MESSAGE_HISTORY_INGEST_ABORT,
  type SaveSyntheticBatchRequest,
  type SaveSyntheticBatchResponse,
  type ForwardTransportEventRequest,
  type ForwardTransportEventResponse,
  type ForwardSemanticBatchRequest,
  type NotifyBridgeObservedRequest,
  type RecordProtocolObservationRequest,
  type ForwardHistoryObservationRequest,
  type PersistCanonicalCheckpointRequest,
  type PersistCanonicalCheckpointResponse,
  type HistoryIngestOpenRequest,
  type HistoryIngestBatchRequest,
  type HistoryIngestCommitRequest,
  type HistoryIngestAbortRequest,
} from '../src/bridge/messages';
import { GenericSseDecoder } from '../src/transport/sse/decoder';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';
import { RawJournalBuffer } from '../src/storage/raw-journal/buffer';
import { extractSessionIdFromUrl } from '../src/adapters/deepseek/context/session-id';
import {
  isDeepSeekGenerationEndpoint,
  normalizePathname,
} from '../src/adapters/deepseek/compatibility/candidate-policy';
import type { DeepSeekSemanticEvent } from '../src/adapters/deepseek/protocol/types';
import { CanonicalStreamCoordinator } from '../src/core/recorder/canonical-stream-coordinator';
import { DeepSeekHistoryParser } from '../src/adapters/deepseek/history/parser';
import { StreamArchiveOverlayPortal } from '../src/overlay/portal';
import { logger } from '../src/shared/logger';

interface ActiveStreamSession {
  streamId: string;
  producerSessionId: string;
  url: string;
  status: 'active' | 'degraded' | 'terminated';
  expectedStreamSequence: number;
  sseDecoder: GenericSseDecoder;
  protocolDecoder: DeepSeekProtocolDecoder;
  canonicalCoordinator: CanonicalStreamCoordinator;
  lastActivity: number;
  sendQueue: Promise<void>;
}

interface ActiveHistoryStream {
  historyId: string;
  url: string;
  sessionId: string;
  status: number;
  chunks: string[];
  totalCharsReceived: number;
  expectedTotalChars?: number;
  nextChunkIndex: number;
  startedAt: number;
}

export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'],
  runAt: 'document_start',
  main(ctx) {
    logger.info('ISOLATED content script loaded');

    const rawJournalBuffer = new RawJournalBuffer();

    const handleFlushOnVisibility = () => {
      if (document.visibilityState === 'hidden') {
        rawJournalBuffer.flushAll();
      }
    };
    const handleFlushOnPageHide = () => {
      rawJournalBuffer.flushAll();
    };

    window.addEventListener('visibilitychange', handleFlushOnVisibility);
    window.addEventListener('pagehide', handleFlushOnPageHide);

    let pendingCanonicalCheckpointsLost = 0;
    let pendingCanonicalRevisionCount = 0;
    let canonicalDurabilityGap = false;

    // Non-destructive in-page recovery overlay portal (Shadow DOM)
    const overlayPortal = new StreamArchiveOverlayPortal();

    if (ctx && typeof ctx.onInvalidated === 'function') {
      ctx.onInvalidated(() => {
        window.removeEventListener('visibilitychange', handleFlushOnVisibility);
        window.removeEventListener('pagehide', handleFlushOnPageHide);
        overlayPortal.destroy();
        for (const session of activeSessions.values()) {
          const diag = session.canonicalCoordinator.getDiagnostics();
          if (diag.hasPendingCheckpoint || diag.unackedRevisionsCount > 0) {
            pendingCanonicalCheckpointsLost += diag.hasPendingCheckpoint ? 1 : 0;
            pendingCanonicalRevisionCount += diag.unackedRevisionsCount;
            canonicalDurabilityGap = true;
          }
          session.canonicalCoordinator.dispose();
        }
        rawJournalBuffer.destroy();
      });
    }

    // In-memory stream assembly states tied to page execution lifecycle
    function makeStreamKey(producerSessionId: string, streamId: string): string {
      return `${producerSessionId}:${streamId}`;
    }

    const activeSessions = new Map<string, ActiveStreamSession>();
    const activeHistoryStreams = new Map<string, ActiveHistoryStream>();
    const unknownSseEndpoints = new Set<string>();
    const unclassifiedStreamKeys = new Set<string>();
    const terminatedStreamKeys = new Set<string>();
    let orphanEventsCount = 0;
    let eventsAfterTerminalCount = 0;
    const MAX_TERMINATED_TOMBSTONES = 128;

    function addTerminatedTombstone(streamKey: string): void {
      if (terminatedStreamKeys.size >= MAX_TERMINATED_TOMBSTONES) {
        const oldest = terminatedStreamKeys.keys().next().value;
        if (oldest) terminatedStreamKeys.delete(oldest);
      }
      terminatedStreamKeys.add(streamKey);
    }

    function enqueueBatchSend(
      session: ActiveStreamSession,
      events: DeepSeekSemanticEvent[],
      forceSendDiagnostics = false
    ): void {
      if (events.length === 0 && !forceSendDiagnostics) return;

      const diagnostics = session.protocolDecoder.getDiagnostics();
      diagnostics.unknownSseEndpoints = Array.from(unknownSseEndpoints);
      diagnostics.orphanEventsCount = orphanEventsCount;
      diagnostics.eventsAfterTerminalCount = Math.max(diagnostics.eventsAfterTerminalCount, eventsAfterTerminalCount);

      session.sendQueue = session.sendQueue
        .then(async () => {
          try {
            const batchReq: ForwardSemanticBatchRequest = {
              type: MESSAGE_FORWARD_SEMANTIC_BATCH,
              batch: {
                streamId: session.streamId,
                producerSessionId: session.producerSessionId,
                events,
              },
              diagnostics,
            };
            await chrome.runtime.sendMessage(batchReq);
          } catch {
            // Fail-open
          }
        })
        .catch(() => {});
    }

    // Listen for events emitted across the MAIN-world bridge using lifecycle-aware listener
    ctx.addEventListener(window, STREAMARCHIVE_BRIDGE_EVENT, async (event) => {
      const customEvent = event as CustomEvent<string | unknown>;
      let rawData: unknown = customEvent.detail;

      // Parse JSON detail if serialized as string
      if (typeof rawData === 'string') {
        try {
          rawData = JSON.parse(rawData);
        } catch {
          logger.warn('Received unparseable string on bridge event');
          return;
        }
      }

      // 1. Strict Runtime Envelope Validation
      const envelope = validateBridgeEnvelope(rawData);
      if (!envelope) {
        logger.warn('Bridge event rejected: invalid envelope schema');
        return;
      }

      // 2. Handle Bridge Readiness Notice
      if (envelope.type === 'bridge.ready') {
        try {
          await chrome.runtime.sendMessage<NotifyBridgeObservedRequest, unknown>({
            type: MESSAGE_NOTIFY_BRIDGE_OBSERVED,
          });
        } catch {
          // ignore
        }
        return;
      }

      // 3. Handle Transport Events & Stateful Stream Pipeline
      if (envelope.type === 'transport.event') {
        const transportEvent = validateTransportEventPayload(envelope.payload);
        if (!transportEvent) {
          logger.warn('Bridge transport event rejected: malformed payload');
          return;
        }

        // Always notify Background of transport progress (stats/diagnostics)
        try {
          chrome.runtime.sendMessage<ForwardTransportEventRequest, ForwardTransportEventResponse>({
            type: MESSAGE_FORWARD_TRANSPORT_EVENT,
            event: transportEvent,
          }).catch(() => {});
        } catch {
          // ignore
        }

        // Execute stateful stream processing with monotonic sequence integrity
        try {
          const streamKey = makeStreamKey(transportEvent.producerSessionId, transportEvent.streamId);

          if (transportEvent.type === 'open') {
            const rawUrl = transportEvent.metadata?.url || '';
            const isGeneration = isDeepSeekGenerationEndpoint(rawUrl);
            const sanitizedPath = normalizePathname(rawUrl);

            if (!isGeneration) {
              unclassifiedStreamKeys.add(streamKey);
              if (sanitizedPath && !unknownSseEndpoints.has(sanitizedPath)) {
                unknownSseEndpoints.add(sanitizedPath);
                try {
                  chrome.runtime.sendMessage<RecordProtocolObservationRequest, unknown>({
                    type: MESSAGE_RECORD_PROTOCOL_OBSERVATION,
                    kind: 'unclassified_sse',
                    sanitizedPathname: sanitizedPath,
                    timestamp: transportEvent.timestamp,
                    producerSessionId: transportEvent.producerSessionId,
                    streamId: transportEvent.streamId,
                  }).catch(() => {});
                } catch {
                  // Fail-open
                }
              }
              // Do not instantiate DeepSeekProtocolDecoder for unclassified non-generation endpoints
              return;
            }

            if (activeSessions.has(streamKey)) {
              // Duplicate open on active stream
              const existing = activeSessions.get(streamKey)!;
              existing.protocolDecoder.recordDuplicateOpen();
              existing.status = 'degraded';
              return;
            }

            const currentRouteSessionId = extractSessionIdFromUrl(window.location.href) || undefined;

            // Immediately register stream with durable Raw Journal buffer
            rawJournalBuffer.handleOpen(transportEvent, currentRouteSessionId);

            const canonicalCoordinator = new CanonicalStreamCoordinator({
              producerSessionId: transportEvent.producerSessionId,
              streamId: transportEvent.streamId,
              provisionalSessionId: currentRouteSessionId,
              conversationTitle:
                (typeof document !== 'undefined' && document.title) ||
                `DeepSeek Chat ${transportEvent.streamId.slice(0, 8)}`,
              onCheckpoint: async (dto) => {
                const req: PersistCanonicalCheckpointRequest = {
                  type: MESSAGE_PERSIST_CANONICAL_CHECKPOINT,
                  checkpoint: {
                    streamKey: dto.streamKey,
                    checkpointSeq: dto.checkpointSeq,
                    isTerminal: dto.isFinal,
                    conversation: dto.conversation,
                    message: dto.message,
                    revisions: dto.revisions,
                    recoveryEvents: dto.recoveryEvents,
                  },
                };
                const ack = await chrome.runtime.sendMessage(req);
                if (
                  ack?.success &&
                  (dto.isFinal ||
                    dto.recoveryEvents.length > 0 ||
                    dto.message.status === 'filtered')
                ) {
                  overlayPortal.refreshSummary().catch(() => {});
                }
                return ack;
              },
            });

            const session: ActiveStreamSession = {
              streamId: transportEvent.streamId,
              producerSessionId: transportEvent.producerSessionId,
              url: rawUrl,
              status: 'active',
              expectedStreamSequence: 1, // open consumed sequence 0
              sseDecoder: new GenericSseDecoder(),
              protocolDecoder: new DeepSeekProtocolDecoder(
                transportEvent.streamId,
                currentRouteSessionId
              ),
              canonicalCoordinator,
              lastActivity: Date.now(),
              sendQueue: Promise.resolve(),
            };

            if (transportEvent.streamSequence !== 0) {
              session.protocolDecoder.recordSequenceGap();
              session.status = 'degraded';
            }

            activeSessions.set(streamKey, session);
          } else if (transportEvent.type === 'chunk' && transportEvent.chunkText) {
            const session = activeSessions.get(streamKey);
            if (!session) {
              if (unclassifiedStreamKeys.has(streamKey)) {
                // Silently ignore chunk for unclassified non-generation SSE stream
                return;
              }

              if (terminatedStreamKeys.has(streamKey)) {
                eventsAfterTerminalCount++;
                logger.warn('Chunk arrived after stream termination', {
                  streamId: transportEvent.streamId,
                  sequence: transportEvent.streamSequence,
                });
                return;
              }
              // ORPHAN CHUNK: chunk arrived without preceding 'open'
              orphanEventsCount++;
              logger.warn('Rejecting orphan chunk without active session', {
                streamId: transportEvent.streamId,
                sequence: transportEvent.streamSequence,
              });
              return;
            }

            if (session.status === 'terminated') {
              eventsAfterTerminalCount++;
              session.protocolDecoder.recordEventAfterTerminal();
              return;
            }

            // 1. FORENSIC EVIDENCE CAPTURE: Always preserve observed raw chunk in journal FIRST
            rawJournalBuffer.handleChunk(transportEvent);

            // 2. Monotonic sequence integrity check for decoder
            if (transportEvent.streamSequence !== session.expectedStreamSequence) {
              logger.warn('Stream sequence gap detected', {
                streamId: transportEvent.streamId,
                expected: session.expectedStreamSequence,
                actual: transportEvent.streamSequence,
              });
              session.protocolDecoder.recordSequenceGap();
              session.status = 'degraded';
              const degradedEvents = session.protocolDecoder.finish({
                kind: 'degraded',
                reason: `Sequence gap: expected ${session.expectedStreamSequence}, got ${transportEvent.streamSequence}`,
              });
              for (const ev of degradedEvents) {
                session.canonicalCoordinator.feedSemanticEvent(ev);
              }
              session.canonicalCoordinator.triggerCheckpoint(true);
              enqueueBatchSend(session, degradedEvents, true);
              return;
            }

            session.expectedStreamSequence++;
            session.lastActivity = Date.now();

            if (session.status === 'degraded') {
              return;
            }

            // 3. Generic SSE frame assembly
            const sseEvents = session.sseDecoder.feed(transportEvent.chunkText);

            // 4. DeepSeek protocol decoding
            const prevWarnings = session.protocolDecoder.getDiagnostics().protocolWarningsCount;
            const semanticEvents: DeepSeekSemanticEvent[] = [];
            for (const sse of sseEvents) {
              const decoded = session.protocolDecoder.feed(sse);
              if (decoded.length > 0) {
                semanticEvents.push(...decoded);
                for (const ev of decoded) {
                  session.canonicalCoordinator.feedSemanticEvent(ev);
                }
              }
            }
            const curWarnings = session.protocolDecoder.getDiagnostics().protocolWarningsCount;
            const warningsIncreased = curWarnings > prevWarnings;

            // 5. Emit semantic batch to Background via sequential queue
            if (semanticEvents.length > 0 || warningsIncreased) {
              enqueueBatchSend(session, semanticEvents, warningsIncreased);
            }
          } else if (
            transportEvent.type === 'complete' ||
            transportEvent.type === 'abort' ||
            transportEvent.type === 'error'
          ) {
            const session = activeSessions.get(streamKey);
            if (!session) {
              if (unclassifiedStreamKeys.has(streamKey)) {
                unclassifiedStreamKeys.delete(streamKey);
                return;
              }

              if (terminatedStreamKeys.has(streamKey)) {
                eventsAfterTerminalCount++;
                return;
              }
              orphanEventsCount++;
              return;
            }

            if (session.status === 'terminated') {
              eventsAfterTerminalCount++;
              session.protocolDecoder.recordEventAfterTerminal();
              return;
            }

            // 1. Verify terminal sequence continuity BEFORE emitting terminal metadata
            let terminalSequenceGap = false;
            if (transportEvent.streamSequence !== session.expectedStreamSequence) {
              session.protocolDecoder.recordSequenceGap();
              session.status = 'degraded';
              terminalSequenceGap = true;
            }

            // 2. Finalize raw stream persistence with accurate terminal reason
            const rawTerminalReason = terminalSequenceGap
              ? (transportEvent.reason ? `${transportEvent.reason} (terminal sequence gap)` : 'Terminal sequence gap')
              : transportEvent.reason;

            rawJournalBuffer.handleTerminal(
              {
                ...transportEvent,
                reason: rawTerminalReason,
              },
              { sequenceGap: terminalSequenceGap }
            );

            session.status = 'terminated';
            addTerminatedTombstone(streamKey);

            const finalSse = session.sseDecoder.finish();
            const semanticEvents: DeepSeekSemanticEvent[] = [];

            for (const sse of finalSse) {
              const decoded = session.protocolDecoder.feed(sse);
              if (decoded.length > 0) {
                semanticEvents.push(...decoded);
                for (const ev of decoded) {
                  session.canonicalCoordinator.feedSemanticEvent(ev);
                }
              }
            }

            const terminalContext =
              transportEvent.type === 'abort'
                ? { kind: 'transport_abort' as const, reason: transportEvent.reason || 'transport_abort' }
                : transportEvent.type === 'error'
                  ? { kind: 'transport_error' as const, error: transportEvent.reason || 'transport_error' }
                  : { kind: 'transport_complete' as const };

            const terminalEvents = session.protocolDecoder.finish(terminalContext);
            semanticEvents.push(...terminalEvents);
            for (const ev of terminalEvents) {
              session.canonicalCoordinator.feedSemanticEvent(ev);
            }

            enqueueBatchSend(session, semanticEvents, true);

            // Flush and finalize canonical checkpoint sequentially before cleaning up session
            session.sendQueue = session.sendQueue.then(async () => {
              try {
                await session.canonicalCoordinator.triggerCheckpoint(true);
              } catch (err) {
                logger.warn('Failed to commit final canonical checkpoint', err);
              } finally {
                session.canonicalCoordinator.dispose();
              }
            });

            // Clean up session once final queue finishes
            session.sendQueue.finally(() => {
              activeSessions.delete(streamKey);
            });
          }
        } catch (err) {
          logger.warn('Error in content script stream pipeline', err);
        }

        return;
      }

      // 4a. Handle Streaming Bounded History: Open
      if (envelope.type === 'history.open') {
        const payload = validateHistoryStreamOpenPayload(envelope.payload);
        if (!payload) {
          logger.warn('Bridge history.open rejected: invalid schema');
          return;
        }
        if (activeHistoryStreams.size >= 10) {
          const oldest = activeHistoryStreams.keys().next().value;
          if (oldest) activeHistoryStreams.delete(oldest);
        }
        activeHistoryStreams.set(payload.historyId, {
          historyId: payload.historyId,
          url: payload.url,
          sessionId: payload.sessionId,
          status: payload.status,
          chunks: [],
          totalCharsReceived: 0,
          expectedTotalChars: payload.totalChars,
          nextChunkIndex: 0,
          startedAt: payload.timestamp,
        });
        return;
      }

      // 4b. Handle Streaming Bounded History: Chunk
      if (envelope.type === 'history.chunk') {
        const payload = validateHistoryStreamChunkPayload(envelope.payload);
        if (!payload) {
          logger.warn('Bridge history.chunk rejected: invalid schema');
          return;
        }
        const histStream = activeHistoryStreams.get(payload.historyId);
        if (!histStream) {
          logger.warn('Bridge history.chunk rejected: unknown history stream', payload.historyId);
          return;
        }
        if (payload.chunkIndex !== histStream.nextChunkIndex) {
          logger.warn('Bridge history.chunk gap detected, aborting stream', {
            expected: histStream.nextChunkIndex,
            actual: payload.chunkIndex,
          });
          activeHistoryStreams.delete(payload.historyId);
          return;
        }
        if (histStream.totalCharsReceived + payload.chunkText.length > MAX_HISTORY_TOTAL_CHARS) {
          logger.warn('Bridge history stream exceeded max 25MB bound, aborting', payload.historyId);
          activeHistoryStreams.delete(payload.historyId);
          return;
        }
        if (histStream.chunks.length >= MAX_HISTORY_CHUNKS_COUNT) {
          logger.warn('Bridge history stream exceeded max chunks limit, aborting', payload.historyId);
          activeHistoryStreams.delete(payload.historyId);
          return;
        }
        histStream.chunks.push(payload.chunkText);
        histStream.totalCharsReceived += payload.chunkText.length;
        histStream.nextChunkIndex++;
        return;
      }

      // 4c. Handle Streaming Bounded History: Complete
      if (envelope.type === 'history.complete') {
        const payload = validateHistoryStreamCompletePayload(envelope.payload);
        if (!payload) {
          logger.warn('Bridge history.complete rejected: invalid schema');
          return;
        }
        const histStream = activeHistoryStreams.get(payload.historyId);
        if (!histStream) {
          logger.warn('Bridge history.complete rejected: unknown history stream', payload.historyId);
          return;
        }
        activeHistoryStreams.delete(payload.historyId);

        if (histStream.totalCharsReceived !== payload.totalChars) {
          logger.warn('Bridge history.complete char count mismatch, discarding stream', {
            expected: payload.totalChars,
            actual: histStream.totalCharsReceived,
          });
          return;
        }

        const fullBody = histStream.chunks.join('');
        const parsed = DeepSeekHistoryParser.parse(fullBody, {
          expectedSessionId: histStream.sessionId,
          observedAt: histStream.startedAt,
        });
        if (!parsed) {
          logger.warn('Bridge history stream failed schema validation');
          return;
        }

        (async () => {
          const stagingId =
            typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : `stage_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

          const BATCH_SIZE = 50;
          const messages = parsed.messages;
          const totalBatches = Math.max(1, Math.ceil(messages.length / BATCH_SIZE));

          try {
            // 1. Open staging
            const openReq: HistoryIngestOpenRequest = {
              type: MESSAGE_HISTORY_INGEST_OPEN,
              stagingId,
              sessionId: parsed.session.sessionId,
              totalBatches,
              totalMessages: messages.length,
              timestamp: histStream.startedAt,
            };
            await chrome.runtime.sendMessage(openReq);

            // 2. Send bounded batches
            for (let b = 0; b < totalBatches; b++) {
              const start = b * BATCH_SIZE;
              const batchMessages = messages.slice(start, start + BATCH_SIZE);
              const batchReq: HistoryIngestBatchRequest = {
                type: MESSAGE_HISTORY_INGEST_BATCH,
                stagingId,
                batchIndex: b,
                session: b === 0 ? parsed.session : undefined,
                messages: batchMessages,
              };
              await chrome.runtime.sendMessage(batchReq);
            }

            // 3. Commit staging
            const commitReq: HistoryIngestCommitRequest = {
              type: MESSAGE_HISTORY_INGEST_COMMIT,
              stagingId,
            };
            await chrome.runtime.sendMessage(commitReq);
            overlayPortal.refreshSummary().catch(() => {});
          } catch (err) {
            logger.warn('Error in bounded history staging transfer; aborting', err);
            try {
              const abortReq: HistoryIngestAbortRequest = {
                type: MESSAGE_HISTORY_INGEST_ABORT,
                stagingId,
                reason: err instanceof Error ? err.message : String(err),
              };
              await chrome.runtime.sendMessage(abortReq);
            } catch {
              // ignore
            }
          }
        })().catch(() => {});
        return;
      }

      // 4d. Handle Streaming Bounded History: Abort
      if (envelope.type === 'history.abort') {
        const payload = validateHistoryStreamAbortPayload(envelope.payload);
        if (payload) {
          activeHistoryStreams.delete(payload.historyId);
        }
        return;
      }

      // 4e. Handle Legacy Direct History Observation (backward compatibility)
      if (envelope.type === 'history.observation') {
        const payload = validateHistoryObservationPayload(envelope.payload);
        if (!payload) {
          logger.warn('Bridge history payload rejected: invalid schema');
          return;
        }

        try {
          const req: ForwardHistoryObservationRequest = {
            type: MESSAGE_FORWARD_HISTORY_OBSERVATION,
            payload,
          };
          chrome.runtime.sendMessage(req).catch((err) => {
            logger.warn('Failed to forward history observation to background', err);
          });
        } catch (err) {
          logger.warn('Error forwarding history observation', err);
        }
        return;
      }

      // 5. Handle Explicit Synthetic Diagnostic Payload (Only if requested)
      if (envelope.type === 'synthetic.test') {
        const payload = validateSyntheticPayload(envelope.payload);
        if (!payload) {
          logger.warn('Bridge synthetic payload rejected: invalid payload schema');
          return;
        }

        await processSyntheticPayload(payload);
      }
    });

    // Listen for extension commands to dispatch synthetic diagnostic test to MAIN world
    chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === 'STREAMARCHIVE_REQUEST_PAGE_SYNTHETIC') {
        window.dispatchEvent(new CustomEvent('streamarchive:trigger-synthetic-test'));
      }
    });
  },
});

async function processSyntheticPayload(payload: SyntheticTestPayload): Promise<void> {
  const convId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `conv_${Date.now()}`;
  const msgId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `msg_${Date.now()}`;
  const revId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `rev_${Date.now()}`;
  const now = Date.now();

  const batchRequest: SaveSyntheticBatchRequest = {
    type: MESSAGE_SAVE_SYNTHETIC_BATCH,
    batchSeq: 1,
    data: {
      conversation: {
        id: convId,
        title: payload.conversationTitle,
        createdAt: now,
        updatedAt: now,
      },
      message: {
        id: msgId,
        conversationId: convId,
        role: 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        createdAt: now,
        updatedAt: now,
      },
      revision: {
        id: revId,
        messageId: msgId,
        revisionIndex: 1,
        text: payload.responseText,
        source: 'synthetic',
        capturedAt: now,
        isFinal: true,
        isLastGood: true,
      },
    },
  };

  try {
    const response = await chrome.runtime.sendMessage<
      SaveSyntheticBatchRequest,
      SaveSyntheticBatchResponse
    >(batchRequest);

    if (response && response.success) {
      logger.info('✓ Received ACK from Background Service Worker for synthetic diagnostic batch', {
        batchSeq: response.batchSeq,
        persistedAt: response.persistedAt,
      });
    }
  } catch (err) {
    logger.error('Failed to communicate with Background Service Worker for synthetic batch', err);
  }
}
