import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { ReplayRebuilder } from '../src/core/reconciliation/replay-rebuilder';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';
import type { RawStreamRecord, RawStreamBatch } from '../src/storage/raw-journal/types';

describe('Canonical History Reconciliation & Replay Rebuilder', () => {
  let fakeFactory: IDBFactory;
  let repository: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    repository = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
  });

  describe('HistoryReconciler', () => {
    it('resolves message threading in two passes regardless of delivery order', async () => {
      const reconciler = new HistoryReconciler(repository);

      // Child delivered BEFORE parent in array
      const parsed: DeepSeekParsedHistory = {
        session: {
          sessionId: 'sess-threading-1',
          title: 'Threading Test',
          updatedAt: 1710000000,
          pinned: false,
        },
        messages: [
          {
            messageId: 'remote-child',
            parentId: 'remote-parent',
            role: 'assistant',
            status: 'finished',
            createdAt: 1710000020,
            text: 'I am the child response',
            isFiltered: false,
            fragmentsCount: 1,
          },
          {
            messageId: 'remote-parent',
            parentId: null,
            role: 'user',
            status: 'finished',
            createdAt: 1710000010,
            text: 'I am the parent prompt',
            isFiltered: false,
            fragmentsCount: 1,
          },
        ],
      };

      const result = await reconciler.reconcile(parsed);
      expect(result.messagesCreated).toBe(2);
      expect(result.treeLinksResolved).toBe(1);

      const conv = await repository.getConversationByRemoteId('sess-threading-1');
      expect(conv).not.toBeNull();

      const messages = await repository.listMessagesByConversation(conv!.id);
      expect(messages).toHaveLength(2);

      const parentMsg = messages.find((m) => m.remoteId === 'remote-parent')!;
      const childMsg = messages.find((m) => m.remoteId === 'remote-child')!;

      expect(parentMsg.parentId).toBeUndefined();
      expect(childMsg.parentId).toBe(parentMsg.id);
      expect(childMsg.remoteParentId).toBe('remote-parent');
      expect(childMsg.identityState).toBe('reconciled');
    });

    it('preserves sibling branches sharing parentId without flattening or collapsing', async () => {
      const reconciler = new HistoryReconciler(repository);

      const parsed: DeepSeekParsedHistory = {
        session: {
          sessionId: 'sess-branches',
          title: 'Branching Session',
          updatedAt: 1710000000,
          pinned: false,
        },
        messages: [
          {
            messageId: 'prompt-1',
            parentId: null,
            role: 'user',
            status: 'finished',
            createdAt: 1000,
            text: 'Code a binary search',
            isFiltered: false,
            fragmentsCount: 1,
          },
          {
            // Branch A: original answer
            messageId: 'turn-1-v1',
            parentId: 'prompt-1',
            role: 'assistant',
            status: 'finished',
            createdAt: 1010,
            text: 'Binary search iteration version',
            isFiltered: false,
            fragmentsCount: 1,
          },
          {
            // Branch B: regenerated answer from same prompt-1
            messageId: 'turn-1-v2',
            parentId: 'prompt-1',
            role: 'assistant',
            status: 'finished',
            createdAt: 1020,
            text: 'Binary search recursive version',
            isFiltered: false,
            fragmentsCount: 1,
          },
        ],
      };

      await reconciler.reconcile(parsed);

      const conv = await repository.getConversationByRemoteId('sess-branches');
      const messages = await repository.listMessagesByConversation(conv!.id);

      expect(messages).toHaveLength(3);
      const parent = messages.find((m) => m.remoteId === 'prompt-1')!;
      const branchA = messages.find((m) => m.remoteId === 'turn-1-v1')!;
      const branchB = messages.find((m) => m.remoteId === 'turn-1-v2')!;

      expect(branchA.parentId).toBe(parent.id);
      expect(branchB.parentId).toBe(parent.id);
      expect(branchA.id).not.toBe(branchB.id);
    });

    it('preserves live uncensored lastGood revision when history returns filtered content', async () => {
      const reconciler = new HistoryReconciler(repository);

      // Pre-populate live recorded message with an uncensored last-good revision
      const liveConv = {
        id: 'c-live',
        remoteId: 'sess-live-censor',
        title: 'Live Streamed Session',
        createdAt: 1000,
        updatedAt: 1000,
      };
      await repository.saveConversation(liveConv);

      const liveMsg = {
        id: 'm-live',
        remoteId: 'msg-target-censor',
        conversationId: 'c-live',
        role: 'assistant' as const,
        status: 'filtered' as const,
        identityState: 'provisional' as const,
        createdAt: 1005,
        updatedAt: 1005,
      };
      await repository.saveMessage(liveMsg);

      const lastGoodRev = {
        id: 'rev-live-good',
        messageId: 'm-live',
        revisionIndex: 0,
        text: 'Critical uncensored mathematical proof captured live during generation.',
        thinking: 'Complex reasoning step.',
        source: 'network' as const,
        capturedAt: 1005,
        isFinal: false,
        isLastGood: true,
      };
      await repository.saveRevision(lastGoodRev);

      // Now server history arrives, where server only returns censored template
      const historyParsed: DeepSeekParsedHistory = {
        session: {
          sessionId: 'sess-live-censor',
          title: 'Live Streamed Session',
          updatedAt: 1010,
          pinned: false,
        },
        messages: [
          {
            messageId: 'msg-target-censor',
            parentId: null,
            role: 'assistant',
            status: 'filtered',
            createdAt: 1005,
            text: 'I cannot answer this request.',
            isFiltered: true,
            templateResponse: 'I cannot answer this request.',
            fragmentsCount: 1,
          },
        ],
      };

      const result = await reconciler.reconcile(historyParsed);
      expect(result.messagesUpdated).toBe(1);

      // Verify that the uncensored lastGood revision remains intact and isLastGood remains true
      const revisions = await repository.listRevisionsByMessage('m-live');
      expect(revisions).toHaveLength(2);

      const preservedGood = revisions.find((r) => r.isLastGood)!;
      expect(preservedGood.text).toBe('Critical uncensored mathematical proof captured live during generation.');
      expect(preservedGood.isLastGood).toBe(true);

      const historyRev = revisions.find((r) => r.source === 'history')!;
      expect(historyRev.text).toBe('I cannot answer this request.');
      expect(historyRev.isLastGood).toBe(false);
    });

    it('is strictly idempotent on repeated ingestion', async () => {
      const reconciler = new HistoryReconciler(repository);

      const parsed: DeepSeekParsedHistory = {
        session: {
          sessionId: 'sess-idempotent',
          title: 'Idempotency Check',
          updatedAt: 1000,
          pinned: false,
        },
        messages: [
          {
            messageId: 'msg-idem-1',
            parentId: null,
            role: 'user',
            status: 'finished',
            createdAt: 1000,
            text: 'First prompt',
            isFiltered: false,
            fragmentsCount: 1,
          },
          {
            messageId: 'msg-idem-2',
            parentId: 'msg-idem-1',
            role: 'assistant',
            status: 'finished',
            createdAt: 1005,
            text: 'First response',
            isFiltered: false,
            fragmentsCount: 1,
          },
        ],
      };

      const firstPass = await reconciler.reconcile(parsed);
      expect(firstPass.messagesCreated).toBe(2);
      expect(firstPass.revisionsCreated).toBe(2);

      const secondPass = await reconciler.reconcile(parsed);
      expect(secondPass.messagesCreated).toBe(0);
      expect(secondPass.revisionsCreated).toBe(0);

      const summary = await repository.getArchiveSummary();
      expect(summary.conversationsCount).toBe(1);
      expect(summary.messagesCount).toBe(2);
      expect(summary.revisionsCount).toBe(2);
    });
  });

  describe('ReplayRebuilder', () => {
    it('promotes intact raw journal stream into canonical conversation, message, and revision', async () => {
      const rebuilder = new ReplayRebuilder(repository);

      const rawStream: RawStreamRecord = {
        id: 'prod_test:stream_replay_1',
        producerSessionId: 'prod_test',
        streamId: 'stream_replay_1',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        method: 'POST',
        state: 'completed',
        integrity: 'intact',
        durabilityGap: false,
        droppedChars: 0,
        openedAt: 1000,
        lastPersistedAt: 1010,
        finalizedAt: 1010,
        totalBatches: 2,
        totalChars: 120,
        totalChunks: 2,
        updatedAt: 1010,
        provisionalSessionId: 'sess-replay-promoted',
      };

      const rawBatches: RawStreamBatch[] = [
        {
          id: `${rawStream.id}:1`,
          streamKey: rawStream.id,
          batchSeq: 1,
          charCount: 75,
          createdAt: 1001,
          chunks: [
            {
              streamSequence: 1,
              chunkText: 'event: ready\ndata: {"request_message_id":"req-1","response_message_id":"resp-1"}\n\n',
              timestamp: 1001,
            },
          ],
        },
        {
          id: `${rawStream.id}:2`,
          streamKey: rawStream.id,
          batchSeq: 2,
          charCount: 150,
          createdAt: 1005,
          chunks: [
            {
              streamSequence: 2,
              chunkText:
                'data: {"p":"response/message_id","o":"SET","v":"resp-1"}\n\n' +
                'data: {"p":"response/fragments/0","o":"SET","v":{"type":"RESPONSE","content":"Promoted answer from raw journal"}}\n\n' +
                'data: {"p":"response/status","o":"SET","v":"FINISHED"}\n\n',
              timestamp: 1005,
            },
          ],
        },
      ];

      const result = await rebuilder.rebuildStream(rawStream, rawBatches);
      expect(result.promoted).toBe(true);
      expect(result.revisionsCount).toBe(1);

      const conv = await repository.getConversationByRemoteId('sess-replay-promoted');
      expect(conv).not.toBeNull();

      const msg = await repository.getMessageByRemoteId(conv!.id, 'resp-1');
      expect(msg).not.toBeNull();
      expect(msg!.sourceRawStreamKey).toBe(rawStream.id);
      expect(msg!.status).toBe('finished');

      const revs = await repository.listRevisionsByMessage(msg!.id);
      expect(revs).toHaveLength(1);
      expect(revs[0]!.source).toBe('replay');
      expect(revs[0]!.text).toBe('Promoted answer from raw journal');
    });

    it('rejects promotion if stream has durabilityGap and was corrupted', async () => {
      const rebuilder = new ReplayRebuilder(repository);

      const corruptedStream: RawStreamRecord = {
        id: 'prod_test:stream_corrupted',
        producerSessionId: 'prod_test',
        streamId: 'stream_corrupted',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        method: 'POST',
        state: 'error',
        integrity: 'gap_detected',
        durabilityGap: true,
        droppedChars: 500,
        openedAt: 1000,
        lastPersistedAt: 1010,
        totalBatches: 0,
        totalChars: 0,
        totalChunks: 0,
        updatedAt: 1010,
      };

      const result = await rebuilder.rebuildStream(corruptedStream, []);
      expect(result.promoted).toBe(false);
      expect(result.reason).toContain('Promotion rejected by gate');
    });
  });
});
