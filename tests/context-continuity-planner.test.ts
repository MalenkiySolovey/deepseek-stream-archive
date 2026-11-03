import { describe, it, expect } from 'vitest';
import type { Message, ResponseRevision, RecoveryEvent } from '../src/core/models';
import {
  buildContextContinuityPlan,
  sliceSafeUtf16,
} from '../src/context-continuity/planner';
import type {
  ContextContinuitySettings,
  ContextContinuityLimits,
} from '../src/context-continuity/types';

describe('Context Continuity Planner', () => {
  const conversationId = 'conv-planner-test';

  const defaultEnabledSettings: ContextContinuitySettings = {
    enabled: true,
    includeThinking: false,
  };

  function createMsg(id: string, parentId: string | undefined, role: 'user' | 'assistant', createdAt: number): Message {
    return {
      id,
      conversationId,
      parentId,
      identityState: 'provisional',
      role,
      createdAt,
      updatedAt: createdAt,
      status: 'finished',
    };
  }

  function createRev(id: string, messageId: string, text: string, thinking?: string): ResponseRevision {
    return {
      id,
      messageId,
      revisionIndex: 1,
      source: 'network',
      text,
      thinking,
      isLastGood: true,
      isFinal: true,
      capturedAt: 1000,
    };
  }

  describe('sliceSafeUtf16', () => {
    it('returns original string when length is within maxChars', () => {
      const res = sliceSafeUtf16('Hello world', 50);
      expect(res.truncated).toBe(false);
      expect(res.text).toBe('Hello world');
    });

    it('truncates cleanly and appends notice when exceeding maxChars', () => {
      const res = sliceSafeUtf16('1234567890', 5);
      expect(res.truncated).toBe(true);
      expect(res.text).toContain('12345');
      expect(res.text).toContain('[... Truncated to fit Context Continuity character budget ...]');
    });

    it('does not split surrogate pairs when boundary cuts through surrogate pair', () => {
      // 𠮷 is composed of high surrogate \uD842 and low surrogate \uDFB7 (2 UTF-16 code units)
      const emojiStr = 'abc' + '\uD842\uDFB7' + 'def';
      // If maxChars cuts right after high surrogate (index 4)
      const res = sliceSafeUtf16(emojiStr, 4);
      expect(res.truncated).toBe(true);
      // It should retreat by 1 and slice at 3 ('abc')
      expect(res.text.startsWith('abc\n\n[... Truncated')).toBe(true);
    });
  });

  describe('buildContextContinuityPlan', () => {
    it('returns empty plan when settings.enabled is false', () => {
      const u1 = createMsg('u1', undefined, 'user', 100);
      const a1 = createMsg('a1', 'u1', 'assistant', 200);
      const rev1 = createRev('rev-1', 'a1', 'Answer 1');

      const plan = buildContextContinuityPlan({
        conversationId,
        messages: [u1, a1],
        revisionsMap: new Map([['a1', [rev1]]]),
        settings: { enabled: false, includeThinking: false },
      });

      expect(plan.eligibleBlocks).toHaveLength(0);
      expect(plan.eligibleBlockCount).toBe(0);
      expect(plan.formattedPreview).toBe('');
    });

    it('builds plan with eligible active branch turns when enabled', () => {
      const u1 = createMsg('u1', undefined, 'user', 100);
      const a1 = createMsg('a1', 'u1', 'assistant', 200);
      const rev1 = createRev('rev-1', 'a1', 'First recovered response');

      const u2 = createMsg('u2', 'a1', 'user', 300);
      const a2 = createMsg('a2', 'u2', 'assistant', 400);
      const rev2 = createRev('rev-2', 'a2', 'Second recovered response');

      const plan = buildContextContinuityPlan({
        conversationId,
        messages: [u1, a1, u2, a2],
        revisionsMap: new Map([
          ['a1', [rev1]],
          ['a2', [rev2]],
        ]),
        settings: defaultEnabledSettings,
      });

      expect(plan.eligibleBlockCount).toBe(2);
      expect(plan.eligibleBlocks[0]!.sourceMessageId).toBe('a1');
      expect(plan.eligibleBlocks[1]!.sourceMessageId).toBe('a2');
      expect(plan.formattedPreview).toContain('First recovered response');
      expect(plan.formattedPreview).toContain('Second recovered response');
      expect(plan.truncated).toBe(false);
      expect(plan.omittedBlockCount).toBe(0);
    });

    it('enforces whole-block budget, dropping oldest blocks when maxBlocks is exceeded', () => {
      const messages: Message[] = [];
      const revisionsMap = new Map<string, ResponseRevision[]>();

      let lastId: string | undefined = undefined;
      for (let i = 1; i <= 6; i++) {
        const uId = `u${i}`;
        const aId = `a${i}`;
        const uMsg = createMsg(uId, lastId, 'user', i * 200);
        const aMsg = createMsg(aId, uId, 'assistant', i * 200 + 100);
        messages.push(uMsg, aMsg);
        revisionsMap.set(aId, [createRev(`rev-${i}`, aId, `Response content ${i}`)]);
        lastId = aId;
      }

      // Limit maxBlocks to 3
      const limits: ContextContinuityLimits = {
        maxBlocks: 3,
        maxTextChars: 10000,
        maxThinkingChars: 5000,
      };

      const plan = buildContextContinuityPlan({
        conversationId,
        messages,
        revisionsMap,
        settings: defaultEnabledSettings,
        limits,
      });

      // Must have selected the 3 newest blocks: a4, a5, a6
      // Sorted in chronological order: [a4, a5, a6]
      expect(plan.eligibleBlocks).toHaveLength(3);
      expect(plan.eligibleBlocks.map((b) => b.sourceMessageId)).toEqual(['a4', 'a5', 'a6']);
      expect(plan.omittedBlockCount).toBe(3);
      expect(plan.truncated).toBe(true);
      expect(plan.formattedPreview).toContain('[Note: 3 older recovered response(s) omitted');
    });

    it('respects includeThinking setting toggle', () => {
      const u1 = createMsg('u1', undefined, 'user', 100);
      const a1 = createMsg('a1', 'u1', 'assistant', 200);
      const rev1 = createRev('rev-1', 'a1', 'Answer with reasoning', 'Detailed thinking chain');

      // 1. Thinking disabled
      const planNoThinking = buildContextContinuityPlan({
        conversationId,
        messages: [u1, a1],
        revisionsMap: new Map([['a1', [rev1]]]),
        settings: { enabled: true, includeThinking: false },
      });
      expect(planNoThinking.totalThinkingChars).toBe(0);
      expect(planNoThinking.formattedPreview).not.toContain('Recovered DeepThink:');
      expect(planNoThinking.formattedPreview).toContain('Answer with reasoning');

      // 2. Thinking enabled
      const planWithThinking = buildContextContinuityPlan({
        conversationId,
        messages: [u1, a1],
        revisionsMap: new Map([['a1', [rev1]]]),
        settings: { enabled: true, includeThinking: true },
      });
      expect(planWithThinking.totalThinkingChars).toBeGreaterThan(0);
      expect(planWithThinking.formattedPreview).toContain('Recovered DeepThink:');
      expect(planWithThinking.formattedPreview).toContain('Detailed thinking chain');
    });

    it('records exclusions for non-active branch messages and invalid turns', () => {
      const u1 = createMsg('u1', undefined, 'user', 100);
      const a1 = createMsg('a1', 'u1', 'assistant', 200);
      const a1_sibling = createMsg('a1_sibling', 'u1', 'assistant', 250);

      const plan = buildContextContinuityPlan({
        conversationId,
        messages: [u1, a1, a1_sibling],
        revisionsMap: new Map([
          ['a1', [createRev('rev-1', 'a1', 'Active turn')]],
          ['a1_sibling', [createRev('rev-sib', 'a1_sibling', 'Sibling turn')]],
        ]),
        branchOptions: { leafMessageId: 'a1' },
        settings: defaultEnabledSettings,
      });

      expect(plan.eligibleBlocks).toHaveLength(1);
      expect(plan.eligibleBlocks[0]!.sourceMessageId).toBe('a1');

      const siblingExclusion = plan.excludedBlocks.find((e) => e.sourceMessageId === 'a1_sibling');
      expect(siblingExclusion).toBeDefined();
      expect(siblingExclusion?.reason).toBe('wrong_branch');
    });
  });
});
