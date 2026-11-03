import { describe, it, expect } from 'vitest';
import { formatContinuityContext } from '../src/context-continuity/formatter';
import type { ContextContinuityBlock } from '../src/context-continuity/types';

describe('Context Continuity Markdown Formatter', () => {
  function createBlock(overrides?: Partial<ContextContinuityBlock>): ContextContinuityBlock {
    return {
      sourceMessageId: 'msg-1',
      sourceRevisionId: 'rev-1',
      assistantText: 'Standard recovered response.',
      recoveryCause: 'content_filter',
      branchDepth: 1,
      originalTextLength: 26,
      originalThinkingLength: 0,
      ...overrides,
    };
  }

  it('returns fallback message when eligibleBlocks is empty', () => {
    const output = formatContinuityContext({ eligibleBlocks: [] });
    expect(output).toBe('[No eligible recovered context for the active branch]');
  });

  it('renders single block with clear boundary markers and cause badge', () => {
    const block = createBlock({
      assistantText: 'Recovered analytical answer.',
      recoveryCause: 'content_filter',
    });

    const output = formatContinuityContext({ eligibleBlocks: [block] });

    expect(output).toContain('[StreamArchive recovered conversation context]');
    expect(output).toContain('Recovered assistant response 1');
    expect(output).toContain('Recovery cause: content_filter');
    expect(output).toContain('Recovered analytical answer.');
    expect(output).toContain('[End StreamArchive recovered conversation context]');
    expect(output).not.toContain('---');
  });

  it('renders multiple blocks with dividers in chronological order', () => {
    const b1 = createBlock({
      sourceMessageId: 'm1',
      assistantText: 'Block 1 text',
      recoveryCause: 'network_interruption',
    });
    const b2 = createBlock({
      sourceMessageId: 'm2',
      assistantText: 'Block 2 text',
      recoveryCause: 'user_stop',
    });

    const output = formatContinuityContext({ eligibleBlocks: [b1, b2] });

    expect(output).toContain('Recovered assistant response 1');
    expect(output).toContain('Recovery cause: network_interruption');
    expect(output).toContain('Block 1 text');
    expect(output).toContain('---');
    expect(output).toContain('Recovered assistant response 2');
    expect(output).toContain('Recovery cause: user_stop');
    expect(output).toContain('Block 2 text');
  });

  it('includes omission notice when truncated with omittedBlockCount', () => {
    const block = createBlock();
    const output = formatContinuityContext({
      eligibleBlocks: [block],
      truncated: true,
      omittedBlockCount: 2,
    });

    expect(output).toContain('[Note: 2 older recovered response(s) omitted to respect Context Continuity limit]');
  });

  it('renders DeepThink section when includeThinking is true and thinkingText exists', () => {
    const block = createBlock({
      assistantText: 'Final conclusion.',
      thinkingText: 'Step 1: Analyzed premises.\nStep 2: Evaluated evidence.',
    });

    // Without thinking
    const outNoThinking = formatContinuityContext(
      { eligibleBlocks: [block] },
      { includeThinking: false }
    );
    expect(outNoThinking).not.toContain('Recovered DeepThink:');
    expect(outNoThinking).toContain('Final conclusion.');

    // With thinking
    const outWithThinking = formatContinuityContext(
      { eligibleBlocks: [block] },
      { includeThinking: true }
    );
    expect(outWithThinking).toContain('Recovered DeepThink:');
    expect(outWithThinking).toContain('Step 1: Analyzed premises.');
    expect(outWithThinking).toContain('Recovered answer:');
    expect(outWithThinking).toContain('Final conclusion.');
  });

  it('preserves code blocks, unicode and inert HTML tags without distortion', () => {
    const block = createBlock({
      assistantText: '```typescript\nconst x: string = "<script>alert(1)</script>";\n```\nРусский текст и 中文 以及 🚀',
    });

    const output = formatContinuityContext({ eligibleBlocks: [block] });
    expect(output).toContain('```typescript\nconst x: string = "<script>alert(1)</script>";\n```');
    expect(output).toContain('Русский текст и 中文 以及 🚀');
  });
});
