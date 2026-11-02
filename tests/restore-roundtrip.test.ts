import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { buildCompressedBackup } from '../src/backup/serializer';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';
import type { RawStreamRecord, RawStreamBatch } from '../src/storage/raw-journal/types';

describe('End-to-End Portable Backup & Restore Round-Trip Fidelity', () => {
  let db: IDBDatabase;
  let repo: IndexedDbStorageRepository;

  beforeEach(async () => {
    closeExtensionDatabase();
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase();
    repo = new IndexedDbStorageRepository();
  });

  it('guarantees 100% round-trip preservation of branches, censorship recovery, and retry attempt isolation', async () => {
    // 1. Seed Complex Conversation Tree in DB
    // 1a. Branching conversation (2 sibling branches)
    const convBranch: Conversation = {
      id: 'conv-branch',
      title: 'Branching Tree Test',
      createdAt: 1000,
      updatedAt: 2000,
      remoteId: 'remote-branch-session',
    };
    await repo.saveConversation(convBranch);

    const userMsg: Message = {
      id: 'msg-u1',
      conversationId: 'conv-branch',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Explain physics',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await repo.saveMessage(userMsg);

    const branch1: Message = {
      id: 'msg-a1-b1',
      conversationId: 'conv-branch',
      parentId: 'msg-u1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Physics branch 1',
      createdAt: 1200,
      updatedAt: 1200,
    };
    const branch2: Message = {
      id: 'msg-a1-b2',
      conversationId: 'conv-branch',
      parentId: 'msg-u1', // Sibling sharing same parent!
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Physics branch 2 regenerated',
      createdAt: 1300,
      updatedAt: 1300,
    };
    await repo.saveMessages([branch1, branch2]);

    const rev1: ResponseRevision = {
      id: 'rev-b1',
      messageId: 'msg-a1-b1',
      revisionIndex: 0,
      text: 'Physics branch 1 text',
      source: 'network',
      capturedAt: 1200,
      isFinal: true,
      isLastGood: true,
    };
    const rev2: ResponseRevision = {
      id: 'rev-b2',
      messageId: 'msg-a1-b2',
      revisionIndex: 0,
      text: 'Physics branch 2 text',
      source: 'network',
      capturedAt: 1300,
      isFinal: true,
      isLastGood: true,
    };
    await repo.saveRevisions([rev1, rev2]);

    // 1b. Censorship recovery conversation
    const convFiltered: Conversation = {
      id: 'conv-filtered',
      title: 'Censorship Anti-Recall Test',
      createdAt: 3000,
      updatedAt: 4000,
    };
    await repo.saveConversation(convFiltered);

    const filteredMsg: Message = {
      id: 'msg-filtered',
      conversationId: 'conv-filtered',
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 3100,
      updatedAt: 3200,
    };
    await repo.saveMessage(filteredMsg);

    const lastGoodRev: ResponseRevision = {
      id: 'rev-lastgood',
      messageId: 'msg-filtered',
      revisionIndex: 0,
      text: 'Useful uncensored answer before filter',
      thinking: 'Reasoning before filter',
      source: 'network',
      capturedAt: 3150,
      isFinal: false,
      isLastGood: true,
    };
    await repo.saveRevision(lastGoodRev);

    const recoveryEvent: RecoveryEvent = {
      id: 'rec-1',
      messageId: 'msg-filtered',
      kind: 'content_filter',
      detectedAt: 3200,
      recoveredRevisionId: 'rev-lastgood',
      reason: 'CONTENT_FILTER triggered',
    };
    await repo.saveRecoveryEvent(recoveryEvent);

    // 1c. Retry attempts & unmatched capture isolation (2D.3)
    const convRetry: Conversation = {
      id: 'conv-retry',
      title: 'Retry Attempts Isolation Test',
      createdAt: 5000,
      updatedAt: 6000,
    };
    await repo.saveConversation(convRetry);

    const logicalMsg: Message = {
      id: 'msg-logical',
      conversationId: 'conv-retry',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Final successful attempt',
      createdAt: 5300,
      updatedAt: 5300,
    };
    const attemptOnlyMsg: Message = {
      id: 'msg-attempt-only',
      conversationId: 'conv-retry',
      parentId: undefined, // Must not have parent
      role: 'assistant',
      status: 'interrupted',
      identityState: 'provisional',
      projectionState: 'attempt_only',
      createdAt: 5100,
      updatedAt: 5100,
    };
    const unmatchedMsg: Message = {
      id: 'msg-unmatched',
      conversationId: 'conv-retry',
      parentId: undefined,
      role: 'assistant',
      status: 'interrupted',
      identityState: 'provisional',
      projectionState: 'unmatched_capture',
      content: 'Partial captured stream',
      createdAt: 5200,
      updatedAt: 5200,
    };
    await repo.saveMessages([logicalMsg, attemptOnlyMsg, unmatchedMsg]);

    // Raw streams for all 3 attempts
    for (let i = 1; i <= 3; i++) {
      const stream: RawStreamRecord = {
        id: `sess-retry:stream-${i}`,
        producerSessionId: 'sess-retry',
        streamId: `stream-${i}`,
        transport: 'xhr',
        url: 'https://chat.deepseek.com/chat/completion',
        method: 'POST',
        state: i === 3 ? 'completed' : 'aborted',
        openedAt: 5000 + i * 100,
        updatedAt: 5000 + i * 100 + 50,
        totalChunks: 2,
        totalChars: 100,
        totalBatches: 1,
      };
      const txStream = db.transaction(['raw_streams', 'raw_stream_batches'], 'readwrite');
      txStream.objectStore('raw_streams').put(stream);
      txStream.objectStore('raw_stream_batches').put({
        id: `sess-retry:stream-${i}:1`,
        streamKey: `sess-retry:stream-${i}`,
        batchSeq: 1,
        chunks: [{ streamSequence: 0, chunkText: `attempt ${i}`, timestamp: 5000 + i * 100 }],
        createdAt: 5000 + i * 100,
        charCount: 9,
      });
      await new Promise<void>((r) => {
        txStream.oncomplete = () => r();
      });
    }

    // 2. Export Portable Backup Snapshot
    const snapshot = await repo.createPortableBackupSnapshot();
    expect(snapshot.footer.counts.conversations).toBe(3);
    expect(snapshot.footer.counts.messages).toBe(7);
    expect(snapshot.footer.counts.revisions).toBe(3);
    expect(snapshot.footer.counts.recovery_events).toBe(1);
    expect(snapshot.footer.counts.raw_streams).toBe(3);
    expect(snapshot.footer.counts.raw_stream_batches).toBe(3);

    // Compress into .streamarchive.jsonl.gz
    const compressedGz = await buildCompressedBackup(snapshot);
    expect(compressedGz.byteLength).toBeGreaterThan(0);

    // 3. Clear database to simulate fresh environment
    closeExtensionDatabase();
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase();
    repo = new IndexedDbStorageRepository();

    const emptyCounts = await repo.getCurrentStoreCounts();
    expect(emptyCounts.conversations).toBe(0);

    // 4. Preflight and Validate
    const { preflight, backup } = await repo.validateAndPreflightRestore(compressedGz, 0, 'replace');
    expect(preflight.canRestore).toBe(true);
    expect(preflight.validationErrors).toHaveLength(0);
    expect(backup).toBeDefined();

    // 5. Execute Replace Restore
    const restoreRes = await repo.executeRestore(backup!, 'replace', 0);
    expect(restoreRes.success).toBe(true);
    expect(restoreRes.verified).toBe(true);
    expect(restoreRes.insertedCounts.conversations).toBe(3);
    expect(restoreRes.insertedCounts.messages).toBe(7);

    // 6. Comprehensive Verification of Restored Entities
    // 6a. Branch structure
    const restoredBranchConvs = await repo.getArchiveConversation('conv-branch');
    expect(restoredBranchConvs).toBeDefined();
    expect(restoredBranchConvs?.messages).toHaveLength(3);
    const siblings = restoredBranchConvs?.messages.filter((m) => m.parentId === 'msg-u1');
    expect(siblings).toHaveLength(2);

    // 6b. Recovery event & LastGood
    const restoredRecovery = await repo.listRecoveryEvents('msg-filtered');
    expect(restoredRecovery).toHaveLength(1);
    expect(restoredRecovery[0]?.recoveredRevisionId).toBe('rev-lastgood');
    const restoredLastGood = await repo.getLastGoodRevision('msg-filtered');
    expect(restoredLastGood?.text).toBe('Useful uncensored answer before filter');
    expect(restoredLastGood?.thinking).toBe('Reasoning before filter');

    // 6c. Retry attempts & Raw Streams
    const restoredRetryConv = await repo.getArchiveConversation('conv-retry');
    // Logical assistant count in conversation view must be 1!
    const logicalAssistantMsgs = restoredRetryConv?.messages.filter(
      (m) => m.role === 'assistant' && (m.projectionState === 'logical' || m.projectionState === 'provisional_logical')
    );
    expect(logicalAssistantMsgs).toHaveLength(1);

    // While raw streams in raw journal must still be 3!
    const restoredRawStreams = await repo.getCurrentStoreCounts();
    expect(restoredRawStreams.raw_streams).toBe(3);
    expect(restoredRawStreams.raw_stream_batches).toBe(3);
  });
});
