import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  setRestoreJournalMarker,
  verifyRestoredBaselinePreserved,
  type RestoreJournalMarker,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';
import {
  STORE_MESSAGES,
  STORE_CONVERSATIONS,
} from '../src/storage/schema';
import type { Message, Conversation } from '../src/core/models';

describe('Reproduce Final Integrity Defects (Commit f6d4c3a)', () => {
  const liveDbName = 'test_live_final_defects';
  const stagingDbName = '_deepseek_archive_staging_replace_final_100';
  const snapshotDbName = '_deepseek_archive_snapshot_replace_final_100';

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

  const makeMarker = (): RestoreJournalMarker => ({
    operationId: 'reproduce-op-final',
    timestamp: 1000,
    stage: 'cleanup_pending',
    type: 'replace',
    liveDbName: liveDbName,
    stagingDbName: stagingDbName,
    snapshotDbName: snapshotDbName,
  });

  it('Defect 1: Moving confirmed root under a1 via new remoteParentId causes cycle and falsely passes on base commit', async () => {
    const conv: Conversation = { id: 'c1', title: 'Cycle conversation', createdAt: 1000, updatedAt: 1000 };
    // Baseline: u1 is ROOT (no parentId, no remoteParentId)
    const u1: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Hello root',
      createdAt: 1000,
      updatedAt: 1000,
    };
    // a1 is child of u1
    const a1: Message = {
      id: 'a1',
      conversationId: 'c1',
      parentId: 'u1',
      remoteId: 'remote-a1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Assistant answer',
      createdAt: 1010,
      updatedAt: 1010,
    };

    // Save baseline to staging
    await new Promise<void>((resolve, reject) => {
      const tx = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.objectStore(STORE_MESSAGES).put(a1);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // In liveDb, u1 is mutated: parentId = 'a1', remoteParentId = 'remote-a1'
    // This creates a cycle: u1 -> a1 -> u1!
    const u1Mutated: Message = {
      ...u1,
      parentId: 'a1',
      remoteParentId: 'remote-a1',
      updatedAt: 1020,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1Mutated);
      tx.objectStore(STORE_MESSAGES).put(a1);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const marker = makeMarker();
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    // ON BASE COMMIT: check.valid is TRUE (DEFECT!)
    // EXPECTATION: Should be FALSE (cycle + moving root message)
    expect(check.valid).toBe(false);
  });

  it('Defect 2: Changing empty content on finished assistant message falsely passes on base commit', async () => {
    const conv: Conversation = { id: 'c2', title: 'Empty content conversation', createdAt: 1000, updatedAt: 1000 };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c2',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Question',
      createdAt: 1000,
      updatedAt: 1000,
    };
    // a1 has empty content in Message, but status finished
    const a1: Message = {
      id: 'a1',
      conversationId: 'c2',
      parentId: 'u1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: '', // Empty content in Message record!
      createdAt: 1010,
      updatedAt: 1010,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.objectStore(STORE_MESSAGES).put(a1);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // In liveDb, a1 content was mutated to arbitrary text!
    const a1Mutated: Message = {
      ...a1,
      content: 'Injected arbitrary text into finished response',
      updatedAt: 1020,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.objectStore(STORE_MESSAGES).put(a1Mutated);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const marker = makeMarker();
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    // ON BASE COMMIT: check.valid is TRUE (DEFECT!)
    // EXPECTATION: Should be FALSE
    expect(check.valid).toBe(false);
  });

  it('Defect 3: Leaking private user prompt in diagnostic error message on base commit', async () => {
    const canarySecret = 'CANARY_SECRET_PROMPT_XYZ';
    const mutatedSecret = 'CANARY_MUTATED_SECRET_ABC';

    const conv: Conversation = { id: 'c3', title: 'Private conversation', createdAt: 1000, updatedAt: 1000 };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c3',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: canarySecret,
      createdAt: 1000,
      updatedAt: 1000,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const u1Mutated: Message = {
      ...u1,
      content: mutatedSecret,
      updatedAt: 1020,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1Mutated);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const marker = makeMarker();
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(false);

    // Diagnostics must NOT contain the canary user text!
    expect(check.reason).toBeDefined();
    // ON BASE COMMIT: check.reason contains canarySecret and mutatedSecret (DEFECT!)
    expect(check.reason).not.toContain(canarySecret);
    expect(check.reason).not.toContain(mutatedSecret);
  });
});
