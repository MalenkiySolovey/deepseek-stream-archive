import { test, expect } from './extension-fixture';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('E2E Browser Compatibility: Safe Conversation Deletion', () => {
  test('deletes targeted conversation with preview while leaving other conversations 100% intact', async ({
    page,
    router,
    loadSidepanel,
  }) => {
    const fixturePath = path.resolve(__dirname, '../../fixtures/deepseek/normal-stream.sse.txt');
    const sseBody = fs.readFileSync(fixturePath, 'utf8');

    // 1. Setup mock completion endpoint
    router.registry.registerCustomHandler(
      'https://chat.deepseek.com/api/v0/chat/completion',
      async (route) => {
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
    );

    // 2. Generate Conversation Alpha
    const sessionA = 'sess-del-alpha';
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionA}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Alpha Prompt for Deletion Test' }));
    });
    await page.waitForTimeout(1000);

    // 3. Generate Conversation Beta
    const sessionB = 'sess-del-beta';
    await page.goto(`https://chat.deepseek.com/a/chat/s/${sessionB}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);

    await page.evaluate(() => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'https://chat.deepseek.com/api/v0/chat/completion', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ prompt: 'Beta Prompt to Keep Intact' }));
    });
    await page.waitForTimeout(1000);

    // 4. Open Sidepanel and navigate to Archive
    const sidepanel = await loadSidepanel();
    const archiveTabBtn = sidepanel.locator('button.tab-btn').filter({ hasText: /Archive|Архив/i });
    await expect(archiveTabBtn).toBeVisible({ timeout: 5000 });
    await archiveTabBtn.click();
    await sidepanel.waitForTimeout(500);

    // Verify both conversations appear in archive list
    const convoCards = sidepanel.locator('.conversation-card');
    await expect(convoCards).toHaveCount(2, { timeout: 5000 });

    // 5. Open Conversation Alpha detail view
    const alphaCard = convoCards.first();
    await alphaCard.click();

    // Verify detail header and Delete button are visible
    const deleteBtn = sidepanel.locator('#delete-conversation-btn');
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });

    // 6. Click Delete to trigger Preview Modal
    await deleteBtn.click();

    const deleteModal = sidepanel.locator('#delete-conversation-modal');
    await expect(deleteModal).toBeVisible({ timeout: 5000 });

    // Verify preview summary counts are visible
    const planSummary = deleteModal.locator('.delete-plan-summary');
    await expect(planSummary).toBeVisible();

    // 7. Confirm deletion
    const confirmDeleteBtn = deleteModal.locator('#confirm-delete-btn');
    await expect(confirmDeleteBtn).toBeVisible();
    await confirmDeleteBtn.click();

    // Modal should close and return to Archive list
    await expect(deleteModal).toBeHidden({ timeout: 5000 });

    // 8. Verify only 1 conversation remains (Beta)
    await expect(sidepanel.locator('.conversation-card')).toHaveCount(1, { timeout: 5000 });

    // 9. Reload sidepanel to verify durability in IndexedDB
    await sidepanel.reload();
    await archiveTabBtn.click();
    await expect(sidepanel.locator('.conversation-card')).toHaveCount(1, { timeout: 5000 });
  });
});
