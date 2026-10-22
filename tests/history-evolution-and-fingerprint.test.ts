import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { closeExtensionDatabase } from '../src/storage/db';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { DeepSeekHistoryParser } from '../src/adapters/deepseek/history/parser';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';

describe('History Evolution, Fingerprinting & Identity Normalization', () => {
  let fakeFactory: IDBFactory;
  let repository: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    repository = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
  });

  it('generates stable content fingerprints and only adds revisions on genuine evolution', async () => {
    const reconciler = new HistoryReconciler(repository);

    // Initial server history snapshot
    const parsedV1: DeepSeekParsedHistory = {
      session: {
        sessionId: 'sess_evo_1',
        title: 'Quantum Field Theory',
        updatedAt: 1000,
        pinned: false,
      },
      messages: [
        {
          messageId: 'prompt_101',
          parentId: null,
          role: 'user',
          status: 'finished',
          createdAt: 1000,
          text: 'Explain renormalization in QFT.',
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: 'resp_102',
          parentId: 'prompt_101',
          role: 'assistant',
          status: 'finished',
          createdAt: 1005,
          text: 'Renormalization is a collection of techniques used to treat infinities.',
          thinking: 'Need to explain cutoff and running coupling.',
          isFiltered: false,
          fragmentsCount: 2,
        },
      ],
    };

    // First ingestion
    const pass1 = await reconciler.reconcile(parsedV1);
    expect(pass1.messagesCreated).toBe(2);
    expect(pass1.revisionsCreated).toBe(2);

    const conv = await repository.getConversationByRemoteId('sess_evo_1');
    expect(conv).not.toBeNull();
    const assistantMsg = (await repository.listMessagesByConversation(conv!.id)).find(
      (m) => m.remoteId === 'resp_102'
    )!;
    expect(assistantMsg).toBeDefined();

    const revisionsV1 = await repository.listRevisionsByMessage(assistantMsg.id);
    expect(revisionsV1).toHaveLength(1);
    expect(revisionsV1[0]!.contentFingerprint).toBeDefined();
    const fp1 = revisionsV1[0]!.contentFingerprint;

    // Second ingestion: exact duplicate
    const pass2 = await reconciler.reconcile(parsedV1);
    expect(pass2.messagesCreated).toBe(0);
    expect(pass2.revisionsCreated).toBe(0);
    expect(pass2.messagesUpdated).toBe(0);

    const revisionsV2 = await repository.listRevisionsByMessage(assistantMsg.id);
    expect(revisionsV2).toHaveLength(1);
    expect(revisionsV2[0]!.contentFingerprint).toBe(fp1);

    // Third ingestion: server history evolves with expanded explanation
    const parsedV3: DeepSeekParsedHistory = {
      session: {
        sessionId: 'sess_evo_1',
        title: 'Quantum Field Theory',
        updatedAt: 1020,
        pinned: false,
      },
      messages: [
        {
          messageId: 'prompt_101',
          parentId: null,
          role: 'user',
          status: 'finished',
          createdAt: 1000,
          text: 'Explain renormalization in QFT.',
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: 'resp_102',
          parentId: 'prompt_101',
          role: 'assistant',
          status: 'finished',
          createdAt: 1005,
          text: 'Renormalization is a collection of techniques used to treat infinities by absorbing them into redefined parameters like physical mass and charge.',
          thinking: 'Need to explain cutoff and running coupling.',
          isFiltered: false,
          fragmentsCount: 2,
        },
      ],
    };

    const pass3 = await reconciler.reconcile(parsedV3);
    expect(pass3.messagesCreated).toBe(0);
    expect(pass3.revisionsCreated).toBe(1); // New evolved revision added

    const revisionsV3 = await repository.listRevisionsByMessage(assistantMsg.id);
    expect(revisionsV3).toHaveLength(2);
    expect(revisionsV3[0]!.revisionIndex).toBe(0);
    expect(revisionsV3[1]!.revisionIndex).toBe(1);
    expect(revisionsV3[1]!.text).toContain('absorbing them into redefined parameters');
    expect(revisionsV3[1]!.source).toBe('history');
  });

  it('normalizes numeric and string remote IDs seamlessly between parser and reconciler', async () => {
    const rawPayloadWithNumbers = {
      data: {
        biz_data: {
          chat_session: {
            id: 889900, // numeric session ID
            title: 'Numeric IDs Session',
            updated_at: 1720000000,
          },
          chat_messages: [
            {
              message_id: 1001, // numeric message ID
              parent_id: null,
              role: 'USER',
              text: 'Hello from numeric world',
              inserted_at: 1720000001,
            },
            {
              message_id: 1002, // numeric message ID
              parent_id: 1001, // numeric parent ID
              role: 'ASSISTANT',
              text: 'Greeting acknowledged',
              inserted_at: 1720000002,
              status: 'FINISHED',
            },
          ],
        },
      },
    };

    const parsed = DeepSeekHistoryParser.parse(rawPayloadWithNumbers, {
      expectedSessionId: '889900',
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.session.sessionId).toBe('889900');
    expect(parsed?.messages[0]?.messageId).toBe('1001');
    expect(parsed?.messages[1]?.messageId).toBe('1002');
    expect(parsed?.messages[1]?.parentId).toBe('1001');

    const reconciler = new HistoryReconciler(repository);
    const result = await reconciler.reconcile(parsed!);

    expect(result.messagesCreated).toBe(2);
    const conv = await repository.getConversationByRemoteId('889900');
    expect(conv).not.toBeNull();

    const messages = await repository.listMessagesByConversation(conv!.id);
    const parentMsg = messages.find((m) => m.remoteId === '1001')!;
    const childMsg = messages.find((m) => m.remoteId === '1002')!;

    expect(childMsg.parentId).toBe(parentMsg.id);
    expect(childMsg.remoteParentId).toBe('1001');
  });

  it('safely handles cycle references in server history without infinite recursion', async () => {
    const reconciler = new HistoryReconciler(repository);

    // Malformed cycle: nodeA -> nodeB -> nodeA
    const parsedWithCycle: DeepSeekParsedHistory = {
      session: {
        sessionId: 'sess_cycle',
        title: 'Cyclic Graph',
        updatedAt: 1000,
        pinned: false,
      },
      messages: [
        {
          messageId: 'nodeA',
          parentId: 'nodeB', // A points to B
          role: 'user',
          status: 'finished',
          createdAt: 1000,
          text: 'Cyclic node A',
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: 'nodeB',
          parentId: 'nodeA', // B points to A
          role: 'assistant',
          status: 'finished',
          createdAt: 1010,
          text: 'Cyclic node B',
          isFiltered: false,
          fragmentsCount: 1,
        },
      ],
    };

    const result = await reconciler.reconcile(parsedWithCycle);
    expect(result.messagesCreated).toBe(2);

    const conv = await repository.getConversationByRemoteId('sess_cycle');
    const messages = await repository.listMessagesByConversation(conv!.id);
    const msgA = messages.find((m) => m.remoteId === 'nodeA')!;
    const msgB = messages.find((m) => m.remoteId === 'nodeB')!;

    // One connection must be broken to avoid DB tree cycle
    const cycleExists = msgA.parentId === msgB.id && msgB.parentId === msgA.id;
    expect(cycleExists).toBe(false);
  });
});
