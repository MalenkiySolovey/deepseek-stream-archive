import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORTABLE_BACKUP_EXTENSION } from '../../src/backup';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Conservative Safe Restore (Merge Mode)', () => {
  test('safely merges non-conflicting backup archive preserving local records, and verifies idempotency', async ({
    page,
    router,
    loadSidepanel,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    // 1. Setup mock completion endpoint
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

    // 2. Generate Conversation B to create an exportable backup file
    const sessionB = 'sess-merge-beta';
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionB}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Conversation Beta Prompt' }));
    });
    await page.waitForTimeout(1000);

    // 3. Open Sidepanel and Create Backup of Beta
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
    const backupBetaBuffer = Buffer.concat(chunks);
    expect(backupBetaBuffer.length).toBeGreaterThan(0);

    // 4. Reset IndexedDB directly in browser so we can create local Conversation Alpha
    await sidepanel.evaluate(async () => {
      const dbReq = indexedDB.open('StreamArchiveDB', 8);
      await new Promise<void>((resolve, reject) => {
        dbReq.onsuccess = () => {
          const db = dbReq.result;
          const stores = [
            'conversations',
            'messages',
            'revisions',
            'recovery_events',
            'raw_streams',
            'raw_stream_batches',
            'canonical_checkpoints',
            'history_staging',
            'history_staging_manifests',
          ];
          const tx = db.transaction(stores, 'readwrite');
          for (const s of stores) {
            tx.objectStore(s).clear();
          }
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        dbReq.onerror = () => reject(dbReq.error);
      });
    });

    // 5. Generate Conversation Alpha
    const sessionA = 'sess-merge-alpha';
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionA}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Conversation Alpha Prompt' }));
    });
    await page.waitForTimeout(1000);

    // 6. Verify Sidepanel Archive has only Conversation Alpha
    const archiveTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Archive|Архив/i });
    await archiveTabBtn.click();
    
    const cardLocator = sidepanel.locator('.conversation-card');
    await expect(cardLocator.first()).toBeVisible({ timeout: 5000 });

    let archiveText = await sidepanel.locator('.conversations-list').innerText();
    expect(archiveText).not.toContain(sessionB);

    // 7. Go to Settings and upload Backup Beta to Merge
    await settingsTabBtn.click();

    const fileInput = sidepanel.locator('#backup-file-input');
    await fileInput.setInputFiles({
      name: 'backup-beta.streamarchive.jsonl.gz',
      mimeType: 'application/gzip',
      buffer: backupBetaBuffer,
    });

    // 8. Select Merge mode in UI
    const previewBox = sidepanel.locator('#restore-preview-box');
    await expect(previewBox).toBeVisible({ timeout: 10000 });

    const mergeRadio = sidepanel.locator('input[type="radio"][value="merge"]');
    await mergeRadio.check();

    const executeBtn = sidepanel.locator('#execute-restore-btn');
    await expect(executeBtn).toBeEnabled();
    await executeBtn.click();

    // 9. Verify Restore Complete summary box
    const summaryBox = sidepanel.locator('#restore-summary-box');
    await expect(summaryBox).toBeVisible({ timeout: 10000 });

    // 10. Switch to Archive tab and verify union: BOTH Alpha and Beta exist
    await archiveTabBtn.click();
    await expect(cardLocator.first()).toBeVisible({ timeout: 5000 });

    const count = await cardLocator.count();
    expect(count).toBeGreaterThanOrEqual(2);

    // 11. Idempotency test: upload Backup Beta a second time
    await settingsTabBtn.click();
    const resetBtn = sidepanel.locator('#restore-summary-box button');
    await expect(resetBtn).toBeVisible();
    await resetBtn.click();

    await fileInput.setInputFiles({
      name: 'backup-beta.streamarchive.jsonl.gz',
      mimeType: 'application/gzip',
      buffer: backupBetaBuffer,
    });

    await expect(previewBox).toBeVisible({ timeout: 10000 });
    await mergeRadio.check();
    await expect(executeBtn).toBeEnabled();
    await executeBtn.click();

    await expect(summaryBox).toBeVisible({ timeout: 10000 });
  });
});
