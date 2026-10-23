import { test, expect } from './extension-fixture';

test.describe('E2E Browser Compatibility: Graceful Degradation on Unknown SSE Shapes', () => {
  test('handles unknown SSE payload structure gracefully without page breakage or crashing background worker', async ({
    page,
    readIndexedDb,
    loadSidepanel,
  }) => {
    // Malformed/novel SSE payload with unknown fields and strange structure
    const strangeSse = `data: {"unknown_wrapper":{"some_key":"val"},"p":"response/unknown_field","o":"SET","v":"unexpected"}

data: {"p":"response/status","o":"SET","v":"FINISHED"}

data: [DONE]
`;

    await page.route('https://chat.deepseek.com/api/v0/chat/completion', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: strangeSse,
      });
    });

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
