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

describe('Message and Conversation Baseline Audit Matrix (Replace & Merge)', () => {
  const liveDbName = 'test_live_msg_matrix';
  const stagingDbName = '_deepseek_archive_staging_replace_matrix_1';
  const snapshotDbName = '_deepseek_archive_snapshot_replace_matrix_1';

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

  // Helper to make marker
  const makeMarker = (type: 'replace' | 'merge', stage: 'cleanup_pending' | 'commit_verified' = 'cleanup_pending'): RestoreJournalMarker => ({
    type,
    stage,
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
      conversations: 'h_conv',
      messages: 'h_msg',
      revisions: 'h_rev',
      recovery_events: 'h_rec',
      raw_streams: 'h_raw',
      raw_stream_batches: 'h_batch',
    },
  });

  // 1. Replace: Old USER received different text
  it('Replace Matrix 1: Old USER received different content -> FAIL, snapshot preserved', async () => {
    const conv: Conversation = { id: 'c1', title: 'Test Conv', createdAt: 1000, updatedAt: 1000 };
    const userMsg: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Назови три закона робототехники',
      createdAt: 1000,
      updatedAt: 1000,
    };

    // Staging and snapshot have pristine userMsg
    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(userMsg);
      await new Promise((r) => (tx.oncomplete = r));
    }

    // LiveDb has corrupted user content + added subsequent message
    const corruptedUser: Message = { ...userMsg, content: 'Повреждённый текст', updatedAt: 1200 };
    const subsequentMsg: Message = {
      id: 'sub-1',
      conversationId: 'c1',
      parentId: 'u1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 2000,
      updatedAt: 2000,
    };

    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(corruptedUser);
    ltx.objectStore(STORE_MESSAGES).put(subsequentMsg);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('content mismatch');

    const recoveryRes = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(recoveryRes.state).toBe('failed');
    expect((recoveryRes as any).snapshotPreserved).toBe(true);
  });

  // 2. Replace: USER parentId substituted to another branch
  it('Replace Matrix 2: USER parentId substituted to wrong branch -> FAIL, snapshot preserved', async () => {
    const conv: Conversation = { id: 'c1', title: 'Branching tree', createdAt: 1000, updatedAt: 1000 };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Prompt 1',
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
      parentId: 'a1b', // Connected under a1b in baseline
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Prompt 2',
      createdAt: 1300,
      updatedAt: 1300,
    };

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.objectStore(STORE_MESSAGES).put(a1a);
      tx.objectStore(STORE_MESSAGES).put(a1b);
      tx.objectStore(STORE_MESSAGES).put(u2);
      await new Promise((r) => (tx.oncomplete = r));
    }

    // Corrupt u2 parentId in liveDb to a1a + subsequent write
    const corruptedU2: Message = { ...u2, parentId: 'a1a', updatedAt: 1500 };
    const subsequentMsg: Message = {
      id: 'sub-2',
      conversationId: 'c1',
      parentId: 'u2',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 2000,
      updatedAt: 2000,
    };

    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(u1);
    ltx.objectStore(STORE_MESSAGES).put(a1a);
    ltx.objectStore(STORE_MESSAGES).put(a1b);
    ltx.objectStore(STORE_MESSAGES).put(corruptedU2);
    ltx.objectStore(STORE_MESSAGES).put(subsequentMsg);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('parentId was substituted');

    const recoveryRes = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(recoveryRes.state).toBe('failed');
    expect((recoveryRes as any).snapshotPreserved).toBe(true);
  });

  // 3. Replace: logical -> attempt_only without justification
  it('Replace Matrix 3: Message projectionState logical -> attempt_only -> FAIL, snapshot preserved', async () => {
    const conv: Conversation = { id: 'c1', title: 'Conv', createdAt: 1000, updatedAt: 1000 };
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

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(msg);
      await new Promise((r) => (tx.oncomplete = r));
    }

    const corruptedMsg: Message = { ...msg, projectionState: 'attempt_only', updatedAt: 1500 };
    const subMsg: Message = {
      id: 'sub-3',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'New prompt',
      createdAt: 2000,
      updatedAt: 2000,
    };

    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(corruptedMsg);
    ltx.objectStore(STORE_MESSAGES).put(subMsg);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('projectionState');
  });

  // 4. Replace: Filtered response lost its status
  it('Replace Matrix 4: Filtered response status changed filtered -> finished -> FAIL', async () => {
    const conv: Conversation = { id: 'c1', title: 'Conv', createdAt: 1000, updatedAt: 1000 };
    const msg: Message = {
      id: 'm-censored',
      conversationId: 'c1',
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1000,
      updatedAt: 1000,
    };

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(msg);
      await new Promise((r) => (tx.oncomplete = r));
    }

    const corruptedMsg: Message = { ...msg, status: 'finished', updatedAt: 1500 };
    const subMsg: Message = {
      id: 'sub-4',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Another prompt',
      createdAt: 2000,
      updatedAt: 2000,
    };

    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(corruptedMsg);
    ltx.objectStore(STORE_MESSAGES).put(subMsg);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('lost its filtered status');
  });

  // 5. Replace: Added new correct message (subsequent legitimate writes) -> PASS
  it('Replace Matrix 5: Added new correct message without mutating baseline -> PASS', async () => {
    const conv: Conversation = { id: 'c1', title: 'Conv', createdAt: 1000, updatedAt: 1000 };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Original user question',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const a1: Message = {
      id: 'a1',
      conversationId: 'c1',
      parentId: 'u1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1100,
      updatedAt: 1100,
    };

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (tx.oncomplete = r));
    }

    // In liveDb: baseline records are 100% intact, and a subsequent user prompt is appended
    const u2: Message = {
      id: 'u2',
      conversationId: 'c1',
      parentId: 'a1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Subsequent user follow-up',
      createdAt: 2000,
      updatedAt: 2000,
    };

    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(u1);
    ltx.objectStore(STORE_MESSAGES).put(a1);
    ltx.objectStore(STORE_MESSAGES).put(u2);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(true);

    const recoveryRes = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(recoveryRes.state).toBe('recovered');
  });

  // 6. Replace: Added new revision, old revision untouched -> PASS
  it('Replace Matrix 6: Added new revision to message, old revision untouched -> PASS', async () => {
    const conv: Conversation = { id: 'c1', title: 'Conv', createdAt: 1000, updatedAt: 1000 };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Prompt',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const a1: Message = {
      id: 'a1',
      conversationId: 'c1',
      parentId: 'u1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1100,
      updatedAt: 1100,
    };
    const r0: ResponseRevision = {
      id: 'rev-0',
      messageId: 'a1',
      revisionIndex: 0,
      text: 'First version of answer',
      source: 'network',
      capturedAt: 1100,
      isFinal: true,
      isLastGood: true,
    };

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.objectStore(STORE_MESSAGES).put(a1);
      tx.objectStore(STORE_REVISIONS).put(r0);
      await new Promise((r) => (tx.oncomplete = r));
    }

    // In liveDb: rev-0 untouched, new rev-1 added
    const r1: ResponseRevision = {
      id: 'rev-1',
      messageId: 'a1',
      revisionIndex: 1,
      text: 'Second version of answer',
      source: 'network',
      capturedAt: 1200,
      isFinal: true,
      isLastGood: false,
    };

    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(u1);
    ltx.objectStore(STORE_MESSAGES).put(a1);
    ltx.objectStore(STORE_REVISIONS).put(r0);
    ltx.objectStore(STORE_REVISIONS).put(r1);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(true);
  });

  // 7. Replace: Confirmed parentId refinement upon server history reconciliation -> PASS
  it('Replace Matrix 7: Confirmed parentId refinement matching remoteParentId -> PASS', async () => {
    const conv: Conversation = { id: 'c1', title: 'Conv', createdAt: 1000, updatedAt: 1000 };
    // In staging: parent user was known by remoteId 'srv_user_1', provisional assistant had parentId: 'srv_user_1' (equal to remoteParentId)
    const u1: Message = {
      id: 'local_u1',
      remoteId: 'srv_user_1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Original prompt',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const a1: Message = {
      id: 'local_a1',
      remoteId: 'srv_assist_1',
      conversationId: 'c1',
      parentId: 'srv_user_1', // raw remoteParentId
      remoteParentId: 'srv_user_1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1100,
      updatedAt: 1100,
    };

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.objectStore(STORE_MESSAGES).put(a1);
      await new Promise((r) => (tx.oncomplete = r));
    }

    // In liveDb: a1 parentId is refined from raw server ID 'srv_user_1' to the local message ID 'local_u1'
    const refinedA1: Message = { ...a1, parentId: 'local_u1', updatedAt: 1200 };
    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(u1);
    ltx.objectStore(STORE_MESSAGES).put(refinedA1);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(true);
  });

  // 8. Replace: Confirmed update of conversation title and valid currentMessageId -> PASS
  it('Replace Matrix 8: Updated conversation title and valid currentMessageId -> PASS', async () => {
    const conv: Conversation = { id: 'c1', title: 'New Chat', createdAt: 1000, updatedAt: 1000 };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Prompt',
      createdAt: 1000,
      updatedAt: 1000,
    };

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      await new Promise((r) => (tx.oncomplete = r));
    }

    // Updated title to meaningful string + currentMessageId points to u1
    const updatedConv: Conversation = {
      ...conv,
      title: 'Discussion on Three Laws of Robotics',
      currentMessageId: 'u1',
      updatedAt: 1500,
    };

    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(updatedConv);
    ltx.objectStore(STORE_MESSAGES).put(u1);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(true);
  });

  // 9. Replace: Conversation title wiped -> FAIL
  it('Replace Matrix 9: Conversation title wiped to empty string -> FAIL', async () => {
    const conv: Conversation = { id: 'c1', title: 'Meaningful Title', createdAt: 1000, updatedAt: 1000 };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Prompt',
      createdAt: 1000,
      updatedAt: 1000,
    };

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      await new Promise((r) => (tx.oncomplete = r));
    }

    const wipedConv: Conversation = { ...conv, title: '', updatedAt: 1500 };
    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(wipedConv);
    ltx.objectStore(STORE_MESSAGES).put(u1);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('title was wiped or emptied');
  });

  // 10. Replace: Conversation currentMessageId points to non-existent message -> FAIL
  it('Replace Matrix 10: Conversation currentMessageId points to missing message -> FAIL', async () => {
    const conv: Conversation = { id: 'c1', title: 'Valid Conv', createdAt: 1000, updatedAt: 1000 };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Prompt',
      createdAt: 1000,
      updatedAt: 1000,
    };

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      await new Promise((r) => (tx.oncomplete = r));
    }

    const brokenConv: Conversation = {
      ...conv,
      currentMessageId: 'non-existent-msg-id',
      updatedAt: 1500,
    };
    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(brokenConv);
    ltx.objectStore(STORE_MESSAGES).put(u1);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(false);
  });

  // 11. Replace: Regenerate with two sibling assistant variants -> PASS
  it('Replace Matrix 11: Assistant regenerate variants preserved -> PASS', async () => {
    const conv: Conversation = {
      id: 'c1',
      title: 'Branching tree',
      currentMessageId: 'a1b',
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
      content: 'User query',
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

    for (const db of [stagingDb, snapshotDb]) {
      const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
      tx.objectStore(STORE_CONVERSATIONS).put(conv);
      tx.objectStore(STORE_MESSAGES).put(u1);
      tx.objectStore(STORE_MESSAGES).put(a1a);
      tx.objectStore(STORE_MESSAGES).put(a1b);
      await new Promise((r) => (tx.oncomplete = r));
    }

    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(u1);
    ltx.objectStore(STORE_MESSAGES).put(a1a);
    ltx.objectStore(STORE_MESSAGES).put(a1b);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('replace');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(true);
  });

  // 12. Merge: Pre-existing user message content mutated in liveDb -> FAIL
  it('Merge Matrix 12: Pre-existing USER message content mutated in liveDb during Merge -> FAIL', async () => {
    const conv: Conversation = { id: 'c1', title: 'Conv', createdAt: 1000, updatedAt: 1000 };
    const preUser: Message = {
      id: 'pre-u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Local pre-existing user prompt',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const impUser: Message = {
      id: 'imp-u2',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Imported user prompt',
      createdAt: 2000,
      updatedAt: 2000,
    };

    // Pre-existing in snapshotDb
    const stx = snapshotDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    stx.objectStore(STORE_CONVERSATIONS).put(conv);
    stx.objectStore(STORE_MESSAGES).put(preUser);
    await new Promise((r) => (stx.oncomplete = r));

    // Imported in stagingDb
    const impTx = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    impTx.objectStore(STORE_CONVERSATIONS).put(conv);
    impTx.objectStore(STORE_MESSAGES).put(impUser);
    await new Promise((r) => (impTx.oncomplete = r));

    // LiveDb has preUser with mutated content
    const corruptedPreUser: Message = { ...preUser, content: 'Corrupted local prompt', updatedAt: 1500 };
    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(corruptedPreUser);
    ltx.objectStore(STORE_MESSAGES).put(impUser);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('merge');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('content mismatch');
  });

  // 13. Merge: Imported user message parentId mutated in liveDb -> FAIL
  it('Merge Matrix 13: Imported message parentId mutated in liveDb during Merge -> FAIL', async () => {
    const conv: Conversation = { id: 'c1', title: 'Conv', createdAt: 1000, updatedAt: 1000 };
    const u1: Message = {
      id: 'u1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'U1',
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
    const impU2: Message = {
      id: 'imp_u2',
      conversationId: 'c1',
      parentId: 'a1b',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'U2',
      createdAt: 1300,
      updatedAt: 1300,
    };

    // snapshot has conv, u1, a1a, a1b
    const stx = snapshotDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    stx.objectStore(STORE_CONVERSATIONS).put(conv);
    stx.objectStore(STORE_MESSAGES).put(u1);
    stx.objectStore(STORE_MESSAGES).put(a1a);
    stx.objectStore(STORE_MESSAGES).put(a1b);
    await new Promise((r) => (stx.oncomplete = r));

    // staging imports impU2 under a1b
    const impTx = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    impTx.objectStore(STORE_CONVERSATIONS).put(conv);
    impTx.objectStore(STORE_MESSAGES).put(impU2);
    await new Promise((r) => (impTx.oncomplete = r));

    // liveDb mutated impU2 parentId to a1a
    const corruptedImpU2: Message = { ...impU2, parentId: 'a1a', updatedAt: 1500 };
    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(u1);
    ltx.objectStore(STORE_MESSAGES).put(a1a);
    ltx.objectStore(STORE_MESSAGES).put(a1b);
    ltx.objectStore(STORE_MESSAGES).put(corruptedImpU2);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('merge');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain('parentId was substituted');
  });

  // 14. Merge: Legitimate merge with subsequent new messages -> PASS
  it('Merge Matrix 14: Legitimate merge with subsequent new messages -> PASS', async () => {
    const conv: Conversation = { id: 'c1', title: 'Conv', createdAt: 1000, updatedAt: 1000 };
    const preMsg: Message = {
      id: 'pre-1',
      conversationId: 'c1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Pre-existing prompt',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const impMsg: Message = {
      id: 'imp-1',
      conversationId: 'c1',
      parentId: 'pre-1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1100,
      updatedAt: 1100,
    };

    const stx = snapshotDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    stx.objectStore(STORE_CONVERSATIONS).put(conv);
    stx.objectStore(STORE_MESSAGES).put(preMsg);
    await new Promise((r) => (stx.oncomplete = r));

    const impTx = stagingDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    impTx.objectStore(STORE_CONVERSATIONS).put(conv);
    impTx.objectStore(STORE_MESSAGES).put(impMsg);
    await new Promise((r) => (impTx.oncomplete = r));

    // LiveDb has both preMsg and impMsg intact, PLUS a new subsequent turn sub-1
    const subMsg: Message = {
      id: 'sub-1',
      conversationId: 'c1',
      parentId: 'imp-1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Subsequent user prompt after merge',
      createdAt: 2000,
      updatedAt: 2000,
    };

    const ltx = liveDb.transaction([STORE_CONVERSATIONS, STORE_MESSAGES], 'readwrite');
    ltx.objectStore(STORE_CONVERSATIONS).put(conv);
    ltx.objectStore(STORE_MESSAGES).put(preMsg);
    ltx.objectStore(STORE_MESSAGES).put(impMsg);
    ltx.objectStore(STORE_MESSAGES).put(subMsg);
    await new Promise((r) => (ltx.oncomplete = r));

    const marker = makeMarker('merge');
    await setRestoreJournalMarker(marker, indexedDB);

    const check = await verifyRestoredBaselinePreserved(liveDb, marker, indexedDB);
    expect(check.valid).toBe(true);

    const recoveryRes = await recoverIncompleteRestoreIfAny(indexedDB);
    expect(recoveryRes.state).toBe('recovered');
  });
});
