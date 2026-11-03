import type { ContextContinuityBlock } from './types';

export interface FormatterInput {
  eligibleBlocks: ContextContinuityBlock[];
  truncated?: boolean;
  omittedBlockCount?: number;
}

export interface FormatterOptions {
  includeThinking?: boolean;
}

/**
 * Pure deterministic formatter that converts a Context Continuity plan into
 * a structured, human-readable markdown block with clear boundaries and disclosures.
 */
export function formatContinuityContext(
  input: FormatterInput,
  options?: FormatterOptions
): string {
  const { eligibleBlocks, truncated, omittedBlockCount = 0 } = input;
  const includeThinking = options?.includeThinking ?? false;

  if (!eligibleBlocks || eligibleBlocks.length === 0) {
    return '[No eligible recovered context for the active branch]';
  }

  const lines: string[] = [];
  lines.push('[StreamArchive recovered conversation context]');
  lines.push('');

  if (truncated && omittedBlockCount > 0) {
    lines.push(
      `[Note: ${omittedBlockCount} older recovered response(s) omitted to respect Context Continuity limit]`
    );
    lines.push('');
  }

  for (let i = 0; i < eligibleBlocks.length; i++) {
    const block = eligibleBlocks[i]!;
    const blockIndex = i + 1;

    lines.push(`Recovered assistant response ${blockIndex}`);
    lines.push(`Recovery cause: ${block.recoveryCause}`);
    lines.push('');

    if (includeThinking && block.thinkingText && block.thinkingText.trim().length > 0) {
      lines.push('Recovered DeepThink:');
      lines.push(block.thinkingText.trim());
      lines.push('');
      lines.push('Recovered answer:');
    }

    lines.push(block.assistantText.trim());

    if (i < eligibleBlocks.length - 1) {
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  lines.push('');
  lines.push('[End StreamArchive recovered conversation context]');

  return lines.join('\n');
}
