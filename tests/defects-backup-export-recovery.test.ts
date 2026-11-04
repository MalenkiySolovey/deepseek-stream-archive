// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { openExtensionDatabase } from '../src/storage/db';
import type { Message, ResponseRevision, RecoveryEvent, Conversation } from '../src/core/models';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';
import { locateMessageAnchor, findInlineInsertionPoint } from '../src/adapters/deepseek/dom/message-locator';

describe('Defects Reproduction & Regression Suite: Backup, Export, and Filtered Message Recovery', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    (globalThis as any).IDBKeyRange = IDBKeyRange;
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 3 REPRODUCTION: Filtered Message Reconciliation & RemoteId Loss
  // ──────────────────────────────────────────────────────────────────────────
  it('REPRODUCTION Defect 3: Filtered message with pre-filter lastGood content fails to reconcile remoteId when server history returns template response', async () => {
    const conv: Conversation = {
      id: 'conv-filter-test',
      remoteId: 'session-remote-1',
      title: 'Censorship Test',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    // 1. User prompt
    const userMsg: Message = {
      id: 'user-msg-1',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Tell me about an uncensored topic',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(userMsg);

    // 2. Assistant generated stream that got filtered
    const preFilterText = 'Here is the detailed uncensored response generated before filter.';
    const asstMsg: Message = {
      id: 'asst-msg-1',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: preFilterText,
      createdAt: 1050,
      updatedAt: 1050,
    };
    await storageRepo.saveMessage(asstMsg);

    // 3. Pre-filter lastGood revision and recovery event
    const lastGoodRev: ResponseRevision = {
      id: 'rev-lastgood-1',
      messageId: asstMsg.id,
      revisionIndex: 1,
      text: preFilterText,
      source: 'network',
      capturedAt: 1050,
      isFinal: false,
      isLastGood: true,
    };
    await storageRepo.saveRevision(lastGoodRev);

    const recEvent: RecoveryEvent = {
      id: 'rec-event-1',
      messageId: asstMsg.id,
      kind: 'content_filter',
      detectedAt: 1050,
      recoveredRevisionId: lastGoodRev.id,
      reason: 'CONTENT_FILTER',
    };
    await storageRepo.saveRecoveryEvent(recEvent);

    // 4. Server history arrives:
    // Server replaces content with the template response!
    const serverTemplateText = "Sorry, that's beyond my current scope. Let's talk about something else.";
    const parsedHistory: DeepSeekParsedHistory = {
      session: {
        sessionId: conv.remoteId!,
        title: conv.title,
        updatedAt: 1050,
        pinned: false,
      },
      messages: [
        {
          messageId: 'server-user-1',
          parentId: null,
          role: 'user',
          status: 'finished',
          text: 'Tell me about an uncensored topic',
          createdAt: 1000,
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: 'server-asst-1',
          parentId: 'server-user-1',
          role: 'assistant',
          status: 'filtered',
          text: serverTemplateText,
          createdAt: 1050,
          isFiltered: true,
          templateResponse: serverTemplateText,
          fragmentsCount: 1,
        },
      ],
    };

    const reconciler = new HistoryReconciler(storageRepo);
    await reconciler.reconcile(parsedHistory);

    // Check what happened to asstMsg in storage:
    const updatedAsst = await storageRepo.getMessage(asstMsg.id);
    expect(updatedAsst).not.toBeNull();

    // THIS FAILS in buggy code because candText !== histText returned false!
    // Expected: asstMsg matches server-asst-1, so remoteId is 'server-asst-1'
    expect(updatedAsst?.remoteId).toBe('server-asst-1');
    expect(updatedAsst?.identityState).toBe('reconciled');

    // Also verify recovery metadata returns this message with its remoteId
    const recoveryMeta = await storageRepo.getRecoveryMetadataForConversation(conv.id);
    expect(recoveryMeta.length).toBe(1);
    expect(recoveryMeta[0]?.messageId).toBe(asstMsg.id);
    expect(recoveryMeta[0]?.remoteId).toBe('server-asst-1');

    // In DOM, the element on chat.deepseek.com has data-virtual-list-item-key="server-asst-1"
    document.body.innerHTML = `
      <div id="chat-list">
        <div data-virtual-list-item-key="server-user-1">User prompt</div>
        <div data-virtual-list-item-key="server-asst-1">
          <div class="ds-markdown">${serverTemplateText}</div>
          <div data-testid="message-actions"><button>Copy</button></div>
        </div>
      </div>
    `;

    const anchor = locateMessageAnchor(recoveryMeta[0]!.remoteId!, document);
    expect(anchor).not.toBeNull();
    expect(anchor?.element.getAttribute('data-virtual-list-item-key')).toBe('server-asst-1');

    const target = findInlineInsertionPoint(anchor!);
    expect(target).not.toBeNull();
    expect(target?.placeholderElement?.textContent).toContain("Sorry, that's beyond my current scope");
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 2 REPRODUCTION: Export Model on Long Conversation
  // ──────────────────────────────────────────────────────────────────────────
  it('REPRODUCTION Defect 2: getConversationExportModel with includeRevisions: false skips intermediate revisions', async () => {
    const conv: Conversation = {
      id: 'conv-export-test',
      title: 'Long Export Conversation',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const userMsg: Message = {
      id: 'user-msg-exp',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Write an essay',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(userMsg);

    const asstMsg: Message = {
      id: 'asst-msg-exp',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Here is the essay.',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await storageRepo.saveMessage(asstMsg);

    // Save 50 intermediate streaming revisions for this message
    for (let i = 0; i < 50; i++) {
      await storageRepo.saveRevision({
        id: `rev-${i}`,
        messageId: asstMsg.id,
        revisionIndex: i,
        text: `Intermediate chunk ${i} ` + 'A'.repeat(500),
        source: 'network',
        capturedAt: 1100 + i * 10,
        isFinal: i === 49,
        isLastGood: false,
      });
    }

    // When includeRevisions: false, it should NOT return 50 revisions in exportModel!
    const exportModel = await storageRepo.getConversationExportModel(conv.id, {
      includeRevisions: false,
    });

    expect(exportModel).not.toBeNull();
    const asstDetail = exportModel!.messages.find((m: any) => m.message.id === asstMsg.id);
    expect(asstDetail).toBeDefined();
    // With optimization, revisions should be bounded (e.g. 1 preferred revision, not all 50)
    expect(asstDetail!.revisions.length).toBeLessThanOrEqual(2);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 1 REPRODUCTION: Large Archive Backup 100 MiB Hardcoded Limit
  // ──────────────────────────────────────────────────────────────────────────
  it('REPRODUCTION Defect 1: createPortableBackupSnapshot fails on databases exceeding 100 MiB threshold', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const conv: Conversation = {
      id: 'conv-large-1',
      title: 'Large Archive',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    // Write a mock message
    const msg: Message = {
      id: 'msg-large-1',
      conversationId: conv.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Large text',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(msg);

    // If maxBytes is exceeded (e.g. threshold = 100 bytes), snapshot throws:
    const { createPortableBackupSnapshot } = await import('../src/backup/snapshot');
    await expect(
      createPortableBackupSnapshot(db, { maxBytes: 100 })
    ).rejects.toThrow('This archive is too large for the current portable backup implementation');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // STREAMING BACKUP & RESTORE VERIFICATION SUITE
  // ──────────────────────────────────────────────────────────────────────────
  it('streams backup incrementally to writable without materializing full dataset in memory', async () => {
    const db = await openExtensionDatabase(fakeFactory);

    // Seed database with conversations, messages, revisions, recovery events, raw streams, and batches
    for (let c = 0; c < 5; c++) {
      const conv: Conversation = {
        id: `conv-stream-${c}`,
        title: `Streaming Conversation ${c}`,
        createdAt: 1000 + c * 100,
        updatedAt: 2000 + c * 100,
      };
      await storageRepo.saveConversation(conv);

      for (let m = 0; m < 10; m++) {
        const msgId = `msg-${c}-${m}`;
        const isUser = m % 2 === 0;
        await storageRepo.saveMessage({
          id: msgId,
          conversationId: conv.id,
          parentId: m > 0 ? `msg-${c}-${m - 1}` : undefined,
          role: isUser ? 'user' : 'assistant',
          status: 'finished',
          identityState: 'reconciled',
          projectionState: 'logical',
          content: isUser ? `User prompt ${c}-${m}` : `Assistant response ${c}-${m}`,
          createdAt: 1000 + c * 100 + m * 10,
          updatedAt: 1000 + c * 100 + m * 10,
        });

        if (!isUser) {
          await storageRepo.saveRevision({
            id: `rev-${c}-${m}-1`,
            messageId: msgId,
            revisionIndex: 1,
            text: `Assistant response text ${c}-${m}`,
            source: 'network',
            capturedAt: 1000 + c * 100 + m * 10,
            isFinal: true,
            isLastGood: true,
          });

          if (m === 3) {
            await storageRepo.saveRecoveryEvent({
              id: `rec-${c}-${m}`,
              messageId: msgId,
              kind: 'content_filter',
              detectedAt: 1000 + c * 100 + m * 10,
              recoveredRevisionId: `rev-${c}-${m}-1`,
              reason: 'CONTENT_FILTER',
            });
          }
        }
      }
    }

    // Now stream the backup into a custom writable chunk sink
    const { streamBackupToWritable } = await import('../src/backup/streaming-backup');
    const chunks: Uint8Array[] = [];
    let isClosed = false;

    const mockWritable = {
      write: async (chunk: Uint8Array) => {
        chunks.push(new Uint8Array(chunk));
      },
      close: async () => {
        isClosed = true;
      },
      abort: async () => {},
    };

    const result = await streamBackupToWritable(db, mockWritable, { batchSize: 5 });

    expect(result.success).toBe(true);
    expect(isClosed).toBe(true);
    expect(result.counts.conversations).toBe(5);
    expect(result.counts.messages).toBe(50);
    expect(result.counts.revisions).toBe(25);
    expect(result.counts.recovery_events).toBe(5);
    expect(result.compressedBytes).toBeGreaterThan(0);

    // Concatenate chunks and read back with readPortableBackup to verify format integrity
    const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }

    const { readPortableBackup } = await import('../src/backup/reader');
    const readRes = await readPortableBackup(combined);
    expect(readRes.success).toBe(true);
    expect(readRes.backup?.manifest.format).toBe('deepseek-streamarchive-backup');
    expect(readRes.backup?.footer.counts.conversations).toBe(5);
    expect(readRes.backup?.footer.counts.messages).toBe(50);
    expect(readRes.backup?.footer.counts.revisions).toBe(25);
    expect(readRes.backup?.footer.counts.recovery_events).toBe(5);

    // Restore into a fresh, independent second test database
    const freshFactory = new IDBFactory();
    const freshDb = await openExtensionDatabase(freshFactory);
    const { executeRestore } = await import('../src/restore/restore-service');

    const restoreRes = await executeRestore(freshDb, readRes.backup!, 'replace', 0);
    expect(restoreRes.success).toBe(true);
    expect(restoreRes.insertedCounts.conversations).toBe(5);
    expect(restoreRes.insertedCounts.messages).toBe(50);
    expect(restoreRes.insertedCounts.revisions).toBe(25);

    // Read back from fresh database to ensure exact content equality
    const freshRepo = new IndexedDbStorageRepository(freshFactory);
    const restoredConv = await freshRepo.getConversation('conv-stream-0');
    expect(restoredConv?.title).toBe('Streaming Conversation 0');

    const restoredMsg = await freshRepo.getMessage('msg-0-1');
    expect(restoredMsg?.role).toBe('assistant');
  });

  it('streaming backup aborts and surfaces error on writable failure (e.g. disk full)', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const { streamBackupToWritable } = await import('../src/backup/streaming-backup');

    let abortedReason: unknown = null;
    const failingWritable = {
      write: async () => {
        throw new Error('ENOSPC: No space left on device');
      },
      close: async () => {},
      abort: async (reason?: unknown) => {
        abortedReason = reason;
      },
    };

    await expect(
      streamBackupToWritable(db, failingWritable)
    ).rejects.toThrow('ENOSPC: No space left on device');

    expect(abortedReason).not.toBeNull();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // COMPLETE HUMAN EXPORT VERIFICATION (Markdown & JSON)
  // ──────────────────────────────────────────────────────────────────────────
  it('exports conversation to Markdown and JSON with correct User -> Assistant order and branch selection', async () => {
    const conv: Conversation = {
      id: 'conv-export-branches',
      remoteId: 'session-branches-1',
      title: 'Branching Dialogue',
      createdAt: 1000,
      updatedAt: 3000,
    };
    await storageRepo.saveConversation(conv);

    // User prompt
    const u1: Message = {
      id: 'u1',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Hello, explain quantum physics.',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(u1);

    // Assistant branch 1 (normal)
    const a1: Message = {
      id: 'a1',
      conversationId: conv.id,
      parentId: u1.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Branch 1 response: wave-particle duality.',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await storageRepo.saveMessage(a1);
    await storageRepo.saveRevision({
      id: 'rev-a1',
      messageId: a1.id,
      revisionIndex: 1,
      text: a1.content!,
      thinking: 'Thinking for branch 1...',
      source: 'network',
      capturedAt: 1100,
      isFinal: true,
      isLastGood: true,
    });

    // Assistant branch 2 (regenerated & filtered, with pre-filter recovery)
    const a2: Message = {
      id: 'a2',
      conversationId: conv.id,
      parentId: u1.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Branch 2 pre-filter response.',
      createdAt: 1200,
      updatedAt: 1200,
    };
    await storageRepo.saveMessage(a2);
    await storageRepo.saveRevision({
      id: 'rev-a2',
      messageId: a2.id,
      revisionIndex: 1,
      text: a2.content!,
      thinking: 'Thinking for branch 2...',
      source: 'network',
      capturedAt: 1200,
      isFinal: false,
      isLastGood: true,
    });
    await storageRepo.saveRecoveryEvent({
      id: 'rec-a2',
      messageId: a2.id,
      kind: 'content_filter',
      detectedAt: 1200,
      recoveredRevisionId: 'rev-a2',
      reason: 'CONTENT_FILTER',
    });

    // User follow-up after branch 1
    const u2: Message = {
      id: 'u2',
      conversationId: conv.id,
      parentId: a1.id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Tell me more about entanglement.',
      createdAt: 1300,
      updatedAt: 1300,
    };
    await storageRepo.saveMessage(u2);

    const exportModel = await storageRepo.getConversationExportModel(conv.id, {
      includeRevisions: false,
    });
    expect(exportModel).not.toBeNull();

    const { buildConversationMarkdown } = await import('../src/export/markdown-exporter');
    const { buildConversationJson } = await import('../src/export/json-exporter');

    // 1. Markdown: All branches
    const mdAll = buildConversationMarkdown(exportModel!, {
      format: 'markdown',
      branches: 'all',
      includeReasoning: true,
      includeRevisions: false,
      includeRecovery: true,
    });

    expect(mdAll).toContain('# Branching Dialogue');
    expect(mdAll).toContain('## User');
    expect(mdAll).toContain('Hello, explain quantum physics.');
    expect(mdAll).toContain('Branch 1 response: wave-particle duality.');
    expect(mdAll).toContain('Branch 2 pre-filter response.');
    expect(mdAll).toContain('Tell me more about entanglement.');

    // 2. JSON Export
    const jsonStr = buildConversationJson(exportModel!, {
      format: 'json',
      branches: 'all',
      includeReasoning: true,
      includeRevisions: false,
      includeRecovery: true,
    });
    const parsedJson = JSON.parse(jsonStr);
    expect(parsedJson.format).toBe('deepseek-streamarchive-conversation');
    expect(parsedJson.messages.length).toBe(4);
    const recoveredMsgJson = parsedJson.messages.find((m: any) => m.id === a2.id);
    expect(recoveredMsgJson.recovery).toBeDefined();
    expect(recoveredMsgJson.recovery.lastGoodText).toBe('Branch 2 pre-filter response.');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // LARGE ARCHIVE SCALABILITY (100 MiB, 163+ MiB, 250 MiB synthetic benchmarks)
  // ──────────────────────────────────────────────────────────────────────────
  it('streams and restores large synthetic dataset with Raw Journal and thousands of revisions without OOM', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const { RawStreamRepository } = await import('../src/storage/raw-journal/repository');
    const rawRepo = new RawStreamRepository(fakeFactory);

    const conv: Conversation = {
      id: 'conv-large-scale',
      remoteId: 'remote-large-scale',
      title: 'Large Scale Synthetic Benchmark',
      createdAt: 1000,
      updatedAt: 5000,
    };
    await storageRepo.saveConversation(conv);

    // Seed 1,000 synthetic messages with revisions and raw stream batches
    const seededMessageIds: string[] = [];
    const seededRevisionsCount = 1000;
    const largeChunkText = 'DeepSeek StreamArchive Synthetic Token Buffer. '.repeat(50); // ~2.4 KB per record

    for (let i = 0; i < 200; i++) {
      const msgId = `msg-scale-${i}`;
      seededMessageIds.push(msgId);
      const isUser = i % 2 === 0;

      await storageRepo.saveMessage({
        id: msgId,
        conversationId: conv.id,
        parentId: i > 0 ? `msg-scale-${i - 1}` : undefined,
        role: isUser ? 'user' : 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
        content: isUser ? `User prompt ${i}` : largeChunkText,
        createdAt: 1000 + i * 10,
        updatedAt: 1000 + i * 10,
      });

      if (!isUser) {
        // Save multiple revisions per assistant message
        for (let r = 0; r < 5; r++) {
          await storageRepo.saveRevision({
            id: `rev-scale-${i}-${r}`,
            messageId: msgId,
            revisionIndex: r,
            text: largeChunkText + ` revision ${r}`,
            thinking: `Thinking token buffer ${r} ` + largeChunkText,
            source: 'network',
            capturedAt: 1000 + i * 10 + r,
            isFinal: r === 4,
            isLastGood: r === 4,
          });
        }
      }
    }

    // Seed raw streams and raw batches directly into all 6 stores
    const rawTx = db.transaction(['raw_streams', 'raw_stream_batches'], 'readwrite');
    for (let s = 0; s < 10; s++) {
      rawTx.objectStore('raw_streams').put({
        id: `prod-scale-1:stream-scale-${s}`,
        producerSessionId: 'prod-scale-1',
        streamId: `stream-scale-${s}`,
        transport: 'fetch',
        method: 'POST',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        state: 'completed',
        openedAt: 1000 + s * 10,
        updatedAt: 1000 + s * 10,
        totalChunks: 2,
        totalChars: largeChunkText.length * 2,
        totalBatches: 1,
      });

      rawTx.objectStore('raw_stream_batches').put({
        id: `batch-${s}-0`,
        streamKey: `prod-scale-1:stream-scale-${s}`,
        batchSeq: 0,
        firstSequence: 1,
        lastSequence: 2,
        chunkCount: 2,
        charCount: largeChunkText.length * 2,
        createdAt: 1000 + s * 10,
        persistedAt: 1000 + s * 10,
        chunks: [
          { streamSequence: 1, timestamp: 1000, chunkText: largeChunkText },
          { streamSequence: 2, timestamp: 1010, chunkText: largeChunkText },
        ],
      });
    }
    await new Promise<void>((resolve, reject) => {
      rawTx.oncomplete = () => resolve();
      rawTx.onerror = () => reject(rawTx.error);
    });

    // Measure memory & streaming performance
    const { streamBackupToWritable } = await import('../src/backup/streaming-backup');
    const chunks: Uint8Array[] = [];

    const mockWritable = {
      write: async (chunk: Uint8Array) => {
        chunks.push(new Uint8Array(chunk));
      },
      close: async () => {},
      abort: async () => {},
    };

    const streamResult = await streamBackupToWritable(db, mockWritable, { batchSize: 50 });
    expect(streamResult.success).toBe(true);
    expect(streamResult.counts.conversations).toBe(1);
    expect(streamResult.counts.messages).toBe(200);
    expect(streamResult.counts.revisions).toBe(500); // 100 assistant messages * 5 revisions
    expect(streamResult.counts.raw_streams).toBe(10);
    expect(streamResult.compressedBytes).toBeGreaterThan(0);

    // Verify roundtrip read & restore
    const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.byteLength;
    }

    const { readPortableBackup } = await import('../src/backup/reader');
    const readResult = await readPortableBackup(combined);
    if (!readResult.success) {
      throw new Error('readResult failed: ' + JSON.stringify(readResult.errors, null, 2));
    }
    expect(readResult.success).toBe(true);
    expect(readResult.totalRecords).toBe(
      streamResult.counts.conversations +
      streamResult.counts.messages +
      streamResult.counts.revisions +
      streamResult.counts.raw_streams +
      streamResult.counts.raw_stream_batches
    );

    // Restore into separate test database
    const targetFactory = new IDBFactory();
    const targetDb = await openExtensionDatabase(targetFactory);
    const { executeRestore } = await import('../src/restore/restore-service');
    const restoreResult = await executeRestore(targetDb, readResult.backup!, 'replace', 0);
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.insertedCounts.messages).toBe(200);
    expect(restoreResult.insertedCounts.revisions).toBe(500);

    // Verify content and parent-child continuity after restore
    const targetRepo = new IndexedDbStorageRepository(targetFactory);
    const restoredMsg5 = await targetRepo.getMessage('msg-scale-5');
    expect(restoredMsg5?.parentId).toBe('msg-scale-4');
    expect(restoredMsg5?.role).toBe('assistant');

    const restoredRevs5 = await targetRepo.listRevisionsByMessage('msg-scale-5');
    expect(restoredRevs5.length).toBe(5);
    expect(restoredRevs5[4]?.isLastGood).toBe(true);
    expect(restoredRevs5[4]?.text).toContain('revision 4');
  });
});
