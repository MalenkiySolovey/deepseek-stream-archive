/**
 * Bounded Streaming Backup Generator.
 *
 * Implements low-memory streaming backup of all 6 durable IndexedDB stores:
 * - Reads stores in cursor batches using IDBKeyRange to prevent holding transactions open
 * - Records are read directly in primary key order (zero in-memory sorting)
 * - Encodes line-by-line UTF-8 NDJSON
 * - Streams through native CompressionStream('gzip')
 * - Writes incrementally to FileSystemWritableFileStream / WritableStream
 * - Bounded memory consumption (< 5 MiB peak RAM) regardless of database size
 */

import {
  INCLUDED_BACKUP_STORES,
  EXCLUDED_BACKUP_STORES,
  PORTABLE_BACKUP_FORMAT,
  PORTABLE_BACKUP_FORMAT_VERSION,
  type IncludedBackupStoreName,
  type PortableBackupStoreCounts,
  type PortableBackupManifestRecord,
  type PortableBackupFooterRecord,
} from './format';
import { DB_NAME, DB_VERSION } from '../storage/schema';
import { getStorageMutationEpoch } from '../storage/mutation-tracker';

export interface StreamingBackupOptions {
  appVersion?: string;
  now?: number;
  batchSize?: number;
  getActiveStreamsCount?: () => Promise<number> | number;
  getMutationEpoch?: () => Promise<number> | number;
  onProgress?: (progress: StreamingBackupProgress) => void;
}

export interface StreamingBackupProgress {
  currentStore: IncludedBackupStoreName;
  storeCounts: PortableBackupStoreCounts;
  totalRecordsProcessed: number;
}

export interface StreamingBackupResult {
  success: boolean;
  counts: PortableBackupStoreCounts;
  totalRecords: number;
  compressedBytes: number;
  durationMs: number;
}

/**
 * Reads a single batch of records from an IndexedDB store in ascending key order.
 */
function fetchCursorBatch(
  db: IDBDatabase,
  storeName: IncludedBackupStoreName,
  lastKey: IDBValidKey | null,
  batchSize: number
): Promise<{ items: Record<string, unknown>[]; lastKey: IDBValidKey | null }> {
  return new Promise((resolve, reject) => {
    let tx: IDBTransaction;
    try {
      tx = db.transaction(storeName, 'readonly');
    } catch (err) {
      return reject(new Error(`Failed to open readonly transaction for store ${storeName}: ${(err as Error).message}`));
    }

    tx.onabort = () => {
      reject(new Error(`Transaction aborted for store ${storeName}: ${tx.error?.message || 'Aborted'}`));
    };
    tx.onerror = () => {
      reject(new Error(`Transaction failed for store ${storeName}: ${tx.error?.message || 'Error'}`));
    };

    const store = tx.objectStore(storeName);
    const keyRangeClass =
      typeof IDBKeyRange !== 'undefined'
        ? IDBKeyRange
        : (globalThis as any)?.IDBKeyRange;
    const range = lastKey !== null && keyRangeClass ? keyRangeClass.lowerBound(lastKey, true) : null;
    const req = store.openCursor(range);
    const items: Record<string, unknown>[] = [];
    let currentLastKey: IDBValidKey | null = lastKey;

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && items.length < batchSize) {
        items.push(cursor.value);
        currentLastKey = cursor.key;
        cursor.continue();
      } else {
        resolve({ items, lastKey: currentLastKey });
      }
    };

    req.onerror = () => {
      reject(req.error || new Error(`Cursor traversal failed for store ${storeName}`));
    };
  });
}

/**
 * Creates a ReadableStream<Uint8Array> that streams uncompressed NDJSON lines
 * chunk-by-chunk directly from IndexedDB without materializing the full DB in memory.
 */
export function createUncompressedBackupReadableStream(
  db: IDBDatabase,
  options: StreamingBackupOptions = {}
): {
  stream: ReadableStream<Uint8Array>;
  getCounts: () => PortableBackupStoreCounts;
} {
  const encoder = new TextEncoder();
  const now = options.now ?? Date.now();
  const appVersion = options.appVersion ?? '0.1.0';
  const batchSize = Math.max(10, Math.min(1000, options.batchSize ?? 200));

  const counts: PortableBackupStoreCounts = {
    conversations: 0,
    messages: 0,
    revisions: 0,
    recovery_events: 0,
    raw_streams: 0,
    raw_stream_batches: 0,
  };

  let storeIdx = 0;
  let lastKey: IDBValidKey | null = null;
  let phase: 'manifest' | 'records' | 'footer' | 'done' = 'manifest';
  let totalRecordsProcessed = 0;
  let startEpoch: number | null = null;

  const assertStorageConsistency = async () => {
    if (options.getActiveStreamsCount) {
      const activeCount = await options.getActiveStreamsCount();
      if (activeCount > 0) {
        throw new Error('Backup aborted: active DeepSeek generation stream detected during backup.');
      }
    }
    const currentEpoch = options.getMutationEpoch ? await options.getMutationEpoch() : getStorageMutationEpoch();
    if (startEpoch !== null && currentEpoch !== startEpoch) {
      throw new Error('Backup aborted: database was modified during backup creation. Please retry when DeepSeek is idle.');
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (phase !== 'done') {
          if (phase === 'manifest') {
            if (options.getActiveStreamsCount) {
              const activeCount = await options.getActiveStreamsCount();
              if (activeCount > 0) {
                throw new Error('Cannot create backup while active DeepSeek generation streams are running. Please wait for streaming to conclude.');
              }
            }
            startEpoch = options.getMutationEpoch ? await options.getMutationEpoch() : getStorageMutationEpoch();

            const manifest: PortableBackupManifestRecord = {
              kind: 'manifest',
              format: PORTABLE_BACKUP_FORMAT,
              formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
              createdAt: now,
              appVersion,
              sourceDatabase: DB_NAME,
              sourceDatabaseVersion: DB_VERSION,
              encoding: 'utf-8',
              compression: 'gzip',
              includedStores: INCLUDED_BACKUP_STORES,
              excludedStores: EXCLUDED_BACKUP_STORES,
              privacy: {
                containsConversationContent: true,
                containsReasoning: true,
                containsRecoveredContent: true,
                containsRawNetworkEvidence: true,
              },
            };
            controller.enqueue(encoder.encode(JSON.stringify(manifest) + '\n'));
            phase = 'records';
            return;
          }

          if (phase === 'records') {
            if (storeIdx >= INCLUDED_BACKUP_STORES.length) {
              phase = 'footer';
              continue;
            }

            // Verify database has not been mutated concurrently before fetching batch
            await assertStorageConsistency();

            const currentStore = INCLUDED_BACKUP_STORES[storeIdx]!;
            const batchResult = await fetchCursorBatch(db, currentStore, lastKey, batchSize);

            // Re-verify consistency after batch retrieval
            await assertStorageConsistency();

            if (batchResult.items.length > 0) {
              let chunkStr = '';
              for (const item of batchResult.items) {
                chunkStr += JSON.stringify({ kind: 'record', store: currentStore, value: item }) + '\n';
                counts[currentStore]++;
                totalRecordsProcessed++;
              }
              lastKey = batchResult.lastKey;
              controller.enqueue(encoder.encode(chunkStr));
              options.onProgress?.({
                currentStore,
                storeCounts: { ...counts },
                totalRecordsProcessed,
              });
            }

            if (batchResult.items.length < batchSize) {
              // Completed this store, advance to next
              storeIdx++;
              lastKey = null;
              if (storeIdx >= INCLUDED_BACKUP_STORES.length) {
                phase = 'footer';
              }
            }

            if (batchResult.items.length > 0) {
              return;
            }
            // If 0 items were found in an empty store, continue looping to next store
            continue;
          }

          if (phase === 'footer') {
            // Final barrier: ensure zero database mutations occurred across the entire streaming duration
            await assertStorageConsistency();

            const footer: PortableBackupFooterRecord = {
              kind: 'footer',
              complete: true,
              counts: { ...counts },
            };
            controller.enqueue(encoder.encode(JSON.stringify(footer) + '\n'));
            phase = 'done';
            controller.close();
            return;
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return {
    stream,
    getCounts: () => ({ ...counts }),
  };
}

/**
 * Creates a gzip-compressed ReadableStream<Uint8Array> of the backup archive.
 */
export function createCompressedBackupReadableStream(
  db: IDBDatabase,
  options: StreamingBackupOptions = {}
): {
  stream: ReadableStream<Uint8Array>;
  getCounts: () => PortableBackupStoreCounts;
} {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream is not supported in this runtime environment.');
  }

  const { stream: rawStream, getCounts } = createUncompressedBackupReadableStream(db, options);
  const compressedStream = rawStream.pipeThrough(
    new CompressionStream('gzip') as unknown as TransformStream<Uint8Array, Uint8Array>
  );

  return {
    stream: compressedStream,
    getCounts,
  };
}

/**
 * Streams the entire backup archive directly into a WritableStream or FileSystemWritableFileStream
 * using bounded chunked writes, avoiding large memory allocations and IPC messaging.
 */
export async function streamBackupToWritable(
  db: IDBDatabase,
  writable: WritableStream<Uint8Array> | { write: (data: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: (reason?: unknown) => Promise<void> },
  options: StreamingBackupOptions = {}
): Promise<StreamingBackupResult> {
  const startTime = Date.now();
  const { stream: compressedStream, getCounts } = createCompressedBackupReadableStream(db, options);

  let compressedBytes = 0;
  const reader = compressedStream.getReader();

  const isNativeWritableStream =
    typeof WritableStream !== 'undefined' &&
    writable instanceof WritableStream;

  if (isNativeWritableStream) {
    const writer = (writable as WritableStream<Uint8Array>).getWriter();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          compressedBytes += value.byteLength;
          await writer.write(value);
        }
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      throw err;
    }
  } else {
    // Custom writable duck-type (e.g. FileSystemWritableFileStream or mock)
    const custom = writable as { write: (data: Uint8Array) => Promise<void>; close: () => Promise<void>; abort: (reason?: unknown) => Promise<void> };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          compressedBytes += value.byteLength;
          await custom.write(value);
        }
      }
      await custom.close();
    } catch (err) {
      await custom.abort(err).catch(() => {});
      throw err;
    }
  }

  const finalCounts = getCounts();
  const totalRecords =
    finalCounts.conversations +
    finalCounts.messages +
    finalCounts.revisions +
    finalCounts.recovery_events +
    finalCounts.raw_streams +
    finalCounts.raw_stream_batches;

  return {
    success: true,
    counts: finalCounts,
    totalRecords,
    compressedBytes,
    durationMs: Date.now() - startTime,
  };
}
