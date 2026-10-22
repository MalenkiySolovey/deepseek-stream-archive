import { defineContentScript } from 'wxt/utils/define-content-script';
import {
  BRIDGE_SOURCE_TAG,
  BRIDGE_PROTOCOL_VERSION,
  STREAMARCHIVE_BRIDGE_EVENT,
  type StreamArchiveBridgeEnvelope,
  type SyntheticTestPayload,
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

    // Install passive transport observers
    installFetchCapture({
      producerSessionId,
      onEvent: handleTransportEvent,
      nextSequence,
      isCandidate,
      onHistoryObservation: handleHistoryObservation,
      isHistoryCandidate: isDeepSeekHistoryEndpoint,
    });

    installXhrCapture({
      producerSessionId,
      onEvent: handleTransportEvent,
      nextSequence,
      isCandidate,
      onHistoryObservation: handleHistoryObservation,
      isHistoryCandidate: isDeepSeekHistoryEndpoint,
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
