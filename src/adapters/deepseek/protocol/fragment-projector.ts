import type { DeepSeekFragment, DeepSeekProjectedContent, ProjectionSource } from './types';
import type { DeepSeekInternalState } from './patch-applier';

const ANSWER_TYPES = new Set(['RESPONSE']);
const THINKING_TYPES = new Set(['THINK', 'THINKING']);
const FILTER_OR_TEMPLATE_TYPES = new Set(['TIP', 'TEMPLATE_RESPONSE']);

/**
 * Checks whether a fragment represents model reasoning/thinking tokens.
 */
export function isThinkingFragment(fragment: DeepSeekFragment): boolean {
  if (!fragment || typeof fragment.type !== 'string') return false;
  return THINKING_TYPES.has(fragment.type.trim().toUpperCase());
}

/**
 * Checks whether a fragment is an explicit system notification, refusal template, or censor tip.
 * Uses strict type whitelisting rather than fragile text heuristics.
 */
export function isFilterOrTemplateFragment(fragment: DeepSeekFragment): boolean {
  if (!fragment || typeof fragment.type !== 'string') return false;
  return FILTER_OR_TEMPLATE_TYPES.has(fragment.type.trim().toUpperCase());
}

/**
 * Checks whether a fragment represents assistant answer text via strict type whitelisting.
 */
export function isAnswerFragment(fragment: DeepSeekFragment): boolean {
  if (!fragment || typeof fragment.type !== 'string') return false;
  return ANSWER_TYPES.has(fragment.type.trim().toUpperCase());
}

/**
 * Helper to join text parts, inserting paragraph separators when necessary.
 */
function joinParts(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return parts.reduce((acc, part, idx) => {
    if (idx === 0) return part;
    const needSep = !acc.endsWith('\n') && !part.startsWith('\n');
    return acc + (needSep ? '\n\n' : '') + part;
  }, '');
}

/**
 * Projects a raw list of fragments into clean semantic answer and thinking texts.
 * Ignores any non-answer and non-thinking fragments (e.g. TIP, TEMPLATE_RESPONSE, REQUEST, TOOL_*).
 */
export function projectFragments(fragments: DeepSeekFragment[]): DeepSeekProjectedContent {
  if (!fragments || !Array.isArray(fragments)) {
    return { answer: '', thinking: '', source: 'none' };
  }

  const answerParts: string[] = [];
  const thinkingParts: string[] = [];

  for (const f of fragments) {
    if (!f || typeof f.content !== 'string' || !f.content) continue;
    if (isFilterOrTemplateFragment(f)) continue;

    if (isThinkingFragment(f)) {
      thinkingParts.push(f.content);
    } else if (isAnswerFragment(f)) {
      answerParts.push(f.content);
    }
  }

  const answer = joinParts(answerParts);
  const thinking = joinParts(thinkingParts);
  const source: ProjectionSource = (answer.length > 0 || thinking.length > 0) ? 'fragments' : 'none';

  return { answer, thinking, source };
}

/**
 * Projects unified DeepSeek internal state across both variants:
 * - Variant A: fragments[]
 * - Variant B: top-level response.content / response.thinking_content
 */
export function projectDeepSeekState(state: DeepSeekInternalState): DeepSeekProjectedContent {
  if (!state) {
    return { answer: '', thinking: '', source: 'none' };
  }

  // 1. Try Variant A (fragments) first
  if (state.fragments && state.fragments.length > 0) {
    const proj = projectFragments(state.fragments);
    if (proj.answer.length > 0 || proj.thinking.length > 0) {
      return {
        answer: proj.answer,
        thinking: proj.thinking,
        source: 'fragments',
      };
    }
  }

  // 2. Try Variant B (top-level content / thinking_content)
  const topContent =
    typeof state.content === 'string'
      ? state.content
      : typeof state.response?.content === 'string'
        ? (state.response.content as string)
        : '';

  const topThinking =
    typeof state.thinking_content === 'string'
      ? state.thinking_content
      : typeof state.response?.thinking_content === 'string'
        ? (state.response.thinking_content as string)
        : '';

  if (topContent.length > 0 || topThinking.length > 0) {
    return {
      answer: topContent,
      thinking: topThinking,
      source: 'top_level',
    };
  }

  return { answer: '', thinking: '', source: 'none' };
}

export type TextDiffKind = 'unchanged' | 'delta' | 'replace';

export interface TextDiffResult {
  kind: TextDiffKind;
  delta?: string;
}

/**
 * Computes the semantic diff between previous and current text.
 * - 'unchanged': texts are identical
 * - 'delta': currentText cleanly extends previousText (prefix append)
 * - 'replace': currentText mutated or replaced non-prefix content
 */
export function computeTextDiff(previousText: string, currentText: string): TextDiffResult {
  if (previousText === currentText) {
    return { kind: 'unchanged' };
  }
  if (!previousText) {
    return { kind: 'delta', delta: currentText };
  }
  if (currentText.startsWith(previousText)) {
    return { kind: 'delta', delta: currentText.slice(previousText.length) };
  }
  return { kind: 'replace' };
}
