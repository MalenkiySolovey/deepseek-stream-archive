import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ExtensionTestFixtures {
  context: BrowserContext;
  extensionId: string;
  page: Page;
  deepseekPageHtml: string;
  loadSidepanel: () => Promise<Page>;
  readIndexedDb: (storeName: string) => Promise<any[]>;
}

export const test = base.extend<ExtensionTestFixtures>({
  context: async ({}, use) => {
    const pathToExtension = path.resolve(__dirname, '../../.output/chrome-mv3');
    if (!fs.existsSync(pathToExtension)) {
      throw new Error(`Extension build not found at ${pathToExtension}. Run 'pnpm run build' before browser tests.`);
    }

    const targetPath = pathToExtension.replace(/\\/g, '/');

    const launchOptions: any = {
      headless: false,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--headless=new',
        `--disable-extensions-except=${targetPath}`,
        `--load-extension=${targetPath}`,
        '--no-sandbox',
        '--disable-gpu',
      ],
    };

    // Dynamic import to use chromium from playwright
    const { chromium } = await import('@playwright/test');
    const context = await chromium.launchPersistentContext('', launchOptions);

    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    // Wait for extension background service worker to register
    let [background] = context.serviceWorkers();
    if (!background) {
      background = await context.waitForEvent('serviceworker', { timeout: 10000 });
    }
    const extensionId = background.url().split('/')[2] || '';
    await use(extensionId);
  },

  deepseekPageHtml: async ({}, use) => {
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>DeepSeek Chat</title>
</head>
<body>
  <div id="root">
    <div class="chat-layout">
      <main id="chat-messages-container">
        <!-- Page owned messages will be dynamically added or mocked -->
      </main>
    </div>
  </div>
</body>
</html>`;
    await use(html);
  },

  page: async ({ context, deepseekPageHtml }, use) => {
    const page = await context.newPage();

    // Guard: Zero unexpected external network access
    await page.route('**/*', async (route) => {
      const url = route.request().url();
      if (!url.startsWith('https://chat.deepseek.com') && !url.startsWith('chrome-extension://')) {
        console.warn(`[Blocked External Request] ${url}`);
        return route.abort('blockedbyclient');
      }

      // Default fulfill for main page document
      if (
        route.request().resourceType() === 'document' &&
        url.startsWith('https://chat.deepseek.com/a/chat/s/')
      ) {
        return route.fulfill({
          status: 200,
          contentType: 'text/html',
          body: deepseekPageHtml,
        });
      }

      // Default fallback for unhandled requests: pass through to route continuation or empty json
      return route.continue();
    });

    await use(page);
  },

  loadSidepanel: async ({ context, extensionId }, use) => {
    const loader = async () => {
      const panelPage = await context.newPage();
      await panelPage.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      return panelPage;
    };
    await use(loader);
  },

  readIndexedDb: async ({ context }, use) => {
    const reader = async (storeName: string) => {
      let [sw] = context.serviceWorkers();
      if (!sw) {
        sw = await context.waitForEvent('serviceworker', { timeout: 5000 });
      }
      return await sw.evaluate(async (store) => {
        return new Promise<any[]>((resolve, reject) => {
          const req = indexedDB.open('StreamArchiveDB');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            try {
              const tx = db.transaction(store, 'readonly');
              const s = tx.objectStore(store);
              const getReq = s.getAll();
              getReq.onsuccess = () => resolve(getReq.result || []);
              getReq.onerror = () => reject(getReq.error);
            } catch (err) {
              reject(err);
            }
          };
        });
      }, storeName);
    };
    await use(reader);
  },
});

export { expect };
