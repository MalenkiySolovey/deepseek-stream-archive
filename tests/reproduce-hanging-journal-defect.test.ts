import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
(globalThis as any).IDBKeyRange = IDBKeyRange;

import {
  commitStagingReplaceToLive,
  recoverIncompleteRestoreIfAny,
  setRestoreJournalMarker,
  getRestoreJournalMarker,
  readAuthoritativeJournalMarkerState,
  openExistingSnapshotWithoutCreating,
  createSnapshotDatabaseName,
  createStagingDatabaseName,
  SIX_DURABLE_STORES,
  RESTORE_JOURNAL_DB_NAME,
  RESTORE_JOURNAL_STORE_NAME,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';
import { IndexedDbStorageRepository, resetStorageRepositoryRecoveryCheck } from '../src/storage/repositories/storage-repository-impl';

describe('Reproduction: Hanging Journal & Premature Snapshot Cleanup Defect', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    resetStorageRepositoryRecoveryCheck(fakeFactory);
  });

  it('demonstrates defect: failed journal deletion deletes snapshot, allows writes, and then fails crash recovery', async () => {
    const liveDbName = 'test_livedb_repro_hanging_journal';
    const snapshotDbName = createSnapshotDatabaseName('test_snap');
    const stagingDbName = createStagingDatabaseName('test_stage');

    // 1. Seed initial LiveDB
    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const txInit = liveDb.transaction(['conversations', 'messages', 'revisions'], 'readwrite');
    txInit.objectStore('conversations').put({ id: 'c1', title: 'Initial Chat', createdAt: 1000, updatedAt: 1000 });
    txInit.objectStore('messages').put({ id: 'm1', conversationId: 'c1', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 1000, updatedAt: 1000 });
    txInit.objectStore('revisions').put({ id: 'r1', messageId: 'm1', revisionIndex: 0, text: 'Initial question', source: 'network', capturedAt: 1000, isFinal: true, isLastGood: true });
    await new Promise<void>((r) => { txInit.oncomplete = () => r(); });

    // 2. Seed Staging DB with restored data
    const stagingDb = await openExtensionDatabase(fakeFactory, stagingDbName);
    const txStage = stagingDb.transaction(['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'], 'readwrite');
    txStage.objectStore('conversations').put({ id: 'c-restored', title: 'Restored Chat', createdAt: 2000, updatedAt: 2000 });
    txStage.objectStore('messages').put({ id: 'm-restored', conversationId: 'c-restored', role: 'assistant', status: 'finished', identityState: 'reconciled', createdAt: 2000, updatedAt: 2000 });
    txStage.objectStore('revisions').put({ id: 'r-restored', messageId: 'm-restored', revisionIndex: 0, text: 'Restored answer', source: 'network', capturedAt: 2000, isFinal: true, isLastGood: true });
    await new Promise<void>((r) => { txStage.oncomplete = () => r(); });

    const originalOpen = fakeFactory.open.bind(fakeFactory);
    fakeFactory.open = function (name: string, version?: number) {
      if (name === RESTORE_JOURNAL_DB_NAME) {
        const stack = new Error().stack || '';
        // Fail ONLY the deletion in performPostCommitCleanup!
        if (stack.includes('performPostCommitCleanup')) {
          const req = new EventTarget() as any;
          req.result = null;
          req.error = new Error('EBUSY: Journal database locked during post-commit deletion');
          queueMicrotask(() => {
            if (req.onerror) req.onerror({ target: req });
          });
          return req;
        }
      }
      return originalOpen(name, version);
    };

    // Simulate existing active session where repository already checked recovery at startup
    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);
    // Initialize repository so it caches recovery check
    await repo.getConversation('c1');

    // Run Replace where journal marker deletion fails
    const res = await commitStagingReplaceToLive(
      liveDb,
      stagingDb,
      {
        conversations: 1,
        messages: 1,
        revisions: 1,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      fakeFactory,
      snapshotDbName
    );

    expect(res.success).toBe(true);
    expect(res.cleanupStatus).toBe('journal_unresolved');

    const state = await readAuthoritativeJournalMarkerState(fakeFactory);
    expect(state.status).toBe('marker_present');

    // On fixed architecture: snapshotDb and stagingDb are PRESERVED!
    const snapDb = await openExistingSnapshotWithoutCreating(fakeFactory, snapshotDbName);
    const stageDb = await openExistingSnapshotWithoutCreating(fakeFactory, stagingDbName);
    expect(snapDb).not.toBeNull();
    expect(stageDb).not.toBeNull();
    snapDb?.close();
    stageDb?.close();

    // After reset, recovery successfully verifies liveDb (restored + new writes), deletes marker and temporary DBs
    resetStorageRepositoryRecoveryCheck(fakeFactory);

    const recoveryStatus = await recoverIncompleteRestoreIfAny(fakeFactory);
    expect(recoveryStatus.state).not.toBe('failed');

    // Normal writes continue to work without false blocking
    await repo.saveConversation({ id: 'c-new', title: 'New Conversation After Restore', createdAt: 3000, updatedAt: 3000 });
    const conv = await repo.getConversation('c-new');
    expect(conv).toBeDefined();
  });
});
