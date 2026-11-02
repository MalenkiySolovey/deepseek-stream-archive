import type { Route } from '@playwright/test';

export type RouteHandler = (route: Route) => Promise<void>;

export interface FixtureEntry {
  id: string;
  pattern: RegExp | string;
  method?: string;
  resourceType?: string;
  handler: RouteHandler;
}

export class FixtureRegistry {
  private readonly fixtures: FixtureEntry[] = [];

  registerDocument(pattern: RegExp | string, html: string): this {
    this.fixtures.push({
      id: `doc_${String(pattern)}`,
      pattern,
      resourceType: 'document',
      handler: async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: html,
        });
      },
    });
    return this;
  }

  registerSseEndpoint(
    pattern: RegExp | string,
    sseBody: string,
    options?: { status?: number; headers?: Record<string, string> }
  ): this {
    this.fixtures.push({
      id: `sse_${String(pattern)}`,
      pattern,
      handler: async (route) => {
        await route.fulfill({
          status: options?.status ?? 200,
          contentType: 'text/event-stream; charset=utf-8',
          headers: {
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            ...(options?.headers || {}),
          },
          body: sseBody,
        });
      },
    });
    return this;
  }

  registerJsonEndpoint(
    pattern: RegExp | string,
    data: unknown,
    options?: { status?: number; headers?: Record<string, string> }
  ): this {
    const bodyStr = typeof data === 'string' ? data : JSON.stringify(data);
    this.fixtures.push({
      id: `json_${String(pattern)}`,
      pattern,
      handler: async (route) => {
        await route.fulfill({
          status: options?.status ?? 200,
          contentType: 'application/json; charset=utf-8',
          headers: {
            'Cache-Control': 'no-cache',
            ...(options?.headers || {}),
          },
          body: bodyStr,
        });
      },
    });
    return this;
  }

  registerCustomHandler(
    pattern: RegExp | string,
    handler: RouteHandler,
    options?: { method?: string; resourceType?: string }
  ): this {
    this.fixtures.push({
      id: `custom_${String(pattern)}`,
      pattern,
      method: options?.method,
      resourceType: options?.resourceType,
      handler,
    });
    return this;
  }

  findHandler(url: string, method: string, resourceType: string): RouteHandler | null {
    for (const fixture of this.fixtures) {
      if (fixture.method && fixture.method.toUpperCase() !== method.toUpperCase()) {
        continue;
      }
      if (fixture.resourceType && fixture.resourceType !== resourceType) {
        continue;
      }

      let matches = false;
      if (typeof fixture.pattern === 'string') {
        if (fixture.pattern.endsWith('*')) {
          matches = url.startsWith(fixture.pattern.slice(0, -1));
        } else {
          matches = url === fixture.pattern || url.startsWith(fixture.pattern + '?');
        }
      } else if (fixture.pattern instanceof RegExp) {
        matches = fixture.pattern.test(url);
      }

      if (matches) {
        return fixture.handler;
      }
    }
    return null;
  }

  clear(): void {
    this.fixtures.length = 0;
  }
}
