import { normalizePathname } from '../compatibility/candidate-policy';

export const DEEPSEEK_HISTORY_ENDPOINT = '/api/v0/chat/history_messages';

/**
 * Checks whether a given URL is the DeepSeek passive history endpoint.
 *
 * Requirements:
 * 1. Host lockdown: must be https://chat.deepseek.com or relative URL without foreign authority.
 * 2. Normalized pathname must strictly equal /api/v0/chat/history_messages.
 * 3. Query string must contain a non-empty `chat_session_id`.
 * 4. Query keys are allowlisted to prevent rogue or poisoned query injection.
 */
export function isDeepSeekHistoryEndpoint(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  const clean = rawUrl.trim();
  if (!clean || clean.length > 1024) return false;

  // 1. Strict Host Validation
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(clean)) {
    try {
      const parsed = new URL(clean);
      if (parsed.protocol !== 'https:') return false;
      if (parsed.hostname.toLowerCase() !== 'chat.deepseek.com') return false;
      if (parsed.port !== '' && parsed.port !== '443') return false;
    } catch {
      return false;
    }
  } else if (clean.startsWith('//')) {
    try {
      const parsed = new URL('https:' + clean);
      if (parsed.hostname.toLowerCase() !== 'chat.deepseek.com') return false;
      if (parsed.port !== '' && parsed.port !== '443') return false;
    } catch {
      return false;
    }
  }

  // 2. Normalized Pathname check
  const pathname = normalizePathname(clean);
  if (pathname !== DEEPSEEK_HISTORY_ENDPOINT) {
    return false;
  }

  // 3. Query string inspection
  try {
    let search = '';
    if (clean.includes('?')) {
      search = clean.split('?')[1]?.split('#')[0] || '';
    }
    if (!search) return false;

    const params = new URLSearchParams(search);
    const sessionId = params.get('chat_session_id');
    if (!sessionId || sessionId.trim().length === 0 || sessionId.length > 128) {
      return false;
    }

    // Allowlisted parameters: chat_session_id and optional benign cache busters
    const allowedKeys = new Set(['chat_session_id', '_', 't', 'timestamp']);
    for (const key of params.keys()) {
      if (!allowedKeys.has(key)) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Extracts the `chat_session_id` query parameter value from a DeepSeek history URL.
 * Returns null if missing or invalid.
 */
export function extractHistorySessionId(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const clean = rawUrl.trim();
    if (!clean.includes('?')) return null;
    const search = clean.split('?')[1]?.split('#')[0] || '';
    const params = new URLSearchParams(search);
    const sessionId = params.get('chat_session_id');
    if (!sessionId || sessionId.trim().length === 0 || sessionId.length > 128) {
      return null;
    }
    return sessionId.trim();
  } catch {
    return null;
  }
}
