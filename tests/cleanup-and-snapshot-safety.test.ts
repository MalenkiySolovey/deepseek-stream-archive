import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
(globalThis as any).IDBKeyRange = IDBKeyRange;

import {
  openExistingSnapshotDetailed,
  openExistingSnapshotWithoutCreating,
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  recoverIncompleteRestoreIfAny,
  setRestoreJournalMarker,
  getRestoreJournalMarker,
  verifyDatabaseEquality,
  computeDatabaseStoreChecksums,
  cleanupStaleTemporaryDatabases,
  SIX_DURABLE_STORES,
  EIGHT_SNAPSHOT_STORES,
  RESTORE_STAGING_DB_NAME,
  RESTORE_SNAPSHOT_DB_NAME,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';
import type { PortableBackupStoreCounts } from '../src/backup/format';
import type { RestorePlan } from '../src/restore/types';

describe('Audit: Cleanup Rollback Guard & Snapshot Protection (Tests 1-5 & Tests A-D)', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
  });

  // ─────────────────────────────────────────────────────────────
  // Section 1: Cleanup Error Must Never Trigger Destructive Rollback
  // ─────────────────────────────────────────────────────────────

  it('TEST 1: Replace — error deleting stagingDb after snapshot deletion must NOT clear liveDb', async () => {
    const liveName = 'test_live_cleanup_staging_fail';
    const stagingName = `${RESTORE_STAGING_DB_NAME}_test1`;
    const snapshotName = `${RESTORE_SNAPSHOT_DB_NAME}_test1`;

    const liveDb = await openExtensionDatabase(fakeFactory, liveName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-old', title: 'Old Original Chat' });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

    const stagingDb = await openExtensionDatabase(fakeFactory, stagingName);
    const sTx = stagingDb.transaction(['conversations', 'messages', 'revisions'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-new', title: 'Restored New Chat' });
    sTx.objectStore('messages').put({ id: 'm-new', conversationId: 'c-new', role: 'assistant', status: 'finished' });
    sTx.objectStore('revisions').put({ id: 'r-new', messageId: 'm-new', text: 'Restored answer', isFinal: true, isLastGood: true });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

    // Mock deleteDatabase to fail only for stagingDb
    const origDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = (name: string) => {
      if (name === stagingName) {
        throw new Error('EACCES: Staging database file locked');
      }
      return origDelete(name);
    };

    const counts: PortableBackupStoreCounts = {
      conversations: 1,
      messages: 1,
      revisions: 1,
      recovery_events: 0,
      raw_streams: 0,
      raw_stream_batches: 0,
    };

    const result = await commitStagingReplaceToLive(liveDb, stagingDb, counts, fakeFactory, snapshotName);
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.cleanupWarning).toContain('EACCES');

    // Verify liveDb contains restored data and was NOT wiped!
    const vTx = liveDb.transaction(['conversations', 'messages', 'revisions'], 'readonly');
    const conv = await new Promise<any>((res) => {
      const req = vTx.objectStore('conversations').get('c-new');
      req.onsuccess = () => res(req.result);
    });
    const rev = await new Promise<any>((res) => {
      const req = vTx.objectStore('revisions').get('r-new');
      req.onsuccess = () => res(req.result);
    });

    expect(conv?.title).toBe('Restored New Chat');
    expect(rev?.text).toBe('Restored answer');
  });

  it('TEST 2: Replace — error deleting snapshotDb must NOT clear liveDb', async () => {
    const liveName = 'test_live_cleanup_snapshot_fail';
    const stagingName = `${RESTORE_STAGING_DB_NAME}_test2`;
    const snapshotName = `${RESTORE_SNAPSHOT_DB_NAME}_test2`;

    const liveDb = await openExtensionDatabase(fakeFactory, liveName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-pre', title: 'Pre-existing Chat' });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

    const stagingDb = await openExtensionDatabase(fakeFactory, stagingName);
    const sTx = stagingDb.transaction(['conversations', 'messages', 'revisions'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-post', title: 'Post-restore Chat' });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

    // Mock deleteDatabase to fail for snapshotDb only during cleanup (after initial creation)
    let snapshotOpenCount = 0;
    const origDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = (name: string) => {
      if (name === snapshotName && snapshotOpenCount > 0) {
        throw new Error('EBUSY: Snapshot database locked');
      }
      return origDelete(name);
    };

    // Track when snapshot is created/opened so we only fail on cleanup
    const origOpen = fakeFactory.open.bind(fakeFactory);
    fakeFactory.open = ((name: string, version?: number) => {
      if (name === snapshotName) snapshotOpenCount++;
      return origOpen(name, version);
    }) as any;

    const counts: PortableBackupStoreCounts = {
      conversations: 1,
      messages: 0,
      revisions: 0,
      recovery_events: 0,
      raw_streams: 0,
      raw_stream_batches: 0,
    };

    const result = await commitStagingReplaceToLive(liveDb, stagingDb, counts, fakeFactory, snapshotName);
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.cleanupWarning).toContain('EBUSY');

    // Verify liveDb contains restored data
    const vTx = liveDb.transaction('conversations', 'readonly');
    const conv = await new Promise<any>((res) => {
      const req = vTx.objectStore('conversations').get('c-post');
      req.onsuccess = () => res(req.result);
    });
    expect(conv?.title).toBe('Post-restore Chat');
  });

  it('TEST 3: Merge — error during Cleanup preserves both pre-existing and imported records', async () => {
    const liveName = 'test_live_merge_cleanup_fail';
    const stagingName = `${RESTORE_STAGING_DB_NAME}_test3`;
    const snapshotName = `${RESTORE_SNAPSHOT_DB_NAME}_test3`;

    const liveDb = await openExtensionDatabase(fakeFactory, liveName);
    const lTx = liveDb.transaction(['conversations', 'messages', 'revisions'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-local', title: 'Local Chat' });
    lTx.objectStore('messages').put({ id: 'm-local', conversationId: 'c-local', role: 'assistant', status: 'finished' });
    lTx.objectStore('revisions').put({ id: 'r-local', messageId: 'm-local', text: 'Local answer text', isFinal: true });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

    const stagingDb = await openExtensionDatabase(fakeFactory, stagingName);
    const sTx = stagingDb.transaction(['conversations', 'messages', 'revisions'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-imported', title: 'Imported Chat' });
    sTx.objectStore('messages').put({ id: 'm-imported', conversationId: 'c-imported', role: 'assistant', status: 'finished' });
    sTx.objectStore('revisions').put({ id: 'r-imported', messageId: 'm-imported', text: 'Imported answer text', isFinal: true });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

    // Mock deleteDatabase to fail when deleting stagingDb
    const origDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = (name: string) => {
      if (name === stagingName) {
        throw new Error('EPERM: Permission denied removing staging');
      }
      return origDelete(name);
    };

    const plan: RestorePlan = {
      mode: 'merge',
      valid: true,
      toInsert: {
        conversations: [{ id: 'c-imported', title: 'Imported Chat', createdAt: 1000, updatedAt: 1000 }],
        messages: [{ id: 'm-imported', conversationId: 'c-imported', role: 'assistant', status: 'finished', identityState: 'reconciled', createdAt: 1000, updatedAt: 1000 }],
        revisions: [{ id: 'r-imported', messageId: 'm-imported', revisionIndex: 0, text: 'Imported answer text', source: 'network', capturedAt: 1000, isFinal: true, isLastGood: true }],
        recovery_events: [],
        raw_streams: [],
        raw_stream_batches: [],
      },
      toInsertCounts: {
        conversations: 1,
        messages: 1,
        revisions: 1,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      toSkip: {
        conversations: 0,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      conflicts: [],
    };

    const result = await commitStagingMergeToLive(liveDb, plan, fakeFactory, stagingDb, snapshotName);
    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.cleanupWarning).toContain('EPERM');

    // Verify both local and imported records are fully intact with texts
    const vTx = liveDb.transaction(['conversations', 'revisions'], 'readonly');
    const localConv = await new Promise<any>((res) => {
      const req = vTx.objectStore('conversations').get('c-local');
      req.onsuccess = () => res(req.result);
    });
    const importedConv = await new Promise<any>((res) => {
      const req = vTx.objectStore('conversations').get('c-imported');
      req.onsuccess = () => res(req.result);
    });
    const localRev = await new Promise<any>((res) => {
      const req = vTx.objectStore('revisions').get('r-local');
      req.onsuccess = () => res(req.result);
    });
    const importedRev = await new Promise<any>((res) => {
      const req = vTx.objectStore('revisions').get('r-imported');
      req.onsuccess = () => res(req.result);
    });

    expect(localConv?.title).toBe('Local Chat');
    expect(importedConv?.title).toBe('Imported Chat');
    expect(localRev?.text).toBe('Local answer text');
    expect(importedRev?.text).toBe('Imported answer text');
  });

  it('TEST 4: Crash after journal deletion — liveDb remains intact, no destructive rollback', async () => {
    const liveName = 'test_live_crash_post_journal';
    const liveDb = await openExtensionDatabase(fakeFactory, liveName);
    const lTx = liveDb.transaction('conversations', 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-intact', title: 'Confirmed Live Chat' });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });
    liveDb.close();

    // Journal was deleted at completion of restore before crash
    await setRestoreJournalMarker(null, fakeFactory);

    // Some residual temp databases exist on disk
    const staleSnapshot = await openExtensionDatabase(fakeFactory, `${RESTORE_SNAPSHOT_DB_NAME}_orphan`);
    staleSnapshot.close();

    const status = await recoverIncompleteRestoreIfAny(fakeFactory);
    expect(status.state).toBe('not_required');

    // LiveDb was NOT modified or rolled back!
    const vDb = await openExtensionDatabase(fakeFactory, liveName);
    const conv = await new Promise<any>((res) => {
      const tx = vDb.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').get('c-intact');
      req.onsuccess = () => res(req.result);
    });
    vDb.close();
    expect(conv?.title).toBe('Confirmed Live Chat');
  });

  it('TEST 5: Crash between snapshot deletion and staging deletion — recovers cleanly without error', async () => {
    const liveName = 'test_live_crash_mid_cleanup';
    const stagingName = `${RESTORE_STAGING_DB_NAME}_test5`;
    const snapshotName = `${RESTORE_SNAPSHOT_DB_NAME}_test5`;

    // 1. LiveDb has restored data
    const liveDb = await openExtensionDatabase(fakeFactory, liveName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-target', title: 'Verified Restored Target' });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });
    const checksums = await computeDatabaseStoreChecksums(liveDb, SIX_DURABLE_STORES);
    liveDb.close();

    // 2. Snapshot was ALREADY deleted during cleanup before process was killed
    // (snapshotName does NOT exist)

    // 3. Staging still exists
    const stagingDb = await openExtensionDatabase(fakeFactory, stagingName);
    const sTx = stagingDb.transaction(['conversations', 'messages'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-target', title: 'Verified Restored Target' });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });
    stagingDb.close();

    // 4. Marker is at cleanup_pending
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName: liveName,
      snapshotDbName: snapshotName,
      stagingDbName: stagingName,
      timestamp: Date.now() - 1000,
      operationId: 'op-mid-cleanup',
      liveStoreChecksums: checksums,
      liveStoreCounts: { conversations: 1, messages: 0, revisions: 0, recovery_events: 0, raw_streams: 0, raw_stream_batches: 0 },
    }, fakeFactory);

    // 5. Run recovery
    const status = await recoverIncompleteRestoreIfAny(fakeFactory);
    expect(status.state).toBe('recovered');

    // 6. LiveDb is untouched and confirmed
    const vDb = await openExtensionDatabase(fakeFactory, liveName);
    const conv = await new Promise<any>((res) => {
      const tx = vDb.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').get('c-target');
      req.onsuccess = () => res(req.result);
    });
    vDb.close();
    expect(conv?.title).toBe('Verified Restored Target');

    // Journal was cleaned up
    const markerAfter = await getRestoreJournalMarker(fakeFactory);
    expect(markerAfter).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────
  // Section 2: Snapshot Protection on Open Errors (Tests A-D)
  // ─────────────────────────────────────────────────────────────

  it('TEST A: VersionError — snapshot with newer schema version must NOT be deleted', async () => {
    const snapName = 'test_snapshot_version_10';

    // 1. Create a snapshot DB with version 10 (higher than DB_VERSION = 9)
    const initDb = await new Promise<IDBDatabase>((res, rej) => {
      const req = fakeFactory.open(snapName, 10);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('conversations', { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const tx = initDb.transaction('conversations', 'readwrite');
    tx.objectStore('conversations').put({ id: 'c-v10-control', title: 'Version 10 Critical Data' });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    initDb.close();

    // 2. Track deleteDatabase calls
    let deleteAttempted = false;
    const origDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = (name: string) => {
      if (name === snapName) deleteAttempted = true;
      return origDelete(name);
    };

    // 3. Try to open with default DB_VERSION (9)
    const detailed = await openExistingSnapshotDetailed(fakeFactory, snapName);
    expect(detailed.status.state).toBe('version_incompatible');
    expect(detailed.db).toBeNull();
    expect(deleteAttempted).toBe(false);

    // 4. Verify database still exists and control record is untouched
    const verifyDb = await new Promise<IDBDatabase>((res, rej) => {
      const req = fakeFactory.open(snapName, 10);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const vTx = verifyDb.transaction('conversations', 'readonly');
    const rec = await new Promise<any>((res) => {
      const req = vTx.objectStore('conversations').get('c-v10-control');
      req.onsuccess = () => res(req.result);
    });
    verifyDb.close();
    expect(rec?.title).toBe('Version 10 Critical Data');
  });

  it('TEST B: Transient open error — deleteDatabase is NEVER called', async () => {
    const snapName = 'test_snapshot_transient_err';

    // Create valid snapshot DB
    const initDb = await openExtensionDatabase(fakeFactory, snapName);
    initDb.close();

    let deleteAttempted = false;
    const origDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = (name: string) => {
      if (name === snapName) deleteAttempted = true;
      return origDelete(name);
    };

    // Mock factory.open to simulate transient QuotaExceededError or SecurityError
    const origOpen = fakeFactory.open.bind(fakeFactory);
    fakeFactory.open = ((name: string, version?: number) => {
      if (name === snapName) {
        const req: any = new EventTarget();
        req.readyState = 'pending';
        req.error = new DOMException('Disk quota exceeded', 'QuotaExceededError');
        setTimeout(() => {
          req.readyState = 'done';
          if (req.onerror) req.onerror(new Event('error'));
        }, 0);
        return req;
      }
      return origOpen(name, version);
    }) as any;

    const result = await openExistingSnapshotDetailed(fakeFactory, snapName);
    expect(result.status.state).toBe('read_error');
    expect(result.db).toBeNull();
    expect(deleteAttempted).toBe(false);
  });

  it('TEST C: Non-existent snapshot — does NOT create a dummy database', async () => {
    const nonExistentName = 'test_snap_does_not_exist_xyz';

    let deleteCalls = 0;
    const origDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = (name: string) => {
      if (name === nonExistentName) deleteCalls++;
      return origDelete(name);
    };

    const result = await openExistingSnapshotDetailed(fakeFactory, nonExistentName);
    expect(result.status.state).toBe('not_found');
    expect(result.db).toBeNull();

    // Verify it was not created as an empty database
    if (typeof (fakeFactory as any).databases === 'function') {
      const dbs: any[] = await (fakeFactory as any).databases();
      const found = dbs.some((db) => db.name === nonExistentName);
      expect(found).toBe(false);
    }
  });

  it('TEST D: Crash recovery with unopenable snapshot — liveDb is preserved, returns failed with snapshotPreserved: true', async () => {
    const liveName = 'test_live_unopenable_snap';
    const snapName = 'test_snap_version_newer';

    // 1. LiveDb has initial data
    const liveDb = await openExtensionDatabase(fakeFactory, liveName);
    const lTx = liveDb.transaction('conversations', 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-important', title: 'Must Not Be Overwritten' });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });
    liveDb.close();

    // 2. Snapshot was created with version 10 (higher version)
    const initDb = await new Promise<IDBDatabase>((res, rej) => {
      const req = fakeFactory.open(snapName, 10);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('conversations', { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const sTx = initDb.transaction('conversations', 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-snap', title: 'Snapshot Content' });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });
    initDb.close();

    // 3. Marker was at pre-commit stage (commit_started)
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'commit_started',
      liveDbName: liveName,
      snapshotDbName: snapName,
      stagingDbName: 'dummy_staging',
      timestamp: Date.now() - 5000,
      operationId: 'op-unopenable-snap',
    }, fakeFactory);

    // 4. Run recovery
    const recoveryResult = await recoverIncompleteRestoreIfAny(fakeFactory);
    expect(recoveryResult.state).toBe('failed');
    if (recoveryResult.state !== 'failed') throw new Error('Expected recovery to fail');
    expect(recoveryResult.snapshotPreserved).toBe(true);
    expect(recoveryResult.reason).toContain('incompatible version');

    // 5. LiveDb was NOT touched
    const vLive = await openExtensionDatabase(fakeFactory, liveName);
    const conv = await new Promise<any>((res) => {
      const tx = vLive.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').get('c-important');
      req.onsuccess = () => res(req.result);
    });
    vLive.close();
    expect(conv?.title).toBe('Must Not Be Overwritten');

    // 6. Snapshot was NOT deleted
    const verifySnap = await new Promise<IDBDatabase>((res, rej) => {
      const req = fakeFactory.open(snapName, 10);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const checkTx = verifySnap.transaction('conversations', 'readonly');
    const snapConv = await new Promise<any>((res) => {
      const req = checkTx.objectStore('conversations').get('c-snap');
      req.onsuccess = () => res(req.result);
    });
    verifySnap.close();
    expect(snapConv?.title).toBe('Snapshot Content');
  });

  // ─────────────────────────────────────────────────────────────
  // Section 3: Safe Sweeper for Orphaned Temporary Databases
  // ─────────────────────────────────────────────────────────────

  it('TEST Sweeper: cleanupStaleTemporaryDatabases sweeps unreferenced temporary DBs, protects active marker', async () => {
    // 1. Create an active marker referencing active_snap and active_staging
    const activeSnap = `${RESTORE_SNAPSHOT_DB_NAME}_active1`;
    const activeStaging = `${RESTORE_STAGING_DB_NAME}_active1`;
    const orphanSnap = `${RESTORE_SNAPSHOT_DB_NAME}_orphan99`;
    const orphanStaging = `${RESTORE_STAGING_DB_NAME}_orphan99`;

    const d1 = await openExtensionDatabase(fakeFactory, activeSnap); d1.close();
    const d2 = await openExtensionDatabase(fakeFactory, activeStaging); d2.close();
    const d3 = await openExtensionDatabase(fakeFactory, orphanSnap); d3.close();
    const d4 = await openExtensionDatabase(fakeFactory, orphanStaging); d4.close();

    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'commit_started',
      liveDbName: 'live_test',
      snapshotDbName: activeSnap,
      stagingDbName: activeStaging,
      timestamp: Date.now(),
      operationId: 'active-op',
    }, fakeFactory);

    // 2. Run sweeper
    const deleted = await cleanupStaleTemporaryDatabases(fakeFactory);
    expect(deleted).toContain(orphanSnap);
    expect(deleted).toContain(orphanStaging);
    expect(deleted).not.toContain(activeSnap);
    expect(deleted).not.toContain(activeStaging);
  });
});
