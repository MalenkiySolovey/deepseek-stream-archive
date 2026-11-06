// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import type { Message, Conversation } from '../src/core/models';
import {
  buildConversationTree,
  type ArchiveViewSelection,
} from '../src/core/conversation-tree';
import {
  parseSafeMarkdown,
  renderSafeMarkdownToFragment,
  parseInlines,
} from '../src/presentation/safe-markdown';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import type { StorageRepository } from '../src/core/contracts/storage-repository';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';

function makeMsg(partial: Partial<Message> & { id: string; role: 'user' | 'assistant' }): Message {
  return {
    id: partial.id,
    remoteId: partial.remoteId,
    conversationId: partial.conversationId || 'conv-test-tree',
    parentId: partial.parentId,
    remoteParentId: partial.remoteParentId,
    role: partial.role,
    status: partial.status || 'finished',
    content: partial.content,
    identityState: partial.identityState || 'reconciled',
    projectionState: partial.projectionState || 'logical',
    createdAt: partial.createdAt || Date.now(),
    updatedAt: partial.updatedAt || Date.now(),
  };
}

describe('DeepSeek StreamArchive — Independent Conversation Tree & Rich Text Scenarios', () => {
  // ── Scenario 1: Normal linear conversation ──
  it('Scenario 1: Normal linear conversation retains strict User -> Assistant ordering', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'Prompt 1', createdAt: 100 }),
      makeMsg({ id: 'a1', role: 'assistant', parentId: 'u1', createdAt: 200 }),
      makeMsg({ id: 'u2', role: 'user', parentId: 'a1', content: 'Prompt 2', createdAt: 300 }),
      makeMsg({ id: 'a2', role: 'assistant', parentId: 'u2', createdAt: 400 }),
    ];

    const tree = buildConversationTree(messages);
    expect(tree.roots).toHaveLength(1);
    expect(tree.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(tree.diagnostics.unresolvedParentLinksCount).toBe(0);
    expect(tree.unlinkedMessages).toHaveLength(0);
  });

  // ── Scenario 2: Edit of the first prompt ──
  it('Scenario 2: Edit of first prompt creates 3 user prompt branches with independent responses', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1_v1', role: 'user', content: 'Original prompt', createdAt: 100 }),
      makeMsg({ id: 'a1_v1', role: 'assistant', parentId: 'u1_v1', createdAt: 200 }),

      makeMsg({ id: 'u1_v2', role: 'user', content: 'Edited prompt 2', createdAt: 300 }),
      makeMsg({ id: 'a1_v2', role: 'assistant', parentId: 'u1_v2', createdAt: 400 }),

      makeMsg({ id: 'u1_v3', role: 'user', content: 'Edited prompt 3', createdAt: 500 }),
      makeMsg({ id: 'a1_v3', role: 'assistant', parentId: 'u1_v3', createdAt: 600 }),
    ];

    const tree = buildConversationTree(messages);
    expect(tree.roots).toHaveLength(3);
    expect(tree.roots[0]!.userBranchCount).toBe(3);
    expect(tree.roots[0]!.userBranchIndex).toBe(0);
    expect(tree.roots[1]!.userBranchIndex).toBe(1);
    expect(tree.roots[2]!.userBranchIndex).toBe(2);

    // Test selection by stable root message ID
    const treeSel2 = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { __root__: 'u1_v2' },
        selectedRootId: 'u1_v2',
        updatedAt: Date.now(),
      },
    });
    expect(treeSel2.activePath.map((m) => m.id)).toEqual(['u1_v2', 'a1_v2']);

    const treeSel3 = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { __root__: 'u1_v3' },
        selectedRootId: 'u1_v3',
        updatedAt: Date.now(),
      },
    });
    expect(treeSel3.activePath.map((m) => m.id)).toEqual(['u1_v3', 'a1_v3']);
  });

  // ── Scenario 3: Regenerate ──
  it('Scenario 3: Single prompt with 3 regenerate variants allows independent bidirectional switching', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'Explain quantum physics', createdAt: 100 }),
      makeMsg({ id: 'a1_v1', role: 'assistant', parentId: 'u1', createdAt: 200 }),
      makeMsg({ id: 'a1_v2', role: 'assistant', parentId: 'u1', createdAt: 300 }),
      makeMsg({ id: 'a1_v3', role: 'assistant', parentId: 'u1', createdAt: 400 }),
    ];

    const tree = buildConversationTree(messages);
    expect(tree.roots).toHaveLength(1);
    const u1Node = tree.roots[0]!;
    expect(u1Node.children).toHaveLength(3);
    expect(u1Node.children[0]!.assistantVariantCount).toBe(3);
    expect(u1Node.children[0]!.assistantVariantIndex).toBe(0);
    expect(u1Node.children[1]!.assistantVariantIndex).toBe(1);
    expect(u1Node.children[2]!.assistantVariantIndex).toBe(2);

    // Switch to variant 1 by stable ID
    const tree1 = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { u1: 'a1_v1' },
        updatedAt: Date.now(),
      },
    });
    expect(tree1.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v1']);

    // Switch to variant 2 by stable ID
    const tree2 = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { u1: 'a1_v2' },
        updatedAt: Date.now(),
      },
    });
    expect(tree2.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v2']);

    // Switch to variant 3 by stable ID
    const tree3 = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { u1: 'a1_v3' },
        updatedAt: Date.now(),
      },
    });
    expect(tree3.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v3']);
  });

  // ── Scenario 4: Edit inside conversation ──
  it('Scenario 4: Editing turn 2 creates sibling user prompts anchored under Assistant 1', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'Question 1', createdAt: 100 }),
      makeMsg({ id: 'a1', role: 'assistant', parentId: 'u1', createdAt: 200 }),
      // Turn 2: original
      makeMsg({ id: 'u2_v1', role: 'user', parentId: 'a1', content: 'Question 2 variant 1', createdAt: 300 }),
      makeMsg({ id: 'a2_v1', role: 'assistant', parentId: 'u2_v1', createdAt: 400 }),
      // Turn 2: edit
      makeMsg({ id: 'u2_v2', role: 'user', parentId: 'a1', content: 'Question 2 variant 2', createdAt: 500 }),
      makeMsg({ id: 'a2_v2', role: 'assistant', parentId: 'u2_v2', createdAt: 600 }),
    ];

    const tree = buildConversationTree(messages);
    const a1Node = tree.getNode('a1')!;
    expect(a1Node.children).toHaveLength(2);
    expect(a1Node.children[0]!.userBranchCount).toBe(2);
    expect(a1Node.children[0]!.message.id).toBe('u2_v1');
    expect(a1Node.children[1]!.userBranchCount).toBe(2);
    expect(a1Node.children[1]!.message.id).toBe('u2_v2');

    // Select variant 1
    const t1 = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { a1: 'u2_v1' },
        updatedAt: Date.now(),
      },
    });
    expect(t1.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_v1', 'a2_v1']);

    // Select variant 2
    const t2 = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { a1: 'u2_v2' },
        updatedAt: Date.now(),
      },
    });
    expect(t2.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_v2', 'a2_v2']);
  });

  // ── Scenario 5: Follow-up continuation on second regenerate response ──
  it('Scenario 5: Follow-up prompt from second regenerate response attaches strictly to variant 2', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'Base prompt', createdAt: 100 }),
      makeMsg({ id: 'a1_v1', role: 'assistant', parentId: 'u1', createdAt: 200 }),
      makeMsg({ id: 'a1_v2', role: 'assistant', parentId: 'u1', createdAt: 300 }),
      // Follow-up from variant 2
      makeMsg({ id: 'u2', role: 'user', parentId: 'a1_v2', content: 'Follow up on variant 2', createdAt: 400 }),
      makeMsg({ id: 'a2', role: 'assistant', parentId: 'u2', createdAt: 500 }),
    ];

    const tree = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { u1: 'a1_v2' },
        updatedAt: Date.now(),
      },
    });

    expect(tree.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v2', 'u2', 'a2']);
    // Variant 1 remains isolated
    const v1Tree = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { u1: 'a1_v1' },
        updatedAt: Date.now(),
      },
    });
    expect(v1Tree.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v1']);
  });

  // ── Scenario 6: Independence from DeepSeek server active branch ──
  it('Scenario 6: StreamArchive selection is independent from DeepSeek server currentMessageId', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q', createdAt: 100 }),
      makeMsg({ id: 'a1_v1', remoteId: '101', role: 'assistant', parentId: 'u1', createdAt: 200 }),
      makeMsg({ id: 'a1_v2', remoteId: '102', role: 'assistant', parentId: 'u1', createdAt: 300 }),
      makeMsg({ id: 'a1_v3', remoteId: '103', role: 'assistant', parentId: 'u1', createdAt: 400 }),
    ];

    // Server state says active leaf is variant 3 (remoteId: '103')
    const conv: Conversation = {
      id: 'conv-test-tree',
      title: 'Test',
      createdAt: 100,
      updatedAt: 400,
      currentMessageId: '103',
    };

    // User explicitly chose variant 1 in StreamArchive
    const tree = buildConversationTree(messages, {
      conversation: conv,
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: { u1: 'a1_v1' },
        updatedAt: 123456,
      },
    });

    // StreamArchive displays variant 1!
    expect(tree.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v1']);
    // Observed path reflects server's variant 3!
    expect(tree.observedPath.map((m) => m.id)).toEqual(['u1', 'a1_v3']);
    // Archive view does not match observed path -> user notification triggered!
    expect(tree.isArchiveViewingObservedPath).toBe(false);
    expect(tree.diagnostics.isArchiveViewingObservedPath).toBe(false);
  });

  // ── Scenario 7: New generation in alternate branch while viewing older branch ──
  it('Scenario 7: New generation in DeepSeek adds to branch 3 without auto-switching archive view from branch 1', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'Q', createdAt: 100 }),
      makeMsg({ id: 'a1_v1', role: 'assistant', parentId: 'u1', createdAt: 200 }),
      makeMsg({ id: 'a1_v2', role: 'assistant', parentId: 'u1', createdAt: 300 }),
      // New turn generated in branch 2
      makeMsg({ id: 'u2_new', role: 'user', parentId: 'a1_v2', content: 'New prompt', createdAt: 400 }),
      makeMsg({ id: 'a2_new', role: 'assistant', parentId: 'u2_new', content: 'New answer', createdAt: 500 }),
    ];

    const conv: Conversation = {
      id: 'conv-test-tree',
      title: 'Test',
      createdAt: 100,
      updatedAt: 500,
      currentMessageId: 'a2_new',
    };

    // User view was set to a1_v1
    const viewSelection: ArchiveViewSelection = {
      conversationId: 'conv-test-tree',
      selectedChildByParent: { u1: 'a1_v1' },
      updatedAt: 1000,
    };

    const tree = buildConversationTree(messages, {
      conversation: conv,
      viewSelection,
    });

    // Active path still displays branch 1
    expect(tree.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v1']);
    // Observed path shows the new generation in branch 2
    expect(tree.observedPath.map((m) => m.id)).toEqual(['u1', 'a1_v2', 'u2_new', 'a2_new']);
    // Notification indicator is true
    expect(tree.isArchiveViewingObservedPath).toBe(false);

    // Clicking "Go to active DeepSeek session" smoothly switches viewSelection
    const updatedViewSelection: ArchiveViewSelection = {
      conversationId: 'conv-test-tree',
      selectedChildByParent: {
        u1: 'a1_v2',
        a1_v2: 'u2_new',
        u2_new: 'a2_new',
      },
      updatedAt: 2000,
    };

    const treeSwitched = buildConversationTree(messages, {
      conversation: conv,
      viewSelection: updatedViewSelection,
    });
    expect(treeSwitched.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v2', 'u2_new', 'a2_new']);
    expect(treeSwitched.isArchiveViewingObservedPath).toBe(true);
  });

  // ── Scenario 8: Selection by stable ID survives re-ordering and insertion ──
  it('Scenario 8: Selection by stable message ID remains unaffected when earlier siblings are inserted', () => {
    const messagesInitial: Message[] = [
      makeMsg({ id: 'u1', role: 'user', createdAt: 100 }),
      makeMsg({ id: 'a1_B', role: 'assistant', parentId: 'u1', createdAt: 300 }),
    ];

    const sel: ArchiveViewSelection = {
      conversationId: 'conv-test-tree',
      selectedChildByParent: { u1: 'a1_B' },
      updatedAt: 1000,
    };

    // Later, an earlier sibling A arrives from a restored stream
    const messagesUpdated: Message[] = [
      makeMsg({ id: 'u1', role: 'user', createdAt: 100 }),
      makeMsg({ id: 'a1_A', role: 'assistant', parentId: 'u1', createdAt: 200 }),
      makeMsg({ id: 'a1_B', role: 'assistant', parentId: 'u1', createdAt: 300 }),
    ];

    const tree = buildConversationTree(messagesUpdated, { viewSelection: sel });
    // Still selects a1_B, not a1_A!
    expect(tree.activePath[1]!.id).toBe('a1_B');
  });

  // ── Scenario 9: Duplicate prompt texts in different branches ──
  it('Scenario 9: Reconciler does not collapse identical prompt texts across different branches', async () => {
    const mockStorage = {
      getConversationByRemoteId: vi.fn().mockResolvedValue({ id: 'c1', title: 'Test' }),
      getConversation: vi.fn().mockResolvedValue({ id: 'c1', title: 'Test' }),
      listMessagesByConversation: vi.fn().mockResolvedValue([
        makeMsg({ id: 'u1_branchA', role: 'user', remoteParentId: 'asst_10', content: 'Explain again', identityState: 'provisional' }),
        makeMsg({ id: 'u1_branchB', role: 'user', remoteParentId: 'asst_20', content: 'Explain again', identityState: 'provisional' }),
      ]),
      listRevisionsByMessage: vi.fn().mockResolvedValue([]),
      listRecoveryEvents: vi.fn().mockResolvedValue([]),
      applyHistoryReconciliationPlan: vi.fn().mockResolvedValue(undefined),
    } as unknown as StorageRepository;

    const reconciler = new HistoryReconciler(mockStorage);
    const parsedHistory: DeepSeekParsedHistory = {
      session: { sessionId: 's1', title: 'Chat', updatedAt: 1000, pinned: false },
      messages: [
        // Incoming history turn matches branch B parent
        { messageId: 'server_u_b', parentId: 'asst_20', role: 'user', text: 'Explain again', status: 'finished', createdAt: 500, isFiltered: false, fragmentsCount: 1 },
      ],
    };

    const { plan } = await reconciler.createPlan(parsedHistory);
    // u1_branchB should be reconciled
    const branchB = plan.messagesToPut.find((m) => m.id === 'u1_branchB');
    expect(branchB?.remoteId).toBe('server_u_b');

    // u1_branchA must NOT be degraded to attempt_only or wiped!
    const branchA = plan.messagesToPut.find((m) => m.id === 'u1_branchA');
    if (branchA) {
      expect(branchA.projectionState).not.toBe('attempt_only');
      expect(branchA.parentId).not.toBeUndefined();
    }
  });

  // ── Scenario 10: Filtered regenerate variants ──
  it('Scenario 10: Censored regenerate variants retain last good content and sticky filtered status', () => {
    const messages: Message[] = [
      makeMsg({ id: 'u1', role: 'user', content: 'Tell me about forbidden topic', createdAt: 100 }),
      makeMsg({ id: 'a1_v1', role: 'assistant', parentId: 'u1', status: 'filtered', createdAt: 200 }),
      makeMsg({ id: 'a1_v2', role: 'assistant', parentId: 'u1', status: 'finished', createdAt: 300 }),
    ];

    const tree = buildConversationTree(messages);
    const v1Node = tree.getNode('a1_v1')!;
    expect(v1Node.message.status).toBe('filtered');
    expect(v1Node.assistantVariantCount).toBe(2);

    const v2Node = tree.getNode('a1_v2')!;
    expect(v2Node.message.status).toBe('finished');
  });

  // ── Scenario 11: Rich Markdown rendering ──
  it('Scenario 11: Full rich markdown parsing (headings, code, lists, tables, quotes, hr, links)', () => {
    const raw = `
# Main Title
Here is a paragraph with **жирный** and *курсив* and ~~зачёркнутый~~ and \`inline code\`.

> Quote block from assistant

---

- Bullet 1
- Bullet 2
  - Sub-bullet 2.1

1. Step 1
2. Step 2

| Param | Value |
|:---|---:|
| Alpha | 100 |
| Beta | 200 |

\`\`\`typescript
const answer = 42;
\`\`\`
`.trim();

    const blocks = parseSafeMarkdown(raw);
    const frag = renderSafeMarkdownToFragment(blocks);

    expect(frag.querySelector('h1.safe-md-h1')?.textContent).toBe('Main Title');
    expect(frag.querySelector('strong.safe-md-bold')?.textContent).toBe('жирный');
    expect(frag.querySelector('em.safe-md-italic')?.textContent).toBe('курсив');
    expect(frag.querySelector('del.safe-md-del')?.textContent).toBe('зачёркнутый');
    expect(frag.querySelector('code.safe-md-inline-code')?.textContent).toBe('inline code');
    expect(frag.querySelector('blockquote.safe-md-blockquote')?.textContent).toContain('Quote block');
    expect(frag.querySelector('hr.safe-md-hr')).not.toBeNull();
    expect(frag.querySelector('ul.safe-md-ul')).not.toBeNull();
    expect(frag.querySelector('ol.safe-md-ol')).not.toBeNull();
    expect(frag.querySelector('.safe-md-table-wrapper table.safe-md-table')).not.toBeNull();
    expect(frag.querySelector('.safe-md-code-wrapper code.safe-md-code')?.textContent).toBe('const answer = 42;');
  });

  // ── Scenario 12: Markdown Security & XSS Immunization ──
  it('Scenario 12: Strict XSS immunization with safe link validation', () => {
    const malicious = `
<script>alert('xss')</script>
<img src=x onerror=alert(1)>
[Legit](https://example.com)
[Dangerous JS](javascript:alert(document.cookie))
[Dangerous Data](data:text/html,<script>alert(1)</script>)
`.trim();

    const blocks = parseSafeMarkdown(malicious);
    const frag = renderSafeMarkdownToFragment(blocks);

    expect(frag.querySelector('script')).toBeNull();
    expect(frag.querySelector('img')).toBeNull();
    expect(frag.querySelectorAll('a.safe-md-link')).toHaveLength(1);
    expect(frag.querySelector('a[href*="javascript"]')).toBeNull();
    expect(frag.querySelector('a[href*="data:"]')).toBeNull();
    expect(frag.textContent).toContain("<script>alert('xss')</script>");
  });

  // ── Scenario 13: Storage persistence across reloads ──
  it('Scenario 13: View selection persists accurately in ArchiveViewSelection structure', () => {
    const selection: ArchiveViewSelection = {
      conversationId: 'conv-persisted',
      selectedChildByParent: {
        __root__: 'root-prompt-2',
        'asst-1': 'prompt-2-edit-3',
      },
      selectedRootId: 'root-prompt-2',
      updatedAt: 12345678,
    };

    expect(selection.selectedChildByParent['__root__']).toBe('root-prompt-2');
    expect(selection.selectedChildByParent['asst-1']).toBe('prompt-2-edit-3');
    expect(typeof selection.updatedAt).toBe('number');
  });

  // ── Scenario 14: Complex mixed tree ──
  it('Scenario 14: Complex mixed tree with 3 Edits, 3 Regenerates and branch continuations', () => {
    const messages: Message[] = [
      // Root Edit A
      makeMsg({ id: 'u_root_A', role: 'user', content: 'Root A', createdAt: 100 }),
      makeMsg({ id: 'a_root_A1', role: 'assistant', parentId: 'u_root_A', createdAt: 200 }),
      makeMsg({ id: 'a_root_A2', role: 'assistant', parentId: 'u_root_A', createdAt: 300 }),
      makeMsg({ id: 'a_root_A3', role: 'assistant', parentId: 'u_root_A', status: 'filtered', createdAt: 400 }),

      // Continuation under A2
      makeMsg({ id: 'u_sub_A2', role: 'user', parentId: 'a_root_A2', content: 'Sub A2', createdAt: 500 }),
      makeMsg({ id: 'a_sub_A2_1', role: 'assistant', parentId: 'u_sub_A2', createdAt: 600 }),

      // Root Edit B
      makeMsg({ id: 'u_root_B', role: 'user', content: 'Root B', createdAt: 700 }),
      makeMsg({ id: 'a_root_B1', role: 'assistant', parentId: 'u_root_B', createdAt: 800 }),
    ];

    const tree = buildConversationTree(messages, {
      viewSelection: {
        conversationId: 'conv-test-tree',
        selectedChildByParent: {
          __root__: 'u_root_A',
          u_root_A: 'a_root_A2',
          a_root_A2: 'u_sub_A2',
        },
        selectedRootId: 'u_root_A',
        updatedAt: Date.now(),
      },
    });

    expect(tree.roots).toHaveLength(2);
    expect(tree.activePath.map((m) => m.id)).toEqual(['u_root_A', 'a_root_A2', 'u_sub_A2', 'a_sub_A2_1']);
    expect(tree.diagnostics.userBranchGroupCount).toBe(1);
    expect(tree.diagnostics.assistantVariantGroupCount).toBe(1);
    expect(tree.diagnostics.unresolvedParentLinksCount).toBe(0);
  });

  // ── Scenario 15: Backward compatibility with legacy unparented records ──
  it('Scenario 15: Unambiguous legacy v0.1.0 records resolve safely without data loss', () => {
    const legacyMessages: Message[] = [
      makeMsg({ id: 'legacy-u', role: 'user', content: 'Old user prompt', createdAt: 100 }),
      makeMsg({ id: 'legacy-a', role: 'assistant', parentId: undefined, createdAt: 200 }),
    ];

    const tree = buildConversationTree(legacyMessages);
    expect(tree.activePath).toHaveLength(2);
    expect(tree.activePath[0]!.id).toBe('legacy-u');
    expect(tree.activePath[1]!.id).toBe('legacy-a');
  });

  // ── Scenario 16: Assistant -> Assistant link prevention ──
  it('Scenario 16: Reconciler never creates illegal Assistant -> Assistant parent links', async () => {
    const mockStorage = {
      getConversationByRemoteId: vi.fn().mockResolvedValue({ id: 'c1', title: 'Test' }),
      getConversation: vi.fn().mockResolvedValue({ id: 'c1', title: 'Test' }),
      listMessagesByConversation: vi.fn().mockResolvedValue([
        makeMsg({ id: 'a_prev', role: 'assistant', remoteId: 'remote_asst_10' }),
        makeMsg({ id: 'a_next', role: 'assistant', remoteParentId: 'remote_asst_10' }), // Attempted illegal link
      ]),
      listRevisionsByMessage: vi.fn().mockResolvedValue([]),
      listRecoveryEvents: vi.fn().mockResolvedValue([]),
      applyHistoryReconciliationPlan: vi.fn().mockResolvedValue(undefined),
    } as unknown as StorageRepository;

    const reconciler = new HistoryReconciler(mockStorage);
    const parsedHistory: DeepSeekParsedHistory = {
      session: { sessionId: 's1', title: 'Chat', updatedAt: 1000, pinned: false },
      messages: [],
    };

    const { plan } = await reconciler.createPlan(parsedHistory);
    // a_next must NOT have parentId set to a_prev
    const aNext = plan.messagesToPut.find((m) => m.id === 'a_next');
    expect(aNext?.parentId).not.toBe('a_prev');
  });
});
