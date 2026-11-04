import type { TransportEvent, TransportMetadata } from './types';

export interface ObservedTurn {
  clientTurnId: string;
  prompt: string;
  parentTurnId?: string | null;
  sessionId?: string;
  timestamp: number;
  hasReceivedTokens: boolean;
  isTerminal: boolean;
  terminalReason?: 'complete' | 'abort' | 'error' | string;
}

export interface ActiveStreamInfo {
  streamId: string;
  clientTurnId?: string;
  hasReceivedTokens: boolean;
  isTerminal: boolean;
}

export interface ResolveTurnParams {
  prompt: string;
  sessionId?: string;
  parentTurnId?: string | null;
  isRegenRequest: boolean;
  requestBody?: unknown;
  now?: number;
}

export interface TurnResolutionResult {
  clientTurnId: string;
  isReused: boolean;
}

/**
 * Request & Turn Identity Coordinator for DeepSeek StreamArchive.
 *
 * Enforces:
 * 1. Strict Turn Lifecycle Isolation: Each user prompt receives a distinct clientTurnId.
 * 2. Strict Transport Retry Invariant: A turn may only be reused if the previous
 *    request for the exact same prompt/session/parent is STILL IN-FLIGHT (!isTerminal),
 *    has received 0 tokens (!hasReceivedTokens), and falls within the transport retry
 *    window (default 2000 ms).
 *    Once a request reaches terminal state (complete, abort, error) or receives tokens,
 *    its turn lifecycle is permanently sealed and subsequent submissions receive fresh clientTurnIds.
 * 3. Bounded Memory Lifecycle (anti-leak): Request bodies mapped to turn IDs are strictly
 *    bounded (max 50 entries, 30s TTL) with automatic FIFO pruning and eviction.
 * 4. Concurrent Stream Isolation: Multi-stream tracking isolates each stream by streamId.
 */
export class TurnIdentityCoordinator {
  private lastObservedTurn: ObservedTurn | null = null;
  private readonly recentObservedTurns: ObservedTurn[] = [];
  private readonly maxRecentTurns: number;
  private readonly activeStreamMap = new Map<string, ActiveStreamInfo>();

  // Bounded request body map with TTL to prevent memory leaks and protect user privacy
  private readonly bodyMap = new Map<unknown, { clientTurnId: string; timestamp: number }>();
  private readonly maxBodyEntries: number;
  private readonly bodyEntryTtlMs: number;
  private readonly transportRetryWindowMs: number;

  constructor(options?: {
    maxRecentTurns?: number;
    maxBodyEntries?: number;
    bodyEntryTtlMs?: number;
    transportRetryWindowMs?: number;
  }) {
    this.maxRecentTurns = options?.maxRecentTurns ?? 10;
    this.maxBodyEntries = options?.maxBodyEntries ?? 50;
    this.bodyEntryTtlMs = options?.bodyEntryTtlMs ?? 30_000;
    this.transportRetryWindowMs = options?.transportRetryWindowMs ?? 2000;
  }

  /**
   * Resolves or creates a clientTurnId for an outgoing prompt request.
   */
  public resolveTurnForOutgoingRequest(params: ResolveTurnParams): TurnResolutionResult {
    const now = params.now ?? Date.now();
    const trimmedPrompt = params.prompt.trim();

    let clientTurnId: string;
    let isReused = false;

    if (
      !params.isRegenRequest &&
      this.lastObservedTurn &&
      !this.lastObservedTurn.isTerminal && // CRITICAL: Never reuse a terminated turn!
      !this.lastObservedTurn.hasReceivedTokens &&
      this.lastObservedTurn.prompt.trim() === trimmedPrompt &&
      this.lastObservedTurn.sessionId === params.sessionId &&
      this.lastObservedTurn.parentTurnId === params.parentTurnId &&
      now - this.lastObservedTurn.timestamp < this.transportRetryWindowMs
    ) {
      clientTurnId = this.lastObservedTurn.clientTurnId;
      isReused = true;
    } else {
      clientTurnId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? `turn_user_${crypto.randomUUID()}`
          : `turn_user_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    }

    const turn: ObservedTurn = {
      clientTurnId,
      prompt: params.prompt,
      parentTurnId: params.parentTurnId,
      sessionId: params.sessionId,
      timestamp: now,
      hasReceivedTokens: false,
      isTerminal: false,
    };

    this.lastObservedTurn = turn;
    this.recentObservedTurns.unshift(turn);
    if (this.recentObservedTurns.length > this.maxRecentTurns) {
      this.recentObservedTurns.pop();
    }

    if (params.requestBody !== undefined) {
      this.recordRequestBody(params.requestBody, clientTurnId, now);
    }

    return { clientTurnId, isReused };
  }

  /**
   * Records a request body into the bounded FIFO body map with TTL.
   */
  public recordRequestBody(body: unknown, clientTurnId: string, now: number = Date.now()): void {
    if (body === undefined) return;
    this.pruneExpiredBodyEntries(now);
    if (this.bodyMap.size >= this.maxBodyEntries) {
      const oldestKey = this.bodyMap.keys().next().value;
      if (oldestKey !== undefined) {
        this.bodyMap.delete(oldestKey);
      }
    }
    this.bodyMap.set(body, { clientTurnId, timestamp: now });
  }

  /**
   * Extracts transport metadata for a stream context, looking up from the bounded body map
   * and falling back to recent in-flight observed turns.
   */
  public extractRequestMetadata(
    context: { method: string; url: string; body: unknown },
    isRegenRequest: boolean,
    hints?: { prompt?: string; sessionId?: string; parentTurnId?: string | null },
    now: number = Date.now()
  ): Partial<TransportMetadata> {
    const parentTurnId = hints?.parentTurnId;
    const reqSessionId = hints?.sessionId;

    let clientTurnId: string | undefined;

    // 1. Check bounded body map
    const bodyEntry = this.bodyMap.get(context.body);
    if (bodyEntry) {
      if (now - bodyEntry.timestamp < this.bodyEntryTtlMs) {
        clientTurnId = bodyEntry.clientTurnId;
      } else {
        this.bodyMap.delete(context.body);
      }
    }

    // 2. Fallback to active non-terminal observed turns if body lookup missed
    if (!clientTurnId && typeof hints?.prompt === 'string') {
      const trimmed = hints.prompt.trim();
      const matched = this.recentObservedTurns.find((turn) => {
        if (now - turn.timestamp > 2500) return false;
        if (turn.isTerminal || turn.hasReceivedTokens) return false;
        if (turn.prompt.trim() !== trimmed) return false;
        if (reqSessionId && turn.sessionId && turn.sessionId !== reqSessionId) return false;
        if (parentTurnId !== undefined && turn.parentTurnId !== undefined && turn.parentTurnId !== parentTurnId) return false;
        return true;
      });
      if (matched) {
        clientTurnId = matched.clientTurnId;
      }
    }

    return {
      clientTurnId: isRegenRequest ? undefined : clientTurnId,
      requestPrompt: !isRegenRequest && typeof hints?.prompt === 'string' ? hints.prompt : undefined,
      requestParentTurnId: parentTurnId,
      requestSessionId: reqSessionId,
    };
  }

  /**
   * Handles stream lifecycle events (chunk, complete, abort, error) across MAIN -> ISOLATED.
   */
  public handleTransportStreamEvent(event: TransportEvent): void {
    let streamInfo = this.activeStreamMap.get(event.streamId);
    if (!streamInfo) {
      streamInfo = {
        streamId: event.streamId,
        clientTurnId: event.metadata?.clientTurnId,
        hasReceivedTokens: false,
        isTerminal: false,
      };
      this.activeStreamMap.set(event.streamId, streamInfo);
    } else if (!streamInfo.clientTurnId && event.metadata?.clientTurnId) {
      streamInfo.clientTurnId = event.metadata.clientTurnId;
    }

    if (event.type === 'chunk' && event.chunkText && event.chunkText.trim().length > 0) {
      streamInfo.hasReceivedTokens = true;
      if (streamInfo.clientTurnId) {
        const matchedTurn = this.recentObservedTurns.find((t) => t.clientTurnId === streamInfo!.clientTurnId);
        if (matchedTurn) {
          matchedTurn.hasReceivedTokens = true;
        }
      }
      if (this.lastObservedTurn && this.lastObservedTurn.clientTurnId === streamInfo.clientTurnId) {
        this.lastObservedTurn.hasReceivedTokens = true;
      }
    } else if (event.type === 'complete' || event.type === 'abort' || event.type === 'error') {
      streamInfo.isTerminal = true;
      const reason = event.type;
      if (streamInfo.clientTurnId) {
        const matchedTurn = this.recentObservedTurns.find((t) => t.clientTurnId === streamInfo!.clientTurnId);
        if (matchedTurn) {
          matchedTurn.isTerminal = true;
          matchedTurn.terminalReason = reason;
        }
      }
      if (this.lastObservedTurn && this.lastObservedTurn.clientTurnId === streamInfo.clientTurnId) {
        this.lastObservedTurn.isTerminal = true;
        this.lastObservedTurn.terminalReason = reason;
        // Turn lifecycle has reached terminal boundary; clear active turn so future prompts start fresh!
        this.lastObservedTurn = null;
      }
      // Cleanup stream info after brief retention for late transport packets
      setTimeout(() => this.activeStreamMap.delete(event.streamId), 5000);
    }
  }

  /**
   * Removes expired entries from the body map.
   */
  public pruneExpiredBodyEntries(now: number = Date.now()): void {
    for (const [key, entry] of this.bodyMap.entries()) {
      if (now - entry.timestamp >= this.bodyEntryTtlMs) {
        this.bodyMap.delete(key);
      }
    }
  }

  /**
   * Diagnostic inspection methods for auditing and testing.
   */
  public getBodyMapSize(): number {
    return this.bodyMap.size;
  }

  public getLastObservedTurn(): ObservedTurn | null {
    return this.lastObservedTurn ? { ...this.lastObservedTurn } : null;
  }

  public getRecentObservedTurns(): ObservedTurn[] {
    return this.recentObservedTurns.map((t) => ({ ...t }));
  }

  public getActiveStream(streamId: string): ActiveStreamInfo | undefined {
    const s = this.activeStreamMap.get(streamId);
    return s ? { ...s } : undefined;
  }

  public clear(): void {
    this.lastObservedTurn = null;
    this.recentObservedTurns.length = 0;
    this.activeStreamMap.clear();
    this.bodyMap.clear();
  }
}
