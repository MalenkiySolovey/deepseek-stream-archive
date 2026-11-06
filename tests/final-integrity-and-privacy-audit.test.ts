import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  setRestoreJournalMarker,
  verifyRestoredBaselinePreserved,
  checkMessageTreeCycle,
  recoverIncompleteRestoreIfAny,
  type RestoreJournalMarker,
} from '../src/restore/staging-service';
import { openExtensionDatabase } from '../src/storage/db';
import {
  STORE_MESSAGES,
  STORE_CONVERSATIONS,
  STORE_REVISIONS,
} from '../src/storage/schema';
import type { Message, Conversation, ResponseRevision } from '../src/core/models';

describe('Final Integrity and Privacy Audit Suite (Defects 1, 2, 3 & Regression Protection)', () => {
  const liveDbName = 'test_live_audit_final';
  const stagingDbName = '_deepseek_archive_staging_audit_final_100';
  const snapshotDbName = '_deepseek_archive_snapshot_audit_final_100';

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
    operationId: 'audit-op-final',
    timestamp: 1000,
    stage: 'cleanup_pending',
    type: 'replace',
    liveDbName: liveDbName,
    stagingDbName: stagingDbName,
    snapshotDbName: snapshotDbName,
  });

  // ─── 1. Tree Root Relocation & Arbitrary Cycles Defense (Defect 1) ───

  describe('1. Root Message Protection & Cycle Defense', () => {
    it('1.1: Rejects relocation of confirmed root message without remoteParentId', async () => {
      const conv: Conversation = { id: 'c1', title: 'Root test', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = {
        id: 'u1',
        conversationId: 'c1',
        role: 'user',
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
        content: 'Original root prompt',
        createdAt: 1000,
        updatedAt: 1000,
      };
      const a1: Message = {
        id: 'a1',
        conversationId: 'c1',
        parentId: 'u1',
        remoteId: 'remote-a1',
        role: 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
        content: 'Answer',
        createdAt: 1010,
        updatedAt: 1010,
      };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      // In liveDb, u1 is given parentId = 'a1' and remoteParentId = 'remote-a1'
      const u1Relocated: Message = {
        ...u1,
        parentId: 'a1',
        remoteParentId: 'remote-a1',
      };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1Relocated);
      txL.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(false);
      expect(check.reason).toMatch(/cycle|relocated/i);

      // Verify recoverIncompleteRestore preserves snapshot
      const rec = await recoverIncompleteRestoreIfAny(indexedDB);
      expect(rec.state).toBe('failed');
      expect((rec as any).snapshotPreserved).toBe(true);
    });

    it('1.2: Rejects arbitrary multi-node cycle (u1 -> a1 -> u2 -> a2 -> u1)', async () => {
      const conv: Conversation = { id: 'c1', title: 'Multi-node cycle test', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c1', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q1', createdAt: 1000, updatedAt: 1000 };
      const a1: Message = { id: 'a1', conversationId: 'c1', parentId: 'u1', role: 'assistant', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'A1', createdAt: 1010, updatedAt: 1010 };
      const u2: Message = { id: 'u2', conversationId: 'c1', parentId: 'a1', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q2', createdAt: 1020, updatedAt: 1020 };
      const a2: Message = { id: 'a2', conversationId: 'c1', parentId: 'u2', role: 'assistant', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'A2', createdAt: 1030, updatedAt: 1030 };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      txS.objectStore(STORE_MESSAGES).put(u2);
      txS.objectStore(STORE_MESSAGES).put(a2);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      // In liveDb, make u1 point to a2 (cycle of 4 nodes: u1 -> a1 -> u2 -> a2 -> u1)
      const u1Cycled: Message = { ...u1, parentId: 'a2' };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1Cycled);
      txL.objectStore(STORE_MESSAGES).put(a1);
      txL.objectStore(STORE_MESSAGES).put(u2);
      txL.objectStore(STORE_MESSAGES).put(a2);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(false);
      expect(check.reason).toMatch(/cycle|relocated/i);
    });

    it('1.3: Allows legitimate refinement when baseline HAD remoteParentId', async () => {
      const conv: Conversation = { id: 'c1', title: 'Refinement test', createdAt: 1000, updatedAt: 1000 };
      // In baseline: u2 has remoteParentId = 'remote-a1', but parentId = undefined (or raw remoteParentId)
      const u1: Message = { id: 'u1', conversationId: 'c1', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q1', createdAt: 1000, updatedAt: 1000 };
      const a1: Message = { id: 'a1', conversationId: 'c1', parentId: 'u1', remoteId: 'remote-a1', role: 'assistant', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'A1', createdAt: 1010, updatedAt: 1010 };
      const u2Baseline: Message = {
        id: 'u2',
        conversationId: 'c1',
        remoteParentId: 'remote-a1',
        parentId: undefined, // provisional/unresolved in baseline
        role: 'user',
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
        content: 'Q2',
        createdAt: 1020,
        updatedAt: 1020,
      };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      txS.objectStore(STORE_MESSAGES).put(u2Baseline);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      // In liveDb: u2 resolved parentId to 'a1' (whose remoteId is 'remote-a1')
      const u2Resolved: Message = {
        ...u2Baseline,
        parentId: 'a1',
        updatedAt: 1030,
      };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1);
      txL.objectStore(STORE_MESSAGES).put(a1);
      txL.objectStore(STORE_MESSAGES).put(u2Resolved);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(true);
    });

    it('1.4: Preserves Edit and Regenerate branches as legitimate subsequent writes', async () => {
      const conv: Conversation = { id: 'c1', title: 'Edit & Regenerate conversation', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c1', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Prompt 1', createdAt: 1000, updatedAt: 1000 };
      const a1: Message = { id: 'a1', conversationId: 'c1', parentId: 'u1', role: 'assistant', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Answer 1', createdAt: 1010, updatedAt: 1010 };

      // Baseline has u1 and a1
      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      // LiveDb has:
      // 1. Unchanged u1 and a1
      // 2. Regenerated response a1_v2 (sibling of a1, parent = u1)
      const a1_v2: Message = { id: 'a1_v2', conversationId: 'c1', parentId: 'u1', role: 'assistant', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Regenerated Answer', createdAt: 1020, updatedAt: 1020 };
      // 3. Edited user prompt u1_edit (sibling of u1, parent = undefined) + answer a1_edit
      const u1_edit: Message = { id: 'u1_edit', conversationId: 'c1', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Edited prompt', createdAt: 1030, updatedAt: 1030 };
      const a1_edit: Message = { id: 'a1_edit', conversationId: 'c1', parentId: 'u1_edit', role: 'assistant', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Answer to edit', createdAt: 1040, updatedAt: 1040 };

      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1);
      txL.objectStore(STORE_MESSAGES).put(a1);
      txL.objectStore(STORE_MESSAGES).put(a1_v2);
      txL.objectStore(STORE_MESSAGES).put(u1_edit);
      txL.objectStore(STORE_MESSAGES).put(a1_edit);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(true);

      const rec = await recoverIncompleteRestoreIfAny(indexedDB);
      expect(rec.state).toBe('recovered');
    });
  });

  // ─── 2. Empty Content on Finished Assistant Message (Defect 2) ───

  describe('2. Empty Content & Finished Assistant Response Protection', () => {
    it('2.1: finished, content = "" -> arbitrary text: FAIL', async () => {
      const conv: Conversation = { id: 'c2', title: 'T2', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c2', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q', createdAt: 1000, updatedAt: 1000 };
      const a1: Message = { id: 'a1', conversationId: 'c2', parentId: 'u1', role: 'assistant', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: '', createdAt: 1010, updatedAt: 1010 };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      const a1Mutated: Message = { ...a1, content: 'Injected text into finished' };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1);
      txL.objectStore(STORE_MESSAGES).put(a1Mutated);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('content mismatch in field "content"');
    });

    it('2.2: filtered, content = "" -> arbitrary text: FAIL', async () => {
      const conv: Conversation = { id: 'c2', title: 'T2', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c2', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q', createdAt: 1000, updatedAt: 1000 };
      const a1: Message = { id: 'a1', conversationId: 'c2', parentId: 'u1', role: 'assistant', status: 'filtered', identityState: 'reconciled', projectionState: 'logical', content: '', createdAt: 1010, updatedAt: 1010 };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      const a1Mutated: Message = { ...a1, content: 'Bypassed filter text' };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1);
      txL.objectStore(STORE_MESSAGES).put(a1Mutated);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('content mismatch in field "content"');
    });

    it('2.3: streaming, content = "" -> legitimate next chunk: PASS', async () => {
      const conv: Conversation = { id: 'c2', title: 'T2', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c2', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q', createdAt: 1000, updatedAt: 1000 };
      // a1 in baseline was streaming with empty content
      const a1: Message = { id: 'a1', conversationId: 'c2', parentId: 'u1', role: 'assistant', status: 'streaming', identityState: 'provisional', projectionState: 'provisional_logical', content: '', createdAt: 1010, updatedAt: 1010 };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      // In liveDb, stream completed and produced content
      const a1Finished: Message = { ...a1, status: 'finished', content: 'Completed streaming answer', updatedAt: 1050 };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1);
      txL.objectStore(STORE_MESSAGES).put(a1Finished);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(true);
    });

    it('2.4: streaming, non-empty text -> correct continuation prefix: PASS', async () => {
      const conv: Conversation = { id: 'c2', title: 'T2', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c2', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q', createdAt: 1000, updatedAt: 1000 };
      const a1: Message = { id: 'a1', conversationId: 'c2', parentId: 'u1', role: 'assistant', status: 'streaming', identityState: 'provisional', projectionState: 'provisional_logical', content: 'First token... ', createdAt: 1010, updatedAt: 1010 };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      // In liveDb, stream continued from 'First token... ' to full sentence
      const a1Continued: Message = { ...a1, status: 'finished', content: 'First token... and second token.', updatedAt: 1050 };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1);
      txL.objectStore(STORE_MESSAGES).put(a1Continued);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(true);
    });

    it('2.5: streaming, non-empty text -> incompatible mutated text: FAIL', async () => {
      const conv: Conversation = { id: 'c2', title: 'T2', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c2', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q', createdAt: 1000, updatedAt: 1000 };
      const a1: Message = { id: 'a1', conversationId: 'c2', parentId: 'u1', role: 'assistant', status: 'streaming', identityState: 'provisional', projectionState: 'provisional_logical', content: 'Prefix A', createdAt: 1010, updatedAt: 1010 };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      // In liveDb, text was replaced with something not starting with 'Prefix A'
      const a1Mutated: Message = { ...a1, status: 'finished', content: 'Completely different text', updatedAt: 1050 };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1);
      txL.objectStore(STORE_MESSAGES).put(a1Mutated);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('content was mutated without legitimate streaming continuation');
    });

    it('2.6: Finished message with preserved ResponseRevisions: no revision is lost or mutated', async () => {
      const conv: Conversation = { id: 'c2', title: 'T2', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c2', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q', createdAt: 1000, updatedAt: 1000 };
      // a1 content in Message is empty, but has revisions in STORE_REVISIONS
      const a1: Message = { id: 'a1', conversationId: 'c2', parentId: 'u1', role: 'assistant', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: '', createdAt: 1010, updatedAt: 1010 };
      const rev1: ResponseRevision = {
        id: 'rev-1',
        messageId: 'a1',
        revisionIndex: 1,
        text: 'Historical revision text from assistant',
        source: 'network',
        capturedAt: 1010,
        isFinal: true,
        isLastGood: true,
      };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      txS.objectStore(STORE_REVISIONS).put(rev1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      // In liveDb, rev1 is corrupted in text
      const rev1Corrupted: ResponseRevision = {
        ...rev1,
        text: 'Corrupted revision text',
      };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1);
      txL.objectStore(STORE_MESSAGES).put(a1);
      txL.objectStore(STORE_REVISIONS).put(rev1Corrupted);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(false);
      expect(check.reason).toContain('revisions');
      expect(check.reason).toContain('modified or corrupted');
    });
  });

  // ─── 3. Privacy: No Private User Text in Diagnostics (Defect 3) ───

  describe('3. Privacy Invariants: No Conversation Text Leaks in Diagnostics', () => {
    it('3.1: Special secret marker in user prompt NEVER appears in diagnostic message', async () => {
      const secretMarker = 'USER_HIGHLY_CONFIDENTIAL_MARKER_998877';
      const mutatedMarker = 'MUTATED_CONFIDENTIAL_REPLACEMENT_112233';

      const conv: Conversation = { id: 'c3', title: 'T3', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c3', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: secretMarker, createdAt: 1000, updatedAt: 1000 };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      const u1Mutated: Message = { ...u1, content: mutatedMarker };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1Mutated);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(false);
      expect(check.reason).toBeDefined();

      // STRICT PRIVACY GUARANTEES:
      expect(check.reason).not.toContain(secretMarker);
      expect(check.reason).not.toContain(mutatedMarker);
      // Technical fields must be present:
      expect(check.reason).toContain('u1');
      expect(check.reason).toContain('content mismatch in field "content"');
      expect(check.reason).toContain('length');
    });

    it('3.2: Special secret marker in assistant response NEVER appears in diagnostic message', async () => {
      const assistantSecret = 'ASSISTANT_SECRET_PROPRIETARY_RESPONSE_XYZ';
      const assistantMutated = 'ASSISTANT_MUTATED_WRONG_TEXT_ABC';

      const conv: Conversation = { id: 'c3', title: 'T3', createdAt: 1000, updatedAt: 1000 };
      const u1: Message = { id: 'u1', conversationId: 'c3', role: 'user', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: 'Q', createdAt: 1000, updatedAt: 1000 };
      const a1: Message = { id: 'a1', conversationId: 'c3', parentId: 'u1', role: 'assistant', status: 'finished', identityState: 'reconciled', projectionState: 'logical', content: assistantSecret, createdAt: 1010, updatedAt: 1010 };

      const txS = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txS.objectStore(STORE_CONVERSATIONS).put(conv);
      txS.objectStore(STORE_MESSAGES).put(u1);
      txS.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (txS.oncomplete = () => r(null)));

      const a1Mutated: Message = { ...a1, content: assistantMutated };
      const txL = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      txL.objectStore(STORE_CONVERSATIONS).put(conv);
      txL.objectStore(STORE_MESSAGES).put(u1);
      txL.objectStore(STORE_MESSAGES).put(a1Mutated);
      await new Promise((r) => (txL.oncomplete = () => r(null)));

      const marker = makeMarker();
      await setRestoreJournalMarker(marker, indexedDB);

      const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
      expect(check.valid).toBe(false);
      expect(check.reason).toBeDefined();

      // STRICT PRIVACY GUARANTEES:
      expect(check.reason).not.toContain(assistantSecret);
      expect(check.reason).not.toContain(assistantMutated);
      expect(check.reason).toContain('a1');
      expect(check.reason).toContain('content mismatch in field "content"');
      expect(check.reason).toContain('length');
    });
  });
});
