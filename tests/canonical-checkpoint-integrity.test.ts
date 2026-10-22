import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  CanonicalStreamCoordinator,
  type CanonicalCheckpointDto,
  type CanonicalCheckpointAck,
} from '../src/core/recorder/canonical-stream-coordinator';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { closeExtensionDatabase } from '../src/storage/db';
import type { Message, ResponseRevision, Conversation } from '../src/core/models';
import { computeSha256 } from '../src/shared/crypto';

describe('Canonical Checkpoint Delivery Integrity & Terminal Locking', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
  });

  describe('CanonicalStreamCoordinator: Sealed Checkpoint & Retry Queue', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });
    it('does not advance checkpointSeq on NACK or transport failure, retrying exact sealed checkpoint', async () => {
      const deliveredCheckpoints: CanonicalCheckpointDto[] = [];
      let failNextAttempts = 2; // Fail first 2 attempts, then succeed

      const coordinator = new CanonicalStreamCoordinator({
        producerSessionId: 'prod-sealed-1',
        streamId: 'stream-sealed-1',
        provisionalSessionId: 'sess-sealed-1',
        retryBackoffMs: [100, 500, 1000],
        debounceMs: 50,
        onCheckpoint: async (cp) => {
          deliveredCheckpoints.push(cp);
          if (failNextAttempts > 0) {
            failNextAttempts--;
            return {
              success: false,
              streamKey: cp.streamKey,
              checkpointSeq: cp.checkpointSeq,
              error: 'transient_network_failure',
            };
          }
          return {
            success: true,
            streamKey: cp.streamKey,
            checkpointSeq: cp.checkpointSeq,
            persistedAt: Date.now(),
          };
        },
      });

      // Feed delta event
      coordinator.feedSemanticEvent({
        streamId: 'stream-sealed-1',
        sequence: 1,
        timestamp: 100,
        type: 'answer_delta',
        delta: 'First delta content',
      });

      // Fast-forward debounce
      await vi.advanceTimersByTimeAsync(60);

      // Attempt 1 happened and failed. Sequence must still be 0!
      expect(deliveredCheckpoints).toHaveLength(1);
      expect(deliveredCheckpoints[0]!.checkpointSeq).toBe(0);
      expect(coordinator.getLastAckedSeq()).toBe(-1);
      expect(coordinator.getNextCheckpointSeq()).toBe(0);
      expect(coordinator.hasPendingCheckpoint()).toBe(true);

      // Fast-forward backoff retry #1 (100ms)
      await vi.advanceTimersByTimeAsync(110);

      // Attempt 2 happened and failed. Still seq 0!
      expect(deliveredCheckpoints).toHaveLength(2);
      expect(deliveredCheckpoints[1]!.checkpointSeq).toBe(0);
      expect(deliveredCheckpoints[1]!.revisions[0]!.text).toBe('First delta content');
      expect(coordinator.getLastAckedSeq()).toBe(-1);
      expect(coordinator.getNextCheckpointSeq()).toBe(0);

      // Fast-forward backoff retry #2 (500ms)
      await vi.advanceTimersByTimeAsync(510);

      // Attempt 3 succeeded!
      expect(deliveredCheckpoints).toHaveLength(3);
      expect(deliveredCheckpoints[2]!.checkpointSeq).toBe(0);
      expect(coordinator.getLastAckedSeq()).toBe(0);
      expect(coordinator.getNextCheckpointSeq()).toBe(1);
      expect(coordinator.hasPendingCheckpoint()).toBe(false);

      // Now send a second event
      coordinator.feedSemanticEvent({
        streamId: 'stream-sealed-1',
        sequence: 2,
        timestamp: 200,
        type: 'answer_delta',
        delta: ' and more content',
      });

      await vi.advanceTimersByTimeAsync(60);

      // Must be seq 1 (NO sequence gap!)
      expect(deliveredCheckpoints).toHaveLength(4);
      expect(deliveredCheckpoints[3]!.checkpointSeq).toBe(1);
      expect(coordinator.getLastAckedSeq()).toBe(1);
      expect(coordinator.getNextCheckpointSeq()).toBe(2);

      coordinator.dispose();
    });

    it('enforces single terminal checkpoint locking in coordinator', async () => {
      const delivered: CanonicalCheckpointDto[] = [];

      const coordinator = new CanonicalStreamCoordinator({
        producerSessionId: 'prod-term-coord',
        streamId: 'stream-term-coord',
        onCheckpoint: async (cp) => {
          delivered.push(cp);
          return {
            success: true,
            streamKey: cp.streamKey,
            checkpointSeq: cp.checkpointSeq,
          };
        },
      });

      coordinator.feedSemanticEvent({
        streamId: 'stream-term-coord',
        sequence: 1,
        timestamp: 100,
        type: 'stream_finished',
        terminalReason: 'completed',
      });

      await vi.runAllTimersAsync();

      expect(delivered).toHaveLength(1);
      expect(delivered[0]!.isFinal).toBe(true);
      expect(coordinator.getDiagnostics().isTerminalLocked).toBe(true);
      expect(coordinator.getDiagnostics().isTerminalCommitted).toBe(true);

      // Attempting to feed events after terminal lock is ignored
      coordinator.feedSemanticEvent({
        streamId: 'stream-term-coord',
        sequence: 2,
        timestamp: 200,
        type: 'answer_delta',
        delta: 'post terminal hallucination',
      });

      await vi.runAllTimersAsync();

      // No new checkpoints emitted
      expect(delivered).toHaveLength(1);

      coordinator.dispose();
    });
  });

  describe('StorageRepository: Durable Fingerprints & Conflict Rejection', () => {
    it('accepts valid sequential checkpoints (seq 0, seq 1)', async () => {
      const conv: Conversation = {
        id: 'conv-integ-1',
        title: 'Integ Test',
        createdAt: 1000,
        updatedAt: 1000,
      };

      const msg: Message = {
        id: 'msg-integ-1',
        conversationId: 'conv-integ-1',
        identityState: 'provisional',
        role: 'assistant',
        status: 'streaming',
        createdAt: 1000,
        updatedAt: 1000,
      };

      const rev0: ResponseRevision = {
        id: 'rev-integ-0',
        messageId: 'msg-integ-1',
        revisionIndex: 0,
        text: 'Initial text',
        source: 'network',
        capturedAt: 1000,
        isFinal: false,
        isLastGood: false,
        contentFingerprint: 'hash-0',
      };

      await storageRepo.saveCanonicalCheckpoint({
        streamKey: 'prod-store:stream-store',
        checkpointSeq: 0,
        conversation: conv,
        message: msg,
        revisions: [rev0],
        isTerminal: false,
      });

      const rev1: ResponseRevision = {
        id: 'rev-integ-1',
        messageId: 'msg-integ-1',
        revisionIndex: 1,
        text: 'Initial text with extension',
        source: 'network',
        capturedAt: 1100,
        isFinal: false,
        isLastGood: false,
        contentFingerprint: 'hash-1',
      };

      await storageRepo.saveCanonicalCheckpoint({
        streamKey: 'prod-store:stream-store',
        checkpointSeq: 1,
        message: msg,
        revisions: [rev1],
        isTerminal: false,
      });

      const savedRevs = await storageRepo.listRevisionsByMessage('msg-integ-1');
      expect(savedRevs).toHaveLength(2);
    });

    it('rejects sequence gap (e.g. seq 2 after seq 0) with checkpoint_sequence_gap', async () => {
      const conv: Conversation = {
        id: 'conv-gap',
        title: 'Gap Test',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const msg: Message = {
        id: 'msg-gap',
        conversationId: 'conv-gap',
        identityState: 'provisional',
        role: 'assistant',
        status: 'streaming',
        createdAt: 1000,
        updatedAt: 1000,
      };

      // seq 0
      await storageRepo.saveCanonicalCheckpoint({
        streamKey: 'prod-gap:stream-gap',
        checkpointSeq: 0,
        conversation: conv,
        message: msg,
        revisions: [],
        isTerminal: false,
      });

      // skip seq 1, send seq 2
      await expect(
        storageRepo.saveCanonicalCheckpoint({
          streamKey: 'prod-gap:stream-gap',
          checkpointSeq: 2,
          message: msg,
          revisions: [],
          isTerminal: false,
        })
      ).rejects.toThrow('checkpoint_sequence_gap: expected 1, got 2');
    });

    it('accepts identical re-ACK for same sequence (idempotent)', async () => {
      const conv: Conversation = {
        id: 'conv-idem',
        title: 'Idem Test',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const msg: Message = {
        id: 'msg-idem',
        conversationId: 'conv-idem',
        identityState: 'provisional',
        role: 'assistant',
        status: 'streaming',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const rev: ResponseRevision = {
        id: 'rev-idem-0',
        messageId: 'msg-idem',
        revisionIndex: 0,
        text: 'Stable text',
        source: 'network',
        capturedAt: 1000,
        isFinal: false,
        isLastGood: false,
        contentFingerprint: 'hash-idem',
      };

      // First delivery of seq 0
      await storageRepo.saveCanonicalCheckpoint({
        streamKey: 'prod-idem:stream-idem',
        checkpointSeq: 0,
        conversation: conv,
        message: msg,
        revisions: [rev],
        isTerminal: false,
      });

      // Re-delivery of identical seq 0 (e.g. lost ACK retry)
      await expect(
        storageRepo.saveCanonicalCheckpoint({
          streamKey: 'prod-idem:stream-idem',
          checkpointSeq: 0,
          conversation: conv,
          message: msg,
          revisions: [rev],
          isTerminal: false,
        })
      ).resolves.toBeUndefined();

      const revs = await storageRepo.listRevisionsByMessage('msg-idem');
      expect(revs).toHaveLength(1);
    });

    it('rejects differing payload on same sequence with checkpoint_conflict', async () => {
      const conv: Conversation = {
        id: 'conv-conf',
        title: 'Conflict Test',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const msg: Message = {
        id: 'msg-conf',
        conversationId: 'conv-conf',
        identityState: 'provisional',
        role: 'assistant',
        status: 'streaming',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const revA: ResponseRevision = {
        id: 'rev-conf-0',
        messageId: 'msg-conf',
        revisionIndex: 0,
        text: 'Version A',
        source: 'network',
        capturedAt: 1000,
        isFinal: false,
        isLastGood: false,
        contentFingerprint: 'hash-A',
      };

      await storageRepo.saveCanonicalCheckpoint({
        streamKey: 'prod-conf:stream-conf',
        checkpointSeq: 0,
        conversation: conv,
        message: msg,
        revisions: [revA],
        isTerminal: false,
      });

      // Attempting to send seq 0 with conflicting payload
      const revB: ResponseRevision = {
        id: 'rev-conf-0',
        messageId: 'msg-conf',
        revisionIndex: 0,
        text: 'Version B - CONFLICT',
        source: 'network',
        capturedAt: 1000,
        isFinal: false,
        isLastGood: false,
        contentFingerprint: 'hash-B',
      };

      await expect(
        storageRepo.saveCanonicalCheckpoint({
          streamKey: 'prod-conf:stream-conf',
          checkpointSeq: 0,
          conversation: conv,
          message: msg,
          revisions: [revB],
          isTerminal: false,
        })
      ).rejects.toThrow('checkpoint_conflict: sequence 0 already committed with different payload fingerprint');
    });

    it('enforces terminal checkpoint locking on repository', async () => {
      const conv: Conversation = {
        id: 'conv-lock',
        title: 'Lock Test',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const msg: Message = {
        id: 'msg-lock',
        conversationId: 'conv-lock',
        identityState: 'provisional',
        role: 'assistant',
        status: 'finished',
        createdAt: 1000,
        updatedAt: 1000,
      };

      // Save terminal checkpoint at seq 0
      await storageRepo.saveCanonicalCheckpoint({
        streamKey: 'prod-lock:stream-lock',
        checkpointSeq: 0,
        conversation: conv,
        message: msg,
        revisions: [],
        isTerminal: true,
      });

      // Identical re-ACK of terminal seq 0 succeeds
      await expect(
        storageRepo.saveCanonicalCheckpoint({
          streamKey: 'prod-lock:stream-lock',
          checkpointSeq: 0,
          conversation: conv,
          message: msg,
          revisions: [],
          isTerminal: true,
        })
      ).resolves.toBeUndefined();

      // Subsequent seq 1 must be rejected with terminal_checkpoint_locked
      await expect(
        storageRepo.saveCanonicalCheckpoint({
          streamKey: 'prod-lock:stream-lock',
          checkpointSeq: 1,
          message: msg,
          revisions: [],
          isTerminal: false,
        })
      ).rejects.toThrow('terminal_checkpoint_locked: stream prod-lock:stream-lock is terminal, cannot commit seq 1');
    });
  });
});
