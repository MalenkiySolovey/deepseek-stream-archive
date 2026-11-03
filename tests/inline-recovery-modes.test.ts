// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mountInlineRecovery } from '../src/presentation/inline-recovery/dom';
import { locateMessageAnchor, findInlineInsertionPoint } from '../src/adapters/deepseek/dom/message-locator';
import type { PageRecoveryMessageSummary } from '../src/adapters/deepseek/dom/types';
import type { OverlayContentResult } from '../src/overlay/portal';

describe('Inline Recovery Modes & Content States (Sections 12 & 15)', () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    if (root.parentNode) {
      root.parentNode.removeChild(root);
    }
  });

  function createMessageDom(id: string) {
    const msgEl = document.createElement('div');
    msgEl.setAttribute('data-message-id', id);

    const placeholderEl = document.createElement('div');
    placeholderEl.className = 'ds-markdown';
    placeholderEl.textContent = 'Original censored text';
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

  const baseSummary: PageRecoveryMessageSummary = {
    messageId: 'msg-test',
    remoteId: 'msg-test',
    role: 'assistant',
    status: 'filtered',
    hasLastGood: true,
    recoveryKind: 'authoritative_recovery',
    presentationKind: 'pre_filter_recovery',
    capturedAt: 1000,
    recoveredRevisionId: 'rev-test',
  };

  it('State 1: Both text and thoughts -> displays both, thoughts collapsible', () => {
    const { msgEl } = createMessageDom('m-state-1');
    const target = findInlineInsertionPoint(locateMessageAnchor('m-state-1', root)!);

    const content: OverlayContentResult = {
      text: 'Full answer text about Redis architecture.',
      thinking: 'Thinking process chain: step 1, step 2.',
    };

    const handle = mountInlineRecovery(target!, baseSummary, content, {
      showThinkingInline: true,
      locale: 'ru',
    });

    expect(handle).not.toBeNull();
    const shadow = handle!.shadowRoot;
    expect(shadow.querySelector('.streamarchive-inline-body')?.textContent).toContain('Full answer text');
    expect(shadow.querySelector('details.streamarchive-inline-thinking')).not.toBeNull();
    expect(shadow.querySelector('.streamarchive-inline-notice')).toBeNull();
    handle?.unmount();
  });

  it('State 2: Text only -> displays text without thinking details element', () => {
    const { msgEl } = createMessageDom('m-state-2');
    const target = findInlineInsertionPoint(locateMessageAnchor('m-state-2', root)!);

    const content: OverlayContentResult = {
      text: 'Direct answer without thinking.',
    };

    const handle = mountInlineRecovery(target!, baseSummary, content, {
      showThinkingInline: true,
      locale: 'ru',
    });

    expect(handle).not.toBeNull();
    const shadow = handle!.shadowRoot;
    expect(shadow.querySelector('.streamarchive-inline-body')?.textContent).toContain('Direct answer without thinking.');
    expect(shadow.querySelector('details.streamarchive-inline-thinking')).toBeNull();
    expect(shadow.querySelector('.streamarchive-inline-notice')).toBeNull();
    handle?.unmount();
  });

  it('State 3: Thoughts only, no text -> displays explicit partial recovery notice and thinking block', () => {
    const { msgEl } = createMessageDom('m-state-3');
    const target = findInlineInsertionPoint(locateMessageAnchor('m-state-3', root)!);

    const content: OverlayContentResult = {
      text: '', // No text received
      thinking: 'Only reasoning was streamed before filter cut the connection.',
    };

    const handle = mountInlineRecovery(target!, baseSummary, content, {
      showThinkingInline: true,
      locale: 'ru',
    });

    expect(handle).not.toBeNull();
    const shadow = handle!.shadowRoot;
    const notice = shadow.querySelector('.streamarchive-inline-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Сохранены только рассуждения. Текст ответа не был получен или не найден.');
    expect(shadow.querySelector('details.streamarchive-inline-thinking')).not.toBeNull();
    expect(shadow.querySelector('.streamarchive-inline-body')).toBeNull();
    handle?.unmount();
  });

  it('State 4: Neither text nor thoughts -> does not create fake recovery', () => {
    const { msgEl } = createMessageDom('m-state-4');
    const target = findInlineInsertionPoint(locateMessageAnchor('m-state-4', root)!);

    const content: OverlayContentResult = {
      text: '   ',
      thinking: '',
    };

    const handle = mountInlineRecovery(target!, baseSummary, content, {
      showThinkingInline: true,
    });

    expect(handle).toBeNull();
  });

  it('Mode B (Replace): Reversible toggle button switches placeholder between none and original', () => {
    const { msgEl, placeholderEl } = createMessageDom('m-mode-b');
    const target = findInlineInsertionPoint(locateMessageAnchor('m-mode-b', root)!);

    const content: OverlayContentResult = {
      text: 'Replaced text in mode B.',
    };

    const handle = mountInlineRecovery(target!, baseSummary, content, {
      showThinkingInline: true,
      inlinePlacement: 'replace',
      locale: 'ru',
    });

    expect(handle).not.toBeNull();
    expect(placeholderEl.style.display).toBe('none');

    const shadow = handle!.shadowRoot;
    const toggleBtn = shadow.querySelector('.streamarchive-inline-toggle-orig-btn') as HTMLButtonElement;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn.textContent).toBe('Показать исходное сообщение DeepSeek');

    // Click to show original
    toggleBtn.click();
    expect(placeholderEl.style.display).toBe('');
    expect(toggleBtn.textContent).toBe('Скрыть исходное сообщение DeepSeek');

    // Click again to hide original
    toggleBtn.click();
    expect(placeholderEl.style.display).toBe('none');
    expect(toggleBtn.textContent).toBe('Показать исходное сообщение DeepSeek');

    handle?.unmount();
    // Upon unmount, placeholder style is cleanly restored
    expect(placeholderEl.style.display).toBe('');
  });
});
