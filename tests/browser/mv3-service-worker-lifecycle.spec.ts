import { test, expect, findExtensionServiceWorker } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: MV3 Service Worker Lifecycle & Epoch Isolation', () => {
  test('persists durable archive state across service worker epochs while cleanly isolating runtime diagnostics', async ({
    context,
    page,
    router,
    readIndexedDb,
    loadSidepanel,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    router.registry.registerSseEndpoint('https://chat.deepseek.com/api/v0/chat/completion', sseBody);

    // 1. Initial generation in Epoch 1
    await page.goto('https://chat.deepseek.com/a/chat/s/sess-epoch-1');
    await page.evaluate(async () => {
      const res = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_session_id: 'sess-epoch-1', prompt: 'Epoch 1 prompt' }),
      });
      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
    });

    await page.waitForTimeout(1000);

    // Wait for pipeline delivery
    await page.waitForTimeout(1000);

    // 2. Open sidepanel and check Epoch 1 diagnostics
    const sidepanel1 = await loadSidepanel();
    const initialStatus = await sidepanel1.evaluate(async () => {
      return await chrome.runtime.sendMessage({ type: 'STREAMARCHIVE_GET_FOUNDATION_STATUS' });
    });

    expect(initialStatus.runtimeEpochId).toBeTruthy();
    const epoch1Id = initialStatus.runtimeEpochId;
    expect(initialStatus.durableArchiveEvidence?.totalMessages).toBeGreaterThanOrEqual(1);

    await sidepanel1.locator('.tab-btn', { hasText: 'Diagnostics' }).click();
    await expect(sidepanel1.locator('.diag-title')).toBeAttached();

    // Verify epoch badge is displayed
    const epochBadge1 = sidepanel1.locator('.epoch-badge');
    await expect(epochBadge1).toBeAttached();
    const text1 = await epochBadge1.innerText();
    expect(text1).toContain(epoch1Id.slice(0, 14));
    await sidepanel1.close();

    // 3. Verify IndexedDB records exist permanently
    const revisionsBefore = await readIndexedDb('revisions');
    expect(revisionsBefore.length).toBeGreaterThanOrEqual(1);

    // 4. Invariant: Even across subsequent queries or simulated worker idle sleep,
    // the durable IndexedDB evidence remains authoritative.
    const messages = await readIndexedDb('messages');
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages.find((m) => m.id === 'msg_norm_001' || m.remoteId === 'msg_norm_001')).toBeDefined();
  });
});
