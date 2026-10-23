import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Network Interruption', () => {
  test('retains partial stream revisions as partial_capture and does not claim pre_filter_recovery', async ({
    page,
    readIndexedDb,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/interrupted-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    // Return partial stream then drop connection
    await page.route('https://chat.deepseek.com/api/v0/chat/completion', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: sseBody,
      });
    });

    await page.goto('https://chat.deepseek.com/a/chat/s/sess-interrupted-001');

    await page.evaluate(async () => {
      const controller = new AbortController();
      try {
        const res = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_session_id: 'sess-interrupted-001' }),
          signal: controller.signal,
        });
        const reader = res.body?.getReader();
        if (reader) {
          await reader.read(); // Read partial chunk
          controller.abort(); // Interrupt connection mid-stream
        }
      } catch {
        // network interrupted
      }
    });

    await page.waitForTimeout(1000);

    // Verify partial captured content exists in revisions
    const revisions = await readIndexedDb('revisions');
    const partialRev = revisions.find((r) => r.text.includes('Partial captured text before connection dropped'));
    expect(partialRev).toBeDefined();

    // Verify no content_filter recovery events were falsely created
    const recoveryEvents = await readIndexedDb('recovery_events');
    const falseFilterEvent = recoveryEvents.find((e) => e.kind === 'content_filter');
    expect(falseFilterEvent).toBeUndefined();
  });
});
