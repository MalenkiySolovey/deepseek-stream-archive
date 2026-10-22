/**
 * DeepSeek Session ID Route Parser.
 *
 * Extracts conversation session identifiers from DeepSeek web routes.
 * Supports both modern format (/a/chat/s/<id>) and legacy format (/chat/s/<id>).
 */

const SESSION_ROUTE_REGEX = /(?:\/a)?\/chat\/s\/([^/?#]+)/i;

/**
 * Extracts a session UUID / ID string from a URL or pathname.
 * Returns null if the URL does not represent an active chat session route.
 */
export function extractSessionIdFromUrl(urlOrPath: string): string | null {
  if (!urlOrPath || typeof urlOrPath !== 'string') {
    return null;
  }

  const match = urlOrPath.match(SESSION_ROUTE_REGEX);
  if (match && match[1]) {
    const trimmed = match[1].trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
}

/**
 * Gets the current active session ID from the browser window's location,
 * or null if outside browser or not in a session route.
 */
export function getCurrentSessionIdFromWindow(): string | null {
  if (typeof window === 'undefined' || !window.location) {
    return null;
  }
  return extractSessionIdFromUrl(window.location.href);
}
