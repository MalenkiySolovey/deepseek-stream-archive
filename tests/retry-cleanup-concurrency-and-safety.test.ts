import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  retryPendingRestoreCleanup,
  recoverIncompleteRestoreIfAny,
  setRestoreJournalMarker,
  type RestoreJournalMarker,
  type PostCommitCleanupResult,
} from '../src/restore/staging-service';
import { withExclusiveRestoreLock } from '../src/restore/restore-lock';
import { openExtensionDatabase } from '../src/storage/db';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
} from '../src/storage/schema';
import type { Conversation, Message, ResponseRevision } from '../src/core/models';

describe('Retry Cleanup Concurrency and Safety Suite (Scenarios 1 - 10)', () => {
  const liveDbName = 'test_live_retry_safety';
  const stagingDbName = '_deepseek_archive_staging_replace_retry_1';
  const snapshotDbName = '_deepseek_archive_snapshot_replace_retry_1';

  let liveDb: IDBDatabase;
  let stagingDb: IDBDatabase;
  let snapshotDb: IDBDatabase;

  const baseConv: Conversation = { id: 'c1', title: 'Conv 1', createdAt: 1000, updatedAt: 1000 };
  const baseMsg: Message = { id: 'm1', conversationId: 'c1', role: 'assistant', status: 'finished', identityState: 'reconciled', createdAt: 1000, updatedAt: 1000 };
  const baseRev: ResponseRevision = { id: 'r1', messageId: 'm1', revisionIndex: 0, text: 'Answer 1', source: 'network', capturedAt: 1000, isFinal: true, isLastGood: true };

  async function seedStore(db: IDBDatabase, store: string, records: any[]) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const r of records) os.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function doesDbExist(name: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = indexedDB.open(name);
      req.onupgradeneeded = (e) => {
        // If upgrade needed, it didn't exist before!
        (e.target as any).transaction.abort();
        resolve(false);
      };
      req.onsuccess = (e) => {
        (e.target as any).result.close();
        resolve(true);
      };
      req.onerror = () => resolve(false);
    });
  }

  beforeEach(async () => {
    indexedDB.deleteDatabase(liveDbName);
    indexedDB.deleteDatabase(stagingDbName);
    indexedDB.deleteDatabase(snapshotDbName);
    indexedDB.deleteDatabase('_deepseek_stream_archive_restore_journal_');

    liveDb = await openExtensionDatabase(indexedDB, liveDbName);
    stagingDb = await openExtensionDatabase(indexedDB, stagingDbName);
    snapshotDb = await openExtensionDatabase(indexedDB, snapshotDbName);

    // Baseline seed
    await seedStore(liveDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(liveDb, STORE_MESSAGES, [baseMsg]);
    await seedStore(liveDb, STORE_REVISIONS, [baseRev]);

    await seedStore(stagingDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(stagingDb, STORE_MESSAGES, [baseMsg]);
    await seedStore(stagingDb, STORE_REVISIONS, [baseRev]);

    await seedStore(snapshotDb, STORE_CONVERSATIONS, [baseConv]);
  });

  afterEach(() => {
    try { liveDb?.close(); } catch {}
    try { stagingDb?.close(); } catch {}
    try { snapshotDb?.close(); } catch {}
    indexedDB.deleteDatabase(liveDbName);
    indexedDB.deleteDatabase(stagingDbName);
    indexedDB.deleteDatabase(snapshotDbName);
    indexedDB.deleteDatabase('_deepseek_stream_archive_restore_journal_');
    delete (globalThis as any).__failJournalMarkerDeletion;
  });

  it('Scenario 1: Button clicked with hanging journal -> clean success and cleanup', async () => {
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_retry_1',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    const res = await retryPendingRestoreCleanup(indexedDB);
    expect(res.success).toBe(true);
    expect(res.journalDeleted).toBe(true);
    expect(res.snapshotDeleted).toBe(true);
  });

  it('Scenario 2: Auto-recovery already executing -> serialized safely, retry completes cleanly', async () => {
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_retry_2',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // Run both concurrently
    const [recoveryRes, retryRes] = await Promise.all([
      recoverIncompleteRestoreIfAny(indexedDB),
      retryPendingRestoreCleanup(indexedDB),
    ]);

    // Whichever runs first resolves the journal, the other sees clean state
    expect(['recovered', 'not_required']).toContain(recoveryRes.state);
    expect(retryRes.journalDeleted).toBe(true);
  });

  it('Scenario 3: Two sidepanels click Retry at the same time -> serialized without error or duplicate deletion', async () => {
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_retry_3',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    const [res1, res2] = await Promise.all([
      retryPendingRestoreCleanup(indexedDB),
      retryPendingRestoreCleanup(indexedDB),
    ]);

    expect(res1.journalDeleted).toBe(true);
    expect(res2.journalDeleted).toBe(true);
    expect(res1.errors).toHaveLength(0);
    expect(res2.errors).toHaveLength(0);
  });

  it('Scenario 4: In another panel Restore is active -> retry waits or aborts without destroying snapshot', async () => {
    let retryFinished = false;
    let otherFinished = false;
    let retryPromise: Promise<any>;

    const lockPromise = withExclusiveRestoreLock('replace', async () => {
      // While locked, someone clicks retry in another context
      retryPromise = retryPendingRestoreCleanup(indexedDB).then((r) => {
        retryFinished = true;
        return r;
      });

      // Assert retry has NOT finished yet while exclusive lock is held
      await new Promise((r) => setTimeout(r, 50));
      expect(retryFinished).toBe(false);

      otherFinished = true;
    });

    await lockPromise;
    expect(otherFinished).toBe(true);

    // Now that exclusive lock is released, retry proceeds and completes
    await retryPromise!;
    expect(retryFinished).toBe(true);
  });

  it('Scenario 5: Between opening panel and clicking Retry, marker changed to pre-commit stage -> refuses cleanup', async () => {
    // Marker is at pre-commit stage (e.g. transferring)
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'transferring',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_retry_5',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    await expect(retryPendingRestoreCleanup(indexedDB)).rejects.toThrow(/pre-commit stage "transferring"/);

    // Snapshot was NOT deleted!
    const snapExists = await doesDbExist(snapshotDbName);
    expect(snapExists).toBe(true);
  });

  it('Scenario 6: Marker already deleted by another context -> returns clean success without error', async () => {
    // No marker
    await setRestoreJournalMarker(null, indexedDB);

    const res = await retryPendingRestoreCleanup(indexedDB);
    expect(res.success).toBe(true);
    expect(res.journalDeleted).toBe(true);
  });

  it('Scenario 7: LiveDB received valid subsequent writes -> verified and cleaned up', async () => {
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_retry_7',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // Valid subsequent message
    const msg2: Message = { id: 'm2', conversationId: 'c1', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 2000, updatedAt: 2000 };
    const rev2: ResponseRevision = { id: 'r2', messageId: 'm2', revisionIndex: 0, text: 'Q2', source: 'network', capturedAt: 2000, isFinal: true, isLastGood: true };

    await seedStore(liveDb, STORE_MESSAGES, [msg2]);
    await seedStore(liveDb, STORE_REVISIONS, [rev2]);

    const res = await retryPendingRestoreCleanup(indexedDB);
    expect(res.success).toBe(true);
    expect(res.journalDeleted).toBe(true);
    expect(res.snapshotDeleted).toBe(true);
  });

  it('Scenario 8: LiveDB check detected corruption -> refuses cleanup, snapshot preserved', async () => {
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_retry_8',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // Corrupt revision r1 in liveDb!
    await seedStore(liveDb, STORE_REVISIONS, [{
      ...baseRev,
      text: 'CORRUPTED_TEXT_FOR_RETRY',
    }]);

    const res = await retryPendingRestoreCleanup(indexedDB);
    expect(res.success).toBe(false);
    expect(res.journalDeleted).toBe(false);
    expect(res.snapshotDeleted).toBe(false);

    // Snapshot MUST still exist!
    const snapExists = await doesDbExist(snapshotDbName);
    expect(snapExists).toBe(true);
  });

  it('Scenario 9: Journal marker deletion fails again (EBUSY) -> halts immediately, snapshot preserved', async () => {
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_retry_9',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // Simulate persistent lock on journal deletion
    (globalThis as any).__failJournalMarkerDeletion = true;

    const res = await retryPendingRestoreCleanup(indexedDB);
    expect(res.journalDeleted).toBe(false);
    expect(res.snapshotDeleted).toBe(false);

    // Snapshot must still exist
    const snapExists = await doesDbExist(snapshotDbName);
    expect(snapExists).toBe(true);
  });

  it('Scenario 10: Second click after temporary failure -> succeeds and cleans up snapshot safely', async () => {
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_retry_10',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // First attempt fails due to simulated EBUSY
    (globalThis as any).__failJournalMarkerDeletion = true;
    const res1 = await retryPendingRestoreCleanup(indexedDB);
    expect(res1.journalDeleted).toBe(false);
    expect(res1.snapshotDeleted).toBe(false);

    // Release lock
    delete (globalThis as any).__failJournalMarkerDeletion;

    // Second click: Retry cleanup succeeds!
    const res2 = await retryPendingRestoreCleanup(indexedDB);
    expect(res2.success).toBe(true);
    expect(res2.journalDeleted).toBe(true);
    expect(res2.snapshotDeleted).toBe(true);
  });
});
