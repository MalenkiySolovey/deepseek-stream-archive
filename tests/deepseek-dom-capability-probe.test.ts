// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { probeDeepSeekDom } from '../src/adapters/deepseek/dom/capability-probe';
import { locateMessageAnchor } from '../src/adapters/deepseek/dom/message-locator';

describe('DeepSeek DOM Capability Probe & Safe Message Locator', () => {
  let testRoot: HTMLElement;

  beforeEach(() => {
    testRoot = document.createElement('div');
    testRoot.id = 'test-deepseek-root';
    document.body.appendChild(testRoot);
  });

  afterEach(() => {
    if (testRoot.parentNode) {
      testRoot.parentNode.removeChild(testRoot);
    }
  });

  it('fails open when chat container and messages are absent', () => {
    const result = probeDeepSeekDom(testRoot);
    expect(result.chatContainerFound).toBe(false);
    expect(result.messageNodesCount).toBe(0);
    expect(result.identifiedMessageRemoteIds).toHaveLength(0);
  });

  it('detects candidate container and extracts remote message IDs without mutating DOM', () => {
    // Setup mock DeepSeek DOM layout
    const container = document.createElement('main');
    container.setAttribute('data-testid', 'chat-container');

    const msg1 = document.createElement('div');
    msg1.setAttribute('data-message-id', 'msg-remote-001');
    msg1.textContent = 'User Prompt 1';

    const msg2 = document.createElement('div');
    msg2.setAttribute('data-message-id', 'msg-remote-002');
    msg2.textContent = 'Assistant Response 1';

    container.appendChild(msg1);
    container.appendChild(msg2);
    testRoot.appendChild(container);

    const initialHtml = container.innerHTML;

    const result = probeDeepSeekDom(testRoot);

    expect(result.chatContainerFound).toBe(true);
    expect(result.observedSelectors.containerSelector).toBe('main');
    expect(result.messageNodesCount).toBe(2);
    expect(result.identifiedMessageRemoteIds).toEqual(['msg-remote-001', 'msg-remote-002']);

    // Non-destructive invariant: original DOM content was not modified at all
    expect(container.innerHTML).toBe(initialHtml);
  });

  it('locates message anchor element by remoteId safely', () => {
    const msgEl = document.createElement('div');
    msgEl.setAttribute('data-message-id', 'authoritative-msg-77');
    msgEl.style.width = '200px';
    msgEl.style.height = '50px';
    testRoot.appendChild(msgEl);

    const anchor = locateMessageAnchor('authoritative-msg-77', testRoot);
    expect(anchor).not.toBeNull();
    expect(anchor?.remoteId).toBe('authoritative-msg-77');
    expect(anchor?.element).toBe(msgEl);
    expect(anchor?.rect).toBeDefined();

    // Unknown ID returns null
    const missing = locateMessageAnchor('unknown-id', testRoot);
    expect(missing).toBeNull();
  });

  it('rejects generic unverified selectors like id or data-id and prevents CSS injection attacks', () => {
    // Generic elements that lack verified data-message-id attribute
    const genericIdEl = document.createElement('div');
    genericIdEl.id = 'msg-generic-1';
    testRoot.appendChild(genericIdEl);

    const genericDataIdEl = document.createElement('div');
    genericDataIdEl.setAttribute('data-id', 'msg-generic-2');
    testRoot.appendChild(genericDataIdEl);

    // Neither generic ID nor data-id should be treated as authoritative anchor
    expect(locateMessageAnchor('msg-generic-1', testRoot)).toBeNull();
    expect(locateMessageAnchor('msg-generic-2', testRoot)).toBeNull();

    // Malicious injection attempt in remoteId
    const injectionPayload = '"><script>alert(1)</script><div [data-id]="';
    expect(() => locateMessageAnchor(injectionPayload, testRoot)).not.toThrow();
    expect(locateMessageAnchor(injectionPayload, testRoot)).toBeNull();
  });
});
