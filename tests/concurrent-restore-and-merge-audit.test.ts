// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  ingestArchiveToStaging,
  recoverIncompleteRestoreIfAny,
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  getRestoreJournalMarker,
  setRestoreJournalMarker,
  readAuthoritativeJournalMarkerState,
  getStoreRecordCount,
  verifyMergeDatabaseIntegrity,
  createStagingDatabaseName,
  createSnapshotDatabaseName,
  RESTORE_STAGING_DB_NAME,
  RESTORE_SNAPSHOT_DB_NAME,
  RESTORE_JOURNAL_DB_NAME,
  RESTORE_JOURNAL_STORE_NAME,
  type RestoreJournalMarker,
} from '../src/restore/staging-service';
import { openExtensionDatabase, deleteExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import { executeRestore, validateAndPreflightRestore } from '../src/restore/restore-service';
import {
  isRestoreLocked,
  withSharedStorageLock,
  withExclusiveRestoreLock,
  acquireRestoreLock,
} from '../src/restore/restore-lock';
import type { MaterializedPortableBackup } from '../src/backup/reader';
import { compressGzip } from '../src/backup/compression';
import {
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_FORMAT_VERSION,
  INCLUDED_BACKUP_STORES,
  EXCLUDED_BACKUP_STORES,
  type IncludedBackupStoreName,
} from '../src/backup/format';

/**
 * Creates a valid gzip-compressed archive payload with correct deterministic ordering.
 */
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

  // Sort records deterministically by store order, then by id ascending
  const sortedRecords = [...records].sort((a, b) => {
    const storeOrderA = INCLUDED_BACKUP_STORES.indexOf(a.store);
    const storeOrderB = INCLUDED_BACKUP_STORES.indexOf(b.store);
    if (storeOrderA !== storeOrderB) return storeOrderA - storeOrderB;
    return String(a.record.id).localeCompare(String(b.record.id));
  });

  const manifest = {
    kind: 'manifest',
    format: PORTABLE_BACKUP_FORMAT,
    formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
    createdAt: Date.now(),
    appVersion: '0.1.0',
    sourceDatabase: 'StreamArchiveDB',
    sourceDatabaseVersion: 9,
    encoding: 'utf-8',
    compression: 'gzip',
    includedStores: [...INCLUDED_BACKUP_STORES],
    excludedStores: [...EXCLUDED_BACKUP_STORES],
    privacy: {
      containsConversationContent: true,
      containsReasoning: true,
      containsRecoveredContent: true,
      containsRawNetworkEvidence: true,
    },
    recordCounts: counts,
  };

  const footer = {
    kind: 'footer',
    complete: true,
    counts,
  };

  const lines = [
    JSON.stringify(manifest),
    ...sortedRecords.map((r) => JSON.stringify({ kind: 'record', store: r.store, value: r.record })),
    JSON.stringify(footer),
  ];

  const text = lines.join('\n') + '\n';
  return await compressGzip(new TextEncoder().encode(text));
}

describe('Audit Reproduction Suite: Staging Isolation, Merge Invariants & Authoritative Journal', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    delete (globalThis as any).__FORCE_BROWSER_LOCK_REQUIREMENT;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 1: Staging Preparation Isolation & Concurrent Operations
  // ──────────────────────────────────────────────────────────────────────────
  describe('1. Staging Preparation Isolation', () => {
    it('generates unique staging and snapshot database names', () => {
      const name1 = createStagingDatabaseName();
      const name2 = createStagingDatabaseName();
      expect(name1).not.toBe(name2);
      expect(name1).toContain(RESTORE_STAGING_DB_NAME);

      const snap1 = createSnapshotDatabaseName();
      const snap2 = createSnapshotDatabaseName();
      expect(snap1).not.toBe(snap2);
      expect(snap1).toContain(RESTORE_SNAPSHOT_DB_NAME);
    });

    it('concurrent ingestArchiveToStaging runs use isolated databases and never delete each other', async () => {
      const archiveA = await makeCompressedArchive([
        {
          store: 'conversations',
          record: { id: 'conv-A', title: 'Conversation A', createdAt: 1000, updatedAt: 1000 },
        },
      ]);
      const archiveB = await makeCompressedArchive([
        {
          store: 'conversations',
          record: { id: 'conv-B', title: 'Conversation B', createdAt: 2000, updatedAt: 2000 },
        },
      ]);

      const [resA, resB] = await Promise.all([
        ingestArchiveToStaging(archiveA, fakeFactory),
        ingestArchiveToStaging(archiveB, fakeFactory),
      ]);

      // Databases must have distinct names
      expect(resA.stagingDb.name).not.toBe(resB.stagingDb.name);

      // Verify resA has only conv-A
      const countA = await getStoreRecordCount(resA.stagingDb, 'conversations');
      expect(countA).toBe(1);
      const getA = await new Promise<any>((r) => {
        const tx = resA.stagingDb.transaction('conversations', 'readonly');
        tx.objectStore('conversations').get('conv-A').onsuccess = (e: any) => r(e.target.result);
      });
      expect(getA?.title).toBe('Conversation A');

      // Verify resB has only conv-B
      const countB = await getStoreRecordCount(resB.stagingDb, 'conversations');
      expect(countB).toBe(1);
      const getB = await new Promise<any>((r) => {
        const tx = resB.stagingDb.transaction('conversations', 'readonly');
        tx.objectStore('conversations').get('conv-B').onsuccess = (e: any) => r(e.target.result);
      });
      expect(getB?.title).toBe('Conversation B');

      // Now commit A to liveDbA. Committing A must only delete A's staging database!
      const liveDbA = await openExtensionDatabase(fakeFactory, 'live_db_A');
      await commitStagingReplaceToLive(liveDbA, resA.stagingDb, resA.counts, fakeFactory);

      // ResB's stagingDb must still be open, accessible, and intact!
      const countBAfterACommit = await getStoreRecordCount(resB.stagingDb, 'conversations');
      expect(countBAfterACommit).toBe(1);

      // ResB commits cleanly to liveDbB
      const liveDbB = await openExtensionDatabase(fakeFactory, 'live_db_B');
      const commitBRes = await commitStagingReplaceToLive(liveDbB, resB.stagingDb, resB.counts, fakeFactory);
      expect(commitBRes.success).toBe(true);

      const liveBCount = await getStoreRecordCount(liveDbB, 'conversations');
      expect(liveBCount).toBe(1);
    });

    it('concurrent validateAndPreflightRestore in merge mode use isolated staging and clean up cleanly', async () => {
      const liveDb = await openExtensionDatabase(fakeFactory, 'live_preflight_test');
      const archiveA = await makeCompressedArchive([
        {
          store: 'conversations',
          record: { id: 'conv-pre-A', title: 'Preflight A', createdAt: 1000, updatedAt: 1000 },
        },
      ]);
      const archiveB = await makeCompressedArchive([
        {
          store: 'conversations',
          record: { id: 'conv-pre-B', title: 'Preflight B', createdAt: 2000, updatedAt: 2000 },
        },
      ]);

      const [prefA, prefB] = await Promise.all([
        validateAndPreflightRestore(liveDb, archiveA, 0, 'merge'),
        validateAndPreflightRestore(liveDb, archiveB, 0, 'merge'),
      ]);

      expect(prefA.preflight.canRestore).toBe(true);
      expect(prefB.preflight.canRestore).toBe(true);
      expect(prefA.preflight.backupCounts.conversations).toBe(1);
      expect(prefB.preflight.backupCounts.conversations).toBe(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 2: Crash recovery at commit_verified for Merge
  // ──────────────────────────────────────────────────────────────────────────
  describe('2. Merge Crash Recovery Invariants', () => {
    it('recovers cleanly at commit_verified when liveDb contains pre-existing and imported records', async () => {
      const liveDbName = 'repro_live_merge_crash';
      const snapshotDbName = 'repro_snap_merge_crash';
      const stagingDbName = 'repro_staging_merge_crash';

      const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
      const snapDb = await openExtensionDatabase(fakeFactory, snapshotDbName);
      const stagingDb = await openExtensionDatabase(fakeFactory, stagingDbName);

      const oldConv = { id: 'conv-old', title: 'Pre-existing Conversation', createdAt: 100, updatedAt: 100 };
      const oldMsg = { id: 'msg-old', conversationId: 'conv-old', role: 'user', content: 'hello', createdAt: 100, updatedAt: 100 };

      const newConv = { id: 'conv-new', title: 'Imported Conversation', createdAt: 200, updatedAt: 200 };
      const newMsg = { id: 'msg-new', conversationId: 'conv-new', role: 'assistant', content: 'world', createdAt: 200, updatedAt: 200 };

      // Snapshot has oldConv & oldMsg
      const snapTx = snapDb.transaction(['conversations', 'messages'], 'readwrite');
      snapTx.objectStore('conversations').put(oldConv);
      snapTx.objectStore('messages').put(oldMsg);
      await new Promise<void>((r) => { snapTx.oncomplete = () => r(); });

      // Staging has newConv & newMsg
      const stTx = stagingDb.transaction(['conversations', 'messages'], 'readwrite');
      stTx.objectStore('conversations').put(newConv);
      stTx.objectStore('messages').put(newMsg);
      await new Promise<void>((r) => { stTx.oncomplete = () => r(); });

      // LiveDB after merge successfully has ALL 4 items
      const liveTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
      liveTx.objectStore('conversations').put(oldConv);
      liveTx.objectStore('messages').put(oldMsg);
      liveTx.objectStore('conversations').put(newConv);
      liveTx.objectStore('messages').put(newMsg);
      await new Promise<void>((r) => { liveTx.oncomplete = () => r(); });

      // Marker left by crash at commit_verified
      const marker: RestoreJournalMarker = {
        type: 'merge',
        stage: 'commit_verified',
        liveDbName,
        snapshotDbName,
        stagingDbName,
        timestamp: Date.now(),
        operationId: 'op-merge-test',
        expectedCounts: { conversations: 1, messages: 1, revisions: 0, recovery_events: 0, raw_streams: 0, raw_stream_batches: 0 },
      };
      await setRestoreJournalMarker(marker, fakeFactory);

      // Run recovery
      const recoveryStatus = await recoverIncompleteRestoreIfAny(fakeFactory);

      // Must succeed with 'recovered' (NOT failed!)
      expect(recoveryStatus.state).toBe('recovered');

      // Verify that liveDb retains both old and new data intact
      const convCount = await getStoreRecordCount(liveDb, 'conversations');
      const msgCount = await getStoreRecordCount(liveDb, 'messages');
      expect(convCount).toBe(2);
      expect(msgCount).toBe(2);

      // Journal marker must be cleaned up
      const currentMarker = await getRestoreJournalMarker(fakeFactory);
      expect(currentMarker).toBeNull();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 3: Strict Merge Verification Invariants & Negative Cases
  // ──────────────────────────────────────────────────────────────────────────
  describe('3. Strict Merge Database Integrity Verification', () => {
    it('confirms genuine semantic union of pre-merge snapshot and staging', async () => {
      const snapDb = await openExtensionDatabase(fakeFactory, 'v_snap');
      const stagDb = await openExtensionDatabase(fakeFactory, 'v_stag');
      const liveDb = await openExtensionDatabase(fakeFactory, 'v_live');

      const oldConv = { id: 'c1', title: 'Old Conv', createdAt: 1, updatedAt: 1 };
      const newConv = { id: 'c2', title: 'New Conv', createdAt: 2, updatedAt: 2 };

      // Snapshot has c1
      const sTx = snapDb.transaction('conversations', 'readwrite');
      sTx.objectStore('conversations').put(oldConv);
      await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

      // Staging has c2
      const stTx = stagDb.transaction('conversations', 'readwrite');
      stTx.objectStore('conversations').put(newConv);
      await new Promise<void>((r) => { stTx.oncomplete = () => r(); });

      // Live has c1 and c2
      const lTx = liveDb.transaction('conversations', 'readwrite');
      lTx.objectStore('conversations').put(oldConv);
      lTx.objectStore('conversations').put(newConv);
      await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

      const check = await verifyMergeDatabaseIntegrity(snapDb, stagDb, liveDb, {
        conversations: 1,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      });

      expect(check.valid).toBe(true);
    });

    it('rejects when an imported record was missing from liveDb', async () => {
      const snapDb = await openExtensionDatabase(fakeFactory, 'v_snap_missing');
      const stagDb = await openExtensionDatabase(fakeFactory, 'v_stag_missing');
      const liveDb = await openExtensionDatabase(fakeFactory, 'v_live_missing');

      const newConv = { id: 'c-missing', title: 'Missed Record', createdAt: 2, updatedAt: 2 };
      const stTx = stagDb.transaction('conversations', 'readwrite');
      stTx.objectStore('conversations').put(newConv);
      await new Promise<void>((r) => { stTx.oncomplete = () => r(); });

      // LiveDb is missing c-missing
      const check = await verifyMergeDatabaseIntegrity(snapDb, stagDb, liveDb, {
        conversations: 1,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      });

      expect(check.valid).toBe(false);
      expect(check.error).toContain('count mismatch');
    });

    it('rejects when revision text was mutated during merge', async () => {
      const snapDb = await openExtensionDatabase(fakeFactory, 'v_snap_mut');
      const stagDb = await openExtensionDatabase(fakeFactory, 'v_stag_mut');
      const liveDb = await openExtensionDatabase(fakeFactory, 'v_live_mut');

      const originalRev = {
        id: 'rev-1',
        messageId: 'm1',
        revisionIndex: 1,
        text: 'Original Text',
        source: 'network',
        capturedAt: 1,
        isFinal: true,
      };

      const sTx = snapDb.transaction('revisions', 'readwrite');
      sTx.objectStore('revisions').put(originalRev);
      await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

      // LiveDb has altered text
      const lTx = liveDb.transaction('revisions', 'readwrite');
      lTx.objectStore('revisions').put({ ...originalRev, text: 'Mutated Corrupted Text' });
      await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

      const check = await verifyMergeDatabaseIntegrity(snapDb, stagDb, liveDb, {
        conversations: 0,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      });

      expect(check.valid).toBe(false);
      expect(check.error).toMatch(/mutated|differs|mismatch/i);
    });

    it('rejects when an existing pre-merge record was deleted from liveDb', async () => {
      const snapDb = await openExtensionDatabase(fakeFactory, 'v_snap_del');
      const stagDb = await openExtensionDatabase(fakeFactory, 'v_stag_del');
      const liveDb = await openExtensionDatabase(fakeFactory, 'v_live_del');

      const existingConv = { id: 'c-del', title: 'Will Be Deleted', createdAt: 1, updatedAt: 1 };
      const sTx = snapDb.transaction('conversations', 'readwrite');
      sTx.objectStore('conversations').put(existingConv);
      await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

      // Live has nothing!
      const check = await verifyMergeDatabaseIntegrity(snapDb, stagDb, liveDb);
      expect(check.valid).toBe(false);
    });

    it('rejects when an imported recovery event references an absent revision (referential integrity failure)', async () => {
      const snapDb = await openExtensionDatabase(fakeFactory, 'v_snap_orphan');
      const stagDb = await openExtensionDatabase(fakeFactory, 'v_stag_orphan');
      const liveDb = await openExtensionDatabase(fakeFactory, 'v_live_orphan');

      // Live has conversation and message, but NO revision for rev-orphan
      const lTx = liveDb.transaction(['conversations', 'messages', 'recovery_events'], 'readwrite');
      lTx.objectStore('conversations').put({ id: 'c1', title: 'T', createdAt: 1, updatedAt: 1 });
      lTx.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'assistant', createdAt: 1, updatedAt: 1 });
      lTx.objectStore('recovery_events').put({
        id: 'rec-1',
        messageId: 'm1',
        kind: 'content_filter',
        recoveredRevisionId: 'rev-orphan-missing',
        detectedAt: 1,
      });
      await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

      const stTx = stagDb.transaction(['conversations', 'messages', 'recovery_events'], 'readwrite');
      stTx.objectStore('conversations').put({ id: 'c1', title: 'T', createdAt: 1, updatedAt: 1 });
      stTx.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'assistant', createdAt: 1, updatedAt: 1 });
      stTx.objectStore('recovery_events').put({
        id: 'rec-1',
        messageId: 'm1',
        kind: 'content_filter',
        recoveredRevisionId: 'rev-orphan-missing',
        detectedAt: 1,
      });
      await new Promise<void>((r) => { stTx.oncomplete = () => r(); });

      const check = await verifyMergeDatabaseIntegrity(snapDb, stagDb, liveDb, {
        conversations: 1,
        messages: 1,
        revisions: 0,
        recovery_events: 1,
        raw_streams: 0,
        raw_stream_batches: 0,
      });

      expect(check.valid).toBe(false);
      expect(check.error).toMatch(/relational integrity|referential integrity/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 4: Authoritative Journal State Machine
  // ──────────────────────────────────────────────────────────────────────────
  describe('4. Authoritative Journal State Machine', () => {
    it('returns null and purges stale chrome.storage mirror when IDB journal is empty', async () => {
      const staleMarker = {
        type: 'replace',
        stage: 'completed',
        liveDbName: 'stale_db',
        snapshotDbName: 'stale_snap',
        stagingDbName: 'stale_staging',
        timestamp: 1000,
      };

      const removeMock = vi.fn().mockResolvedValue(undefined);
      (globalThis as any).chrome = {
        storage: {
          local: {
            get: vi.fn().mockResolvedValue({ __streamarchive_restore_marker__: staleMarker }),
            set: vi.fn().mockResolvedValue(undefined),
            remove: removeMock,
          },
        },
      };

      // IDB journal exists but has NO active record
      const req = fakeFactory.open(RESTORE_JOURNAL_DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        (e.target as any).result.createObjectStore(RESTORE_JOURNAL_STORE_NAME, { keyPath: 'id' });
      };
      await new Promise<void>((r) => { req.onsuccess = () => { (req.result as any).close(); r(); }; });

      const markerState = await readAuthoritativeJournalMarkerState(fakeFactory);
      expect(markerState.status).toBe('marker_absent');

      const marker = await getRestoreJournalMarker(fakeFactory);
      expect(marker).toBeNull();
      expect(removeMock).toHaveBeenCalled();
    });

    it('prefers newer stage in authoritative IDB over stale chrome.storage.local mirror', async () => {
      const idbMarker: RestoreJournalMarker = {
        type: 'merge',
        stage: 'commit_verified',
        liveDbName: 'live_test',
        snapshotDbName: 'snap_test',
        stagingDbName: 'staging_test',
        timestamp: 5000,
        operationId: 'op-authoritative',
      };

      const staleMirror = {
        type: 'merge',
        stage: 'preparing_snapshot',
        liveDbName: 'live_test',
        snapshotDbName: 'snap_test',
        stagingDbName: 'staging_test',
        timestamp: 1000,
        operationId: 'op-stale',
      };

      (globalThis as any).chrome = {
        storage: {
          local: {
            get: vi.fn().mockResolvedValue({ __streamarchive_restore_marker__: staleMirror }),
            set: vi.fn().mockResolvedValue(undefined),
            remove: vi.fn().mockResolvedValue(undefined),
          },
        },
      };

      await setRestoreJournalMarker(idbMarker, fakeFactory);

      const activeMarker = await getRestoreJournalMarker(fakeFactory);
      expect(activeMarker).not.toBeNull();
      expect(activeMarker?.stage).toBe('commit_verified');
      expect(activeMarker?.operationId).toBe('op-authoritative');
    });

    it('rejects explicitly when setRestoreJournalMarker(null) fails deletion', async () => {
      // Mock an IDBFactory whose open request fails
      const failingFactory: IDBFactory = {
        open: () => {
          const req: any = {};
          setTimeout(() => {
            req.error = new Error('Disk IO failure while opening journal database');
            if (req.onerror) req.onerror();
          }, 0);
          return req;
        },
      } as any;

      await expect(setRestoreJournalMarker(null, failingFactory)).rejects.toThrow('Disk IO failure');
    });

    it('throws explicit error when reading authoritative journal fails due to IDB failure', async () => {
      const failingFactory: IDBFactory = {
        open: () => {
          const req: any = {};
          setTimeout(() => {
            req.error = new Error('Unreadable journal store');
            if (req.onerror) req.onerror();
          }, 0);
          return req;
        },
      } as any;

      const markerState = await readAuthoritativeJournalMarkerState(failingFactory);
      expect(markerState.status).toBe('read_failed');

      await expect(getRestoreJournalMarker(failingFactory)).rejects.toThrow(/Failed to read authoritative/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 5: getStoreRecordCount Fail-Closed Semantics
  // ──────────────────────────────────────────────────────────────────────────
  describe('5. getStoreRecordCount Invariants', () => {
    it('rejects with explicit error on non-existent store instead of returning 0', async () => {
      const db = await openExtensionDatabase(fakeFactory, 'test_count_fail_db');
      await expect(getStoreRecordCount(db, 'non_existent_store')).rejects.toThrow();
    });

    it('rejects with explicit error if database connection is closed', async () => {
      const db = await openExtensionDatabase(fakeFactory, 'test_count_closed_db');
      db.close();
      await expect(getStoreRecordCount(db, 'conversations')).rejects.toThrow();
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 6: Pre-Materialized executeRestore Protected by Exclusive Web Lock
  // ──────────────────────────────────────────────────────────────────────────
  describe('6. Pre-Materialized Restore Lock Protection', () => {
    it('acquires Exclusive Web Lock during pre-materialized restore execution', async () => {
      const liveDb = await openExtensionDatabase(fakeFactory, 'live_materialized_db');

      const materializedBackup: MaterializedPortableBackup = {
        manifest: {
          kind: 'manifest',
          format: PORTABLE_BACKUP_FORMAT,
          formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
          createdAt: Date.now(),
          appVersion: '0.1.0',
          sourceDatabase: 'StreamArchiveDB',
          sourceDatabaseVersion: 9,
          encoding: 'utf-8',
          compression: 'gzip',
          includedStores: [...INCLUDED_BACKUP_STORES],
          excludedStores: [...EXCLUDED_BACKUP_STORES],
          privacy: {
            containsConversationContent: true,
            containsReasoning: true,
            containsRecoveredContent: true,
            containsRawNetworkEvidence: true,
          },
        },
        footer: {
          kind: 'footer',
          complete: true,
          counts: {
            conversations: 1,
            messages: 0,
            revisions: 0,
            recovery_events: 0,
            raw_streams: 0,
            raw_stream_batches: 0,
          },
        },
        records: {
          conversations: [{ id: 'c-mat-1', title: 'Mat 1', createdAt: 1, updatedAt: 1 }],
          messages: [],
          revisions: [],
          recovery_events: [],
          raw_streams: [],
          raw_stream_batches: [],
        },
      };

      let lockObservedDuringRestore = false;

      // Wrap executeAtomicReplace to inspect lock state during execution
      const replacePromise = executeRestore(liveDb, materializedBackup, 'replace', 0);
      lockObservedDuringRestore = await isRestoreLocked();

      const res = await replacePromise;
      expect(res.success).toBe(true);
      expect(lockObservedDuringRestore).toBe(true);
      // After restore concludes, lock must be released
      expect(await isRestoreLocked()).toBe(false);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // DEFECT 8: Long-Lock Watchdog Boundaries & Network Failure Propagation
  // ──────────────────────────────────────────────────────────────────────────
  describe('8. Long-Lock Watchdog Boundaries & Network Fail-Safe', () => {
    it('keeps Exclusive Lock active across long intervals when watchdog extension is maintained', async () => {
      vi.useFakeTimers();

      let lockReleased = false;
      let midCheck = false;
      const longRestorePromise = withExclusiveRestoreLock('replace', async () => {
        // Simulate a long 300-second restore operation
        for (let second = 0; second < 300; second += 30) {
          vi.advanceTimersByTime(30000); // 30s step
          if (await isRestoreLocked()) {
            midCheck = true;
          }
        }
        return 'completed_300s';
      });

      longRestorePromise.then(() => {
        lockReleased = true;
      });

      await vi.runAllTimersAsync();
      const result = await longRestorePromise;
      expect(result).toBe('completed_300s');
      expect(midCheck).toBe(true);
      expect(lockReleased).toBe(true);
      expect(await isRestoreLocked()).toBe(false);

      vi.useRealTimers();
    });

    it('aborts shared storage request with fail-safe error if exclusive restore lock is held', async () => {
      // Hold exclusive lock
      const lockHandle = await acquireRestoreLock('merge');
      expect(await isRestoreLocked()).toBe(true);

      // DeepSeek network stream batch attempts to acquire shared lock
      // Should fail or timeout without silent loss
      let sharedLockFailed = false;
      try {
        await withSharedStorageLock('deepseek_network_batch', async () => {
          // This must not run while exclusive lock is held
        }, 100); // 100ms timeout
      } catch (err: any) {
        sharedLockFailed = true;
        expect(err.message).toMatch(/timed out/i);
      }

      expect(sharedLockFailed).toBe(true);

      // Release exclusive lock
      await lockHandle.release();
      expect(await isRestoreLocked()).toBe(false);
    });
  });
});
