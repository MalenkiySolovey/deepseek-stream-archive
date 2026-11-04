import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  BRIDGE_SOURCE_TAG,
  BRIDGE_PROTOCOL_VERSION,
  STREAMARCHIVE_BRIDGE_EVENT,
  STREAMARCHIVE_CONTINUITY_ARM_EVENT,
  STREAMARCHIVE_CONTINUITY_REVOKE_EVENT,
  type StreamArchiveBridgeEnvelope,
  type SyntheticTestPayload,
  type ContinuityDispatchedPayload,
  type ContinuitySkippedPayload,
} from '../src/bridge/protocol';
import type { TransportEvent } from '../src/transport/types';
import { installFetchCapture } from '../src/transport/fetch/capture';
import { installXhrCapture } from '../src/transport/xhr/capture';
import { createDeepSeekCandidatePredicate } from '../src/adapters/deepseek/compatibility/candidate-policy';
import {
  isDeepSeekHistoryEndpoint,
  extractHistorySessionId,
} from '../src/adapters/deepseek/history/capture-policy';
import type { HistoryObservationPayload } from '../src/bridge/protocol';
import { augmentDeepSeekRequest } from '../src/adapters/deepseek/request/augment';
import {
  isDeepSeekUserGenerationEndpoint,
  parseDeepSeekRequestBody,
} from '../src/adapters/deepseek/request/parser';
import type { ContextDeliveryEnvelope } from '../src/adapters/deepseek/request/types';
import { logger } from '../src/shared/logger';

const TRANSPORT_HOOK_KEY = Symbol.for('__STREAMARCHIVE_MAIN_HOOK__');
const CURRENT_HOOK_VERSION = 1;

interface HookSentinel {
  version: number;
  installedAt: number;
  producerSessionId: string;
}

export default defineContentScript({
  matches: ['https://chat.deepseek.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const target = typeof window !== 'undefined' ? (window as any) : (globalThis as any);
    const existingHook: HookSentinel | undefined = target[TRANSPORT_HOOK_KEY];

    if (existingHook) {
      if (existingHook.version !== CURRENT_HOOK_VERSION) {
        logger.warn(
          `[StreamArchive] Incompatible transport hook v${existingHook.version} detected (current v${CURRENT_HOOK_VERSION}). Reload DeepSeek page to activate updated interceptor.`
        );
      } else {
        logger.info(
          `[StreamArchive] Transport hook already installed for session ${existingHook.producerSessionId}. Avoiding double wrap.`
        );
      }
      return;
    }

    logger.info('MAIN-world transport tap initialized');

    // Producer session identity created once per context lifecycle
    const producerSessionId =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `prod_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    target[TRANSPORT_HOOK_KEY] = {
      version: CURRENT_HOOK_VERSION,
      installedAt: Date.now(),
      producerSessionId,
    };

    let sequenceCounter = 0;
    const nextSequence = () => ++sequenceCounter;

    const dispatchBridgeEnvelope = <T>(type: any, payload: T) => {
      const eventId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `evt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      const envelope: StreamArchiveBridgeEnvelope<T> = {
        source: BRIDGE_SOURCE_TAG,
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        eventId,
        type,
        timestamp: Date.now(),
        payload,
      };

      try {
        window.dispatchEvent(
          new CustomEvent(STREAMARCHIVE_BRIDGE_EVENT, {
            detail: JSON.stringify(envelope),
          })
        );
      } catch (err) {
        logger.error('Failed to dispatch bridge envelope', err);
      }
    };

    // Forward captured transport events across MAIN -> ISOLATED boundary
    const handleTransportEvent = (event: TransportEvent) => {
      dispatchBridgeEnvelope('transport.event', event);
    };

    const MAX_HIST_CHUNK_SIZE = 65536; // 64 KiB
    const MAX_HIST_TOTAL_CHARS = 25 * 1024 * 1024; // 25 MB

    // Forward passive history observations across MAIN -> ISOLATED boundary in bounded chunks
    const handleHistoryObservation = (obs: { url: string; status: number; body: string }) => {
      const sessionId = extractHistorySessionId(obs.url) || '';
      const body = obs.body || '';

      if (body.length > MAX_HIST_TOTAL_CHARS) {
        logger.warn('[StreamArchive] Captured history payload exceeds 25MB bound, dropped');
        return;
      }

      const historyId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `hist_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      const now = Date.now();

      // Emit history.open
      dispatchBridgeEnvelope('history.open', {
        historyId,
        url: obs.url,
        sessionId,
        status: obs.status,
        timestamp: now,
        totalChars: body.length,
      });

      // Emit chunk(s)
      let chunkIndex = 0;
      for (let offset = 0; offset < body.length; offset += MAX_HIST_CHUNK_SIZE) {
        const chunkText = body.slice(offset, offset + MAX_HIST_CHUNK_SIZE);
        dispatchBridgeEnvelope('history.chunk', {
          historyId,
          chunkIndex: chunkIndex++,
          chunkText,
        });
      }

      if (body.length === 0) {
        dispatchBridgeEnvelope('history.chunk', {
          historyId,
          chunkIndex: 0,
          chunkText: '',
        });
      }

      // Emit history.complete
      dispatchBridgeEnvelope('history.complete', {
        historyId,
        totalChars: body.length,
        timestamp: Date.now(),
      });
    };

    const isCandidate = createDeepSeekCandidatePredicate();

    const handleHistoryStreamEvent = (
      ev: import('../src/transport/fetch/capture').HistoryStreamCaptureEvent
    ) => {
      if (ev.type === 'open') {
        const sessionId = extractHistorySessionId(ev.url) || '';
        dispatchBridgeEnvelope('history.open', {
          historyId: ev.historyId,
          url: ev.url,
          sessionId,
          status: ev.status,
          timestamp: ev.timestamp,
        });
      } else if (ev.type === 'chunk') {
        dispatchBridgeEnvelope('history.chunk', {
          historyId: ev.historyId,
          chunkIndex: ev.chunkIndex,
          chunkText: ev.chunkText,
        });
      } else if (ev.type === 'complete') {
        dispatchBridgeEnvelope('history.complete', {
          historyId: ev.historyId,
          totalChars: ev.totalChars,
          timestamp: ev.timestamp,
        });
      } else if (ev.type === 'abort') {
        dispatchBridgeEnvelope('history.abort', {
          historyId: ev.historyId,
          reason: ev.reason,
        });
      }
    };

    // ── Context Continuity Delivery Envelope (MAIN world) ──
    let activeEnvelope: ContextDeliveryEnvelope | null = null;
    const bodyToTurnIdMap = new Map<unknown, string>();
    const promptToTurnIdMap = new Map<string, string>();
    let lastObservedTurn: {
      clientTurnId: string;
      prompt: string;
      parentTurnId?: string | null;
      sessionId?: string;
      timestamp: number;
    } | null = null;

    window.addEventListener(STREAMARCHIVE_CONTINUITY_ARM_EVENT, (event: any) => {
      try {
        const detail = typeof event.detail === 'string' ? JSON.parse(event.detail) : event.detail;
        if (detail && detail.deliveryId && detail.formattedContext) {
          activeEnvelope = detail as ContextDeliveryEnvelope;
          logger.info(`[StreamArchive] MAIN: Armed continuity delivery envelope ${detail.deliveryId}`);
        }
      } catch (err) {
        logger.warn('[StreamArchive] MAIN: Failed to parse continuity arm event', err);
      }
    });

    window.addEventListener(STREAMARCHIVE_CONTINUITY_REVOKE_EVENT, () => {
      if (activeEnvelope) {
        logger.info(`[StreamArchive] MAIN: Revoked continuity delivery envelope ${activeEnvelope.deliveryId}`);
        activeEnvelope = null;
      }
    });

    const handleOutgoingRequest = (
      url: string,
      method: string,
      body: unknown,
      transport: 'fetch' | 'xhr'
    ): { body?: unknown } | undefined => {
      let finalBody: unknown = body;
      let originalUserPrompt: string | undefined = undefined;

      if (activeEnvelope) {
        const augResult = augmentDeepSeekRequest({
          url,
          method,
          body,
          envelope: activeEnvelope,
        });

        if (augResult.augmented) {
          const env = activeEnvelope;
          if (env.deliveryMode === 'manual_next') {
            activeEnvelope = null;
          }

          const dispatchedPayload: ContinuityDispatchedPayload = {
            deliveryId: augResult.deliveryId,
            conversationId: env.conversationId,
            remoteConversationId: env.remoteConversationId,
            parentMessageId: env.expectedParentMessageId,
            sourceMessageIds: env.sourceMessageIds,
            sourceRevisionIds: env.sourceRevisionIds,
            deliveryMode: env.deliveryMode,
            transport,
            timestamp: Date.now(),
          };
          dispatchBridgeEnvelope('continuity.dispatched', dispatchedPayload);

          logger.info(`[StreamArchive] Injected recovered context into DeepSeek prompt (delivery ${augResult.deliveryId})`);
          finalBody = augResult.augmentedBody;
          originalUserPrompt = augResult.originalPrompt;
        } else {
          if (augResult.reason !== 'not_candidate_endpoint') {
            const skippedPayload: ContinuitySkippedPayload = {
              deliveryId: activeEnvelope?.deliveryId,
              reason: augResult.reason,
              url,
              timestamp: Date.now(),
            };
            dispatchBridgeEnvelope('continuity.skipped', skippedPayload);
            logger.info(`[StreamArchive] Continuity skipped: ${augResult.reason}`);
          }
        }
      }

      // Immediate User Prompt Persistence (Section 6)
      if (isDeepSeekUserGenerationEndpoint(url, method)) {
        const parsed = parseDeepSeekRequestBody(finalBody);
        if (parsed && typeof parsed.prompt === 'string' && parsed.prompt.trim().length > 0) {
          const userPromptText = originalUserPrompt || parsed.prompt;
          const parentTurnId =
            parsed.parent_message_id !== undefined
              ? (parsed.parent_message_id ? String(parsed.parent_message_id) : null)
              : undefined;
          const reqSessionId = parsed.chat_session_id ? String(parsed.chat_session_id) : undefined;

          let clientTurnId: string;
          if (
            lastObservedTurn &&
            lastObservedTurn.prompt.trim() === userPromptText.trim() &&
            lastObservedTurn.sessionId === reqSessionId &&
            lastObservedTurn.parentTurnId === parentTurnId &&
            Date.now() - lastObservedTurn.timestamp < 15000
          ) {
            clientTurnId = lastObservedTurn.clientTurnId;
          } else {
            clientTurnId =
              typeof crypto !== 'undefined' && crypto.randomUUID
                ? `turn_user_${crypto.randomUUID()}`
                : `turn_user_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          }

          bodyToTurnIdMap.set(finalBody, clientTurnId);
          if (body !== finalBody) {
            bodyToTurnIdMap.set(body, clientTurnId);
          }

          promptToTurnIdMap.set(userPromptText.trim(), clientTurnId);
          if (parsed.prompt && parsed.prompt.trim() !== userPromptText.trim()) {
            promptToTurnIdMap.set(parsed.prompt.trim(), clientTurnId);
          }

          lastObservedTurn = {
            clientTurnId,
            prompt: userPromptText,
            parentTurnId,
            sessionId: reqSessionId,
            timestamp: Date.now(),
          };

          dispatchBridgeEnvelope('user_turn.observed', {
            clientTurnId,
            sessionId: reqSessionId,
            prompt: userPromptText,
            parentTurnId,
            transport,
            timestamp: Date.now(),
          });

          logger.info(`[StreamArchive] Observed user prompt outgoing turn: ${clientTurnId}`);
        }
      }

      return finalBody !== body ? { body: finalBody } : undefined;
    };

    const extractDeepSeekRequestMetadata = (context: { method: string; url: string; body: unknown }): Partial<import('../src/transport/types').TransportMetadata> | undefined => {
      const parsed = parseDeepSeekRequestBody(context.body);
      if (!parsed) return undefined;

      let clientTurnId = bodyToTurnIdMap.get(context.body);
      if (!clientTurnId && typeof parsed.prompt === 'string') {
        const trimmed = parsed.prompt.trim();
        clientTurnId = promptToTurnIdMap.get(trimmed);
        if (!clientTurnId && lastObservedTurn && Date.now() - lastObservedTurn.timestamp < 15000) {
          if (lastObservedTurn.prompt.trim() === trimmed) {
            clientTurnId = lastObservedTurn.clientTurnId;
          }
        }
      }

      return {
        clientTurnId,
        requestPrompt: typeof parsed.prompt === 'string' ? parsed.prompt : undefined,
        requestParentTurnId: parsed.parent_message_id !== undefined ? (parsed.parent_message_id ? String(parsed.parent_message_id) : null) : undefined,
        requestSessionId: parsed.chat_session_id ? String(parsed.chat_session_id) : undefined,
      };
    };

    // Install passive transport observers
    installFetchCapture({
      producerSessionId,
      onEvent: handleTransportEvent,
      nextSequence,
      isCandidate,
      onHistoryStreamEvent: handleHistoryStreamEvent,
      isHistoryCandidate: isDeepSeekHistoryEndpoint,
      onRequestMetadata: extractDeepSeekRequestMetadata,
      onRequest(input, init) {
        const url = typeof input === 'string' ? input : 'url' in input ? input.url : input.toString();
        const method = (init?.method || (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
        const body = init?.body ?? (typeof input === 'object' && 'body' in input ? (input as any).body : undefined);

        const res = handleOutgoingRequest(url, method, body, 'fetch');
        if (res && res.body !== undefined) {
          return {
            init: {
              ...init,
              body: res.body as any,
            },
          };
        }
        return undefined;
      },
    });

    installXhrCapture({
      producerSessionId,
      onEvent: handleTransportEvent,
      nextSequence,
      isCandidate,
      onHistoryObservation: handleHistoryObservation,
      isHistoryCandidate: isDeepSeekHistoryEndpoint,
      onRequestMetadata: extractDeepSeekRequestMetadata,
      onRequest(ctx) {
        return handleOutgoingRequest(ctx.url, ctx.method, ctx.body, 'xhr');
      },
    });

    // Announce bridge readiness to ISOLATED world
    dispatchBridgeEnvelope('bridge.ready', { producerSessionId });

    // Explicit diagnostic trigger (invoked only on explicit demand, NOT on page load)
    window.addEventListener('streamarchive:trigger-synthetic-test', () => {
      const syntheticPayload: SyntheticTestPayload = {
        testId: `diag_${Date.now()}`,
        conversationTitle: 'Explicit Diagnostic Test',
        promptText: 'Manual trigger test from Side Panel diagnostic action.',
        responseText: 'Synthetic diagnostic verification payload transferred through pipeline.',
        source: 'synthetic',
      };
      dispatchBridgeEnvelope('synthetic.test', syntheticPayload);
    });
  },
});
