import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { CanonicalStreamCoordinator } from '../src/core/recorder/canonical-stream-coordinator';
import {
  MESSAGE_PERSIST_CANONICAL_CHECKPOINT,
  type PersistCanonicalCheckpointRequest,
  type PersistCanonicalCheckpointResponse,
} from '../src/bridge/messages';
import { validatePersistCanonicalCheckpointRequest } from '../src/bridge/validation';

describe('Canonical Runtime Integration Pipeline', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  it('persists live streaming canonical checkpoints end-to-end through bridge and storage', async () => {
    // Simulated background message dispatcher
    const handleBackgroundMessage = async (msg: unknown): Promise<PersistCanonicalCheckpointResponse> => {
      const validated = validatePersistCanonicalCheckpointRequest(msg);
      if (!validated) {
        return {
          success: false,
          streamKey: '',
          checkpointSeq: -1,
          error: 'invalid_request',
        };
      }

      await storageRepo.saveCanonicalCheckpoint(validated.checkpoint);

      return {
        success: true,
        streamKey: validated.checkpoint.streamKey,
        checkpointSeq: validated.checkpoint.checkpointSeq,
        persistedAt: Date.now(),
      };
    };

    const coordinator = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_e2e_1',
      streamId: 'stream_e2e_1',
      provisionalSessionId: 'sess_e2e_1',
      conversationTitle: 'Live Streaming Conversation',
      onCheckpoint: async (dto) => {
        const req: PersistCanonicalCheckpointRequest = {
          type: MESSAGE_PERSIST_CANONICAL_CHECKPOINT,
          checkpoint: {
            streamKey: dto.streamKey,
            checkpointSeq: dto.checkpointSeq,
            isTerminal: dto.isFinal,
            conversation: dto.conversation,
            message: dto.message,
            revisions: dto.revisions,
            recoveryEvents: dto.recoveryEvents,
          },
        };
        return await handleBackgroundMessage(req);
      },
      debounceMs: 50,
    });

    // 1. Initial streaming tokens
    coordinator.feedSemanticEvent({
      streamId: 'stream_e2e_1',
      sequence: 1,
      timestamp: 1000,
      type: 'thinking_delta',
      delta: 'Reasoning about topological quantum computing...',
    });

    coordinator.feedSemanticEvent({
      streamId: 'stream_e2e_1',
      sequence: 2,
      timestamp: 1050,
      type: 'answer_delta',
      delta: 'Topological quantum computers use anyons to perform fault-tolerant operations.',
    });

    // Trigger explicit checkpoint flush
    await coordinator.triggerCheckpoint(false);

    // Verify storage has conversation, message, and initial revision
    const conv = await storageRepo.getConversation('sess_e2e_1');
    expect(conv).not.toBeNull();
    expect(conv?.title).toBe('Live Streaming Conversation');

    const messages = await storageRepo.listMessagesByConversation('sess_e2e_1');
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.role).toBe('assistant');
    expect(msg.identityState).toBe('provisional');
    expect(msg.status).toBe('streaming');

    const revisions = await storageRepo.listRevisionsByMessage(msg.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0]!.text).toBe(
      'Topological quantum computers use anyons to perform fault-tolerant operations.'
    );
    expect(revisions[0]!.thinking).toBe('Reasoning about topological quantum computing...');
    expect(revisions[0]!.isFinal).toBe(false);

    // 2. Authoritative message ID arrives from server
    coordinator.feedSemanticEvent({
      streamId: 'stream_e2e_1',
      sequence: 3,
      timestamp: 1100,
      type: 'message_id_identified',
      messageId: '10992288',
    });

    // Wait for checkpoint transaction to persist
    await new Promise((resolve) => setTimeout(resolve, 20));

    const updatedMsg = await storageRepo.getMessage(msg.id);
    expect(updatedMsg?.remoteId).toBe('10992288');

    // 3. Filter triggered: model answers censored template
    coordinator.feedSemanticEvent({
      streamId: 'stream_e2e_1',
      sequence: 4,
      timestamp: 1200,
      type: 'filter_triggered',
      lastGood: {
        answer: 'Topological quantum computers use anyons to perform fault-tolerant operations.',
        thinking: 'Reasoning about topological quantum computing...',
        capturedAt: 1200,
        reason: 'CONTENT_FILTER',
        projectionSource: 'top_level',
      },
    });

    // 4. Replacement answer (censor template)
    coordinator.feedSemanticEvent({
      streamId: 'stream_e2e_1',
      sequence: 5,
      timestamp: 1250,
      type: 'answer_replace',
      fullText: 'I apologize, but I cannot discuss sensitive quantum technology.',
    });

    // 5. Finished
    coordinator.feedSemanticEvent({
      streamId: 'stream_e2e_1',
      sequence: 6,
      timestamp: 1300,
      type: 'stream_finished',
      terminalReason: 'filtered',
    });

    // Wait for final checkpoint transaction to persist
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Final storage verification
    const finalRevs = await storageRepo.listRevisionsByMessage(msg.id);
    expect(finalRevs.length).toBeGreaterThanOrEqual(2);

    const lastGood = await storageRepo.getLastGoodRevision(msg.id);
    expect(lastGood).not.toBeNull();
    expect(lastGood?.isLastGood).toBe(true);
    expect(lastGood?.text).toBe(
      'Topological quantum computers use anyons to perform fault-tolerant operations.'
    );

    const recoveryEvents = await storageRepo.listRecoveryEvents(msg.id);
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0]!.kind).toBe('content_filter');
    expect(recoveryEvents[0]!.recoveredRevisionId).toBe(lastGood?.id);

    const finalMsg = await storageRepo.getMessage(msg.id);
    expect(finalMsg?.status).toBe('filtered');

    coordinator.dispose();
  });
});
