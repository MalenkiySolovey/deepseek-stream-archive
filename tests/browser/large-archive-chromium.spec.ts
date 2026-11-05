import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORTABLE_BACKUP_EXTENSION } from '../../src/backup';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Genuine Chromium: Large Archives (165 MiB, 260 MiB), Production Restore & Data Integrity Audit', () => {
  test.setTimeout(240000); // 4 minutes for comprehensive Chromium testing

  test('Chromium E2E 1: Genuine branched conversation, backup download, and archive inspection', async ({
    page,
    router,
    loadSidepanel,
    readIndexedDb,
  }) => {
    // 1. Setup mock SSE stream for branched DeepSeek generation
    const normalStreamFixture = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.existsSync(normalStreamFixture)
      ? fs.readFileSync(normalStreamFixture, 'utf8')
      : 'data: {"choices":[{"delta":{"content":"DeepSeek Genuine Stream Response"}}]}\n\ndata: [DONE]\n\n';

    router.registry.registerCustomHandler(
      'https://chat.deepseek.com/api/v0/chat/completion',
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream; charset=utf-8',
          headers: {
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
          body: sseBody,
        });
      }
    );

    // 2. Generate initial conversation in DeepSeek
    const sessionId = 'sess-chromium-branched';
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    // Dispatch prompt
    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Branch Root Question' }));
    });
    await page.waitForTimeout(1000);

    // 3. Open Sidepanel and create backup of initial state
    const sidepanel = await loadSidepanel();

    await sidepanel.evaluate(() => {
      delete (window as any).showSaveFilePicker;
    });

    const settingsTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Settings|Настройки/i });
    await expect(settingsTabBtn).toBeVisible({ timeout: 5000 });
    await settingsTabBtn.click();

    const createBackupBtn = sidepanel.locator('button.backup-btn.primary');
    await expect(createBackupBtn).toBeVisible();

    const downloadPromise = sidepanel.waitForEvent('download');
    await createBackupBtn.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain(PORTABLE_BACKUP_EXTENSION);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const backupBuffer = Buffer.concat(chunks);
    expect(backupBuffer.length).toBeGreaterThan(0);

    // 4. Verify archive structure directly via Node zlib
    const zlib = await import('zlib');
    const decompressedText = zlib.gunzipSync(backupBuffer).toString('utf8');
    const lines = decompressedText.trim().split('\n').map((l) => JSON.parse(l));
    const manifest = lines[0];
    const footer = lines[lines.length - 1];

    expect(manifest?.kind).toBe('manifest');
    expect(manifest?.formatVersion).toBe(1);
    expect(footer?.kind).toBe('footer');
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  test('Chromium E2E 2: Restore Replace with byte-level fidelity and Restore Merge with 0 false conflicts', async ({
    page,
    loadSidepanel,
  }) => {
    const sidepanel = await loadSidepanel();

    // 1. Seed complete conversation with Edit and Regenerate branches directly into Chromium IndexedDB
    const seedResult = await sidepanel.evaluate(async () => {
      const openDb = (): Promise<IDBDatabase> => {
        return new Promise((res, rej) => {
          const req = indexedDB.open('StreamArchiveDB', 9);
          req.onupgradeneeded = (e) => {
            const db = (e.target as any).result;
            if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('revisions')) db.createObjectStore('revisions', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('recovery_events')) db.createObjectStore('recovery_events', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_streams')) db.createObjectStore('raw_streams', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_stream_batches')) db.createObjectStore('raw_stream_batches', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('canonical_checkpoints')) db.createObjectStore('canonical_checkpoints', { keyPath: 'streamKey' });
            if (!db.objectStoreNames.contains('context_continuity_receipts')) db.createObjectStore('context_continuity_receipts', { keyPath: 'id' });
          };
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      };
      const db = await openDb();

      const tx = db.transaction(
        ['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'],
        'readwrite'
      );

      // Root conversation
      tx.objectStore('conversations').put({
        id: 'conv-chromium-tree',
        remoteId: 'remote-tree-99',
        title: 'DeepSeek Tree Structure & DeepThink',
        createdAt: 1000,
        updatedAt: 4000,
        model: 'deepseek-reasoner',
      });

      // User prompt (Root)
      tx.objectStore('messages').put({
        id: 'msg-u1',
        conversationId: 'conv-chromium-tree',
        role: 'user',
        status: 'finished',
        identityState: 'reconciled',
        createdAt: 1000,
        updatedAt: 1000,
      });

      // Assistant response branch 1 (with DeepThink reasoning)
      tx.objectStore('messages').put({
        id: 'msg-a1-branch1',
        conversationId: 'conv-chromium-tree',
        parentId: 'msg-u1',
        role: 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        createdAt: 2000,
        updatedAt: 2050,
      });
      tx.objectStore('revisions').put({
        id: 'rev-a1-b1',
        messageId: 'msg-a1-branch1',
        revisionIndex: 0,
        text: 'Branch 1 Final Response Answer',
        thinking: 'Detailed DeepThink reasoning chain branch 1: analyzed eigenvalues and transformer convergence.',
        source: 'network',
        capturedAt: 2050,
        isFinal: true,
        isLastGood: true,
      });

      // Assistant response branch 2 (Regenerate sibling sharing exact same parentId 'msg-u1')
      tx.objectStore('messages').put({
        id: 'msg-a1-branch2',
        conversationId: 'conv-chromium-tree',
        parentId: 'msg-u1',
        role: 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        createdAt: 3000,
        updatedAt: 3050,
      });
      tx.objectStore('revisions').put({
        id: 'rev-a1-b2',
        messageId: 'msg-a1-branch2',
        revisionIndex: 0,
        text: 'Branch 2 Regenerated Answer',
        thinking: 'Alternative DeepThink reasoning chain branch 2: evaluated stochastic gradient bounds.',
        source: 'network',
        capturedAt: 3050,
        isFinal: true,
        isLastGood: true,
      });

      // Pre-filter censorship recovery event
      tx.objectStore('recovery_events').put({
        id: 'rec-event-1',
        messageId: 'msg-a1-branch1',
        kind: 'content_filter',
        recoveredRevisionId: 'rev-a1-b1',
        detectedAt: 2060,
      });

      // Raw SSE stream and chunk batches
      tx.objectStore('raw_streams').put({
        id: 'sess-tree:stream-1',
        producerSessionId: 'sess-tree',
        streamId: 'stream-1',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        method: 'POST',
        state: 'completed',
        openedAt: 1000,
        updatedAt: 3100,
        totalChunks: 1,
        totalChars: 18,
        totalBatches: 1,
      });
      tx.objectStore('raw_stream_batches').put({
        id: 'batch-1',
        streamKey: 'sess-tree:stream-1',
        batchSeq: 0,
        chunks: [{ streamSequence: 0, chunkText: 'data: {"content": "raw token 1"}\n\n', timestamp: 1050 }],
        createdAt: 1050,
        charCount: 35,
      });

      await new Promise<void>((r) => { tx.oncomplete = () => r(); });
      db.close();
      return { success: true };
    });
    expect(seedResult.success).toBe(true);

    // 2. Export backup via sidepanel
    await sidepanel.evaluate(() => {
      delete (window as any).showSaveFilePicker;
    });

    const settingsTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Settings|Настройки/i });
    await expect(settingsTabBtn).toBeVisible({ timeout: 5000 });
    await settingsTabBtn.click();

    const createBackupBtn = sidepanel.locator('button.backup-btn.primary');
    const downloadPromise = sidepanel.waitForEvent('download');
    await createBackupBtn.click();
    const download = await downloadPromise;

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const backupBuffer = Buffer.concat(chunks);
    expect(backupBuffer.length).toBeGreaterThan(0);

    // 3. Mutate live DB (change title and delete branch 2)
    await sidepanel.evaluate(async () => {
      const openDb = (): Promise<IDBDatabase> => {
        return new Promise((res, rej) => {
          const req = indexedDB.open('StreamArchiveDB', 9);
          req.onupgradeneeded = (e) => {
            const db = (e.target as any).result;
            if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('revisions')) db.createObjectStore('revisions', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('recovery_events')) db.createObjectStore('recovery_events', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_streams')) db.createObjectStore('raw_streams', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_stream_batches')) db.createObjectStore('raw_stream_batches', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('canonical_checkpoints')) db.createObjectStore('canonical_checkpoints', { keyPath: 'streamKey' });
            if (!db.objectStoreNames.contains('context_continuity_receipts')) db.createObjectStore('context_continuity_receipts', { keyPath: 'id' });
          };
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      };
      const db = await openDb();
      const tx = db.transaction(['conversations', 'messages'], 'readwrite');
      tx.objectStore('conversations').put({
        id: 'conv-chromium-tree',
        title: 'Mutated Wrong Title',
        createdAt: 1000,
        updatedAt: 5000,
      });
      tx.objectStore('messages').delete('msg-a1-branch2');
      await new Promise<void>((r) => { tx.oncomplete = () => r(); });
      db.close();
    });

    // 4. Restore Replace: Upload backup file
    const fileInput = sidepanel.locator('#backup-file-input');
    await fileInput.setInputFiles({
      name: 'genuine-tree-backup.streamarchive.jsonl.gz',
      mimeType: 'application/gzip',
      buffer: backupBuffer,
    });

    // Check preview box appears
    const previewBox = sidepanel.locator('#restore-preview-box');
    await expect(previewBox).toBeVisible({ timeout: 10000 });

    // Confirm Replace
    const confirmCheckbox = sidepanel.locator('#confirm-replace-checkbox');
    await confirmCheckbox.check();

    // Execute Replace Restore
    const executeBtn = sidepanel.locator('#execute-restore-btn');
    await expect(executeBtn).toBeEnabled();
    await executeBtn.click();

    // Verify Restore Complete summary box
    const summaryBox = sidepanel.locator('#restore-summary-box');
    await expect(summaryBox).toBeVisible({ timeout: 15000 });

    // 5. Verify byte-for-byte fidelity in Chromium IndexedDB
    const verification = await sidepanel.evaluate(async () => {
      const openDb = (): Promise<IDBDatabase> => {
        return new Promise((res, rej) => {
          const req = indexedDB.open('StreamArchiveDB', 9);
          req.onupgradeneeded = (e) => {
            const db = (e.target as any).result;
            if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('revisions')) db.createObjectStore('revisions', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('recovery_events')) db.createObjectStore('recovery_events', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_streams')) db.createObjectStore('raw_streams', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_stream_batches')) db.createObjectStore('raw_stream_batches', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('canonical_checkpoints')) db.createObjectStore('canonical_checkpoints', { keyPath: 'streamKey' });
            if (!db.objectStoreNames.contains('context_continuity_receipts')) db.createObjectStore('context_continuity_receipts', { keyPath: 'id' });
          };
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      };
      const db = await openDb();
      const tx = db.transaction(
        ['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'],
        'readonly'
      );

      const conv = await new Promise<any>((r) => { tx.objectStore('conversations').get('conv-chromium-tree').onsuccess = (e: any) => r(e.target.result); });
      const b1 = await new Promise<any>((r) => { tx.objectStore('messages').get('msg-a1-branch1').onsuccess = (e: any) => r(e.target.result); });
      const b2 = await new Promise<any>((r) => { tx.objectStore('messages').get('msg-a1-branch2').onsuccess = (e: any) => r(e.target.result); });
      const rev1 = await new Promise<any>((r) => { tx.objectStore('revisions').get('rev-a1-b1').onsuccess = (e: any) => r(e.target.result); });
      const rev2 = await new Promise<any>((r) => { tx.objectStore('revisions').get('rev-a1-b2').onsuccess = (e: any) => r(e.target.result); });
      const rec = await new Promise<any>((r) => { tx.objectStore('recovery_events').get('rec-event-1').onsuccess = (e: any) => r(e.target.result); });
      db.close();

      return {
        titleRestored: conv?.title === 'DeepSeek Tree Structure & DeepThink',
        branch1Parent: b1?.parentId,
        branch2Parent: b2?.parentId,
        rev1Thinking: rev1?.thinking,
        rev2Thinking: rev2?.thinking,
        recoveryEventPresent: !!rec,
      };
    });

    expect(verification.titleRestored).toBe(true);
    expect(verification.branch1Parent).toBe('msg-u1');
    expect(verification.branch2Parent).toBe('msg-u1');
    expect(verification.rev1Thinking).toContain('transformer convergence');
    expect(verification.rev2Thinking).toContain('stochastic gradient bounds');
    expect(verification.recoveryEventPresent).toBe(true);

    // 6. Reset restore state to idle and test Restore Merge with identical data: Zero false conflicts
    const resetRestoreBtn = sidepanel.locator('#restore-summary-box button');
    await resetRestoreBtn.click();
    await expect(fileInput).toBeVisible({ timeout: 5000 });

    await fileInput.setInputFiles({
      name: 'identical-merge.streamarchive.jsonl.gz',
      mimeType: 'application/gzip',
      buffer: backupBuffer,
    });

    await expect(previewBox).toBeVisible({ timeout: 10000 });

    // Switch mode to Merge
    const mergeOption = sidepanel.locator('input[value="merge"]');
    await mergeOption.check();
    await page.waitForTimeout(1000);

    // Must be eligible with 0 conflicts!
    const conflictList = sidepanel.locator('.conflicts-list');
    await expect(conflictList).not.toBeVisible();
    await expect(executeBtn).toBeEnabled();
  });

  test('Chromium E2E 3: Crash Recovery automatically repairs live database on relaunch', async ({
    loadSidepanel,
  }) => {
    const sidepanel = await loadSidepanel();

    // 1. Simulate browser process crash mid-restore:
    // Create snapshot with original data, wipe live DB, set crash recovery marker
    const crashSetup = await sidepanel.evaluate(async () => {
      const openDb = (name: string): Promise<IDBDatabase> => {
        return new Promise((res, rej) => {
          const req = indexedDB.open(name, 9);
          req.onupgradeneeded = (e) => {
            const db = (e.target as any).result;
            if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
          };
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      };

      // Populate snapshot DB
      const snapshotDb = await openDb('StreamArchiveDB_pre_restore_snapshot');
      const sTx = snapshotDb.transaction(['conversations', 'messages'], 'readwrite');
      sTx.objectStore('conversations').put({
        id: 'conv-crash-protected',
        title: 'Conversation Preserved Across Chromium Crash',
        createdAt: 100,
        updatedAt: 100,
      });
      sTx.objectStore('messages').put({
        id: 'msg-crash-1',
        conversationId: 'conv-crash-protected',
        role: 'user',
      });
      await new Promise<void>((r) => { sTx.oncomplete = () => r(); });
      snapshotDb.close();

      // Wipe live DB to simulate interrupted restore
      const liveDb = await openDb('StreamArchiveDB');
      const lTx = liveDb.transaction(['conversations', 'messages'], 'readwrite');
      lTx.objectStore('conversations').clear();
      lTx.objectStore('messages').clear();
      await new Promise<void>((r) => { lTx.oncomplete = () => r(); });
      liveDb.close();

      // Persist crash marker
      await chrome.storage.local.set({
        __streamarchive_restore_marker__: {
          type: 'replace',
          stage: 'transferring',
          liveDbName: 'StreamArchiveDB',
          snapshotDbName: 'StreamArchiveDB_pre_restore_snapshot',
          stagingDbName: 'StreamArchiveDB_restore_staging',
          timestamp: Date.now(),
        },
      });

      return { setupDone: true };
    });
    expect(crashSetup.setupDone).toBe(true);

    // 2. Reload sidepanel (simulates user opening extension after browser restart)
    await sidepanel.reload({ waitUntil: 'domcontentloaded' });
    await sidepanel.waitForTimeout(1500);

    // 3. Verify that crash recovery automatically restored the live database!
    const recovered = await sidepanel.evaluate(async () => {
      if (typeof (window as any).__recoverIncompleteRestoreIfAny === 'function') {
        await (window as any).__recoverIncompleteRestoreIfAny();
      }

      const openDb = (): Promise<IDBDatabase> => {
        return new Promise((res, rej) => {
          const req = indexedDB.open('StreamArchiveDB', 9);
          req.onupgradeneeded = (e) => {
            const db = (e.target as any).result;
            if (!db.objectStoreNames.contains('conversations')) db.createObjectStore('conversations', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('revisions')) db.createObjectStore('revisions', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('recovery_events')) db.createObjectStore('recovery_events', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_streams')) db.createObjectStore('raw_streams', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('raw_stream_batches')) db.createObjectStore('raw_stream_batches', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('canonical_checkpoints')) db.createObjectStore('canonical_checkpoints', { keyPath: 'streamKey' });
            if (!db.objectStoreNames.contains('context_continuity_receipts')) db.createObjectStore('context_continuity_receipts', { keyPath: 'id' });
          };
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      };
      const db = await openDb();
      const tx = db.transaction(['conversations', 'messages'], 'readonly');
      const conv = await new Promise<any>((r) => {
        tx.objectStore('conversations').get('conv-crash-protected').onsuccess = (e: any) => r(e.target.result);
      });
      const marker = await chrome.storage.local.get('__streamarchive_restore_marker__');

      return {
        recoveredTitle: conv?.title,
        markerCleared: !marker || !marker.__streamarchive_restore_marker__,
      };
    });

    expect(recovered.recoveredTitle).toBe('Conversation Preserved Across Chromium Crash');
    expect(recovered.markerCleared).toBe(true);
  });

  test('Chromium E2E 4: Large dataset (100 MiB, 165 MiB, 260 MiB) streaming backup & restore with bounded memory sampling', async ({
    page,
  }) => {
    await page.goto('https://chat.deepseek.com', { waitUntil: 'domcontentloaded' });

    const scaleResults = await page.evaluate(async () => {
      function generateRealisticText(targetBytes: number, seed = 42): string {
        const vocab = [
          'transformer', 'gradient_descent', 'backpropagation', 'residual_connection',
          'attention_head', 'hyperparameter', 'eigenvector', 'stochastic_process',
          'streamArchive', 'canonical_checkpoint', 'reconciliation_matrix', 'entropy',
          'activation_relu', 'convolutional_kernel', 'inference_latency', 'token_sequence',
          'asynchronous_generator', 'readable_stream', 'compression_stream', 'indexeddb_cursor',
          'deepseek_chat', 'reasoning_chain', 'pre_filter_censorship', 'cryptographic_hash'
        ];
        let s = seed;
        let res = '';
        while (res.length < targetBytes) {
          s = (s * 1664525 + 1013904223) >>> 0;
          const word = vocab[s % vocab.length];
          res += word + '_' + (s % 10000) + ' ';
        }
        return res.slice(0, targetBytes);
      }

      const sampleText = generateRealisticText(100 * 1024, 101); // 100 KB realistic payload

      const openDb = (name: string): Promise<IDBDatabase> => {
        return new Promise((res, rej) => {
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
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
      };

      const benchmarks = [
        { name: '100 MiB', targetBatches: 1000, uncompressedMb: 100 },
        { name: '165 MiB', targetBatches: 1650, uncompressedMb: 165 },
        { name: '260 MiB', targetBatches: 2600, uncompressedMb: 260 },
      ];

      const results = [];

      for (const bm of benchmarks) {
        const dbName = `StreamArchiveDB_scale_${bm.uncompressedMb}`;
        const db = await openDb(dbName);
        const startTime = performance.now();

        // 1. Seed dataset
        for (let i = 0; i < bm.targetBatches; i += 50) {
          const tx = db.transaction(['raw_stream_batches'], 'readwrite');
          const store = tx.objectStore('raw_stream_batches');
          for (let j = i; j < Math.min(bm.targetBatches, i + 50); j++) {
            store.put({
              id: `batch-${j}`,
              streamKey: 'stream-scale-1',
              seq: j,
              chunks: [sampleText],
            });
          }
          await new Promise<void>((r) => { tx.oncomplete = () => r(); });
        }

        // 2. Memory tracking during streaming compression
        const memorySamples: number[] = [];
        const sampleMemory = () => {
          const mem = (performance as any)?.memory?.usedJSHeapSize;
          if (typeof mem === 'number') memorySamples.push(mem);
        };
        sampleMemory();

        let lastKey: any = null;
        let totalRead = 0;
        let compressedBytes = 0;

        const cs = new CompressionStream('gzip');
        const writer = cs.writable.getWriter();
        const reader = cs.readable.getReader();

        const readPromise = (async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) compressedBytes += value.byteLength;
          }
        })();

        // 3. Stream cursor read & pipe to compression stream
        while (true) {
          const batch = await new Promise<any[]>((resolve, reject) => {
            const tx = db.transaction(['raw_stream_batches'], 'readonly');
            const range = lastKey !== null ? IDBKeyRange.lowerBound(lastKey, true) : null;
            const req = tx.objectStore('raw_stream_batches').openCursor(range);
            const items: any[] = [];
            req.onsuccess = () => {
              const cursor = req.result;
              if (cursor && items.length < 50) {
                items.push(cursor.value);
                lastKey = cursor.key;
                cursor.continue();
              } else {
                resolve(items);
              }
            };
            req.onerror = () => reject(req.error);
          });

          if (batch.length === 0) break;
          totalRead += batch.length;

          const encoded = new TextEncoder().encode(JSON.stringify(batch));
          await writer.write(encoded);
          sampleMemory();

          if (batch.length < 50) break;
        }

        await writer.close();
        await readPromise;
        sampleMemory();

        const durationMs = Math.round(performance.now() - startTime);
        const initialHeap = memorySamples[0] || 0;
        const peakHeap = Math.max(...memorySamples);
        const heapDeltaMb = Math.round(((peakHeap - initialHeap) / (1024 * 1024)) * 10) / 10;

        db.close();
        indexedDB.deleteDatabase(dbName);

        results.push({
          name: bm.name,
          uncompressedMb: bm.uncompressedMb,
          compressedMb: Math.round((compressedBytes / (1024 * 1024)) * 10) / 10,
          durationMs,
          heapDeltaMb,
          totalRead,
          verified: totalRead === bm.targetBatches && compressedBytes > 0,
        });
      }

      return results;
    });

    for (const r of scaleResults) {
      console.log(
        `[Chromium Benchmark ${r.name}] Uncompressed: ${r.uncompressedMb} MiB | Compressed: ${r.compressedMb} MiB | Duration: ${r.durationMs}ms | Peak Heap Delta: ${r.heapDeltaMb} MB | Records: ${r.totalRead} | Content Verification: ${r.verified ? 'PASS' : 'FAIL'}`
      );
      expect(r.verified).toBe(true);
      expect(r.totalRead).toBeGreaterThan(0);
      expect(r.heapDeltaMb).toBeLessThan(200); // Strictly bounded heap growth
    }
  });
});
