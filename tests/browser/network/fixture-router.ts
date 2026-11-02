import type { Page, Route } from '@playwright/test';
import { FixtureRegistry } from './fixture-registry';
import { NetworkAudit } from './network-audit';

export class FailClosedFixtureRouter {
  public readonly registry: FixtureRegistry;
  public readonly audit: NetworkAudit;

  constructor() {
    this.registry = new FixtureRegistry();
    this.audit = new NetworkAudit();
  }

  async attachToPage(page: Page): Promise<void> {
    await page.route('**/*', async (route: Route) => {
      const request = route.request();
      const url = request.url();
      const method = request.method();
      const resourceType = request.resourceType();

      // Extension assets (HTML, scripts, stylesheets, icons) inside chrome-extension origin
      if (url.startsWith('chrome-extension://')) {
        return route.continue();
      }

      // Deny-by-default for all HTTP/HTTPS requests
      const handler = this.registry.findHandler(url, method, resourceType);
      if (handler) {
        try {
          await handler(route);
          return;
        } catch (err) {
          this.audit.recordViolation(url, method, resourceType);
          await route.abort('failed');
          return;
        }
      }

      // Unhandled HTTP/HTTPS request: Block immediately and record violation
      this.audit.recordViolation(url, method, resourceType);
      await route.abort('blockedbyclient');
    });
  }
}
