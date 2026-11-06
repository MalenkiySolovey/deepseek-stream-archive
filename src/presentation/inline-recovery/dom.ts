import type { InlineInsertionTarget } from '../../adapters/deepseek/dom/types';
import type { PageRecoveryMessageSummary } from '../../adapters/deepseek/dom/types';
import type { OverlayContentResult } from '../../overlay/portal';
import { parseStreamArchiveAugmentedPrompt } from '../../adapters/deepseek/request/marker';
import { parseSafeMarkdown, renderSafeMarkdownToFragment } from '../safe-markdown';
import { INLINE_RECOVERY_STYLES } from './styles';
import type { InlineHostHandle, InlineRecoveryPresentationOptions } from './types';

export const OWNED_INLINE_HOSTS = new WeakSet<HTMLElement>();

function getInlineRecoveryLabel(
  msg: PageRecoveryMessageSummary,
  locale: 'en' | 'ru' = 'en'
): {
  icon: string;
  badgeLabel: string;
  className: string;
} {
  const isPreFilter =
    msg.presentationKind === 'pre_filter_recovery' ||
    (msg.recoveryKind === 'authoritative_recovery' && !msg.presentationKind) ||
    msg.status === 'filtered';

  if (isPreFilter) {
    return {
      icon: '🛡️',
      badgeLabel:
        locale === 'ru'
          ? 'Восстановлено локально до фильтра DeepSeek'
          : 'Recovered locally before DeepSeek filter',
      className: 'filtered',
    };
  }

  const isInterruption = msg.presentationKind === 'interruption_recovery' || msg.status === 'interrupted';
  if (isInterruption) {
    return {
      icon: '⚡',
      badgeLabel:
        locale === 'ru'
          ? 'Сохранено локально до обрыва сети'
          : 'Captured locally before interruption',
      className: 'interrupted',
    };
  }

  return {
    icon: '⚠️',
    badgeLabel:
      locale === 'ru'
        ? 'Частичный локальный захват'
        : 'Partial local capture',
    className: 'degraded',
  };
}

/**
 * Mounts an extension-owned closed Shadow DOM inline recovery host into the verified insertion target.
 *
 * Requirements:
 * - Zero innerHTML / insertAdjacentHTML
 * - Minimal, 100% reversible style changes on verified placeholder element
 * - DeepSeek native toolbar remains in host DOM and untouched
 * - Zero sensitive text exposed in host attributes
 */
export function mountInlineRecovery(
  target: InlineInsertionTarget,
  message: PageRecoveryMessageSummary,
  content: OverlayContentResult,
  options?: InlineRecoveryPresentationOptions
): InlineHostHandle | null {
  if (!target || !target.containerElement) {
    return null;
  }

  // Section 15: Content existence check (State 4 rejection)
  const hasText = Boolean(content.text && content.text.trim().length > 0);
  const hasThinking = Boolean(content.thinking && content.thinking.trim().length > 0);
  if (!hasText && !hasThinking) {
    return null;
  }

  const locale = options?.locale || 'en';
  const remoteId = message.remoteId || message.messageId;
  const isReplaceMode = options?.inlinePlacement === 'replace';

  // 1. Reversible host style modification on placeholder (Mode B: Replace)
  let originalPlaceholderDisplay = '';
  const placeholder = target.placeholderElement;
  if (placeholder && isReplaceMode) {
    originalPlaceholderDisplay = placeholder.style.display || '';
    placeholder.style.display = 'none';
  }

  // 2. Create extension-owned host element
  const host = document.createElement('div');
  host.setAttribute('data-streamarchive-inline-recovery-host', message.messageId);
  OWNED_INLINE_HOSTS.add(host);

  // 3. Attach closed Shadow DOM for full CSS/DOM isolation
  let shadow: ShadowRoot | null = null;
  try {
    shadow = host.attachShadow({ mode: 'closed' });
  } catch {
    shadow = (host as any).shadowRoot || null;
  }

  if (!shadow) {
    // Fail-closed for inline recovery: restore placeholder and return null
    if (placeholder && isReplaceMode) {
      placeholder.style.display = originalPlaceholderDisplay;
    }
    return null;
  }

  // Inject scoped stylesheet
  const styleEl = document.createElement('style');
  styleEl.textContent = INLINE_RECOVERY_STYLES;
  shadow.appendChild(styleEl);

  const labelInfo = getInlineRecoveryLabel(message, locale);

  // Root container inside Shadow DOM
  const root = document.createElement('div');
  root.className = `streamarchive-inline-host-root ${labelInfo.className}`;

  // Header row with StreamArchive trust marker
  const header = document.createElement('div');
  header.className = 'streamarchive-inline-header';

  const headerCol = document.createElement('div');
  headerCol.style.display = 'flex';
  headerCol.style.flexDirection = 'column';

  const badge = document.createElement('span');
  badge.className = `streamarchive-inline-badge ${labelInfo.className}`;
  const badgeText = isReplaceMode
    ? (locale === 'ru' ? '🛡️ Показана локально сохранённая версия' : '🛡️ Locally preserved version shown')
    : `${labelInfo.icon} ${locale === 'ru' ? 'Локально сохранённый ответ' : 'Locally preserved response'}`;
  badge.textContent = badgeText;
  headerCol.appendChild(badge);

  if (!isReplaceMode) {
    const sub = document.createElement('span');
    sub.className = 'streamarchive-inline-subtitle';
    sub.textContent = locale === 'ru'
      ? 'Сохранён до изменения или прерывания исходного ответа.'
      : 'Preserved prior to modification or interruption of original response.';
    headerCol.appendChild(sub);
  }

  header.appendChild(headerCol);

  // Optional Context Continuity status indicator (Section 46)
  if (options?.continuityStatus) {
    const continuityPill = document.createElement('span');
    continuityPill.className = 'streamarchive-inline-continuity-pill';
    continuityPill.textContent = `🔄 Context: ${options.continuityStatus}`;
    header.appendChild(continuityPill);
  }

  root.appendChild(header);

  // DeepThink reasoning block (collapsed by default if enabled & present)
  const showThinking = options?.showThinkingInline !== false;
  if (showThinking && hasThinking && content.thinking) {
    const thinkingText = content.thinking;
    const details = document.createElement('details');
    details.className = 'streamarchive-inline-thinking';

    const summary = document.createElement('summary');
    summary.className = 'streamarchive-inline-thinking-summary';
    const thinkCount = thinkingText.length;
    const summaryText =
      locale === 'ru'
        ? `▶ 🧠 DeepThink — восстановлено локально (${thinkCount} симв.)`
        : `▶ 🧠 DeepThink — recovered locally (${thinkCount} chars)`;
    summary.textContent = summaryText;
    details.appendChild(summary);

    const thinkingBody = document.createElement('div');
    thinkingBody.className = 'streamarchive-inline-thinking-body';
    const thinkBlocks = parseSafeMarkdown(thinkingText);
    thinkingBody.appendChild(
      renderSafeMarkdownToFragment(thinkBlocks, {
        codeCopyLabel: locale === 'ru' ? 'Копировать' : 'Copy code',
        codeCopiedLabel: locale === 'ru' ? 'Скопировано!' : 'Copied!',
        onCopyCode: options?.onCopyCode,
      })
    );
    details.appendChild(thinkingBody);

    root.appendChild(details);
  }

  // Section 15 State 3 vs States 1 & 2:
  if (!hasText && hasThinking) {
    const notice = document.createElement('div');
    notice.className = 'streamarchive-inline-notice';
    notice.textContent =
      locale === 'ru'
        ? 'Сохранены только рассуждения. Текст ответа не был получен или не найден.'
        : 'Only reasoning preserved. Response text was not received or not found.';
    root.appendChild(notice);
  } else if (hasText) {
    // Response Body content rendered via safe markdown fragment
    const body = document.createElement('div');
    body.className = 'streamarchive-inline-body';
    const textBlocks = parseSafeMarkdown(content.text);
    body.appendChild(
      renderSafeMarkdownToFragment(textBlocks, {
        codeCopyLabel: locale === 'ru' ? 'Копировать' : 'Copy code',
        codeCopiedLabel: locale === 'ru' ? 'Скопировано!' : 'Copied!',
        onCopyCode: options?.onCopyCode,
      })
    );
    root.appendChild(body);
  }

  // Footer with Extension-Owned Action Buttons
  const footer = document.createElement('div');
  footer.className = 'streamarchive-inline-footer';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'streamarchive-inline-copy-btn';
  const copyLabel = locale === 'ru' ? 'Скопировать сохранённый ответ' : 'Copy recovered response';
  const copiedLabel = locale === 'ru' ? 'Скопировано!' : 'Copied!';
  copyBtn.textContent = copyLabel;

  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      const textToCopy = hasText ? content.text : (content.thinking || '');
      if (options?.onCopyAnswer) {
        await options.onCopyAnswer(textToCopy);
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(textToCopy);
      }
      copyBtn.textContent = copiedLabel;
      setTimeout(() => {
        copyBtn.textContent = copyLabel;
      }, 2000);
    } catch {
      copyBtn.textContent = 'Error';
    }
  });
  footer.appendChild(copyBtn);

  // Section 12 Mode B: Reversible Toggle Button to view/hide original DeepSeek stub
  if (isReplaceMode && placeholder) {
    const toggleOrigBtn = document.createElement('button');
    toggleOrigBtn.type = 'button';
    toggleOrigBtn.className = 'streamarchive-inline-toggle-orig-btn';
    let isOrigShown = false;
    const showOrigLabel = locale === 'ru' ? 'Показать исходное сообщение DeepSeek' : 'Show original DeepSeek message';
    const hideOrigLabel = locale === 'ru' ? 'Скрыть исходное сообщение DeepSeek' : 'Hide original DeepSeek message';
    toggleOrigBtn.textContent = showOrigLabel;

    toggleOrigBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      isOrigShown = !isOrigShown;
      placeholder.style.display = isOrigShown ? originalPlaceholderDisplay || '' : 'none';
      toggleOrigBtn.textContent = isOrigShown ? hideOrigLabel : showOrigLabel;
    });
    footer.appendChild(toggleOrigBtn);
  }

  root.appendChild(footer);

  shadow.appendChild(root);

  // Insert host into target container at the safe reference position
  try {
    target.containerElement.insertBefore(host, target.insertRefNode);
  } catch {
    // If insertBefore fails (e.g. insertRefNode detached), fall back to appendChild
    target.containerElement.appendChild(host);
  }

  const unmount = () => {
    try {
      if (host.parentNode) {
        host.parentNode.removeChild(host);
      }
      if (placeholder && isReplaceMode) {
        placeholder.style.display = originalPlaceholderDisplay;
      }
    } catch {
      // ignore
    }
    OWNED_INLINE_HOSTS.delete(host);
  };

  return {
    messageId: message.messageId,
    remoteId,
    hostElement: host,
    shadowRoot: shadow,
    containerElement: target.containerElement,
    unmount,
  };
}

/**
 * Mounts a clean non-destructive presentation for user turns that contain Context Continuity markers.
 *
 * Presentation requirements:
 * - Renders original clean user prompt
 * - Displays Context Continuity trust badge
 * - Collapsible included context toggle
 * - Reversible placeholder element hiding
 * - Closed Shadow DOM isolation
 * - DeepSeek native toolbar intact in host DOM
 * - Zero innerHTML / outerHTML / insertAdjacentHTML / React internal access
 */
export function mountCleanUserTurn(
  target: InlineInsertionTarget,
  rawText: string,
  options?: { locale?: 'en' | 'ru' }
): InlineHostHandle | null {
  if (!target || !target.containerElement || !rawText) return null;

  const parsed = parseStreamArchiveAugmentedPrompt(rawText);
  if (!parsed.isAugmented) return null;

  const locale = options?.locale || 'en';
  let originalPlaceholderDisplay = '';
  const placeholder = target.placeholderElement;
  if (placeholder) {
    originalPlaceholderDisplay = placeholder.style.display || '';
    placeholder.style.display = 'none';
  }

  const host = document.createElement('div');
  const deliveryId = parsed.deliveryId || 'continuity';
  host.setAttribute('data-streamarchive-user-turn-host', deliveryId);
  OWNED_INLINE_HOSTS.add(host);

  let shadow: ShadowRoot | null = null;
  try {
    shadow = host.attachShadow({ mode: 'closed' });
  } catch {
    shadow = (host as any).shadowRoot || null;
  }

  if (!shadow) {
    if (placeholder) placeholder.style.display = originalPlaceholderDisplay;
    return null;
  }

  const styleEl = document.createElement('style');
  styleEl.textContent = INLINE_RECOVERY_STYLES;
  shadow.appendChild(styleEl);

  const root = document.createElement('div');
  root.className = 'streamarchive-user-continuity-root';

  // 1. Original user-authored prompt
  const promptEl = document.createElement('div');
  promptEl.className = 'streamarchive-user-prompt-text';
  promptEl.textContent = parsed.userPrompt;
  root.appendChild(promptEl);

  // 2. Trust indicator badge (Section 45: 🔄 Context Continuity supplied / 1 recovered response)
  const badge = document.createElement('div');
  badge.className = 'streamarchive-user-continuity-badge';
  badge.textContent =
    locale === 'ru'
      ? '🔄 Непрерывность контекста применена (1 восстановленный ответ)'
      : '🔄 Context Continuity supplied (1 recovered response)';
  root.appendChild(badge);

  // 3. Collapsible included context toggle (Section 45: [View included context])
  if (parsed.continuityContext && parsed.continuityContext.trim().length > 0) {
    const details = document.createElement('details');
    details.className = 'streamarchive-user-included-context';

    const summary = document.createElement('summary');
    summary.className = 'streamarchive-user-included-summary';
    summary.textContent =
      locale === 'ru' ? '▶ Показать включённый контекст' : '▶ View included context';
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'streamarchive-user-included-body';
    body.textContent = parsed.continuityContext;
    details.appendChild(body);

    root.appendChild(details);
  }

  shadow.appendChild(root);

  try {
    target.containerElement.insertBefore(host, target.insertRefNode);
  } catch {
    target.containerElement.appendChild(host);
  }

  const unmount = () => {
    try {
      if (host.parentNode) {
        host.parentNode.removeChild(host);
      }
    } catch {
      // ignore
    }
    OWNED_INLINE_HOSTS.delete(host);
    if (placeholder) {
      placeholder.style.display = originalPlaceholderDisplay;
    }
  };

  return {
    messageId: deliveryId,
    remoteId: deliveryId,
    hostElement: host,
    shadowRoot: shadow,
    containerElement: target.containerElement,
    unmount,
  };
}
