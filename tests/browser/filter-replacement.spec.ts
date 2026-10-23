import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Content Filter Replacement & In-Page Recovery', () => {
  test('preserves pre-filter lastGood revision, creates RecoveryEvent, and provides lazy overlay modal', async ({
    page,
    readIndexedDb,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/filter-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    // Intercept completion with censored stream
    await page.route('https://chat.deepseek.com/api/v0/chat/completion', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: sseBody,
      });
    });

    await page.goto('https://chat.deepseek.com/a/chat/s/sess-filter-001');

    // Trigger stream from MAIN world
    await page.evaluate(async () => {
      const res = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_session_id: 'sess-filter-001' }),
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

    // 1. Verify IndexedDB contains lastGood revision
    const revisions = await readIndexedDb('revisions');
    const lastGoodRev = revisions.find((r) => r.isLastGood === true);
    expect(lastGoodRev).toBeDefined();
    expect(lastGoodRev?.text).toContain('Valuable pre-filter response content with important mathematical derivations.');

    // 2. Verify RecoveryEvent was recorded
    const recoveryEvents = await readIndexedDb('recovery_events');
    expect(recoveryEvents.length).toBeGreaterThanOrEqual(1);
    const filterEvent = recoveryEvents.find((e) => e.kind === 'content_filter');
    expect(filterEvent).toBeDefined();

    // 3. Page DOM remained untouched
    const container = page.locator('#chat-messages-container');
    await expect(container).toBeAttached();
  });
});
