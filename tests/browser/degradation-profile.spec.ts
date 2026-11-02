import { test, expect } from './extension-fixture';

test.describe('E2E Browser Compatibility: Graceful Degradation on Unknown Protocol Shapes', () => {
  test('retains raw stream journal when encountering unknown SSE protocol shapes without page disruption', async ({
    page,
    router,
    readIndexedDb,
    loadSidepanel,
  }) => {
    // Malformed/novel SSE payload with unknown fields and strange structure
    const strangeSse = `data: {"unknown_wrapper":{"some_key":"val"},"p":"response/unknown_field","o":"SET","v":"unexpected"}

data: {"p":"response/status","o":"SET","v":"FINISHED"}

data: [DONE]
`;

    // Register SSE completion endpoint in central fail-closed registry
    router.registry.registerSseEndpoint('https://chat.deepseek.com/api/v0/chat/completion', strangeSse);

    await page.goto('https://chat.deepseek.com/a/chat/s/sess-degraded-test');

    // Trigger stream from MAIN world
    await page.evaluate(async () => {
      const res = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_session_id: 'sess-degraded-test' }),
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

    // 1. Raw evidence must survive even if high-level protocol was unfamiliar!
    const rawStreams = await readIndexedDb('raw_streams');
    expect(rawStreams.length).toBeGreaterThanOrEqual(1);

    // 2. Page DOM did not crash
    await expect(page.locator('#root')).toBeAttached();

    // 3. Sidepanel is functional and responsive
    const panel = await loadSidepanel();
    await panel.locator('.tab-btn', { hasText: 'Diagnostics' }).click();
    await expect(panel.locator('.diag-title')).toBeAttached();
    await panel.close();
  });
});
