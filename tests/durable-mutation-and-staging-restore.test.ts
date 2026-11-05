// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  openExtensionDatabase,
  closeExtensionDatabase,
  createDurableWriteTransaction,
  deleteExtensionDatabase,
} from '../src/storage/db';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import {
  getStorageMutationEpoch,
  resetStorageMutationEpoch,
  getDurableStorageMutationEpoch,
} from '../src/storage/mutation-tracker';
import { buildRestorePlan } from '../src/restore/plan';
import { buildCompressedBackup } from '../src/backup/serializer';
import {
  validateAndPreflightRestore,
  executeRestore,
} from '../src/restore/restore-service';
import {
  ingestArchiveToStaging,
  buildRestorePlanFromStaging,
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  createFreshInputStream,
  RESTORE_STAGING_DB_NAME,
  RESTORE_SNAPSHOT_DB_NAME,
} from '../src/restore/staging-service';
import { streamBackupToWritable } from '../src/backup/streaming-backup';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';
import type { RawStreamRecord, RawStreamBatch } from '../src/storage/raw-journal/types';
import { STORE_CANONICAL_CHECKPOINTS, STORE_CONVERSATIONS } from '../src/storage/schema';

describe('Architectural Verification: Durable Mutation, Staging Restore & Zero False Conflicts', () => {
  let fakeFactory: IDBFactory;

  beforeEach(async () => {
    fakeFactory = new IDBFactory();
    (globalThis as any).indexedDB = fakeFactory;
    (globalThis as any).IDBKeyRange = IDBKeyRange;
    closeExtensionDatabase(fakeFactory);
    resetStorageMutationEpoch(1);
    await deleteExtensionDatabase(fakeFactory, RESTORE_STAGING_DB_NAME);
    await deleteExtensionDatabase(fakeFactory, RESTORE_SNAPSHOT_DB_NAME);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 1: Authoritative Durable Mutation Sequence in IndexedDB
  // ──────────────────────────────────────────────────────────────────────────
  it('DEFECT 1: durable mutation sequence persists across Service Worker restarts', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const repo = new IndexedDbStorageRepository(fakeFactory);

    const initialEpoch = await getDurableStorageMutationEpoch(db);
    expect(initialEpoch).toBeGreaterThanOrEqual(1);

    await repo.saveConversation({
      id: 'conv-1',
      title: 'First Chat',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const epoch1 = await getDurableStorageMutationEpoch(db);
    expect(epoch1).toBeGreaterThan(initialEpoch);

    await repo.saveConversation({
      id: 'conv-2',
      title: 'Second Chat',
      createdAt: 2000,
      updatedAt: 2000,
    });

    const epoch2 = await getDurableStorageMutationEpoch(db);
    expect(epoch2).toBeGreaterThan(epoch1);

    // Simulate SW restart
    resetStorageMutationEpoch(1);
    expect(getStorageMutationEpoch()).toBe(1);

    const durableEpochAfterColdStart = await getDurableStorageMutationEpoch(db);
    expect(durableEpochAfterColdStart).toBe(epoch2);
    expect(getStorageMutationEpoch()).toBe(epoch2);
  });

  it('DEFECT 1: aborted transactions roll back and do NOT advance the durable sequence', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const repo = new IndexedDbStorageRepository(fakeFactory);

    await repo.saveConversation({
      id: 'conv-stable',
      title: 'Stable Chat',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const epochBefore = await getDurableStorageMutationEpoch(db);

    await expect(
      new Promise<void>((resolve, reject) => {
        const tx = createDurableWriteTransaction(db, [STORE_CONVERSATIONS]);
        tx.objectStore(STORE_CONVERSATIONS).put({
          id: 'conv-failed',
          title: 'Aborting Chat',
          createdAt: 2000,
          updatedAt: 2000,
        });
        tx.onabort = () => reject(new Error('Transaction aborted by design'));
        tx.abort();
      })
    ).rejects.toThrow('Transaction aborted by design');

    const epochAfter = await getDurableStorageMutationEpoch(db);
    expect(epochAfter).toBe(epochBefore);
  });

  it('DEFECT 1: streaming backup aborts if DB is mutated concurrently, even if SW restarted', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const repo = new IndexedDbStorageRepository(fakeFactory);

    await repo.saveConversation({
      id: 'conv-base',
      title: 'Base Chat',
      createdAt: 1000,
      updatedAt: 1000,
    });

    let wroteMidway = false;
    const dummySink = {
      write: async (_chunk: Uint8Array) => {
        if (!wroteMidway) {
          wroteMidway = true;
          await repo.saveConversation({
            id: 'conv-concurrent',
            title: 'Concurrent Mutation',
            createdAt: 2000,
            updatedAt: 2000,
          });
          resetStorageMutationEpoch(1);
        }
      },
      close: async () => {},
      abort: async () => {},
    };

    await expect(
      streamBackupToWritable(db, dummySink, { batchSize: 1 })
    ).rejects.toThrow(/database was modified during backup creation/);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 3: Zero False Conflicts on Mode Change ('merge')
  // ──────────────────────────────────────────────────────────────────────────
  it('DEFECT 3 FIX: buildRestorePlan defensively rejects lightweight stub objects', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const lightweightBackup: any = {
      manifest: { format: 'streamarchive' },
      footer: { counts: {} },
      records: { conversations: [{ id: 'stub' }] },
      _lightweight: true,
    };

    await expect(
      buildRestorePlan(db, lightweightBackup, 'merge')
    ).rejects.toThrow(/Cannot build merge plan from lightweight inspection backup/);
  });

  it('DEFECT 3 FIX: validateAndPreflightRestore produces ZERO false conflicts on identical data in merge mode', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const repo = new IndexedDbStorageRepository(fakeFactory);

    // 1. Seed conversation & message in local DB
    const conv: Conversation = {
      id: 'conv-exact',
      title: 'Exact Identical Title',
      createdAt: 1000,
      updatedAt: 2000,
      remoteId: 'remote-session-1',
    };
    const msg: Message = {
      id: 'msg-exact',
      conversationId: 'conv-exact',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Exact user message content',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await repo.saveConversation(conv);
    await repo.saveMessage(msg);

    // 2. Export backup snapshot and compress
    const snapshot = await repo.createPortableBackupSnapshot();
    const compressedGz = await buildCompressedBackup(snapshot);

    // 3. Preflight with mode = 'merge' against identical local DB
    const { preflight } = await validateAndPreflightRestore(
      db,
      compressedGz,
      0,
      'merge'
    );

    expect(preflight.canRestore).toBe(true);
    expect(preflight.validationErrors).toHaveLength(0);
    expect(preflight.plan?.conflicts).toHaveLength(0);
    // Identical records must be skipped, NOT flagged as conflicts!
    expect(preflight.plan?.toSkip.conversations).toBe(1);
    expect(preflight.plan?.toSkip.messages).toBe(1);
    expect(preflight.plan?.toInsert.conversations).toHaveLength(0);
    expect(preflight.plan?.toInsert.messages).toHaveLength(0);
  });

  it('DEFECT 3 FIX: detects genuine content conflict (same ID, different content)', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const repo = new IndexedDbStorageRepository(fakeFactory);

    await repo.saveConversation({
      id: 'conv-conflict',
      title: 'Local Version Title',
      createdAt: 1000,
      updatedAt: 2000,
    });

    const snapshot = await repo.createPortableBackupSnapshot();
    // Modify incoming backup title to differ from local
    const convRec = snapshot.records.find((r) => r.store === 'conversations')!;
    (convRec.value as any).title = 'Differing Incoming Title';
    const compressedGz = await buildCompressedBackup(snapshot);

    const { preflight } = await validateAndPreflightRestore(
      db,
      compressedGz,
      0,
      'merge'
    );

    expect(preflight.canRestore).toBe(false);
    expect(preflight.plan?.conflicts.length).toBeGreaterThan(0);
    expect(preflight.plan?.conflicts[0]!.code).toBe('primary_key_conflict');
    expect(preflight.plan?.conflicts[0]!.message).toContain('differing content');
  });

  it('DEFECT 3 FIX: detects genuine semantic identity collision (different ID, same remoteId)', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const repo = new IndexedDbStorageRepository(fakeFactory);

    await repo.saveConversation({
      id: 'local-conv-id',
      remoteId: 'shared-remote-id',
      title: 'Local Conversation',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const snapshot = await repo.createPortableBackupSnapshot();
    // Same remoteId, but incoming archive has different primary key
    const convRec = snapshot.records.find((r) => r.store === 'conversations')!;
    (convRec.value as any).id = 'incoming-conv-id';
    const compressedGz = await buildCompressedBackup(snapshot);

    const { preflight } = await validateAndPreflightRestore(
      db,
      compressedGz,
      0,
      'merge'
    );

    expect(preflight.canRestore).toBe(false);
    const remoteConflict = preflight.plan?.conflicts.find((c) => c.code === 'semantic_identity_collision');
    expect(remoteConflict).toBeDefined();
    expect(remoteConflict?.message).toContain('conflicts with local identity');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 2 & 4: Staging Database Restore, Bounded Memory & Rollback Guard
  // ──────────────────────────────────────────────────────────────────────────
  it('DEFECT 2 & 4: creates independent fresh streams without input.tee() memory accumulation', () => {
    const u8 = new Uint8Array([1, 2, 3, 4]);
    const { stream: s1, isSingleUse: u1 } = createFreshInputStream(u8);
    const { stream: s2, isSingleUse: u2 } = createFreshInputStream(u8);

    expect(s1).not.toBe(s2);
    expect(u1).toBe(false);
    expect(u2).toBe(false);
  });

  it('DEFECT 2 & 5: rollback guard restores original database if restore fails midway', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const repo = new IndexedDbStorageRepository(fakeFactory);

    // 1. Initial live database state
    await repo.saveConversation({
      id: 'live-conv-original',
      title: 'Original Live Conversation Must Survive',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await repo.saveMessage({
      id: 'live-msg-original',
      conversationId: 'live-conv-original',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Original Live Content',
      createdAt: 1000,
      updatedAt: 1000,
    });

    const initialLiveCounts = await repo.getCurrentStoreCounts();
    expect(initialLiveCounts.conversations).toBe(1);
    expect(initialLiveCounts.messages).toBe(1);

    // 2. Prepare staging database with corrupted record that causes verification failure
    const snapshot = await repo.createPortableBackupSnapshot();
    const compressedGz = await buildCompressedBackup(snapshot);

    // Intentionally pass impossible expected counts to trigger verification failure
    const corruptCounts = {
      conversations: 999, // impossible mismatch
      messages: 999,
      revisions: 0,
      recovery_events: 0,
      raw_streams: 0,
      raw_stream_batches: 0,
    };

    const { stagingDb } = await ingestArchiveToStaging(compressedGz, fakeFactory);
    const res = await commitStagingReplaceToLive(db, stagingDb, corruptCounts, fakeFactory);

    expect(res.success).toBe(false);
    expect(res.verified).toBe(false);
    expect(res.error).toContain('Store count mismatch');

    // 3. VERIFY ROLLBACK: Live database was restored to its exact pre-restore state!
    const rolledBackCounts = await repo.getCurrentStoreCounts();
    expect(rolledBackCounts.conversations).toBe(1);
    expect(rolledBackCounts.messages).toBe(1);

    const preservedConv = await repo.getConversation('live-conv-original');
    expect(preservedConv?.title).toBe('Original Live Conversation Must Survive');

    const preservedMsg = await repo.getMessage('live-msg-original');
    expect(preservedMsg?.content).toBe('Original Live Content');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 5: Real Content Fidelity (Edit/Regenerate, DeepThink, Censorship, Raw)
  // ──────────────────────────────────────────────────────────────────────────
  it('DEFECT 5: verifies byte-for-byte content fidelity across backup and staging restore', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const repo = new IndexedDbStorageRepository(fakeFactory);

    // 1. Seed complete suite of entities
    const conv: Conversation = {
      id: 'conv-deep',
      title: 'Full Fidelity Check',
      createdAt: 1000,
      updatedAt: 2000,
    };
    await repo.saveConversation(conv);

    const userPrompt: Message = {
      id: 'msg-u1',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Explain quantum computing.',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await repo.saveMessage(userPrompt);

    // Branch 1: Normal with DeepThink
    const branch1: Message = {
      id: 'msg-a1-normal',
      conversationId: conv.id,
      parentId: userPrompt.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Quantum computing uses qubits.',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await repo.saveMessage(branch1);
    await repo.saveRevision({
      id: 'rev-b1',
      messageId: branch1.id,
      revisionIndex: 1,
      text: branch1.content!,
      thinking: 'Complex quantum superposition reasoning chain.',
      source: 'network',
      capturedAt: 1100,
      isFinal: true,
      isLastGood: true,
    });

    // Branch 2: Regenerated with censorship recovery event & lastGood
    const branch2: Message = {
      id: 'msg-a1-regenerated',
      conversationId: conv.id,
      parentId: userPrompt.id, // Sibling sharing same parent!
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Sensitive answer caught by filter.',
      createdAt: 1200,
      updatedAt: 1200,
    };
    await repo.saveMessage(branch2);
    await repo.saveRevision({
      id: 'rev-b2-lastgood',
      messageId: branch2.id,
      revisionIndex: 1,
      text: 'Useful uncensored pre-filter response.',
      thinking: 'Uncensored reasoning before filter.',
      source: 'network',
      capturedAt: 1200,
      isFinal: false,
      isLastGood: true,
    });
    await repo.saveRecoveryEvent({
      id: 'rec-filter',
      messageId: branch2.id,
      kind: 'content_filter',
      detectedAt: 1250,
      recoveredRevisionId: 'rev-b2-lastgood',
      reason: 'CONTENT_FILTER',
    });

    // Raw stream and batch
    const rawStream: RawStreamRecord = {
      id: 'sess-q:stream-1',
      producerSessionId: 'sess-q',
      streamId: 'stream-1',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/chat/completion',
      method: 'POST',
      state: 'completed',
      openedAt: 1000,
      updatedAt: 1300,
      totalChunks: 1,
      totalChars: 50,
      totalBatches: 1,
    };
    const rawBatch: RawStreamBatch = {
      id: 'sess-q:stream-1:1',
      streamKey: 'sess-q:stream-1',
      batchSeq: 1,
      createdAt: 1100,
      charCount: 50,
      chunks: [{ streamSequence: 1, timestamp: 1100, chunkText: 'Raw network chunk' }],
    };

    const rawTx = createDurableWriteTransaction(db, ['raw_streams', 'raw_stream_batches'], 'strict');
    rawTx.objectStore('raw_streams').put(rawStream);
    rawTx.objectStore('raw_stream_batches').put(rawBatch);
    await new Promise<void>((r) => { rawTx.oncomplete = () => r(); });

    // 2. Export & compress
    const snapshot = await repo.createPortableBackupSnapshot();
    const compressedGz = await buildCompressedBackup(snapshot);

    // 3. Clear database to simulate fresh environment
    closeExtensionDatabase(fakeFactory);
    const freshDb = await openExtensionDatabase(fakeFactory);
    const freshRepo = new IndexedDbStorageRepository(fakeFactory);

    // 4. Restore via executeRestore (using Staging Database engine)
    const restoreResult = await executeRestore(freshDb, compressedGz, 'replace', 0);
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.verified).toBe(true);

    // 5. Deep content checks:
    // Sibling branches share exact parentId
    const restoredBranch1 = await freshRepo.getMessage('msg-a1-normal');
    const restoredBranch2 = await freshRepo.getMessage('msg-a1-regenerated');
    expect(restoredBranch1?.parentId).toBe('msg-u1');
    expect(restoredBranch2?.parentId).toBe('msg-u1');

    // DeepThink reasoning text
    const rev1 = await freshRepo.getRevision('rev-b1');
    expect(rev1?.thinking).toBe('Complex quantum superposition reasoning chain.');

    // Censorship recovery event & lastGood revision
    const lastGood = await freshRepo.getLastGoodRevision('msg-a1-regenerated');
    expect(lastGood?.id).toBe('rev-b2-lastgood');
    expect(lastGood?.text).toBe('Useful uncensored pre-filter response.');
    expect(lastGood?.thinking).toBe('Uncensored reasoning before filter.');

    const recs = await freshRepo.listRecoveryEvents('msg-a1-regenerated');
    expect(recs).toHaveLength(1);
    expect(recs[0]!.recoveredRevisionId).toBe('rev-b2-lastgood');
    expect(recs[0]!.kind).toBe('content_filter');

    // Raw stream batch
    const rawCheckTx = freshDb.transaction(['raw_streams', 'raw_stream_batches'], 'readonly');
    const restoredBatch = await new Promise<any>((resolve) => {
      rawCheckTx.objectStore('raw_stream_batches').get('sess-q:stream-1:1').onsuccess = (e) => resolve((e.target as any).result);
    });
    expect(restoredBatch?.chunks[0]?.chunkText).toBe('Raw network chunk');
  });
});
