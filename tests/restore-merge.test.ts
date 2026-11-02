import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { executeAtomicReplace } from '../src/restore/replace';
import { executeAtomicMerge } from '../src/restore/merge';
import { buildRestorePlan } from '../src/restore/plan';
import { openExtensionDatabase } from '../src/storage/db';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
} from '../src/storage/schema';
import type { MaterializedPortableBackup } from '../src/backup/reader';
import { PORTABLE_BACKUP_FORMAT, PORTABLE_BACKUP_FORMAT_VERSION } from '../src/backup/format';

function makeTestBackup(suffix = 'm', convOverrides?: any): MaterializedPortableBackup {
  return {
    manifest: {
      kind: 'manifest',
      format: PORTABLE_BACKUP_FORMAT,
      formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
      createdAt: 1700000000000,
      appVersion: '0.1.0',
      sourceDatabase: 'StreamArchiveDB',
      sourceDatabaseVersion: 8,
      encoding: 'utf-8',
      compression: 'gzip',
      includedStores: ['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'],
      excludedStores: ['canonical_checkpoints', 'history_staging', 'history_staging_manifests'],
      privacy: {
        containsConversationContent: true,
        containsReasoning: true,
        containsRecoveredContent: true,
        containsRawNetworkEvidence: true,
      },
    },
    records: {
      conversations: [
        { id: `conv-${suffix}`, title: `Title ${suffix}`, createdAt: 100, updatedAt: 200, ...convOverrides },
      ],
      messages: [
        {
          id: `msg-${suffix}`,
          conversationId: `conv-${suffix}`,
          role: 'user',
          status: 'finished',
          identityState: 'reconciled',
          projectionState: 'logical',
          createdAt: 110,
          updatedAt: 110,
        },
      ],
      revisions: [
        {
          id: `rev-${suffix}`,
          messageId: `msg-${suffix}`,
          revisionIndex: 0,
          text: `Text ${suffix}`,
          source: 'network',
          capturedAt: 110,
          isFinal: true,
          isLastGood: true,
        },
      ],
      recovery_events: [],
      raw_streams: [],
      raw_stream_batches: [],
    },
    footer: {
      kind: 'footer',
      complete: true,
      counts: {
        conversations: 1,
        messages: 1,
        revisions: 1,
        recovery_events: 0,
        raw_streams: 0,
        raw_stream_batches: 0,
      },
    },
  };
}

describe('Conservative Safe Merge Engine (tests/restore-merge.test.ts)', () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase();
  });

  it('merges into empty DB successfully inserting all records', async () => {
    const backup = makeTestBackup('1');
    const plan = await buildRestorePlan(db, backup, 'merge');
    expect(plan.valid).toBe(true);
    expect(plan.toInsert.conversations).toHaveLength(1);

    const res = await executeAtomicMerge(db, plan);
    expect(res.success).toBe(true);
    expect(res.insertedCounts.conversations).toBe(1);

    const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
    const conv = await new Promise<any>((resolve) => {
      const req = tx.objectStore(STORE_CONVERSATIONS).get('conv-1');
      req.onsuccess = () => resolve(req.result);
    });
    expect(conv?.id).toBe('conv-1');
  });

  it('merges non-overlapping archive into existing database creating strict union', async () => {
    // Seed archive A
    const backupA = makeTestBackup('a');
    await executeAtomicReplace(db, backupA);

    // Merge backup B
    const backupB = makeTestBackup('b');
    const planB = await buildRestorePlan(db, backupB, 'merge');
    expect(planB.valid).toBe(true);
    expect(planB.toInsert.conversations).toHaveLength(1);

    const res = await executeAtomicMerge(db, planB);
    expect(res.success).toBe(true);
    expect(res.insertedCounts.conversations).toBe(1);

    // Both A and B must exist in the database
    const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
    const convA = await new Promise<any>((resolve) => {
      const req = tx.objectStore(STORE_CONVERSATIONS).get('conv-a');
      req.onsuccess = () => resolve(req.result);
    });
    const convB = await new Promise<any>((resolve) => {
      const req = tx.objectStore(STORE_CONVERSATIONS).get('conv-b');
      req.onsuccess = () => resolve(req.result);
    });

    expect(convA?.id).toBe('conv-a');
    expect(convB?.id).toBe('conv-b');
  });

  it('guarantees idempotency: merging the exact same backup twice inserts 0 records and skips duplicates', async () => {
    const backup = makeTestBackup('same');

    // First merge: inserts 1 conversation, 1 message, 1 revision
    const plan1 = await buildRestorePlan(db, backup, 'merge');
    const res1 = await executeAtomicMerge(db, plan1);
    expect(res1.insertedCounts.conversations).toBe(1);

    // Second merge of the exact same backup
    const plan2 = await buildRestorePlan(db, backup, 'merge');
    expect(plan2.valid).toBe(true);
    expect(plan2.toInsert.conversations).toHaveLength(0);
    expect(plan2.toSkip.conversations).toBe(1);
    expect(plan2.toSkip.messages).toBe(1);
    expect(plan2.toSkip.revisions).toBe(1);

    const res2 = await executeAtomicMerge(db, plan2);
    expect(res2.insertedCounts.conversations).toBe(0);
    expect(res2.skippedCounts.conversations).toBe(1);
  });

  it('detects primary key conflict with modified content and aborts the entire merge', async () => {
    // Seed local archive
    const backupOriginal = makeTestBackup('c1');
    await executeAtomicReplace(db, backupOriginal);

    // Incoming backup with same ID 'conv-c1' but modified title
    const backupModified = makeTestBackup('c1', { title: 'Divergent Title' });
    const plan = await buildRestorePlan(db, backupModified, 'merge');

    expect(plan.valid).toBe(false);
    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.conflicts[0]?.code).toBe('primary_key_conflict');

    // Attempting to execute invalid plan must throw
    await expect(executeAtomicMerge(db, plan)).rejects.toThrow();

    // Verify local DB title was NOT overwritten
    const tx = db.transaction(STORE_CONVERSATIONS, 'readonly');
    const conv = await new Promise<any>((resolve) => {
      const req = tx.objectStore(STORE_CONVERSATIONS).get('conv-c1');
      req.onsuccess = () => resolve(req.result);
    });
    expect(conv?.title).toBe('Title c1');
  });

  it('detects semantic remote identity collisions on conversations and blocks merge', async () => {
    // Local DB has conv-local with remoteId = 'deepseek-session-999'
    const backupLocal = makeTestBackup('local', { remoteId: 'deepseek-session-999' });
    await executeAtomicReplace(db, backupLocal);

    // Incoming backup has conv-incoming (DIFFERENT id) but SAME remoteId = 'deepseek-session-999'
    const backupForeign = makeTestBackup('foreign', { remoteId: 'deepseek-session-999' });
    const plan = await buildRestorePlan(db, backupForeign, 'merge');

    expect(plan.valid).toBe(false);
    expect(plan.conflicts.some((c) => c.code === 'semantic_identity_collision')).toBe(true);
  });
});
