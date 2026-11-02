import { describe, it, expect } from 'vitest';
import {
  evaluateRawStreamRetention,
  getCutoffTimestamp,
} from '../src/storage/retention/policy';
import type { RawStreamRecord } from '../src/storage/raw-journal/types';

describe('Raw Evidence Retention Policy Engine (Milestone 2E.3)', () => {
  const baseStream: RawStreamRecord = {
    id: 'prod-1:stream-1',
    producerSessionId: 'prod-1',
    streamId: 'stream-1',
    transport: 'fetch',
    url: 'https://chat.deepseek.com/api/v0/chat/completion',
    method: 'POST',
    state: 'completed',
    openedAt: 1000000,
    updatedAt: 1005000,
    finalizedAt: 1005000,
    totalChunks: 10,
    totalChars: 500,
    totalBatches: 2,
    integrity: 'intact',
    durabilityGap: false,
    droppedChars: 0,
  };

  const NOW = 20000000000; // Reference timestamp far in future

  describe('getCutoffTimestamp', () => {
    it('returns undefined when mode is forever', () => {
      expect(getCutoffTimestamp('forever', NOW)).toBeUndefined();
    });

    it('computes exact millisecond boundaries for 30, 90, 180 days', () => {
      const ms30 = 30 * 24 * 60 * 60 * 1000;
      const ms90 = 90 * 24 * 60 * 60 * 1000;
      const ms180 = 180 * 24 * 60 * 60 * 1000;

      expect(getCutoffTimestamp('30', NOW)).toBe(NOW - ms30);
      expect(getCutoffTimestamp('90', NOW)).toBe(NOW - ms90);
      expect(getCutoffTimestamp('180', NOW)).toBe(NOW - ms180);
    });
  });

  describe('evaluateRawStreamRetention Shield Guarantees', () => {
    it('disables retention when mode is forever', () => {
      const decision = evaluateRawStreamRetention(baseStream, {
        mode: 'forever',
        now: NOW,
        isActive: false,
      });

      expect(decision.eligible).toBe(false);
      expect(decision.reason).toBe('retention_disabled');
      expect(decision.streamKey).toBe(baseStream.id);
    });

    it('shields active streams whether indicated by flag or record state', () => {
      // isActive flag in context
      const d1 = evaluateRawStreamRetention(baseStream, {
        mode: '30',
        now: NOW,
        isActive: true,
      });
      expect(d1.eligible).toBe(false);
      expect(d1.reason).toBe('active');

      // state is active on record
      const d2 = evaluateRawStreamRetention({ ...baseStream, state: 'active' }, {
        mode: '30',
        now: NOW,
        isActive: false,
      });
      expect(d2.eligible).toBe(false);
      expect(d2.reason).toBe('active');
    });

    it('shields streams with pre-filter recovery provenance', () => {
      // Filter status
      const d1 = evaluateRawStreamRetention(baseStream, {
        mode: '30',
        now: NOW,
        isActive: false,
        hasFilterStatus: true,
      });
      expect(d1.eligible).toBe(false);
      expect(d1.reason).toBe('recovery_protected');

      // Recovery event
      const d2 = evaluateRawStreamRetention(baseStream, {
        mode: '30',
        now: NOW,
        isActive: false,
        hasRecoveryEvent: true,
      });
      expect(d2.eligible).toBe(false);
      expect(d2.reason).toBe('recovery_protected');

      // Last good revision
      const d3 = evaluateRawStreamRetention(baseStream, {
        mode: '30',
        now: NOW,
        isActive: false,
        hasLastGoodRevision: true,
      });
      expect(d3.eligible).toBe(false);
      expect(d3.reason).toBe('recovery_protected');
    });

    it('shields streams with forensic anomalies and degraded integrity', () => {
      // Gap detected integrity
      const d1 = evaluateRawStreamRetention({ ...baseStream, integrity: 'gap_detected' }, {
        mode: '30',
        now: NOW,
        isActive: false,
      });
      expect(d1.eligible).toBe(false);
      expect(d1.reason).toBe('forensic_protected');

      // Durability gap
      const d2 = evaluateRawStreamRetention({ ...baseStream, durabilityGap: true }, {
        mode: '30',
        now: NOW,
        isActive: false,
      });
      expect(d2.eligible).toBe(false);
      expect(d2.reason).toBe('forensic_protected');

      // Dropped chars
      const d3 = evaluateRawStreamRetention({ ...baseStream, droppedChars: 15 }, {
        mode: '30',
        now: NOW,
        isActive: false,
      });
      expect(d3.eligible).toBe(false);
      expect(d3.reason).toBe('forensic_protected');

      // Terminal aborted state
      const d4 = evaluateRawStreamRetention({ ...baseStream, state: 'aborted' }, {
        mode: '30',
        now: NOW,
        isActive: false,
      });
      expect(d4.eligible).toBe(false);
      expect(d4.reason).toBe('forensic_protected');

      // Terminal error state
      const d5 = evaluateRawStreamRetention({ ...baseStream, state: 'error', error: 'ECONNRESET' }, {
        mode: '30',
        now: NOW,
        isActive: false,
      });
      expect(d5.eligible).toBe(false);
      expect(d5.reason).toBe('forensic_protected');

      // Unmatched capture
      const d6 = evaluateRawStreamRetention(baseStream, {
        mode: '30',
        now: NOW,
        isActive: false,
        isUnmatchedCapture: true,
      });
      expect(d6.eligible).toBe(false);
      expect(d6.reason).toBe('forensic_protected');
    });

    it('enforces exact millisecond age cutoff boundary', () => {
      const mode = '30';
      const cutoff = getCutoffTimestamp(mode, NOW)!;

      // Stream younger than cutoff (even by 1ms)
      const youngStream = { ...baseStream, openedAt: cutoff + 1 };
      const dYoung = evaluateRawStreamRetention(youngStream, {
        mode,
        now: NOW,
        isActive: false,
      });
      expect(dYoung.eligible).toBe(false);
      expect(dYoung.reason).toBe('too_recent');

      // Stream exactly at cutoff
      const exactStream = { ...baseStream, openedAt: cutoff };
      const dExact = evaluateRawStreamRetention(exactStream, {
        mode,
        now: NOW,
        isActive: false,
      });
      expect(dExact.eligible).toBe(true);
      expect(dExact.reason).toBe('expired_safe');

      // Stream older than cutoff
      const oldStream = { ...baseStream, openedAt: cutoff - 1000 };
      const dOld = evaluateRawStreamRetention(oldStream, {
        mode,
        now: NOW,
        isActive: false,
      });
      expect(dOld.eligible).toBe(true);
      expect(dOld.reason).toBe('expired_safe');
    });

    it('demonstrates clock injection determinism without system time dependencies', () => {
      const streamTime = 1000000;
      const testStream = { ...baseStream, openedAt: streamTime };

      // With now = streamTime + 10 days, mode = 30 -> too recent
      const now1 = streamTime + 10 * 24 * 60 * 60 * 1000;
      expect(evaluateRawStreamRetention(testStream, { mode: '30', now: now1, isActive: false }).eligible).toBe(false);

      // With now = streamTime + 31 days, mode = 30 -> expired safe
      const now2 = streamTime + 31 * 24 * 60 * 60 * 1000;
      expect(evaluateRawStreamRetention(testStream, { mode: '30', now: now2, isActive: false }).eligible).toBe(true);
    });
  });
});
