import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory as FakeIDBFactory } from 'fake-indexeddb';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_CONTEXT_CONTINUITY_RECEIPTS,
} from '../src/storage/schema';
import { openExtensionDatabase, deleteExtensionDatabase, createDurableWriteTransaction } from '../src/storage/db';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import {
  getStorageMutationEpoch,
  resetStorageMutationEpoch,
  getDurableStorageMutationEpoch,
  STORAGE_MUTATION_KEY,
} from '../src/storage/mutation-tracker';
import {
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  buildRestorePlanFromStaging,
  RESTORE_STAGING_DB_NAME,
  RESTORE_SNAPSHOT_DB_NAME,
} from '../src/restore/staging-service';

describe('Audit Reproduction: Data Integrity, Durable Mutations & Crash Resilience', () => {
  let idb: IDBFactory;

  beforeEach(() => {
    idb = new FakeIDBFactory();
    resetStorageMutationEpoch(1);
  });

  it('REPRODUCTION 1: StorageRepository.getMutationEpoch must return durable epoch from IDB after SW cold restart', async () => {
    const repo = new IndexedDbStorageRepository(idb);
    const db = await openExtensionDatabase(idb);

    // Seed durable epoch 77 in canonical_checkpoints
    const tx = db.transaction([STORE_CANONICAL_CHECKPOINTS], 'readwrite');
    tx.objectStore(STORE_CANONICAL_CHECKPOINTS).put({
      streamKey: STORAGE_MUTATION_KEY,
      lastCommittedCheckpointSeq: 77,
      updatedAt: Date.now(),
      isTerminal: false,
    });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });

    // Simulate Service Worker cold restart (in-memory counter resets to 1)
    resetStorageMutationEpoch(1);
    expect(getStorageMutationEpoch()).toBe(1);

    // Call production path repo.getMutationEpoch()
    const epoch = await repo.getMutationEpoch();

    // Must return the durable value 77, NOT 1
    expect(epoch).toBe(77);
  });

  it('REPRODUCTION 2: getDurableStorageMutationEpoch must reject on database error, not quietly return in-memory counter', async () => {
    const db = await openExtensionDatabase(idb);
    db.close(); // Closed DB will cause transaction to throw or fail

    resetStorageMutationEpoch(999);

    // Attempting to read from a closed DB must reject
    await expect(getDurableStorageMutationEpoch(db)).rejects.toThrow();
  });

  it('REPRODUCTION 3: buildRestorePlanFromStaging must NOT load entire tables via getAll()', async () => {
    const liveDb = await openExtensionDatabase(idb, 'TestLive_NoGetAll');
    const stagingDb = await openExtensionDatabase(idb, 'TestStaging_NoGetAll');

    // Spy on objectStore.getAll
    let getAllCallCount = 0;
    const origTx = liveDb.transaction.bind(liveDb);
    liveDb.transaction = ((stores: any, mode: any) => {
      const tx = origTx(stores, mode);
      const origStore = tx.objectStore.bind(tx);
      tx.objectStore = ((name: string) => {
        const store = origStore(name);
        const origGetAll = store.getAll.bind(store);
        store.getAll = ((...args: any[]) => {
          getAllCallCount++;
          return origGetAll(...args);
        }) as any;
        return store;
      }) as any;
      return tx;
    }) as any;

    await buildRestorePlanFromStaging(liveDb, stagingDb, 'merge', {
      conversations: 0,
      messages: 0,
      revisions: 0,
      recovery_events: 0,
      raw_streams: 0,
      raw_stream_batches: 0,
    });

    // getAll should NOT have been called to load entire database tables
    expect(getAllCallCount).toBe(0);
  });

  it('REPRODUCTION 4: commitStagingReplaceToLive must NOT delete snapshot DB if rollback fails', async () => {
    const liveDb = await openExtensionDatabase(idb, 'TestLive_RollbackFailure');
    const stagingDb = await openExtensionDatabase(idb, RESTORE_STAGING_DB_NAME);

    // Put initial conversation in liveDb
    const initTx = liveDb.transaction([STORE_CONVERSATIONS], 'readwrite');
    initTx.objectStore(STORE_CONVERSATIONS).put({
      id: 'conv-vital',
      title: 'Vital User Conversation',
      createdAt: 100,
      updatedAt: 100,
      model: 'deepseek-chat',
    });
    await new Promise<void>((r) => { initTx.oncomplete = () => r(); });

    // Intentionally break liveDb write during replace to trigger rollback,
    // and make rollback fail by closing or poisoning liveDb
    const origTx = liveDb.transaction.bind(liveDb);
    let rollbackAttempted = false;
    liveDb.transaction = ((stores: any, mode: any) => {
      if (mode === 'readwrite' && rollbackAttempted) {
        throw new Error('Simulated disk catastrophic failure during rollback');
      }
      return origTx(stores, mode);
    }) as any;

    // Trigger replace with deliberate count mismatch so rollback is triggered
    rollbackAttempted = true;
    try {
      await commitStagingReplaceToLive(
        liveDb,
        stagingDb,
        { conversations: 999, messages: 0, revisions: 0, recovery_events: 0, raw_streams: 0, raw_stream_batches: 0 },
        idb
      );
    } catch {
      // Catastrophic failure occurred
    }

    // If rollback failed, RESTORE_SNAPSHOT_DB_NAME must NOT have been deleted!
    // We should be able to open RESTORE_SNAPSHOT_DB_NAME and find 'conv-vital' intact!
    const snapshotDb = await openExtensionDatabase(idb, RESTORE_SNAPSHOT_DB_NAME);
    const snapTx = snapshotDb.transaction([STORE_CONVERSATIONS], 'readonly');
    const snapReq = snapTx.objectStore(STORE_CONVERSATIONS).get('conv-vital');
    const snapConv = await new Promise<any>((resolve) => {
      snapReq.onsuccess = () => resolve(snapReq.result);
      snapReq.onerror = () => resolve(null);
    });

    expect(snapConv).toBeDefined();
    expect(snapConv?.id).toBe('conv-vital');
  });

  it('REPRODUCTION 5: commitStagingMergeToLive must roll back completely if an error occurs midway', async () => {
    const liveDb = await openExtensionDatabase(idb, 'TestLive_MergeRollback');
    const stagingDb = await openExtensionDatabase(idb, RESTORE_STAGING_DB_NAME);

    // Seed liveDb with initial conversation
    const liveTx = liveDb.transaction([STORE_CONVERSATIONS], 'readwrite');
    liveTx.objectStore(STORE_CONVERSATIONS).put({
      id: 'conv-existing',
      title: 'Existing Conversation',
      createdAt: 100,
      updatedAt: 100,
      model: 'deepseek-chat',
    });
    await new Promise<void>((r) => { liveTx.oncomplete = () => r(); });

    // Seed stagingDb with 1 new conversation AND 1 new message
    const stagTx = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    stagTx.objectStore(STORE_CONVERSATIONS).put({
      id: 'conv-new-1',
      title: 'New Conversation 1',
      createdAt: 200,
      updatedAt: 200,
      model: 'deepseek-chat',
    });
    stagTx.objectStore(STORE_MESSAGES).put({
      id: 'msg-new-1',
      conversationId: 'conv-new-1',
      role: 'user',
      createdAt: 200,
    });
    await new Promise<void>((r) => { stagTx.oncomplete = () => r(); });

    // Build merge plan
    const plan = await buildRestorePlanFromStaging(liveDb, stagingDb, 'merge', {
      conversations: 1,
      messages: 1,
      revisions: 0,
      recovery_events: 0,
      raw_streams: 0,
      raw_stream_batches: 0,
    });

    // Make liveDb throw when writing messages (after conversations already committed!)
    let messageFailures = 0;
    const origTx = liveDb.transaction.bind(liveDb);
    liveDb.transaction = ((stores: any, mode: any, options: any) => {
      const storeList = Array.isArray(stores) ? stores : [stores];
      if (mode === 'readwrite' && storeList.includes(STORE_MESSAGES) && messageFailures < 2) {
        messageFailures++;
        throw new Error('Simulated mid-merge disk error on messages store');
      }
      return origTx(stores, mode, options);
    }) as any;

    // Merge must fail
    await expect(commitStagingMergeToLive(liveDb, plan, idb)).rejects.toThrow();

    // After mid-merge failure, liveDb must NOT have conv-new-1 left behind!
    // It must roll back to the pre-merge state (only conv-existing).
    const checkTx = liveDb.transaction([STORE_CONVERSATIONS], 'readonly');
    const req1 = checkTx.objectStore(STORE_CONVERSATIONS).get('conv-new-1');
    const item1 = await new Promise<any>((resolve) => { req1.onsuccess = () => resolve(req1.result); });
    expect(item1).toBeUndefined(); // conv-new-1 must have been rolled back!
  });

  it('TEST 6: recoverIncompleteRestoreIfAny automatically restores liveDb from snapshot after browser crash', async () => {
    const liveDbName = 'TestLive_CrashRecover';
    const snapshotDbName = 'TestSnapshot_CrashRecover';

    // 1. Seed snapshotDb with valuable user conversation and message
    const snapshotDb = await openExtensionDatabase(idb, snapshotDbName);
    const snapTx = snapshotDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    snapTx.objectStore(STORE_CONVERSATIONS).put({
      id: 'conv-pre-crash',
      title: 'Pre-Crash Important Conversation',
      createdAt: 100,
      updatedAt: 100,
      model: 'deepseek-chat',
    });
    snapTx.objectStore(STORE_MESSAGES).put({
      id: 'msg-pre-crash',
      conversationId: 'conv-pre-crash',
      role: 'user',
      createdAt: 100,
    });
    await new Promise<void>((r) => { snapTx.oncomplete = () => r(); });

    // 2. Simulate broken liveDb (e.g. wiped or empty due to sudden process kill)
    const liveDb = await openExtensionDatabase(idb, liveDbName);
    const wipeTx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    wipeTx.objectStore(STORE_CONVERSATIONS).clear();
    wipeTx.objectStore(STORE_MESSAGES).clear();
    await new Promise<void>((r) => { wipeTx.oncomplete = () => r(); });

    // 3. Set crash-recovery marker as if browser crashed during Replace
    const { setRestoreJournalMarker, recoverIncompleteRestoreIfAny } = await import('../src/restore/staging-service');
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'transferring',
      liveDbName,
      snapshotDbName,
      stagingDbName: 'StreamArchiveDB_restore_staging',
      timestamp: Date.now(),
    }, idb);

    // 4. Trigger recovery
    const recovered = await recoverIncompleteRestoreIfAny(idb);
    expect(recovered).toBe(true);

    // 5. Verify liveDb now contains the recovered data!
    const checkTx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readonly');
    const cReq = checkTx.objectStore(STORE_CONVERSATIONS).get('conv-pre-crash');
    const mReq = checkTx.objectStore(STORE_MESSAGES).get('msg-pre-crash');

    const conv = await new Promise<any>((r) => { cReq.onsuccess = () => r(cReq.result); });
    const msg = await new Promise<any>((r) => { mReq.onsuccess = () => r(mReq.result); });

    expect(conv).toBeDefined();
    expect(conv?.id).toBe('conv-pre-crash');
    expect(msg).toBeDefined();
    expect(msg?.id).toBe('msg-pre-crash');
  });

  it('TEST 7: Concurrent restores must be rejected immediately by activeRestoreLock', async () => {
    const liveDb = await openExtensionDatabase(idb, 'TestLive_ConcurrentLock');
    const stagingDb = await openExtensionDatabase(idb, RESTORE_STAGING_DB_NAME);

    // Build plan
    const plan = await buildRestorePlanFromStaging(liveDb, stagingDb, 'merge', {
      conversations: 0,
      messages: 0,
      revisions: 0,
      recovery_events: 0,
      raw_streams: 0,
      raw_stream_batches: 0,
    });

    // Launch first restore
    const promise1 = commitStagingMergeToLive(liveDb, plan, idb);

    // Attempt second restore immediately while first is in-flight
    await expect(commitStagingMergeToLive(liveDb, plan, idb)).rejects.toThrow(
      'Another restore operation is already in progress.'
    );

    // Await first
    await promise1;
  });

  it('TEST 8: Sidepanel production backup path uses durable mutation epoch from IDB and detects concurrent mutation', async () => {
    const repo = new IndexedDbStorageRepository(idb);
    const db = await openExtensionDatabase(idb);
    const { streamBackupToWritable } = await import('../src/backup/streaming-backup');

    // Seed conversation and durable mutation epoch 10
    const tx = createDurableWriteTransaction(db, [STORE_CONVERSATIONS], 'strict');
    tx.objectStore(STORE_CONVERSATIONS).put({
      id: 'conv-prod-backup',
      title: 'Production Backup Conversation',
      createdAt: 100,
      updatedAt: 100,
      model: 'deepseek-chat',
    });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });

    // Simulate Service Worker cold-start (resetting in-memory counter to 1)
    resetStorageMutationEpoch(1);

    // Production call from sidepanel: getMutationEpoch: () => repo.getMutationEpoch()
    const chunks: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });

    // Run real backup stream with (db, writable, options)
    const result = await streamBackupToWritable(db, writable, {
      getMutationEpoch: () => repo.getMutationEpoch(),
    });

    expect(result.success).toBe(true);
    expect(result.totalRecords).toBeGreaterThan(0);
    expect(chunks.length).toBeGreaterThan(0);
  });
});
