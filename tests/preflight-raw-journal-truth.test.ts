import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { RawStreamRepository } from '../src/storage/raw-journal/repository';
import { RawJournalBuffer } from '../src/storage/raw-journal/buffer';
import { closeExtensionDatabase } from '../src/storage/db';
import { isDeepSeekGenerationEndpoint } from '../src/adapters/deepseek/compatibility/candidate-policy';
import { validateTransportEventPayload } from '../src/bridge/validation';
import { evaluateCanonicalPromotion } from '../src/storage/raw-journal/promotion-gate';
import type { RawStreamBatch, RawStreamRecord } from '../src/storage/raw-journal/types';
import type { ReplayResult } from '../src/storage/raw-journal/replay';

describe('Raw Journal Integrity & Truth Gate', () => {
  let fakeFactory: IDBFactory;
  let repo: RawStreamRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    repo = new RawStreamRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
    closeExtensionDatabase();
  });

  describe('True Last Raw Commit vs batch.createdAt', () => {
    it('records actual IDB transaction commit timestamp (5000) not batch.createdAt (1000)', async () => {
      await repo.openStream({
        producerSessionId: 'p_meta',
        streamId: 's_meta',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        openedAt: 500,
      });

      const batch: RawStreamBatch = {
        id: 'p_meta:s_meta:1',
        streamKey: 'p_meta:s_meta',
        batchSeq: 1,
        chunks: [{ streamSequence: 1, chunkText: 'hello', timestamp: 1000 }],
        createdAt: 1000, // batch was created at 1000
        charCount: 5,
      };

      // Mock Date.now during persistBatch commit
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(5000);

      const ack = await repo.persistBatch(batch);
      expect(ack.persistedAt).toBe(5000);

      const metadata = await repo.getJournalMetadata();
      expect(metadata.lastPersistedAt).toBe(5000); // MUST be 5000, NOT 1000!

      nowSpy.mockRestore();
    });
  });

  describe('OPEN Immutable Identity & Conflict vs Enrichment', () => {
    it('allows idempotent re-open with identical metadata', async () => {
      const first = await repo.openStream({
        producerSessionId: 'p_idem',
        streamId: 's_idem',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        method: 'POST',
        openedAt: 1000,
      });

      const second = await repo.openStream({
        producerSessionId: 'p_idem',
        streamId: 's_idem',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        method: 'POST',
        openedAt: 1000,
      });

      expect(second.id).toBe(first.id);
      expect(second.openedAt).toBe(1000);
    });

    it('rejects re-open with conflicting HTTP method', async () => {
      await repo.openStream({
        producerSessionId: 'p_meth',
        streamId: 's_meth',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        method: 'POST',
        openedAt: 1000,
      });

      await expect(
        repo.openStream({
          producerSessionId: 'p_meth',
          streamId: 's_meth',
          transport: 'fetch',
          url: 'https://chat.deepseek.com/api/v0/chat/completion',
          method: 'GET',
          openedAt: 1000,
        })
      ).rejects.toThrow();
    });

    it('rejects re-open with conflicting openedAt timestamp', async () => {
      await repo.openStream({
        producerSessionId: 'p_time',
        streamId: 's_time',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        openedAt: 1000,
      });

      await expect(
        repo.openStream({
          producerSessionId: 'p_time',
          streamId: 's_time',
          transport: 'fetch',
          url: 'https://chat.deepseek.com/api/v0/chat/completion',
          openedAt: 9999,
        })
      ).rejects.toThrow();
    });

    it('allows metadata enrichment when existing field was undefined', async () => {
      const opened = await repo.openStream({
        producerSessionId: 'p_enrich',
        streamId: 's_enrich',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        openedAt: 1000,
      });
      expect(opened.provisionalSessionId).toBeUndefined();

      const enriched = await repo.openStream({
        producerSessionId: 'p_enrich',
        streamId: 's_enrich',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        openedAt: 1000,
        provisionalSessionId: 'route_session_123',
      });
      expect(enriched.provisionalSessionId).toBe('route_session_123');
    });

    it('rejects metadata conflict when both existing and new enrichment values differ', async () => {
      await repo.openStream({
        producerSessionId: 'p_conf',
        streamId: 's_conf',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        openedAt: 1000,
        provisionalSessionId: 'session_A',
      });

      await expect(
        repo.openStream({
          producerSessionId: 'p_conf',
          streamId: 's_conf',
          transport: 'fetch',
          url: 'https://chat.deepseek.com/api/v0/chat/completion',
          openedAt: 1000,
          provisionalSessionId: 'session_B',
        })
      ).rejects.toThrow();
    });
  });

  describe('OPEN Sequence Integrity', () => {
    it('marks new stream as degraded and gap_detected if OPEN has streamSequence !== 0', async () => {
      const rec = await repo.openStream({
        producerSessionId: 'p_openseq',
        streamId: 's_openseq',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        streamSequence: 4, // Started mid-stream!
      });

      expect(rec.state).toBe('degraded');
      expect(rec.integrity).toBe('gap_detected');
      expect(rec.durabilityGap).toBe(true);
    });
  });

  describe('Origin Anti-Spoofing Gate', () => {
    it('strictly accepts https://chat.deepseek.com with default port 443', () => {
      expect(isDeepSeekGenerationEndpoint('https://chat.deepseek.com/api/v0/chat/completion')).toBe(true);
      expect(isDeepSeekGenerationEndpoint('/api/v0/chat/completion')).toBe(true);
    });

    it('strictly rejects http://, non-443 ports, and rogue domains', () => {
      expect(isDeepSeekGenerationEndpoint('http://chat.deepseek.com/api/v0/chat/completion')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('https://chat.deepseek.com:8443/api/v0/chat/completion')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('https://evil.example/api/v0/chat/completion')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('https://chat.deepseek.com.evil.com/api/v0/chat/completion')).toBe(false);
    });
  });

  describe('Mandatory streamSequence in Bridge Validation', () => {
    it('rejects transport payload missing streamSequence or with negative streamSequence', () => {
      const valid = {
        producerSessionId: 'p1',
        streamId: 's1',
        sequence: 1,
        streamSequence: 0,
        timestamp: 1000,
        transport: 'fetch',
        type: 'open',
      };
      expect(validateTransportEventPayload(valid)).not.toBeNull();

      // Missing streamSequence: MUST REJECT
      const missingSeq: any = { ...valid };
      delete missingSeq.streamSequence;
      expect(validateTransportEventPayload(missingSeq)).toBeNull();

      // Negative streamSequence: MUST REJECT
      expect(validateTransportEventPayload({ ...valid, streamSequence: -1 })).toBeNull();

      // Non-integer streamSequence: MUST REJECT
      expect(validateTransportEventPayload({ ...valid, streamSequence: 1.5 })).toBeNull();
    });
  });

  describe('Terminal Sequence Integrity & Transport State vs Evidence Integrity', () => {
    it('records state = completed but integrity = gap_detected when terminal sequence gap occurs', async () => {
      await repo.openStream({
        producerSessionId: 'p_term',
        streamId: 's_term',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
      });

      const res = await repo.finalizeStream(
        'p_term:s_term',
        'completed', // transport completed!
        'Terminal sequence gap',
        undefined,
        0,
        true, // durabilityGap
        'gap_detected' // integrity
      );

      expect(res.finalState).toBe('completed');

      const stream = await repo.getStream('p_term:s_term');
      expect(stream?.state).toBe('completed');
      expect(stream?.integrity).toBe('gap_detected');
      expect(stream?.durabilityGap).toBe(true);
    });
  });

  describe('RawJournalBuffer.destroy() Diagnostics', () => {
    it('returns honest loss window diagnostics without sensitive raw text', () => {
      const buffer = new RawJournalBuffer({
        messageSender: async () => ({ success: true }),
      });

      buffer.handleOpen({
        producerSessionId: 'p_dest',
        streamId: 's_dest',
        sequence: 1,
        streamSequence: 0,
        timestamp: 100,
        transport: 'fetch',
        type: 'open',
      });

      buffer.handleChunk({
        producerSessionId: 'p_dest',
        streamId: 's_dest',
        sequence: 2,
        streamSequence: 1,
        timestamp: 101,
        transport: 'fetch',
        type: 'chunk',
        chunkText: 'some sensitive tokens',
      });

      const report = buffer.destroy();
      expect(report.pendingStreamsLost).toBe(1);
      expect(report.pendingCharsLost).toBe('some sensitive tokens'.length);
      expect(report.pendingBatchesLost).toBe(1);
      // Verify no raw text in report
      expect((report as any).chunkText).toBeUndefined();
    });
  });

  describe('Raw Canonical Promotion Gate', () => {
    const pristineRawStream: RawStreamRecord = {
      id: 'p_gate:s_gate',
      producerSessionId: 'p_gate',
      streamId: 's_gate',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      method: 'POST',
      state: 'completed',
      integrity: 'intact',
      durabilityGap: false,
      openedAt: 1000,
      updatedAt: 2000,
      totalChunks: 5,
      totalChars: 100,
      totalBatches: 2,
    };

    const cleanReplayResult: ReplayResult = {
      streamKey: 'p_gate:s_gate',
      totalChunks: 5,
      totalChars: 100,
      sequenceGapsCount: 0,
      integrity: 'complete',
      audit: {
        duplicateBatchSeq: false,
        duplicateStreamSequence: false,
        batchGap: false,
        chunkGap: false,
        foreignStreamKey: false,
        missingPrefix: false,
        invalidDeterministicId: false,
      },
      semanticEvents: [
        { type: 'answer_delta', streamId: 's_gate', sequence: 1, timestamp: 1000, delta: 'Clean answer' },
      ],
      diagnostics: {} as any,
      projectedAnswer: 'Clean answer',
      projectedThinking: '',
      isComplete: true,
      filterTriggered: false,
    };

    it('approves promotion for intact completed stream with clean replay', () => {
      const evalResult = evaluateCanonicalPromotion(pristineRawStream, cleanReplayResult);
      expect(evalResult.eligible).toBe(true);
      expect(evalResult.terminalOutcome).toBe('finished');
      expect(evalResult.candidateText).toBe('Clean answer');
    });

    it('approves promotion for intact censored stream preserving lastGood candidate', () => {
      const censoredReplay: ReplayResult = {
        ...cleanReplayResult,
        isComplete: false,
        filterTriggered: true,
        semanticEvents: [
          {
            type: 'filter_triggered',
            streamId: 's_gate',
            sequence: 2,
            reason: 'CONTENT_FILTER',
            timestamp: 1500,
            lastGood: {
              answer: 'Valuable unredacted code',
              thinking: 'Deep thoughts',
              capturedAt: 1500,
              reason: 'CONTENT_FILTER',
              projectionSource: 'fragments',
            },
          },
        ],
      };

      const evalResult = evaluateCanonicalPromotion(pristineRawStream, censoredReplay);
      expect(evalResult.eligible).toBe(true);
      expect(evalResult.isCensored).toBe(true);
      expect(evalResult.terminalOutcome).toBe('filtered');
      expect(evalResult.lastGoodText).toBe('Valuable unredacted code');
      expect(evalResult.lastGoodThinking).toBe('Deep thoughts');
    });

    it('rejects promotion if raw stream integrity is gap_detected or corrupt', () => {
      const degradedStream: RawStreamRecord = {
        ...pristineRawStream,
        integrity: 'gap_detected',
      };
      const evalResult = evaluateCanonicalPromotion(degradedStream, cleanReplayResult);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reason).toBe('raw_stream_not_intact');
    });

    it('rejects promotion if raw stream has durabilityGap = true', () => {
      const gapStream: RawStreamRecord = {
        ...pristineRawStream,
        durabilityGap: true,
      };
      const evalResult = evaluateCanonicalPromotion(gapStream, cleanReplayResult);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reason).toBe('durability_gap_present');
    });

    it('rejects promotion if replay audit reports missing prefix or sequence gaps', () => {
      const corruptedReplay: ReplayResult = {
        ...cleanReplayResult,
        audit: {
          ...cleanReplayResult.audit,
          batchGap: true,
        },
      };
      const evalResult = evaluateCanonicalPromotion(pristineRawStream, corruptedReplay);
      expect(evalResult.eligible).toBe(false);
      expect(evalResult.reason).toBe('replay_sequence_anomalies');
    });
  });
});
