import type { SseEvent } from '../../../transport/sse/types';
import type { DeepSeekCompatibilityProfile } from '../compatibility/types';
import { DEFAULT_DEEPSEEK_PROFILE } from '../compatibility/profiles';
import { DeepSeekPatchApplier, MAX_BATCH_DEPTH, MAX_BATCH_ITEMS } from './patch-applier';
import {
  computeTextDiff,
  projectDeepSeekState,
} from './fragment-projector';
import type {
  DeepSeekLastGoodState,
  DeepSeekProjectedContent,
  DeepSeekProtocolDiagnosticsData,
  DeepSeekRawPatch,
  DeepSeekSemanticEvent,
  ProjectionSource,
  ProtocolCompatibilityState,
  ProtocolWarningCode,
  StreamTerminalContext,
  TerminalReason,
} from './types';

const MAX_SCAN_DEPTH = 5;
const MAX_SCAN_NODES = 50;

const INTEGRITY_THREATENING_WARNINGS = new Set<ProtocolWarningCode>([
  'unknown_operation',
  'invalid_path',
  'path_too_deep',
  'batch_too_large',
  'batch_too_deep',
  'array_index_too_large',
  'invalid_negative_index',
  'stream_sequence_gap',
  'malformed_json',
]);

/**
 * High-performance stateful decoder for DeepSeek stream protocol.
 * Consumes WHATWG SseEvent instances and emits semantic domain events.
 */
export class DeepSeekProtocolDecoder {
  private readonly streamId: string;
  private readonly sessionId?: string;
  private readonly profile: DeepSeekCompatibilityProfile;
  private readonly patchApplier: DeepSeekPatchApplier;

  private sequenceCounter = 0;
  private isStarted = false;
  private isFinished = false;
  private filterTriggered = false;
  private lastGoodState?: DeepSeekLastGoodState;

  private currentMessageId?: string;
  private lastProjectedAnswer = '';
  private lastProjectedThinking = '';
  private currentProjectionSource: ProjectionSource = 'none';

  // Live Acceptance Gate state: runtime stream starts at 'not_observed'
  private compatibilityState: ProtocolCompatibilityState = 'not_observed';
  private validFramesSeen = 0;
  private validPatchesSeen = 0;

  // Diagnostics counters
  private parsedFramesCount = 0;
  private opsCount = {
    set: 0,
    append: 0,
    replace: 0,
    batch: 0,
    other: 0,
  };
  private filterEventsCount = 0;
  private lastFilterEvent?: { reason: string; timestamp: number; messageId?: string };
  private lastTerminalReason?: TerminalReason;
  private finishObserved = false;
  private closeObserved = false;
  private sequenceGapsCount = 0;
  private orphanEventsCount = 0;
  private duplicateOpensCount = 0;
  private eventsAfterTerminalCount = 0;
  private protocolWarningsCount = 0;
  private unknownSseEndpoints: string[] = [];
  private unknownSseEventNames = new Set<string>();
  private recentWarnings: string[] = [];

  constructor(
    streamId: string,
    sessionId?: string,
    profile: DeepSeekCompatibilityProfile = DEFAULT_DEEPSEEK_PROFILE
  ) {
    this.streamId = streamId;
    this.sessionId = sessionId;
    this.profile = profile;
    this.patchApplier = new DeepSeekPatchApplier(undefined, (code, msg) => {
      this.recordWarning(code, msg);
    });
  }

  private nextSeq(): number {
    return ++this.sequenceCounter;
  }

  public recordWarning(code: ProtocolWarningCode, message: string): void {
    this.protocolWarningsCount++;
    const formatted = `[${code}] ${message}`;
    if (this.recentWarnings.length >= 10) {
      this.recentWarnings.shift();
    }
    this.recentWarnings.push(formatted);

    // If warning threatens protocol integrity, transition to degraded
    if (INTEGRITY_THREATENING_WARNINGS.has(code)) {
      this.compatibilityState = 'degraded';
    }
  }

  public setCompatibilityState(state: ProtocolCompatibilityState): void {
    this.compatibilityState = state;
  }

  public recordSequenceGap(): void {
    this.sequenceGapsCount++;
    this.recordWarning('stream_sequence_gap', `Sequence gap detected on stream ${this.streamId}`);
  }

  public recordDuplicateOpen(): void {
    this.duplicateOpensCount++;
    this.recordWarning('duplicate_open', `Duplicate open event on stream ${this.streamId}`);
  }

  public recordEventAfterTerminal(): void {
    this.eventsAfterTerminalCount++;
    this.recordWarning('event_after_terminal', `Event received after terminal on stream ${this.streamId}`);
  }

  /**
   * Evaluates criteria to promote compatibilityState from 'not_observed' to 'live_observed'.
   */
  private evaluateLiveObservedGate(): void {
    if (this.compatibilityState === 'degraded' || this.compatibilityState === 'incompatible') {
      return;
    }
    const hasRecognizedProjection = this.lastProjectedAnswer.length > 0 || this.lastProjectedThinking.length > 0;
    const hasTerminal = this.isFinished;

    if (
      this.validFramesSeen >= 1 &&
      this.validPatchesSeen >= 1 &&
      (hasRecognizedProjection || hasTerminal)
    ) {
      this.compatibilityState = 'live_observed';
    }
  }

  /**
   * Feeds a single parsed SseEvent and returns any generated semantic events.
   */
  feed(event: SseEvent): DeepSeekSemanticEvent[] {
    const semanticEvents: DeepSeekSemanticEvent[] = [];

    const rawEvent = event.event?.trim();
    const eventName = rawEvent && rawEvent.length > 0 ? rawEvent : 'message';

    // 0. Verify event name against compatibility profile
    if (!this.profile.knownEventNames.includes(eventName)) {
      this.unknownSseEventNames.add(eventName);
      this.recordWarning('unknown_sse_event_name', `Unknown SSE event name: ${eventName}`);
      return semanticEvents;
    }

    // Trailing event handling: legal control events after terminal are allowed and do NOT increment eventsAfterTerminal
    if (this.isFinished) {
      if (eventName === 'finish' || eventName === 'close' || eventName === 'update_session' || eventName === 'title') {
        if (eventName === 'finish') this.finishObserved = true;
        if (eventName === 'close') this.closeObserved = true;
        return semanticEvents;
      }
      this.recordEventAfterTerminal();
      return semanticEvents;
    }

    if (!this.isStarted) {
      this.isStarted = true;
      semanticEvents.push({
        type: 'stream_start',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        sessionId: this.sessionId,
      });
    }

    const rawData = event.data?.trim();

    // Handle SSE Control Events prior to terminal
    if (eventName === 'ready') {
      if (rawData) {
        try {
          const readyJson = JSON.parse(rawData);
          const msgId = readyJson?.response_message_id ?? readyJson?.message_id;
          if (msgId !== undefined && msgId !== null) {
            const strId = String(msgId).trim();
            if (strId && strId !== this.currentMessageId) {
              this.currentMessageId = strId;
              semanticEvents.push({
                type: 'message_id_identified',
                streamId: this.streamId,
                sequence: this.nextSeq(),
                timestamp: Date.now(),
                messageId: this.currentMessageId,
                sessionId: this.sessionId,
              });
            }
          }
        } catch {
          // ignore non-json ready frame
        }
      }
      return semanticEvents;
    }

    if (eventName === 'update_session') {
      return semanticEvents;
    }

    if (eventName === 'title') {
      return semanticEvents;
    }

    if (eventName === 'finish') {
      this.finishObserved = true;
      if (!this.isFinished) {
        const currentStatus = this.patchApplier.getStatus();
        let terminalReason: TerminalReason | undefined = undefined;

        if (this.filterTriggered || currentStatus === 'CONTENT_FILTER') {
          terminalReason = 'filtered';
        } else if (currentStatus === 'FINISHED') {
          const hasPending = this.patchApplier.hasPendingFragment() ?? false;
          const isIncomplete = this.patchApplier.incompleteMessage() ?? false;
          terminalReason = (hasPending || isIncomplete) ? 'incomplete' : 'completed';
        } else if (currentStatus === 'INCOMPLETE') {
          terminalReason = 'incomplete';
        } else if (currentStatus === 'TIMEOUT') {
          terminalReason = 'timeout';
        } else if (currentStatus === 'CONTEXT_LENGTH_EXCEEDED') {
          terminalReason = 'truncated_context_limit';
        }

        if (terminalReason) {
          this.isFinished = true;
          this.lastTerminalReason = terminalReason;
          this.evaluateLiveObservedGate();
          semanticEvents.push({
            type: 'stream_finished',
            streamId: this.streamId,
            sequence: this.nextSeq(),
            timestamp: Date.now(),
            messageId: this.currentMessageId,
            sessionId: this.sessionId,
            status: currentStatus || (terminalReason === 'filtered' ? 'CONTENT_FILTER' : 'FINISHED'),
            terminalReason,
            hasPendingFragment: this.patchApplier.hasPendingFragment() ?? false,
            incompleteMessage: this.patchApplier.incompleteMessage() ?? false,
            projectionSource: this.currentProjectionSource,
          });
        }
      }
      return semanticEvents;
    }

    if (eventName === 'close') {
      this.closeObserved = true;
      if (!this.isFinished) {
        const currentStatus = this.patchApplier.getStatus();
        let terminalReason: TerminalReason = 'closed_without_resolved_status';

        if (this.filterTriggered || currentStatus === 'CONTENT_FILTER') {
          terminalReason = 'filtered';
        } else if (currentStatus === 'FINISHED') {
          terminalReason = 'completed';
        } else if (currentStatus === 'INCOMPLETE') {
          terminalReason = 'incomplete';
        } else if (currentStatus === 'TIMEOUT') {
          terminalReason = 'timeout';
        } else if (currentStatus === 'CONTEXT_LENGTH_EXCEEDED') {
          terminalReason = 'truncated_context_limit';
        }

        this.isFinished = true;
        this.lastTerminalReason = terminalReason;
        this.evaluateLiveObservedGate();
        semanticEvents.push({
          type: 'stream_finished',
          streamId: this.streamId,
          sequence: this.nextSeq(),
          timestamp: Date.now(),
          messageId: this.currentMessageId,
          sessionId: this.sessionId,
          status: currentStatus || (terminalReason === 'filtered' ? 'CONTENT_FILTER' : 'CLOSED'),
          terminalReason,
          projectionSource: this.currentProjectionSource,
        });
      }
      return semanticEvents;
    }

    if (!rawData) {
      return semanticEvents;
    }

    // 1. Detect standard [DONE] SSE sentinel (Supported defensively, not required)
    if (rawData === '[DONE]') {
      this.isFinished = true;
      this.lastTerminalReason = 'completed';
      this.evaluateLiveObservedGate();
      semanticEvents.push({
        type: 'stream_finished',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        status: 'FINISHED',
        terminalReason: 'completed',
        projectionSource: this.currentProjectionSource,
      });
      return semanticEvents;
    }

    // 2. Parse JSON patch
    let parsed: any;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      this.recordWarning('malformed_json', 'Unparseable SSE JSON frame ignored');
      return semanticEvents;
    }

    this.parsedFramesCount++;
    this.validFramesSeen++;

    // 3. Detect-Before-Apply: Structural scan for censorship or refusal markers
    const filterReason = this.detectCensorship(parsed);
    if (filterReason && !this.filterTriggered) {
      this.filterTriggered = true;
      this.filterEventsCount++;

      // Freeze current valid projected state prior to patch mutation
      const currentProj = projectDeepSeekState(this.patchApplier.getState());
      this.lastGoodState = {
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        answer: currentProj.answer,
        thinking: currentProj.thinking,
        fragments: structuredClone(this.patchApplier.getFragments()),
        capturedAt: Date.now(),
        reason: filterReason,
        projectionSource: currentProj.source,
      };

      this.lastFilterEvent = {
        reason: filterReason,
        timestamp: Date.now(),
        messageId: this.currentMessageId,
      };

      semanticEvents.push({
        type: 'filter_triggered',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        reason: filterReason,
        lastGood: this.lastGoodState,
        projectionSource: currentProj.source,
      });
    }

    // 4. Update diagnostics operations count with bounded traversal
    this.recordOperationDiagnostics(parsed);

    // 5. Apply patch to internal state
    const applyResult = this.patchApplier.applyPatch(parsed);
    if (applyResult.status === 'applied') {
      this.validPatchesSeen++;
    }

    // 6. Check for message_id identification or update
    const detectedId = this.patchApplier.getMessageId();
    if (detectedId && detectedId !== this.currentMessageId) {
      this.currentMessageId = detectedId;
      semanticEvents.push({
        type: 'message_id_identified',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
      });
    }

    // 7. Project state (supporting both Variant A: fragments and Variant B: top_level)
    const projected = projectDeepSeekState(this.patchApplier.getState());
    this.currentProjectionSource = projected.source;
    const { answer, thinking, source } = projected;

    // Check Answer
    const answerDiff = computeTextDiff(this.lastProjectedAnswer, answer);
    if (answerDiff.kind === 'delta' && answerDiff.delta) {
      this.lastProjectedAnswer = answer;
      semanticEvents.push({
        type: 'answer_delta',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        delta: answerDiff.delta,
        fullText: answer,
        projectionSource: source,
      });
    } else if (answerDiff.kind === 'replace') {
      this.lastProjectedAnswer = answer;
      semanticEvents.push({
        type: 'answer_replace',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        fullText: answer,
        projectionSource: source,
      });
    }

    // Check Thinking
    const thinkingDiff = computeTextDiff(this.lastProjectedThinking, thinking);
    if (thinkingDiff.kind === 'delta' && thinkingDiff.delta) {
      this.lastProjectedThinking = thinking;
      semanticEvents.push({
        type: 'thinking_delta',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        delta: thinkingDiff.delta,
        fullText: thinking,
        projectionSource: source,
      });
    } else if (thinkingDiff.kind === 'replace') {
      this.lastProjectedThinking = thinking;
      semanticEvents.push({
        type: 'thinking_replace',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        fullText: thinking,
        projectionSource: source,
      });
    }

    // 8. Check terminal status using normalized protocol vocabulary (AUTHORITATIVE status only!)
    const currentStatus = this.patchApplier.getStatus();
    if (currentStatus && this.profile.terminalStatuses.includes(currentStatus as any) && !this.isFinished) {
      this.isFinished = true;

      const hasPending = this.patchApplier.hasPendingFragment() ?? false;
      const isIncomplete = this.patchApplier.incompleteMessage() ?? false;

      let terminalReason: TerminalReason = 'completed';
      if (currentStatus === 'FINISHED') {
        terminalReason = (hasPending || isIncomplete) ? 'incomplete' : 'completed';
      } else if (currentStatus === 'CONTENT_FILTER') {
        terminalReason = 'filtered';
      } else if (currentStatus === 'CONTEXT_LENGTH_EXCEEDED') {
        terminalReason = 'truncated_context_limit';
      } else if (currentStatus === 'INCOMPLETE') {
        terminalReason = 'incomplete';
      } else if (currentStatus === 'TIMEOUT') {
        terminalReason = 'timeout';
      }

      this.lastTerminalReason = terminalReason;
      this.evaluateLiveObservedGate();

      semanticEvents.push({
        type: 'stream_finished',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        status: currentStatus,
        terminalReason,
        hasPendingFragment: hasPending,
        incompleteMessage: isIncomplete,
        projectionSource: source,
      });
    } else {
      this.evaluateLiveObservedGate();
    }

    return semanticEvents;
  }

  /**
   * Finalizes the stream session at transport completion or interruption.
   */
  finish(context?: StreamTerminalContext): DeepSeekSemanticEvent[] {
    const events: DeepSeekSemanticEvent[] = [];
    if (this.isFinished) {
      return events;
    }

    this.isFinished = true;
    this.evaluateLiveObservedGate();

    if (context?.kind === 'transport_abort') {
      this.lastTerminalReason = 'transport_abort';
      events.push({
        type: 'stream_interrupted',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        reason: context.reason || 'transport_abort',
        terminalReason: 'transport_abort',
        projectionSource: this.currentProjectionSource,
      });
      return events;
    }

    if (context?.kind === 'transport_error') {
      this.lastTerminalReason = 'transport_error';
      events.push({
        type: 'stream_interrupted',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        reason: context.error || 'transport_error',
        terminalReason: 'transport_error',
        error: context.error,
        projectionSource: this.currentProjectionSource,
      });
      return events;
    }

    if (context?.kind === 'degraded') {
      this.lastTerminalReason = 'degraded';
      events.push({
        type: 'stream_degraded',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        reason: context.reason || 'stream_degraded',
        terminalReason: 'degraded',
        projectionSource: this.currentProjectionSource,
      });
      return events;
    }

    // Default: transport completed normally (AUTHORITATIVE status only!)
    const existingStatus = this.patchApplier.getStatus();
    if (existingStatus && this.profile.terminalStatuses.includes(existingStatus as any)) {
      const hasPending = this.patchApplier.hasPendingFragment() ?? false;
      const isIncomplete = this.patchApplier.incompleteMessage() ?? false;

      let terminalReason: TerminalReason = 'completed';
      if (existingStatus === 'FINISHED') {
        terminalReason = (hasPending || isIncomplete) ? 'incomplete' : 'completed';
      } else if (existingStatus === 'CONTENT_FILTER') {
        terminalReason = 'filtered';
      } else if (existingStatus === 'CONTEXT_LENGTH_EXCEEDED') {
        terminalReason = 'truncated_context_limit';
      } else if (existingStatus === 'INCOMPLETE') {
        terminalReason = 'incomplete';
      } else if (existingStatus === 'TIMEOUT') {
        terminalReason = 'timeout';
      }

      this.lastTerminalReason = terminalReason;
      events.push({
        type: 'stream_finished',
        streamId: this.streamId,
        sequence: this.nextSeq(),
        timestamp: Date.now(),
        messageId: this.currentMessageId,
        sessionId: this.sessionId,
        status: existingStatus,
        terminalReason,
        hasPendingFragment: hasPending,
        incompleteMessage: isIncomplete,
        projectionSource: this.currentProjectionSource,
      });
      return events;
    }

    this.lastTerminalReason = 'transport_ended';
    events.push({
      type: 'stream_transport_ended',
      streamId: this.streamId,
      sequence: this.nextSeq(),
      timestamp: Date.now(),
      messageId: this.currentMessageId,
      sessionId: this.sessionId,
      status: this.patchApplier.getStatus() || 'TRANSPORT_ENDED',
      terminalReason: 'transport_ended',
      projectionSource: this.currentProjectionSource,
    });

    return events;
  }

  getLastGoodState(): DeepSeekLastGoodState | undefined {
    return this.lastGoodState;
  }

  getProjectedContent(): DeepSeekProjectedContent {
    return {
      answer: this.lastProjectedAnswer,
      thinking: this.lastProjectedThinking,
      source: this.currentProjectionSource,
    };
  }

  getDiagnostics(): DeepSeekProtocolDiagnosticsData {
    return {
      activeProfileId: this.profile.id,
      compatibilityState: this.compatibilityState,
      projectionSource: this.currentProjectionSource,
      parsedFramesCount: this.parsedFramesCount,
      operationsCount: { ...this.opsCount },
      activeMessageId: this.currentMessageId,
      activeSessionId: this.sessionId,
      currentAnswerLength: this.lastProjectedAnswer.length,
      currentThinkingLength: this.lastProjectedThinking.length,
      filterEventsCount: this.filterEventsCount,
      lastFilterEvent: this.lastFilterEvent,
      lastTerminalReason: this.lastTerminalReason,
      lastProtocolStatus: this.patchApplier.getStatus(),
      quasiStatus: this.patchApplier.getQuasiStatus(),
      hasPendingFragment: this.patchApplier.hasPendingFragment(),
      incompleteMessage: this.patchApplier.incompleteMessage(),
      finishControlObserved: this.finishObserved,
      closeControlObserved: this.closeObserved,
      sequenceGapsCount: this.sequenceGapsCount,
      orphanEventsCount: this.orphanEventsCount,
      duplicateOpensCount: this.duplicateOpensCount,
      eventsAfterTerminalCount: this.eventsAfterTerminalCount,
      protocolWarningsCount: this.protocolWarningsCount,
      unknownSseEndpoints: [...this.unknownSseEndpoints],
      unknownSseEventNames: Array.from(this.unknownSseEventNames),
      recentWarnings: [...this.recentWarnings],
    };
  }

  /**
   * Structural bounded scan for censorship markers.
   *
   * Hardened Invariants:
   * 1. Requires structural status field (obj.status or obj.quasi_status) matching filterStatusMarkers.
   * 2. Or explicit patch path: p === 'status' / 'response/status' / 'quasi_status' with v matching filterStatusMarkers.
   * 3. Or fragment type: obj.type matching filterFragmentTypes (e.g. TEMPLATE_RESPONSE).
   * 4. Strictly avoids bare value checking so literal content strings like "CONTENT_FILTER" never trigger false positives.
   */
  private detectCensorship(patch: unknown): string | null {
    if (!patch || typeof patch !== 'object') return null;

    // Priority 1: Check status markers
    const statusMarker = this.scanForMarker(patch, (obj) => {
      if (typeof obj.status === 'string' && this.profile.filterStatusMarkers.includes(obj.status)) {
        return obj.status;
      }
      if (typeof obj.quasi_status === 'string' && this.profile.filterStatusMarkers.includes(obj.quasi_status)) {
        return obj.quasi_status;
      }
      const isStatusPath =
        obj.p === 'status' ||
        obj.p === 'response/status' ||
        obj.p === 'quasi_status' ||
        obj.p === 'response/quasi_status';
      if (isStatusPath && typeof obj.v === 'string' && this.profile.filterStatusMarkers.includes(obj.v)) {
        return obj.v;
      }
      return null;
    });
    if (statusMarker) return statusMarker;

    // Priority 2: Check fragment types (e.g. TEMPLATE_RESPONSE)
    const templateMarker = this.scanForMarker(patch, (obj) => {
      if (typeof obj.type === 'string' && this.profile.filterFragmentTypes.includes(obj.type)) {
        return obj.type;
      }
      return null;
    });
    if (templateMarker) return templateMarker;

    return null;
  }

  private scanForMarker(
    root: unknown,
    predicate: (obj: Record<string, unknown>) => string | null
  ): string | null {
    let visitedCount = 0;
    const visited = new WeakSet<object>();

    const traverse = (node: unknown, depth: number): string | null => {
      if (!node || typeof node !== 'object') return null;
      if (depth > MAX_SCAN_DEPTH || visitedCount > MAX_SCAN_NODES) return null;
      if (visited.has(node as object)) return null;

      visited.add(node as object);
      visitedCount++;

      const obj = node as Record<string, unknown>;
      const match = predicate(obj);
      if (match) return match;

      if (Array.isArray(node)) {
        for (const item of node) {
          const res = traverse(item, depth + 1);
          if (res) return res;
        }
      } else {
        for (const key of Object.keys(obj)) {
          if (key === '__proto__' || key === 'prototype' || key === 'constructor') continue;
          const val = obj[key];
          if (val && typeof val === 'object') {
            const res = traverse(val, depth + 1);
            if (res) return res;
          }
        }
      }

      return null;
    };

    return traverse(root, 0);
  }

  /**
   * Bounded diagnostics operations counting to prevent DoS from deeply nested BATCH payloads.
   */
  private recordOperationDiagnostics(
    patch: unknown,
    depth = 0,
    visited = { count: 0 }
  ): void {
    if (!patch || typeof patch !== 'object') return;
    if (depth > MAX_BATCH_DEPTH || visited.count > MAX_SCAN_NODES) return;

    visited.count++;
    const op = String((patch as any).o || '').toUpperCase();

    switch (op) {
      case 'SET':
        this.opsCount.set++;
        break;
      case 'APPEND':
        this.opsCount.append++;
        break;
      case 'REPLACE':
        this.opsCount.replace++;
        break;
      case 'BATCH':
        this.opsCount.batch++;
        if (Array.isArray((patch as any).v)) {
          if ((patch as any).v.length > MAX_BATCH_ITEMS) {
            return;
          }
          for (const item of (patch as any).v) {
            this.recordOperationDiagnostics(item, depth + 1, visited);
          }
        }
        break;
      default:
        if (op) {
          this.opsCount.other++;
        }
        break;
    }
  }
}
