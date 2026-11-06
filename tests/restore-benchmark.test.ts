import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { createPortableBackupSnapshot } from '../src/backup/snapshot';
import { buildCompressedBackup } from '../src/backup/serializer';
import { STORE_MESSAGES, STORE_REVISIONS, STORE_CONVERSATIONS } from '../src/storage/schema';
import type { Message, ResponseRevision, Conversation } from '../src/core/models';

async function populateSyntheticArchive(db: IDBDatabase, targetByteSize: number) {
  const convId = 'conv_bench_001';
  const conv: Conversation = {
    id: convId,
    remoteId: 'remote_bench_sess',
    title: 'Benchmark Synthetic Session',
    createdAt: 1000,
    updatedAt: 2000,
  };

  const chunkSize = 1000;
  const count = Math.max(1, Math.floor(targetByteSize / chunkSize));
  const sampleText = 'A'.repeat(chunkSize);

  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE_CONVERSATIONS, STORE_MESSAGES, STORE_REVISIONS], 'readwrite');
    const convStore = tx.objectStore(STORE_CONVERSATIONS);
    const msgStore = tx.objectStore(STORE_MESSAGES);
    const revStore = tx.objectStore(STORE_REVISIONS);

    convStore.put(conv);

    for (let i = 0; i < count; i++) {
      const msgId = `msg_bench_${String(i).padStart(6, '0')}`;
      const msg: Message = {
        id: msgId,
        conversationId: convId,
        role: 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
        content: sampleText,
        createdAt: 1000 + i,
        updatedAt: 1000 + i,
      };
      const rev: ResponseRevision = {
        id: `rev_bench_${String(i).padStart(6, '0')}`,
        messageId: msgId,
        revisionIndex: 0,
        source: 'network',
        isFinal: true,
        isLastGood: false,
        text: sampleText,
        thinking: 'Synthetic chain-of-thought analysis.',
        capturedAt: 1000 + i,
      };
      msgStore.put(msg);
      revStore.put(rev);
    }

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

describe('Restore Performance & Scalability Benchmarks (1 MiB, 10 MiB)', () => {
  beforeEach(async () => {
    closeExtensionDatabase();
    indexedDB = new IDBFactory();
  });

  it('measures 1 MiB synthetic backup restore throughput and latency', async () => {
    let db = await openExtensionDatabase();
    await populateSyntheticArchive(db, 1 * 1024 * 1024);

    const snapshot = await createPortableBackupSnapshot(db);
    const compressedGz = await buildCompressedBackup(snapshot);

    // Clear DB to simulate restore to empty target
    closeExtensionDatabase();
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase();
    const repo = new IndexedDbStorageRepository();

    const t0 = performance.now();
    const { preflight, backup } = await repo.validateAndPreflightRestore(compressedGz, 0, 'replace');
    const tValidation = performance.now() - t0;

    expect(preflight.canRestore).toBe(true);
    expect(backup).toBeDefined();

    const t1 = performance.now();
    const result = await repo.executeRestore(backup!, 'replace', 0);
    const tRestore = performance.now() - t1;

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.insertedCounts.messages).toBeGreaterThanOrEqual(1000);

    console.log(
      `[Benchmark 1 MiB Restore] Validation: ${tValidation.toFixed(2)}ms | Transaction: ${tRestore.toFixed(2)}ms | Total Records: ${result.insertedCounts.conversations + result.insertedCounts.messages + result.insertedCounts.revisions}`
    );
  }, 10000);

  it('measures 10 MiB synthetic backup restore throughput and latency', async () => {
    let db = await openExtensionDatabase();
    await populateSyntheticArchive(db, 10 * 1024 * 1024);

    const snapshot = await createPortableBackupSnapshot(db);
    const compressedGz = await buildCompressedBackup(snapshot);

    // Clear DB to simulate restore to empty target
    closeExtensionDatabase();
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase();
    const repo = new IndexedDbStorageRepository();

    const t0 = performance.now();
    const { preflight, backup } = await repo.validateAndPreflightRestore(compressedGz, 0, 'replace');
    const tValidation = performance.now() - t0;

    expect(preflight.canRestore).toBe(true);
    expect(backup).toBeDefined();

    const t1 = performance.now();
    const result = await repo.executeRestore(backup!, 'replace', 0);
    const tRestore = performance.now() - t1;

    expect(result.success).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.insertedCounts.messages).toBeGreaterThanOrEqual(10000);

    console.log(
      `[Benchmark 10 MiB Restore] Validation: ${tValidation.toFixed(2)}ms | Transaction: ${tRestore.toFixed(2)}ms | Total Records: ${result.insertedCounts.conversations + result.insertedCounts.messages + result.insertedCounts.revisions}`
    );
  }, 60000);
});
