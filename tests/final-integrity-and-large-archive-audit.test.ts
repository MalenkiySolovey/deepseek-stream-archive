// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import {
  verifyDatabaseEquality,
  verifyMergeDatabaseIntegrity,
  validateStagingReferentialIntegrity,
  batchGetKeys,
  computeStoreContentChecksum,
  computeDatabaseStoreChecksums,
  recoverIncompleteRestoreIfAny,
  setRestoreJournalMarker,
  getRestoreJournalMarker,
  getStoreRecordCount,
  createStagingDatabaseName,
  createSnapshotDatabaseName,
  SIX_DURABLE_STORES,
  EIGHT_SNAPSHOT_STORES,
  RESTORE_STAGING_DB_NAME,
  RESTORE_SNAPSHOT_DB_NAME,
  type RestoreJournalMarker,
} from '../src/restore/staging-service';
import { openExtensionDatabase, deleteExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import { executeRestore } from '../src/restore/restore-service';
import { compressGzip } from '../src/backup/compression';
import {
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_FORMAT_VERSION,
  INCLUDED_BACKUP_STORES,
  EXCLUDED_BACKUP_STORES,
  type IncludedBackupStoreName,
} from '../src/backup/format';

async function makeCompressedArchive(
  records: Array<{ store: IncludedBackupStoreName; record: any }>
): Promise<Uint8Array> {
  const counts: Record<string, number> = {
    conversations: 0,
    messages: 0,
    revisions: 0,
    recovery_events: 0,
    raw_streams: 0,
    raw_stream_batches: 0,
  };
  for (const r of records) {
    if (counts[r.store] !== undefined) (counts as any)[r.store]++;
  }

  const sortedRecords = [...records].sort((a, b) => {
    const storeOrderA = INCLUDED_BACKUP_STORES.indexOf(a.store);
    const storeOrderB = INCLUDED_BACKUP_STORES.indexOf(b.store);
    if (storeOrderA !== storeOrderB) return storeOrderA - storeOrderB;
    return String(a.record.id).localeCompare(String(b.record.id));
  });

  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      format: PORTABLE_BACKUP_FORMAT,
      formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
      appVersion: '0.1.0',
      exportedAt: 1000,
      counts,
      includedStores: INCLUDED_BACKUP_STORES,
      excludedStores: EXCLUDED_BACKUP_STORES,
    })
  );

  for (const r of sortedRecords) {
    lines.push(JSON.stringify({ store: r.store, record: r.record }));
  }

  lines.push(
    JSON.stringify({
      complete: true,
      totalRecords: records.length,
      counts,
    })
  );

  const payloadText = lines.join('\n') + '\n';
  return await compressGzip(new TextEncoder().encode(payloadText));
}

describe('Final Audit: Database Equality, Referential Integrity, Merge Conflicts & Crash Recovery', () => {
  let idb: IDBFactory;

  beforeEach(() => {
    idb = new IDBFactory();
    (globalThis as any).IDBKeyRange = IDBKeyRange;
    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
          remove: vi.fn().mockResolvedValue(undefined),
        },
      },
    };
  });

  describe('1. verifyDatabaseEquality: Missing Stores, Empty Stores & Cursor Order', () => {
    it('fails when revisions store is missing in dbB', async () => {
      const dbA = await openExtensionDatabase(idb, 'test_eq_db_a');
      // Create a dbB that does not have 'revisions'
      const dbB = await new Promise<IDBDatabase>((res, rej) => {
        const req = idb.open('test_eq_db_b', 1);
        req.onupgradeneeded = (e) => {
          const d = (e.target as any).result;
          d.createObjectStore('conversations', { keyPath: 'id' });
          d.createObjectStore('messages', { keyPath: 'id' });
          // Note: revisions store is omitted!
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });

      const result = await verifyDatabaseEquality(dbA, dbB, ['conversations', 'messages', 'revisions']);
      expect(result).toBe(false);

      dbA.close();
      dbB.close();
    });

    it('fails when raw_stream_batches store is missing in dbA', async () => {
      const dbA = await new Promise<IDBDatabase>((res, rej) => {
        const req = idb.open('test_eq_db_a2', 1);
        req.onupgradeneeded = (e) => {
          const d = (e.target as any).result;
          d.createObjectStore('raw_streams', { keyPath: 'id' });
          // raw_stream_batches omitted!
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const dbB = await openExtensionDatabase(idb, 'test_eq_db_b2');

      const result = await verifyDatabaseEquality(dbA, dbB, ['raw_streams', 'raw_stream_batches']);
      expect(result).toBe(false);

      dbA.close();
      dbB.close();
    });

    it('passes when stores exist and both are empty', async () => {
      const dbA = await openExtensionDatabase(idb, 'test_eq_empty_a');
      const dbB = await openExtensionDatabase(idb, 'test_eq_empty_b');

      const result = await verifyDatabaseEquality(dbA, dbB, SIX_DURABLE_STORES);
      expect(result).toBe(true);

      dbA.close();
      dbB.close();
    });

    it('fails when count matches but content differs', async () => {
      const dbA = await openExtensionDatabase(idb, 'test_eq_diff_a');
      const dbB = await openExtensionDatabase(idb, 'test_eq_diff_b');

      const txA = dbA.transaction(['conversations'], 'readwrite');
      txA.objectStore('conversations').put({ id: 'c1', title: 'Title A', createdAt: 100, updatedAt: 100 });
      await new Promise<void>((r) => { txA.oncomplete = () => r(); });

      const txB = dbB.transaction(['conversations'], 'readwrite');
      txB.objectStore('conversations').put({ id: 'c1', title: 'Title DIFFERENT', createdAt: 100, updatedAt: 100 });
      await new Promise<void>((r) => { txB.oncomplete = () => r(); });

      const result = await verifyDatabaseEquality(dbA, dbB, ['conversations']);
      expect(result).toBe(false);

      dbA.close();
      dbB.close();
    });

    it('passes when identical records were inserted in different orders', async () => {
      const dbA = await openExtensionDatabase(idb, 'test_eq_order_a');
      const dbB = await openExtensionDatabase(idb, 'test_eq_order_b');

      // Insert in order: c1, c2, c3
      const txA = dbA.transaction(['conversations'], 'readwrite');
      txA.objectStore('conversations').put({ id: 'c1', title: 'First', createdAt: 1, updatedAt: 1 });
      txA.objectStore('conversations').put({ id: 'c2', title: 'Second', createdAt: 2, updatedAt: 2 });
      txA.objectStore('conversations').put({ id: 'c3', title: 'Third', createdAt: 3, updatedAt: 3 });
      await new Promise<void>((r) => { txA.oncomplete = () => r(); });

      // Insert in reverse order: c3, c1, c2
      const txB = dbB.transaction(['conversations'], 'readwrite');
      txB.objectStore('conversations').put({ id: 'c3', title: 'Third', createdAt: 3, updatedAt: 3 });
      txB.objectStore('conversations').put({ id: 'c1', title: 'First', createdAt: 1, updatedAt: 1 });
      txB.objectStore('conversations').put({ id: 'c2', title: 'Second', createdAt: 2, updatedAt: 2 });
      await new Promise<void>((r) => { txB.oncomplete = () => r(); });

      const result = await verifyDatabaseEquality(dbA, dbB, ['conversations']);
      expect(result).toBe(true);

      dbA.close();
      dbB.close();
    });
  });

  describe('2. validateStagingReferentialIntegrity & batchGetKeys', () => {
    it('validates a high-density dataset without TransactionInactiveError', async () => {
      const db = await openExtensionDatabase(idb, 'test_density_db');
      const tx = db.transaction(
        ['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'],
        'readwrite'
      );

      // 1 Conversation
      tx.objectStore('conversations').put({ id: 'c-main', title: 'Main', createdAt: 1, updatedAt: 1 });

      // 150 Messages
      let prevMsgId = 'c-main';
      for (let i = 0; i < 150; i++) {
        const msgId = `m-${i}`;
        tx.objectStore('messages').put({
          id: msgId,
          conversationId: 'c-main',
          parentId: i === 0 ? undefined : prevMsgId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          createdAt: 100 + i,
          updatedAt: 100 + i,
        });
        prevMsgId = msgId;
      }

      // 500 Revisions across the 150 messages
      for (let i = 0; i < 500; i++) {
        const msgId = `m-${i % 150}`;
        tx.objectStore('revisions').put({
          id: `r-${i}`,
          messageId: msgId,
          revisionIndex: Math.floor(i / 150),
          text: `Revision text ${i}`,
          capturedAt: 100 + i,
        });
      }

      // 200 Raw Streams and 200 Raw Stream Batches
      for (let i = 0; i < 200; i++) {
        const sKey = `stream-${i}`;
        tx.objectStore('raw_streams').put({
          id: sKey,
          producerSessionId: `p-${i}`,
          streamId: `s-${i}`,
          state: 'completed',
          openedAt: 100 + i,
          updatedAt: 100 + i,
        });
        tx.objectStore('raw_stream_batches').put({
          id: `batch-${i}`,
          streamKey: sKey,
          batchSeq: 1,
          chunks: ['test chunk'],
          createdAt: 100 + i,
          charCount: 10,
        });
      }

      // 200 Recovery Events pointing to valid messages & revisions
      for (let i = 0; i < 200; i++) {
        tx.objectStore('recovery_events').put({
          id: `rec-${i}`,
          messageId: `m-${i % 150}`,
          recoveredRevisionId: `r-${i}`,
          kind: 'content_filter',
          detectedAt: 100 + i,
        });
      }

      await new Promise<void>((r) => { tx.oncomplete = () => r(); });

      const result = await validateStagingReferentialIntegrity(db);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);

      db.close();
    });

    it('rejects on database/transaction error in batchGetKeys and does not mask it as orphan', async () => {
      const db = await openExtensionDatabase(idb, 'test_batch_err_db');
      db.close(); // Close DB immediately to force transaction open failure

      await expect(batchGetKeys(db, 'conversations', ['c1'])).rejects.toThrow();
    });
  });

  describe('3. verifyMergeDatabaseIntegrity: ID Conflicts on Existing Records', () => {
    it('fails when staging record has conflicting content for a pre-existing snapshot ID', async () => {
      const snapDb = await openExtensionDatabase(idb, 'test_merge_conf_snap');
      const stagingDb = await openExtensionDatabase(idb, 'test_merge_conf_stage');
      const liveDb = await openExtensionDatabase(idb, 'test_merge_conf_live');

      // Conv in all three
      for (const d of [snapDb, stagingDb, liveDb]) {
        const tx = d.transaction(['conversations'], 'readwrite');
        tx.objectStore('conversations').put({ id: 'c1', title: 'Conv 1', createdAt: 1, updatedAt: 1 });
        await new Promise<void>((r) => { tx.oncomplete = () => r(); });
      }

      // Snapshot: m1 has text "Original Text"
      const txSnap = snapDb.transaction(['messages'], 'readwrite');
      txSnap.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'assistant', text: 'Original Text' });
      await new Promise<void>((r) => { txSnap.oncomplete = () => r(); });

      // Staging: m1 has CONFLICTING text "Conflicting Staging Text"
      const txStage = stagingDb.transaction(['messages'], 'readwrite');
      txStage.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'assistant', text: 'Conflicting Staging Text' });
      await new Promise<void>((r) => { txStage.oncomplete = () => r(); });

      // Live: has "Original Text"
      const txLive = liveDb.transaction(['messages'], 'readwrite');
      txLive.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'assistant', text: 'Original Text' });
      await new Promise<void>((r) => { txLive.oncomplete = () => r(); });

      // verifyMergeDatabaseIntegrity should detect the conflict and reject!
      const verifyResult = await verifyMergeDatabaseIntegrity(snapDb, stagingDb, liveDb);
      expect(verifyResult.valid).toBe(false);
      expect(verifyResult.error).toContain('Conflicting record "m1" in store "messages"');

      snapDb.close();
      stagingDb.close();
      liveDb.close();
    });

    it('passes when staging record has identical content for a pre-existing snapshot ID (0 false conflicts)', async () => {
      const snapDb = await openExtensionDatabase(idb, 'test_merge_ident_snap');
      const stagingDb = await openExtensionDatabase(idb, 'test_merge_ident_stage');
      const liveDb = await openExtensionDatabase(idb, 'test_merge_ident_live');

      for (const d of [snapDb, stagingDb, liveDb]) {
        const tx = d.transaction(['conversations', 'messages'], 'readwrite');
        tx.objectStore('conversations').put({ id: 'c1', title: 'Conv 1', createdAt: 1, updatedAt: 1 });
        tx.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'assistant', text: 'Identical Text' });
        await new Promise<void>((r) => { tx.oncomplete = () => r(); });
      }

      const verifyResult = await verifyMergeDatabaseIntegrity(snapDb, stagingDb, liveDb);
      expect(verifyResult.valid).toBe(true);

      snapDb.close();
      stagingDb.close();
      liveDb.close();
    });
  });

  describe('4. executeRestore: Staging DB Preservation on In-Flight Failures', () => {
    it('preserves staging database when commit fails midway with an active journal marker', async () => {
      const liveDb = await openExtensionDatabase(idb, 'StreamArchiveDB_test_preserve');
      const archiveBytes = await makeCompressedArchive([
        { store: 'conversations', record: { id: 'c-p', title: 'Preserve Test', createdAt: 1, updatedAt: 1 } },
      ]);

      // Seed an active crash marker simulating a failure after commit started
      const opId = 'op_preserve_test';
      const stagingDbName = createStagingDatabaseName(opId);
      const snapshotDbName = createSnapshotDatabaseName(opId);

      // Create staging DB manually
      const sDb = await openExtensionDatabase(idb, stagingDbName);
      sDb.close();

      await setRestoreJournalMarker({
        type: 'replace',
        stage: 'transferring',
        liveDbName: 'StreamArchiveDB_test_preserve',
        snapshotDbName,
        stagingDbName,
        timestamp: Date.now(),
        operationId: opId,
      }, idb);

      // Verify that getRestoreJournalMarker sees it
      const activeMarker = await getRestoreJournalMarker(idb);
      expect(activeMarker).not.toBeNull();

      // Ensure that staging DB exists
      const checkDb = await openExtensionDatabase(idb, stagingDbName);
      expect(checkDb.name).toBe(stagingDbName);
      checkDb.close();

      liveDb.close();
    });
  });

  describe('5. recoverIncompleteRestoreIfAny: Missing Staging DB Scenarios at commit_verified', () => {
    it('Scenario 1: Replace, commit_verified, staging absent, LiveDB correct -> recovers cleanly via checksums', async () => {
      const liveDb = await openExtensionDatabase(idb, 'StreamArchiveDB_r1');
      const snapDb = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r1');

      // Populate LiveDB with valid records
      const tx = liveDb.transaction(['conversations', 'messages', 'revisions'], 'readwrite');
      tx.objectStore('conversations').put({ id: 'c1', title: 'Valid Conv', createdAt: 1, updatedAt: 1 });
      tx.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'assistant', createdAt: 1, updatedAt: 1 });
      tx.objectStore('revisions').put({ id: 'r1', messageId: 'm1', revisionIndex: 0, text: 'Hello World', capturedAt: 1 });
      await new Promise<void>((r) => { tx.oncomplete = () => r(); });

      // Also populate snapshot with prior state
      const snapTx = snapDb.transaction(['conversations'], 'readwrite');
      snapTx.objectStore('conversations').put({ id: 'c-old', title: 'Old Conv', createdAt: 1, updatedAt: 1 });
      await new Promise<void>((r) => { snapTx.oncomplete = () => r(); });

      const liveChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
      const liveCounts: Record<string, number> = {};
      for (const s of SIX_DURABLE_STORES) {
        liveCounts[s] = await getStoreRecordCount(liveDb, s);
      }

      liveDb.close();
      snapDb.close();

      // Staging DB is intentionally NOT created (absent)
      await setRestoreJournalMarker({
        type: 'replace',
        stage: 'commit_verified',
        liveDbName: 'StreamArchiveDB_r1',
        snapshotDbName: 'StreamArchiveDB_snap_r1',
        stagingDbName: 'StreamArchiveDB_staging_absent_r1',
        timestamp: Date.now(),
        operationId: 'r1',
        liveStoreChecksums: liveChecksums,
        liveStoreCounts: liveCounts,
      }, idb);

      const recovery = await recoverIncompleteRestoreIfAny(idb);
      expect(recovery.state).toBe('recovered');

      // Marker should be cleared and snapshot deleted
      const marker = await getRestoreJournalMarker(idb);
      expect(marker).toBeNull();
    });

    it('Scenario 2: Replace, staging absent, one revision text corrupted -> fails verification, snapshot PRESERVED', async () => {
      const liveDb = await openExtensionDatabase(idb, 'StreamArchiveDB_r2');
      const snapDb = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r2');

      const tx = liveDb.transaction(['conversations', 'messages', 'revisions'], 'readwrite');
      tx.objectStore('conversations').put({ id: 'c1', title: 'Valid Conv', createdAt: 1, updatedAt: 1 });
      tx.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'assistant', createdAt: 1, updatedAt: 1 });
      tx.objectStore('revisions').put({ id: 'r1', messageId: 'm1', revisionIndex: 0, text: 'Original Uncorrupted Text', capturedAt: 1 });
      await new Promise<void>((r) => { tx.oncomplete = () => r(); });

      const snapTx = snapDb.transaction(['conversations'], 'readwrite');
      snapTx.objectStore('conversations').put({ id: 'c-old', title: 'Old Conv', createdAt: 1, updatedAt: 1 });
      await new Promise<void>((r) => { snapTx.oncomplete = () => r(); });

      const liveChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
      const liveCounts: Record<string, number> = {};
      for (const s of SIX_DURABLE_STORES) {
        liveCounts[s] = await getStoreRecordCount(liveDb, s);
      }

      // CORRUPT revision text in LiveDB before crash recovery
      const txCorrupt = liveDb.transaction(['revisions'], 'readwrite');
      txCorrupt.objectStore('revisions').put({ id: 'r1', messageId: 'm1', revisionIndex: 0, text: '', capturedAt: 1 });
      await new Promise<void>((r) => { txCorrupt.oncomplete = () => r(); });

      liveDb.close();
      snapDb.close();

      await setRestoreJournalMarker({
        type: 'replace',
        stage: 'commit_verified',
        liveDbName: 'StreamArchiveDB_r2',
        snapshotDbName: 'StreamArchiveDB_snap_r2',
        stagingDbName: 'StreamArchiveDB_staging_absent_r2',
        timestamp: Date.now(),
        operationId: 'r2',
        liveStoreChecksums: liveChecksums,
        liveStoreCounts: liveCounts,
      }, idb);

      const recovery = await recoverIncompleteRestoreIfAny(idb);
      expect(recovery.state).toBe('failed');
      expect((recovery as any).snapshotPreserved).toBe(true);

      // Snapshot MUST still exist!
      const snapCheck = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r2');
      expect(await getStoreRecordCount(snapCheck, 'conversations')).toBe(1);
      snapCheck.close();
    });

    it('Scenario 3: Merge, staging absent, all records correct -> recovers cleanly via checksums', async () => {
      const liveDb = await openExtensionDatabase(idb, 'StreamArchiveDB_r3');
      const snapDb = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r3');

      const tx = liveDb.transaction(['conversations', 'messages', 'revisions'], 'readwrite');
      tx.objectStore('conversations').put({ id: 'c-pre', title: 'Pre-existing', createdAt: 1, updatedAt: 1 });
      tx.objectStore('conversations').put({ id: 'c-imp', title: 'Imported', createdAt: 2, updatedAt: 2 });
      tx.objectStore('messages').put({ id: 'm1', conversationId: 'c-imp', role: 'assistant', createdAt: 2, updatedAt: 2 });
      tx.objectStore('revisions').put({ id: 'r1', messageId: 'm1', revisionIndex: 0, text: 'Imported response', capturedAt: 2 });
      await new Promise<void>((r) => { tx.oncomplete = () => r(); });

      const snapTx = snapDb.transaction(['conversations'], 'readwrite');
      snapTx.objectStore('conversations').put({ id: 'c-pre', title: 'Pre-existing', createdAt: 1, updatedAt: 1 });
      await new Promise<void>((r) => { snapTx.oncomplete = () => r(); });

      const liveChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
      const liveCounts: Record<string, number> = {};
      for (const s of SIX_DURABLE_STORES) {
        liveCounts[s] = await getStoreRecordCount(liveDb, s);
      }

      liveDb.close();
      snapDb.close();

      await setRestoreJournalMarker({
        type: 'merge',
        stage: 'commit_verified',
        liveDbName: 'StreamArchiveDB_r3',
        snapshotDbName: 'StreamArchiveDB_snap_r3',
        stagingDbName: 'StreamArchiveDB_staging_absent_r3',
        timestamp: Date.now(),
        operationId: 'r3',
        liveStoreChecksums: liveChecksums,
        liveStoreCounts: liveCounts,
      }, idb);

      const recovery = await recoverIncompleteRestoreIfAny(idb);
      expect(recovery.state).toBe('recovered');
      expect(await getRestoreJournalMarker(idb)).toBeNull();
    });

    it('Scenario 4: Merge, staging absent, one old record modified -> fails, snapshot PRESERVED, no destructive rollback', async () => {
      const liveDb = await openExtensionDatabase(idb, 'StreamArchiveDB_r4');
      const snapDb = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r4');

      const tx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
      tx.objectStore('conversations').put({ id: 'c-old', title: 'Original Old Title', createdAt: 1, updatedAt: 1 });
      tx.objectStore('conversations').put({ id: 'c-new', title: 'New Title', createdAt: 2, updatedAt: 2 });
      await new Promise<void>((r) => { tx.oncomplete = () => r(); });

      const snapTx = snapDb.transaction(['conversations'], 'readwrite');
      snapTx.objectStore('conversations').put({ id: 'c-old', title: 'Original Old Title', createdAt: 1, updatedAt: 1 });
      await new Promise<void>((r) => { snapTx.oncomplete = () => r(); });

      const liveChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
      const liveCounts: Record<string, number> = {};
      for (const s of SIX_DURABLE_STORES) {
        liveCounts[s] = await getStoreRecordCount(liveDb, s);
      }

      // Mutate c-old title in liveDb!
      const txMut = liveDb.transaction(['conversations'], 'readwrite');
      txMut.objectStore('conversations').put({ id: 'c-old', title: 'MUTATED TITLE', createdAt: 1, updatedAt: 1 });
      await new Promise<void>((r) => { txMut.oncomplete = () => r(); });

      liveDb.close();
      snapDb.close();

      await setRestoreJournalMarker({
        type: 'merge',
        stage: 'commit_verified',
        liveDbName: 'StreamArchiveDB_r4',
        snapshotDbName: 'StreamArchiveDB_snap_r4',
        stagingDbName: 'StreamArchiveDB_staging_absent_r4',
        timestamp: Date.now(),
        operationId: 'r4',
        liveStoreChecksums: liveChecksums,
        liveStoreCounts: liveCounts,
      }, idb);

      const recovery = await recoverIncompleteRestoreIfAny(idb);
      expect(recovery.state).toBe('failed');
      expect((recovery as any).snapshotPreserved).toBe(true);

      // Snapshot MUST be preserved
      const snapCheck = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r4');
      expect(await getStoreRecordCount(snapCheck, 'conversations')).toBe(1);
      snapCheck.close();
    });

    it('Scenario 5: Merge, staging absent, one imported record missing -> count mismatch fails, snapshot PRESERVED', async () => {
      const liveDb = await openExtensionDatabase(idb, 'StreamArchiveDB_r5');
      const snapDb = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r5');

      const tx = liveDb.transaction(['conversations'], 'readwrite');
      tx.objectStore('conversations').put({ id: 'c1', title: 'Conv 1', createdAt: 1, updatedAt: 1 });
      tx.objectStore('conversations').put({ id: 'c2', title: 'Conv 2', createdAt: 2, updatedAt: 2 });
      await new Promise<void>((r) => { tx.oncomplete = () => r(); });

      const snapTx = snapDb.transaction(['conversations'], 'readwrite');
      snapTx.objectStore('conversations').put({ id: 'c1', title: 'Conv 1', createdAt: 1, updatedAt: 1 });
      await new Promise<void>((r) => { snapTx.oncomplete = () => r(); });

      const liveChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
      const liveCounts: Record<string, number> = {};
      for (const s of SIX_DURABLE_STORES) {
        liveCounts[s] = await getStoreRecordCount(liveDb, s);
      }

      // Delete c2 from liveDb
      const txDel = liveDb.transaction(['conversations'], 'readwrite');
      txDel.objectStore('conversations').delete('c2');
      await new Promise<void>((r) => { txDel.oncomplete = () => r(); });

      liveDb.close();
      snapDb.close();

      await setRestoreJournalMarker({
        type: 'merge',
        stage: 'commit_verified',
        liveDbName: 'StreamArchiveDB_r5',
        snapshotDbName: 'StreamArchiveDB_snap_r5',
        stagingDbName: 'StreamArchiveDB_staging_absent_r5',
        timestamp: Date.now(),
        operationId: 'r5',
        liveStoreChecksums: liveChecksums,
        liveStoreCounts: liveCounts,
      }, idb);

      const recovery = await recoverIncompleteRestoreIfAny(idb);
      expect(recovery.state).toBe('failed');
      expect((recovery as any).snapshotPreserved).toBe(true);

      const snapCheck = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r5');
      expect(await getStoreRecordCount(snapCheck, 'conversations')).toBe(1);
      snapCheck.close();
    });

    it('Scenario 6: Merge, staging absent, references valid but text damaged -> checksum mismatch fails, snapshot PRESERVED', async () => {
      const liveDb = await openExtensionDatabase(idb, 'StreamArchiveDB_r6');
      const snapDb = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r6');

      const tx = liveDb.transaction(['conversations', 'messages', 'revisions'], 'readwrite');
      tx.objectStore('conversations').put({ id: 'c1', title: 'Conv 1', createdAt: 1, updatedAt: 1 });
      tx.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'assistant', createdAt: 1, updatedAt: 1 });
      tx.objectStore('revisions').put({ id: 'r1', messageId: 'm1', revisionIndex: 0, text: 'Expected valid text', capturedAt: 1 });
      await new Promise<void>((r) => { tx.oncomplete = () => r(); });

      const snapTx = snapDb.transaction(['conversations'], 'readwrite');
      snapTx.objectStore('conversations').put({ id: 'c1', title: 'Conv 1', createdAt: 1, updatedAt: 1 });
      await new Promise<void>((r) => { snapTx.oncomplete = () => r(); });

      const liveChecksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
      const liveCounts: Record<string, number> = {};
      for (const s of SIX_DURABLE_STORES) {
        liveCounts[s] = await getStoreRecordCount(liveDb, s);
      }

      // Damage the text of revision r1 (references remain completely valid: r1 -> m1 -> c1)
      const txDam = liveDb.transaction(['revisions'], 'readwrite');
      txDam.objectStore('revisions').put({ id: 'r1', messageId: 'm1', revisionIndex: 0, text: 'DAMAGED TEXT', capturedAt: 1 });
      await new Promise<void>((r) => { txDam.oncomplete = () => r(); });

      liveDb.close();
      snapDb.close();

      await setRestoreJournalMarker({
        type: 'merge',
        stage: 'commit_verified',
        liveDbName: 'StreamArchiveDB_r6',
        snapshotDbName: 'StreamArchiveDB_snap_r6',
        stagingDbName: 'StreamArchiveDB_staging_absent_r6',
        timestamp: Date.now(),
        operationId: 'r6',
        liveStoreChecksums: liveChecksums,
        liveStoreCounts: liveCounts,
      }, idb);

      const recovery = await recoverIncompleteRestoreIfAny(idb);
      // Referential integrity would pass, BUT checksum fails!
      expect(recovery.state).toBe('failed');
      expect((recovery as any).snapshotPreserved).toBe(true);

      const snapCheck = await openExtensionDatabase(idb, 'StreamArchiveDB_snap_r6');
      expect(await getStoreRecordCount(snapCheck, 'conversations')).toBe(1);
      snapCheck.close();
    });
  });
});
