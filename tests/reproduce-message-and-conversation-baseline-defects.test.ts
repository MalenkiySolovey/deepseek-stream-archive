import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  recoverIncompleteRestoreIfAny,
  verifyRestoredBaselinePreserved,
  setRestoreJournalMarker,
  type RestoreJournalMarker,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
} from '../src/storage/schema';
import type { Conversation, Message, ResponseRevision } from '../src/core/models';

describe('Reproduction: Message and Conversation baseline preservation defects', () => {
  const liveDbName = 'test_live_msg_baseline_defect';
  const stagingDbName = '_deepseek_archive_staging_replace_msg_defect_100';
  const snapshotDbName = '_deepseek_archive_snapshot_replace_msg_defect_100';

  let liveDb: IDBDatabase;
  let stagingDb: IDBDatabase;
  let snapshotDb: IDBDatabase;

  beforeEach(async () => {
    indexedDB.deleteDatabase(liveDbName);
    indexedDB.deleteDatabase(stagingDbName);
    indexedDB.deleteDatabase(snapshotDbName);
    indexedDB.deleteDatabase('_deepseek_stream_archive_restore_journal_');

    liveDb = await openExtensionDatabase(indexedDB, liveDbName);
    stagingDb = await openExtensionDatabase(indexedDB, stagingDbName);
    snapshotDb = await openExtensionDatabase(indexedDB, snapshotDbName);
  });

  afterEach(() => {
    try { liveDb?.close(); } catch {}
    try { stagingDb?.close(); } catch {}
    try { snapshotDb?.close(); } catch {}
    indexedDB.deleteDatabase(liveDbName);
    indexedDB.deleteDatabase(stagingDbName);
    indexedDB.deleteDatabase(snapshotDbName);
    indexedDB.deleteDatabase('_deepseek_stream_archive_restore_journal_');
  });

  it('DEFECT 1 REPRODUCTION: isBaselineRecordPreserved ignores user message content mutation if string', async () => {
    const conv: Conversation = {
      id: 'c1',
      title: 'Original Title',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const userMsg: Message = {
      id: 'user-1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Назови три закона робототехники',
      createdAt: 1000,
      updatedAt: 1000,
    };

    // Save baseline to staging and snapshot
    for (const targetDb of [stagingDb, snapshotDb]) {
      await new Promise<void>((resolve, reject) => {
        const tx = targetDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
        tx.objectStore(STORE_CONVERSATIONS).put(conv);
        tx.objectStore(STORE_MESSAGES).put(userMsg);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // In Live DB: corrupted user content + added subsequent message
    const corruptedUserMsg: Message = {
      ...userMsg,
      content: 'Повреждённый текст',
      updatedAt: 1500,
    };
    const subsequentMsg: Message = {
      id: 'msg-subsequent',
      conversationId: 'c1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 2000,
      updatedAt: 2000,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(corruptedUserMsg);
      tx.objectStore(STORE_MESSAGES).put(subsequentMsg);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: 1000,
      liveStoreCounts: {
        conversations: 1,
        messages: 1,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      liveStoreChecksums: {
        conversations: 'dummy_hash_1',
        messages: 'dummy_hash_2',
        revisions: 'dummy_hash_3',
        recovery_events: 'dummy_hash_4',
        raw_streams: 'dummy_hash_5',
        raw_stream_batches: 'dummy_hash_6',
      },
    };
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    // ON fb799d6: check.valid is TRUE because it only checked typeof content === 'string'!
    // BUT EXPECTED: check.valid MUST BE FALSE!
    expect(check.valid).toBe(false);
  });

  it('DEFECT 2 REPRODUCTION: isBaselineRecordPreserved ignores parentId mutation to another valid parent', async () => {
    const conv: Conversation = {
      id: 'c1',
      title: 'Branching tree',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'User prompt 1',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const a1a: Message = {
      id: 'a1a',
      conversationId: 'c1',
      parentId: 'u1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1100,
      updatedAt: 1100,
    };
    const a1b: Message = {
      id: 'a1b',
      conversationId: 'c1',
      parentId: 'u1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1200,
      updatedAt: 1200,
    };
    const u2: Message = {
      id: 'u2',
      conversationId: 'c1',
      parentId: 'a1b', // Connected under a1b
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'User prompt 2',
      createdAt: 1300,
      updatedAt: 1300,
    };

    // Save baseline
    for (const targetDb of [stagingDb, snapshotDb]) {
      await new Promise<void>((resolve, reject) => {
        const tx = targetDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
        tx.objectStore(STORE_CONVERSATIONS).put(conv);
        tx.objectStore(STORE_MESSAGES).put(u1);
        tx.objectStore(STORE_MESSAGES).put(a1a);
        tx.objectStore(STORE_MESSAGES).put(a1b);
        tx.objectStore(STORE_MESSAGES).put(u2);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // In liveDb: u2's parentId is mutated from 'a1b' to 'a1a' (corrupting tree structure),
    // and a new message is added to cause counts divergence.
    const corruptedU2: Message = {
      ...u2,
      parentId: 'a1a', // corrupted parent
      updatedAt: 1400,
    };
    const subsequentMsg: Message = {
      id: 'msg-subsequent',
      conversationId: 'c1',
      parentId: 'u2',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 2000,
      updatedAt: 2000,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.objectStore(STORE_MESSAGES).put(a1a);
      tx.objectStore(STORE_MESSAGES).put(a1b);
      tx.objectStore(STORE_MESSAGES).put(corruptedU2);
      tx.objectStore(STORE_MESSAGES).put(subsequentMsg);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: 1000,
      liveStoreCounts: {
        conversations: 1,
        messages: 4,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      liveStoreChecksums: {
        conversations: 'h1',
        messages: 'h2',
        revisions: 'h3',
        recovery_events: 'h4',
        raw_streams: 'h5',
        raw_stream_batches: 'h6',
      },
    };
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    // ON fb799d6: check.valid is TRUE because parentId is NOT checked!
    // BUT EXPECTED: check.valid MUST BE FALSE!
    expect(check.valid).toBe(false);
  });

  it('DEFECT 3 REPRODUCTION: isBaselineRecordPreserved ignores projectionState mutation logical -> attempt_only', async () => {
    const conv: Conversation = {
      id: 'c1',
      title: 'Conversation 1',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const msg: Message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1000,
      updatedAt: 1000,
    };

    // Save baseline
    for (const targetDb of [stagingDb, snapshotDb]) {
      await new Promise<void>((resolve, reject) => {
        const tx = targetDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
        tx.objectStore(STORE_CONVERSATIONS).put(conv);
        tx.objectStore(STORE_MESSAGES).put(msg);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // In liveDb: projectionState changed to 'attempt_only' (hides from tree!) + subsequent message
    const corruptedMsg: Message = {
      ...msg,
      projectionState: 'attempt_only',
      updatedAt: 1500,
    };
    const subsequentMsg: Message = {
      id: 'm-subsequent',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'New prompt',
      createdAt: 2000,
      updatedAt: 2000,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(corruptedMsg);
      tx.objectStore(STORE_MESSAGES).put(subsequentMsg);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: 1000,
      liveStoreCounts: {
        conversations: 1,
        messages: 1,
        revisions: 0,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      liveStoreChecksums: {
        conversations: 'h1',
        messages: 'h2',
        revisions: 'h3',
        recovery_events: 'h4',
        raw_streams: 'h5',
        raw_stream_batches: 'h6',
      },
    };
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    // ON fb799d6: check.valid is TRUE because projectionState is NOT checked!
    // BUT EXPECTED: check.valid MUST BE FALSE!
    expect(check.valid).toBe(false);
  });
});
