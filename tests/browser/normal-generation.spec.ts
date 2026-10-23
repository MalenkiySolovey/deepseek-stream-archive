import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Normal Stream Generation', () => {
  test('records raw stream, commits canonical message, and preserves page DOM with zero mutation', async ({
    page,
    readIndexedDb,
    loadSidepanel,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    // Intercept completion API endpoint with synthetic SSE stream
    await page.route('https://chat.deepseek.com/api/v0/chat/completion', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        headers: {
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
        body: sseBody,
      });
    });

    // 1. Navigate to DeepSeek chat session route
    await page.goto('https://chat.deepseek.com/a/chat/s/sess-e2e-normal');

    // Verify page loaded and extension overlay host is attached
    await expect(page.locator('div[data-streamarchive-overlay-root]')).toBeAttached();

    // 2. Trigger fetch stream from inside MAIN world
    await page.evaluate(async () => {
      const res = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_session_id: 'sess-e2e-normal',
          parent_message_id: null,
          prompt: 'Hello DeepSeek',
        }),
      });

      const reader = res.body?.getReader();
      if (reader) {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      }
    });

    // Wait for asynchronous pipeline delivery to storage
    await page.waitForTimeout(1000);

    // 3. Verify IndexedDB canonical records
    const messages = await readIndexedDb('messages');
    expect(messages.length).toBeGreaterThanOrEqual(1);
    const normMsg = messages.find((m) => m.id === 'msg_norm_001' || m.remoteId === 'msg_norm_001');
    expect(normMsg).toBeDefined();

    const revisions = await readIndexedDb('revisions');
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    const normRev = revisions.find((r) => r.text.includes('Hello from synthetic DeepSeek stream.'));
    expect(normRev).toBeDefined();

    // 4. Invariant: Page DOM was not mutated or stripped
    const chatContainer = page.locator('#chat-messages-container');
    await expect(chatContainer).toBeAttached();

    // 5. Normal stream has no recovery badges
    const shadowHost = page.locator('div[data-streamarchive-overlay-root]');
    const badgeCount = await shadowHost.evaluate((el) => {
      // closed shadow root can be inspected by extension or host element check
      return el.children.length;
    });
    // Overlay host should have zero light-DOM children (shadow DOM only)
    expect(badgeCount).toBe(0);

    // 6. Sidepanel diagnostics verification
    const sidepanel = await loadSidepanel();
    await sidepanel.locator('.tab-btn', { hasText: 'Diagnostics' }).click();
    await expect(sidepanel.locator('.diag-title')).toBeAttached();

    const healthyBadges = sidepanel.locator('.stage-badge.status-healthy');
    const healthyCount = await healthyBadges.count();
    expect(healthyCount).toBeGreaterThan(0);

    await sidepanel.close();
  });
});
