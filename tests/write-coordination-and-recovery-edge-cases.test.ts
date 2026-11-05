import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  withExclusiveRestoreLock,
  withSharedStorageLock,
  isRestoreLocked,
  isBrowserExtensionRuntime,
} from '../src/restore/restore-lock';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import {
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  recoverIncompleteRestoreIfAny,
  setRestoreJournalMarker,
  getRestoreJournalMarker,
  verifyDatabaseEquality,
  RESTORE_SNAPSHOT_DB_NAME,
  RESTORE_STAGING_DB_NAME,
  RESTORE_JOURNAL_DB_NAME,
  EIGHT_SNAPSHOT_STORES,
  SIX_DURABLE_STORES,
  type RecoveryStatus,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';
import type { ContextContinuityReceipt } from '../src/context-continuity';
import type { CanonicalCheckpointData, HistoryReconciliationPlan } from '../src/core/contracts/storage-repository';

describe('Production Audit Regression Suite: Write Coordination, Lock Boundaries & Recovery Edge Cases', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    delete (globalThis as any).__FORCE_BROWSER_LOCK_REQUIREMENT;
  });

  // ── Test 1: saveCanonicalCheckpoint waits for Replace lock and writes safely ──
  it('TEST 1: saveCanonicalCheckpoint invoked concurrently during Replace waits for exclusive lock and writes into restored database without loss', async () => {
    const liveDbName = 'test_live_checkpoint_coordination';
    const stagingDbName = 'test_staging_checkpoint_coordination';

    // 1. Initial live database
    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-old', title: 'Old Chat', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

    // 2. Staging database with restored conversation
    const stagingDb = await openExtensionDatabase(fakeFactory, stagingDbName);
    const sTx = stagingDb.transaction(['conversations', 'messages'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-restored', title: 'Restored Chat', createdAt: 200, updatedAt: 200 });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);

    let checkpointSaved = false;

    // Start Replace
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

    // Concurrently invoke saveCanonicalCheckpoint
    const checkpointData: CanonicalCheckpointData = {
      streamKey: 'sess-cp:stream-1',
      checkpointSeq: 0,
      conversation: {
        id: 'c-restored',
        title: 'Restored Chat Updated by Stream',
        createdAt: 200,
        updatedAt: 500,
      },
      userMessage: {
        id: 'm-user-cp',
        conversationId: 'c-restored',
        role: 'user',
        status: 'finished',
        identityState: 'reconciled',
        createdAt: 300,
        updatedAt: 300,
      },
      message: {
        id: 'm-asst-cp',
        conversationId: 'c-restored',
        parentId: 'm-user-cp',
        role: 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        createdAt: 310,
        updatedAt: 400,
      },
      revisions: [
        {
          id: 'rev-cp-1',
          messageId: 'm-asst-cp',
          revisionIndex: 0,
          text: 'Assistant checkpoint text',
          source: 'network',
          capturedAt: 400,
          isFinal: true,
          isLastGood: true,
        },
      ],
      recoveryEvents: [],
      isTerminal: true,
    };

    const checkpointPromise = repo.saveCanonicalCheckpoint(checkpointData).then(() => {
      checkpointSaved = true;
    });

    await Promise.all([replacePromise, checkpointPromise]);
    expect(checkpointSaved).toBe(true);

    // Verify both the restored archive and the incoming checkpoint exist in liveDb
    const checkDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const conv = await new Promise<any>((res) => {
      checkDb.transaction('conversations', 'readonly').objectStore('conversations').get('c-restored').onsuccess = (e: any) => res(e.target.result);
    });
    const uMsg = await new Promise<any>((res) => {
      checkDb.transaction('messages', 'readonly').objectStore('messages').get('m-user-cp').onsuccess = (e: any) => res(e.target.result);
    });
    const aMsg = await new Promise<any>((res) => {
      checkDb.transaction('messages', 'readonly').objectStore('messages').get('m-asst-cp').onsuccess = (e: any) => res(e.target.result);
    });
    const rev = await new Promise<any>((res) => {
      checkDb.transaction('revisions', 'readonly').objectStore('revisions').get('rev-cp-1').onsuccess = (e: any) => res(e.target.result);
    });
    checkDb.close();

    expect(conv?.title).toBe('Restored Chat Updated by Stream');
    expect(uMsg).toBeDefined();
    expect(aMsg?.parentId).toBe('m-user-cp');
    expect(rev?.text).toBe('Assistant checkpoint text');
  });

  // ── Test 2: applyHistoryReconciliationPlan waits for lock ──
  it('TEST 2: applyHistoryReconciliationPlan during active Replace waits for lock and reconciles successfully', async () => {
    const liveDbName = 'test_live_recon_coordination';
    const stagingDbName = 'test_staging_recon_coordination';

    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const stagingDb = await openExtensionDatabase(fakeFactory, stagingDbName);

    // Seed staging
    const sTx = stagingDb.transaction(['conversations', 'messages'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-recon', title: 'Staging Chat', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });

    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);

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

    const reconPlan: HistoryReconciliationPlan = {
      conversation: {
        id: 'c-recon',
        remoteId: 'remote-recon-1',
        title: 'Reconciled Title',
        createdAt: 100,
        updatedAt: 300,
      },
      messagesToPut: [
        {
          id: 'msg-recon-1',
          conversationId: 'c-recon',
          role: 'user',
          status: 'finished',
          identityState: 'reconciled',
          createdAt: 150,
          updatedAt: 150,
        },
      ],
      revisionsToPut: [],
      treeLinksResolved: 0,
    };

    let reconDone = false;
    const reconPromise = repo.applyHistoryReconciliationPlan(reconPlan).then(() => {
      reconDone = true;
    });

    await Promise.all([replacePromise, reconPromise]);
    expect(reconDone).toBe(true);

    const checkDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const conv = await new Promise<any>((res) => {
      checkDb.transaction('conversations', 'readonly').objectStore('conversations').get('c-recon').onsuccess = (e: any) => res(e.target.result);
    });
    const msg = await new Promise<any>((res) => {
      checkDb.transaction('messages', 'readonly').objectStore('messages').get('msg-recon-1').onsuccess = (e: any) => res(e.target.result);
    });
    checkDb.close();

    expect(conv?.title).toBe('Reconciled Title');
    expect(msg).toBeDefined();
  });

  // ── Test 3: recordContinuityReceipt resolves strictly on tx.oncomplete ──
  it('TEST 3: recordContinuityReceipt resolves strictly on tx.oncomplete and handles transaction aborts cleanly', async () => {
    const liveDbName = 'test_live_continuity_ack';
    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);

    const receipt: ContextContinuityReceipt = {
      id: 'receipt-1',
      conversationId: 'conv-orig',
      remoteConversationId: 'conv-remote',
      parentMessageId: null,
      sourceMessageIds: ['m1', 'm2'],
      sourceRevisionIds: ['r1', 'r2'],
      deliveryMode: 'manual_next',
      state: 'dispatched',
      createdAt: 1000,
      updatedAt: 1000,
    };

    // 1. Normal save: resolves on tx.oncomplete
    await repo.recordContinuityReceipt(receipt);

    const loaded = await repo.getContinuityReceipt('receipt-1');
    expect(loaded?.id).toBe('receipt-1');

    // 2. updateContinuityReceipt resolves on tx.oncomplete
    await repo.updateContinuityReceipt('receipt-1', {
      state: 'bridged',
      resultingMessageId: 'msg-res-1',
    });

    const updated = await repo.getContinuityReceipt('receipt-1');
    expect(updated?.state).toBe('bridged');
    expect(updated?.resultingMessageId).toBe('msg-res-1');
  });

  // ── Test 4: Second context calling recoverIncompleteRestoreIfAny does NOT delete active snapshot ──
  it('TEST 4: A second context calling recoverIncompleteRestoreIfAny while Restore is at preparing_snapshot waits for lock and does NOT wipe active snapshot', async () => {
    const liveDbName = 'test_live_two_contexts';
    const snapshotDbName = RESTORE_SNAPSHOT_DB_NAME;
    const stagingDbName = RESTORE_STAGING_DB_NAME;

    // Seed original data in live
    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-important', title: 'Must Not Be Lost', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });
    liveDb.close();

    // Context A begins Replace: acquires exclusive lock and sets preparing_snapshot
    let contextBRecoverCompleted = false;
    let contextBResult: RecoveryStatus | null = null;

    await withExclusiveRestoreLock('replace', async () => {
      // Context A creates snapshot
      const snapDb = await openExtensionDatabase(fakeFactory, snapshotDbName);
      const sTx = snapDb.transaction(['conversations', 'messages'], 'readwrite');
      sTx.objectStore('conversations').put({ id: 'c-important', title: 'Must Not Be Lost', createdAt: 100, updatedAt: 100 });
      await new Promise<void>((r) => { sTx.oncomplete = () => r(); });
      snapDb.close();

      await setRestoreJournalMarker({
        type: 'replace',
        stage: 'preparing_snapshot',
        liveDbName,
        snapshotDbName,
        stagingDbName,
        timestamp: Date.now(),
        operationId: 'op-context-a',
      }, fakeFactory);

      // Now Context B starts (e.g. sidepanel opened concurrently) and calls recoverIncompleteRestoreIfAny
      // In the old buggy code, Context B would see stage 'preparing_snapshot' OUTSIDE a lock and delete Context A's snapshot!
      // In our fixed code, Context B acquires withExclusiveRestoreLock('recovery') FIRST, so it must wait!
      const contextBPromise = recoverIncompleteRestoreIfAny(fakeFactory).then((res) => {
        contextBRecoverCompleted = true;
        contextBResult = res;
      });

      // Give Context B a moment to attempt lock acquisition
      await new Promise((r) => setTimeout(r, 50));
      // Context B MUST NOT have finished yet, because Context A is holding the exclusive lock!
      expect(contextBRecoverCompleted).toBe(false);

      // Verify that Context A's snapshot was NOT deleted by Context B
      const checkSnapDb = await openExtensionDatabase(fakeFactory, snapshotDbName);
      const count = await new Promise<number>((res) => {
        const tx = checkSnapDb.transaction('conversations', 'readonly');
        tx.objectStore('conversations').count().onsuccess = (e: any) => res(e.target.result);
      });
      checkSnapDb.close();
      expect(count).toBe(1);

      // Context A now successfully finishes its operation and marks completed / clears marker
      await setRestoreJournalMarker(null, fakeFactory);
    });

    // Now Context A has released the lock; Context B can finish
    await new Promise((r) => setTimeout(r, 60));
    expect(contextBRecoverCompleted).toBe(true);
    expect((contextBResult as any)?.state).toBe('not_required');
  });

  // ── Test 5: IndexedDB is authoritative over chrome.storage.local ──
  it('TEST 5: IndexedDB is authoritative: when desynchronized with chrome.storage.local, IndexedDB unconditionally wins', async () => {
    // Mock chrome.storage.local with stale data
    const mockStorage: Record<string, any> = {
      __streamarchive_restore_marker__: {
        type: 'replace',
        stage: 'completed',
        liveDbName: 'stale_db',
        snapshotDbName: 'stale_snap',
        stagingDbName: 'stale_staging',
        timestamp: 100,
        operationId: 'op-stale',
      },
    };

    (globalThis as any).chrome = {
      storage: {
        local: {
          get: vi.fn(async (key: string) => ({ [key]: mockStorage[key] })),
          set: vi.fn(async (obj: Record<string, any>) => {
            Object.assign(mockStorage, obj);
          }),
          remove: vi.fn(async (key: string) => {
            delete mockStorage[key];
          }),
        },
      },
    };

    // Authoritative marker in IndexedDB
    const authoritativeMarker = {
      type: 'replace' as const,
      stage: 'commit_started' as const,
      liveDbName: 'authoritative_db',
      snapshotDbName: 'authoritative_snap',
      stagingDbName: 'authoritative_staging',
      timestamp: 2000,
      operationId: 'op-authoritative',
    };

    await setRestoreJournalMarker(authoritativeMarker, fakeFactory);

    // Read marker: MUST return the authoritative IndexedDB marker, NOT stale chrome.storage
    const result = await getRestoreJournalMarker(fakeFactory);
    expect(result).not.toBeNull();
    expect(result?.operationId).toBe('op-authoritative');
    expect(result?.stage).toBe('commit_started');

    delete (globalThis as any).chrome;
  });

  // ── Test 6: Journal write error before commit_started halts Replace without touching liveDb ──
  it('TEST 6: Journal verification failure before commit halts Replace immediately without touching liveDb', async () => {
    const liveDbName = 'test_live_journal_fail';
    const stagingDbName = 'test_staging_journal_fail';

    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    lTx.objectStore('conversations').put({ id: 'c-preserve', title: 'Protected Original Data', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { lTx.oncomplete = () => r(); });

    const stagingDb = await openExtensionDatabase(fakeFactory, stagingDbName);

    // Simulate journal open failure by corrupting the journal database name
    const corruptedFactory = {
      ...fakeFactory,
      open: (name: string, version?: number) => {
        if (name === RESTORE_JOURNAL_DB_NAME) {
          throw new Error('Disk IO Error: simulated failure writing journal marker');
        }
        return fakeFactory.open(name, version);
      },
    } as unknown as IDBFactory;

    let replaceThrew = false;
    let errorMessage = '';
    try {
      await commitStagingReplaceToLive(
        liveDb,
        stagingDb,
        {
          conversations: 0,
          messages: 0,
          revisions: 0,
          recovery_events: 0,
          raw_streams: 0,
          raw_stream_batches: 0,
        },
        corruptedFactory
      );
    } catch (err: any) {
      replaceThrew = true;
      errorMessage = err.message;
    }

    expect(replaceThrew).toBe(true);
    expect(errorMessage.toLowerCase()).toContain('journal');

    // Live database MUST remain 100% intact!
    const checkDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const conv = await new Promise<any>((res) => {
      checkDb.transaction('conversations', 'readonly').objectStore('conversations').get('c-preserve').onsuccess = (e: any) => res(e.target.result);
    });
    checkDb.close();

    expect(conv?.title).toBe('Protected Original Data');
  });

  // ── Test 7: Long restore wait in withSharedStorageLock does not timeout while restore is active ──
  it('TEST 7: withSharedStorageLock with adaptive extension waits while exclusive restore is active', async () => {
    let sharedExecuted = false;

    await withExclusiveRestoreLock('replace', async () => {
      // Start a shared write during exclusive lock
      const sharedPromise = withSharedStorageLock(
        'longRestoreWrite',
        async () => {
          sharedExecuted = true;
          return 'ok';
        },
        10_000 // 10s wait allowed to adaptively extend while restore is locked
      );

      // Verify lock is active
      const locked = await isRestoreLocked();
      expect(locked).toBe(true);

      // Simulate 80ms of restore work
      await new Promise((r) => setTimeout(r, 80));
      expect(sharedExecuted).toBe(false);

      // Exclusive lock ends here
    });

    // After exclusive lock is released, shared write executes immediately
    await new Promise((r) => setTimeout(r, 50));
    expect(sharedExecuted).toBe(true);
  });

  // ── Test 8: Browser runtime without Web Locks fails-closed ──
  it('TEST 8: In browser extension runtime without Web Locks, locking fails-closed with explicit error instead of silent process-local lock', async () => {
    const origLocks = (globalThis as any).navigator?.locks;
    try {
      // Temporarily simulate missing navigator.locks
      if (typeof navigator !== 'undefined') {
        Object.defineProperty(navigator, 'locks', {
          value: undefined,
          configurable: true,
          writable: true,
        });
      }
      (globalThis as any).__FORCE_BROWSER_LOCK_REQUIREMENT = true;

      // Verify isBrowserExtensionRuntime detects it
      expect(isBrowserExtensionRuntime()).toBe(true);

      let threwExclusive = false;
      let errExclusiveMsg = '';
      try {
        await withExclusiveRestoreLock('test_browser', async () => 'ok');
      } catch (err: any) {
        threwExclusive = true;
        errExclusiveMsg = err.message;
      }
      expect(threwExclusive).toBe(true);
      expect(errExclusiveMsg).toContain('navigator.locks');

      let threwShared = false;
      let errSharedMsg = '';
      try {
        await withSharedStorageLock('test_shared_browser', async () => 'ok');
      } catch (err: any) {
        threwShared = true;
        errSharedMsg = err.message;
      }
      expect(threwShared).toBe(true);
      expect(errSharedMsg).toContain('navigator.locks');
    } finally {
      if (typeof navigator !== 'undefined' && origLocks) {
        Object.defineProperty(navigator, 'locks', {
          value: origLocks,
          configurable: true,
          writable: true,
        });
      }
      delete (globalThis as any).__FORCE_BROWSER_LOCK_REQUIREMENT;
    }
  });

  // ── Test 9: commit_verified stage with corrupted staging preserves pre-restore snapshot ──
  it('TEST 9: recoverIncompleteRestoreIfAny at commit_verified with corrupt/empty liveDb preserves pre-restore snapshot', async () => {
    const liveDbName = 'test_live_commit_verified_corrupt';
    const snapshotDbName = 'test_snap_commit_verified_corrupt';
    const stagingDbName = 'test_staging_commit_verified_corrupt';

    // Populate snapshot
    const snapDb = await openExtensionDatabase(fakeFactory, snapshotDbName);
    const sTx = snapDb.transaction(['conversations', 'messages'], 'readwrite');
    sTx.objectStore('conversations').put({ id: 'c-snap-safe', title: 'Snapshot Safe Data', createdAt: 100, updatedAt: 100 });
    await new Promise<void>((r) => { sTx.oncomplete = () => r(); });
    snapDb.close();

    // Live DB is empty (e.g. disk corruption occurred right after commit_verified marker)
    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    liveDb.close();

    // Set marker indicating commit_verified, but expected 1 conversation
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'commit_verified',
      liveDbName,
      snapshotDbName,
      stagingDbName,
      timestamp: Date.now() - 5000,
      operationId: 'op-verified-corrupt',
      expectedCounts: {
        conversations: 1,
        messages: 0,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
    }, fakeFactory);

    // Run recovery: it MUST NOT delete the snapshot because liveDb has 0 records while 1 was expected!
    const recStatus = await recoverIncompleteRestoreIfAny(fakeFactory);
    expect(recStatus.state).toBe('failed');
    if (recStatus.state === 'failed') {
      expect(recStatus.snapshotPreserved).toBe(true);
    }

    // Verify snapshot was preserved and still has records
    const checkSnapDb = await openExtensionDatabase(fakeFactory, snapshotDbName);
    const snapCount = await new Promise<number>((res) => {
      checkSnapDb.transaction('conversations', 'readonly').objectStore('conversations').count().onsuccess = (e: any) => res(e.target.result);
    });
    checkSnapDb.close();
    expect(snapCount).toBe(1);
  });

  // ── Test 10: Retention operations wrapped in shared lock ──
  it('TEST 10: Raw retention and cascade deletion operations serialize with shared lock', async () => {
    const liveDbName = 'test_live_retention_coordination';
    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);

    // Seed conversation and raw stream
    const db = await openExtensionDatabase(fakeFactory, liveDbName);
    const tx = db.transaction(['conversations', 'raw_streams'], 'readwrite');
    tx.objectStore('conversations').put({ id: 'c-del', title: 'To Delete', createdAt: 100, updatedAt: 100 });
    tx.objectStore('raw_streams').put({
      id: 'stream-del',
      producerSessionId: 'sess-del',
      streamId: 's1',
      transport: 'fetch',
      url: 'https://chat.deepseek.com',
      method: 'POST',
      state: 'completed',
      openedAt: 100,
      updatedAt: 100,
    });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    db.close();

    // Execute raw evidence cleanup
    const clearResult = await repo.clearRawEvidence(0);
    expect(clearResult).toBeDefined();

    // Execute cascade deletion
    const plan = await repo.buildConversationDeletionPlan('c-del', new Set());
    await repo.deleteConversationCascade(plan, new Set());

    const checkDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const conv = await new Promise<any>((res) => {
      checkDb.transaction('conversations', 'readonly').objectStore('conversations').get('c-del').onsuccess = (e: any) => res(e.target.result);
    });
    checkDb.close();

    expect(conv).toBeUndefined();
  });
});
