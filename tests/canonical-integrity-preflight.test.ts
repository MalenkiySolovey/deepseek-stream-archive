import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { closeExtensionDatabase } from '../src/storage/db';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import {
  makeProvisionalMessageId,
  mergeCanonicalMessage,
  computeContentFingerprint,
  type Conversation,
  type Message,
  type ResponseRevision,
  type RecoveryEvent,
} from '../src/core/models';
import type { ReplayPromotionPlan } from '../src/core/contracts';

describe('Canonical Integrity & Persistence Truth Gate', () => {
  let fakeFactory: IDBFactory;
  let repository: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    repository = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase();
  });

  describe('Durable Checkpoint Ledger & Sequence Enforcement (Section 9)', () => {
    it('rejects initial checkpoint if sequenceNumber does not start at 0', async () => {
      const data = {
        streamKey: 'prod-gate:stream-gap-init',
        checkpointSeq: 1, // Gap! Should be 0
        message: {
          id: 'msg-gap-1',
          conversationId: 'conv-gap-1',
          role: 'assistant' as const,
          status: 'streaming' as const,
          identityState: 'provisional' as const,
          createdAt: 100,
          updatedAt: 100,
        },
        revisions: [],
      };

      await expect(repository.saveCanonicalCheckpoint(data)).rejects.toThrow(
        /checkpoint_sequence_gap/
      );
    });

    it('enforces monotonic checkpoint progression and rejects sequence gaps', async () => {
      const baseMsg: Message = {
        id: 'msg-mono-1',
        conversationId: 'conv-mono-1',
        role: 'assistant',
        status: 'streaming',
        identityState: 'provisional',
        createdAt: 100,
        updatedAt: 100,
      };

      // 1. Seq 0 succeeds
      await repository.saveCanonicalCheckpoint({
        streamKey: 'prod:mono-stream',
        checkpointSeq: 0,
        message: baseMsg,
        revisions: [],
      });

      // 2. Seq 1 succeeds (expected monotonic next)
      await repository.saveCanonicalCheckpoint({
        streamKey: 'prod:mono-stream',
        checkpointSeq: 1,
        message: baseMsg,
        revisions: [],
      });

      // 3. Seq 3 rejected as gap (expected 2)
      await expect(
        repository.saveCanonicalCheckpoint({
          streamKey: 'prod:mono-stream',
          checkpointSeq: 3,
          message: baseMsg,
          revisions: [],
        })
      ).rejects.toThrow(/checkpoint_sequence_gap: expected 2, got 3/);
    });

    it('handles idempotent re-ACK (identical sequenceNumber) gracefully without corruption', async () => {
      const baseMsg: Message = {
        id: 'msg-idemp-1',
        conversationId: 'conv-idemp-1',
        role: 'assistant',
        status: 'streaming',
        identityState: 'provisional',
        createdAt: 100,
        updatedAt: 100,
      };

      // Seq 0 initial
      await repository.saveCanonicalCheckpoint({
        streamKey: 'prod:idemp-stream',
        checkpointSeq: 0,
        message: baseMsg,
        revisions: [],
      });

      // Seq 0 repeated (network re-send / duplicate ACK)
      await expect(
        repository.saveCanonicalCheckpoint({
          streamKey: 'prod:idemp-stream',
          checkpointSeq: 0,
          message: baseMsg,
          revisions: [],
        })
      ).resolves.not.toThrow();
    });
  });

  describe('Immutable Revisions & Recovery Events (Section 8)', () => {
    it('permits identical revision writes but rejects conflicting revision mutation', async () => {
      const baseMsg: Message = {
        id: 'msg-immut-1',
        conversationId: 'conv-immut-1',
        role: 'assistant',
        status: 'streaming',
        identityState: 'provisional',
        createdAt: 100,
        updatedAt: 100,
      };

      const rev1: ResponseRevision = {
        id: 'rev-immutable-test',
        messageId: 'msg-immut-1',
        revisionIndex: 0,
        text: 'Original durable response chunk',
        source: 'network',
        capturedAt: 100,
        isFinal: false,
        isLastGood: false,
      };

      // Initial commit
      await repository.saveCanonicalCheckpoint({
        streamKey: 'prod:immut-stream',
        checkpointSeq: 0,
        message: baseMsg,
        revisions: [rev1],
      });

      // Idempotent identical rewrite succeeds
      await expect(
        repository.saveCanonicalCheckpoint({
          streamKey: 'prod:immut-stream',
          checkpointSeq: 0, // idempotent seq
          message: baseMsg,
          revisions: [{ ...rev1 }],
        })
      ).resolves.not.toThrow();

      // Conflicting revision mutation on next seq throws revision_conflict
      const conflictingRev: ResponseRevision = {
        id: 'rev-immutable-test',
        messageId: 'msg-immut-1',
        revisionIndex: 0,
        text: 'MUTATED unauthorized revision payload',
        source: 'network',
        capturedAt: 100,
        isFinal: false,
        isLastGood: false,
      };

      await expect(
        repository.saveCanonicalCheckpoint({
          streamKey: 'prod:immut-stream',
          checkpointSeq: 1,
          message: baseMsg,
          revisions: [conflictingRev],
        })
      ).rejects.toThrow(/revision_conflict: cannot mutate existing revision rev-immutable-test/);
    });

    it('rejects conflicting recovery event mutation', async () => {
      const baseMsg: Message = {
        id: 'msg-rec-immut',
        conversationId: 'conv-rec-immut',
        role: 'assistant',
        status: 'filtered',
        identityState: 'provisional',
        createdAt: 100,
        updatedAt: 100,
      };

      const event: RecoveryEvent = {
        id: 'rec-event-1',
        messageId: 'msg-rec-immut',
        kind: 'content_filter',
        detectedAt: 100,
        recoveredRevisionId: 'rev-rec-1',
        reason: 'Original reason',
      };

      await repository.saveCanonicalCheckpoint({
        streamKey: 'prod:rec-immut',
        checkpointSeq: 0,
        message: baseMsg,
        revisions: [],
        recoveryEvents: [event],
      });

      const conflictingEvent: RecoveryEvent = {
        id: 'rec-event-1',
        messageId: 'msg-rec-immut',
        kind: 'synthetic', // Changed kind!
        detectedAt: 100,
        recoveredRevisionId: 'rev-rec-1',
        reason: 'Tampered reason',
      };

      await expect(
        repository.saveCanonicalCheckpoint({
          streamKey: 'prod:rec-immut',
          checkpointSeq: 1,
          message: baseMsg,
          revisions: [],
          recoveryEvents: [conflictingEvent],
        })
      ).rejects.toThrow(/recovery_event_conflict: cannot mutate existing recovery event rec-event-1/);
    });
  });

  describe('Identity & Status Merge Policy (Section 11 & 12)', () => {
    it('prevents reconciled status from regressing to provisional', () => {
      const existing: Message = {
        id: 'msg-merge-1',
        remoteId: 'remote-100',
        conversationId: 'conv-1',
        identityState: 'reconciled',
        role: 'assistant',
        status: 'finished',
        createdAt: 100,
        updatedAt: 200,
      };

      const incoming: Message = {
        id: 'msg-merge-1',
        conversationId: 'conv-1',
        identityState: 'provisional',
        role: 'assistant',
        status: 'streaming',
        createdAt: 150,
        updatedAt: 300,
      };

      const merged = mergeCanonicalMessage(existing, incoming, 'live');
      expect(merged.identityState).toBe('reconciled');
      expect(merged.remoteId).toBe('remote-100');
    });

    it('prevents filtered status from being downgraded to finished or streaming', () => {
      const existing: Message = {
        id: 'msg-merge-filtered',
        conversationId: 'conv-1',
        identityState: 'provisional',
        role: 'assistant',
        status: 'filtered',
        createdAt: 100,
        updatedAt: 200,
      };

      const incoming: Message = {
        id: 'msg-merge-filtered',
        conversationId: 'conv-1',
        identityState: 'provisional',
        role: 'assistant',
        status: 'finished',
        createdAt: 100,
        updatedAt: 250,
      };

      const merged = mergeCanonicalMessage(existing, incoming, 'live');
      expect(merged.status).toBe('filtered');
    });

    it('guarantees identical deterministic provisional ID between live coordinator and replay rebuilder', () => {
      const streamKey = 'prod_session_1:stream_42';
      const provisionalId1 = makeProvisionalMessageId(streamKey);
      const provisionalId2 = makeProvisionalMessageId('prod_session_1:stream_42');

      expect(provisionalId1).toBe(provisionalId2);
      expect(provisionalId1).toBe('msg_prod_session_1_stream_42');
    });
  });

  describe('Atomic Replay Promotion Plan Persistence (Section 15)', () => {
    it('applies replay promotion plan atomically across stores', async () => {
      const plan: ReplayPromotionPlan = {
        conversation: {
          id: 'conv-promo-1',
          title: 'Promoted Chat',
          createdAt: 100,
          updatedAt: 200,
        },
        message: {
          id: 'msg-promo-1',
          conversationId: 'conv-promo-1',
          role: 'assistant',
          status: 'finished',
          identityState: 'provisional',
          createdAt: 100,
          updatedAt: 200,
        },
        revisions: [
          {
            id: 'rev-promo-1',
            messageId: 'msg-promo-1',
            revisionIndex: 0,
            text: 'Replayed text',
            source: 'replay',
            capturedAt: 200,
            isFinal: true,
            isLastGood: false,
          },
        ],
        recoveryEvents: [],
      };

      await repository.applyReplayPromotionPlan(plan);

      const conv = await repository.getConversation('conv-promo-1');
      const msg = await repository.getMessage('msg-promo-1');
      const rev = await repository.getRevision('rev-promo-1');

      expect(conv).not.toBeNull();
      expect(msg).not.toBeNull();
      expect(rev).not.toBeNull();
    });
  });
});
