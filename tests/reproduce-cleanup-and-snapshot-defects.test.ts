import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
(globalThis as any).IDBKeyRange = IDBKeyRange;

import {
  openExistingSnapshotWithoutCreating,
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  recoverIncompleteRestoreIfAny,
  setRestoreJournalMarker,
  getRestoreJournalMarker,
  verifyDatabaseEquality,
  createSnapshotDatabaseName,
  createStagingDatabaseName,
  SIX_DURABLE_STORES,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';
import type { PortableBackupStoreCounts } from '../src/backup/format';

describe('Audit Defect Reproductions: Cleanup Rollback & Snapshot Destruction', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
  });

  it('REPRODUCTION Defect 2 (Test A): VersionError must not trigger deleteDatabase of existing snapshot', async () => {
    const snapName = 'test_snapshot_v10';
    // 1. Create a database with version 10 (higher than DB_VERSION = 9)
    const initDb = await new Promise<IDBDatabase>((res, rej) => {
      const req = fakeFactory.open(snapName, 10);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        db.createObjectStore('conversations', { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });

    const tx = initDb.transaction('conversations', 'readwrite');
    tx.objectStore('conversations').put({ id: 'c-preserve-me', title: 'Must Survive' });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    initDb.close();

    // 2. Track calls to deleteDatabase
    let deleteDatabaseCalled = false;
    const origDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = (name: string) => {
      if (name === snapName) {
        deleteDatabaseCalled = true;
      }
      return origDelete(name);
    };

    // 3. Attempt to open existing snapshot (which has version 10)
    const result = await openExistingSnapshotWithoutCreating(fakeFactory, snapName);
    expect(result).toBeNull();

    // In commit 7582743, deleteDatabase was called and destroyed the snapshot!
    expect(deleteDatabaseCalled).toBe(false);

    // 4. Verify snapshot was NOT deleted and control record is intact
    const verifyDb = await new Promise<IDBDatabase>((res, rej) => {
      const req = fakeFactory.open(snapName, 10);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const checkTx = verifyDb.transaction('conversations', 'readonly');
    const rec = await new Promise<any>((res) => {
      const req = checkTx.objectStore('conversations').get('c-preserve-me');
      req.onsuccess = () => res(req.result);
    });
    verifyDb.close();
    expect(rec?.title).toBe('Must Survive');
  });

  it('REPRODUCTION Defect 1 (Test 1): Staging deletion error must NOT wipe liveDb after verified commit', async () => {
    const liveName = 'test_live_cleanup_fail';
    const stagingName = 'StreamArchiveDB_restore_staging_fail_test';
    const snapshotName = 'StreamArchiveDB_pre_restore_snapshot_fail_test';

    // 1. Setup liveDb with initial data
    const liveDb = await openExtensionDatabase(fakeFactory, liveName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-old', title: 'Old Chat' });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

    // 2. Setup stagingDb with new data
    const stagingDb = await openExtensionDatabase(fakeFactory, stagingName);
    const sTx = stagingDb.transaction(['conversations', 'messages'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-new', title: 'New Restored Chat' });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

    // 3. Mock deleteDatabase: snapshotDb deletion succeeds, stagingDb deletion throws
    const origDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = (name: string) => {
      if (name === stagingName) {
        const req = {} as any;
        setTimeout(() => {
          if (req.onerror) req.onerror(new Event('error'));
        }, 0);
        throw new Error('Disk locked: cannot delete staging database');
      }
      return origDelete(name);
    };

    const counts: PortableBackupStoreCounts = {
      conversations: 1,
      messages: 0,
      revisions: 0,
      recovery_events: 0,
      raw_streams: 0,
      raw_stream_batches: 0,
    };

    // 4. Run commitStagingReplaceToLive
    try {
      await commitStagingReplaceToLive(liveDb, stagingDb, counts, fakeFactory, snapshotName);
    } catch (err) {
      // It might throw or return result, but liveDb MUST NOT be cleared!
    }

    // 5. Check liveDb content!
    const verifyTx = liveDb.transaction(['conversations'], 'readonly');
    const newChat = await new Promise<any>((res) => {
      const req = verifyTx.objectStore('conversations').get('c-new');
      req.onsuccess = () => res(req.result);
    });

    const allChats = await new Promise<any[]>((res) => {
      const req = verifyTx.objectStore('conversations').getAll();
      req.onsuccess = () => res(req.result);
    });

    expect(allChats.length).toBeGreaterThan(0);
    expect(newChat?.title).toBe('New Restored Chat');
  });
});
