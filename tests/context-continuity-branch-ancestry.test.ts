import { describe, it, expect } from 'vitest';
import type { Message } from '../src/core/models';
import { getActiveBranchAncestry } from '../src/context-continuity/branch-ancestry';

describe('Active Branch Ancestry Resolver', () => {
  const conversationId = 'conv-tree-branch';

  function createMsg(id: string, parentId?: string, overrides?: Partial<Message>): Message {
    return {
      id,
      conversationId,
      parentId,
      identityState: 'provisional',
      role: 'assistant',
      createdAt: 1000,
      updatedAt: 1000,
      status: 'finished',
      ...overrides,
    };
  }

  describe('Upward Traversal from Explicit Leaf', () => {
    it('traces lineage from leaf to root via parentId', () => {
      // Linear branch: u1 -> a1 -> u2 -> a2
      const u1 = createMsg('u1', undefined, { role: 'user', createdAt: 100 });
      const a1 = createMsg('a1', 'u1', { role: 'assistant', createdAt: 200 });
      const u2 = createMsg('u2', 'a1', { role: 'user', createdAt: 300 });
      const a2 = createMsg('a2', 'u2', { role: 'assistant', createdAt: 400 });

      const result = getActiveBranchAncestry([u1, a1, u2, a2], { leafMessageId: 'a2' });

      expect(result.leafMessageId).toBe('a2');
      expect(result.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
      expect(result.activeMessageIds.has('u1')).toBe(true);
      expect(result.activeMessageIds.has('a1')).toBe(true);
      expect(result.activeMessageIds.has('u2')).toBe(true);
      expect(result.activeMessageIds.has('a2')).toBe(true);
      expect(result.depthMap.get('u1')).toBe(0);
      expect(result.depthMap.get('a1')).toBe(1);
      expect(result.depthMap.get('u2')).toBe(2);
      expect(result.depthMap.get('a2')).toBe(3);
    });

    it('isolates unselected sibling branches cleanly', () => {
      // Tree:
      // u1
      // ├── a1 (original) ── u2_a ── a2_a
      // └── a1_regen (regenerate) ── u2_b ── a2_b
      const u1 = createMsg('u1', undefined, { role: 'user', createdAt: 100 });
      const a1 = createMsg('a1', 'u1', { role: 'assistant', createdAt: 200 });
      const a1_regen = createMsg('a1_regen', 'u1', { role: 'assistant', createdAt: 250 });
      const u2_a = createMsg('u2_a', 'a1', { role: 'user', createdAt: 300 });
      const a2_a = createMsg('a2_a', 'u2_a', { role: 'assistant', createdAt: 400 });
      const u2_b = createMsg('u2_b', 'a1_regen', { role: 'user', createdAt: 350 });
      const a2_b = createMsg('a2_b', 'u2_b', { role: 'assistant', createdAt: 450 });

      const allMessages = [u1, a1, a1_regen, u2_a, a2_a, u2_b, a2_b];

      // Select leaf in branch B
      const resultB = getActiveBranchAncestry(allMessages, { leafMessageId: 'a2_b' });
      expect(resultB.activePath.map((m) => m.id)).toEqual(['u1', 'a1_regen', 'u2_b', 'a2_b']);
      expect(resultB.activeMessageIds.has('a1')).toBe(false);
      expect(resultB.activeMessageIds.has('u2_a')).toBe(false);
      expect(resultB.activeMessageIds.has('a2_a')).toBe(false);

      // Select leaf in branch A
      const resultA = getActiveBranchAncestry(allMessages, { leafMessageId: 'a2_a' });
      expect(resultA.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_a', 'a2_a']);
      expect(resultA.activeMessageIds.has('a1_regen')).toBe(false);
      expect(resultA.activeMessageIds.has('u2_b')).toBe(false);
      expect(resultA.activeMessageIds.has('a2_b')).toBe(false);
    });

    it('handles cycle gracefully without infinite loop', () => {
      // Malformed cycle: m1 -> m2 -> m1
      const m1 = createMsg('m1', 'm2', { createdAt: 100 });
      const m2 = createMsg('m2', 'm1', { createdAt: 200 });

      const result = getActiveBranchAncestry([m1, m2], { leafMessageId: 'm2' });
      expect(result.activePath.length).toBeLessThanOrEqual(2);
      expect(result.activeMessageIds.size).toBeLessThanOrEqual(2);
    });

    it('filters out non-logical turns (attempt_only, unmatched_capture)', () => {
      const u1 = createMsg('u1', undefined, { role: 'user', createdAt: 100 });
      const attempt = createMsg('attempt-1', 'u1', { projectionState: 'attempt_only', createdAt: 150 });
      const a1 = createMsg('a1', 'attempt-1', { role: 'assistant', createdAt: 200 });

      // Because attempt-1 is stripped from logical turns, upward traversal from a1 stops or cannot reach u1 through attempt-1
      const result = getActiveBranchAncestry([u1, attempt, a1], { leafMessageId: 'a1' });
      expect(result.activeMessageIds.has('attempt-1')).toBe(false);
    });
  });

  describe('Downward Traversal via branchSelections', () => {
    it('defaults to first sibling when branchSelections are omitted', () => {
      const u1 = createMsg('u1', undefined, { role: 'user', createdAt: 100 });
      const a1_v1 = createMsg('a1_v1', 'u1', { role: 'assistant', createdAt: 200 });
      const a1_v2 = createMsg('a1_v2', 'u1', { role: 'assistant', createdAt: 300 });

      const result = getActiveBranchAncestry([u1, a1_v1, a1_v2]);
      expect(result.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v1']);
      expect(result.leafMessageId).toBe('a1_v1');
    });

    it('selects alternate sibling when branchSelection index is specified', () => {
      const u1 = createMsg('u1', undefined, { role: 'user', createdAt: 100 });
      const a1_v1 = createMsg('a1_v1', 'u1', { role: 'assistant', createdAt: 200 });
      const a1_v2 = createMsg('a1_v2', 'u1', { role: 'assistant', createdAt: 300 });

      const result = getActiveBranchAncestry([u1, a1_v1, a1_v2], {
        branchSelections: { u1: 1 },
      });
      expect(result.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v2']);
      expect(result.leafMessageId).toBe('a1_v2');
    });

    it('returns empty result when no messages provided', () => {
      const result = getActiveBranchAncestry([]);
      expect(result.activePath).toEqual([]);
      expect(result.activeMessageIds.size).toBe(0);
      expect(result.leafMessageId).toBeNull();
    });
  });
});
