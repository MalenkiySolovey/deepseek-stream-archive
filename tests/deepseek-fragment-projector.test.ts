import { describe, it, expect } from 'vitest';
import {
  isThinkingFragment,
  isFilterOrTemplateFragment,
  isAnswerFragment,
  projectFragments,
  projectDeepSeekState,
  computeTextDiff,
} from '../src/adapters/deepseek/protocol/fragment-projector';
import type { DeepSeekFragment } from '../src/adapters/deepseek/protocol/types';
import type { DeepSeekInternalState } from '../src/adapters/deepseek/protocol/patch-applier';

describe('DeepSeek Fragment Projector & Diffing', () => {
  it('correctly classifies fragment types using strict whitelisting', () => {
    const thinkFrag: DeepSeekFragment = { type: 'THINK', content: 'thinking...' };
    const thinkingLower: DeepSeekFragment = { type: 'thinking', content: 'reasoning' };
    const answerFrag: DeepSeekFragment = { type: 'RESPONSE', content: 'hello' };
    const tipFrag: DeepSeekFragment = { type: 'TIP', content: 'warning' };
    const templateFrag: DeepSeekFragment = { type: 'TEMPLATE_RESPONSE', content: 'Censored' };
    const requestFrag: DeepSeekFragment = { type: 'REQUEST', content: 'user query' };
    const toolSearchFrag: DeepSeekFragment = { type: 'TOOL_SEARCH', content: 'search query' };
    const genericTextFrag: DeepSeekFragment = { type: 'text', content: '⚠️ Censored message' };

    expect(isThinkingFragment(thinkFrag)).toBe(true);
    expect(isThinkingFragment(thinkingLower)).toBe(true);
    expect(isThinkingFragment(answerFrag)).toBe(false);

    expect(isFilterOrTemplateFragment(tipFrag)).toBe(true);
    expect(isFilterOrTemplateFragment(templateFrag)).toBe(true);
    // Strict whitelist: genericTextFrag and toolSearch are not filter templates
    expect(isFilterOrTemplateFragment(genericTextFrag)).toBe(false);
    expect(isFilterOrTemplateFragment(answerFrag)).toBe(false);

    // Whitelist for answers: only RESPONSE
    expect(isAnswerFragment(answerFrag)).toBe(true);
    expect(isAnswerFragment(thinkFrag)).toBe(false);
    expect(isAnswerFragment(templateFrag)).toBe(false);
    expect(isAnswerFragment(requestFrag)).toBe(false);
    expect(isAnswerFragment(toolSearchFrag)).toBe(false);
    expect(isAnswerFragment(genericTextFrag)).toBe(false);
  });

  it('projects mixed fragments into separated answer and thinking texts', () => {
    const fragments: DeepSeekFragment[] = [
      { type: 'THINK', content: 'Step 1: analyze.\nStep 2: compute.' },
      { type: 'RESPONSE', content: 'Here is the final answer.' },
      { type: 'TIP', content: 'System tip' },
      { type: 'TEMPLATE_RESPONSE', content: 'Refusal template' },
      { type: 'TOOL_SEARCH', content: 'ignored tool token' },
    ];

    const projected = projectFragments(fragments);
    expect(projected.thinking).toBe('Step 1: analyze.\nStep 2: compute.');
    expect(projected.answer).toBe('Here is the final answer.');
    expect(projected.source).toBe('fragments');
  });

  it('concatenates multiple block fragments with proper block separation', () => {
    const fragments: DeepSeekFragment[] = [
      { type: 'RESPONSE', content: 'Paragraph one.' },
      { type: 'RESPONSE', content: 'Paragraph two.' },
    ];

    const projected = projectFragments(fragments);
    expect(projected.answer).toBe('Paragraph one.\n\nParagraph two.');
  });

  it('projects dual shape states correctly (Variant A vs Variant B)', () => {
    // 1. Variant A: fragments[] takes precedence
    const stateA: DeepSeekInternalState = {
      fragments: [
        { type: 'THINK', content: 'Thought A' },
        { type: 'RESPONSE', content: 'Answer A' },
      ],
      content: 'Alternative B',
      thinking_content: 'Thought B',
      response: {},
    };
    const projA = projectDeepSeekState(stateA);
    expect(projA.answer).toBe('Answer A');
    expect(projA.thinking).toBe('Thought A');
    expect(projA.source).toBe('fragments');

    // 2. Variant B: top-level content / thinking_content when fragments are empty
    const stateB: DeepSeekInternalState = {
      fragments: [],
      content: 'Top-level answer text',
      thinking_content: 'Top-level reasoning text',
      response: {
        content: 'Top-level answer text',
        thinking_content: 'Top-level reasoning text',
      },
    };
    const projB = projectDeepSeekState(stateB);
    expect(projB.answer).toBe('Top-level answer text');
    expect(projB.thinking).toBe('Top-level reasoning text');
    expect(projB.source).toBe('top_level');

    // 3. Empty state
    const stateEmpty: DeepSeekInternalState = {
      fragments: [],
      response: {},
    };
    const projEmpty = projectDeepSeekState(stateEmpty);
    expect(projEmpty.answer).toBe('');
    expect(projEmpty.thinking).toBe('');
    expect(projEmpty.source).toBe('none');
  });

  it('computes semantic diffs accurately (unchanged, delta, replace)', () => {
    // 1. Unchanged
    expect(computeTextDiff('Hello', 'Hello')).toEqual({ kind: 'unchanged' });

    // 2. Initial delta
    expect(computeTextDiff('', 'Hello')).toEqual({ kind: 'delta', delta: 'Hello' });

    // 3. Prefix extension delta
    expect(computeTextDiff('Hello', 'Hello world')).toEqual({ kind: 'delta', delta: ' world' });

    // 4. Non-prefix modification (replace)
    expect(computeTextDiff('Hello world', 'Goodbye world')).toEqual({ kind: 'replace' });
    expect(computeTextDiff('Hello world', 'Hello')).toEqual({ kind: 'replace' });
  });
});
