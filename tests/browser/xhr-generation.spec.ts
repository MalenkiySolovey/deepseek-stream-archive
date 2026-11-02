import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: XHR Stream Generation', () => {
  test('intercepts XMLHttpRequest streaming completion, commits raw journal and canonical revisions', async ({
    page,
    router,
    readIndexedDb,
    loadSidepanel,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    // Register SSE completion endpoint in central fail-closed registry
    router.registry.registerSseEndpoint('https://chat.deepseek.com/api/v0/chat/completion', sseBody);

    // 1. Navigate to DeepSeek session route
    await page.goto('https://chat.deepseek.com/a/chat/s/sess-e2e-xhr');
    await expect(page.locator('div[data-streamarchive-overlay-root]')).toBeAttached();

    // 2. Trigger stream via XMLHttpRequest from MAIN world
    await page.evaluate(() => {
      return new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion');
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.onprogress = () => {};
        xhr.onload = () => resolve();
        xhr.onerror = () => reject(new Error('XHR stream failed'));
        xhr.send(
          JSON.stringify({
            chat_session_id: 'sess-e2e-xhr',
            prompt: 'Test via XHR',
          })
        );
      });
    });

    // Wait for pipeline processing
    await page.waitForTimeout(1000);

    // 3. Verify IndexedDB records
    const rawStreams = await readIndexedDb('raw_streams');
    expect(rawStreams.length).toBeGreaterThanOrEqual(1);

    const messages = await readIndexedDb('messages');
    expect(messages.length).toBeGreaterThanOrEqual(1);

    const revisions = await readIndexedDb('revisions');
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const rev = revisions.find((r) => r.text.includes('Hello from synthetic DeepSeek stream.'));
    expect(rev).toBeDefined();

    // 4. Verify Sidepanel reports XHR stream and healthy pipeline
    const sidepanel = await loadSidepanel();
    await sidepanel.locator('.tab-btn', { hasText: 'Diagnostics' }).click();
    await expect(sidepanel.locator('.diag-title')).toBeAttached();

    const xhrItem = sidepanel.locator('.pipeline-item[data-stage-id="xhr_hook"]');
    await expect(xhrItem).toBeAttached();
    const statusBadge = xhrItem.locator('.stage-badge');
    const text = await statusBadge.innerText();
    expect(['HEALTHY', 'OBSERVED']).toContain(text.trim());

    await sidepanel.close();
  });
});
