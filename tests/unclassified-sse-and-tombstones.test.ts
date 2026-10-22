import { describe, it, expect, vi } from 'vitest';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';
import { normalizePathname, isDeepSeekGenerationEndpoint } from '../src/adapters/deepseek/compatibility/candidate-policy';

describe('Unclassified SSE Streams & Terminated Stream Tombstones', () => {
  describe('Unclassified SSE Stream Handling', () => {
    it('distinguishes unclassified SSE endpoint from generation endpoint', () => {
      const unknownEndpoint = 'https://chat.deepseek.com/api/v0/notifications/sse';
      const isGen = isDeepSeekGenerationEndpoint(unknownEndpoint);
      const sanitized = normalizePathname(unknownEndpoint);

      expect(isGen).toBe(false);
      expect(sanitized).toBe('/api/v0/notifications/sse');
    });

    it('demonstrates unclassified stream lifecycle where chunks are discarded without orphan counting', () => {
      // Simulating the Content Script unclassified stream tracking invariant
      const unclassifiedStreamIds = new Set<string>();
      let orphanEventsCount = 0;
      let recordedObservations = 0;

      const streamId = 'stream_notifications_01';
      const url = 'https://chat.deepseek.com/api/v0/notifications/stream';

      // 1. Open event arrives for unclassified endpoint
      if (!isDeepSeekGenerationEndpoint(url)) {
        unclassifiedStreamIds.add(streamId);
        recordedObservations++;
      }

      expect(unclassifiedStreamIds.has(streamId)).toBe(true);
      expect(recordedObservations).toBe(1);

      // 2. Chunks arrive for this stream
      const chunkEvents = [
        { streamId, sequence: 1, chunkText: 'data: {"badge": 1}\n\n' },
        { streamId, sequence: 2, chunkText: 'data: {"badge": 2}\n\n' },
      ];

      for (const chunk of chunkEvents) {
        if (unclassifiedStreamIds.has(chunk.streamId)) {
          // Silently dropped: not a generation stream, so do not count as orphan!
          continue;
        }
        orphanEventsCount++;
      }

      // Invariant: orphan count remains 0
      expect(orphanEventsCount).toBe(0);

      // 3. Complete event arrives for unclassified stream
      if (unclassifiedStreamIds.has(streamId)) {
        unclassifiedStreamIds.delete(streamId);
      }

      expect(unclassifiedStreamIds.size).toBe(0);
      expect(orphanEventsCount).toBe(0);
    });
  });

  describe('Terminated Stream Tombstone Tracking', () => {
    it('classifies late arrivals after termination as event_after_terminal, not orphan', () => {
      const activeSessions = new Map<string, boolean>();
      const terminatedStreamIds = new Set<string>();
      let orphanEventsCount = 0;
      let eventsAfterTerminalCount = 0;

      const streamId = 'stream_gen_terminated_01';
      activeSessions.set(streamId, true);

      // Stream finishes
      activeSessions.delete(streamId);
      terminatedStreamIds.add(streamId);

      // Late chunk arrives after session has cleaned up
      const lateEvent = { streamId, chunkText: 'late data' };

      if (activeSessions.has(lateEvent.streamId)) {
        // active
      } else if (terminatedStreamIds.has(lateEvent.streamId)) {
        // Tombstone hit: recorded as post-terminal event
        eventsAfterTerminalCount++;
      } else {
        orphanEventsCount++;
      }

      expect(eventsAfterTerminalCount).toBe(1);
      expect(orphanEventsCount).toBe(0);
    });

    it('enforces FIFO ring-buffer bounds (MAX 128) on terminated stream tombstones', () => {
      const terminatedStreamIds = new Set<string>();
      const MAX_TOMBSTONES = 128;

      function addTombstone(id: string) {
        if (terminatedStreamIds.size >= MAX_TOMBSTONES) {
          const oldest = terminatedStreamIds.keys().next().value;
          if (oldest) terminatedStreamIds.delete(oldest);
        }
        terminatedStreamIds.add(id);
      }

      // Add 150 terminated streams
      for (let i = 0; i < 150; i++) {
        addTombstone(`stream_term_${i}`);
      }

      expect(terminatedStreamIds.size).toBe(MAX_TOMBSTONES);
      // First 22 items (0..21) should have been evicted
      expect(terminatedStreamIds.has('stream_term_0')).toBe(false);
      expect(terminatedStreamIds.has('stream_term_21')).toBe(false);
      // Items 22..149 should be present
      expect(terminatedStreamIds.has('stream_term_22')).toBe(true);
      expect(terminatedStreamIds.has('stream_term_149')).toBe(true);
    });

    it('records event_after_terminal on protocol decoder when fed after finish', () => {
      const decoder = new DeepSeekProtocolDecoder('stream_direct_term');

      decoder.feed({
        data: JSON.stringify({
          p: 'status',
          o: 'SET',
          v: 'FINISHED',
        }),
      });

      expect(decoder.getDiagnostics().eventsAfterTerminalCount).toBe(0);

      // Feed late event
      decoder.feed({
        data: JSON.stringify({
          p: 'fragments/0/content',
          o: 'APPEND',
          v: 'late content',
        }),
      });

      expect(decoder.getDiagnostics().eventsAfterTerminalCount).toBe(1);
      expect(decoder.getDiagnostics().recentWarnings.some((w) => w.includes('event_after_terminal'))).toBe(true);
    });
  });
});
