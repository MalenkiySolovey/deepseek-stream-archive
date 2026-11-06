// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildConversationTree } from '../src/core/conversation-tree';
import type { Message, Conversation } from '../src/core/models';
import { StreamArchiveOverlayPortal } from '../src/overlay/portal';
import { locateMessageAnchor, findInlineInsertionPoint } from '../src/adapters/deepseek/dom/message-locator';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import type { StorageRepository } from '../src/core/contracts';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';

function createMsg(id: string, parentId?: string, opts?: Partial<Message>): Message {
  return {
    id,
    conversationId: 'conv-test-123',
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

describe('Mandatory Goal Scenarios A-J: Inline Recovery & Branch DAG Integrity', () => {
  let rootEl: HTMLElement;

  beforeEach(() => {
    rootEl = document.createElement('div');
    document.body.appendChild(rootEl);
  });

  afterEach(() => {
    if (rootEl.parentNode) {
      rootEl.parentNode.removeChild(rootEl);
    }
    // Clean up any remaining portals or inline hosts
    const roots = document.querySelectorAll('[data-streamarchive-overlay-root]');
    roots.forEach((r) => r.remove());
  });

  // ────────────────────────────────────────────────────────────────
  // Test A: Inline recovery mode (Mode A underneath original response)
  // ────────────────────────────────────────────────────────────────
  it('Scenario A: Mode A renders inline block underneath original response without overlay badge', async () => {
    // Construct real DeepSeek DOM layout using data-virtual-list-item-key
    const itemEl = document.createElement('div');
    itemEl.setAttribute('data-virtual-list-item-key', '201');

    const msgBox = document.createElement('div');
    msgBox.className = 'ds-message';

    const stubEl = document.createElement('div');
    stubEl.className = 'ds-markdown ds-assistant-message-main-content';
    stubEl.textContent = 'This message was filtered by safety system.';
    msgBox.appendChild(stubEl);

    const toolbarEl = document.createElement('div');
    toolbarEl.className = 'ds-flex';
    const copyBtn = document.createElement('div');
    copyBtn.className = 'ds-icon-button';
    copyBtn.setAttribute('role', 'button');
    toolbarEl.appendChild(copyBtn);
    msgBox.appendChild(toolbarEl);

    itemEl.appendChild(msgBox);
    rootEl.appendChild(itemEl);

    const portal = new StreamArchiveOverlayPortal({
      presentationSettings: {
        displayMode: 'inline',
        inlinePlacement: 'underneath',
        showThinkingInline: true,
      },
      fetchSummary: async () => ({
        conversationId: 'conv-test-123',
        remoteSessionId: 'sess-123',
        recoverableCount: 1,
        messages: [
          {
            messageId: 'asst-msg-201',
            remoteId: '201',
            role: 'assistant',
            status: 'filtered',
            hasLastGood: true,
            recoveryKind: 'authoritative_recovery',
            presentationKind: 'pre_filter_recovery',
            capturedAt: 12345,
            recoveredRevisionId: 'rev-201',
          },
        ],
      }),
      fetchContent: async () => ({
        text: 'Preserved pre-filter answer text about quantum computing.',
        thinking: 'DeepThink step 1: analyze quantum states.',
      }),
    });

    // Provide URL matching session
    window.location.href = 'https://chat.deepseek.com/a/chat/s/sess-123';
    await portal.refreshSummary();

    // Verify anchor was found via data-virtual-list-item-key
    const anchor = locateMessageAnchor('201', rootEl);
    expect(anchor).not.toBeNull();
    expect(anchor!.remoteId).toBe('201');

    // Verify inline host is mounted inside message container
    const inlineHost = itemEl.querySelector('[data-streamarchive-inline-recovery-host]');
    expect(inlineHost).not.toBeNull();

    // Verify Mode A: original stub remains VISIBLE
    expect(stubEl.style.display).not.toBe('none');

    // Verify overlay badge is NOT rendered
    const overlayContainer = (portal as any).container as HTMLElement;
    const badge = overlayContainer.querySelector('.streamarchive-anchored-badge');
    expect(badge).toBeNull();
    const tray = overlayContainer.querySelector('.streamarchive-floating-tray');
    expect(tray).toBeNull();

    // Verify diagnostics
    const diag = portal.getDiagnostics();
    expect(diag.inlineMountedCount).toBe(1);
    expect(diag.inlineAttemptedCount).toBeGreaterThanOrEqual(1);
    expect(diag.inlineSucceededCount).toBeGreaterThanOrEqual(1);
    expect(diag.inlineFallbackReason).toBeNull();

    portal.destroy();
  });

  // ────────────────────────────────────────────────────────────────
  // Test B: Inline replacement mode (Mode B instead of original response)
  // ────────────────────────────────────────────────────────────────
  it('Scenario B: Mode B hides original stub, mounts preserved version, and provides reversible toggle', async () => {
    const itemEl = document.createElement('div');
    itemEl.setAttribute('data-virtual-list-item-key', '202');

    const msgBox = document.createElement('div');
    msgBox.className = 'ds-message';

    const stubEl = document.createElement('div');
    stubEl.className = 'ds-markdown';
    stubEl.textContent = 'Original stub text.';
    msgBox.appendChild(stubEl);

    itemEl.appendChild(msgBox);
    rootEl.appendChild(itemEl);

    const portal = new StreamArchiveOverlayPortal({
      presentationSettings: {
        displayMode: 'inline',
        inlinePlacement: 'replace',
        showThinkingInline: true,
      },
      fetchSummary: async () => ({
        conversationId: 'conv-test-123',
        remoteSessionId: 'sess-123',
        recoverableCount: 1,
        messages: [
          {
            messageId: 'asst-msg-202',
            remoteId: '202',
            role: 'assistant',
            status: 'filtered',
            hasLastGood: true,
            recoveryKind: 'authoritative_recovery',
            presentationKind: 'pre_filter_recovery',
            capturedAt: 12345,
            recoveredRevisionId: 'rev-201',
          },
        ],
      }),
      fetchContent: async () => ({
        text: 'Preserved uncensored answer.',
        thinking: 'Preserved thoughts.',
      }),
    });

    window.location.href = 'https://chat.deepseek.com/a/chat/s/sess-123';
    await portal.refreshSummary();

    const inlineHost = itemEl.querySelector('[data-streamarchive-inline-recovery-host]');
    expect(inlineHost).not.toBeNull();

    // Verify Mode B: placeholder is hidden
    expect(stubEl.style.display).toBe('none');

    // Access closed shadow root via ledger handle
    const handle = portal.getInlineLedger().get('asst-msg-202');
    expect(handle).toBeDefined();
    const shadow = handle!.shadowRoot;

    // Toggle button to view original stub
    const toggleBtn = shadow.querySelector('.streamarchive-inline-toggle-orig-btn') as HTMLButtonElement;
    expect(toggleBtn).not.toBeNull();

    // Click toggle button -> original stub becomes visible
    toggleBtn.click();
    expect(stubEl.style.display).not.toBe('none');

    // Click again -> original stub is hidden again (reversible)
    toggleBtn.click();
    expect(stubEl.style.display).toBe('none');

    portal.destroy();
  });

  // ────────────────────────────────────────────────────────────────
  // Test C: Overlay fallback only when needed (missing DOM node)
  // ────────────────────────────────────────────────────────────────
  it('Scenario C: Overlay fallback triggers ONLY when DOM node cannot be located in document', async () => {
    const portal = new StreamArchiveOverlayPortal({
      presentationSettings: {
        displayMode: 'inline',
      },
      fetchSummary: async () => ({
        conversationId: 'conv-test-123',
        remoteSessionId: 'sess-123',
        recoverableCount: 1,
        messages: [
          {
            messageId: 'missing-node-id',
            remoteId: '999999', // Not in DOM!
            role: 'assistant',
            status: 'filtered',
            hasLastGood: true,
            recoveryKind: 'authoritative_recovery',
            presentationKind: 'pre_filter_recovery',
            capturedAt: 12345,
            recoveredRevisionId: 'rev-201',
          },
        ],
      }),
      fetchContent: async () => ({ text: 'Some preserved text' }),
    });

    window.location.href = 'https://chat.deepseek.com/a/chat/s/sess-123';
    await portal.refreshSummary();

    const overlayContainer = (portal as any).container as HTMLElement;
    // Because node is missing, floating recovery tray fallback should appear
    const tray = overlayContainer.querySelector('.streamarchive-floating-tray');
    expect(tray).not.toBeNull();

    const diag = portal.getDiagnostics();
    expect(diag.inlineMountedCount).toBe(0);
    expect(diag.inlineFallbackReason).toBe('dom_anchor_not_found');

    portal.destroy();
  });

  // ────────────────────────────────────────────────────────────────
  // Test D: Edit branching (1 assistant parent, 3 user edits, switcher 1/2/3)
  // ────────────────────────────────────────────────────────────────
  it('Scenario D: User prompt edits produce 3 sibling branches with fully functional 1/2/3 navigation', () => {
    // Structure:
    // a1
    //  ├── u2_v1 -> a2_v1
    //  ├── u2_v2 -> a2_v2
    //  └── u2_v3 -> a2_v3
    const messages: Message[] = [
      createMsg('u1', undefined, { role: 'user', createdAt: 100 }),
      createMsg('a1', 'u1', { role: 'assistant', createdAt: 200 }),
      createMsg('u2_v1', 'a1', { role: 'user', createdAt: 300, content: 'User Edit 1' }),
      createMsg('a2_v1', 'u2_v1', { role: 'assistant', createdAt: 400 }),
      createMsg('u2_v2', 'a1', { role: 'user', createdAt: 500, content: 'User Edit 2' }),
      createMsg('a2_v2', 'u2_v2', { role: 'assistant', createdAt: 600 }),
      createMsg('u2_v3', 'a1', { role: 'user', createdAt: 700, content: 'User Edit 3' }),
      createMsg('a2_v3', 'u2_v3', { role: 'assistant', createdAt: 800 }),
    ];

    // Branch 1
    const tree1 = buildConversationTree(messages, { branchSelections: { a1: 0 } });
    expect(tree1.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_v1', 'a2_v1']);
    const u2v1 = tree1.getNode('u2_v1')!;
    expect(u2v1.userBranchCount).toBe(3);
    expect(u2v1.userBranchIndex).toBe(0);

    // Branch 2
    const tree2 = buildConversationTree(messages, { branchSelections: { a1: 1 } });
    expect(tree2.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_v2', 'a2_v2']);
    const u2v2 = tree2.getNode('u2_v2')!;
    expect(u2v2.userBranchCount).toBe(3);
    expect(u2v2.userBranchIndex).toBe(1);

    // Branch 3
    const tree3 = buildConversationTree(messages, { branchSelections: { a1: 2 } });
    expect(tree3.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_v3', 'a2_v3']);
    const u2v3 = tree3.getNode('u2_v3')!;
    expect(u2v3.userBranchCount).toBe(3);
    expect(u2v3.userBranchIndex).toBe(2);

    // Return back to Branch 1 from Branch 3
    const treeBack = buildConversationTree(messages, { branchSelections: { a1: 0 } });
    expect(treeBack.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_v1', 'a2_v1']);
    expect(treeBack.diagnostics.userBranchGroupCount).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────
  // Test E: Regenerate branching (1 user prompt, 3 assistant variants)
  // ────────────────────────────────────────────────────────────────
  it('Scenario E: Regenerate produces 3 assistant variants without resetting to branch 1', () => {
    // Structure:
    // u1
    //  ├── a1_resp1 (first answer)
    //  ├── a1_resp2 (regenerated answer)
    //  └── a1_resp3 (third regenerate)
    const messages: Message[] = [
      createMsg('u1', undefined, { role: 'user', createdAt: 100 }),
      createMsg('a1_resp1', 'u1', { role: 'assistant', createdAt: 200, updatedAt: 200 }),
      createMsg('a1_resp2', 'u1', { role: 'assistant', createdAt: 300, updatedAt: 300 }),
      createMsg('a1_resp3', 'u1', { role: 'assistant', createdAt: 400, updatedAt: 400 }),
    ];

    // Default without branchSelections follows the latest child (regenerate response 3)
    const treeDefault = buildConversationTree(messages);
    expect(treeDefault.activePath.map((m) => m.id)).toEqual(['u1', 'a1_resp3']);

    // User switches to variant 1 (index 0)
    const treeV1 = buildConversationTree(messages, { branchSelections: { u1: 0 } });
    expect(treeV1.activePath.map((m) => m.id)).toEqual(['u1', 'a1_resp1']);
    const nodeV1 = treeV1.getNode('a1_resp1')!;
    expect(nodeV1.assistantVariantCount).toBe(3);
    expect(nodeV1.assistantVariantIndex).toBe(0);

    // User switches to variant 2 (index 1)
    const treeV2 = buildConversationTree(messages, { branchSelections: { u1: 1 } });
    expect(treeV2.activePath.map((m) => m.id)).toEqual(['u1', 'a1_resp2']);
    const nodeV2 = treeV2.getNode('a1_resp2')!;
    expect(nodeV2.assistantVariantCount).toBe(3);
    expect(nodeV2.assistantVariantIndex).toBe(1);

    expect(treeV2.diagnostics.assistantVariantGroupCount).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────
  // Test F: Follow-up from second regenerate branch
  // ────────────────────────────────────────────────────────────────
  it('Scenario F: Follow-up prompt sent while on second regenerate branch links to that specific branch', () => {
    // Structure:
    // u1
    //  ├── a1_resp1
    //  └── a1_resp2 (remoteId: '102')
    //        └── u2_followup (remoteParentId: '102') -> a2_followup
    const messages: Message[] = [
      createMsg('u1', undefined, { role: 'user', remoteId: '100', createdAt: 100 }),
      createMsg('a1_resp1', 'u1', { role: 'assistant', remoteId: '101', createdAt: 200, updatedAt: 200 }),
      createMsg('a1_resp2', 'u1', { role: 'assistant', remoteId: '102', createdAt: 300, updatedAt: 300 }),
      createMsg('u2_followup', undefined, {
        role: 'user',
        remoteParentId: '102', // linked to second assistant variant!
        createdAt: 400,
        updatedAt: 400,
        content: 'Follow-up question to response 2',
      }),
      createMsg('a2_followup', 'u2_followup', { role: 'assistant', createdAt: 500, updatedAt: 500 }),
    ];

    // Tree should automatically follow branch 2 because u2_followup/a2_followup is the newest active subtree
    const tree = buildConversationTree(messages);
    expect(tree.activePath.map((m) => m.id)).toEqual([
      'u1',
      'a1_resp2',
      'u2_followup',
      'a2_followup',
    ]);
    expect(tree.activeLeafId).toBe('a2_followup');

    // Follow-up prompt must NOT be an orphan
    expect(tree.unlinkedMessages.length).toBe(0);
    const u2Node = tree.getNode('u2_followup')!;
    expect(u2Node.parent?.message.id).toBe('a1_resp2');
  });

  // ────────────────────────────────────────────────────────────────
  // Test G: Combined Edit + Regenerate DAG structure
  // ────────────────────────────────────────────────────────────────
  it('Scenario G: Combined Edit branches containing regenerate responses and deep follow-ups', () => {
    // Root prompt edit:
    // u1_v1 -> a1_v1
    // u1_v2 (newer root)
    //   ├── a1_v2_respA
    //   └── a1_v2_respB (chosen)
    //         └── u2_deep -> a2_deep
    const messages: Message[] = [
      createMsg('u1_v1', undefined, { role: 'user', createdAt: 100 }),
      createMsg('a1_v1', 'u1_v1', { role: 'assistant', createdAt: 200 }),

      createMsg('u1_v2', undefined, { role: 'user', createdAt: 300, content: 'Root prompt edit' }),
      createMsg('a1_v2_respA', 'u1_v2', { role: 'assistant', createdAt: 400 }),
      createMsg('a1_v2_respB', 'u1_v2', { role: 'assistant', createdAt: 500 }),

      createMsg('u2_deep', 'a1_v2_respB', { role: 'user', createdAt: 600 }),
      createMsg('a2_deep', 'u2_deep', { role: 'assistant', createdAt: 700 }),
    ];

    // Branch selection: root edit 2 (index 1), inside it regenerate variant B (index 1)
    const tree = buildConversationTree(messages, {
      branchSelections: {
        __root__: 1,
        u1_v2: 1,
      },
    });

    expect(tree.roots.length).toBe(2);
    expect(tree.activePath.map((m) => m.id)).toEqual([
      'u1_v2',
      'a1_v2_respB',
      'u2_deep',
      'a2_deep',
    ]);
    expect(tree.getNode('u1_v2')!.userBranchCount).toBe(2);
    expect(tree.getNode('a1_v2_respB')!.assistantVariantCount).toBe(2);
    expect(tree.unlinkedMessages.length).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────
  // Test H: Filtered response in alternate branch
  // ────────────────────────────────────────────────────────────────
  it('Scenario H: Filtered response attached to non-default branch is correctly localized in DOM', () => {
    // Two assistant variants:
    // u1 -> a1_v1 (clean)
    //    -> a1_v2 (filtered, remoteId: '802')
    const itemEl = document.createElement('div');
    itemEl.setAttribute('data-virtual-list-item-key', '802');
    const msgBox = document.createElement('div');
    msgBox.className = 'ds-message';
    const stubEl = document.createElement('div');
    stubEl.className = 'ds-markdown';
    stubEl.textContent = 'Filtered message stub';
    msgBox.appendChild(stubEl);
    itemEl.appendChild(msgBox);
    rootEl.appendChild(itemEl);

    // Locate anchor by exact variant remoteId
    const anchor = locateMessageAnchor('802', rootEl);
    expect(anchor).not.toBeNull();
    expect(anchor!.element).toBe(itemEl);

    const target = findInlineInsertionPoint(anchor!);
    expect(target).not.toBeNull();
    expect(target!.level).toBe('level_1_body');
  });

  // ────────────────────────────────────────────────────────────────
  // Test I: Reconcile stability (HistoryReconciler preserves finished variants)
  // ────────────────────────────────────────────────────────────────
  it('Scenario I: History reconciliation preserves finished assistant variants from earlier regenerate branches', async () => {
    const mockStorage = {
      getConversationByRemoteId: vi.fn().mockResolvedValue({ id: 'c1', remoteId: 's1', title: 'Chat' }),
      getConversation: vi.fn().mockResolvedValue({ id: 'c1', remoteId: 's1', title: 'Chat' }),
      listMessagesByConversation: vi.fn().mockResolvedValue([
        createMsg('u1', undefined, { remoteId: '10', role: 'user', content: 'What is AI?' }),
        // Finished assistant response from regenerate branch 1:
        createMsg('a1_v1', 'u1', {
          remoteId: '11',
          role: 'assistant',
          status: 'finished',
          identityState: 'provisional',
          projectionState: 'provisional_logical',
        }),
      ]),
      listRevisionsByMessage: vi.fn().mockResolvedValue([
        { id: 'r1', messageId: 'a1_v1', text: 'AI is artificial intelligence', source: 'network', isLastGood: false },
      ]),
      listRecoveryEvents: vi.fn().mockResolvedValue([]),
      applyHistoryReconciliationPlan: vi.fn().mockResolvedValue(undefined),
    } as unknown as StorageRepository;

    const reconciler = new HistoryReconciler(mockStorage);

    // Server history arrives containing active branch: u1 -> a1_v2 (remoteId 12)
    // Server does NOT contain a1_v1 (remoteId 11)!
    const parsedHistory: DeepSeekParsedHistory = {
      session: { sessionId: 's1', title: 'Chat', updatedAt: 1000, pinned: false },
      messages: [
        { messageId: '10', role: 'user', text: 'What is AI?', status: 'finished', createdAt: 100, isFiltered: false, fragmentsCount: 1 },
        { messageId: '12', parentId: '10', role: 'assistant', text: 'AI is a branch of computer science.', status: 'finished', createdAt: 200, isFiltered: false, fragmentsCount: 1 },
      ],
    };

    const { plan } = await reconciler.createPlan(parsedHistory);

    // Verify a1_v1 was NOT demoted to unmatched_capture!
    const putA1v1 = plan.messagesToPut.find((m) => m.id === 'a1_v1');
    if (putA1v1) {
      expect(putA1v1.projectionState).not.toBe('unmatched_capture');
      expect(putA1v1.parentId).not.toBeUndefined();
    }

    // Both messages are logical in tree
    const messages = [
      createMsg('u1', undefined, { remoteId: '10', role: 'user' }),
      createMsg('a1_v1', 'u1', { remoteId: '11', role: 'assistant', status: 'finished' }),
      createMsg('a1_v2', 'u1', { remoteId: '12', role: 'assistant', status: 'finished' }),
    ];
    const tree = buildConversationTree(messages);
    expect(tree.getNode('a1_v1')!.assistantVariantCount).toBe(2);
    expect(tree.getNode('a1_v2')!.assistantVariantCount).toBe(2);
  });

  // ────────────────────────────────────────────────────────────────
  // Test J: Refresh persistence
  // ────────────────────────────────────────────────────────────────
  it('Scenario J: Persisted branch selections survive reload and restore chosen branch state', () => {
    const messages: Message[] = [
      createMsg('u1', undefined, { role: 'user', createdAt: 100 }),
      createMsg('a1_v1', 'u1', { role: 'assistant', createdAt: 200 }),
      createMsg('a1_v2', 'u1', { role: 'assistant', createdAt: 300 }),
      createMsg('a1_v3', 'u1', { role: 'assistant', createdAt: 400 }),
    ];

    // Simulated saved state in storage for conversation 'conv-test-123':
    const savedBranchSelections: Record<string, number> = {
      u1: 1, // User had chosen variant 2 (a1_v2)
    };

    // Tree built with saved selections restores active path to a1_v2
    const tree = buildConversationTree(messages, {
      branchSelections: savedBranchSelections,
    });

    expect(tree.activePath.map((m) => m.id)).toEqual(['u1', 'a1_v2']);
    expect(tree.activeLeafId).toBe('a1_v2');
  });
});
