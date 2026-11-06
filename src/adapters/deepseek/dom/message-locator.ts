import type { LocatedMessageAnchor, InlineInsertionTarget } from './types';
import { normalizeRemoteId } from '../history/types';

const CANDIDATE_CONTENT_SELECTORS = [
  '[data-message-content]',
  '.ds-markdown',
  '.ds-assistant-message-main-content',
  '.markdown-body',
  'div[class*="content"]',
  'div[class*="message-content"]',
  'div[class*="ds-message-content"]',
];

const CANDIDATE_TOOLBAR_SELECTORS = [
  '[data-testid="message-actions"]',
  '[data-message-actions]',
  'div[class*="toolbar"]',
  'div[class*="actions"]',
  'div[class*="operation"]',
];

const CANDIDATE_MESSAGE_ID_ATTRS = [
  'data-virtual-list-item-key',
  'data-message-id',
];

const CANDIDATE_MESSAGE_QUERY = CANDIDATE_MESSAGE_ID_ATTRS.map((a) => `[${a}]`).join(', ');

/**
 * Safely locates a message node in the DeepSeek DOM by its authoritative remote ID.
 * Uses direct attribute comparison on verified identity attributes (`data-virtual-list-item-key`,
 * `data-message-id`, etc.) to prevent CSS selector injection attacks and reject generic ambiguous IDs.
 * Returns viewport coordinates for floating anchored badge attachment or inline host insertion.
 * Guarantees zero DOM mutation and zero React state access.
 */
export function locateMessageAnchor(
  remoteId: string,
  root: Document | Element = typeof document !== 'undefined' ? document : (null as any)
): LocatedMessageAnchor | null {
  if (!root || typeof (root as any).querySelectorAll !== 'function' || !remoteId) {
    return null;
  }

  const normalized = normalizeRemoteId(remoteId);
  if (!normalized) return null;

  try {
    // Only verified message identity attributes are considered strong identity authority.
    // We scan candidate message key elements and check normalized equality directly rather than
    // interpolating unescaped user-controlled IDs into querySelector strings.
    const elements = root.querySelectorAll(CANDIDATE_MESSAGE_QUERY);
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as HTMLElement;
      for (const attr of CANDIDATE_MESSAGE_ID_ATTRS) {
        const rawAttr = el.getAttribute(attr);
        if (rawAttr && normalizeRemoteId(rawAttr) === normalized) {
          if (typeof el.getBoundingClientRect === 'function') {
            const rect = el.getBoundingClientRect();
            // Ensure element is connected to the DOM or has a layout bounding box
            if (el.isConnected || rect.width > 0 || rect.height > 0) {
              return {
                remoteId: normalized,
                element: el,
                rect,
                authority: 'verified_message_id_attribute',
              };
            }
          }
        }
      }
    }
  } catch {
    // Fail-open
  }

  return null;
}

/**
 * Identifies the safe structural insertion point for inline recovery inside a verified message anchor.
 *
 * Requirements:
 * - Message-scoped and identity-verified (anchor is required).
 * - Identifies native toolbar (e.g. Copy, Regenerate, Like, Dislike, Share) so it is left untouched.
 * - Identifies content placeholder element, allowing minimal reversible hiding.
 * - Falls back to Level 2 (adjacent insertion inside message node) or null (fallback to overlay).
 */
export function findInlineInsertionPoint(
  anchorOrElement: LocatedMessageAnchor | HTMLElement
): InlineInsertionTarget | null {
  const el = (anchorOrElement as LocatedMessageAnchor)?.element || (anchorOrElement as HTMLElement);
  if (!el || typeof el.querySelector !== 'function' || typeof el.appendChild !== 'function') {
    return null;
  }

  // 1. Scan for native toolbar
  let toolbarElement: HTMLElement | null = null;
  for (const sel of CANDIDATE_TOOLBAR_SELECTORS) {
    try {
      const tb = el.querySelector(sel) as HTMLElement | null;
      if (tb && el.contains(tb) && tb !== el) {
        toolbarElement = tb;
        break;
      }
    } catch {
      // Fail-open
    }
  }

  // Fallback toolbar heuristic: look for a child container holding multiple action buttons or icon buttons
  if (!toolbarElement) {
    try {
      const buttons = el.querySelectorAll('button, [role="button"], .ds-icon-button');
      if (buttons.length >= 2) {
        const firstBtn = buttons[0];
        if (firstBtn && firstBtn.parentElement && firstBtn.parentElement !== el && el.contains(firstBtn.parentElement)) {
          toolbarElement = firstBtn.parentElement as HTMLElement;
        }
      }
    } catch {
      // Fail-open
    }
  }

  // 2. Scan for content / placeholder element
  let placeholderElement: HTMLElement | null = null;
  for (const sel of CANDIDATE_CONTENT_SELECTORS) {
    try {
      const contentEl = el.querySelector(sel) as HTMLElement | null;
      if (
        contentEl &&
        el.contains(contentEl) &&
        contentEl !== el &&
        contentEl !== toolbarElement &&
        (!toolbarElement || !toolbarElement.contains(contentEl))
      ) {
        placeholderElement = contentEl;
        break;
      }
    } catch {
      // Fail-open
    }
  }

  // Heuristic content detection: if no selector matched, check child elements containing text
  if (!placeholderElement && el.children.length > 0) {
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i] as HTMLElement;
      if (child !== toolbarElement && (!toolbarElement || !toolbarElement.contains(child))) {
        if (child.textContent && child.textContent.trim().length > 0) {
          placeholderElement = child;
          break;
        }
      }
    }
  }

  // Level 1: True inline body insertion
  if (placeholderElement) {
    return {
      anchorElement: el,
      placeholderElement,
      containerElement: placeholderElement.parentElement || el,
      insertRefNode: placeholderElement.nextSibling,
      toolbarElement,
      level: 'level_1_body',
    };
  }

  // Level 2: Adjacent insertion inside verified message node before toolbar
  if (toolbarElement) {
    return {
      anchorElement: el,
      placeholderElement: null,
      containerElement: toolbarElement.parentElement || el,
      insertRefNode: toolbarElement,
      toolbarElement,
      level: 'level_2_adjacent',
    };
  }

  // If neither content placeholder nor native toolbar is identifiable,
  // do not guess into unknown host DOM structure. Fail safe to null (Level 3 overlay badge / Level 4 tray).
  return null;
}
