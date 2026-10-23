import type { LocatedMessageAnchor } from './types';
import { normalizeRemoteId } from '../history/types';

/**
 * Safely locates a message node in the DeepSeek DOM by its authoritative remote ID.
 * Uses direct attribute comparison on verified `data-message-id` attributes to prevent
 * CSS selector injection attacks and reject generic ambiguous IDs.
 * Returns viewport coordinates for floating anchored badge attachment.
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
    // Only verified data-message-id attribute is considered strong identity authority.
    // We scan data-message-id elements and check normalized equality directly rather than
    // interpolating unescaped user-controlled IDs into querySelector strings.
    const elements = root.querySelectorAll('[data-message-id]');
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i] as HTMLElement;
      const rawAttr = el.getAttribute('data-message-id');
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
  } catch {
    // Fail-open
  }

  return null;
}
