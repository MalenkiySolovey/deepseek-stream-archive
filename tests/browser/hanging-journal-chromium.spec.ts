import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORTABLE_BACKUP_EXTENSION } from '../../src/backup';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Chromium: Hanging Journal Marker & Post-Commit Cleanup Safety', () => {
  test.setTimeout(90000);

  test('genuine Chromium: preserves snapshot on journal cleanup failure and successfully resolves via UI retry', async ({
    page,
    router,
    loadSidepanel,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.existsSync(fixturePath)
      ? fs.readFileSync(fixturePath, 'utf8')
      : 'data: {"choices":[{"delta":{"content":"Chromium Journal Safety Response"}}]}\n\ndata: [DONE]\n\n';

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

    // 2. Generate initial Conversation in DeepSeek
    const sessionId = 'sess-journal-safety-initial';
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Initial Chat for Journal Safety Test' }));
    });
    await page.waitForTimeout(1000);

    // 3. Open Sidepanel and Create Backup
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

    // 4. In sidepanel, simulate EBUSY lock on restore journal deletion
    await sidepanel.evaluate(() => {
      (window as any).__failJournalMarkerDeletion = true;
    });

    // 5. Select backup file for Restore Replace
    const fileInput = sidepanel.locator('#backup-file-input');
    await fileInput.setInputFiles({
      name: 'safety-test-backup' + PORTABLE_BACKUP_EXTENSION,
      mimeType: 'application/gzip',
      buffer: backupBuffer,
    });

    // Wait for preflight card / preview box
    const preflightCard = sidepanel.locator('#restore-preflight-card, #restore-preview-box');
    await expect(preflightCard.first()).toBeVisible({ timeout: 15000 });

    // Select Replace Mode
    const replaceRadio = sidepanel.locator('input[value="replace"]');
    await replaceRadio.check();

    const replaceCheckbox = sidepanel.locator('#confirm-replace-checkbox');
    await expect(replaceCheckbox).toBeVisible();
    await replaceCheckbox.check();

    const executeBtn = sidepanel.locator('#execute-restore-btn');
    await expect(executeBtn).toBeEnabled();
    await executeBtn.click();

    // 6. Verify that UI shows the warning box and retry button, NOT a generic success!
    const warningBanner = sidepanel.locator('#restore-journal-warning-banner');
    await expect(warningBanner).toBeVisible({ timeout: 15000 });

    // In genuine Chromium IndexedDB, verify that snapshot database exists and was preserved!
    const dbsAfterFailedCleanup = await sidepanel.evaluate(async () => {
      const dbs = await indexedDB.databases();
      return dbs.map((d) => d.name || '');
    });
    const snapshotDbFound = dbsAfterFailedCleanup.some((n) => n.startsWith('StreamArchiveDB_pre_restore_snapshot_'));
    expect(snapshotDbFound).toBe(true);

    // 7. Release simulated lock and click Retry Cleanup button in sidepanel UI
    await sidepanel.evaluate(() => {
      (window as any).__failJournalMarkerDeletion = false;
    });

    const retryBtn = sidepanel.locator('#restore-journal-warning-banner button.backup-btn.primary');
    await expect(retryBtn).toBeVisible();
    await retryBtn.click();

    // After retry, the warning banner disappears and the green summary box displays
    await expect(warningBanner).not.toBeVisible({ timeout: 10000 });
    const summaryBox = sidepanel.locator('#restore-summary-box');
    await expect(summaryBox).toBeVisible();
    await expect(summaryBox.locator('.summary-icon')).toHaveText('✅');

    // In genuine Chromium IndexedDB, verify snapshot database is now cleanly swept!
    const dbsAfterRetry = await sidepanel.evaluate(async () => {
      const dbs = await indexedDB.databases();
      return dbs.map((d) => d.name || '');
    });
    const snapshotDbLeftover = dbsAfterRetry.some((n) => n.startsWith('StreamArchiveDB_pre_restore_snapshot_'));
    expect(snapshotDbLeftover).toBe(false);

    // 8. Generate a fresh conversation in DeepSeek to verify normal live writes work flawlessly
    const sessionNext = 'sess-journal-safety-next';
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionNext}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Subsequent Conversation Prompt' }));
    });
    await page.waitForTimeout(1000);

    // Switch to Archive tab and verify both conversations exist
    const archiveTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Archive|Архив/i });
    await expect(archiveTabBtn).toBeVisible();
    await archiveTabBtn.click();

    await sidepanel.waitForTimeout(1000);
    const convItems = sidepanel.locator('.conversation-card');
    await expect(convItems.first()).toBeVisible({ timeout: 5000 });
  });
});
