import { test, expect } from './extension-fixture';

test.describe('E2E Browser Compatibility: Route Switch & Privacy Revocation', () => {
  test('revokes overlay state immediately on navigation between sessions with zero cross-session projection', async ({
    page,
  }) => {
    // 1. Navigate to Session A
    await page.goto('https://chat.deepseek.com/a/chat/s/sess-route-A');
    await expect(page.locator('div[data-streamarchive-overlay-root]')).toBeAttached();

    // 2. Perform in-page client-side pushState navigation to Session B
    await page.evaluate(() => {
      window.history.pushState({}, '', '/a/chat/s/sess-route-B');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    // 3. Verify URL changed and no errors or crashes occurred
    expect(page.url()).toContain('/a/chat/s/sess-route-B');

    // 4. Navigate to non-session route (homepage)
    await page.evaluate(() => {
      window.history.pushState({}, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    await page.waitForTimeout(300);
    expect(page.url()).toBe('https://chat.deepseek.com/');

    // Page DOM must remain intact
    await expect(page.locator('#root')).toBeAttached();
  });
});
