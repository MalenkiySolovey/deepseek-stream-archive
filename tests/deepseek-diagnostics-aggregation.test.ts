import { describe, it, expect } from 'vitest';
import type { DeepSeekProtocolDiagnosticsData } from '../src/adapters/deepseek/protocol/types';

/**
 * Diagnostic aggregation logic mirroring Background Service Worker implementation.
 */
function aggregateDiagnostics(
  streamDiagnosticsMap: Map<string, DeepSeekProtocolDiagnosticsData>
): DeepSeekProtocolDiagnosticsData {
  const agg: DeepSeekProtocolDiagnosticsData = {
    activeProfileId: 'deepseek-web-reference-2026-10',
    compatibilityState: 'automated_verified',
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
    sequenceGapsCount: 0,
    orphanEventsCount: 0,
    duplicateOpensCount: 0,
    eventsAfterTerminalCount: 0,
    protocolWarningsCount: 0,
    finishControlObserved: false,
    closeControlObserved: false,
    unknownSseEventNames: [],
    unknownSseEndpoints: [],
    recentWarnings: [],
  };

  const unknownEndpointsSet = new Set<string>();
  const warningsSet = new Set<string>();

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

    agg.filterEventsCount += d.filterEventsCount;
    if (d.lastFilterEvent) {
      if (!agg.lastFilterEvent || d.lastFilterEvent.timestamp > agg.lastFilterEvent.timestamp) {
        agg.lastFilterEvent = d.lastFilterEvent;
      }
    }

    agg.sequenceGapsCount += d.sequenceGapsCount;
    agg.orphanEventsCount = Math.max(agg.orphanEventsCount, d.orphanEventsCount);
    agg.duplicateOpensCount += d.duplicateOpensCount;
    agg.eventsAfterTerminalCount += d.eventsAfterTerminalCount;
    agg.protocolWarningsCount += d.protocolWarningsCount;

    if (d.compatibilityState === 'degraded' || agg.sequenceGapsCount > 0) {
      agg.compatibilityState = 'degraded';
    } else if (d.compatibilityState === 'live_observed' && agg.compatibilityState !== 'degraded') {
      agg.compatibilityState = 'live_observed';
    }

    for (const ep of d.unknownSseEndpoints) unknownEndpointsSet.add(ep);
    for (const w of d.recentWarnings) warningsSet.add(w);
  }

  agg.unknownSseEndpoints = Array.from(unknownEndpointsSet);
  agg.recentWarnings = Array.from(warningsSet).slice(-10);

  return agg;
}

describe('DeepSeek Diagnostics Aggregation (Double-Counting Immunity)', () => {
  it('prevents double-counting across multiple batches of the same stream', () => {
    const streamMap = new Map<string, DeepSeekProtocolDiagnosticsData>();

    const makeDiag = (frames: number, appends: number): DeepSeekProtocolDiagnosticsData => ({
      activeProfileId: 'deepseek-web-reference-2026-10',
      compatibilityState: 'automated_verified',
      projectionSource: 'fragments',
      parsedFramesCount: frames,
      operationsCount: { set: 1, append: appends, replace: 0, batch: 0, other: 0 },
      currentAnswerLength: frames * 10,
      currentThinkingLength: 0,
      filterEventsCount: 0,
      sequenceGapsCount: 0,
      orphanEventsCount: 0,
      duplicateOpensCount: 0,
      eventsAfterTerminalCount: 0,
      protocolWarningsCount: 0,
      finishControlObserved: false,
      closeControlObserved: false,
      unknownSseEventNames: [],
      unknownSseEndpoints: [],
      recentWarnings: [],
    });

    // Batch 1 (5 frames)
    streamMap.set('stream_1', makeDiag(5, 4));
    let agg = aggregateDiagnostics(streamMap);
    expect(agg.parsedFramesCount).toBe(5);
    expect(agg.operationsCount.append).toBe(4);

    // Batch 2 (10 frames cumulative snapshot for stream_1)
    streamMap.set('stream_1', makeDiag(10, 9));
    agg = aggregateDiagnostics(streamMap);
    expect(agg.parsedFramesCount).toBe(10); // NOT 5 + 10 = 15!
    expect(agg.operationsCount.append).toBe(9);

    // Batch 3 (15 frames cumulative snapshot for stream_1)
    streamMap.set('stream_1', makeDiag(15, 14));
    agg = aggregateDiagnostics(streamMap);
    expect(agg.parsedFramesCount).toBe(15); // NOT 5 + 10 + 15 = 30!
    expect(agg.operationsCount.append).toBe(14);
  });

  it('correctly aggregates distinct concurrent streams additively', () => {
    const streamMap = new Map<string, DeepSeekProtocolDiagnosticsData>();

    const diagA: DeepSeekProtocolDiagnosticsData = {
      activeProfileId: 'deepseek-web-reference-2026-10',
      compatibilityState: 'automated_verified',
      projectionSource: 'fragments',
      parsedFramesCount: 12,
      operationsCount: { set: 2, append: 10, replace: 0, batch: 0, other: 0 },
      currentAnswerLength: 120,
      currentThinkingLength: 50,
      filterEventsCount: 0,
      sequenceGapsCount: 0,
      orphanEventsCount: 0,
      duplicateOpensCount: 0,
      eventsAfterTerminalCount: 0,
      protocolWarningsCount: 0,
      finishControlObserved: false,
      closeControlObserved: false,
      unknownSseEventNames: [],
      unknownSseEndpoints: [],
      recentWarnings: [],
    };

    const diagB: DeepSeekProtocolDiagnosticsData = {
      activeProfileId: 'deepseek-web-reference-2026-10',
      compatibilityState: 'automated_verified',
      projectionSource: 'top_level',
      parsedFramesCount: 18,
      operationsCount: { set: 3, append: 15, replace: 0, batch: 0, other: 0 },
      currentAnswerLength: 200,
      currentThinkingLength: 0,
      filterEventsCount: 1,
      sequenceGapsCount: 0,
      orphanEventsCount: 0,
      duplicateOpensCount: 0,
      eventsAfterTerminalCount: 0,
      protocolWarningsCount: 0,
      finishControlObserved: false,
      closeControlObserved: false,
      unknownSseEventNames: [],
      unknownSseEndpoints: ['https://chat.deepseek.com/api/v0/events'],
      recentWarnings: [],
    };

    streamMap.set('stream_A', diagA);
    streamMap.set('stream_B', diagB);

    const agg = aggregateDiagnostics(streamMap);
    expect(agg.parsedFramesCount).toBe(30); // 12 + 18
    expect(agg.operationsCount.append).toBe(25); // 10 + 15
    expect(agg.filterEventsCount).toBe(1);
    expect(agg.unknownSseEndpoints).toContain('https://chat.deepseek.com/api/v0/events');
  });

  it('marks aggregated compatibilityState as degraded if any stream suffered sequence gaps', () => {
    const streamMap = new Map<string, DeepSeekProtocolDiagnosticsData>();

    const healthyDiag: DeepSeekProtocolDiagnosticsData = {
      activeProfileId: 'deepseek-web-reference-2026-10',
      compatibilityState: 'automated_verified',
      projectionSource: 'fragments',
      parsedFramesCount: 10,
      operationsCount: { set: 1, append: 9, replace: 0, batch: 0, other: 0 },
      currentAnswerLength: 100,
      currentThinkingLength: 0,
      filterEventsCount: 0,
      sequenceGapsCount: 0,
      orphanEventsCount: 0,
      duplicateOpensCount: 0,
      eventsAfterTerminalCount: 0,
      protocolWarningsCount: 0,
      finishControlObserved: false,
      closeControlObserved: false,
      unknownSseEventNames: [],
      unknownSseEndpoints: [],
      recentWarnings: [],
    };

    const degradedDiag: DeepSeekProtocolDiagnosticsData = {
      activeProfileId: 'deepseek-web-reference-2026-10',
      compatibilityState: 'degraded',
      projectionSource: 'fragments',
      parsedFramesCount: 5,
      operationsCount: { set: 1, append: 4, replace: 0, batch: 0, other: 0 },
      currentAnswerLength: 50,
      currentThinkingLength: 0,
      filterEventsCount: 0,
      sequenceGapsCount: 1,
      orphanEventsCount: 0,
      duplicateOpensCount: 0,
      eventsAfterTerminalCount: 0,
      protocolWarningsCount: 1,
      finishControlObserved: false,
      closeControlObserved: false,
      unknownSseEventNames: [],
      unknownSseEndpoints: [],
      recentWarnings: ['[stream_sequence_gap] Gap detected'],
    };

    streamMap.set('stream_healthy', healthyDiag);
    streamMap.set('stream_degraded', degradedDiag);

    const agg = aggregateDiagnostics(streamMap);
    expect(agg.compatibilityState).toBe('degraded');
    expect(agg.sequenceGapsCount).toBe(1);
    expect(agg.protocolWarningsCount).toBe(1);
  });
});
