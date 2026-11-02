import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Network Transport Retries & Sibling Branch Stabilization', () => {
  test('persists 3 raw transport attempts but stabilizes canonical tree into 1 logical branch without fake branch selectors', async ({
    page,
    router,
    readIndexedDb,
    loadSidepanel,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    const sessionId = 'sess-e2e-retries';
    let completionAttempt = 0;

    // 1. Register dynamic completion endpoint: 2 failed transport retries followed by successful stream
    router.registry.registerCustomHandler(
      'https://chat.deepseek.com/api/v0/chat/completion',
      async (route) => {
        completionAttempt++;
        if (completionAttempt === 1) {
          // Attempt #1: SSE headers established, but stream drops immediately with 0 tokens
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream; charset=utf-8',
            headers: {
              'Cache-Control': 'no-cache',
              Connection: 'close',
            },
            body: '',
          });
        } else if (completionAttempt === 2) {
          // Attempt #2: Retry transport also drops immediately with 0 tokens
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream; charset=utf-8',
            headers: {
              'Cache-Control': 'no-cache',
              Connection: 'close',
            },
            body: '',
          });
        } else {
          // Attempt #3: Authoritative response succeeds
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
      }
    );

    // 2. Register History endpoint with 1 User and 1 Assistant message (matching Attempt #3)
    const historyPayload = {
      code: 0,
      msg: 'success',
      data: {
        biz_data: {
          chat_session: {
            id: sessionId,
            title: 'Network Retry E2E Session',
            inserted_at: 1710000000,
            updated_at: 1710000500,
          },
          chat_messages: [
            {
              id: 9001,
              message_id: 'remote-user-retry-1',
              parent_id: null,
              role: 'USER',
              text: 'Prompt with network retries',
              status: 'FINISHED',
              inserted_at: 1710000000,
            },
            {
              id: 9002,
              message_id: 'msg_norm_001',
              parent_id: 'remote-user-retry-1',
              role: 'ASSISTANT',
              text: 'Hello from synthetic DeepSeek stream. This stream verifies canonical streaming flow.',
              status: 'FINISHED',
              inserted_at: 1710000010,
            },
          ],
        },
      },
    };

    router.registry.registerJsonEndpoint(
      new RegExp(`^https://chat\\.deepseek\\.com/api/v0/chat/history_messages\\?chat_session_id=${sessionId}`),
      historyPayload
    );

    // 3. Navigate to session route
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionId}`);
    await expect(page.locator('div[data-streamarchive-overlay-root]')).toBeAttached();

    // 4. Execute 3 XHR calls from page (simulating DeepSeek client transport retries)
    await page.evaluate(async (sess) => {
      async function sendAttempt() {
        return new Promise<void>((resolve) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion');
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.onload = () => resolve();
          xhr.onerror = () => resolve(); // continue on network failure
          xhr.send(
            JSON.stringify({
              chat_session_id: sess,
              prompt: 'Prompt with network retries',
            })
          );
        });
      }

      // Transport attempt #1
      await sendAttempt();
      // Transport attempt #2 (retry)
      await sendAttempt();
      // Transport attempt #3 (retry succeeds)
      await sendAttempt();

      // Trigger History reconciliation
      const res = await fetch(`https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=${sess}`);
      await res.json();
    }, sessionId);

    // Allow pipeline to persist checkpoints and apply history reconciliation plan
    await page.waitForTimeout(1500);

    // 5. Invariant Assertion: Raw Journal Evidence
    const rawStreams = await readIndexedDb('raw_streams');
    expect(rawStreams.length).toBeGreaterThanOrEqual(3);

    // 6. Invariant Assertion: Canonical Messages
    const messages = await readIndexedDb('messages');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');
    expect(assistantMessages.length).toBeGreaterThanOrEqual(3);

    // Logical messages check: exactly 1 logical assistant message exists
    const logicalAssistantMessages = assistantMessages.filter(
      (m) => m.projectionState === 'logical' || m.identityState === 'reconciled'
    );
    expect(logicalAssistantMessages).toHaveLength(1);
    expect(logicalAssistantMessages[0]?.remoteId).toBe('msg_norm_001');

    // Failed empty attempts must have projectionState === 'attempt_only' and parentId === undefined
    const attemptOnlyMessages = assistantMessages.filter((m) => m.projectionState === 'attempt_only');
    expect(attemptOnlyMessages.length).toBeGreaterThanOrEqual(2);
    for (const attempt of attemptOnlyMessages) {
      expect(attempt.parentId).toBeUndefined();
    }

    // 7. Verify Sidepanel Archive Browser shows honest 2 messages with NO fake branch controls
    const sidepanel = await loadSidepanel();

    // Find the session card in Archive list
    const sessionCard = sidepanel.locator('.conversation-card', { hasText: 'Network Retry E2E Session' });
    await expect(sessionCard).toBeAttached();

    // Verify messageCount badge says "2 messages" (1 user + 1 assistant, NOT 4)
    const msgCountBadge = sessionCard.locator('.meta-messages');
    await expect(msgCountBadge).toHaveText('2 messages');

    // Open the conversation detail view
    await sessionCard.click();
    await expect(sidepanel.locator('.convo-title')).toHaveText('Network Retry E2E Session');

    // In the message thread, assert that NO branch navigation buttons or indicators exist!
    const branchControls = sidepanel.locator('.branch-controls');
    await expect(branchControls).toHaveCount(0);

    // Assert that the assistant response is rendered cleanly
    const assistantCard = sidepanel.locator('.message-card.assistant');
    await expect(assistantCard).toHaveCount(1);
    await expect(assistantCard).toContainText('Hello from synthetic DeepSeek stream.');

    await sidepanel.close();
  });
});
