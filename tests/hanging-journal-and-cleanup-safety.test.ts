import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
(globalThis as any).IDBKeyRange = IDBKeyRange;

import {
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  recoverIncompleteRestoreIfAny,
  performPostCommitCleanup,
  retryPendingRestoreCleanup,
  cleanupStaleTemporaryDatabases,
  registerActiveTemporaryDatabase,
  isTemporaryDatabaseActive,
  setRestoreJournalMarker,
  getRestoreJournalMarker,
  readAuthoritativeJournalMarkerState,
  openExistingSnapshotWithoutCreating,
  createSnapshotDatabaseName,
  createStagingDatabaseName,
  SIX_DURABLE_STORES,
  RESTORE_JOURNAL_DB_NAME,
  RESTORE_STAGING_DB_NAME,
  RESTORE_SNAPSHOT_DB_NAME,
  STALE_TEMPORARY_DB_AGE_THRESHOLD_MS,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';
import {
  IndexedDbStorageRepository,
  resetStorageRepositoryRecoveryCheck,
  ArchiveRecoveryFailedError,
} from '../src/storage/repositories/storage-repository-impl';
import type { RestorePlan } from '../src/restore/types';

describe('Hanging Journal & Post-Commit Cleanup Safety Suite', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    resetStorageRepositoryRecoveryCheck(fakeFactory);
  });

  // Helper to populate LiveDB with sample conversation, messages, revisions, recovery events
  async function seedLiveDatabase(dbName: string) {
    const liveDb = await openExtensionDatabase(fakeFactory, dbName);
    const tx = liveDb.transaction(
      ['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'],
      'readwrite'
    );
    tx.objectStore('conversations').put({ id: 'c-live-1', title: 'Live Chat 1', createdAt: 1000, updatedAt: 1000 });
    tx.objectStore('messages').put({
      id: 'm-live-1',
      conversationId: 'c-live-1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 1000,
      updatedAt: 1000,
    });
    tx.objectStore('revisions').put({
      id: 'r-live-1',
      messageId: 'm-live-1',
      revisionIndex: 0,
      text: 'Live user query',
      source: 'network',
      capturedAt: 1000,
      isFinal: true,
      isLastGood: true,
    });
    tx.objectStore('messages').put({
      id: 'm-live-2',
      conversationId: 'c-live-1',
      parentMessageId: 'm-live-1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 1010,
      updatedAt: 1010,
    });
    tx.objectStore('revisions').put({
      id: 'r-live-2',
      messageId: 'm-live-2',
      revisionIndex: 0,
      text: 'Live assistant response with DeepThink',
      thinking: 'Carefully evaluating facts...',
      source: 'network',
      capturedAt: 1010,
      isFinal: true,
      isLastGood: true,
    });
    tx.objectStore('recovery_events').put({
      id: 'ev-live-1',
      conversationId: 'c-live-1',
      messageId: 'm-live-2',
      eventType: 'reconciliation_applied',
      timestamp: 1020,
    });
    tx.objectStore('raw_streams').put({
      id: 'stream-live-1',
      producerSessionId: 'sess-1',
      streamId: 'stream-1',
      transport: 'xhr',
      url: 'https://chat.deepseek.com/api/chat',
      method: 'POST',
      state: 'completed',
      openedAt: 1005,
      updatedAt: 1015,
      totalChunks: 1,
      totalChars: 5,
      totalBatches: 1,
    });
    tx.objectStore('raw_stream_batches').put({
      id: 'stream-live-1:1',
      streamKey: 'stream-live-1',
      batchSeq: 1,
      chunks: [{ streamSequence: 1, chunkText: 'hello', timestamp: 1006 }],
      createdAt: 1006,
      charCount: 5,
    });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    return liveDb;
  }

  // Helper to populate Staging DB with imported records
  async function seedStagingDatabase(stagingDbName: string) {
    const stagingDb = await openExtensionDatabase(fakeFactory, stagingDbName);
    const tx = stagingDb.transaction(
      ['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'],
      'readwrite'
    );
    tx.objectStore('conversations').put({ id: 'c-stage-1', title: 'Imported Chat 1', createdAt: 2000, updatedAt: 2000 });
    tx.objectStore('messages').put({
      id: 'm-stage-1',
      conversationId: 'c-stage-1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 2000,
      updatedAt: 2000,
    });
    tx.objectStore('revisions').put({
      id: 'r-stage-1',
      messageId: 'm-stage-1',
      revisionIndex: 0,
      text: 'Imported user question',
      source: 'network',
      capturedAt: 2000,
      isFinal: true,
      isLastGood: true,
    });
    tx.objectStore('messages').put({
      id: 'm-stage-2',
      conversationId: 'c-stage-1',
      parentMessageId: 'm-stage-1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 2010,
      updatedAt: 2010,
    });
    tx.objectStore('revisions').put({
      id: 'r-stage-2',
      messageId: 'm-stage-2',
      revisionIndex: 0,
      text: 'Imported answer with deep thought',
      thinking: 'Imported reasoning steps...',
      source: 'network',
      capturedAt: 2010,
      isFinal: true,
      isLastGood: true,
    });
    tx.objectStore('recovery_events').put({
      id: 'ev-stage-1',
      conversationId: 'c-stage-1',
      messageId: 'm-stage-2',
      eventType: 'reconciliation_applied',
      timestamp: 2020,
    });
    tx.objectStore('raw_streams').put({
      id: 'stream-stage-1',
      producerSessionId: 'sess-stage-1',
      streamId: 'stream-stage-1',
      transport: 'fetch',
      url: 'https://chat.deepseek.com/api/chat',
      method: 'POST',
      state: 'completed',
      openedAt: 2005,
      updatedAt: 2015,
      totalChunks: 1,
      totalChars: 11,
      totalBatches: 1,
    });
    tx.objectStore('raw_stream_batches').put({
      id: 'stream-stage-1:1',
      streamKey: 'stream-stage-1',
      batchSeq: 1,
      chunks: [{ streamSequence: 1, chunkText: 'chunk-stage', timestamp: 2006 }],
      createdAt: 2006,
      charCount: 11,
    });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    return stagingDb;
  }

  // =========================================================================
  // Scenario A: Error deleting restore journal marker after confirmed Replace
  // =========================================================================
  it('Scenario A: protects snapshotDb & stagingDb when journal deletion fails after confirmed Replace', async () => {
    const liveDbName = 'test_livedb_scenario_a';
    const snapshotDbName = createSnapshotDatabaseName('snap_a');
    const stagingDbName = createStagingDatabaseName('stage_a');

    const liveDb = await seedLiveDatabase(liveDbName);
    const stagingDb = await seedStagingDatabase(stagingDbName);

    // Simulate persistent EBUSY / lock exclusively during performPostCommitCleanup journal deletion
    const originalOpen = fakeFactory.open.bind(fakeFactory);
    fakeFactory.open = function (name: string, version?: number) {
      if (name === RESTORE_JOURNAL_DB_NAME) {
        const stack = new Error().stack || '';
        if (stack.includes('performPostCommitCleanup')) {
          const req = new EventTarget() as any;
          req.result = null;
          req.error = new Error('EBUSY: simulated persistent lock on restore journal');
          queueMicrotask(() => {
            if (req.onerror) req.onerror({ target: req });
          });
          return req;
        }
      }
      return originalOpen(name, version);
    };

    const res = await commitStagingReplaceToLive(
      liveDb,
      stagingDb,
      {
        conversations: 1,
        messages: 2,
        revisions: 2,
        recovery_events: 1,
        raw_streams: 1,
        raw_stream_batches: 1,
      },
      fakeFactory,
      snapshotDbName
    );

    // Commit confirmed and verified!
    expect(res.success).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.cleanupStatus).toBe('journal_unresolved');
    expect(res.journalError).toContain('EBUSY');
    expect(res.cleanupWarning).toContain('EBUSY');

    // INVARIANT: snapshotDb and stagingDb MUST NOT be deleted!
    const snapDb = await openExistingSnapshotWithoutCreating(fakeFactory, snapshotDbName);
    expect(snapDb).not.toBeNull();
    snapDb?.close();

    const stageDb = await openExistingSnapshotWithoutCreating(fakeFactory, stagingDbName);
    expect(stageDb).not.toBeNull();
    stageDb?.close();

    // INVARIANT: LiveDB has restored content, no destructive rollback!
    const txLive = liveDb.transaction('conversations', 'readonly');
    const conv = await new Promise<any>((r) => {
      const req = txLive.objectStore('conversations').get('c-stage-1');
      req.onsuccess = () => r(req.result);
    });
    expect(conv).toBeDefined();
    expect(conv.title).toBe('Imported Chat 1');
  });

  // =========================================================================
  // Scenario B: Normal writes gated while journal marker is unresolved
  // =========================================================================
  it('Scenario B: gates normal repository writes until unresolved journal cleanup is resolved', async () => {
    const liveDbName = 'test_livedb_scenario_b';
    const snapshotDbName = createSnapshotDatabaseName('snap_b');
    const stagingDbName = createStagingDatabaseName('stage_b');

    const liveDb = await seedLiveDatabase(liveDbName);
    const stagingDb = await seedStagingDatabase(stagingDbName);

    let failJournalOpen = true;
    const originalOpen = fakeFactory.open.bind(fakeFactory);
    fakeFactory.open = function (name: string, version?: number) {
      if (name === RESTORE_JOURNAL_DB_NAME && failJournalOpen) {
        const stack = new Error().stack || '';
        if (stack.includes('performPostCommitCleanup') || stack.includes('recoverIncompleteRestoreIfAny')) {
          const req = new EventTarget() as any;
          req.result = null;
          req.error = new Error('EBUSY: journal locked');
          queueMicrotask(() => {
            if (req.onerror) req.onerror({ target: req });
          });
          return req;
        }
      }
      return originalOpen(name, version);
    };

    const res = await commitStagingReplaceToLive(
      liveDb,
      stagingDb,
      {
        conversations: 1,
        messages: 2,
        revisions: 2,
        recovery_events: 1,
        raw_streams: 1,
        raw_stream_batches: 1,
      },
      fakeFactory,
      snapshotDbName
    );
    expect(res.cleanupStatus).toBe('journal_unresolved');

    // While journal marker is unresolved and failing to delete, repository operations must fail-closed
    // to prevent corrupting journal invariants
    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);
    await expect(
      repo.saveConversation({ id: 'c-new', title: 'New Conversation While Locked', createdAt: 3000, updatedAt: 3000 })
    ).rejects.toThrow(/journal locked|Crash recovery/);

    // Snapshot and staging are preserved during the blocked state
    const snapDb = await openExistingSnapshotWithoutCreating(fakeFactory, snapshotDbName);
    expect(snapDb).not.toBeNull();
    snapDb?.close();
  });

  // =========================================================================
  // Scenario C: Retry pending cleanup succeeds cleanly without altering liveDb
  // =========================================================================
  it('Scenario C: retryPendingRestoreCleanup cleanly clears hanging marker and allows writes', async () => {
    const liveDbName = 'test_livedb_scenario_c';
    const snapshotDbName = createSnapshotDatabaseName('snap_c');
    const stagingDbName = createStagingDatabaseName('stage_c');

    const liveDb = await seedLiveDatabase(liveDbName);
    const stagingDb = await seedStagingDatabase(stagingDbName);

    let failJournal = true;
    const originalOpen = fakeFactory.open.bind(fakeFactory);
    fakeFactory.open = function (name: string, version?: number) {
      if (name === RESTORE_JOURNAL_DB_NAME && failJournal) {
        const stack = new Error().stack || '';
        if (stack.includes('performPostCommitCleanup')) {
          const req = new EventTarget() as any;
          req.result = null;
          req.error = new Error('EBUSY: transient journal lock');
          queueMicrotask(() => {
            if (req.onerror) req.onerror({ target: req });
          });
          return req;
        }
      }
      return originalOpen(name, version);
    };

    const res = await commitStagingReplaceToLive(
      liveDb,
      stagingDb,
      {
        conversations: 1,
        messages: 2,
        revisions: 2,
        recovery_events: 1,
        raw_streams: 1,
        raw_stream_batches: 1,
      },
      fakeFactory,
      snapshotDbName
    );
    expect(res.cleanupStatus).toBe('journal_unresolved');

    // Now simulated transient lock is released
    failJournal = false;

    // Execute retry of cleanup
    const retryResult = await retryPendingRestoreCleanup(fakeFactory);
    expect(retryResult.success).toBe(true);
    expect(retryResult.journalDeleted).toBe(true);
    expect(retryResult.snapshotDeleted).toBe(true);
    expect(retryResult.stagingDeleted).toBe(true);

    // Journal marker is gone
    const marker = await getRestoreJournalMarker(fakeFactory);
    expect(marker).toBeNull();

    // Snapshot DB and staging DB are now cleanly deleted
    const snapDb = await openExistingSnapshotWithoutCreating(fakeFactory, snapshotDbName);
    expect(snapDb).toBeNull();

    // LiveDB remains 100% intact with restored data
    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);
    const restoredConv = await repo.getConversation('c-stage-1');
    expect(restoredConv).toBeDefined();
    expect(restoredConv?.title).toBe('Imported Chat 1');

    // Normal writes immediately succeed!
    await repo.saveConversation({ id: 'c-fresh-write', title: 'Fresh Write Succeeded', createdAt: 4000, updatedAt: 4000 });
    const freshConv = await repo.getConversation('c-fresh-write');
    expect(freshConv).toBeDefined();
    expect(freshConv?.title).toBe('Fresh Write Succeeded');
  });

  // =========================================================================
  // Scenario D: Error deleting snapshotDb when journal was already deleted
  // =========================================================================
  it('Scenario D: handles failure to delete snapshotDb when journal was already deleted', async () => {
    const liveDbName = 'test_livedb_scenario_d';
    const snapshotDbName = createSnapshotDatabaseName('snap_d');
    const stagingDbName = createStagingDatabaseName('stage_d');

    const liveDb = await seedLiveDatabase(liveDbName);
    const stagingDb = await seedStagingDatabase(stagingDbName);

    // Fail ONLY snapshotDb deletion during performPostCommitCleanup
    const originalDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = function (name: string) {
      const stack = new Error().stack || '';
      if (name === snapshotDbName && stack.includes('performPostCommitCleanup')) {
        const req = new EventTarget() as any;
        req.result = undefined;
        req.error = new Error('EACCES: Snapshot database handle locked by external process');
        queueMicrotask(() => {
          if (req.onerror) req.onerror({ target: req });
        });
        return req;
      }
      return originalDelete(name);
    };

    const res = await commitStagingReplaceToLive(
      liveDb,
      stagingDb,
      {
        conversations: 1,
        messages: 2,
        revisions: 2,
        recovery_events: 1,
        raw_streams: 1,
        raw_stream_batches: 1,
      },
      fakeFactory,
      snapshotDbName
    );

    // Success and verified, categorized as temporary_leftover
    expect(res.success).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.cleanupStatus).toBe('temporary_leftover');
    expect(res.cleanupWarning).toContain('EACCES');

    // Journal was deleted!
    const marker = await getRestoreJournalMarker(fakeFactory);
    expect(marker).toBeNull();

    // LiveDB intact
    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);
    const conv = await repo.getConversation('c-stage-1');
    expect(conv?.title).toBe('Imported Chat 1');

    // Browser restart / recovery check must NOT trigger rollback!
    resetStorageRepositoryRecoveryCheck(fakeFactory);
    const recovery = await recoverIncompleteRestoreIfAny(fakeFactory);
    expect(recovery.state).toBe('not_required');
  });

  // =========================================================================
  // Scenario E: Error deleting stagingDb preserves liveDb without false rollback
  // =========================================================================
  it('Scenario E: handles failure to delete stagingDb as benign temporary_leftover', async () => {
    const liveDbName = 'test_livedb_scenario_e';
    const snapshotDbName = createSnapshotDatabaseName('snap_e');
    const stagingDbName = createStagingDatabaseName('stage_e');

    const liveDb = await seedLiveDatabase(liveDbName);
    const stagingDb = await seedStagingDatabase(stagingDbName);

    // Fail ONLY stagingDb deletion during performPostCommitCleanup
    const originalDelete = fakeFactory.deleteDatabase.bind(fakeFactory);
    fakeFactory.deleteDatabase = function (name: string) {
      const stack = new Error().stack || '';
      if (name === stagingDbName && stack.includes('performPostCommitCleanup')) {
        const req = new EventTarget() as any;
        req.result = undefined;
        req.error = new Error('EBUSY: Staging DB locked');
        queueMicrotask(() => {
          if (req.onerror) req.onerror({ target: req });
        });
        return req;
      }
      return originalDelete(name);
    };

    const res = await commitStagingReplaceToLive(
      liveDb,
      stagingDb,
      {
        conversations: 1,
        messages: 2,
        revisions: 2,
        recovery_events: 1,
        raw_streams: 1,
        raw_stream_batches: 1,
      },
      fakeFactory,
      snapshotDbName
    );

    expect(res.success).toBe(true);
    expect(res.cleanupStatus).toBe('temporary_leftover');
    expect(res.cleanupWarning).toContain('EBUSY');

    // Journal deleted
    expect(await getRestoreJournalMarker(fakeFactory)).toBeNull();

    // Snapshot deleted
    expect(await openExistingSnapshotWithoutCreating(fakeFactory, snapshotDbName)).toBeNull();

    // Writes work without false block
    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);
    await repo.saveConversation({ id: 'c-after-leftover', title: 'Leftover Safe Write', createdAt: 5000, updatedAt: 5000 });
    const fetched = await repo.getConversation('c-after-leftover');
    expect(fetched?.title).toBe('Leftover Safe Write');
  });

  // =========================================================================
  // Scenario F: Merge mode invariants (DeepThink, revisions, recovery events)
  // =========================================================================
  it('Scenario F: validates journal cleanup failure and safety in Merge mode with revisions and DeepThink', async () => {
    const liveDbName = 'test_livedb_scenario_f';
    const snapshotDbName = createSnapshotDatabaseName('snap_f');
    const stagingDbName = createStagingDatabaseName('stage_f');

    const liveDb = await seedLiveDatabase(liveDbName);
    const stagingDb = await seedStagingDatabase(stagingDbName);

    // Prepare Merge plan
    const plan: RestorePlan = {
      mode: 'merge',
      valid: true,
      toInsert: {
        conversations: [{ id: 'c-stage-1', title: 'Imported Chat 1', createdAt: 2000, updatedAt: 2000 }],
        messages: [
          { id: 'm-stage-1', conversationId: 'c-stage-1', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 2000, updatedAt: 2000 },
          { id: 'm-stage-2', conversationId: 'c-stage-1', parentId: 'm-stage-1', role: 'assistant', status: 'finished', identityState: 'reconciled', createdAt: 2010, updatedAt: 2010 },
        ],
        revisions: [
          { id: 'r-stage-1', messageId: 'm-stage-1', revisionIndex: 0, text: 'Imported user question', source: 'network', capturedAt: 2000, isFinal: true, isLastGood: true },
          { id: 'r-stage-2', messageId: 'm-stage-2', revisionIndex: 0, text: 'Imported answer with deep thought', thinking: 'Imported reasoning steps...', source: 'network', capturedAt: 2010, isFinal: true, isLastGood: true },
        ],
        recovery_events: [
          { id: 'ev-stage-1', messageId: 'm-stage-2', kind: 'content_filter', detectedAt: 2020, recoveredRevisionId: 'r-stage-2' },
        ],
        raw_streams: [
          {
            id: 'stream-stage-1',
            producerSessionId: 'sess-stage-1',
            streamId: 'stream-stage-1',
            transport: 'fetch',
            url: 'https://chat.deepseek.com/api/chat',
            method: 'POST',
            state: 'completed',
            openedAt: 2005,
            updatedAt: 2015,
            totalChunks: 1,
            totalChars: 11,
            totalBatches: 1,
          },
        ],
        raw_stream_batches: [
          {
            id: 'stream-stage-1:1',
            streamKey: 'stream-stage-1',
            batchSeq: 1,
            chunks: [{ streamSequence: 1, chunkText: 'chunk-stage', timestamp: 2006 }],
            createdAt: 2006,
            charCount: 11,
          },
        ],
      },
      toInsertCounts: {
        conversations: 1,
        messages: 2,
        revisions: 2,
        recovery_events: 1,
        raw_streams: 1,
        raw_stream_batches: 1,
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

    // Simulate journal deletion failure during Merge post-commit cleanup
    let failJournal = true;
    const originalOpen = fakeFactory.open.bind(fakeFactory);
    fakeFactory.open = function (name: string, version?: number) {
      if (name === RESTORE_JOURNAL_DB_NAME && failJournal) {
        const stack = new Error().stack || '';
        if (stack.includes('performPostCommitCleanup')) {
          const req = new EventTarget() as any;
          req.result = null;
          req.error = new Error('EBUSY: Merge journal deletion locked');
          queueMicrotask(() => {
            if (req.onerror) req.onerror({ target: req });
          });
          return req;
        }
      }
      return originalOpen(name, version);
    };

    const res = await commitStagingMergeToLive(
      liveDb,
      plan,
      fakeFactory,
      stagingDb,
      snapshotDbName
    );

    expect(res.success).toBe(true);
    expect(res.verified).toBe(true);
    expect(res.cleanupStatus).toBe('journal_unresolved');
    expect(res.journalError).toContain('EBUSY');

    // Both snapshot and staging preserved
    expect(await openExistingSnapshotWithoutCreating(fakeFactory, snapshotDbName)).not.toBeNull();
    expect(await openExistingSnapshotWithoutCreating(fakeFactory, stagingDbName)).not.toBeNull();

    // Verify liveDb contains both pre-existing live data AND imported data with revisions and DeepThink
    const repo = new IndexedDbStorageRepository(fakeFactory, liveDbName);
    const liveConv = await repo.getConversation('c-live-1');
    const importedConv = await repo.getConversation('c-stage-1');
    expect(liveConv).toBeDefined();
    expect(importedConv).toBeDefined();

    // Now release lock and retry cleanup
    failJournal = false;
    const retryRes = await retryPendingRestoreCleanup(fakeFactory);
    expect(retryRes.success).toBe(true);
    expect(retryRes.journalDeleted).toBe(true);
    expect(retryRes.snapshotDeleted).toBe(true);

    // Verify data remains intact and functional after cleanup
    const messages = await repo.listMessagesByConversation('c-stage-1');
    expect(messages).toHaveLength(2);
    const revisions = await repo.listRevisionsByMessage('m-stage-2');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.thinking).toBe('Imported reasoning steps...');
  });

  // =========================================================================
  // Scenario G: Safety of cleanupStaleTemporaryDatabases
  // =========================================================================
  it('Scenario G: protects actively registered temporary DBs and recent DBs from stale sweep', async () => {
    // 1. Create a simulated active in-flight preflight staging DB
    const activePreflightDbName = createStagingDatabaseName(`preflight_${Date.now()}_act123`);
    const unregister = registerActiveTemporaryDatabase(activePreflightDbName);
    expect(isTemporaryDatabaseActive(activePreflightDbName)).toBe(true);

    // Open it so it exists in fakeFactory
    const activeDb = await openExtensionDatabase(fakeFactory, activePreflightDbName);
    activeDb.close();

    // 2. Create a recent temporary staging DB (created now, < 15 minutes old)
    const recentDbName = createStagingDatabaseName(`op_${Date.now()}_recent`);
    const recentDb = await openExtensionDatabase(fakeFactory, recentDbName);
    recentDb.close();

    // 3. Create an old temporary staging DB (timestamp 25 minutes ago)
    const twentyFiveMinutesAgo = Date.now() - 25 * 60 * 1000;
    const oldDbName = createStagingDatabaseName(`op_${twentyFiveMinutesAgo}_old`);
    const oldDb = await openExtensionDatabase(fakeFactory, oldDbName);
    oldDb.close();

    // Run stale sweeper
    const swept = await cleanupStaleTemporaryDatabases(fakeFactory);

    // The old orphaned DB should be swept
    expect(swept).toContain(oldDbName);
    expect(await openExistingSnapshotWithoutCreating(fakeFactory, oldDbName)).toBeNull();

    // The actively registered database MUST NOT be swept!
    expect(swept).not.toContain(activePreflightDbName);
    expect(await openExistingSnapshotWithoutCreating(fakeFactory, activePreflightDbName)).not.toBeNull();

    // The recent database (< 15 min) MUST NOT be swept!
    expect(swept).not.toContain(recentDbName);
    expect(await openExistingSnapshotWithoutCreating(fakeFactory, recentDbName)).not.toBeNull();

    // Unregister active database
    unregister();
    expect(isTemporaryDatabaseActive(activePreflightDbName)).toBe(false);
  });
});
