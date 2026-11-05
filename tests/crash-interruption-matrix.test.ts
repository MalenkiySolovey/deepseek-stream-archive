import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  commitStagingReplaceToLive,
  commitStagingMergeToLive,
  recoverIncompleteRestoreIfAny,
  setTestRestoreInterruptionHook,
  verifyDatabaseEquality,
  type RestoreInterruptionPoint,
  EIGHT_SNAPSHOT_STORES,
  SIX_DURABLE_STORES,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';

describe('Crash Interruption Matrix (All 9 Lifecycle Points)', () => {
  let fakeFactory: IDBFactory;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    setTestRestoreInterruptionHook(null);
  });

  afterEach(() => {
    setTestRestoreInterruptionHook(null);
  });

  async function seedLiveDatabase(dbName: string, prefix: string) {
    const db = await openExtensionDatabase(fakeFactory, dbName);
    const tx = db.transaction(['conversations', 'messages', 'revisions', 'raw_streams', 'raw_stream_batches'], 'readwrite');

    tx.objectStore('conversations').put({
      id: `${prefix}-c1`,
      title: `${prefix} Live Original Conversation`,
      createdAt: 1000,
      updatedAt: 1000,
    });
    tx.objectStore('messages').put({
      id: `${prefix}-m1`,
      conversationId: `${prefix}-c1`,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      content: `${prefix} User message original content`,
      createdAt: 1000,
      updatedAt: 1000,
    });
    tx.objectStore('messages').put({
      id: `${prefix}-m2`,
      conversationId: `${prefix}-c1`,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      content: `${prefix} Assistant response original content`,
      createdAt: 1001,
      updatedAt: 1001,
    });
    tx.objectStore('revisions').put({
      id: `${prefix}-r1`,
      messageId: `${prefix}-m2`,
      conversationId: `${prefix}-c1`,
      content: `${prefix} Assistant revision original content`,
      createdAt: 1001,
    });
    tx.objectStore('raw_streams').put({
      id: `${prefix}-s1`,
      streamKey: `key-${prefix}-1`,
      status: 'completed',
      createdAt: 1000,
    });
    tx.objectStore('raw_stream_batches').put({
      id: `${prefix}-b1`,
      streamKey: `key-${prefix}-1`,
      seq: 0,
      chunks: ['Original stream chunks'],
    });

    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    db.close();
  }

  async function seedStagingDatabase(stagingDbName: string, prefix: string) {
    const db = await openExtensionDatabase(fakeFactory, stagingDbName);
    const tx = db.transaction(['conversations', 'messages', 'revisions', 'raw_streams', 'raw_stream_batches'], 'readwrite');

    tx.objectStore('conversations').put({
      id: `${prefix}-c-incoming`,
      title: `${prefix} Incoming New Conversation`,
      createdAt: 2000,
      updatedAt: 2000,
    });
    tx.objectStore('messages').put({
      id: `${prefix}-m-incoming`,
      conversationId: `${prefix}-c-incoming`,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      content: `${prefix} Incoming assistant content`,
      createdAt: 2001,
      updatedAt: 2001,
    });
    tx.objectStore('revisions').put({
      id: `${prefix}-r-incoming`,
      messageId: `${prefix}-m-incoming`,
      conversationId: `${prefix}-c-incoming`,
      content: `${prefix} Incoming revision content`,
      createdAt: 2001,
    });
    tx.objectStore('raw_streams').put({
      id: `${prefix}-s-incoming`,
      streamKey: `key-${prefix}-incoming`,
      status: 'completed',
      createdAt: 2000,
    });
    tx.objectStore('raw_stream_batches').put({
      id: `${prefix}-b-incoming`,
      streamKey: `key-${prefix}-incoming`,
      seq: 0,
      chunks: ['Incoming stream chunks'],
    });

    await new Promise<void>((r) => { tx.oncomplete = () => r(); });
    return db;
  }

  const interruptionPoints: RestoreInterruptionPoint[] = [
    'after_snapshot_created',
    'after_journal_persisted',
    'after_live_db_cleared',
    'after_first_batch',
    'mid_transfer',
    'after_full_transfer',
    'before_journal_deletion',
    'after_journal_deletion',
    'before_snapshot_deletion',
  ];

  for (const point of interruptionPoints) {
    it(`guarantees data integrity on crash at lifecycle point: "${point}"`, async () => {
      const liveDbName = `test_live_${point.replace(/_/g, '-')}`;
      const referenceLiveDbName = `test_ref_${point.replace(/_/g, '-')}`;

      // Seed live database and an exact reference copy for comparison
      await seedLiveDatabase(liveDbName, point);
      await seedLiveDatabase(referenceLiveDbName, point);

      const liveDb = await openExtensionDatabase(fakeFactory, liveDbName);
      const stagingDb = await seedStagingDatabase('StreamArchiveDB_restore_staging', point);

      // Inject crash at exact interruption point
      setTestRestoreInterruptionHook((currentPoint) => {
        if (currentPoint === point) {
          throw new Error(`CRASH_INJECTED_AT_${point}`);
        }
      });

      let restoreError: string | null = null;
      try {
        const res = await commitStagingReplaceToLive(
          liveDb,
          stagingDb,
          {
            conversations: 1,
            messages: 1,
            revisions: 1,
            recovery_events: 0,
            raw_streams: 1,
            raw_stream_batches: 1,
          },
          fakeFactory
        );
        if (!res.success) {
          restoreError = res.error || 'Restore failed';
        }
      } catch (err) {
        restoreError = (err as Error).message;
      }

      expect(restoreError).toBeDefined();
      expect(restoreError).toContain(`CRASH_INJECTED_AT_${point}`);

      // Simulate browser crash recovery on startup
      setTestRestoreInterruptionHook(null);
      await recoverIncompleteRestoreIfAny(fakeFactory);

      // Open liveDb and referenceLiveDb and perform deep content verification
      const verifyLiveDb = await openExtensionDatabase(fakeFactory, liveDbName);
      const referenceDb = await openExtensionDatabase(fakeFactory, referenceLiveDbName);

      const isDataIntact = await verifyDatabaseEquality(verifyLiveDb, referenceDb, EIGHT_SNAPSHOT_STORES);
      verifyLiveDb.close();
      referenceDb.close();

      expect(isDataIntact).toBe(true);
    });
  }
});
