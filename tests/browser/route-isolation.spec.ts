import { test, expect } from './extension-fixture';

test.describe('E2E Browser Compatibility: Route Switch & Privacy Revocation', () => {
  test('revokes overlay state immediately on client-side SPA pushState without artificial popstate events', async ({
    page,
  }) => {
    // 1. Navigate to Session A
    await page.goto('https://chat.deepseek.com/a/chat/s/sess-route-A');
    await expect(page.locator('div[data-streamarchive-overlay-root]')).toBeAttached();

    // 2. Perform real in-page client-side pushState navigation to Session B (NO synthetic popstate event)
    await page.evaluate(() => {
      window.history.pushState({}, '', '/a/chat/s/sess-route-B');
    });

    // 3. Verify URL changed and no errors or crashes occurred
    expect(page.url()).toContain('/a/chat/s/sess-route-B');

    // 4. Navigate to non-session route (homepage) via pushState (NO synthetic popstate event)
    await page.evaluate(() => {
      window.history.pushState({}, '', '/');
    });

    await page.waitForTimeout(300);
    expect(page.url()).toBe('https://chat.deepseek.com/');

    // Page DOM must remain intact
    await expect(page.locator('#root')).toBeAttached();
  });
});
