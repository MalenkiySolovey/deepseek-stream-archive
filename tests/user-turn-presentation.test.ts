// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { locateMessageAnchor, findInlineInsertionPoint } from '../src/adapters/deepseek/dom/message-locator';
import { mountCleanUserTurn, OWNED_INLINE_HOSTS } from '../src/presentation/inline-recovery/dom';
import { InlineRecoveryLedger } from '../src/presentation/inline-recovery/ledger';
import { formatContinuityPrompt } from '../src/adapters/deepseek/request/marker';

describe('Clean User-Turn Context Continuity Presentation', () => {
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

  function createUserMessageDom(
    messageId: string,
    rawPromptText: string
  ): {
    msgEl: HTMLElement;
    placeholderEl: HTMLElement;
    toolbarEl: HTMLElement;
  } {
    const msgEl = document.createElement('div');
    msgEl.setAttribute('data-message-id', messageId);

    const placeholderEl = document.createElement('div');
    placeholderEl.className = 'ds-markdown';
    placeholderEl.textContent = rawPromptText;
    msgEl.appendChild(placeholderEl);

    const toolbarEl = document.createElement('div');
    toolbarEl.className = 'ds-message-actions';
    const copyBtn = document.createElement('button');
    copyBtn.textContent = 'Copy';
    toolbarEl.appendChild(copyBtn);
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    toolbarEl.appendChild(editBtn);
    msgEl.appendChild(toolbarEl);

    root.appendChild(msgEl);
    return { msgEl, placeholderEl, toolbarEl };
  }

  it('rejects un-augmented normal prompts and leaves placeholder untouched', () => {
    const normalPrompt = 'Hello DeepSeek, explain quantum electrodynamics.';
    const { placeholderEl } = createUserMessageDom('u-msg-1', normalPrompt);

    const anchor = locateMessageAnchor('u-msg-1', root);
    expect(anchor).not.toBeNull();
    const target = findInlineInsertionPoint(anchor!);
    expect(target).not.toBeNull();

    const handle = mountCleanUserTurn(target!, normalPrompt);
    expect(handle).toBeNull();
    expect(placeholderEl.style.display).toBe('');
  });

  it('mounts closed Shadow DOM host for augmented prompt and de-augments presentation', () => {
    const deliveryId = 'deliv-test-4567';
    const recoveredContext = 'Historical context: General relativity was published in 1915.';
    const userPrompt = 'Can you give an analogy for spacetime curvature?';
    const rawAugmented = formatContinuityPrompt(recoveredContext, userPrompt, deliveryId);

    const { msgEl, placeholderEl, toolbarEl } = createUserMessageDom('u-msg-2', rawAugmented);

    const anchor = locateMessageAnchor('u-msg-2', root);
    expect(anchor).not.toBeNull();
    const target = findInlineInsertionPoint(anchor!);
    expect(target).not.toBeNull();

    const handle = mountCleanUserTurn(target!, rawAugmented);
    expect(handle).not.toBeNull();
    ledger.registerHandle(deliveryId, handle!);

    // Placeholder hidden reversibly
    expect(placeholderEl.style.display).toBe('none');

    // Host attached
    expect(handle!.hostElement.parentNode).toBe(msgEl);
    expect(OWNED_INLINE_HOSTS.has(handle!.hostElement)).toBe(true);

    // Closed Shadow DOM contains clean presentation
    const shadow = handle!.shadowRoot;
    expect(shadow).not.toBeNull();

    const promptTextEl = shadow.querySelector('.streamarchive-user-prompt-text');
    expect(promptTextEl).not.toBeNull();
    expect(promptTextEl!.textContent).toBe(userPrompt);

    const badgeEl = shadow.querySelector('.streamarchive-user-continuity-badge');
    expect(badgeEl).not.toBeNull();
    expect(badgeEl!.textContent).toContain('🔄 Context Continuity supplied');

    const detailsEl = shadow.querySelector('.streamarchive-user-included-context');
    expect(detailsEl).not.toBeNull();
    const summaryEl = detailsEl!.querySelector('.streamarchive-user-included-summary');
    expect(summaryEl!.textContent).toContain('View included context');
    const bodyEl = detailsEl!.querySelector('.streamarchive-user-included-body');
    expect(bodyEl!.textContent).toBe(recoveredContext);

    // Native toolbar remains untouched in host DOM
    expect(toolbarEl.parentNode).toBe(msgEl);
    expect(toolbarEl.querySelectorAll('button').length).toBe(2);

    // Reversible unmount
    ledger.unmount(deliveryId);
    expect(handle!.hostElement.parentNode).toBeNull();
    expect(placeholderEl.style.display).toBe('');
  });

  it('supports Russian locale labels', () => {
    const raw = formatContinuityPrompt('Контекст', 'Вопрос пользователя', 'deliv-ru-1');
    const { placeholderEl } = createUserMessageDom('u-msg-ru', raw);

    const anchor = locateMessageAnchor('u-msg-ru', root);
    const target = findInlineInsertionPoint(anchor!);

    const handle = mountCleanUserTurn(target!, raw, { locale: 'ru' });
    expect(handle).not.toBeNull();

    const badge = handle!.shadowRoot.querySelector('.streamarchive-user-continuity-badge');
    expect(badge!.textContent).toContain('Непрерывность контекста применена');

    const summary = handle!.shadowRoot.querySelector('.streamarchive-user-included-summary');
    expect(summary!.textContent).toContain('Показать включённый контекст');

    handle!.unmount();
    expect(placeholderEl.style.display).toBe('');
  });
});
