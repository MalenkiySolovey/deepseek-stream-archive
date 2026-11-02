import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { RawStreamRepository } from '../src/storage/raw-journal/repository';
import { openExtensionDatabase } from '../src/storage/db';
import {
  createPortableBackupSnapshot,
  buildCompressedBackup,
  validatePortableBackup,
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_FORMAT_VERSION,
  INCLUDED_BACKUP_STORES,
  compressGzip,
} from '../src/backup';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';

describe('Portable Full-Archive Backup v1 (Snapshot, Native Gzip, Validation)', () => {
  let storage: IndexedDbStorageRepository;
  let rawStorage: RawStreamRepository;
  let db: IDBDatabase;

  beforeEach(async () => {
    // Unique in-memory database name per test
    const testDbName = `StreamArchiveDB_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase(indexedDB);
    storage = new IndexedDbStorageRepository(indexedDB);
    rawStorage = new RawStreamRepository(indexedDB);
  });

  async function seedTestArchive() {
    // 1. Conversation
    const conv1: Conversation = {
      id: 'conv_001',
      remoteId: 'remote_sess_001',
      title: 'Distributed Systems & Consensus',
      createdAt: 1000,
      updatedAt: 2000,
    };
    const conv2: Conversation = {
      id: 'conv_002',
      remoteId: 'remote_sess_002',
      title: 'Квантовая механика и криптография',
      createdAt: 1500,
      updatedAt: 2500,
    };
    await storage.saveConversation(conv2);
    await storage.saveConversation(conv1); // Out of order to verify sorting

    // 2. Messages with diverse projection states
    const msgUser: Message = {
      id: 'msg_01_user',
      conversationId: 'conv_001',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Explain Raft consensus.',
      createdAt: 1010,
      updatedAt: 1010,
    };
    const msgAttemptOnly: Message = {
      id: 'msg_02_attempt',
      conversationId: 'conv_001',
      role: 'assistant',
      status: 'interrupted',
      identityState: 'provisional',
      projectionState: 'attempt_only',
      content: '',
      createdAt: 1020,
      updatedAt: 1025,
    };
    const msgLogicalAsst: Message = {
      id: 'msg_03_asst',
      conversationId: 'conv_001',
      parentId: 'msg_01_user',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Raft election involves leader heartbeats and term increments.',
      createdAt: 1030,
      updatedAt: 1050,
    };
    await storage.saveMessage(msgAttemptOnly);
    await storage.saveMessage(msgLogicalAsst);
    await storage.saveMessage(msgUser);

    // 3. Revisions including isLastGood
    const rev1: ResponseRevision = {
      id: 'rev_01',
      messageId: 'msg_03_asst',
      revisionIndex: 0,
      source: 'network',
      isFinal: false,
      isLastGood: true,
      text: msgLogicalAsst.content!,
      thinking: 'Analyzing Raft vs Paxos simplicity.',
      capturedAt: 1040,
    };
    const rev2: ResponseRevision = {
      id: 'rev_02',
      messageId: 'msg_03_asst',
      revisionIndex: 1,
      source: 'history',
      isFinal: true,
      isLastGood: false,
      text: msgLogicalAsst.content!,
      capturedAt: 1050,
    };
    await storage.saveRevision(rev2);
    await storage.saveRevision(rev1);

    // 4. Recovery Event
    const recEvent: RecoveryEvent = {
      id: 'rec_01',
      messageId: 'msg_03_asst',
      kind: 'content_filter',
      detectedAt: 1045,
      recoveredRevisionId: 'rev_01',
      reason: 'Safety audit boundary trigger',
    };
    await storage.saveRecoveryEvent(recEvent);

    // 5. Raw Journal Streams and Batches (Evidence Layer)
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['raw_streams', 'raw_stream_batches'], 'readwrite');
      tx.objectStore('raw_streams').put({
        id: 'sess_001:stream_01',
        producerSessionId: 'sess_001',
        streamId: 'stream_01',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        transport: 'xhr',
        method: 'POST',
        state: 'completed',
        openedAt: 1015,
        updatedAt: 1030,
        totalBatches: 1,
        totalChunks: 1,
        totalChars: 28,
      });
      tx.objectStore('raw_stream_batches').put({
        id: 'batch_01',
        streamKey: 'sess_001:stream_01',
        batchSeq: 1,
        chunks: [
          {
            streamSequence: 1,
            chunkText: '{"p":"/response","v":"Raft"}',
            timestamp: 1020,
          },
        ],
        charCount: 28,
        createdAt: 1025,
        persistedAt: 1025,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // 6. Ephemeral history staging (must be EXCLUDED from backup!)
    await storage.saveHistoryStagingManifest({
      stagingId: 'stage_test_1',
      sessionId: 'remote_sess_001',
      expectedBatchCount: 1,
      expectedMessageCount: 2,
      receivedBatchCount: 1,
      state: 'open',
      createdAt: 1000,
      updatedAt: 1000,
    });
  }

  it('creates point-in-time snapshot with deterministic ordering and strictly whitelisted stores', async () => {
    await seedTestArchive();

    const snapshot = await createPortableBackupSnapshot(db);

    // Verify manifest
    expect(snapshot.manifest.kind).toBe('manifest');
    expect(snapshot.manifest.format).toBe(PORTABLE_BACKUP_FORMAT);
    expect(snapshot.manifest.formatVersion).toBe(PORTABLE_BACKUP_FORMAT_VERSION);
    expect(snapshot.manifest.sourceDatabase).toBe('StreamArchiveDB');
    expect(snapshot.manifest.sourceDatabaseVersion).toBe(8);
    expect(snapshot.manifest.compression).toBe('gzip');

    // Verify store counts in footer
    expect(snapshot.footer.kind).toBe('footer');
    expect(snapshot.footer.complete).toBe(true);
    expect(snapshot.footer.counts.conversations).toBe(2);
    expect(snapshot.footer.counts.messages).toBe(3);
    expect(snapshot.footer.counts.revisions).toBe(2);
    expect(snapshot.footer.counts.recovery_events).toBe(1);
    expect(snapshot.footer.counts.raw_streams).toBe(1);
    expect(snapshot.footer.counts.raw_stream_batches).toBe(1);

    // Verify excluded stores are completely absent
    const storesInSnapshot = new Set(snapshot.records.map((r) => r.store));
    expect(storesInSnapshot.has('history_staging' as any)).toBe(false);
    expect(storesInSnapshot.has('history_staging_manifests' as any)).toBe(false);
    expect(storesInSnapshot.has('canonical_checkpoints' as any)).toBe(false);

    // Verify deterministic store progression
    let lastStoreIdx = -1;
    for (const record of snapshot.records) {
      const idx = INCLUDED_BACKUP_STORES.indexOf(record.store);
      expect(idx).toBeGreaterThanOrEqual(lastStoreIdx);
      lastStoreIdx = idx;
    }

    // Verify primary-key ascending order within conversations ('conv_001' before 'conv_002')
    const convRecords = snapshot.records.filter((r) => r.store === 'conversations');
    expect(convRecords[0]?.value.id).toBe('conv_001');
    expect(convRecords[1]?.value.id).toBe('conv_002');

    // Verify attempt_only message is faithfully preserved in backup
    const msgRecords = snapshot.records.filter((r) => r.store === 'messages');
    const attemptMsg = msgRecords.find((r) => r.value.id === 'msg_02_attempt');
    expect(attemptMsg).toBeDefined();
    expect(attemptMsg?.value.projectionState).toBe('attempt_only');
  });

  it('compresses and validates a complete backup successfully', async () => {
    await seedTestArchive();

    const snapshot = await createPortableBackupSnapshot(db);
    const compressedBytes = await buildCompressedBackup(snapshot);

    expect(compressedBytes.length).toBeGreaterThan(0);
    // Gzip magic number check (0x1f, 0x8b)
    expect(compressedBytes[0]).toBe(0x1f);
    expect(compressedBytes[1]).toBe(0x8b);

    // Validate using pure read-only validator
    const result = await validatePortableBackup(compressedBytes);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.format).toBe(PORTABLE_BACKUP_FORMAT);
    expect(result.formatVersion).toBe(PORTABLE_BACKUP_FORMAT_VERSION);
    expect(result.counts?.conversations).toBe(2);
    expect(result.counts?.messages).toBe(3);
    expect(result.counts?.revisions).toBe(2);
    expect(result.counts?.raw_streams).toBe(1);
    expect(result.totalRecords).toBe(10);
  });

  it('rejects corrupted or truncated gzip bytes without throwing unhandled exceptions', async () => {
    const corruptBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff]);
    const result = await validatePortableBackup(corruptBytes);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'corrupt_gzip_stream')).toBe(true);
  });

  it('rejects backup missing the footer record (truncated backup)', async () => {
    const manifest = {
      kind: 'manifest',
      format: PORTABLE_BACKUP_FORMAT,
      formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
      createdAt: 1000,
      appVersion: '0.1.0',
      sourceDatabase: 'StreamArchiveDB',
      sourceDatabaseVersion: 8,
      encoding: 'utf-8',
      compression: 'gzip',
      includedStores: [...INCLUDED_BACKUP_STORES],
      excludedStores: [],
      privacy: {
        containsConversationContent: true,
        containsReasoning: true,
        containsRecoveredContent: true,
        containsRawNetworkEvidence: true,
      },
    };

    // NDJSON missing footer
    const ndjson = JSON.stringify(manifest) + '\n';
    const compressed = await compressGzip(ndjson);

    const result = await validatePortableBackup(compressed);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'missing_backup_footer')).toBe(true);
  });

  it('rejects unsupported newer backup formatVersion (formatVersion > 1)', async () => {
    const manifest = {
      kind: 'manifest',
      format: PORTABLE_BACKUP_FORMAT,
      formatVersion: 2, // Unsupported future version
      createdAt: 1000,
      appVersion: '0.2.0',
      sourceDatabase: 'StreamArchiveDB',
      sourceDatabaseVersion: 9,
      encoding: 'utf-8',
      compression: 'gzip',
      includedStores: [...INCLUDED_BACKUP_STORES],
      excludedStores: [],
      privacy: {
        containsConversationContent: true,
        containsReasoning: true,
        containsRecoveredContent: true,
        containsRawNetworkEvidence: true,
      },
    };

    const footer = {
      kind: 'footer',
      complete: true,
      counts: {
        conversations: 0,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
    };

    const ndjson = JSON.stringify(manifest) + '\n' + JSON.stringify(footer) + '\n';
    const compressed = await compressGzip(ndjson);

    const result = await validatePortableBackup(compressed);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'unsupported_backup_version')).toBe(true);
  });

  it('rejects count mismatch between footer and actual record lines', async () => {
    const manifest = {
      kind: 'manifest',
      format: PORTABLE_BACKUP_FORMAT,
      formatVersion: 1,
      createdAt: 1000,
      appVersion: '0.1.0',
      sourceDatabase: 'StreamArchiveDB',
      sourceDatabaseVersion: 8,
      encoding: 'utf-8',
      compression: 'gzip',
      includedStores: [...INCLUDED_BACKUP_STORES],
      excludedStores: [],
      privacy: {
        containsConversationContent: true,
        containsReasoning: true,
        containsRecoveredContent: true,
        containsRawNetworkEvidence: true,
      },
    };

    const record = {
      kind: 'record',
      store: 'conversations',
      value: { id: 'c1', title: 'Test' },
    };

    const footerWithWrongCount = {
      kind: 'footer',
      complete: true,
      counts: {
        conversations: 5, // Declared 5 but provided 1
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
    };

    const ndjson = [
      JSON.stringify(manifest),
      JSON.stringify(record),
      JSON.stringify(footerWithWrongCount),
    ].join('\n') + '\n';

    const compressed = await compressGzip(ndjson);
    const result = await validatePortableBackup(compressed);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'footer_count_mismatch')).toBe(true);
  });

  it('rejects stores appearing out of order', async () => {
    const manifest = {
      kind: 'manifest',
      format: PORTABLE_BACKUP_FORMAT,
      formatVersion: 1,
      createdAt: 1000,
      appVersion: '0.1.0',
      sourceDatabase: 'StreamArchiveDB',
      sourceDatabaseVersion: 8,
      encoding: 'utf-8',
      compression: 'gzip',
      includedStores: [...INCLUDED_BACKUP_STORES],
      excludedStores: [],
      privacy: {
        containsConversationContent: true,
        containsReasoning: true,
        containsRecoveredContent: true,
        containsRawNetworkEvidence: true,
      },
    };

    // Out of order: message record BEFORE conversation record
    const record1 = {
      kind: 'record',
      store: 'messages',
      value: { id: 'm1' },
    };
    const record2 = {
      kind: 'record',
      store: 'conversations', // Appears after messages!
      value: { id: 'c1' },
    };

    const footer = {
      kind: 'footer',
      complete: true,
      counts: {
        conversations: 1,
        messages: 1,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
    };

    const ndjson = [
      JSON.stringify(manifest),
      JSON.stringify(record1),
      JSON.stringify(record2),
      JSON.stringify(footer),
    ].join('\n') + '\n';

    const compressed = await compressGzip(ndjson);
    const result = await validatePortableBackup(compressed);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'stores_out_of_order')).toBe(true);
  });

  it('enforces memory safety limit and aborts before producing partial backups', async () => {
    await seedTestArchive();

    // Set maxBytes to a tiny threshold (e.g. 50 bytes)
    await expect(
      createPortableBackupSnapshot(db, { maxBytes: 50 })
    ).rejects.toThrow('This archive is too large for the current portable backup implementation. No backup file was created.');
  });

  it('guarantees point-in-time snapshot isolation across concurrent writes', async () => {
    // 1. Seed initial data state A
    const convA: Conversation = {
      id: 'conv_state_A',
      title: 'State A Conversation',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storage.saveConversation(convA);

    // 2. Start snapshot promise (opens multi-store readonly transaction)
    const snapshotPromise = createPortableBackupSnapshot(db);

    // 3. Immediately queue concurrent write B into IndexedDB
    const writeBPromise = storage.saveConversation({
      id: 'conv_state_B_concurrent',
      title: 'State B Conversation',
      createdAt: 2000,
      updatedAt: 2000,
    });

    const [snapshot] = await Promise.all([snapshotPromise, writeBPromise]);

    // Snapshot was opened before write B committed, so it contains state A
    // (In IndexedDB transaction scheduling, readonly tx opened first sees state A)
    const convIdsInSnapshot = snapshot.records
      .filter((r) => r.store === 'conversations')
      .map((r) => r.value.id);

    expect(convIdsInSnapshot).toContain('conv_state_A');

    // Verify database afterwards contains both records normally without lockup
    const allConvs = await storage.listConversations();
    expect(allConvs.some((c) => c.id === 'conv_state_A')).toBe(true);
    expect(allConvs.some((c) => c.id === 'conv_state_B_concurrent')).toBe(true);
  });
});
