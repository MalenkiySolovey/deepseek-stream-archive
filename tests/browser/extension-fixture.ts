import { test as base, expect, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { FailClosedFixtureRouter } from './network/fixture-router';
import type { SanitizedRequestInfo } from './network/network-audit';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../../src/core/models';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface TypedIndexedDbReader {
  <T = any>(storeName: string): Promise<T[]>;
  conversations(): Promise<Conversation[]>;
  messages(): Promise<Message[]>;
  revisions(): Promise<ResponseRevision[]>;
  recoveryEvents(): Promise<RecoveryEvent[]>;
  rawStreams(): Promise<any[]>;
  rawBatches(): Promise<any[]>;
  canonicalCheckpoints(): Promise<any[]>;
}

export interface ExtensionTestFixtures {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  page: Page;
  router: FailClosedFixtureRouter;
  deepseekPageHtml: string;
  loadSidepanel: () => Promise<Page>;
  readIndexedDb: TypedIndexedDbReader;
  unexpectedNetworkRequests: readonly SanitizedRequestInfo[];
}

export async function findExtensionServiceWorker(
  context: BrowserContext,
  timeoutMs = 15000
): Promise<Worker> {
  // First check active workers
  const existing = context.serviceWorkers().find((sw) => sw.url().startsWith('chrome-extension://'));
  if (existing) return existing;

  // Wait for extension worker registration event
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const sw = await context.waitForEvent('serviceworker', {
      timeout: Math.max(1000, timeoutMs - (Date.now() - startTime)),
      predicate: (worker) => worker.url().startsWith('chrome-extension://'),
    }).catch(() => null);

    if (sw && sw.url().startsWith('chrome-extension://')) {
      return sw;
    }

    const current = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
    if (current) return current;
  }

  throw new Error(`[StreamArchive Test] Extension service worker (chrome-extension://) not found within ${timeoutMs}ms`);
}

export const test = base.extend<ExtensionTestFixtures>({
  context: async ({}, use) => {
    const pathToExtension = path.resolve(__dirname, '../../.output/chrome-mv3');
    if (!fs.existsSync(pathToExtension)) {
      throw new Error(`Extension build not found at ${pathToExtension}. Run 'pnpm run build' before browser tests.`);
    }

    const targetPath = pathToExtension.replace(/\\/g, '/');
    const tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamarchive-e2e-'));

    // Official Playwright pattern for testing Chrome Extensions in Chromium:
    // 1. ignoreDefaultArgs: ['--disable-extensions'] is required because Playwright disables extensions by default.
    // 2. '--headless=new' provides headless Chromium MV3 execution with extension support.
    const launchOptions = {
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

    const { chromium } = await import('@playwright/test');
    const context = await chromium.launchPersistentContext(tempUserDataDir, launchOptions);

    try {
      await use(context);
    } finally {
      await context.close().catch(() => {});
      try {
        fs.rmSync(tempUserDataDir, { recursive: true, force: true });
      } catch {
        // temp dir clean up best-effort
      }
    }
  },

  serviceWorker: async ({ context }, use) => {
    const sw = await findExtensionServiceWorker(context);
    await use(sw);
  },

  extensionId: async ({ serviceWorker }, use) => {
    const extensionId = serviceWorker.url().split('/')[2] || '';
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

  router: async ({}, use) => {
    const router = new FailClosedFixtureRouter();
    await use(router);
  },

  page: async ({ context, router, deepseekPageHtml }, use) => {
    const page = await context.newPage();

    // Default registration: All DeepSeek document routes serve the synthetic HTML fixture
    router.registry.registerDocument(/^https:\/\/chat\.deepseek\.com(\/.*)?$/, deepseekPageHtml);

    // Attach the fail-closed network router
    await router.attachToPage(page);

    await use(page);

    // Enforce Fail-Closed Network Guarantee: Assert zero unhandled external requests
    router.audit.assertClean();
  },

  unexpectedNetworkRequests: async ({ router }, use) => {
    await use(router.audit.getViolations());
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
    const readerFn = (async (storeName: string) => {
      const sw = await findExtensionServiceWorker(context);
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
    }) as TypedIndexedDbReader;

    readerFn.conversations = async () => (await readerFn('conversations')) as Conversation[];
    readerFn.messages = async () => (await readerFn('messages')) as Message[];
    readerFn.revisions = async () => (await readerFn('revisions')) as ResponseRevision[];
    readerFn.recoveryEvents = async () => (await readerFn('recovery_events')) as RecoveryEvent[];
    readerFn.rawStreams = async () => (await readerFn('raw_streams')) as any[];
    readerFn.rawBatches = async () => (await readerFn('raw_batches')) as any[];
    readerFn.canonicalCheckpoints = async () => (await readerFn('canonical_checkpoints')) as any[];

    await use(readerFn);
  },
});

export { expect };
