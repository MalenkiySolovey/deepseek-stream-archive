import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { closeExtensionDatabase } from '../src/storage/db';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';

describe('Archive Browser Read-Only Queries', () => {
  let fakeFactory: IDBFactory;
  let repository: IndexedDbStorageRepository;

  beforeEach(() => {
    (globalThis as any).IDBKeyRange = IDBKeyRange;
    fakeFactory = new IDBFactory();
    repository = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase();
  });

  it('lists archive conversations with metadata-first pagination and sorting by updatedAt desc', async () => {
    // Populate 3 conversations with varying timestamps
    const conv1: Conversation = {
      id: 'conv-1',
      title: 'First Chat',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const conv2: Conversation = {
      id: 'conv-2',
      title: 'Second Chat (Recent)',
      createdAt: 2000,
      updatedAt: 3000,
    };
    const conv3: Conversation = {
      id: 'conv-3',
      title: 'Third Chat (Most Recent)',
      createdAt: 2500,
      updatedAt: 5000,
    };

    await repository.saveConversation(conv1);
    await repository.saveConversation(conv2);
    await repository.saveConversation(conv3);

    // Messages for conv-2: 1 normal, 1 filtered
    const msg1: Message = {
      id: 'msg-1',
      conversationId: 'conv-2',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 2010,
      updatedAt: 2010,
    };
    const msg2: Message = {
      id: 'msg-2',
      conversationId: 'conv-2',
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      createdAt: 2020,
      updatedAt: 2020,
    };
    await repository.saveMessages([msg1, msg2]);

    // Query page 1 with limit 2
    const page1 = await repository.listArchiveConversations({ limit: 2 });
    expect(page1.totalCount).toBe(3);
    expect(page1.items).toHaveLength(2);

    // Order: conv-3 (updatedAt: 5000), conv-2 (updatedAt: 3000)
    expect(page1.items[0]!.id).toBe('conv-3');
    expect(page1.items[1]!.id).toBe('conv-2');
    expect(page1.items[1]!.messageCount).toBe(2);
    expect(page1.items[1]!.hasDegraded).toBe(true);
    expect(page1.items[1]!.recoveredCount).toBe(1);
    expect(page1.nextCursor).toBe('3000');

    // Query page 2 with cursor
    const page2 = await repository.listArchiveConversations({ limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]!.id).toBe('conv-1');
    expect(page2.nextCursor).toBeUndefined();
  });

  it('retrieves detailed archive conversation with messages, revisions, and recovery events', async () => {
    const conv: Conversation = {
      id: 'conv-detail-test',
      remoteId: 'remote-sess-77',
      title: 'Detailed Quantum Physics Chat',
      createdAt: 1000,
      updatedAt: 1200,
    };
    await repository.saveConversation(conv);

    const userMsg: Message = {
      id: 'msg-user-1',
      conversationId: 'conv-detail-test',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      content: 'Explain anyonic statistics.',
      createdAt: 1010,
      updatedAt: 1010,
    };

    const asstMsg: Message = {
      id: 'msg-asst-1',
      conversationId: 'conv-detail-test',
      parentId: 'msg-user-1',
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      createdAt: 1020,
      updatedAt: 1050,
    };
    await repository.saveMessages([userMsg, asstMsg]);

    const rev0: ResponseRevision = {
      id: 'rev-lastgood-1',
      messageId: 'msg-asst-1',
      revisionIndex: 0,
      text: 'Non-abelian anyons have braid statistics that form representations of the braid group.',
      thinking: 'Thinking about braided topological charge...',
      source: 'network',
      capturedAt: 1030,
      isFinal: false,
      isLastGood: true,
    };

    const rev1: ResponseRevision = {
      id: 'rev-filtered-1',
      messageId: 'msg-asst-1',
      revisionIndex: 1,
      text: 'Content filtered by safety system.',
      source: 'network',
      capturedAt: 1040,
      isFinal: true,
      isLastGood: false,
    };
    await repository.saveRevisions([rev0, rev1]);

    const recEvt: RecoveryEvent = {
      id: 'rec-event-1',
      messageId: 'msg-asst-1',
      kind: 'content_filter',
      detectedAt: 1045,
      recoveredRevisionId: 'rev-lastgood-1',
    };
    await repository.saveRecoveryEvent(recEvt);

    const detail = await repository.getArchiveConversation('conv-detail-test');
    expect(detail).not.toBeNull();
    expect(detail!.conversation.title).toBe('Detailed Quantum Physics Chat');
    expect(detail!.messages).toHaveLength(2);

    const assistantSummary = detail!.messages.find((m) => m.role === 'assistant');
    expect(assistantSummary).toBeDefined();
    expect(assistantSummary!.revisions).toHaveLength(2);
    expect(assistantSummary!.revisions[0]!.isLastGood).toBe(true);
    expect(assistantSummary!.recoveryEvents).toHaveLength(1);

    // Preferred revision: for filtered message, prefers isLastGood = true
    expect(assistantSummary!.preferredRevision).toBeDefined();
    expect(assistantSummary!.preferredRevision!.id).toBe('rev-lastgood-1');
    expect(assistantSummary!.preferredRevision!.text).toContain('Non-abelian anyons');
  });

  it('fetches specific revision content by revision ID', async () => {
    const rev: ResponseRevision = {
      id: 'rev-content-fetch',
      messageId: 'msg-x',
      revisionIndex: 0,
      text: 'Detailed revision payload text content',
      thinking: 'Detailed thinking process string',
      source: 'history',
      capturedAt: 500,
      isFinal: true,
      isLastGood: false,
    };
    await repository.saveRevision(rev);

    const content = await repository.getRevisionContent('rev-content-fetch');
    expect(content).not.toBeNull();
    expect(content!.text).toBe('Detailed revision payload text content');
    expect(content!.thinking).toBe('Detailed thinking process string');

    const notFound = await repository.getRevisionContent('non-existent-id');
    expect(notFound).toBeNull();
  });
});
