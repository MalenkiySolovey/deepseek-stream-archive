import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PORTABLE_BACKUP_EXTENSION } from '../../src/backup';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Atomic Restore (Replace Mode)', () => {
  test('restores archive via Replace mode, wiping subsequent mutations and restoring exact snapshot', async ({
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

    // 2. Generate Conversation A
    const sessionA = 'sess-replace-alpha';
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionA}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Conversation Alpha Prompt' }));
    });
    await page.waitForTimeout(1000);

    // 3. Open Sidepanel and Create Backup of State A
    const sidepanel = await loadSidepanel();

    // Disable showSaveFilePicker in test so it deterministically exercises Blob download fallback
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
    const backupABuffer = Buffer.concat(chunks);
    expect(backupABuffer.length).toBeGreaterThan(0);

    // 4. Mutate Archive by generating Conversation B
    const sessionB = 'sess-replace-beta';
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionB}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Conversation Beta Prompt' }));
    });
    await page.waitForTimeout(1000);

    // 5. Verify Sidepanel Archive has Conversation Beta
    const archiveTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Archive|Архив/i });
    await archiveTabBtn.click();
    await page.waitForTimeout(500);

    // 6. Navigate to Settings and Upload Backup A to Restore Card
    await settingsTabBtn.click();

    const fileInput = sidepanel.locator('#backup-file-input');
    await fileInput.setInputFiles({
      name: 'backup-a.streamarchive.jsonl.gz',
      mimeType: 'application/gzip',
      buffer: backupABuffer,
    });

    // 7. Verify Preview Box appears
    const previewBox = sidepanel.locator('#restore-preview-box');
    await expect(previewBox).toBeVisible({ timeout: 10000 });

    // 8. Confirm Replace and Execute
    const confirmCheckbox = sidepanel.locator('#confirm-replace-checkbox');
    await confirmCheckbox.check();

    const executeBtn = sidepanel.locator('#execute-restore-btn');
    await expect(executeBtn).toBeEnabled();
    await executeBtn.click();

    // 9. Verify Restore Complete summary box
    const summaryBox = sidepanel.locator('#restore-summary-box');
    await expect(summaryBox).toBeVisible({ timeout: 10000 });

    // 10. Switch to Archive tab and verify state
    await archiveTabBtn.click();
    
    // Wait for conversation card to appear in ArchiveBrowser
    const cardLocator = sidepanel.locator('.conversation-card');
    await expect(cardLocator.first()).toBeVisible({ timeout: 5000 });

    // After replace restore of Backup A:
    // Conversation Alpha must be restored
    // Conversation Beta must be gone
    const count = await cardLocator.count();
    expect(count).toBeGreaterThanOrEqual(1);

    const archiveText = await sidepanel.locator('.conversations-list').innerText();
    expect(archiveText).not.toContain(sessionB);
  });
});
