// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import {
  streamBackupToWritable,
  createUncompressedBackupReadableStream,
} from '../src/backup/streaming-backup';
import {
  getStorageMutationEpoch,
  recordStorageMutation,
  resetStorageMutationEpoch,
} from '../src/storage/mutation-tracker';
import { validateAndPreflightRestore, executeRestore } from '../src/restore/restore-service';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';

describe('Backup Consistency, Mutation Epoch Tracking & Edge Cases', () => {
  let fakeFactory: IDBFactory;
  let db: IDBDatabase;
  let repo: IndexedDbStorageRepository;

  beforeEach(async () => {
    fakeFactory = new IDBFactory();
    (globalThis as any).IDBKeyRange = IDBKeyRange;
    resetStorageMutationEpoch(1);
    db = await openExtensionDatabase(fakeFactory);
    repo = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase();
  });

  it('detects concurrent write transaction during streaming backup and aborts safely', async () => {
    // 1. Seed initial data
    const conv: Conversation = {
      id: 'conv-mut-1',
      title: 'Mutation Test Conversation',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await repo.saveConversation(conv);

    for (let i = 0; i < 50; i++) {
      await repo.saveMessage({
        id: `msg-mut-${i}`,
        conversationId: conv.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
        content: `Message content ${i}`,
        createdAt: 1000 + i,
        updatedAt: 1000 + i,
      });
    }

    let abortCalled = false;
    let abortReason: unknown = null;
    let writeCount = 0;

    const sink = {
      write: async (_chunk: Uint8Array) => {
        writeCount++;
        // Trigger concurrent mutation during the second batch write
        if (writeCount === 1) {
          // Concurrent write to database simulates DeepSeek live message arrival during backup
          await repo.saveMessage({
            id: 'msg-concurrent-arrival',
            conversationId: conv.id,
            role: 'assistant',
            status: 'finished',
            identityState: 'reconciled',
            projectionState: 'logical',
            content: 'Concurrent live stream text arriving while backup is streaming to disk',
            createdAt: 9999,
            updatedAt: 9999,
          });
        }
      },
      close: async () => {},
      abort: async (reason?: unknown) => {
        abortCalled = true;
        abortReason = reason;
      },
    };

    // Expect backup to detect mutation and abort
    await expect(
      streamBackupToWritable(db, sink, {
        batchSize: 10,
        getMutationEpoch: () => repo.getMutationEpoch(),
      })
    ).rejects.toThrow('Backup aborted: database was modified during backup creation. Please retry when DeepSeek is idle.');

    expect(abortCalled).toBe(true);
    expect((abortReason as Error).message).toContain('database was modified during backup creation');
  });

  it('detects history reconciliation plan applied during streaming backup and aborts safely', async () => {
    const conv: Conversation = {
      id: 'conv-recon-1',
      title: 'Reconciliation Test Conversation',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await repo.saveConversation(conv);

    for (let i = 0; i < 20; i++) {
      await repo.saveMessage({
        id: `msg-recon-${i}`,
        conversationId: conv.id,
        role: 'user',
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
        content: `Prompt ${i}`,
        createdAt: 1000 + i,
        updatedAt: 1000 + i,
      });
    }

    let abortCalled = false;
    let writeCount = 0;

    const sink = {
      write: async (_chunk: Uint8Array) => {
        writeCount++;
        if (writeCount === 1) {
          // History reconciler commits a plan midway through backup
          await repo.applyHistoryReconciliationPlan({
            conversation: { ...conv, title: 'Updated Title by History Sync' },
            messagesToPut: [
              {
                id: 'msg-recon-history-1',
                conversationId: conv.id,
                role: 'assistant',
                status: 'finished',
                identityState: 'reconciled',
                projectionState: 'logical',
                content: 'Reconciled response',
                createdAt: 2000,
                updatedAt: 2000,
              },
            ],
            revisionsToPut: [],
            treeLinksResolved: 1,
          });
        }
      },
      close: async () => {},
      abort: async () => {
        abortCalled = true;
      },
    };

    await expect(
      streamBackupToWritable(db, sink, {
        batchSize: 5,
        getMutationEpoch: () => repo.getMutationEpoch(),
      })
    ).rejects.toThrow('Backup aborted: database was modified during backup creation. Please retry when DeepSeek is idle.');

    expect(abortCalled).toBe(true);
  });

  it('selects earlier non-empty revision in getConversationExportModel when highest revisionIndex is empty (0 chars)', async () => {
    const conv: Conversation = {
      id: 'conv-export-test',
      title: 'Export Revision Selection Invariant',
      createdAt: 1000,
      updatedAt: 2000,
    };
    await repo.saveConversation(conv);

    const userMsg: Message = {
      id: 'msg-user-1',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Explain quantum entanglement',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await repo.saveMessage(userMsg);

    // Assistant message with 3 streaming revisions:
    // Rev 0: Partial text (50 chars)
    // Rev 1: Full complete text (150 chars)
    // Rev 2: Aborted/empty chunk (0 chars) at highest revisionIndex
    const asstMsg: Message = {
      id: 'msg-asst-1',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1100,
      updatedAt: 1200,
    };
    await repo.saveMessage(asstMsg);

    await repo.saveRevision({
      id: 'rev-0-partial',
      messageId: asstMsg.id,
      revisionIndex: 0,
      text: 'Quantum entanglement is a phenomenon in quantum mechanics...',
      source: 'network',
      capturedAt: 1110,
      isFinal: false,
      isLastGood: false,
    });

    await repo.saveRevision({
      id: 'rev-1-complete',
      messageId: asstMsg.id,
      revisionIndex: 1,
      text: 'Quantum entanglement is a phenomenon in quantum mechanics where states of particles are correlated.',
      thinking: 'Deep reasoning on quantum physics.',
      source: 'network',
      capturedAt: 1150,
      isFinal: true,
      isLastGood: false,
    });

    await repo.saveRevision({
      id: 'rev-2-empty-aborted',
      messageId: asstMsg.id,
      revisionIndex: 2,
      text: '', // 0 chars empty chunk
      source: 'network',
      capturedAt: 1200,
      isFinal: false,
      isLastGood: false,
    });

    // Query export model with includeRevisions: false (the optimized cursor path)
    const exportModel = await repo.getConversationExportModel(conv.id, { includeRevisions: false });
    expect(exportModel).not.toBeNull();
    expect(exportModel?.messages).toHaveLength(2);

    const exportedAsst = exportModel?.messages.find((m) => m.message.id === asstMsg.id);
    expect(exportedAsst).toBeDefined();

    // Invariant: Must select rev-1-complete with 99 chars, NEVER rev-2-empty-aborted with 0 chars!
    const preferred = exportedAsst?.revisions[0];
    expect(preferred?.id).toBe('rev-1-complete');
    expect(preferred?.text).toBe(
      'Quantum entanglement is a phenomenon in quantum mechanics where states of particles are correlated.'
    );
  });

  it('selects uncensored isLastGood revision in getConversationExportModel for filtered assistant turn', async () => {
    const conv: Conversation = {
      id: 'conv-filter-export',
      title: 'Filtered Export Test',
      createdAt: 1000,
      updatedAt: 2000,
    };
    await repo.saveConversation(conv);

    const asstFiltered: Message = {
      id: 'msg-asst-filtered',
      conversationId: conv.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1100,
      updatedAt: 1200,
    };
    await repo.saveMessage(asstFiltered);

    // Rev 1: Uncensored response before filter
    await repo.saveRevision({
      id: 'rev-filtered-lastgood',
      messageId: asstFiltered.id,
      revisionIndex: 1,
      text: 'Sensitive philosophical reasoning before content filter intervened.',
      thinking: 'Original pre-filter thoughts.',
      source: 'network',
      capturedAt: 1150,
      isFinal: false,
      isLastGood: true,
    });

    // Rev 2: Overwritten server content filter template
    await repo.saveRevision({
      id: 'rev-filtered-censored-template',
      messageId: asstFiltered.id,
      revisionIndex: 2,
      text: "I'm sorry, but I cannot assist with this request.",
      source: 'network',
      capturedAt: 1200,
      isFinal: true,
      isLastGood: false,
    });

    await repo.saveRecoveryEvent({
      id: 'rec-export-1',
      messageId: asstFiltered.id,
      kind: 'content_filter',
      detectedAt: 1200,
      recoveredRevisionId: 'rev-filtered-lastgood',
      reason: 'CONTENT_FILTER',
    });

    const exportModel = await repo.getConversationExportModel(conv.id, { includeRevisions: false });
    const exportedAsst = exportModel?.messages.find((m) => m.message.id === asstFiltered.id);
    expect(exportedAsst).toBeDefined();

    // Domain invariant: Must prioritize uncensored lastGood revision over censored template!
    const preferred = exportedAsst?.revisions.find((r) => r.isLastGood);
    expect(preferred).toBeDefined();
    expect(preferred?.id).toBe('rev-filtered-lastgood');
    expect(preferred?.text).toBe('Sensitive philosophical reasoning before content filter intervened.');
  });

  it('rejects truncated or corrupted archive safely during validateAndPreflightRestore', async () => {
    // Random invalid bytes
    const corruptBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x99, 0x88, 0x77, 0x66]);

    const { preflight } = await validateAndPreflightRestore(db, corruptBytes, 0, 'replace');
    expect(preflight.canRestore).toBe(false);
    expect(preflight.validationErrors.length).toBeGreaterThan(0);
  });
});
