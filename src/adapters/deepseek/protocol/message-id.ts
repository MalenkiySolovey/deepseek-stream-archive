/**
 * DeepSeek Message ID Extractor.
 *
 * Inspired by prior art in better-deepseek (MIT License - with attribution):
 * - Identifies message IDs from streamed completion chunks.
 * - Searches keys matching /^(message_id|msg_id|response_message_id)$/i.
 * - Deliberately rejects bare 'id', 'chat_session_id', and 'parent_message_id'.
 * - Recursion depth bounded to 5 to protect against deep/circular payloads.
 * - Cyclic reference immunity via WeakSet tracking.
 * - Enforces scalar values (string or number).
 * - "Later ID wins": stream updates supersede previous IDs.
 */

const MESSAGE_ID_KEY = /^(message_id|msg_id|response_message_id)$/i;
const MAX_ID_SEARCH_DEPTH = 5;
const MAX_VISITED_NODES = 100;

export function findDeepSeekMessageId(
  value: unknown,
  depth = 0,
  visited = new WeakSet<object>(),
  visitCount = { current: 0 }
): string | null {
  if (!value || typeof value !== 'object' || depth > MAX_ID_SEARCH_DEPTH) {
    return null;
  }

  // Prevent cycles and excessive exploration
  if (visited.has(value) || visitCount.current++ >= MAX_VISITED_NODES) {
    return null;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findDeepSeekMessageId(item, depth + 1, visited, visitCount);
      if (found) return found;
    }
    return null;
  }

  const obj = value as Record<string, unknown>;

  // Check direct properties first
  for (const [key, val] of Object.entries(obj)) {
    if (MESSAGE_ID_KEY.test(key) && (typeof val === 'string' || typeof val === 'number')) {
      const candidate = String(val).trim();
      if (candidate.length > 0) {
        return candidate;
      }
    }
  }

  // Recurse into nested object values
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findDeepSeekMessageId(val, depth + 1, visited, visitCount);
      if (found) return found;
    }
  }

  return null;
}
