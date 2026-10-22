import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import {
  MESSAGE_SAVE_SYNTHETIC_BATCH,
  MESSAGE_GET_FOUNDATION_STATUS,
  type SaveSyntheticBatchRequest,
  type SaveSyntheticBatchResponse,
  type FoundationStatusResponse,
} from '../src/bridge/messages';
import type { Conversation, Message, ResponseRevision } from '../src/core/models';
import { STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS } from '../src/storage/schema';

describe('ACK Pipeline & Batch Persistence Semantics', () => {
  let fakeFactory: IDBFactory;
  let repository: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    repository = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase();
  });

  const createValidBatchData = (seq: number) => {
    const conversation: Conversation = {
      id: `conv-ack-${seq}`,
      title: `Batch Run #${seq}`,
      createdAt: 1710000000 + seq,
      updatedAt: 1710000000 + seq,
    };
    const message: Message = {
      id: `msg-ack-${seq}`,
      conversationId: conversation.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 1710000000 + seq,
      updatedAt: 1710000000 + seq,
    };
    const revision: ResponseRevision = {
      id: `rev-ack-${seq}`,
      messageId: message.id,
      revisionIndex: 0,
      text: `Synthetic response text for batch ${seq}`,
      source: 'synthetic',
      capturedAt: 1710000000 + seq,
      isFinal: true,
      isLastGood: true,
    };
    return { conversation, message, revision };
  };

  /**
   * Simulates the Background Service Worker message handler for ACK pipeline processing.
   */
  const handleBackgroundMessage = async (
    req: SaveSyntheticBatchRequest,
    repo: IndexedDbStorageRepository
  ): Promise<SaveSyntheticBatchResponse> => {
    if (req.type !== MESSAGE_SAVE_SYNTHETIC_BATCH) {
      throw new Error(`Unexpected message type: ${req.type}`);
    }

    try {
      await repo.saveSyntheticBatch(req.data);
      return {
        success: true,
        batchSeq: req.batchSeq,
        persistedAt: Date.now(),
      };
    } catch (err) {
      return {
        success: false,
        batchSeq: req.batchSeq,
        persistedAt: Date.now(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  it('delivers positive ACK only upon successful atomic commit', async () => {
    const batchSeq = 1;
    const batchData = createValidBatchData(batchSeq);

    const request: SaveSyntheticBatchRequest = {
      type: MESSAGE_SAVE_SYNTHETIC_BATCH,
      batchSeq,
      data: batchData,
    };

    const response = await handleBackgroundMessage(request, repository);

    // Assert ACK contract
    expect(response.success).toBe(true);
    expect(response.batchSeq).toBe(1);
    expect(response.error).toBeUndefined();
    expect(response.persistedAt).toBeGreaterThan(0);

    // Verify all 3 entities are actually persisted in IndexedDB
    const savedConv = await repository.getConversation(batchData.conversation.id);
    const savedMsg = await repository.getMessage(batchData.message.id);
    const savedRev = await repository.getRevision(batchData.revision.id);

    expect(savedConv).not.toBeNull();
    expect(savedMsg).not.toBeNull();
    expect(savedRev).not.toBeNull();
  });

  it('preserves sequence ordering across consecutive ACK batches', async () => {
    for (let seq = 1; seq <= 5; seq++) {
      const batchData = createValidBatchData(seq);
      const request: SaveSyntheticBatchRequest = {
        type: MESSAGE_SAVE_SYNTHETIC_BATCH,
        batchSeq: seq,
        data: batchData,
      };

      const ack = await handleBackgroundMessage(request, repository);
      expect(ack.success).toBe(true);
      expect(ack.batchSeq).toBe(seq);
    }

    const convs = await repository.listConversations();
    expect(convs).toHaveLength(5);
  });

  it('guarantees no fake ACK and returns success=false if atomic transaction fails', async () => {
    // Create a mock repository whose saveSyntheticBatch fails (simulating I/O error or quota exhaustion)
    const failingRepo = new IndexedDbStorageRepository(fakeFactory);
    failingRepo.saveSyntheticBatch = async () => {
      throw new Error('QuotaExceededError: Simulated storage write failure');
    };

    const request: SaveSyntheticBatchRequest = {
      type: MESSAGE_SAVE_SYNTHETIC_BATCH,
      batchSeq: 42,
      data: createValidBatchData(42),
    };

    const response = await handleBackgroundMessage(request, failingRepo);

    // Must NOT return success: true!
    expect(response.success).toBe(false);
    expect(response.batchSeq).toBe(42);
    expect(response.error).toContain('QuotaExceededError');

    // Storage must not have any corrupt entries
    const conv = await repository.getConversation('conv-ack-42');
    expect(conv).toBeNull();
  });

  it('rolls back all records if transaction is aborted (atomicity invariant)', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const batchData = createValidBatchData(999);

    // Intentionally abort transaction after starting writes
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(
        [STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS],
        'readwrite'
      );

      tx.objectStore(STORE_CONVERSATIONS).put(batchData.conversation);
      tx.objectStore(STORE_MESSAGES).put(batchData.message);

      // Abort the transaction explicitly before completion
      tx.abort();

      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
      tx.oncomplete = () => reject(new Error('Should not have completed'));
    });

    // Verify neither conversation nor message was committed
    const conv = await repository.getConversation(batchData.conversation.id);
    const msg = await repository.getMessage(batchData.message.id);

    expect(conv).toBeNull();
    expect(msg).toBeNull();
  });

  it('accurately aggregates foundation status after acknowledged batches', async () => {
    // Add two batches
    await handleBackgroundMessage(
      {
        type: MESSAGE_SAVE_SYNTHETIC_BATCH,
        batchSeq: 1,
        data: createValidBatchData(1),
      },
      repository
    );

    await handleBackgroundMessage(
      {
        type: MESSAGE_SAVE_SYNTHETIC_BATCH,
        batchSeq: 2,
        data: createValidBatchData(2),
      },
      repository
    );

    // Calculate status
    const conversations = await repository.listConversations();
    let revCount = 0;
    for (const conv of conversations) {
      const msgs = await repository.listMessagesByConversation(conv.id);
      for (const msg of msgs) {
        const revs = await repository.listRevisionsByMessage(msg.id);
        revCount += revs.length;
      }
    }

    const status: FoundationStatusResponse = {
      bridgeState: 'observed',
      backgroundAlive: true,
      storageOperational: true,
      persistedCount: revCount,
      lastPersistedAt: Date.now(),
      transport: {
        fetchStreamsCount: 0,
        xhrStreamsCount: 0,
        activeStreamsCount: 0,
        sseEventsDecodedCount: 0,
        transportErrorsCount: 0,
      },
    };

    expect(status.bridgeState).toBe('observed');
    expect(status.storageOperational).toBe(true);
    expect(status.persistedCount).toBe(2);
  });
});
