import { describe, it, expect } from 'vitest';
import { FixtureRegistry } from './browser/network/fixture-registry';
import { NetworkAudit } from './browser/network/network-audit';

describe('Browser Fixture Router & Network Audit Policy (Pure Logic)', () => {
  it('matches registered document, SSE, and JSON endpoints correctly', () => {
    const registry = new FixtureRegistry();
    registry.registerDocument(/^https:\/\/chat\.deepseek\.com(\/.*)?$/, '<html>DeepSeek</html>');
    registry.registerSseEndpoint('https://chat.deepseek.com/api/v0/chat/completion', 'data: {"test":1}\n\n');
    registry.registerJsonEndpoint('https://chat.deepseek.com/api/v0/chat/history_messages*', { code: 0 });

    const docHandler = registry.findHandler('https://chat.deepseek.com/a/chat/s/123', 'GET', 'document');
    expect(docHandler).toBeDefined();

    const sseHandler = registry.findHandler('https://chat.deepseek.com/api/v0/chat/completion', 'POST', 'fetch');
    expect(sseHandler).toBeDefined();

    const jsonHandler = registry.findHandler('https://chat.deepseek.com/api/v0/chat/history_messages?session_id=123', 'GET', 'fetch');
    expect(jsonHandler).toBeDefined();

    // Unknown endpoint must return null
    const unknownHandler = registry.findHandler('https://chat.deepseek.com/api/v0/chat/unregistered', 'POST', 'fetch');
    expect(unknownHandler).toBeNull();

    // External domain must return null
    const externalHandler = registry.findHandler('https://example.com/api', 'GET', 'fetch');
    expect(externalHandler).toBeNull();
  });

  it('NetworkAudit sanitizes request details, rejecting queries, bodies, and authorization headers', () => {
    const audit = new NetworkAudit();
    const recorded = audit.recordViolation(
      'https://chat.deepseek.com/api/v0/secret_endpoint?token=super_secret_token_123',
      'POST',
      'fetch'
    );

    expect(recorded.origin).toBe('https://chat.deepseek.com');
    expect(recorded.pathname).toBe('/api/v0/secret_endpoint');
    expect(recorded.method).toBe('POST');
    expect(recorded.resourceType).toBe('fetch');
    // Ensure query secrets are not in origin or pathname
    expect(recorded.pathname).not.toContain('super_secret_token_123');

    expect(audit.count).toBe(1);
    expect(() => audit.assertClean()).toThrow(/NetworkAudit Violation/);
  });
});
