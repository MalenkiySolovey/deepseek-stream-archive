// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { locateMessageAnchor, findInlineInsertionPoint } from '../src/adapters/deepseek/dom/message-locator';
import { mountInlineRecovery, OWNED_INLINE_HOSTS } from '../src/presentation/inline-recovery/dom';
import type { PageRecoveryMessageSummary } from '../src/adapters/deepseek/dom/types';
import type { OverlayContentResult } from '../src/overlay/portal';

describe('Inline Recovery Security & Trust Boundary Invariants', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
  });

  afterEach(() => {
    if (root.parentNode) {
      root.parentNode.removeChild(root);
    }
  });

  it('never places sensitive recovered text into host element attributes', () => {
    const msgEl = document.createElement('div');
    msgEl.setAttribute('data-message-id', 'sec-msg-1');
    const placeholder = document.createElement('div');
    placeholder.textContent = 'Censored';
    msgEl.appendChild(placeholder);
    root.appendChild(msgEl);

    const anchor = locateMessageAnchor('sec-msg-1', root)!;
    const target = findInlineInsertionPoint(anchor)!;

    const secretAnswer = 'SUPER_SENSITIVE_RECOVERED_PROPRIETARY_CODE_XYZ123';
    const secretThinking = 'SECRET_INTERNAL_REASONING_CHAIN_ABC789';

    const summary: PageRecoveryMessageSummary = {
      messageId: 'sec-msg-1',
      remoteId: 'sec-msg-1',
      role: 'assistant',
      status: 'filtered',
      hasLastGood: true,
      recoveryKind: 'authoritative_recovery',
      capturedAt: 1000,
      recoveredRevisionId: 'rev-sec-1',
    };

    const handle = mountInlineRecovery(target, summary, {
      text: secretAnswer,
      thinking: secretThinking,
    })!;

    expect(handle).not.toBeNull();
    const host = handle.hostElement;

    // Check all attributes on host element in light DOM
    for (let i = 0; i < host.attributes.length; i++) {
      const attr = host.attributes[i]!;
      expect(attr.value).not.toContain(secretAnswer);
      expect(attr.value).not.toContain(secretThinking);
    }

    // Verify host is tracked in isolated-world WeakSet
    expect(OWNED_INLINE_HOSTS.has(host)).toBe(true);

    handle.unmount();
  });

  it('renders malicious HTML strings as inert text with zero script execution', () => {
    const msgEl = document.createElement('div');
    msgEl.setAttribute('data-message-id', 'xss-msg-1');
    const placeholder = document.createElement('div');
    placeholder.className = 'ds-markdown';
    msgEl.appendChild(placeholder);
    root.appendChild(msgEl);

    const anchor = locateMessageAnchor('xss-msg-1', root)!;
    const target = findInlineInsertionPoint(anchor)!;

    const maliciousPayload = '<script>window.__xss_executed = true;</script><img src="x" onerror="window.__xss_executed = true" />';

    const summary: PageRecoveryMessageSummary = {
      messageId: 'xss-msg-1',
      remoteId: 'xss-msg-1',
      role: 'assistant',
      status: 'filtered',
      hasLastGood: true,
      recoveryKind: 'authoritative_recovery',
      capturedAt: 1000,
      recoveredRevisionId: 'rev-xss-1',
    };

    const handle = mountInlineRecovery(target, summary, { text: maliciousPayload })!;
    expect(handle).not.toBeNull();

    // Verify window property was not set
    expect((window as any).__xss_executed).toBeUndefined();

    // Verify no script or img elements were created in light DOM
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img')).toBeNull();

    handle.unmount();
  });
});
