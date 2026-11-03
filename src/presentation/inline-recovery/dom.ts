import type { InlineInsertionTarget } from '../../adapters/deepseek/dom/types';
import type { PageRecoveryMessageSummary } from '../../adapters/deepseek/dom/types';
import type { OverlayContentResult } from '../../overlay/portal';
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

  const locale = options?.locale || 'en';
  const remoteId = message.remoteId || message.messageId;

  // 1. Reversible host style modification on placeholder
  let originalPlaceholderDisplay = '';
  const placeholder = target.placeholderElement;
  if (placeholder) {
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
    if (placeholder) {
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

  const badge = document.createElement('span');
  badge.className = `streamarchive-inline-badge ${labelInfo.className}`;
  badge.textContent = `${labelInfo.icon} ${labelInfo.badgeLabel}`;
  header.appendChild(badge);

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
  if (showThinking && content.thinking && content.thinking.trim().length > 0) {
    const details = document.createElement('details');
    details.className = 'streamarchive-inline-thinking';

    const summary = document.createElement('summary');
    summary.className = 'streamarchive-inline-thinking-summary';
    const thinkCount = content.thinking.length;
    const summaryText =
      locale === 'ru'
        ? `▶ 🧠 DeepThink — восстановлено локально (${thinkCount} симв.)`
        : `▶ 🧠 DeepThink — recovered locally (${thinkCount} chars)`;
    summary.textContent = summaryText;
    details.appendChild(summary);

    const thinkingBody = document.createElement('div');
    thinkingBody.className = 'streamarchive-inline-thinking-body';
    const thinkBlocks = parseSafeMarkdown(content.thinking);
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

  // Footer with Extension-Owned Copy Button
  const footer = document.createElement('div');
  footer.className = 'streamarchive-inline-footer';

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'streamarchive-inline-copy-btn';
  const copyLabel = locale === 'ru' ? 'Скопировать восстановленный ответ' : 'Copy recovered response';
  const copiedLabel = locale === 'ru' ? 'Скопировано!' : 'Copied!';
  copyBtn.textContent = copyLabel;

  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      if (options?.onCopyAnswer) {
        await options.onCopyAnswer(content.text);
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(content.text);
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
    } catch {
      // ignore
    }
    OWNED_INLINE_HOSTS.delete(host);

    // Revert placeholder style cleanly
    if (placeholder) {
      placeholder.style.display = originalPlaceholderDisplay;
    }
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
