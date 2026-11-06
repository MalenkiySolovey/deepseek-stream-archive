import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  recoverIncompleteRestoreIfAny,
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
import { computeContentFingerprint } from '../src/core/models/revision';

describe('Subsequent Writes vs Corruption Defense Suite (Tests A - G)', () => {
  const liveDbName = 'test_live_defense';
  const stagingDbName = '_deepseek_archive_staging_replace_defense_1';
  const snapshotDbName = '_deepseek_archive_snapshot_replace_defense_1';

  let liveDb: IDBDatabase;
  let stagingDb: IDBDatabase;
  let snapshotDb: IDBDatabase;

  const baseConv: Conversation = {
    id: 'c1',
    title: 'Baseline Conversation',
    createdAt: 1000,
    updatedAt: 1000,
  };
  const baseMsg: Message = {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    status: 'finished',
    identityState: 'reconciled',
    projectionState: 'logical',
    createdAt: 1000,
    updatedAt: 1000,
  };
  const baseRev: ResponseRevision = {
    id: 'r1',
    messageId: 'm1',
    revisionIndex: 0,
    text: 'Original verified answer',
    thinking: 'Valid deep reasoning',
    source: 'network',
    capturedAt: 1000,
    isFinal: true,
    isLastGood: true,
    contentFingerprint: computeContentFingerprint('Original verified answer', 'Valid deep reasoning', 'finished', 'network'),
  };

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

  async function seedStore(db: IDBDatabase, store: string, records: any[]) {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      for (const r of records) os.put(r);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REPLACE MODE (Tests A - F)
  // ───────────────────────────────────────────────────────────────────────────

  it('Test A (Replace): New record added, old data untouched -> verified and safe', async () => {
    // Staging contains baseline
    await seedStore(stagingDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(stagingDb, STORE_MESSAGES, [baseMsg]);
    await seedStore(stagingDb, STORE_REVISIONS, [baseRev]);

    // Snapshot exists
    await seedStore(snapshotDb, STORE_CONVERSATIONS, [baseConv]);

    // Marker cleanup_pending
    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_a',
      liveStoreCounts: { conversations: 1, messages: 1, revisions: 1 },
      liveStoreChecksums: { conversations: 'c_chk', messages: 'm_chk', revisions: 'r_chk' },
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // LiveDb has baseline + NEW valid message m2/r2
    const newMsg: Message = {
      id: 'm2',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    const newRev: ResponseRevision = {
      id: 'r2',
      messageId: 'm2',
      revisionIndex: 0,
      text: 'Follow up question',
      source: 'network',
      capturedAt: 2000,
      isFinal: true,
      isLastGood: true,
    };

    await seedStore(liveDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(liveDb, STORE_MESSAGES, [baseMsg, newMsg]);
    await seedStore(liveDb, STORE_REVISIONS, [baseRev, newRev]);

    const res = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(res.state).toBe('recovered');
  });

  it('Test B (Replace): Old revision corrupted AND new record added -> fails verification, snapshot preserved', async () => {
    await seedStore(stagingDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(stagingDb, STORE_MESSAGES, [baseMsg]);
    await seedStore(stagingDb, STORE_REVISIONS, [baseRev]);
    await seedStore(snapshotDb, STORE_CONVERSATIONS, [baseConv]);

    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_b',
      liveStoreCounts: { conversations: 1, messages: 1, revisions: 1 },
    };
    await setRestoreJournalMarker(marker, indexedDB);

    const corruptedRev: ResponseRevision = {
      ...baseRev,
      text: 'CORRUPTED', // text corrupted!
    };
    const newMsg: Message = {
      id: 'm2',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 2000,
      updatedAt: 2000,
    };
    const newRev: ResponseRevision = {
      id: 'r2',
      messageId: 'm2',
      revisionIndex: 0,
      text: 'New question',
      source: 'network',
      capturedAt: 2000,
      isFinal: true,
      isLastGood: true,
    };

    await seedStore(liveDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(liveDb, STORE_MESSAGES, [baseMsg, newMsg]);
    await seedStore(liveDb, STORE_REVISIONS, [corruptedRev, newRev]);

    const res = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(res.state).toBe('failed');
    expect((res as any).snapshotPreserved).toBe(true);
  });

  it('Test C (Replace): DeepThink corrupted AND new message added -> fails verification, snapshot preserved', async () => {
    await seedStore(stagingDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(stagingDb, STORE_MESSAGES, [baseMsg]);
    await seedStore(stagingDb, STORE_REVISIONS, [baseRev]);
    await seedStore(snapshotDb, STORE_CONVERSATIONS, [baseConv]);

    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_c',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    const corruptedDeepThink: ResponseRevision = {
      ...baseRev,
      thinking: 'TAMPERED_OR_CORRUPTED_DEEPTHINK',
    };
    const newMsg: Message = {
      id: 'm2',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 2000,
      updatedAt: 2000,
    };
    const newRev: ResponseRevision = {
      id: 'r2',
      messageId: 'm2',
      revisionIndex: 0,
      text: 'Valid question',
      source: 'network',
      capturedAt: 2000,
      isFinal: true,
      isLastGood: true,
    };

    await seedStore(liveDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(liveDb, STORE_MESSAGES, [baseMsg, newMsg]);
    await seedStore(liveDb, STORE_REVISIONS, [corruptedDeepThink, newRev]);

    const res = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(res.state).toBe('failed');
    expect((res as any).snapshotPreserved).toBe(true);
  });

  it('Test D (Replace): Existing record replaced with same ID, count grew -> fails verification', async () => {
    await seedStore(stagingDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(stagingDb, STORE_MESSAGES, [baseMsg]);
    await seedStore(stagingDb, STORE_REVISIONS, [baseRev]);
    await seedStore(snapshotDb, STORE_CONVERSATIONS, [baseConv]);

    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_d',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // Replace r1 with completely different text
    const replacedRev: ResponseRevision = {
      id: 'r1',
      messageId: 'm1',
      revisionIndex: 0,
      text: 'Different answer completely replacing r1',
      source: 'dom',
      capturedAt: 1500,
      isFinal: false,
      isLastGood: false,
    };
    const newMsg: Message = {
      id: 'm2',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 2000,
      updatedAt: 2000,
    };
    const newRev: ResponseRevision = {
      id: 'r2',
      messageId: 'm2',
      revisionIndex: 0,
      text: 'Question',
      source: 'network',
      capturedAt: 2000,
      isFinal: true,
      isLastGood: true,
    };

    await seedStore(liveDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(liveDb, STORE_MESSAGES, [baseMsg, newMsg]);
    await seedStore(liveDb, STORE_REVISIONS, [replacedRev, newRev]);

    const res = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(res.state).toBe('failed');
    expect((res as any).snapshotPreserved).toBe(true);
  });

  it('Test E (Replace): Old record deleted, several new records added -> loss of old record detected', async () => {
    await seedStore(stagingDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(stagingDb, STORE_MESSAGES, [baseMsg]);
    await seedStore(stagingDb, STORE_REVISIONS, [baseRev]);
    await seedStore(snapshotDb, STORE_CONVERSATIONS, [baseConv]);

    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_e',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // Old r1 is completely DELETED from liveDb, but m2, m3, r2, r3 added (total count > 1)
    const m2: Message = { id: 'm2', conversationId: 'c1', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 2000, updatedAt: 2000 };
    const r2: ResponseRevision = { id: 'r2', messageId: 'm2', revisionIndex: 0, text: 'Q2', source: 'network', capturedAt: 2000, isFinal: true, isLastGood: true };
    const m3: Message = { id: 'm3', conversationId: 'c1', role: 'assistant', status: 'finished', identityState: 'reconciled', createdAt: 3000, updatedAt: 3000 };
    const r3: ResponseRevision = { id: 'r3', messageId: 'm3', revisionIndex: 0, text: 'A3', source: 'network', capturedAt: 3000, isFinal: true, isLastGood: true };

    await seedStore(liveDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(liveDb, STORE_MESSAGES, [baseMsg, m2, m3]);
    await seedStore(liveDb, STORE_REVISIONS, [r2, r3]); // r1 missing!

    const res = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(res.state).toBe('failed');
    expect((res as any).snapshotPreserved).toBe(true);
  });

  it('Test F (Replace): Legitimate new revision added to existing message -> passes verification', async () => {
    await seedStore(stagingDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(stagingDb, STORE_MESSAGES, [baseMsg]);
    await seedStore(stagingDb, STORE_REVISIONS, [baseRev]);
    await seedStore(snapshotDb, STORE_CONVERSATIONS, [baseConv]);

    const marker: RestoreJournalMarker = {
      type: 'replace',
      stage: 'cleanup_pending',
      liveDbName,
      stagingDbName,
      snapshotDbName,
      timestamp: Date.now(),
      operationId: 'op_f',
    };
    await setRestoreJournalMarker(marker, indexedDB);

    // Old r1 is intact. New revision r2 is added for the SAME message m1 (regeneration / edit turn)
    const legRev2: ResponseRevision = {
      id: 'r2',
      messageId: 'm1',
      revisionIndex: 1,
      text: 'Regenerated second answer',
      thinking: 'Second thinking session',
      source: 'network',
      capturedAt: 2500,
      isFinal: true,
      isLastGood: true,
    };

    const updatedBaseMsg: Message = {
      ...baseMsg,
      updatedAt: 2500, // Legitimate updatedAt advance
    };

    await seedStore(liveDb, STORE_CONVERSATIONS, [baseConv]);
    await seedStore(liveDb, STORE_MESSAGES, [updatedBaseMsg]);
    await seedStore(liveDb, STORE_REVISIONS, [baseRev, legRev2]);

    const res = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(res.state).toBe('recovered');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // MERGE MODE (Test G: repeats B - F for merge)
  // ───────────────────────────────────────────────────────────────────────────

  describe('Test G: Merge Mode Suite', () => {
    const snapConv: Conversation = { id: 'c_snap', title: 'Snapshot Conv', createdAt: 500, updatedAt: 500 };
    const snapMsg: Message = { id: 'm_snap', conversationId: 'c_snap', role: 'assistant', status: 'finished', identityState: 'reconciled', createdAt: 500, updatedAt: 500 };
    const snapRev: ResponseRevision = { id: 'r_snap', messageId: 'm_snap', revisionIndex: 0, text: 'Pre-existing snap answer', source: 'network', capturedAt: 500, isFinal: true, isLastGood: true };

    const stagConv: Conversation = { id: 'c_stag', title: 'Staging Conv', createdAt: 1000, updatedAt: 1000 };
    const stagMsg: Message = { id: 'm_stag', conversationId: 'c_stag', role: 'assistant', status: 'finished', identityState: 'reconciled', createdAt: 1000, updatedAt: 1000 };
    const stagRev: ResponseRevision = { id: 'r_stag', messageId: 'm_stag', revisionIndex: 0, text: 'Imported stag answer', source: 'network', capturedAt: 1000, isFinal: true, isLastGood: true };

    async function setupMergeBaseline() {
      // SnapshotDb has snap records
      await seedStore(snapshotDb, STORE_CONVERSATIONS, [snapConv]);
      await seedStore(snapshotDb, STORE_MESSAGES, [snapMsg]);
      await seedStore(snapshotDb, STORE_REVISIONS, [snapRev]);

      // StagingDb has stag records
      await seedStore(stagingDb, STORE_CONVERSATIONS, [stagConv]);
      await seedStore(stagingDb, STORE_MESSAGES, [stagMsg]);
      await seedStore(stagingDb, STORE_REVISIONS, [stagRev]);

      const marker: RestoreJournalMarker = {
        type: 'merge',
        stage: 'cleanup_pending',
        liveDbName,
        stagingDbName,
        snapshotDbName,
        timestamp: Date.now(),
        operationId: 'op_merge_g',
      };
      await setRestoreJournalMarker(marker, indexedDB);
    }

    it('Test G - A: Merge succeeds with untouched merged data + new record', async () => {
      await setupMergeBaseline();

      const newMsg: Message = { id: 'm_new', conversationId: 'c_snap', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 3000, updatedAt: 3000 };
      const newRev: ResponseRevision = { id: 'r_new', messageId: 'm_new', revisionIndex: 0, text: 'New query', source: 'network', capturedAt: 3000, isFinal: true, isLastGood: true };

      await seedStore(liveDb, STORE_CONVERSATIONS, [snapConv, stagConv]);
      await seedStore(liveDb, STORE_MESSAGES, [snapMsg, stagMsg, newMsg]);
      await seedStore(liveDb, STORE_REVISIONS, [snapRev, stagRev, newRev]);

      const res = await recoverIncompleteRestoreIfAny(indexedDB);
      expect(res.state).toBe('recovered');
    });

    it('Test G - B: Old revision corrupted in Merge + new record added -> fails verification', async () => {
      await setupMergeBaseline();

      const corruptedSnapRev: ResponseRevision = { ...snapRev, text: 'CORRUPTED_MERGE_SNAP' };
      const newMsg: Message = { id: 'm_new', conversationId: 'c_snap', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 3000, updatedAt: 3000 };
      const newRev: ResponseRevision = { id: 'r_new', messageId: 'm_new', revisionIndex: 0, text: 'New query', source: 'network', capturedAt: 3000, isFinal: true, isLastGood: true };

      await seedStore(liveDb, STORE_CONVERSATIONS, [snapConv, stagConv]);
      await seedStore(liveDb, STORE_MESSAGES, [snapMsg, stagMsg, newMsg]);
      await seedStore(liveDb, STORE_REVISIONS, [corruptedSnapRev, stagRev, newRev]);

      const res = await recoverIncompleteRestoreIfAny(indexedDB);
      expect(res.state).toBe('failed');
      expect((res as any).snapshotPreserved).toBe(true);
    });

    it('Test G - C: DeepThink corrupted on imported staging revision + new record -> fails verification', async () => {
      await setupMergeBaseline();

      const corruptedStagRev: ResponseRevision = { ...stagRev, thinking: 'CORRUPTED_DEEPTHINK' };
      const newMsg: Message = { id: 'm_new', conversationId: 'c_stag', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 3000, updatedAt: 3000 };
      const newRev: ResponseRevision = { id: 'r_new', messageId: 'm_new', revisionIndex: 0, text: 'New query', source: 'network', capturedAt: 3000, isFinal: true, isLastGood: true };

      await seedStore(liveDb, STORE_CONVERSATIONS, [snapConv, stagConv]);
      await seedStore(liveDb, STORE_MESSAGES, [snapMsg, stagMsg, newMsg]);
      await seedStore(liveDb, STORE_REVISIONS, [snapRev, corruptedStagRev, newRev]);

      const res = await recoverIncompleteRestoreIfAny(indexedDB);
      expect(res.state).toBe('failed');
      expect((res as any).snapshotPreserved).toBe(true);
    });

    it('Test G - D: Existing record replaced under same ID in Merge -> fails verification', async () => {
      await setupMergeBaseline();

      const replacedRev: ResponseRevision = { id: 'r_snap', messageId: 'm_snap', revisionIndex: 0, text: 'Replaced text in snap rev', source: 'dom', capturedAt: 2000, isFinal: false, isLastGood: false };
      const newMsg: Message = { id: 'm_new', conversationId: 'c_snap', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 3000, updatedAt: 3000 };
      const newRev: ResponseRevision = { id: 'r_new', messageId: 'm_new', revisionIndex: 0, text: 'New query', source: 'network', capturedAt: 3000, isFinal: true, isLastGood: true };

      await seedStore(liveDb, STORE_CONVERSATIONS, [snapConv, stagConv]);
      await seedStore(liveDb, STORE_MESSAGES, [snapMsg, stagMsg, newMsg]);
      await seedStore(liveDb, STORE_REVISIONS, [replacedRev, stagRev, newRev]);

      const res = await recoverIncompleteRestoreIfAny(indexedDB);
      expect(res.state).toBe('failed');
      expect((res as any).snapshotPreserved).toBe(true);
    });

    it('Test G - E: Pre-existing record deleted from liveDb during Merge -> fails verification', async () => {
      await setupMergeBaseline();

      // r_snap deleted from liveDb, but new records added
      const m2: Message = { id: 'm2', conversationId: 'c_snap', role: 'user', status: 'finished', identityState: 'reconciled', createdAt: 3000, updatedAt: 3000 };
      const r2: ResponseRevision = { id: 'r2', messageId: 'm2', revisionIndex: 0, text: 'Q', source: 'network', capturedAt: 3000, isFinal: true, isLastGood: true };

      await seedStore(liveDb, STORE_CONVERSATIONS, [snapConv, stagConv]);
      await seedStore(liveDb, STORE_MESSAGES, [snapMsg, stagMsg, m2]);
      await seedStore(liveDb, STORE_REVISIONS, [stagRev, r2]); // r_snap missing!

      const res = await recoverIncompleteRestoreIfAny(indexedDB);
      expect(res.state).toBe('failed');
      expect((res as any).snapshotPreserved).toBe(true);
    });

    it('Test G - F: Legitimate new revision on merged message -> passes verification', async () => {
      await setupMergeBaseline();

      // Legitimate second revision on m_stag
      const legRev2: ResponseRevision = {
        id: 'r_stag_2',
        messageId: 'm_stag',
        revisionIndex: 1,
        text: 'Regenerated response on imported message',
        source: 'network',
        capturedAt: 2500,
        isFinal: true,
        isLastGood: true,
      };

      await seedStore(liveDb, STORE_CONVERSATIONS, [snapConv, stagConv]);
      await seedStore(liveDb, STORE_MESSAGES, [snapMsg, stagMsg]);
      await seedStore(liveDb, STORE_REVISIONS, [snapRev, stagRev, legRev2]);

      const res = await recoverIncompleteRestoreIfAny(indexedDB);
      expect(res.state).toBe('recovered');
    });
  });
});
