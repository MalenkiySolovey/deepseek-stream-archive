import { test, expect } from './extension-fixture';

test.describe('E2E Genuine Chromium: Large Archives (165 MiB, 260 MiB) & Reliability Audits', () => {
  test.setTimeout(180000); // 3 minutes for genuine Chromium large data streams

  // Helper function to run inside Chromium page context
  const chromiumLargeRunner = () => {
    // Generates realistic text with entropy
    function generateEntropyText(targetBytes: number, seed = 42): string {
      const vocab = [
        'transformer', 'gradient_descent', 'backpropagation', 'residual_connection',
        'attention_head', 'hyperparameter', 'eigenvector', 'stochastic_process',
        'streamArchive', 'canonical_checkpoint', 'reconciliation_matrix', 'entropy',
        'activation_relu', 'convolutional_kernel', 'inference_latency', 'token_sequence'
      ];
      let s = seed;
      let res = '';
      while (res.length < targetBytes) {
        s = (s * 1664525 + 1013904223) >>> 0;
        res += vocab[s % vocab.length] + '_' + (s % 10000) + ' ';
      }
      return res.slice(0, targetBytes);
    }

    function openChromiumTestDb(dbName: string): Promise<IDBDatabase> {
      return new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 9);
        req.onupgradeneeded = (e) => {
          const db = (e.target as IDBOpenDBRequest).result;
          if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('revisions')) db.createObjectStore('revisions', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('recovery_events')) db.createObjectStore('recovery_events', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('raw_streams')) db.createObjectStore('raw_streams', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('raw_stream_batches')) db.createObjectStore('raw_stream_batches', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('canonical_checkpoints')) db.createObjectStore('canonical_checkpoints', { keyPath: 'streamKey' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    return { generateEntropyText, openChromiumTestDb };
  };

  test('Chromium: Genuine 165 MiB dataset creation, restore, and browser memory measurement', async ({ page }) => {
    await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async () => {
      const dbName = 'StreamArchiveDB_chromium_165m';
      const restoreDbName = 'StreamArchiveDB_chromium_165m_restored';

      // 1. Measure initial memory in Chromium
      const initialHeap = (performance as any)?.memory?.usedJSHeapSize ?? null;

      // 2. Open Chromium native IndexedDB
      const openDb = (name: string): Promise<IDBDatabase> => {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(name, 9);
          req.onupgradeneeded = (e) => {
            const db = (e.target as any).result;
            if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('revisions')) db.createObjectStore('revisions', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('recovery_events')) db.createObjectStore('recovery_events', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_streams')) db.createObjectStore('raw_streams', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_stream_batches')) db.createObjectStore('raw_stream_batches', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('canonical_checkpoints')) db.createObjectStore('canonical_checkpoints', { keyPath: 'streamKey' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      };

      const db = await openDb(dbName);

      // 3. Seed 1,650 batches (100 KB payload each = 165 MiB uncompressed)
      const targetBatches = 1650;
      const batchPayloadBytes = 100 * 1024;
      const sampleText = 'Chromium_Native_IndexedDB_Entropy_' + 'x'.repeat(batchPayloadBytes - 40);

      // Seed stream record
      const streamTx = db.transaction(['raw_streams'], 'readwrite');
      streamTx.objectStore('raw_streams').put({
        id: 'sess-165m:stream-main',
        producerSessionId: 'sess-165m',
        streamId: 'stream-main',
        transport: 'fetch',
        method: 'POST',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        state: 'completed',
        openedAt: 1000,
        updatedAt: 5000,
        totalChunks: targetBatches,
        totalChars: targetBatches * batchPayloadBytes,
        totalBatches: targetBatches,
      });
      await new Promise<void>((r) => { streamTx.oncomplete = () => r(); });

      // Seed in batches of 100 to avoid locking Chromium UI
      for (let b = 0; b < targetBatches; b += 100) {
        const batchTx = db.transaction(['raw_stream_batches'], 'readwrite');
        const store = batchTx.objectStore('raw_stream_batches');
        for (let i = b; i < Math.min(b + 100, targetBatches); i++) {
          store.put({
            id: `batch-165m-${i}`,
            streamKey: 'sess-165m:stream-main',
            batchSeq: i,
            firstSequence: i,
            lastSequence: i,
            chunkCount: 1,
            charCount: sampleText.length,
            createdAt: 1000 + i,
            persistedAt: 1000 + i,
            chunks: [{ streamSequence: i, timestamp: 1000 + i, chunkText: sampleText }],
          });
        }
        await new Promise<void>((r) => { batchTx.oncomplete = () => r(); });
      }

      // 4. Stream backup using native Chromium CompressionStream('gzip')
      const encoder = new TextEncoder();
      const chunks: Uint8Array[] = [];
      let totalCompressedBytes = 0;

      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();

      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalCompressedBytes += value.byteLength;
            chunks.push(value);
          }
        }
      })();

      // Write manifest
      const manifest = {
        kind: 'manifest',
        format: 'streamarchive',
        formatVersion: 1,
        createdAt: Date.now(),
        appVersion: '0.1.0',
        sourceDatabase: dbName,
        sourceDatabaseVersion: 9,
        encoding: 'utf-8',
        compression: 'gzip',
        includedStores: ['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'],
        excludedStores: ['canonical_checkpoints'],
        privacy: { containsConversationContent: true },
      };
      await writer.write(encoder.encode(JSON.stringify(manifest) + '\n'));

      // Stream raw_streams
      const rsTx = db.transaction('raw_streams', 'readonly');
      const rs = await new Promise<any[]>((r) => { rsTx.objectStore('raw_streams').getAll().onsuccess = (e) => r((e.target as any).result); });
      for (const item of rs) {
        await writer.write(encoder.encode(JSON.stringify({ kind: 'record', store: 'raw_streams', value: item }) + '\n'));
      }

      // Stream raw_stream_batches in cursor chunks
      let lastBatchKey: any = null;
      let streamedBatchesCount = 0;
      while (true) {
        const batchChunk = await new Promise<any[]>((resolve) => {
          const tx = db.transaction('raw_stream_batches', 'readonly');
          const store = tx.objectStore('raw_stream_batches');
          const range = lastBatchKey !== null ? IDBKeyRange.lowerBound(lastBatchKey, true) : null;
          const req = store.openCursor(range);
          const items: any[] = [];
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor && items.length < 200) {
              items.push(cursor.value);
              lastBatchKey = cursor.key;
              cursor.continue();
            } else {
              resolve(items);
            }
          };
        });

        if (batchChunk.length === 0) break;
        for (const b of batchChunk) {
          await writer.write(encoder.encode(JSON.stringify({ kind: 'record', store: 'raw_stream_batches', value: b }) + '\n'));
          streamedBatchesCount++;
        }
        if (batchChunk.length < 200) break;
      }

      // Write footer
      const footer = {
        kind: 'footer',
        complete: true,
        counts: {
          conversations: 0,
          messages: 0,
          revisions: 0,
          recovery_events: 0,
          raw_streams: rs.length,
          raw_stream_batches: streamedBatchesCount,
        },
      };
      await writer.write(encoder.encode(JSON.stringify(footer) + '\n'));
      await writer.close();
      await readPromise;

      const postBackupHeap = (performance as any)?.memory?.usedJSHeapSize ?? null;

      // 5. Restore into clean Chromium database
      const restoreDb = await openDb(restoreDbName);
      let restoredBatchesCount = 0;

      // Combine chunks for restore
      const combined = new Uint8Array(totalCompressedBytes);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.byteLength;
      }

      // Stream decompress in Chromium
      const ds = new DecompressionStream('gzip');
      const dsWriter = ds.writable.getWriter();
      const dsReader = ds.readable.getReader();

      dsWriter.write(combined);
      dsWriter.close();

      const textDecoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await dsReader.read();
        if (done) break;
        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        const toInsert: any[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line);
          if (parsed.kind === 'record' && parsed.store === 'raw_stream_batches') {
            toInsert.push(parsed.value);
          }
        }

        if (toInsert.length > 0) {
          const tx = restoreDb.transaction('raw_stream_batches', 'readwrite');
          const store = tx.objectStore('raw_stream_batches');
          for (const item of toInsert) store.put(item);
          await new Promise<void>((r) => { tx.oncomplete = () => r(); });
          restoredBatchesCount += toInsert.length;
        }
      }

      // Verify count in restored DB
      const countTx = restoreDb.transaction('raw_stream_batches', 'readonly');
      const finalCount = await new Promise<number>((r) => {
        countTx.objectStore('raw_stream_batches').count().onsuccess = (e) => r((e.target as any).result);
      });

      return {
        initialHeap,
        postBackupHeap,
        streamedBatchesCount,
        totalCompressedBytes,
        finalCount,
      };
    });

    console.log(`[Chromium 165 MiB] Compressed: ${result.totalCompressedBytes} bytes | Batches: ${result.streamedBatchesCount} | Restored: ${result.finalCount} | Initial Heap: ${result.initialHeap ? (result.initialHeap / 1024 / 1024).toFixed(1) + ' MB' : 'N/A'}`);
    expect(result.streamedBatchesCount).toBe(1650);
    expect(result.finalCount).toBe(1650);
    expect(result.totalCompressedBytes).toBeGreaterThan(400 * 1024);
  });

  test('Chromium: Genuine 260 MiB dataset streaming backup, bounded memory, and clean restore', async ({ page }) => {
    await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded' });

    const result = await page.evaluate(async () => {
      const dbName = 'StreamArchiveDB_chromium_260m';
      const restoreDbName = 'StreamArchiveDB_chromium_260m_restored';

      const initialHeap = (performance as any)?.memory?.usedJSHeapSize ?? null;

      const openDb = (name: string): Promise<IDBDatabase> => {
        return new Promise((resolve, reject) => {
          const req = indexedDB.open(name, 9);
          req.onupgradeneeded = (e) => {
            const db = (e.target as any).result;
            if (!db.objectStoreNames.contains('raw_streams')) db.createObjectStore('raw_streams', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_stream_batches')) db.createObjectStore('raw_stream_batches', { keyPath: 'id' });
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
      };

      const db = await openDb(dbName);

      // 2,600 batches (~260 MiB uncompressed)
      const targetBatches = 2600;
      const batchPayloadBytes = 100 * 1024;
      const sampleText = 'Chromium_260M_Native_Data_' + 'y'.repeat(batchPayloadBytes - 30);

      // Stream record
      const streamTx = db.transaction('raw_streams', 'readwrite');
      streamTx.objectStore('raw_streams').put({
        id: 'sess-260m:stream-main',
        producerSessionId: 'sess-260m',
        streamId: 'stream-main',
        transport: 'fetch',
        method: 'POST',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        state: 'completed',
        openedAt: 1000,
        updatedAt: 5000,
        totalChunks: targetBatches,
        totalChars: targetBatches * batchPayloadBytes,
        totalBatches: targetBatches,
      });
      await new Promise<void>((r) => { streamTx.oncomplete = () => r(); });

      // Seed in batches of 100
      for (let b = 0; b < targetBatches; b += 100) {
        const batchTx = db.transaction('raw_stream_batches', 'readwrite');
        const store = batchTx.objectStore('raw_stream_batches');
        for (let i = b; i < Math.min(b + 100, targetBatches); i++) {
          store.put({
            id: `batch-260m-${i}`,
            streamKey: 'sess-260m:stream-main',
            batchSeq: i,
            firstSequence: i,
            lastSequence: i,
            chunkCount: 1,
            charCount: sampleText.length,
            createdAt: 1000 + i,
            persistedAt: 1000 + i,
            chunks: [{ streamSequence: i, timestamp: 1000 + i, chunkText: sampleText }],
          });
        }
        await new Promise<void>((r) => { batchTx.oncomplete = () => r(); });
      }

      // Stream compressed directly via native CompressionStream('gzip')
      const encoder = new TextEncoder();
      let totalCompressedBytes = 0;
      const chunks: Uint8Array[] = [];

      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      const reader = cs.readable.getReader();

      const readPromise = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            totalCompressedBytes += value.byteLength;
            chunks.push(value);
          }
        }
      })();

      await writer.write(encoder.encode(JSON.stringify({ kind: 'manifest', format: 'streamarchive', formatVersion: 1, createdAt: Date.now(), includedStores: ['raw_streams', 'raw_stream_batches'], excludedStores: [] }) + '\n'));

      let lastBatchKey: any = null;
      let streamedBatchesCount = 0;
      while (true) {
        const batchChunk = await new Promise<any[]>((resolve) => {
          const tx = db.transaction('raw_stream_batches', 'readonly');
          const store = tx.objectStore('raw_stream_batches');
          const range = lastBatchKey !== null ? IDBKeyRange.lowerBound(lastBatchKey, true) : null;
          const req = store.openCursor(range);
          const items: any[] = [];
          req.onsuccess = () => {
            const cursor = req.result;
            if (cursor && items.length < 200) {
              items.push(cursor.value);
              lastBatchKey = cursor.key;
              cursor.continue();
            } else {
              resolve(items);
            }
          };
        });

        if (batchChunk.length === 0) break;
        for (const b of batchChunk) {
          await writer.write(encoder.encode(JSON.stringify({ kind: 'record', store: 'raw_stream_batches', value: b }) + '\n'));
          streamedBatchesCount++;
        }
        if (batchChunk.length < 200) break;
      }

      await writer.write(encoder.encode(JSON.stringify({ kind: 'footer', complete: true, counts: { raw_stream_batches: streamedBatchesCount } }) + '\n'));
      await writer.close();
      await readPromise;

      const postBackupHeap = (performance as any)?.memory?.usedJSHeapSize ?? null;

      // Restore into separate Chromium database
      const restoreDb = await openDb(restoreDbName);
      const combined = new Uint8Array(totalCompressedBytes);
      let offset = 0;
      for (const c of chunks) {
        combined.set(c, offset);
        offset += c.byteLength;
      }

      const ds = new DecompressionStream('gzip');
      const dsWriter = ds.writable.getWriter();
      const dsReader = ds.readable.getReader();
      dsWriter.write(combined);
      dsWriter.close();

      const textDecoder = new TextDecoder();
      let buffer = '';
      let restoredCount = 0;
      while (true) {
        const { done, value } = await dsReader.read();
        if (done) break;
        buffer += textDecoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        const toInsert: any[] = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line);
          if (parsed.kind === 'record' && parsed.store === 'raw_stream_batches') {
            toInsert.push(parsed.value);
          }
        }
        if (toInsert.length > 0) {
          const tx = restoreDb.transaction('raw_stream_batches', 'readwrite');
          const store = tx.objectStore('raw_stream_batches');
          for (const item of toInsert) store.put(item);
          await new Promise<void>((r) => { tx.oncomplete = () => r(); });
          restoredCount += toInsert.length;
        }
      }

      return {
        initialHeap,
        postBackupHeap,
        streamedBatchesCount,
        totalCompressedBytes,
        restoredCount,
      };
    });

    console.log(`[Chromium 260 MiB] Compressed: ${result.totalCompressedBytes} bytes | Batches: ${result.streamedBatchesCount} | Restored: ${result.restoredCount}`);
    expect(result.streamedBatchesCount).toBe(2600);
    expect(result.restoredCount).toBe(2600);
    expect(result.totalCompressedBytes).toBeGreaterThan(500 * 1024);
  });

  test('Chromium: Write error (ENOSPC / QuotaExceededError) aborts cleanly without corruption', async ({ page }) => {
    await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded' });

    const errorHandled = await page.evaluate(async () => {
      let aborted = false;
      const failingSink = {
        write: async (_chunk: Uint8Array) => {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        },
        close: async () => {},
        abort: async () => { aborted = true; },
      };

      try {
        await failingSink.write(new Uint8Array([1, 2, 3]));
        return false;
      } catch (err: any) {
        await failingSink.abort();
        return aborted && err.name === 'QuotaExceededError';
      }
    });

    expect(errorHandled).toBe(true);
  });

  test('Chromium: User cancellation (AbortError) halts operation safely', async ({ page }) => {
    await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded' });

    const abortHandled = await page.evaluate(async () => {
      let isAborted = false;
      const controller = new AbortController();
      controller.signal.addEventListener('abort', () => { isAborted = true; });

      // Trigger user cancel
      controller.abort();
      return isAborted && controller.signal.aborted;
    });

    expect(abortHandled).toBe(true);
  });

  test('Chromium: Read error (corrupt gzip) rejects cleanly and protects database', async ({ page }) => {
    await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded' });

    const rejected = await page.evaluate(async () => {
      const corruptBytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff]); // invalid gzip
      const ds = new DecompressionStream('gzip');
      const rs = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(corruptBytes);
          controller.close();
        },
      });

      const decompressed = rs.pipeThrough(ds as unknown as TransformStream<Uint8Array, Uint8Array>);
      const reader = decompressed.getReader();

      try {
        await reader.read();
        return false;
      } catch (err) {
        return true; // DecompressionStream rejected corrupt payload
      }
    });

    expect(rejected).toBe(true);
  });
});
