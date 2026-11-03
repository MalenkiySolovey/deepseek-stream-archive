import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Content Filter Replacement & In-Page Recovery', () => {
  test('preserves pre-filter lastGood revision and authoritative RecoveryEvent', async ({
    page,
    router,
    readIndexedDb,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/filter-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    // Register SSE completion endpoint in central fail-closed registry
    router.registry.registerSseEndpoint('https://chat.deepseek.com/api/v0/chat/completion', sseBody);

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

  test('preserves pre-filter content when destructive clearing patch arrives before CONTENT_FILTER status (Milestone v0.1.0 core correctness)', async ({
    page,
    router,
    readIndexedDb,
  }) => {
    // Exact representation of live observed bug:
    // 1. Tokens streamed into RESPONSE fragment
    // 2. Destructive patch clears fragments to []
    // 3. Status CONTENT_FILTER arrives in separate packet
    const sseBody = [
      'data: {"p":"response/message_id","o":"SET","v":"msg_filter_destruct_002"}',
      '',
      'data: {"p":"response/session_id","o":"SET","v":"sess-filter-destruct-002"}',
      '',
      'data: {"p":"response/fragments","o":"SET","v":[{"type":"THINK","content":"Analytical safety considerations."},{"type":"RESPONSE","content":"CRITICAL PRE-FILTER TEXT: Crucial user explanation before destructive removal."}]}',
      '',
      'data: {"p":"response/fragments","o":"SET","v":[]}',
      '',
      'data: {"p":"response/status","o":"SET","v":"CONTENT_FILTER"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    router.registry.registerSseEndpoint('https://chat.deepseek.com/api/v0/chat/completion', sseBody);

    await page.goto('https://chat.deepseek.com/a/chat/s/sess-filter-destruct-002');

    await page.evaluate(async () => {
      const res = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_session_id: 'sess-filter-destruct-002' }),
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

    // 1. Verify IndexedDB contains lastGood revision with the actual pre-filter text, NOT 0 chars!
    const revisions = await readIndexedDb('revisions');
    const lastGoodRev = revisions.find((r) => r.isLastGood === true);
    expect(lastGoodRev).toBeDefined();
    expect(lastGoodRev?.text).toBe('CRITICAL PRE-FILTER TEXT: Crucial user explanation before destructive removal.');
    expect(lastGoodRev?.text.length).toBeGreaterThan(0);

    // 2. Verify RecoveryEvent references that non-empty lastGood revision
    const recoveryEvents = await readIndexedDb('recovery_events');
    const filterEvent = recoveryEvents.find((e) => e.kind === 'content_filter');
    expect(filterEvent).toBeDefined();
    expect(filterEvent?.recoveredRevisionId).toBe(lastGoodRev?.id);
  });
});
