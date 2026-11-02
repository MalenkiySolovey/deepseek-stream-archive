import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Human Conversation Export (Markdown & JSON)', () => {
  test('exports conversation as human-readable Markdown and structured JSON without permissions violation', async ({
    page,
    router,
    loadSidepanel,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    const sessionId = 'sess-export-e2e';

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

    // 2. Open DeepSeek chat page and trigger generation
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

    // 4. Navigate into conversation
    const card = sidepanel.locator('.conversation-card').first();
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.click();

    // 5. Verify ConversationView is displayed and export button is visible
    const exportBtn = sidepanel.locator('button.export-header-btn');
    await expect(exportBtn).toBeVisible({ timeout: 5000 });
    await exportBtn.click();

    // 6. Verify Export Modal opened
    const modal = sidepanel.locator('.modal-card');
    await expect(modal).toBeVisible();

    // 7. Test Markdown export download
    const downloadPromise = sidepanel.waitForEvent('download');
    const confirmBtn = sidepanel.locator('button.modal-btn.primary');
    await confirmBtn.click();

    const download = await downloadPromise;
    const filename = download.suggestedFilename();
    expect(filename).toMatch(/\.md$/);

    // Read downloaded content
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const markdownContent = Buffer.concat(chunks).toString('utf-8');

    expect(markdownContent).toContain('- **StreamArchive Format:** `human-markdown-v1`');
    expect(markdownContent).toContain('## Assistant');
    expect(markdownContent).toContain('Hello from synthetic DeepSeek stream');

    // 8. Test JSON export download
    await exportBtn.click();
    await expect(modal).toBeVisible();

    // Select JSON radio
    const jsonRadio = sidepanel.locator('input[type="radio"][value="json"]');
    await jsonRadio.check();

    const jsonDownloadPromise = sidepanel.waitForEvent('download');
    await confirmBtn.click();

    const jsonDownload = await jsonDownloadPromise;
    const jsonFilename = jsonDownload.suggestedFilename();
    expect(jsonFilename).toMatch(/\.json$/);

    const jsonStream = await jsonDownload.createReadStream();
    const jsonChunks: Buffer[] = [];
    for await (const chunk of jsonStream) {
      jsonChunks.push(chunk as Buffer);
    }
    const jsonContent = Buffer.concat(jsonChunks).toString('utf-8');
    const parsed = JSON.parse(jsonContent);

    expect(parsed.format).toBe('deepseek-streamarchive-conversation');
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.messages.length).toBeGreaterThanOrEqual(1);
  });
});
