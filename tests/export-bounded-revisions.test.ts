// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { Message, Conversation, ResponseRevision, RecoveryEvent } from '../src/core/models';
import { buildConversationMarkdown } from '../src/export/markdown-exporter';
import { buildConversationJson } from '../src/export/json-exporter';
import { openExtensionDatabase } from '../src/storage/db';

describe('Defect 4 Verification: Conversation Export Bounded Revisions & Error Propagation', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    (globalThis as any).IDBKeyRange = IDBKeyRange;
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  it('bounds revision retrieval to O(1) records when includeRevisions: false, skipping hundreds of intermediate revisions', async () => {
    const conv: Conversation = {
      id: 'conv-export-opt',
      title: 'Streaming Dialogue with Many Revisions',
      createdAt: 1000,
      updatedAt: 2000,
    };
    await storageRepo.saveConversation(conv);

    const userMsg: Message = {
      id: 'msg-u-opt',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Hello, write a 1000-line script.',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(userMsg);

    const asstMsg: Message = {
      id: 'msg-a-opt',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Final completed response text after 150 streaming tokens.',
      createdAt: 1100,
      updatedAt: 1200,
    };
    await storageRepo.saveMessage(asstMsg);

    // Save 150 intermediate revisions simulating live SSE streaming chunks
    for (let i = 0; i < 150; i++) {
      await storageRepo.saveRevision({
        id: `rev-opt-${i}`,
        messageId: asstMsg.id,
        revisionIndex: i,
        text: `Intermediate stream token buffer ${i}: ` + 'X'.repeat(400),
        source: 'network',
        capturedAt: 1100 + i,
        isFinal: i === 149,
        isLastGood: false,
      });
    }

    // Test 1: With includeRevisions: false -> bounded to preferred (at most 1-2 revisions)
    const boundedExport = await storageRepo.getConversationExportModel(conv.id, {
      includeRevisions: false,
    });
    expect(boundedExport).not.toBeNull();
    const asstDetail = boundedExport!.messages.find((m) => m.message.id === asstMsg.id);
    expect(asstDetail).toBeDefined();
    // Revisions must be bounded: only 1 revision (the latest/preferred), NOT all 150!
    expect(asstDetail!.revisions.length).toBe(1);
    expect(asstDetail!.revisions[0]!.revisionIndex).toBe(149);

    // Test 2: With includeRevisions: true -> retrieves all 150 revisions
    const fullExport = await storageRepo.getConversationExportModel(conv.id, {
      includeRevisions: true,
    });
    expect(fullExport).not.toBeNull();
    const fullAsstDetail = fullExport!.messages.find((m) => m.message.id === asstMsg.id);
    expect(fullAsstDetail).toBeDefined();
    expect(fullAsstDetail!.revisions.length).toBe(150);
  });

  it('rejects export promise immediately upon any transaction or objectStore error (never silently omits messages)', async () => {
    const conv: Conversation = {
      id: 'conv-error-test',
      title: 'Error Propagation Test',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const msg: Message = {
      id: 'msg-err-1',
      conversationId: conv.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Some content',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(msg);

    // Mock db.transaction to simulate a store read error on conversations
    const db = await (storageRepo as any).getDb();
    const origTransaction = db.transaction.bind(db);
    (db as any).transaction = function (...args: any[]) {
      const tx = (origTransaction as any)(...args);
      const origStore = tx.objectStore.bind(tx);
      tx.objectStore = function (storeName: string) {
        const store = origStore(storeName);
        if (storeName === 'conversations') {
          return new Proxy(store, {
            get(target, prop, receiver) {
              if (prop === 'get') {
                return () => {
                  const req = {
                    error: new Error('Simulated disk read failure in conversations store'),
                    onsuccess: null as any,
                    onerror: null as any,
                  };
                  queueMicrotask(() => {
                    if (req.onerror) {
                      req.onerror(new Event('error') as any);
                    }
                  });
                  return req;
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        }
        return store;
      };
      return tx;
    };

    // When an error occurs, getConversationExportModel MUST reject (not silently resolve incomplete data)
    await expect(
      storageRepo.getConversationExportModel(conv.id, { includeRevisions: false })
    ).rejects.toThrow('Simulated disk read failure in conversations store');
  });

  it('exports conversation to Markdown and JSON formats preserving branch DAG and DeepThink reasoning', async () => {
    const conv: Conversation = {
      id: 'conv-export-formats',
      remoteId: 'session-formats-1',
      title: 'Branching Dialogue with DeepThink',
      createdAt: 1000,
      updatedAt: 2000,
    };
    await storageRepo.saveConversation(conv);

    const u1: Message = {
      id: 'u-fmt-1',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Explain relativity simply.',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(u1);

    const a1: Message = {
      id: 'a-fmt-1',
      conversationId: conv.id,
      parentId: u1.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Relativity means time and space are connected.',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await storageRepo.saveMessage(a1);
    await storageRepo.saveRevision({
      id: 'rev-fmt-1',
      messageId: a1.id,
      revisionIndex: 1,
      text: a1.content!,
      thinking: 'Thinking about Einstein and speed of light...',
      source: 'network',
      capturedAt: 1100,
      isFinal: true,
      isLastGood: true,
    });

    const exportModel = await storageRepo.getConversationExportModel(conv.id, {
      includeRevisions: false,
    });
    expect(exportModel).not.toBeNull();

    // 1. Markdown Export
    const md = buildConversationMarkdown(exportModel!, {
      format: 'markdown',
      branches: 'all',
      includeReasoning: true,
      includeRevisions: false,
      includeRecovery: true,
    });
    expect(md).toContain('# Branching Dialogue with DeepThink');
    expect(md).toContain('Explain relativity simply.');
    expect(md).toContain('Thinking about Einstein and speed of light...');
    expect(md).toContain('Relativity means time and space are connected.');

    // 2. JSON Export
    const jsonStr = buildConversationJson(exportModel!, {
      format: 'json',
      branches: 'all',
      includeReasoning: true,
      includeRevisions: false,
      includeRecovery: true,
    });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.format).toBe('deepseek-streamarchive-conversation');
    expect(parsed.messages.length).toBe(2);
    expect(parsed.messages[1].thinking).toContain('Thinking about Einstein');
  });
});
