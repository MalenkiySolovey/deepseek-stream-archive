import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validatePortableBackup, PORTABLE_BACKUP_EXTENSION } from '../../src/backup';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Portable Full-Archive Backup v1', () => {
  test('creates compressed portable backup from Settings UI and validates archive integrity', async ({
    page,
    router,
    loadSidepanel,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    const sessionId = 'sess-backup-e2e';

    // 1. Setup completion endpoint in mock router
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

    // 2. Open DeepSeek chat page and trigger generation to populate database
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Explain the difference between TCP and UDP' }));
    });

    await page.waitForTimeout(1000);

    // 3. Open Sidepanel
    const sidepanel = await loadSidepanel();

    // Disable showSaveFilePicker in test so it deterministically exercises Blob download fallback
    await sidepanel.evaluate(() => {
      delete (window as any).showSaveFilePicker;
    });

    // 4. Switch to Settings tab
    const settingsTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Settings|Настройки/i });
    await expect(settingsTabBtn).toBeVisible({ timeout: 5000 });
    await settingsTabBtn.click();

    // 5. Verify Backup card and create button
    const backupCard = sidepanel.locator('.backup-card');
    await expect(backupCard).toBeVisible();

    const createBackupBtn = sidepanel.locator('button.backup-btn.primary');
    await expect(createBackupBtn).toBeVisible();

    // 6. Capture download and trigger backup creation
    const downloadPromise = sidepanel.waitForEvent('download');
    await createBackupBtn.click();

    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    expect(filename).toContain(PORTABLE_BACKUP_EXTENSION);

    // 7. Read downloaded bytes
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const backupBuffer = Buffer.concat(chunks);
    expect(backupBuffer.length).toBeGreaterThan(0);

    // 8. Validate backup using pure validator
    const validation = await validatePortableBackup(new Uint8Array(backupBuffer));
    expect(validation.valid).toBe(true);
    expect(validation.format).toBe('deepseek-streamarchive-backup');
    expect(validation.formatVersion).toBe(1);
    expect(validation.counts?.conversations).toBeGreaterThanOrEqual(1);
    expect(validation.counts?.messages).toBeGreaterThanOrEqual(1);
    expect(validation.counts?.revisions).toBeGreaterThanOrEqual(1);
    expect(validation.counts?.raw_streams).toBeGreaterThanOrEqual(1);

    // 9. Verify UI summary card in Sidepanel
    const summaryBox = sidepanel.locator('.backup-summary-box');
    await expect(summaryBox).toBeVisible({ timeout: 5000 });
  });
});
