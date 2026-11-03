import { describe, it, expect } from 'vitest';
import {
  formatContinuityPrompt,
  parseStreamArchiveAugmentedPrompt,
  hasContinuityMarker,
  CONTINUITY_MARKER_HEADER_PREFIX,
  CONTINUITY_MARKER_FOOTER,
} from '../src/adapters/deepseek/request/marker';

describe('Context Continuity Marker & Parser', () => {
  it('detects continuity marker accurately', () => {
    expect(hasContinuityMarker('Hello DeepSeek')).toBe(false);
    expect(hasContinuityMarker(null)).toBe(false);
    expect(hasContinuityMarker(undefined)).toBe(false);
    expect(hasContinuityMarker(12345)).toBe(false);

    const formatted = formatContinuityPrompt(
      '[StreamArchive recovered conversation context]\nRecovered answer: foo\n[End StreamArchive recovered conversation context]',
      'What was the summary?',
      'deliv-1234'
    );
    expect(hasContinuityMarker(formatted)).toBe(true);
  });

  it('formats prompt with explicit boundary markers', () => {
    const context = 'Recovered assistant response 1\nAnswer: 42';
    const userPrompt = 'Continue explaining.';
    const deliveryId = 'deliv-xyz-987';

    const formatted = formatContinuityPrompt(context, userPrompt, deliveryId);

    expect(formatted).toContain(`${CONTINUITY_MARKER_HEADER_PREFIX}${deliveryId}]`);
    expect(formatted).toContain(context);
    expect(formatted).toContain(CONTINUITY_MARKER_FOOTER);
    expect(formatted.endsWith('Continue explaining.')).toBe(true);
  });

  it('parses formatted prompt and extracts original user prompt and deliveryId', () => {
    const context = 'Recovered assistant response 1\nAnswer: DeepSeek recovery';
    const userPrompt = 'Can you rewrite that in TypeScript?\n\nInclude types.';
    const deliveryId = 'uuid-delivery-001';

    const formatted = formatContinuityPrompt(context, userPrompt, deliveryId);
    const parsed = parseStreamArchiveAugmentedPrompt(formatted);

    expect(parsed.isAugmented).toBe(true);
    expect(parsed.deliveryId).toBe(deliveryId);
    expect(parsed.continuityContext).toBe(context);
    expect(parsed.userPrompt).toBe(userPrompt);
  });

  it('handles CRLF line endings gracefully in marker parser', () => {
    const rawWithCrlf =
      `[StreamArchive Context Continuity v1 — deliv-crlf]\r\n` +
      `Recovered assistant response 1\r\n` +
      `[End StreamArchive Context Continuity]\r\n\r\n` +
      `What is the next step?\r\nSecond line.`;

    const parsed = parseStreamArchiveAugmentedPrompt(rawWithCrlf);

    expect(parsed.isAugmented).toBe(true);
    expect(parsed.deliveryId).toBe('deliv-crlf');
    expect(parsed.continuityContext).toContain('Recovered assistant response 1');
    expect(parsed.userPrompt).toContain('What is the next step?');
    expect(parsed.userPrompt).toContain('Second line.');
  });

  it('returns isAugmented false when no marker is present', () => {
    const plain = 'Normal user question with no recovery';
    const parsed = parseStreamArchiveAugmentedPrompt(plain);

    expect(parsed.isAugmented).toBe(false);
    expect(parsed.deliveryId).toBeUndefined();
    expect(parsed.userPrompt).toBe(plain);
  });

  it('handles empty or non-string inputs gracefully', () => {
    const parsedEmpty = parseStreamArchiveAugmentedPrompt('');
    expect(parsedEmpty.isAugmented).toBe(false);
    expect(parsedEmpty.userPrompt).toBe('');

    const parsedNonString = parseStreamArchiveAugmentedPrompt(null as any);
    expect(parsedNonString.isAugmented).toBe(false);
    expect(parsedNonString.userPrompt).toBe('');
  });
});
