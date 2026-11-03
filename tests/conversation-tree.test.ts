import { describe, it, expect } from 'vitest';
import { buildConversationTree } from '../src/core/conversation-tree';
import type { Message } from '../src/core/models';

function createMsg(
  id: string,
  parentId?: string,
  opts?: Partial<Message>
): Message {
  return {
    id,
    conversationId: 'conv-test',
    parentId,
    identityState: 'reconciled',
    projectionState: 'logical',
    role: opts?.role ?? 'user',
    status: opts?.status ?? 'finished',
    createdAt: opts?.createdAt ?? 1000,
    updatedAt: opts?.updatedAt ?? 1000,
    ...opts,
  };
}

describe('Unified ConversationTree Engine', () => {
  it('Scenario A: Standard linear conversation (5 turns alternating USER -> ASSISTANT)', () => {
    const messages: Message[] = [
      createMsg('u1', undefined, { role: 'user', createdAt: 100 }),
      createMsg('a1', 'u1', { role: 'assistant', createdAt: 200 }),
      createMsg('u2', 'a1', { role: 'user', createdAt: 300 }),
      createMsg('a2', 'u2', { role: 'assistant', createdAt: 400 }),
      createMsg('u3', 'a2', { role: 'user', createdAt: 500 }),
      createMsg('a3', 'u3', { role: 'assistant', createdAt: 600 }),
      createMsg('u4', 'a3', { role: 'user', createdAt: 700 }),
      createMsg('a4', 'u4', { role: 'assistant', createdAt: 800 }),
      createMsg('u5', 'a4', { role: 'user', createdAt: 900 }),
      createMsg('a5', 'u5', { role: 'assistant', createdAt: 1000 }),
    ];

    const tree = buildConversationTree(messages);

    expect(tree.roots.length).toBe(1);
    expect(tree.roots[0]!.message.id).toBe('u1');
    expect(tree.activePath.map((m) => m.id)).toEqual([
      'u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5',
    ]);
    expect(tree.activeLeafId).toBe('a5');
    expect(tree.unlinkedMessages.length).toBe(0);

    // Verify alternation
    for (let i = 0; i < tree.activePath.length; i++) {
      const expectedRole = i % 2 === 0 ? 'user' : 'assistant';
      expect(tree.activePath[i]!.role).toBe(expectedRole);
    }
  });

  it('Scenario B: User prompt edits produce sibling user branches', () => {
    // Tree:
    // u1 -> a1
    //       ├── u2_v1 [Edit 1] -> a2_v1
    //       ├── u2_v2 [Edit 2] -> a2_v2
    //       └── u2_v3 [Edit 3] -> a2_v3
    const messages: Message[] = [
      createMsg('u1', undefined, { role: 'user', createdAt: 100 }),
      createMsg('a1', 'u1', { role: 'assistant', createdAt: 200 }),
      createMsg('u2_v1', 'a1', { role: 'user', createdAt: 300, content: 'Prompt 2 Version 1' }),
      createMsg('a2_v1', 'u2_v1', { role: 'assistant', createdAt: 400 }),
      createMsg('u2_v2', 'a1', { role: 'user', createdAt: 500, content: 'Prompt 2 Version 2' }),
      createMsg('a2_v2', 'u2_v2', { role: 'assistant', createdAt: 600 }),
      createMsg('u2_v3', 'a1', { role: 'user', createdAt: 700, content: 'Prompt 2 Version 3' }),
      createMsg('a2_v3', 'u2_v3', { role: 'assistant', createdAt: 800 }),
    ];

    // Branch 0 (first edit)
    const tree0 = buildConversationTree(messages, {
      branchSelections: { a1: 0 },
    });
    expect(tree0.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_v1', 'a2_v1']);
    const u2v1Node = tree0.getNode('u2_v1')!;
    expect(u2v1Node.userBranchCount).toBe(3);
    expect(u2v1Node.userBranchIndex).toBe(0);

    // Branch 1 (second edit)
    const tree1 = buildConversationTree(messages, {
      branchSelections: { a1: 1 },
    });
    expect(tree1.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_v2', 'a2_v2']);
    const u2v2Node = tree1.getNode('u2_v2')!;
    expect(u2v2Node.userBranchCount).toBe(3);
    expect(u2v2Node.userBranchIndex).toBe(1);

    // Branch 2 (third edit)
    const tree2 = buildConversationTree(messages, {
      branchSelections: { a1: 2 },
    });
    expect(tree2.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_v3', 'a2_v3']);
    const u2v3Node = tree2.getNode('u2_v3')!;
    expect(u2v3Node.userBranchCount).toBe(3);
    expect(u2v3Node.userBranchIndex).toBe(2);
  });

  it('Scenario C: Regenerate produces sibling assistant variants sharing same user parent', () => {
    // Tree:
    // u1
    //  ├── a1_v1 (original response)
    //  ├── a1_v2 (regenerated response)
    //  └── a1_v3 (third regenerate)
    const messages: Message[] = [
      createMsg('u1', undefined, { role: 'user', createdAt: 100 }),
      createMsg('a1_v1', 'u1', { role: 'assistant', createdAt: 200, content: 'Resp 1' }),
      createMsg('a1_v2', 'u1', { role: 'assistant', createdAt: 300, content: 'Resp 2' }),
      createMsg('a1_v3', 'u1', { role: 'assistant', createdAt: 400, content: 'Resp 3' }),
    ];

    const tree = buildConversationTree(messages, {
      branchSelections: { u1: 1 }, // select 2nd regenerate
    });

    expect(tree.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v2']);
    const a1v2Node = tree.getNode('a1_v2')!;
    expect(a1v2Node.assistantVariantCount).toBe(3);
    expect(a1v2Node.assistantVariantIndex).toBe(1);
    expect(a1v2Node.userBranchCount).toBe(1); // Not a user branch!
  });

  it('Scenario D: Resolves parentage via remoteParentId -> remoteId lookup', () => {
    const messages: Message[] = [
      createMsg('local-user-1', undefined, {
        remoteId: 'remote-100',
        role: 'user',
        createdAt: 100,
      }),
      createMsg('local-asst-1', undefined, {
        remoteParentId: 'remote-100', // points to remoteId of user-1
        remoteId: 'remote-101',
        role: 'assistant',
        createdAt: 200,
      }),
    ];

    const tree = buildConversationTree(messages);
    expect(tree.activePath.map((m) => m.id)).toEqual(['local-user-1', 'local-asst-1']);
    const asstNode = tree.getNode('local-asst-1')!;
    expect(asstNode.parent?.message.id).toBe('local-user-1');
  });

  it('Scenario E: Authoritative server leaf via conversation.currentMessageId', () => {
    // Tree with two branches:
    // u1 -> a1 -> u2_a -> a2_a (remoteId 501)
    //          -> u2_b -> a2_b (remoteId 502)
    const messages: Message[] = [
      createMsg('u1', undefined, { role: 'user', createdAt: 100 }),
      createMsg('a1', 'u1', { role: 'assistant', createdAt: 200 }),
      createMsg('u2_a', 'a1', { role: 'user', createdAt: 300 }),
      createMsg('a2_a', 'u2_a', { remoteId: '501', role: 'assistant', createdAt: 400 }),
      createMsg('u2_b', 'a1', { role: 'user', createdAt: 500 }),
      createMsg('a2_b', 'u2_b', { remoteId: '502', role: 'assistant', createdAt: 600 }),
    ];

    const tree = buildConversationTree(messages, {
      conversation: { id: 'conv-1', currentMessageId: '502' },
    });

    expect(tree.activeLeafId).toBe('a2_b');
    expect(tree.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_b', 'a2_b']);
  });

  it('Scenario F: Cycle breaking and unlinked message collection', () => {
    // Deliberate cycle: m1 -> m2 -> m1
    const messages: Message[] = [
      createMsg('root-u', undefined, { role: 'user', createdAt: 50 }),
      createMsg('cycle-1', 'cycle-2', { role: 'assistant', createdAt: 100 }),
      createMsg('cycle-2', 'cycle-1', { role: 'user', createdAt: 200 }),
      createMsg('orphan-1', 'non-existent-parent', { role: 'assistant', createdAt: 300 }),
    ];

    const tree = buildConversationTree(messages);
    expect(tree.roots.length).toBe(1);
    expect(tree.roots[0]!.message.id).toBe('root-u');
    expect(tree.activePath.map((m) => m.id)).toEqual(['root-u']);
    expect(tree.unlinkedMessages.length).toBeGreaterThanOrEqual(1);
  });
});
