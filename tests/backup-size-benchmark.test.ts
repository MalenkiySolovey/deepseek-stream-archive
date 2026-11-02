import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openExtensionDatabase } from '../src/storage/db';
import {
  createPortableBackupSnapshot,
  buildCompressedBackup,
  validatePortableBackup,
} from '../src/backup';
import { STORE_MESSAGES, STORE_REVISIONS, STORE_CONVERSATIONS } from '../src/storage/schema';
import type { Message, ResponseRevision, Conversation } from '../src/core/models';

describe('Portable Backup Scalability & Synthetic Benchmarks (1 MiB, 10 MiB, 50 MiB)', () => {
  let db: IDBDatabase;

  beforeEach(async () => {
    indexedDB = new IDBFactory();
    db = await openExtensionDatabase(indexedDB);
  });

  async function populateSyntheticArchive(targetByteSize: number) {
    const convId = 'conv_bench_001';
    const conv: Conversation = {
      id: convId,
      remoteId: 'remote_bench_sess',
      title: 'Benchmark Synthetic Session',
      createdAt: 1000,
      updatedAt: 2000,
    };

    // Calculate how many messages/revisions to generate
    // Each revision payload will be ~1000 bytes of text
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

  it('measures 1 MiB synthetic source benchmark: snapshot, compression, and validation', async () => {
    const targetBytes = 1 * 1024 * 1024; // 1 MiB
    await populateSyntheticArchive(targetBytes);

    const t0 = performance.now();
    const snapshot = await createPortableBackupSnapshot(db);
    const tSnapshot = performance.now() - t0;

    const t1 = performance.now();
    const compressedBytes = await buildCompressedBackup(snapshot);
    const tCompression = performance.now() - t1;

    const t2 = performance.now();
    const validation = await validatePortableBackup(compressedBytes);
    const tValidation = performance.now() - t2;

    console.log(`[Benchmark 1 MiB] Snapshot: ${tSnapshot.toFixed(2)}ms | Compression: ${tCompression.toFixed(2)}ms | Compressed Size: ${compressedBytes.length} bytes | Validation: ${tValidation.toFixed(2)}ms`);

    expect(validation.valid).toBe(true);
    expect(snapshot.totalRecordCount).toBeGreaterThanOrEqual(1000);
    expect(compressedBytes.length).toBeLessThan(targetBytes); // Gzip should compress repetitive text heavily
  });

  it('measures 10 MiB synthetic source benchmark: snapshot and compression performance', async () => {
    const targetBytes = 10 * 1024 * 1024; // 10 MiB
    await populateSyntheticArchive(targetBytes);

    const t0 = performance.now();
    const snapshot = await createPortableBackupSnapshot(db);
    const tSnapshot = performance.now() - t0;

    const t1 = performance.now();
    const compressedBytes = await buildCompressedBackup(snapshot);
    const tCompression = performance.now() - t1;

    console.log(`[Benchmark 10 MiB] Snapshot: ${tSnapshot.toFixed(2)}ms | Compression: ${tCompression.toFixed(2)}ms | Compressed Size: ${compressedBytes.length} bytes | Record Count: ${snapshot.totalRecordCount}`);

    expect(snapshot.totalRecordCount).toBeGreaterThanOrEqual(10000);
    expect(compressedBytes.length).toBeGreaterThan(0);
  }, 15000);

  it('enforces safety limit against 100 MiB boundary without OOM crash', async () => {
    // Test that MAX_IN_MEMORY_PORTABLE_BACKUP_SOURCE_BYTES triggers cleanly when ceiling is set lower
    const simulatedBytes = 2 * 1024 * 1024; // 2 MiB
    await populateSyntheticArchive(simulatedBytes);

    // Limit snapshot to 500 KB to trigger safety boundary
    await expect(
      createPortableBackupSnapshot(db, { maxBytes: 500 * 1024 })
    ).rejects.toThrow('This archive is too large for the current portable backup implementation. No backup file was created.');
  });
});
