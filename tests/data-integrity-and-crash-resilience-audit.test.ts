import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  verifyDatabaseEquality,
  getRestoreJournalMarker,
  setRestoreJournalMarker,
  recoverIncompleteRestoreIfAny,
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  EIGHT_SNAPSHOT_STORES,
  SIX_DURABLE_STORES,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';

describe('Audit Defect Reproductions: Content Verification & Stale Journal Safety', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
  });

  it('REPRODUCTION 1: verifyDatabaseEquality must detect content difference when keys match', async () => {
    const dbA = await openExtensionDatabase(fakeFactory, 'test_db_a');
    const dbB = await openExtensionDatabase(fakeFactory, 'test_db_b');

    // Seed same key 'msg-1' into both databases, but with DIFFERENT content
    const txA = dbA.transaction(['messages'], 'readwrite');
    txA.objectStore('messages').put({
      id: 'msg-1',
      conversationId: 'c1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      content: 'Original saved response',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await new Promise<void>((r) => { txA.oncomplete = () => r(); });

    const txB = dbB.transaction(['messages'], 'readwrite');
    txB.objectStore('messages').put({
      id: 'msg-1',
      conversationId: 'c1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      content: 'Corrupted response',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await new Promise<void>((r) => { txB.oncomplete = () => r(); });

    // The audit identified that current verifyDatabaseEquality only compares keys, so it returns true!
    // It MUST return false when content differs!
    const areEqual = await verifyDatabaseEquality(dbA, dbB, ['messages']);
    dbA.close();
    dbB.close();

    expect(areEqual).toBe(false);
  });

  it('REPRODUCTION 2: stale journal marker with non-existent snapshot must NEVER wipe healthy liveDb', async () => {
    const liveDbName = 'test_live_healthy';
    const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);

    // Seed precious conversation into liveDb
    const tx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    tx.objectStore('conversations').put({
      id: 'conv-precious',
      title: 'Precious User Chat',
      createdAt: 1000,
      updatedAt: 1000,
    });
    tx.objectStore('messages').put({
      id: 'msg-precious-1',
      conversationId: 'conv-precious',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      content: 'Important financial and health questions',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    liveDb.close();

    // Simulate stale journal marker pointing to a deleted or non-existent snapshot DB
    await setRestoreJournalMarker({
      type: 'replace',
      stage: 'commit_started' as any,
      liveDbName: liveDbName,
      snapshotDbName: 'StreamArchiveDB_nonexistent_snapshot',
      stagingDbName: 'StreamArchiveDB_nonexistent_staging',
      timestamp: Date.now() - 3600000, // 1 hour ago
    } as any, fakeFactory);

    // Call recovery.
    // BUG in current code: it calls openExtensionDatabase('StreamArchiveDB_nonexistent_snapshot'),
    // which auto-creates an EMPTY snapshot DB, wipes liveDb, and copies 0 records!
    const recovered = await recoverIncompleteRestoreIfAny(fakeFactory);

    // Live DB must remain UNTOUCHED!
    const verifyDb = await openExtensionDatabase(fakeFactory, liveDbName);
    const countConv = await new Promise<number>((r) => {
      const vTx = verifyDb.transaction('conversations', 'readonly');
      const req = vTx.objectStore('conversations').count();
      req.onsuccess = () => r(req.result);
    });
    const countMsg = await new Promise<number>((r) => {
      const vTx = verifyDb.transaction('messages', 'readonly');
      const req = vTx.objectStore('messages').count();
      req.onsuccess = () => r(req.result);
    });
    verifyDb.close();

    // If live database was wiped, countConv would be 0! It MUST be 1!
    expect(countConv).toBe(1);
    expect(countMsg).toBe(1);
    expect(recovered).toBe(false);
  });

  it('REPRODUCTION 3: commitStagingMergeToLive must detect concurrent modification collision on existing ID and abort with rollback', async () => {
    const liveDb = await openExtensionDatabase(fakeFactory, 'test_live_merge_collision');
    const stagingDb = await openExtensionDatabase(fakeFactory, 'test_staging_merge_collision');

    // Seed initial identical message into liveDb
    const txL = liveDb.transaction(['conversations', 'messages'], 'readwrite');
    txL.objectStore('conversations').put({
      id: 'c1',
      title: 'Chat 1',
      createdAt: 1000,
      updatedAt: 1000,
    });
    txL.objectStore('messages').put({
      id: 'msg-existing',
      conversationId: 'c1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      content: 'Original pre-merge content',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await new Promise<void>((r) => { txL.oncomplete = () => r(); });

    // Seed DIFFERENT content in stagingDb for the SAME key
    const txS = stagingDb.transaction(['conversations', 'messages'], 'readwrite');
    txS.objectStore('conversations').put({
      id: 'c1',
      title: 'Chat 1',
      createdAt: 1000,
      updatedAt: 1000,
    });
    txS.objectStore('messages').put({
      id: 'msg-existing',
      conversationId: 'c1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      content: 'Conflicting incoming content from backup',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await new Promise<void>((r) => { txS.oncomplete = () => r(); });

    // Commit merge: it MUST reject because of conflicting modification on 'msg-existing'
    let threwError = false;
    try {
      await commitStagingMergeToLive(
        liveDb,
        {
          mode: 'merge',
          valid: true,
          toInsert: {
            conversations: [],
            messages: [],
            revisions: [],
            recovery_events: [],
            raw_streams: [],
            raw_stream_batches: [],
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
        },
        fakeFactory,
        stagingDb
      );
    } catch {
      threwError = true;
    }

    // In current code, commitStagingMergeToLive silently ignores existing IDs without semantic check,
    // so it succeeds without throwing error!
    expect(threwError).toBe(true);
  });
});
