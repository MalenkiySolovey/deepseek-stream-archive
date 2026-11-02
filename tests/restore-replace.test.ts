import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { executeAtomicReplace, ALL_NINE_STORES } from '../src/restore/replace';
import { openExtensionDatabase } from '../src/storage/db';
import {
  STORE_CONVERSATIONS,
  STORE_MESSAGES,
  STORE_REVISIONS,
  STORE_RECOVERY_EVENTS,
  STORE_RAW_STREAMS,
  STORE_RAW_STREAM_BATCHES,
  STORE_CANONICAL_CHECKPOINTS,
  STORE_HISTORY_STAGING,
  STORE_HISTORY_STAGING_MANIFESTS,
} from '../src/storage/schema';
import type { MaterializedPortableBackup } from '../src/backup/reader';
import { PORTABLE_BACKUP_FORMAT, PORTABLE_BACKUP_FORMAT_VERSION } from '../src/backup/format';

function makeTestBackup(suffix = 'b'): MaterializedPortableBackup {
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
        { id: `conv-${suffix}`, title: `Title ${suffix}`, createdAt: 100, updatedAt: 200 },
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
      recovery_events: [
        {
          id: `rec-${suffix}`,
          messageId: `msg-${suffix}`,
          kind: 'content_filter',
          detectedAt: 115,
          recoveredRevisionId: `rev-${suffix}`,
        },
      ],
      raw_streams: [
        {
          id: `p-${suffix}:s-${suffix}`,
          producerSessionId: `p-${suffix}`,
          streamId: `s-${suffix}`,
          transport: 'fetch',
          url: 'https://chat.deepseek.com/chat/completion',
          method: 'POST',
          state: 'completed',
          openedAt: 105,
          updatedAt: 115,
          totalChunks: 1,
          totalChars: 10,
          totalBatches: 1,
        },
      ],
      raw_stream_batches: [
        {
          id: `p-${suffix}:s-${suffix}:1`,
          streamKey: `p-${suffix}:s-${suffix}`,
          batchSeq: 1,
          chunks: [{ streamSequence: 0, chunkText: 'data\n\n', timestamp: 106 }],
          createdAt: 106,
          charCount: 6,
        },
      ],
    },
    footer: {
      kind: 'footer',
      complete: true,
      counts: {
        conversations: 1,
        messages: 1,
        revisions: 1,
        recovery_events: 1,
        raw_streams: 1,
        raw_stream_batches: 1,
      },
    },
  };
}

describe('Atomic Archive Replacement Engine (tests/restore-replace.test.ts)', () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase();
  });

  it('atomically replaces archive and clears ephemeral stores in one transaction', async () => {
    // 1. Seed existing ephemeral stores
    const txInit = db.transaction(
      [STORE_CANONICAL_CHECKPOINTS, STORE_HISTORY_STAGING, STORE_HISTORY_STAGING_MANIFESTS],
      'readwrite'
    );
    txInit.objectStore(STORE_CANONICAL_CHECKPOINTS).put({
      streamKey: 'old:stream',
      lastCommittedCheckpointSeq: 5,
      isTerminal: true,
      updatedAt: 50,
    });
    txInit.objectStore(STORE_HISTORY_STAGING_MANIFESTS).put({
      stagingId: 'stg-old',
      sessionId: 'sess-old',
      expectedBatchCount: 1,
      expectedMessageCount: 1,
      receivedBatchCount: 1,
      state: 'open',
      createdAt: 50,
      updatedAt: 50,
    });
    await new Promise<void>((resolve) => {
      txInit.oncomplete = () => resolve();
    });

    // 2. Execute Replace
    const backup = makeTestBackup('target');
    const res = await executeAtomicReplace(db, backup);

    expect(res.success).toBe(true);
    expect(res.insertedCounts.conversations).toBe(1);
    expect(res.insertedCounts.messages).toBe(1);

    // 3. Verify durable stores have backup records
    const txCheck = db.transaction(ALL_NINE_STORES as unknown as string[], 'readonly');
    const conv = await new Promise<any>((resolve) => {
      const req = txCheck.objectStore(STORE_CONVERSATIONS).get('conv-target');
      req.onsuccess = () => resolve(req.result);
    });
    expect(conv?.title).toBe('Title target');

    // 4. Verify ephemeral stores were cleared
    const oldCp = await new Promise<any>((resolve) => {
      const req = txCheck.objectStore(STORE_CANONICAL_CHECKPOINTS).get('old:stream');
      req.onsuccess = () => resolve(req.result);
    });
    expect(oldCp).toBeUndefined();

    const oldManifest = await new Promise<any>((resolve) => {
      const req = txCheck.objectStore(STORE_HISTORY_STAGING_MANIFESTS).get('stg-old');
      req.onsuccess = () => resolve(req.result);
    });
    expect(oldManifest).toBeUndefined();
  });

  it('guarantees atomic rollback on transaction failure, leaving local archive 100% intact', async () => {
    // 1. Seed LOCAL_A archive
    const localA = makeTestBackup('local-a');
    await executeAtomicReplace(db, localA);

    // Verify LOCAL_A is present
    const txA = db.transaction(STORE_CONVERSATIONS, 'readonly');
    const convA = await new Promise<any>((resolve) => {
      const req = txA.objectStore(STORE_CONVERSATIONS).get('conv-local-a');
      req.onsuccess = () => resolve(req.result);
    });
    expect(convA?.id).toBe('conv-local-a');

    // 2. Prepare BACKUP_B with an intentional write error trigger
    const backupB = makeTestBackup('backup-b');

    // Inject an error by monkey-patching or passing an invalid object that throws on put
    // In IndexedDB, an invalid key or frozen throwing getter triggers a DataError / constraint failure
    const badConv = {
      get id() {
        throw new Error('Simulated disk/quota write error during put()');
      },
    } as any;
    backupB.records.conversations.push(badConv);

    // 3. Attempt replace: expect it to reject
    await expect(executeAtomicReplace(db, backupB)).rejects.toThrow();

    // 4. Critical Invariant Assertion: LOCAL_A MUST REMAIN 100% INTACT
    const txVerify = db.transaction(STORE_CONVERSATIONS, 'readonly');
    const convAfter = await new Promise<any>((resolve) => {
      const req = txVerify.objectStore(STORE_CONVERSATIONS).get('conv-local-a');
      req.onsuccess = () => resolve(req.result);
    });
    expect(convAfter?.id).toBe('conv-local-a');
    expect(convAfter?.title).toBe('Title local-a');

    // Verify BACKUP_B is completely absent
    const convB = await new Promise<any>((resolve) => {
      const req = txVerify.objectStore(STORE_CONVERSATIONS).get('conv-backup-b');
      req.onsuccess = () => resolve(req.result);
    });
    expect(convB).toBeUndefined();
  });
});
