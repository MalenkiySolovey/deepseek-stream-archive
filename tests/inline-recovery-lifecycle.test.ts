// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { locateMessageAnchor, findInlineInsertionPoint } from '../src/adapters/deepseek/dom/message-locator';
import { mountInlineRecovery } from '../src/presentation/inline-recovery/dom';
import { InlineRecoveryLedger } from '../src/presentation/inline-recovery/ledger';
import type { PageRecoveryMessageSummary } from '../src/adapters/deepseek/dom/types';
import type { OverlayContentResult } from '../src/overlay/portal';

describe('Inline Recovery Lifecycle & Reversibility', () => {
  let root: HTMLElement;
  let ledger: InlineRecoveryLedger;

  beforeEach(() => {
    root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    ledger = new InlineRecoveryLedger();
  });

  afterEach(() => {
    ledger.unmountAll();
    if (root.parentNode) {
      root.parentNode.removeChild(root);
    }
  });

  function createCensoredMessageDom(messageId: string): {
    msgEl: HTMLElement;
    placeholderEl: HTMLElement;
    toolbarEl: HTMLElement;
  } {
    const msgEl = document.createElement('div');
    msgEl.setAttribute('data-message-id', messageId);

    const placeholderEl = document.createElement('div');
    placeholderEl.className = 'ds-markdown';
    placeholderEl.textContent = "Sorry, that's beyond my current scope. Let's talk about something else.";
    msgEl.appendChild(placeholderEl);

    const toolbarEl = document.createElement('div');
    toolbarEl.className = 'ds-message-actions';
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    toolbarEl.appendChild(btn);
    msgEl.appendChild(toolbarEl);

    root.appendChild(msgEl);
    return { msgEl, placeholderEl, toolbarEl };
  }

  it('mounts inline recovery into verified message and reversibly hides placeholder', () => {
    const { msgEl, placeholderEl, toolbarEl } = createCensoredMessageDom('m-filtered-1');

    const anchor = locateMessageAnchor('m-filtered-1', root);
    expect(anchor).not.toBeNull();
    const target = findInlineInsertionPoint(anchor!);
    expect(target).not.toBeNull();

    const summary: PageRecoveryMessageSummary = {
      messageId: 'm-filtered-1',
      remoteId: 'm-filtered-1',
      role: 'assistant',
      status: 'filtered',
      hasLastGood: true,
      recoveryKind: 'authoritative_recovery',
      presentationKind: 'pre_filter_recovery',
      capturedAt: 1000,
      recoveredRevisionId: 'rev-1',
    };

    const content: OverlayContentResult = {
      text: 'Recovered pre-filter answer with code:\n```typescript\nconst a = 10;\n```',
      thinking: 'Recovered mathematical thinking process step 1, 2, 3.',
    };

    const onCopy = vi.fn();
    const handle = mountInlineRecovery(target!, summary, content, {
      showThinkingInline: true,
      inlinePlacement: 'replace',
      onCopyAnswer: onCopy,
      locale: 'en',
    });

    expect(handle).not.toBeNull();
    ledger.registerHandle('m-filtered-1', handle!);

    // 1. Placeholder must be visually suppressed
    expect(placeholderEl.style.display).toBe('none');

    // 2. Extension host must be inserted into msgEl before toolbar
    const host = msgEl.querySelector('div[data-streamarchive-inline-recovery-host="m-filtered-1"]');
    expect(host).not.toBeNull();
    expect(host?.nextSibling).toBe(toolbarEl);

    // 3. Toolbar must remain in host DOM and untouched
    expect(toolbarEl.isConnected).toBe(true);
    expect(toolbarEl.querySelectorAll('button').length).toBe(1);

    // 4. Unmount restores original placeholder display and removes host
    ledger.unmount('m-filtered-1');
    expect(msgEl.querySelector('div[data-streamarchive-inline-recovery-host]')).toBeNull();
    expect(placeholderEl.style.display).toBe('');
  });

  it('enforces idempotency: mounting same ID replaces previous handle cleanly', () => {
    createCensoredMessageDom('m-idem-1');
    const anchor = locateMessageAnchor('m-idem-1', root)!;
    const target = findInlineInsertionPoint(anchor)!;

    const summary: PageRecoveryMessageSummary = {
      messageId: 'm-idem-1',
      remoteId: 'm-idem-1',
      role: 'assistant',
      status: 'filtered',
      hasLastGood: true,
      recoveryKind: 'authoritative_recovery',
      capturedAt: 1000,
      recoveredRevisionId: 'rev-1',
    };

    const content: OverlayContentResult = { text: 'Version 1' };
    const handle1 = mountInlineRecovery(target, summary, content)!;
    ledger.registerHandle('m-idem-1', handle1);
    expect(ledger.size).toBe(1);

    const handle2 = mountInlineRecovery(target, summary, { text: 'Version 2' })!;
    ledger.registerHandle('m-idem-1', handle2);
    expect(ledger.size).toBe(1);

    const hosts = root.querySelectorAll('div[data-streamarchive-inline-recovery-host]');
    expect(hosts.length).toBe(1);
  });

  it('unmountAll cleanly unmounts all active handles and restores styles', () => {
    createCensoredMessageDom('m-multi-1');
    createCensoredMessageDom('m-multi-2');

    const target1 = findInlineInsertionPoint(locateMessageAnchor('m-multi-1', root)!)!;
    const target2 = findInlineInsertionPoint(locateMessageAnchor('m-multi-2', root)!)!;

    const summary1: PageRecoveryMessageSummary = {
      messageId: 'm-multi-1',
      remoteId: 'm-multi-1',
      role: 'assistant',
      status: 'filtered',
      hasLastGood: true,
      recoveryKind: 'authoritative_recovery',
      capturedAt: 1000,
      recoveredRevisionId: 'rev-1',
    };
    const summary2: PageRecoveryMessageSummary = {
      messageId: 'm-multi-2',
      remoteId: 'm-multi-2',
      role: 'assistant',
      status: 'interrupted',
      hasLastGood: true,
      recoveryKind: 'partial_capture',
      presentationKind: 'interruption_recovery',
      capturedAt: 1001,
      recoveredRevisionId: 'rev-2',
    };

    ledger.registerHandle('m-multi-1', mountInlineRecovery(target1, summary1, { text: 'Text 1' })!);
    ledger.registerHandle('m-multi-2', mountInlineRecovery(target2, summary2, { text: 'Text 2' })!);
    expect(ledger.size).toBe(2);

    ledger.unmountAll();
    expect(ledger.size).toBe(0);
    expect(root.querySelectorAll('div[data-streamarchive-inline-recovery-host]').length).toBe(0);
  });

  it('Mode A: mounts inline recovery underneath original response without hiding placeholder', () => {
    const { msgEl, placeholderEl, toolbarEl } = createCensoredMessageDom('m-underneath-1');

    const anchor = locateMessageAnchor('m-underneath-1', root);
    const target = findInlineInsertionPoint(anchor!);

    const summary: PageRecoveryMessageSummary = {
      messageId: 'm-underneath-1',
      remoteId: 'm-underneath-1',
      role: 'assistant',
      status: 'filtered',
      hasLastGood: true,
      recoveryKind: 'authoritative_recovery',
      presentationKind: 'pre_filter_recovery',
      capturedAt: 1000,
      recoveredRevisionId: 'rev-underneath',
    };

    const content: OverlayContentResult = {
      text: 'Preserved response rendered underneath.',
      thinking: 'Reasoning chain step 1.',
    };

    const handle = mountInlineRecovery(target!, summary, content, {
      showThinkingInline: true,
      inlinePlacement: 'underneath',
      locale: 'ru',
    });

    expect(handle).not.toBeNull();
    // Mode A: placeholder style must NOT be set to none
    expect(placeholderEl.style.display).not.toBe('none');
    expect(msgEl.querySelector('div[data-streamarchive-inline-recovery-host="m-underneath-1"]')).not.toBeNull();
    handle?.unmount();
  });
});
