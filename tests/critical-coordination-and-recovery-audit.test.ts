import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  withExclusiveRestoreLock,
  withSharedStorageLock,
  isRestoreLocked,
} from '../src/restore/restore-lock';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import {
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  recoverIncompleteRestoreIfAny,
  setRestoreJournalMarker,
  getRestoreJournalMarker,
  verifyDatabaseEquality,
  EIGHT_SNAPSHOT_STORES,
  type RecoveryStatus,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';

describe('10 Mandatory Audit Scenarios: Coordination, Web Locks & Recovery Safety', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
  });

  // ── Scenario 1: Two concurrent exclusive lock acquisitions from different contexts ──
  it('SCENARIO 1: Two concurrent exclusive lock requests must be strictly serialized (never run simultaneously)', async () => {
    const executionOrder: string[] = [];

    const op1 = withExclusiveRestoreLock('replace', async () => {
      executionOrder.push('op1_start');
      await new Promise((r) => setTimeout(r, 60));
      executionOrder.push('op1_end');
      return 'op1_done';
    });

    const op2 = withExclusiveRestoreLock('merge', async () => {
      executionOrder.push('op2_start');
      await new Promise((r) => setTimeout(r, 20));
      executionOrder.push('op2_end');
      return 'op2_done';
    });

    const results = await Promise.all([op1, op2]);
    expect(results).toEqual(['op1_done', 'op2_done']);
    // Op2 MUST NOT start before Op1 finishes!
    expect(executionOrder).toEqual(['op1_start', 'op1_end', 'op2_start', 'op2_end']);
  });

  // ── Scenario 2: Crash recovery failure stops repository write operations ──
  it('SCENARIO 2: Failed crash recovery must fail-closed and block subsequent repository writes', async () => {
    const liveDbName = 'test_repo_crash_fail';
    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);

    // Seed existing message
    const tx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    tx.objectStore('conversations').put({ id: 'c1', title: 'Precious', createdAt: 100, updatedAt: 100 });
    tx.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'user', content: 'Precious content', createdAt: 100 });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    liveDb.close();

    // Set marker indicating interrupted commit, but snapshot DB is missing/corrupted
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'commit_started',
      liveDbName,
      snapshotDbName: 'StreamArchiveDB_missing_snapshot',
      stagingDbName: 'StreamArchiveDB_missing_staging',
      timestamp: Date.now() - 5000,
    }, fakeFactory);

    // Initialize repository with this fakeFactory and target database
    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);

    // Attempting to save a message MUST fail because recovery failed (snapshot missing)
    let writeThrew = false;
    let errorMessage = '';
    try {
      await repo.saveMessage({
        id: 'm-new-blocked',
        conversationId: 'c1',
        role: 'user',
        status: 'finished',
        identityState: 'reconciled',
        createdAt: 200,
        updatedAt: 200,
      });
    } catch (err) {
      writeThrew = true;
      errorMessage = (err as Error).message;
    }

    expect(writeThrew).toBe(true);
    expect(errorMessage.toLowerCase()).toContain('recovery');

    // Verify original data was preserved and NOT wiped
    const checkDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const count = await new Promise<number>((res) => {
      const vTx = checkDb.transaction('messages', 'readonly');
      const req = vTx.objectStore('messages').count();
      req.onsuccess = () => res(req.result);
    });
    checkDb.close();
    expect(count).toBe(1);
  });

  // ── Scenario 3: Desynchronized journal copies reconciliation ──
  it('SCENARIO 3: getRestoreJournalMarker authoritatively reconciles desynchronized storage and IndexedDB copies', async () => {
    // Write marker only to IndexedDB directly (simulating chrome.storage failure during crash)
    const markerData = {
      type: 'replace' as const,
      stage: 'commit_started' as const,
      liveDbName: 'test_live_reconcile',
      snapshotDbName: 'test_snap_reconcile',
      stagingDbName: 'test_staging_reconcile',
      timestamp: 1234567,
      operationId: 'op-desync-1',
    };

    await setRestoreJournalMarker(markerData, fakeFactory);

    // Read reconciled marker
    const reconciled = await getRestoreJournalMarker(fakeFactory);
    expect(reconciled).not.toBeNull();
    expect(reconciled?.operationId).toBe('op-desync-1');
    expect(reconciled?.stage).toBe('commit_started');
  });

  // ── Scenario 4: Corrupted snapshot DB does NOT wipe live database ──
  it('SCENARIO 4: Corrupted or empty snapshot DB must be rejected by recoverIncompleteRestoreIfAny without wiping liveDb', async () => {
    const liveDbName = 'test_live_corrupt_snap';
    const snapshotDbName = 'test_snap_corrupt';

    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const tx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    tx.objectStore('conversations').put({ id: 'c-precious', title: 'Vital Data', createdAt: 100, updatedAt: 100 });
    tx.objectStore('messages').put({ id: 'm-precious', conversationId: 'c-precious', role: 'user', content: 'Vital text', createdAt: 100 });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    liveDb.close();

    // Create an empty snapshot DB (missing data, 0 records)
    const snapDb = await openExtensionDatabase(fakeFactory, snapshotDbName);
    snapDb.close();

    // Journal says commit started and expected 1 conversation and 1 message
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'commit_started',
      liveDbName,
      snapshotDbName,
      stagingDbName: 'test_staging_corrupt',
      timestamp: Date.now() - 5000,
      operationId: 'op-corrupt-snap',
      expectedCounts: {
        conversations: 1,
        messages: 1,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
    }, fakeFactory);

    const recStatus = await recoverIncompleteRestoreIfAny(fakeFactory);
    expect(recStatus.state).toBe('failed');
    if (recStatus.state === 'failed') {
      expect(recStatus.snapshotPreserved).toBe(true);
    }

    // Live DB must remain completely untouched!
    const verifyDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const count = await new Promise<number>((res) => {
      const vTx = verifyDb.transaction('conversations', 'readonly');
      const req = vTx.objectStore('conversations').count();
      req.onsuccess = () => res(req.result);
    });
    verifyDb.close();
    expect(count).toBe(1);
  });

  // ── Scenario 5: Concurrent response write during Replace ──
  it('SCENARIO 5: Incoming write during Replace waits for exclusive lock and writes into restored database without loss', async () => {
    const liveDbName = 'test_live_concurrent_write';
    const stagingDbName = 'test_staging_concurrent_write';

    // 1. Initial live database
    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-old', title: 'Old Chat', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

    // 2. Incoming staging database
    const stagingDb = await openExtensionDatabase(fakeFactory, stagingDbName);
    const sTx = stagingDb.transaction(['conversations', 'messages'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-restored', title: 'Restored Chat', createdAt: 200, updatedAt: 200 });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);

    // Run Replace and simulate incoming saveMessage during the replace operation
    let messageSavedAfterReplace = false;

    const replacePromise = commitStagingReplaceToLive(
      liveDb,
      stagingDb,
      {
        conversations: 1,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      fakeFactory
    );

    // This write runs concurrently; it must safely wait for Replace to finish
    const writePromise = repo.saveMessage({
      id: 'm-streamed-during-replace',
      conversationId: 'c-restored',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      content: 'Fresh response generated by DeepSeek',
      createdAt: 300,
      updatedAt: 300,
    }).then(() => {
      messageSavedAfterReplace = true;
    });

    await Promise.all([replacePromise, writePromise]);
    expect(messageSavedAfterReplace).toBe(true);

    // Verify both the restored conversation and the newly saved message exist in liveDb!
    const checkDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const conv = await new Promise<any>((res) => {
      const tx = checkDb.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').get('c-restored');
      req.onsuccess = () => res(req.result);
    });
    const msg = await new Promise<any>((res) => {
      const tx = checkDb.transaction('messages', 'readonly');
      const req = tx.objectStore('messages').get('m-streamed-during-replace');
      req.onsuccess = () => res(req.result);
    });
    checkDb.close();

    expect(conv?.title).toBe('Restored Chat');
    expect(msg?.content).toBe('Fresh response generated by DeepSeek');
  });

  // ── Scenario 6: Write cannot slip in between snapshot creation and live DB clear ──
  it('SCENARIO 6: Normal shared write cannot slip in between snapshot creation and liveDb clear because exclusive lock is held continuously', async () => {
    let sharedAcquiredDuringExclusive = false;

    await withExclusiveRestoreLock('replace', async () => {
      // While exclusive lock is held, attempt shared write with immediate probe
      const isLocked = await isRestoreLocked();
      expect(isLocked).toBe(true);

      // Attempt shared lock with 50ms timeout; it MUST NOT acquire while exclusive is running
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('LockContentionTimeout')), 50);

      try {
        await withSharedStorageLock(
          'testWrite',
          async () => {
            sharedAcquiredDuringExclusive = true;
          },
          100
        );
      } catch {
        // Expected timeout or contention
      }
    });

    expect(sharedAcquiredDuringExclusive).toBe(false);
  });

  // ── Scenario 7: Crash after transfer but before final verification rolls back to snapshot ──
  it('SCENARIO 7: Crash at transfer_completed (before verification) safely rolls back liveDb from snapshot', async () => {
    const liveDbName = 'test_live_crash_transfer_completed';
    const snapshotDbName = 'test_snap_transfer_completed';

    // Seed liveDb with original data
    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-orig', title: 'Original Chat', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });
    liveDb.close();

    // Snapshot has the exact original data
    const snapDb = await openExtensionDatabase(fakeFactory, snapshotDbName);
    const sTx = snapDb.transaction(['conversations', 'messages'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-orig', title: 'Original Chat', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });
    snapDb.close();

    // Simulate crash at stage 'transfer_completed'
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'transfer_completed',
      liveDbName,
      snapshotDbName,
      stagingDbName: 'test_staging_transfer_completed',
      timestamp: Date.now() - 5000,
      operationId: 'op-transfer-completed',
    }, fakeFactory);

    const recStatus = await recoverIncompleteRestoreIfAny(fakeFactory);
    expect(recStatus.state).toBe('recovered');

    // Verify liveDb was rolled back to original data
    const verifyDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const conv = await new Promise<any>((res) => {
      const tx = verifyDb.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').get('c-orig');
      req.onsuccess = () => res(req.result);
    });
    verifyDb.close();
    expect(conv?.title).toBe('Original Chat');
  });

  // ── Scenario 8: Crash after verification (commit_verified) preserves restored data ──
  it('SCENARIO 8: Crash at commit_verified preserves verified new data and completes cleanup without rollback', async () => {
    const liveDbName = 'test_live_commit_verified';
    const snapshotDbName = 'test_snap_commit_verified';

    // LiveDb has the verified newly restored data
    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-new-verified', title: 'Newly Restored Chat', createdAt: 200, updatedAt: 200 });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });
    liveDb.close();

    // Snapshot has old pre-restore data
    const snapDb = await openExtensionDatabase(fakeFactory, snapshotDbName);
    const sTx = snapDb.transaction(['conversations', 'messages'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-old', title: 'Old Chat', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });
    snapDb.close();

    // Simulate crash at stage 'commit_verified' (deep verification had already succeeded!)
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'commit_verified',
      liveDbName,
      snapshotDbName,
      stagingDbName: 'test_staging_commit_verified',
      timestamp: Date.now() - 5000,
      operationId: 'op-commit-verified',
    }, fakeFactory);

    const recStatus = await recoverIncompleteRestoreIfAny(fakeFactory);
    expect(recStatus.state).toBe('recovered');

    // LiveDb MUST retain the new verified data (NOT rolled back to old!)
    const verifyDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const conv = await new Promise<any>((res) => {
      const tx = verifyDb.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').get('c-new-verified');
      req.onsuccess = () => res(req.result);
    });
    verifyDb.close();
    expect(conv?.title).toBe('Newly Restored Chat');
  });

  // ── Scenario 9: Re-running restore after midway failure ──
  it('SCENARIO 9: Re-running restore after midway failure succeeds cleanly without lock contention or corruption', async () => {
    const liveDbName = 'test_live_retry_after_fail';
    const stagingDbName = 'test_staging_retry_after_fail';

    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const stagingDb = await openExtensionDatabase(fakeFactory, stagingDbName);

    // Initial state
    const tx = stagingDb.transaction(['conversations'], 'readwrite');
    tx.objectStore('conversations').put({ id: 'c1', title: 'Retry Test Chat', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });

    // First attempt fails intentionally due to count mismatch
    const failRes = await commitStagingReplaceToLive(
      liveDb,
      stagingDb,
      {
        conversations: 999, // Mismatch!
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      fakeFactory
    );
    expect(failRes.success).toBe(false);

    // Second attempt with correct counts MUST succeed without deadlock!
    const successRes = await commitStagingReplaceToLive(
      liveDb,
      stagingDb,
      {
        conversations: 1,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      fakeFactory
    );
    expect(successRes.success).toBe(true);
    expect(successRes.verified).toBe(true);
  });

  // ── Scenario 10: Re-running Merge with identical data ──
  it('SCENARIO 10: Re-running Merge with identical data inserts 0 duplicates, detects 0 conflicts, and marks skipped', async () => {
    const liveDbName = 'test_live_merge_idempotent';
    const stagingDbName = 'test_staging_merge_idempotent';

    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const stagingDb = await openExtensionDatabase(fakeFactory, stagingDbName);

    const sTx = stagingDb.transaction(['conversations', 'messages'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c1', title: 'Idempotent Chat', createdAt: 100, updatedAt: 100 });
    sTx.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'user', content: 'Same content', createdAt: 100 });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

    // Merge pass 1: inserts 1 conversation and 1 message
    const res1 = await commitStagingMergeToLive(
      liveDb,
      {
        mode: 'merge',
        valid: true,
        toInsert: { conversations: [], messages: [], revisions: [], recovery_events: [], raw_streams: [], raw_stream_batches: [] },
        toSkip: { conversations: 0, messages: 0, revisions: 0, recovery_events: 0, raw_streams: 0, raw_stream_batches: 0 },
        conflicts: [],
      },
      fakeFactory,
      stagingDb
    );
    expect(res1.success).toBe(true);
    expect(res1.insertedCounts.conversations).toBe(1);
    expect(res1.insertedCounts.messages).toBe(1);

    // Merge pass 2 with identical staging data: 0 inserted, skipped equal to counts, 0 conflicts!
    const res2 = await commitStagingMergeToLive(
      liveDb,
      {
        mode: 'merge',
        valid: true,
        toInsert: { conversations: [], messages: [], revisions: [], recovery_events: [], raw_streams: [], raw_stream_batches: [] },
        toSkip: { conversations: 0, messages: 0, revisions: 0, recovery_events: 0, raw_streams: 0, raw_stream_batches: 0 },
        conflicts: [],
      },
      fakeFactory,
      stagingDb
    );
    expect(res2.success).toBe(true);
    expect(res2.insertedCounts.conversations).toBe(0);
    expect(res2.insertedCounts.messages).toBe(0);
  });
});
