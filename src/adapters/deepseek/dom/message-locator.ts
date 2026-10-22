import type { LocatedMessageAnchor } from './types';
import { normalizeRemoteId } from '../history/types';

/**
 * Safely locates a message node in the DeepSeek DOM by its remote ID.
 * Returns viewport coordinates for floating anchored badge attachment.
 * Guarantees zero DOM mutation.
 */
export function locateMessageAnchor(
  remoteId: string,
  root: Document | Element = typeof document !== 'undefined' ? document : (null as any)
): LocatedMessageAnchor | null {
  if (!root || typeof (root as any).querySelector !== 'function' || !remoteId) {
    return null;
  }

  const normalized = normalizeRemoteId(remoteId);
  if (!normalized) return null;

  // Specific data-message-id selector
  const candidates = [
    `[data-message-id="${normalized}"]`,
    `[data-id="${normalized}"]`,
    `#msg_${normalized}`,
    `#${normalized}`,
  ];

  for (const selector of candidates) {
    try {
      const el = root.querySelector(selector) as HTMLElement | null;
      if (el && typeof el.getBoundingClientRect === 'function') {
        const rect = el.getBoundingClientRect();
        // Ensure element is actually laid out
        if (rect.width > 0 || rect.height > 0 || el.isConnected) {
          return {
            remoteId: normalized,
            element: el,
            rect,
          };
        }
      }
    } catch {
      // Fail-open
    }
  }

  return null;
}
