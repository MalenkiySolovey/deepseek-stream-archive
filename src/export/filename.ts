/**
 * Safe filename sanitization for human conversation exports.
 * Handles Windows reserved device names, illegal path characters,
 * control characters, trailing spaces/dots, and length boundaries.
 */

const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

const ILLEGAL_CHARS_REGEX = /[\\/:*?"<>|\x00-\x1f\x7f]/g;
const MAX_TITLE_LENGTH = 60;

/**
 * Format a Date or timestamp as YYYY-MM-DD in UTC.
 */
export function formatDateUtc(dateOrTimestamp: Date | number = Date.now()): string {
  const d = typeof dateOrTimestamp === 'number' ? new Date(dateOrTimestamp) : dateOrTimestamp;
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Truncate a string to a maximum character length without splitting Unicode surrogate pairs.
 */
function safeTruncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  const chars = Array.from(str);
  if (chars.length <= maxLength) return str;
  return chars.slice(0, maxLength).join('').trimEnd();
}

/**
 * Generate a safe, deterministic filename for human conversation exports.
 *
 * @param title Conversation title or prompt snippet
 * @param dateStr ISO date string (YYYY-MM-DD)
 * @param extension Target file extension without leading dot (e.g. 'md' or 'json')
 * @param fallbackId Optional short conversation ID used if title is empty or invalid
 */
export function sanitizeExportFilename(
  title: string | undefined | null,
  dateStr: string,
  extension: string,
  fallbackId?: string
): string {
  const cleanExt = extension.replace(/^\./, '').trim().toLowerCase();
  const rawTitle = (title ?? '').trim();

  // 1. Normalize whitespace (tabs, newlines) into spaces first
  let sanitized = rawTitle.replace(/\s+/g, ' ');

  // 2. Strip quotes, question marks, angle brackets, and non-whitespace control chars
  sanitized = sanitized
    .replace(/["?<>]/g, '')
    .replace(/[\x00-\x1f\x7f]/g, '');

  // 3. Replace path separators and illegal filesystem chars with a hyphen
  sanitized = sanitized.replace(/[\\/:*|]/g, '-');

  // 4. Clean up spaces around hyphens and collapse consecutive hyphens/spaces
  sanitized = sanitized
    .replace(/\s*-\s*/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/-+/g, '-')
    .trim();

  // 5. Strip leading and trailing dots, hyphens, and spaces
  sanitized = sanitized.replace(/^[\s.-]+|[\s.-]+$/g, '');

  // 6. Bound length safely
  sanitized = safeTruncate(sanitized, MAX_TITLE_LENGTH);
  sanitized = sanitized.replace(/^[\s.-]+|[\s.-]+$/g, '');

  // 7. Check if resulting base name is a Windows reserved device name
  const upper = sanitized.toUpperCase();
  if (WINDOWS_RESERVED_NAMES.has(upper) || sanitized.length === 0) {
    if (sanitized.length > 0 && WINDOWS_RESERVED_NAMES.has(upper)) {
      sanitized = `_${sanitized.toUpperCase()}`;
    } else {
      const shortId = fallbackId ? fallbackId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12) : 'export';
      sanitized = `deepseek-conversation_${shortId || 'export'}`;
    }
  }

  return `${sanitized}_${dateStr}.${cleanExt}`;
}
