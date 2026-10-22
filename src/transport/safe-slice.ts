/**
 * Safely splits a UTF-16 string into chunks without splitting surrogate pairs.
 * If a split boundary falls between a high surrogate (\uD800-\uDBFF) and a
 * low surrogate (\uDC00-\uDFFF), the split boundary is adjusted so the surrogate
 * pair stays intact in the same chunk.
 */
export function splitSafeUtf16(text: string, maxChunkLength: number): string[] {
  if (text.length <= maxChunkLength) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + maxChunkLength;
    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }

    // Check if end - 1 is a high surrogate (leading surrogate)
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      // Advance end by 1 to include the trailing low surrogate
      end += 1;
    }

    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks;
}
