/**
 * Context Continuity Delivery Marker Formatter & Parser.
 *
 * Formats prompt augmentation with explicit boundary disclosures
 * and robustly extracts user-authored prompts for history reconciliation.
 */

export const CONTINUITY_MARKER_HEADER_PREFIX = '[StreamArchive Context Continuity v1 — ';
export const CONTINUITY_MARKER_HEADER_SUFFIX = ']';
export const CONTINUITY_MARKER_FOOTER = '[End StreamArchive Context Continuity]';

export interface ParsedAugmentedPrompt {
  isAugmented: boolean;
  deliveryId?: string;
  continuityContext?: string;
  userPrompt: string;
}

/**
 * Checks if a prompt string already contains a StreamArchive Context Continuity marker.
 */
export function hasContinuityMarker(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  return text.includes(CONTINUITY_MARKER_HEADER_PREFIX);
}

/**
 * Formats an outgoing prompt with boundary markers enclosing the recovered context.
 */
export function formatContinuityPrompt(
  formattedContext: string,
  userPrompt: string,
  deliveryId: string
): string {
  const cleanContext = formattedContext.trim();
  return `${CONTINUITY_MARKER_HEADER_PREFIX}${deliveryId}${CONTINUITY_MARKER_HEADER_SUFFIX}\n${cleanContext}\n${CONTINUITY_MARKER_FOOTER}\n\n${userPrompt}`;
}

/**
 * Parses an augmented prompt string, extracting the deliveryId, continuityContext,
 * and the original clean user prompt.
 *
 * If no valid marker is detected, returns isAugmented: false with the original prompt.
 */
export function parseStreamArchiveAugmentedPrompt(rawPrompt: string): ParsedAugmentedPrompt {
  if (typeof rawPrompt !== 'string' || !hasContinuityMarker(rawPrompt)) {
    return {
      isAugmented: false,
      userPrompt: rawPrompt ?? '',
    };
  }

  // Regex to match the marker block and capture deliveryId, context, and the remaining user prompt
  // Normalizes \r\n to \n for matching
  const markerRegex = /^\[StreamArchive Context Continuity v1 — ([^\]]+)\]\r?\n([\s\S]*?)\r?\n\[End StreamArchive Context Continuity\](?:\r?\n\r?\n|\r?\n)?([\s\S]*)$/;

  const match = rawPrompt.match(markerRegex);
  if (match) {
    const deliveryId = match[1]?.trim();
    const continuityContext = match[2]?.trim();
    const userPrompt = match[3] ?? '';

    return {
      isAugmented: true,
      deliveryId,
      continuityContext,
      userPrompt,
    };
  }

  // Fallback: If marker is embedded inside or whitespace preceded, try search
  const startIndex = rawPrompt.indexOf(CONTINUITY_MARKER_HEADER_PREFIX);
  const footerIndex = rawPrompt.indexOf(CONTINUITY_MARKER_FOOTER, startIndex);

  if (startIndex !== -1 && footerIndex !== -1) {
    const headerEndIndex = rawPrompt.indexOf(CONTINUITY_MARKER_HEADER_SUFFIX, startIndex);
    if (headerEndIndex !== -1 && headerEndIndex < footerIndex) {
      const deliveryId = rawPrompt
        .slice(startIndex + CONTINUITY_MARKER_HEADER_PREFIX.length, headerEndIndex)
        .trim();
      const continuityContext = rawPrompt
        .slice(headerEndIndex + 1, footerIndex)
        .trim();
      const afterFooter = rawPrompt.slice(footerIndex + CONTINUITY_MARKER_FOOTER.length);
      const userPrompt = afterFooter.replace(/^\r?\n\r?\n?/, '');

      return {
        isAugmented: true,
        deliveryId,
        continuityContext,
        userPrompt,
      };
    }
  }

  return {
    isAugmented: false,
    userPrompt: rawPrompt,
  };
}
