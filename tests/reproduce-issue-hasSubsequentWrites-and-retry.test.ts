import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  commitStagingReplaceToLive,
  recoverIncompleteRestoreIfAny,
  retryPendingRestoreCleanup,
  setRestoreJournalMarker,
  type RestoreJournalMarker,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
} from '../src/storage/schema';
import type { Conversation, Message, ResponseRevision } from '../src/core/models';

describe('Reproduction: hasSubsequentWrites false integrity proof & unsafe retry cleanup', () => {
  const liveDbName = 'test_live_reproduce_defect';
  const stagingDbName = '_deepseek_archive_staging_replace_reproduce_100';
  const snapshotDbName = '_deepseek_archive_snapshot_replace_reproduce_100';

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

  it('REPRODUCES DEFECT 1: recoverIncompleteRestoreIfAny accepts corrupted old revision when new message is added', async () => {
    // 1. Seed baseline data into stagingDb and liveDb
    const conv1: Conversation = {
      id: 'c1',
      title: 'Conversation 1',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const msg1: Message = {
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const rev1: ResponseRevision = {
      id: 'r1',
      messageId: 'm1',
      revisionIndex: 0,
      text: 'Complete preserved answer',
      thinking: 'Original reasoning',
      source: 'network',
      capturedAt: 1000,
      isFinal: true,
      isLastGood: true,
    };

    // Save into stagingDb
    await new Promise<void>((resolve, reject) => {
      const tx = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv1);
      tx.objectStore(STORE_MESSAGES).put(msg1);
      tx.objectStore(STORE_REVISIONS).put(rev1);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Also seed into snapshotDb (safety snapshot of original state)
    await new Promise<void>((resolve, reject) => {
      const tx = snapshotDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv1);
      tx.objectStore(STORE_MESSAGES).put(msg1);
      tx.objectStore(STORE_REVISIONS).put(rev1);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Simulate confirmed commit in journal
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_repro_1',
      expectedCounts: {
        conversations: 1,
        messages: 1,
        revisions: 1,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      liveStoreCounts: {
        conversations: 1,
        messages: 1,
        revisions: 1,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
      liveStoreChecksums: {
        conversations: 'checksum_c1',
        messages: 'checksum_m1',
        revisions: 'checksum_r1',
        recovery_events: 'empty',
        raw_streams: 'empty',
        raw_stream_batches: 'empty',
      },
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // 2. CORRUPT r1 in liveDb!
    const corruptedRev1: ResponseRevision = {
      ...rev1,
      text: 'CORRUPTED', // Damaged text!
    };

    // 3. Add legitimate new message m2 and revision r2 into liveDb!
    const msg2: Message = {
      id: 'm2',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    const rev2: ResponseRevision = {
      id: 'r2',
      messageId: 'm2',
      revisionIndex: 0,
      text: 'New question',
      source: 'network',
      capturedAt: 2000,
      isFinal: true,
      isLastGood: true,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv1);
      tx.objectStore(STORE_MESSAGES).put(msg1);
      tx.objectStore(STORE_REVISIONS).put(corruptedRev1); // CORRUPTED
      tx.objectStore(STORE_MESSAGES).put(msg2); // NEW
      tx.objectStore(STORE_REVISIONS).put(rev2); // NEW
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // 4. Run recoverIncompleteRestoreIfAny()
    const recoveryResult = await recoverIncompleteRestoreIfAny(indexedDB);

    // IN VULNERABLE CODE: recoveryResult.state is 'recovered' (FALSE POSITIVE!)
    // Expected safe behavior: recoveryResult.state MUST NOT be 'recovered' because r1 was corrupted!
    console.log('REPRO DEFECT 1 result:', recoveryResult);

    // This assertion should FAIL on commit 5b3f71c:
    expect(recoveryResult.state).not.toBe('recovered');
  });

  it('REPRODUCES DEFECT 2: retryPendingRestoreCleanup cleans up snapshot without checking liveDb corruption', async () => {
    // Simulate hanging cleanup_pending marker
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_repro_2',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // Corrupt liveDb by clearing it or corrupting revisions
    await new Promise<void>((resolve, reject) => {
      const tx = liveDb.transaction([STORE_REVISIONS], 'readwrite');
      tx.objectStore(STORE_REVISIONS).put({
        id: 'r1',
        messageId: 'm1',
        text: 'CORRUPTED_TEXT',
        revisionIndex: 0,
        source: 'network',
        capturedAt: 1000,
        isFinal: true,
        isLastGood: true,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // In vulnerable code: retryPendingRestoreCleanup does not verify liveDb and deletes snapshot!
    const cleanupRes = await retryPendingRestoreCleanup(indexedDB);
    console.log('REPRO DEFECT 2 cleanupRes:', cleanupRes);

    // In safe code: retryPendingRestoreCleanup MUST refuse cleanup if liveDb is corrupted!
    expect(cleanupRes.snapshotDeleted).toBe(false);
  });
});
