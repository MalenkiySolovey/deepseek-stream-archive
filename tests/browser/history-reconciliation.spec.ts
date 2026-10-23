import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: History Reconciliation', () => {
  test('ingests and reconciles synthetic history_messages without leaking unhandled promises', async ({
    page,
    readIndexedDb,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/history-fragments.json');
    const historyJson = fs.readFileSync(fixturePath, 'utf8');

    // Intercept history endpoint
    await page.route('https://chat.deepseek.com/api/v0/chat/history_messages*', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: historyJson,
      });
    });

    await page.goto('https://chat.deepseek.com/a/chat/s/sess-hist-frag');

    // Trigger history request from page
    await page.evaluate(async () => {
      const res = await fetch('https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=sess-hist-frag');
      await res.json();
    });

    await page.waitForTimeout(1000);

    // Verify conversation was reconciled
    const conversations = await readIndexedDb('conversations');
    const histConv = conversations.find((c) => c.remoteId === 'sess-hist-frag');
    expect(histConv).toBeDefined();
    expect(histConv?.title).toBe('History Fragments Session');

    // Verify messages were ingested
    const messages = await readIndexedDb('messages');
    const histMsgs = messages.filter((m) => m.conversationId === histConv?.id);
    expect(histMsgs.length).toBe(2);
  });
});
