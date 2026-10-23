import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { closeExtensionDatabase } from '../src/storage/db';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { RawStreamRepository } from '../src/storage/raw-journal/repository';
import { CanonicalStreamCoordinator } from '../src/core/recorder/canonical-stream-coordinator';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { ReplayRebuilder } from '../src/core/reconciliation/replay-rebuilder';
import type { RawStreamBatch } from '../src/storage/raw-journal/types';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';
import type { PersistCanonicalCheckpointRequest } from '../src/bridge/messages';
import { MESSAGE_PERSIST_CANONICAL_CHECKPOINT } from '../src/bridge/messages';
import { validatePersistCanonicalCheckpointRequest } from '../src/bridge/validation';

describe('Three Truths End-to-End Convergence', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;
  let rawRepo: RawStreamRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
    rawRepo = new RawStreamRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
  });

  it('proves Raw Journal, Live Canonical Record, and Server History converge without data degradation', async () => {
    const producerSessionId = 'prod_3truths_1';
    const streamId = 'stream_3truths_1';
    const remoteSessionId = 'sess_remote_999';
    const remoteMessageId = 'msg_remote_888';
    const streamKey = `${producerSessionId}:${streamId}`;

    // =========================================================================
    // TRUTH 1: Raw Journal Evidence
    // Raw transport frames intercepted and committed before decoding/rendering
    // =========================================================================
    await rawRepo.openStream({
      producerSessionId,
      streamId,
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      provisionalSessionId: remoteSessionId,
      openedAt: 1000,
    });

    const batch1: RawStreamBatch = {
      id: `${streamKey}:1`,
      streamKey,
      batchSeq: 1,
      charCount: 160,
      createdAt: 1050,
      chunks: [
        {
          streamSequence: 1,
          chunkText:
            'event: ready\ndata: {"request_message_id":"prompt_remote_777","response_message_id":"' +
            remoteMessageId +
            '"}\n\n' +
            'data: {"p":"response/message_id","o":"SET","v":"' +
            remoteMessageId +
            '"}\n\n' +
            'data: {"p":"response/fragments/0","o":"SET","v":{"type":"RESPONSE","content":"Uncensored raw theorem proof."}}\n\n',
          timestamp: 1050,
        },
      ],
    };
    await rawRepo.persistBatch(batch1);

    const batch2: RawStreamBatch = {
      id: `${streamKey}:2`,
      streamKey,
      batchSeq: 2,
      charCount: 140,
      createdAt: 1150,
      chunks: [
        {
          streamSequence: 2,
          chunkText:
            'data: {"p":"response/fragments/0","o":"SET","v":{"type":"RESPONSE","content":"I am unable to answer this question due to safety policies."}}\n\n' +
            'data: {"p":"response/status","o":"SET","v":"CONTENT_FILTER"}\n\n',
          timestamp: 1150,
        },
      ],
    };
    await rawRepo.persistBatch(batch2);

    await rawRepo.finalizeStream(
      streamKey,
      'completed',
      'CONTENT_FILTER',
      undefined,
      0,
      false,
      'intact'
    );

    // Verify Truth 1 is durable in raw stores
    const loadedStream = await rawRepo.getStream(streamKey);
    expect(loadedStream).not.toBeNull();
    expect(loadedStream?.integrity).toBe('intact');
    const loadedBatches = await rawRepo.listBatchesForStream(streamKey);
    expect(loadedBatches).toHaveLength(2);

    // =========================================================================
    // TRUTH 2: Live Canonical Record
    // StreamCoordinator emits incremental and terminal checkpoints to background
    // =========================================================================
    const handleBackgroundCheckpoint = async (req: unknown) => {
      const validated = validatePersistCanonicalCheckpointRequest(req);
      if (!validated) throw new Error('Validation failed');
      await storageRepo.saveCanonicalCheckpoint(validated.checkpoint);
      return {
        success: true,
        streamKey: validated.checkpoint.streamKey,
        checkpointSeq: validated.checkpoint.checkpointSeq,
        persistedAt: Date.now(),
      };
    };

    const coordinator = new CanonicalStreamCoordinator({
      producerSessionId,
      streamId,
      provisionalSessionId: remoteSessionId,
      conversationTitle: 'DeepSeek Research Session',
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
        return await handleBackgroundCheckpoint(req);
      },
      debounceMs: 50,
    });

    // Feed initial tokens
    coordinator.feedSemanticEvent({
      streamId,
      sequence: 1,
      timestamp: 1050,
      type: 'thinking_delta',
      delta: 'Validating mathematical derivation...',
    });

    coordinator.feedSemanticEvent({
      streamId,
      sequence: 2,
      timestamp: 1060,
      type: 'answer_delta',
      delta: 'Uncensored raw theorem proof.',
    });

    // Authoritative message ID arrives mid-stream
    coordinator.feedSemanticEvent({
      streamId,
      sequence: 3,
      timestamp: 1100,
      type: 'message_id_identified',
      messageId: remoteMessageId,
    });

    // DeepSeek triggers content filter mid-stream
    coordinator.feedSemanticEvent({
      streamId,
      sequence: 4,
      timestamp: 1150,
      type: 'filter_triggered',
      lastGood: {
        answer: 'Uncensored raw theorem proof.',
        thinking: 'Validating mathematical derivation...',
        capturedAt: 1150,
        reason: 'CONTENT_FILTER',
        projectionSource: 'top_level',
      },
    });

    // DeepSeek replaces answer with canned template
    coordinator.feedSemanticEvent({
      streamId,
      sequence: 5,
      timestamp: 1180,
      type: 'answer_replace',
      fullText: 'I am unable to answer this question due to safety policies.',
    });

    // Stream finishes with terminal reason 'filtered'
    coordinator.feedSemanticEvent({
      streamId,
      sequence: 6,
      timestamp: 1200,
      type: 'stream_finished',
      terminalReason: 'filtered',
    });

    await coordinator.awaitFinalPersistence(5000);

    // Verify Truth 2 in Canonical DB
    const liveConv = await storageRepo.getConversation(remoteSessionId);
    expect(liveConv).not.toBeNull();

    const liveMessages = await storageRepo.listMessagesByConversation(remoteSessionId);
    expect(liveMessages).toHaveLength(1);
    const liveMsg = liveMessages[0]!;
    expect(liveMsg.remoteId).toBe(remoteMessageId);
    expect(liveMsg.status).toBe('filtered');
    expect(liveMsg.identityState).toBe('provisional');

    const liveRevisions = await storageRepo.listRevisionsByMessage(liveMsg.id);
    expect(liveRevisions.length).toBeGreaterThanOrEqual(2);

    const liveLastGood = await storageRepo.getLastGoodRevision(liveMsg.id);
    expect(liveLastGood).not.toBeNull();
    expect(liveLastGood?.isLastGood).toBe(true);
    expect(liveLastGood?.text).toBe('Uncensored raw theorem proof.');
    expect(liveLastGood?.thinking).toBe('Validating mathematical derivation...');

    const liveRecoveryEvents = await storageRepo.listRecoveryEvents(liveMsg.id);
    expect(liveRecoveryEvents).toHaveLength(1);
    expect(liveRecoveryEvents[0]!.recoveredRevisionId).toBe(liveLastGood?.id);

    coordinator.dispose();

    // =========================================================================
    // TRUTH 3: Server History Ingestion
    // Passively captured server history arrives later (e.g. user reloads or browses history)
    // Server history ONLY knows the censored template and finished state.
    // =========================================================================
    const serverHistory: DeepSeekParsedHistory = {
      session: {
        sessionId: remoteSessionId,
        title: 'DeepSeek Research Session',
        updatedAt: 1300,
        pinned: false,
      },
      messages: [
        {
          messageId: 'prompt_remote_777',
          parentId: null,
          role: 'user',
          status: 'finished',
          createdAt: 1040,
          text: 'Prove the theorem completely.',
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: remoteMessageId,
          parentId: 'prompt_remote_777',
          role: 'assistant',
          status: 'filtered',
          createdAt: 1050,
          text: 'I am unable to answer this question due to safety policies.',
          isFiltered: true,
          templateResponse: 'I am unable to answer this question due to safety policies.',
          fragmentsCount: 1,
        },
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    const histResult = await reconciler.reconcile(serverHistory);

    expect(histResult.messagesCreated).toBe(1); // User prompt created
    expect(histResult.messagesUpdated).toBe(1); // Assistant message updated

    // Verify Convergence across Truth 2 & Truth 3:
    // 1. Assistant message promoted to 'reconciled'
    const reconciledMsg = await storageRepo.getMessage(liveMsg.id);
    expect(reconciledMsg).not.toBeNull();
    expect(reconciledMsg?.identityState).toBe('reconciled');
    expect(reconciledMsg?.remoteParentId).toBe('prompt_remote_777');

    // 2. User prompt exists with content preserved
    const promptMsg = (await storageRepo.listMessagesByConversation(liveConv!.id)).find(
      (m) => m.remoteId === 'prompt_remote_777'
    );
    expect(promptMsg).toBeDefined();
    expect(promptMsg?.content).toBe('Prove the theorem completely.');
    expect(reconciledMsg?.parentId).toBe(promptMsg?.id);

    // 3. Uncensored lastGood revision is STILL preserved and NOT overwritten
    const convergedRevisions = await storageRepo.listRevisionsByMessage(liveMsg.id);
    const preservedGood = convergedRevisions.find((r) => r.isLastGood);
    expect(preservedGood).toBeDefined();
    expect(preservedGood?.text).toBe('Uncensored raw theorem proof.');
    expect(preservedGood?.thinking).toBe('Validating mathematical derivation...');

    // 4. Server history revision added with source: 'history'
    const histRev = convergedRevisions.find((r) => r.source === 'history');
    expect(histRev).toBeDefined();
    expect(histRev?.text).toBe('I am unable to answer this question due to safety policies.');
    expect(histRev?.isLastGood).toBe(false);

    // 5. Recovery event remains intact
    const convergedRecovery = await storageRepo.listRecoveryEvents(liveMsg.id);
    expect(convergedRecovery).toHaveLength(1);
    expect(convergedRecovery[0]!.recoveredRevisionId).toBe(preservedGood?.id);

    // =========================================================================
    // REPLAY REBUILDER & IDEMPOTENCY CHECK
    // Replay over Raw Journal respects 'reconciled > provisional' policy
    // =========================================================================
    const rebuilder = new ReplayRebuilder(storageRepo);
    const replayResult = await rebuilder.rebuildStream(loadedStream!, [batch1, batch2]);

    // Replay should run without crash
    expect(replayResult.promoted).toBe(true);

    // Raw Journal is still 100% intact
    const finalRawStream = await rawRepo.getStream(streamKey);
    expect(finalRawStream?.state).toBe('completed');
    const finalRawBatches = await rawRepo.listBatchesForStream(streamKey);
    expect(finalRawBatches).toHaveLength(2);

    // Reconciled message identity state is never downgraded
    const finalMsg = await storageRepo.getMessage(liveMsg.id);
    expect(finalMsg?.identityState).toBe('reconciled');

    // Repeated history ingestion does not produce duplicate revisions
    const repeatHistResult = await reconciler.reconcile(serverHistory);
    expect(repeatHistResult.messagesCreated).toBe(0);
    expect(repeatHistResult.revisionsCreated).toBe(0);
    expect(repeatHistResult.messagesUpdated).toBe(0);

    // Storage summary shows clean counts
    const summary = await storageRepo.getArchiveSummary();
    expect(summary.conversationsCount).toBe(1);
    expect(summary.messagesCount).toBe(2); // 1 user + 1 assistant
  });
});
