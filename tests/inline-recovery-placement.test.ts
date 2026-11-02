// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { locateMessageAnchor, findInlineInsertionPoint } from '../src/adapters/deepseek/dom/message-locator';
import { probeDeepSeekDom } from '../src/adapters/deepseek/dom/capability-probe';

describe('Inline Recovery DOM Placement & Capability Probing', () => {
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

  it('probes DOM capabilities including inline insertion and toolbar separation', () => {
    const main = document.createElement('main');
    root.appendChild(main);

    const msg = document.createElement('div');
    msg.setAttribute('data-message-id', 'msg-101');
    main.appendChild(msg);

    const content = document.createElement('div');
    content.className = 'ds-markdown';
    content.textContent = 'Hello world';
    msg.appendChild(content);

    const toolbar = document.createElement('div');
    toolbar.className = 'ds-message-actions';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    const regenBtn = document.createElement('button');
    regenBtn.textContent = 'Regenerate';
    toolbar.appendChild(copyBtn);
    toolbar.appendChild(regenBtn);
    msg.appendChild(toolbar);

    const probe = probeDeepSeekDom(document);
    expect(probe.chatContainerFound).toBe(true);
    expect(probe.messageNodesCount).toBe(1);
    expect(probe.messageAnchorStrongIdentity).toBe(true);
    expect(probe.inlineRecoveryInsertionPoint).toBe(true);
    expect(probe.nativeToolbarSeparation).toBe(true);
    expect(probe.identifiedMessageRemoteIds).toEqual(['msg-101']);
  });

  it('identifies Level 1 body insertion point with placeholder and preserves native toolbar', () => {
    const msg = document.createElement('div');
    msg.setAttribute('data-message-id', 'msg-202');
    root.appendChild(msg);

    const placeholder = document.createElement('div');
    placeholder.className = 'ds-markdown';
    placeholder.textContent = "Sorry, that's beyond my current scope. Let's talk about something else.";
    msg.appendChild(placeholder);

    const toolbar = document.createElement('div');
    toolbar.setAttribute('data-message-actions', 'true');
    toolbar.appendChild(document.createElement('button'));
    toolbar.appendChild(document.createElement('button'));
    msg.appendChild(toolbar);

    const anchor = locateMessageAnchor('msg-202', root);
    expect(anchor).not.toBeNull();

    const target = findInlineInsertionPoint(anchor!);
    expect(target).not.toBeNull();
    expect(target?.level).toBe('level_1_body');
    expect(target?.placeholderElement).toBe(placeholder);
    expect(target?.toolbarElement).toBe(toolbar);
    expect(target?.containerElement).toBe(msg);
    expect(target?.insertRefNode).toBe(toolbar);
  });

  it('identifies Level 2 adjacent insertion before toolbar when content has no distinct container', () => {
    const msg = document.createElement('div');
    msg.setAttribute('data-message-id', 'msg-303');
    root.appendChild(msg);

    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    toolbar.appendChild(document.createElement('button'));
    toolbar.appendChild(document.createElement('button'));
    msg.appendChild(toolbar);

    const anchor = locateMessageAnchor('msg-303', root);
    expect(anchor).not.toBeNull();

    const target = findInlineInsertionPoint(anchor!);
    expect(target).not.toBeNull();
    expect(target?.level).toBe('level_2_adjacent');
    expect(target?.placeholderElement).toBeNull();
    expect(target?.toolbarElement).toBe(toolbar);
    expect(target?.insertRefNode).toBe(toolbar);
  });

  it('returns null on invalid anchor element', () => {
    const target = findInlineInsertionPoint({
      remoteId: 'null-id',
      element: null as any,
      rect: new DOMRect(),
      authority: 'verified_message_id_attribute',
    });
    expect(target).toBeNull();
  });
});
