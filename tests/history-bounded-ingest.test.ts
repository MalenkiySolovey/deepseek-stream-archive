import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { installFetchCapture, type HistoryStreamCaptureEvent } from '../src/transport/fetch/capture';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { closeExtensionDatabase } from '../src/storage/db';
import { STORE_HISTORY_STAGING } from '../src/storage/schema';
import type { NormalizedHistorySession, NormalizedHistoryMessage } from '../src/adapters/deepseek/history/types';
import type { HistoryReconciliationPlan } from '../src/core/contracts';

describe('History Bounded Streaming & Staging Store Lifecycle', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
  });

  describe('FetchCapture: Incremental History Streaming', () => {
    it('streams history chunks incrementally via onHistoryStreamEvent without buffering full body in MAIN world', async () => {
      const streamEvents: HistoryStreamCaptureEvent[] = [];

      // Create a mock stream with 3 distinct chunks
      const encoder = new TextEncoder();
      const chunks = ['{"code":0,"data":{"chat_session":{"id":"sess-1",', '"title":"Test Chat"},"chat_messages":[', '{"message_id":"m1","role":"user","content":"Hi"}]}}'];
      let chunkIdx = 0;

      const mockStream = new ReadableStream({
        pull(controller) {
          if (chunkIdx < chunks.length) {
            controller.enqueue(encoder.encode(chunks[chunkIdx++]));
          } else {
            controller.close();
          }
        },
      });

      const mockResponse = new Response(mockStream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => mockResponse;

      const uninstall = installFetchCapture({
        producerSessionId: 'prod-hist-test',
        nextSequence: () => 1,
        onEvent: () => {},
        isHistoryCandidate: (url) => url.includes('/chat/history_messages'),
        onHistoryStreamEvent: (ev) => {
          streamEvents.push(ev);
        },
      });

      const response = await fetch('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=sess-1');
      expect(response).toBeDefined();

      // Allow microtasks for stream reading
      await new Promise((r) => setTimeout(r, 50));

      uninstall();
      globalThis.fetch = originalFetch;

      expect(streamEvents.length).toBeGreaterThanOrEqual(4); // 1 open + 3 chunks + 1 complete
      expect(streamEvents[0]!.type).toBe('open');
      if (streamEvents[0]!.type === 'open') {
        expect(streamEvents[0]!.url).toContain('chat_session_id=sess-1');
      }

      const chunkEvents = streamEvents.filter((e) => e.type === 'chunk');
      expect(chunkEvents.length).toBe(3);

      const completeEvent = streamEvents.find((e) => e.type === 'complete');
      expect(completeEvent).toBeDefined();
      if (completeEvent && completeEvent.type === 'complete') {
        const totalChars = chunks.reduce((acc, c) => acc + c.length, 0);
        expect(completeEvent.totalChars).toBe(totalChars);
      }
    });
  });

  describe('StorageRepository: Staging Store & Atomic Commit', () => {
    it('persists multi-batch history chunks and commits plan atomically while clearing staging store', async () => {
      const stagingId = 'stage-unit-test-1';

      const session: NormalizedHistorySession = {
        sessionId: 'sess-staged-1',
        title: 'Staged Session Title',
        updatedAt: 1000,
        pinned: false,
      };

      const msg1: NormalizedHistoryMessage = {
        messageId: 'hm-1',
        role: 'user',
        status: 'finished',
        createdAt: 1000,
        text: 'User prompt',
        isFiltered: false,
        fragmentsCount: 1,
      };

      const msg2: NormalizedHistoryMessage = {
        messageId: 'hm-2',
        parentId: 'hm-1',
        role: 'assistant',
        status: 'finished',
        createdAt: 1050,
        text: 'Assistant response',
        thinking: 'Assistant reasoning',
        isFiltered: false,
        fragmentsCount: 2,
      };

      // 0. Save Staging Manifest
      await storageRepo.saveHistoryStagingManifest({
        stagingId,
        sessionId: session.sessionId,
        expectedBatchCount: 2,
        expectedMessageCount: 2,
        receivedBatchCount: 0,
        state: 'open',
        createdAt: 1000,
        updatedAt: 1000,
      });

      // 1. Save Batch 0
      await storageRepo.saveHistoryStagingBatch({
        id: `${stagingId}:0`,
        stagingId,
        batchIndex: 0,
        session,
        messages: [msg1],
        createdAt: 1000,
      });

      // 2. Save Batch 1
      await storageRepo.saveHistoryStagingBatch({
        id: `${stagingId}:1`,
        stagingId,
        batchIndex: 1,
        messages: [msg2],
        createdAt: 1010,
      });

      // 3. List staging batches - must be ordered by batchIndex
      const batches = await storageRepo.listHistoryStagingBatches(stagingId);
      expect(batches).toHaveLength(2);
      expect(batches[0]!.batchIndex).toBe(0);
      expect(batches[0]!.session?.title).toBe('Staged Session Title');
      expect(batches[1]!.batchIndex).toBe(1);
      expect(batches[1]!.messages[0]!.text).toBe('Assistant response');

      // 4. Commit Plan atomically
      const plan: HistoryReconciliationPlan = {
        conversation: {
          id: 'conv-from-stage',
          remoteId: session.sessionId,
          title: session.title,
          createdAt: 1000,
          updatedAt: 1050,
        },
        messagesToPut: [
          {
            id: 'm-stage-1',
            conversationId: 'conv-from-stage',
            remoteId: 'hm-1',
            role: 'user',
            status: 'finished',
            content: 'User prompt',
            identityState: 'reconciled',
            createdAt: 1000,
            updatedAt: 1000,
          },
          {
            id: 'm-stage-2',
            conversationId: 'conv-from-stage',
            remoteId: 'hm-2',
            parentId: 'm-stage-1',
            remoteParentId: 'hm-1',
            role: 'assistant',
            status: 'finished',
            identityState: 'reconciled',
            createdAt: 1050,
            updatedAt: 1050,
          },
        ],
        revisionsToPut: [
          {
            id: 'rev-stage-2',
            messageId: 'm-stage-2',
            revisionIndex: 0,
            text: 'Assistant response',
            thinking: 'Assistant reasoning',
            source: 'history',
            capturedAt: 1050,
            isFinal: true,
            isLastGood: false,
          },
        ],
        treeLinksResolved: 1,
      };

      await storageRepo.commitHistoryStagingPlan(stagingId, plan);

      // Verify conversation, messages, and revisions were committed
      const conv = await storageRepo.getConversation('conv-from-stage');
      expect(conv).toBeDefined();
      expect(conv?.title).toBe('Staged Session Title');

      const msgs = await storageRepo.listMessagesByConversation('conv-from-stage');
      expect(msgs).toHaveLength(2);

      const revs = await storageRepo.listRevisionsByMessage('m-stage-2');
      expect(revs).toHaveLength(1);
      expect(revs[0]!.text).toBe('Assistant response');

      // Verify staging store was completely cleared for this stagingId
      const remainingStaging = await storageRepo.listHistoryStagingBatches(stagingId);
      expect(remainingStaging).toHaveLength(0);
    });

    it('clears staging store when staging is aborted', async () => {
      const stagingId = 'stage-abort-test';

      await storageRepo.saveHistoryStagingManifest({
        stagingId,
        sessionId: 'sess-abort',
        expectedBatchCount: 1,
        expectedMessageCount: 0,
        receivedBatchCount: 0,
        state: 'open',
        createdAt: 1000,
        updatedAt: 1000,
      });

      await storageRepo.saveHistoryStagingBatch({
        id: `${stagingId}:0`,
        stagingId,
        batchIndex: 0,
        messages: [],
        createdAt: 1000,
      });

      let batches = await storageRepo.listHistoryStagingBatches(stagingId);
      expect(batches).toHaveLength(1);

      await storageRepo.clearHistoryStaging(stagingId);

      batches = await storageRepo.listHistoryStagingBatches(stagingId);
      expect(batches).toHaveLength(0);

      const manifest = await storageRepo.getHistoryStagingManifest(stagingId);
      expect(manifest).toBeNull();
    });

    it('handles idempotent manifest save and rejects manifest conflict with history_staging_conflict', async () => {
      const stagingId = 'stage-conflict-test';

      await storageRepo.saveHistoryStagingManifest({
        stagingId,
        sessionId: 'sess-conf',
        expectedBatchCount: 2,
        expectedMessageCount: 5,
        receivedBatchCount: 0,
        state: 'open',
        createdAt: 1000,
        updatedAt: 1000,
      });

      // Idempotent re-save of exact same manifest succeeds
      await expect(
        storageRepo.saveHistoryStagingManifest({
          stagingId,
          sessionId: 'sess-conf',
          expectedBatchCount: 2,
          expectedMessageCount: 5,
          receivedBatchCount: 0,
          state: 'open',
          createdAt: 1000,
          updatedAt: 1000,
        })
      ).resolves.toBeUndefined();

      // Conflicting manifest with different expectedBatchCount rejects
      await expect(
        storageRepo.saveHistoryStagingManifest({
          stagingId,
          sessionId: 'sess-conf',
          expectedBatchCount: 3, // Conflict!
          expectedMessageCount: 5,
          receivedBatchCount: 0,
          state: 'open',
          createdAt: 1000,
          updatedAt: 1000,
        })
      ).rejects.toThrow('history_staging_conflict');
    });

    it('completeness barrier: rejects commit when received batches are incomplete', async () => {
      const stagingId = 'stage-incomplete-test';

      await storageRepo.saveHistoryStagingManifest({
        stagingId,
        sessionId: 'sess-incomp',
        expectedBatchCount: 2,
        expectedMessageCount: 2,
        receivedBatchCount: 0,
        state: 'open',
        createdAt: 1000,
        updatedAt: 1000,
      });

      // Save only 1 of 2 expected batches
      await storageRepo.saveHistoryStagingBatch({
        id: `${stagingId}:0`,
        stagingId,
        batchIndex: 0,
        messages: [],
        createdAt: 1000,
      });

      const plan: HistoryReconciliationPlan = {
        conversation: {
          id: 'conv-incomp',
          remoteId: 'sess-incomp',
          title: 'Incomplete Test',
          createdAt: 1000,
          updatedAt: 1000,
        },
        messagesToPut: [],
        revisionsToPut: [],
        treeLinksResolved: 0,
      };

      await expect(
        storageRepo.commitHistoryStagingPlan(stagingId, plan)
      ).rejects.toThrow('history_staging_incomplete: received 1 of 2 batches');
    });

    it('cleans up stale open staging sessions older than ttl', async () => {
      const staleStagingId = 'stage-stale-cleanup';
      const tenMinutesAgo = Date.now() - 600000;

      await storageRepo.saveHistoryStagingManifest({
        stagingId: staleStagingId,
        sessionId: 'sess-stale',
        expectedBatchCount: 1,
        expectedMessageCount: 1,
        receivedBatchCount: 0,
        state: 'open',
        createdAt: tenMinutesAgo,
        updatedAt: tenMinutesAgo,
      });

      await storageRepo.saveHistoryStagingBatch({
        id: `${staleStagingId}:0`,
        stagingId: staleStagingId,
        batchIndex: 0,
        messages: [],
        createdAt: tenMinutesAgo,
      });

      let batches = await storageRepo.listHistoryStagingBatches(staleStagingId);
      expect(batches).toHaveLength(1);

      // Clean up staging older than 5 minutes (300,000ms)
      const cleaned = await storageRepo.cleanupStaleHistoryStaging(300000);
      expect(cleaned).toBeGreaterThanOrEqual(1);

      batches = await storageRepo.listHistoryStagingBatches(staleStagingId);
      expect(batches).toHaveLength(0);

      const manifest = await storageRepo.getHistoryStagingManifest(staleStagingId);
      expect(manifest).toBeNull();
    });

    it('rejects duplicate batch with conflicting session metadata with history_staging_conflict', async () => {
      const stagingId = 'stage-session-conf';

      await storageRepo.saveHistoryStagingManifest({
        stagingId,
        sessionId: 'sess-match',
        expectedBatchCount: 1,
        expectedMessageCount: 1,
        receivedBatchCount: 0,
        state: 'open',
        createdAt: 1000,
        updatedAt: 1000,
      });

      // Batch 0 with session title A
      await storageRepo.saveHistoryStagingBatch({
        id: `${stagingId}:0`,
        stagingId,
        batchIndex: 0,
        session: {
          sessionId: 'sess-match',
          title: 'Initial Title',
          updatedAt: 1000,
          pinned: false,
        },
        messages: [],
        createdAt: 1000,
      });

      // Idempotent save with exact same session metadata succeeds
      await expect(
        storageRepo.saveHistoryStagingBatch({
          id: `${stagingId}:0`,
          stagingId,
          batchIndex: 0,
          session: {
            sessionId: 'sess-match',
            title: 'Initial Title',
            updatedAt: 1000,
            pinned: false,
          },
          messages: [],
          createdAt: 1000,
        })
      ).resolves.toBeUndefined();

      // Conflicting save with different session metadata rejects
      await expect(
        storageRepo.saveHistoryStagingBatch({
          id: `${stagingId}:0`,
          stagingId,
          batchIndex: 0,
          session: {
            sessionId: 'sess-match',
            title: 'DIFFERENT CONFLICTING TITLE',
            updatedAt: 2000,
            pinned: false,
          },
          messages: [],
          createdAt: 1000,
        })
      ).rejects.toThrow('history_batch_conflict');
    });

    it('rejects plan when conversation remoteId does not match manifest sessionId (history_plan_session_mismatch)', async () => {
      const stagingId = 'stage-mismatch-test';

      await storageRepo.saveHistoryStagingManifest({
        stagingId,
        sessionId: 'sess-expected-authority',
        expectedBatchCount: 1,
        expectedMessageCount: 0,
        receivedBatchCount: 0,
        state: 'open',
        createdAt: 1000,
        updatedAt: 1000,
      });

      await storageRepo.saveHistoryStagingBatch({
        id: `${stagingId}:0`,
        stagingId,
        batchIndex: 0,
        messages: [],
        createdAt: 1000,
      });

      // Plan has conflicting remoteId 'sess-unauthorized-wrong'
      const plan: HistoryReconciliationPlan = {
        conversation: {
          id: 'conv-mismatch',
          remoteId: 'sess-unauthorized-wrong',
          title: 'Mismatched Remote ID',
          createdAt: 1000,
          updatedAt: 1000,
        },
        messagesToPut: [
          {
            id: 'msg-mismatch-1',
            conversationId: 'conv-mismatch',
            identityState: 'reconciled',
            role: 'assistant',
            status: 'finished',
            createdAt: 1000,
            updatedAt: 1000,
          },
        ],
        revisionsToPut: [],
        treeLinksResolved: 0,
      };

      await expect(
        storageRepo.commitHistoryStagingPlan(stagingId, plan)
      ).rejects.toThrow('history_plan_session_mismatch');

      // Verify ZERO canonical mutations occurred in storage
      const conv = await storageRepo.getConversation('conv-mismatch');
      expect(conv).toBeNull();
      const msgs = await storageRepo.listMessagesByConversation('conv-mismatch');
      expect(msgs).toHaveLength(0);
    });
  });
});
