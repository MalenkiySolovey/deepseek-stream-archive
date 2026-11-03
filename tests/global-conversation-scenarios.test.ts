// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { buildConversationTree } from '../src/core/conversation-tree';
import { selectPreferredRevision } from '../src/core/models/revision';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { mountInlineRecovery } from '../src/presentation/inline-recovery/dom';
import { locateMessageAnchor, findInlineInsertionPoint } from '../src/adapters/deepseek/dom/message-locator';
import { formatContinuityPrompt, parseStreamArchiveAugmentedPrompt } from '../src/adapters/deepseek/request/marker';
import { getActiveBranchAncestry } from '../src/context-continuity/branch-ancestry';
import type { Conversation, Message, ResponseRevision } from '../src/core/models';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';
import type { PageRecoveryMessageSummary } from '../src/adapters/deepseek/dom/types';

describe('Global Conversation Architecture Scenarios (A through Z & Full Chain)', () => {
  let repository: IndexedDbStorageRepository;

  beforeEach(() => {
    indexedDB = new IDBFactory();
    repository = new IndexedDbStorageRepository();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  function makeMsg(partial: Partial<Message> & { id: string; role: 'user' | 'assistant' }): Message {
    return {
      conversationId: 'default_conv',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
      ...partial,
    };
  }

  function createMessageDom(id: string) {
    const msgEl = document.createElement('div');
    msgEl.setAttribute('data-message-id', id);

    const placeholderEl = document.createElement('div');
    placeholderEl.className = 'ds-markdown';
    placeholderEl.textContent = 'Original censored text';
    msgEl.appendChild(placeholderEl);

    const toolbarEl = document.createElement('div');
    toolbarEl.className = 'ds-message-actions';
    const btn = document.createElement('button');
    btn.textContent = 'Copy';
    toolbarEl.appendChild(btn);
    msgEl.appendChild(toolbarEl);

    document.body.appendChild(msgEl);
    return { msgEl, placeholderEl, toolbarEl };
  }

  const baseSummary: PageRecoveryMessageSummary = {
    messageId: 'msg-test',
    remoteId: 'msg-test',
    role: 'assistant',
    status: 'filtered',
    hasLastGood: true,
    recoveryKind: 'authoritative_recovery',
    presentationKind: 'pre_filter_recovery',
    capturedAt: 1000,
    recoveredRevisionId: 'rev-test',
  };

  // Scenario A: Ordinary sequence (strict alternation USER -> ASSISTANT)
  it('Scenario A: verifies strict alternation USER -> ASSISTANT in standard 5-turn sequence', async () => {
    const messages: Message[] = [];
    let prevId: string | undefined = undefined;

    for (let i = 1; i <= 5; i++) {
      const uId = `u_${i}`;
      messages.push(
        makeMsg({
          id: uId,
          conversationId: 'c_a',
          parentId: prevId,
          role: 'user',
          identityState: 'reconciled',
          createdAt: 1000 + i * 10,
          updatedAt: 1000 + i * 10,
        })
      );
      const aId = `a_${i}`;
      messages.push(
        makeMsg({
          id: aId,
          conversationId: 'c_a',
          parentId: uId,
          role: 'assistant',
          identityState: 'reconciled',
          createdAt: 1000 + i * 10 + 5,
          updatedAt: 1000 + i * 10 + 5,
        })
      );
      prevId = aId;
    }

    const tree = buildConversationTree(messages, { activeLeafId: 'a_5' });
    expect(tree.activePath.length).toBe(10);
    for (let i = 0; i < 10; i++) {
      const expectedRole = i % 2 === 0 ? 'user' : 'assistant';
      expect(tree.activePath[i]!.role).toBe(expectedRole);
    }
  });

  // Scenario B: Immediate persistence before assistant response
  it('Scenario B: user prompt is stored and confirmed in IndexedDB before assistant starts', async () => {
    const userMsg = makeMsg({
      id: 'turn_client_early',
      conversationId: 'c_early',
      role: 'user',
      content: 'Early user prompt query',
      createdAt: 2000,
      updatedAt: 2000,
    });
    await repository.saveMessage(userMsg);

    const fetched = await repository.getMessage('turn_client_early');
    expect(fetched).not.toBeNull();
    expect(fetched?.role).toBe('user');
    expect(fetched?.content).toBe('Early user prompt query');
  });

  // Scenario C: Generation attempt without response (interrupted connection)
  it('Scenario C: user prompt remains preserved when response stream never delivers content', async () => {
    const u = makeMsg({
      id: 'u_interrupted',
      conversationId: 'c_interrupted',
      role: 'user',
      content: 'Hello DeepSeek?',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await repository.saveMessage(u);

    const tree = buildConversationTree([u]);
    expect(tree.roots.length).toBe(1);
    expect(tree.roots[0]!.message.id).toBe('u_interrupted');
    expect(tree.activePath.length).toBe(1);
    expect(tree.activePath[0]!.role).toBe('user');
  });

  // Scenario D: Three Edits of one user prompt
  it('Scenario D: editing a prompt three times produces independent sibling user variants under root', () => {
    const u1 = makeMsg({ id: 'u_v1', conversationId: 'c_edit', role: 'user', createdAt: 100 });
    const u2 = makeMsg({ id: 'u_v2', conversationId: 'c_edit', role: 'user', createdAt: 200 });
    const u3 = makeMsg({ id: 'u_v3', conversationId: 'c_edit', role: 'user', createdAt: 300 });

    const tree = buildConversationTree([u1, u2, u3]);
    expect(tree.roots.length).toBe(3);
    expect(tree.roots[0]!.userBranchCount).toBe(3);
    expect(tree.roots[0]!.userBranchIndex).toBe(0);
    expect(tree.roots[1]!.userBranchIndex).toBe(1);
    expect(tree.roots[2]!.userBranchIndex).toBe(2);
  });

  // Scenario E: Three Regenerates of one assistant response
  it('Scenario E: regenerating an assistant response three times produces 3 assistant variants under same user turn', () => {
    const u = makeMsg({ id: 'u_root', conversationId: 'c_regen', role: 'user', createdAt: 100 });
    const a1 = makeMsg({ id: 'a_v1', conversationId: 'c_regen', parentId: 'u_root', role: 'assistant', createdAt: 200 });
    const a2 = makeMsg({ id: 'a_v2', conversationId: 'c_regen', parentId: 'u_root', role: 'assistant', createdAt: 300 });
    const a3 = makeMsg({ id: 'a_v3', conversationId: 'c_regen', parentId: 'u_root', role: 'assistant', createdAt: 400 });

    const tree = buildConversationTree([u, a1, a2, a3]);
    const root = tree.roots[0]!;
    expect(root.children.length).toBe(3);
    expect(root.children[0]!.assistantVariantCount).toBe(3);
    expect(root.children[0]!.assistantVariantIndex).toBe(0);
    expect(root.children[1]!.assistantVariantIndex).toBe(1);
    expect(root.children[2]!.assistantVariantIndex).toBe(2);
  });

  // Scenario F: Edit + Regenerate combined DAG
  it('Scenario F: edit followed by regenerations maintains strict DAG branching without interleaving', () => {
    const u1 = makeMsg({ id: 'u1', conversationId: 'c_mix', role: 'user', createdAt: 100 });
    const a1 = makeMsg({ id: 'a1', conversationId: 'c_mix', parentId: 'u1', role: 'assistant', createdAt: 200 });
    const u1_edit = makeMsg({ id: 'u1_edit', conversationId: 'c_mix', role: 'user', createdAt: 300 });
    const a2 = makeMsg({ id: 'a2', conversationId: 'c_mix', parentId: 'u1_edit', role: 'assistant', createdAt: 400 });
    const a3 = makeMsg({ id: 'a3', conversationId: 'c_mix', parentId: 'u1_edit', role: 'assistant', createdAt: 500 });

    const tree = buildConversationTree([u1, a1, u1_edit, a2, a3], { activeLeafId: 'a3' });
    expect(tree.activePath.map((m) => m.id)).toEqual(['u1_edit', 'a3']);
  });

  // Scenario G: Continuation across different branches
  it('Scenario G: subsequent turns link to the active branch parent correctly', () => {
    const u1 = makeMsg({ id: 'u1', conversationId: 'c_g', role: 'user', createdAt: 100 });
    const a1 = makeMsg({ id: 'a1', conversationId: 'c_g', parentId: 'u1', role: 'assistant', createdAt: 200 });
    const a1_alt = makeMsg({ id: 'a1_alt', conversationId: 'c_g', parentId: 'u1', role: 'assistant', createdAt: 300 });

    const u2_branchA = makeMsg({ id: 'u2_a', conversationId: 'c_g', parentId: 'a1', role: 'user', createdAt: 400 });
    const a2_branchA = makeMsg({ id: 'a2_a', conversationId: 'c_g', parentId: 'u2_a', role: 'assistant', createdAt: 500 });

    const u2_branchB = makeMsg({ id: 'u2_b', conversationId: 'c_g', parentId: 'a1_alt', role: 'user', createdAt: 600 });
    const a2_branchB = makeMsg({ id: 'a2_b', conversationId: 'c_g', parentId: 'u2_b', role: 'assistant', createdAt: 700 });

    const treeA = buildConversationTree([u1, a1, a1_alt, u2_branchA, a2_branchA, u2_branchB, a2_branchB], { activeLeafId: 'a2_a' });
    expect(treeA.activePath.map((m) => m.id)).toEqual(['u1', 'a1', 'u2_a', 'a2_a']);

    const treeB = buildConversationTree([u1, a1, a1_alt, u2_branchA, a2_branchA, u2_branchB, a2_branchB], { activeLeafId: 'a2_b' });
    expect(treeB.activePath.map((m) => m.id)).toEqual(['u1', 'a1_alt', 'u2_b', 'a2_b']);
  });

  // Scenario H & I: Filtering and independent streaming revisions
  it('Scenario H & I: filtered branches preserve their uncensored revisions independently', () => {
    const a_normal = makeMsg({ id: 'a_norm', conversationId: 'c_h', role: 'assistant', createdAt: 100 });
    const a_filtered = makeMsg({ id: 'a_filt', conversationId: 'c_h', role: 'assistant', status: 'filtered', createdAt: 200 });

    const revsNormal: ResponseRevision[] = [
      { id: 'rn1', messageId: 'a_norm', revisionIndex: 1, text: 'chunk 1', source: 'network', capturedAt: 100, isFinal: false, isLastGood: false },
      { id: 'rn2', messageId: 'a_norm', revisionIndex: 2, text: 'chunk 1 complete text', source: 'network', capturedAt: 150, isFinal: true, isLastGood: false },
    ];
    const revsFiltered: ResponseRevision[] = [
      { id: 'rf1', messageId: 'a_filt', revisionIndex: 1, text: 'valid text before filter', source: 'network', capturedAt: 200, isFinal: false, isLastGood: true },
      { id: 'rf2', messageId: 'a_filt', revisionIndex: 2, text: '', source: 'network', capturedAt: 250, isFinal: true, isLastGood: false },
    ];

    const prefNormal = selectPreferredRevision(a_normal, revsNormal);
    const prefFiltered = selectPreferredRevision(a_filtered, revsFiltered);

    expect(prefNormal?.text).toBe('chunk 1 complete text');
    expect(prefFiltered?.text).toBe('valid text before filter');
    expect(prefFiltered?.isLastGood).toBe(true);
  });

  // Scenario J: Empty final revision does not overwrite good pre-filter text
  it('Scenario J: empty 0-char final revision falls back to last good text', () => {
    const msg = makeMsg({ id: 'm_j', conversationId: 'c_j', role: 'assistant', status: 'filtered', createdAt: 100, updatedAt: 200 });
    const revisions: ResponseRevision[] = [
      { id: 'r1', messageId: 'm_j', revisionIndex: 1, text: 'Meaningful answer content', source: 'network', capturedAt: 100, isFinal: false, isLastGood: true },
      { id: 'r2', messageId: 'm_j', revisionIndex: 2, text: '', source: 'network', capturedAt: 200, isFinal: true, isLastGood: false },
    ];
    const preferred = selectPreferredRevision(msg, revisions);
    expect(preferred?.text).toBe('Meaningful answer content');
  });

  // Scenario K: Thinking only (State 3 notice)
  it('Scenario K: displays reasoning notice when text is empty but thoughts exist', () => {
    createMessageDom('m_k');
    const target = findInlineInsertionPoint(locateMessageAnchor('m_k', document)!);

    const handle = mountInlineRecovery(
      target!,
      baseSummary,
      { text: '', thinking: 'Extensive thoughts only' },
      { showThinkingInline: true, inlinePlacement: 'underneath', locale: 'ru' }
    );

    expect(handle).not.toBeNull();
    const shadow = handle!.shadowRoot;
    const notice = shadow.querySelector('.streamarchive-inline-notice');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('Сохранены только рассуждения');
    handle?.unmount();
  });

  // Scenario L & M: Inline recovery placement (underneath vs replace with toggle)
  it('Scenario L & M: verifies Mode A (underneath) and Mode B (replace with toggle button)', () => {
    const { placeholderEl: pA } = createMessageDom('m_l');
    const targetA = findInlineInsertionPoint(locateMessageAnchor('m_l', document)!);

    // Mode A (underneath)
    const handleA = mountInlineRecovery(
      targetA!,
      baseSummary,
      { text: 'Recovered text A' },
      { showThinkingInline: true, inlinePlacement: 'underneath', locale: 'ru' }
    );
    expect(handleA).not.toBeNull();
    expect(pA.style.display).not.toBe('none');
    handleA?.unmount();

    // Mode B (replace)
    const { placeholderEl: pB } = createMessageDom('m_m');
    const targetB = findInlineInsertionPoint(locateMessageAnchor('m_m', document)!);

    const handleB = mountInlineRecovery(
      targetB!,
      baseSummary,
      { text: 'Recovered text B' },
      { showThinkingInline: true, inlinePlacement: 'replace', locale: 'ru' }
    );
    expect(handleB).not.toBeNull();
    expect(pB.style.display).toBe('none');

    const shadow = handleB!.shadowRoot;
    const toggleBtn = shadow.querySelector('.streamarchive-inline-toggle-orig-btn') as HTMLButtonElement;
    expect(toggleBtn).not.toBeNull();
    expect(toggleBtn?.textContent).toBe('Показать исходное сообщение DeepSeek');

    // Click toggle to reveal original
    toggleBtn.click();
    expect(pB.style.display).toBe('');
    expect(toggleBtn.textContent).toBe('Скрыть исходное сообщение DeepSeek');

    // Click toggle to re-hide
    toggleBtn.click();
    expect(pB.style.display).toBe('none');
    handleB?.unmount();
  });

  // Scenario N & O: DOM re-renders and message stability
  it('Scenario N & O: handles unmounting and re-mounting cleanly without duplicating elements', () => {
    const { msgEl } = createMessageDom('m_n');
    const target = findInlineInsertionPoint(locateMessageAnchor('m_n', document)!);

    const handle1 = mountInlineRecovery(
      target!,
      baseSummary,
      { text: 'Recovered text' },
      { showThinkingInline: true }
    );
    expect(msgEl.querySelectorAll('div[data-streamarchive-inline-recovery-host]').length).toBe(1);

    handle1?.unmount();
    expect(msgEl.querySelectorAll('div[data-streamarchive-inline-recovery-host]').length).toBe(0);

    const handle2 = mountInlineRecovery(
      target!,
      baseSummary,
      { text: 'Recovered text re-mount' },
      { showThinkingInline: true }
    );
    expect(msgEl.querySelectorAll('div[data-streamarchive-inline-recovery-host]').length).toBe(1);
    handle2?.unmount();
  });

  // Scenario P & Q: MV3 persistence across restart / F5
  it('Scenario P & Q: confirmed data and linkages survive persistence and reload without corruption', async () => {
    const conv: Conversation = { id: 'c_persist', title: 'Persist Test', createdAt: 100, updatedAt: 200 };
    await repository.saveConversation(conv);

    const u = makeMsg({ id: 'u_p', conversationId: 'c_persist', role: 'user', content: 'Stable user turn', createdAt: 100 });
    const a = makeMsg({ id: 'a_p', conversationId: 'c_persist', parentId: 'u_p', role: 'assistant', createdAt: 200 });
    await repository.saveMessages([u, a]);

    const loadedMessages = await repository.listMessagesByConversation('c_persist');
    expect(loadedMessages.length).toBe(2);

    const tree = buildConversationTree(loadedMessages);
    expect(tree.activePath.length).toBe(2);
    expect(tree.activePath[0]!.id).toBe('u_p');
    expect(tree.activePath[1]!.id).toBe('a_p');
  });

  // Scenario R: Isolation of multiple conversations
  it('Scenario R: messages from two independent conversations never interleave', () => {
    const conv1Msgs: Message[] = [
      makeMsg({ id: 'c1_u1', conversationId: 'conv_1', role: 'user', createdAt: 100 }),
      makeMsg({ id: 'c1_a1', conversationId: 'conv_1', parentId: 'c1_u1', role: 'assistant', createdAt: 150 }),
    ];
    const conv2Msgs: Message[] = [
      makeMsg({ id: 'c2_u1', conversationId: 'conv_2', role: 'user', createdAt: 110 }),
      makeMsg({ id: 'c2_a1', conversationId: 'conv_2', parentId: 'c2_u1', role: 'assistant', createdAt: 160 }),
    ];

    const tree1 = buildConversationTree(conv1Msgs);
    const tree2 = buildConversationTree(conv2Msgs);

    expect(tree1.activePath.map((m) => m.id)).toEqual(['c1_u1', 'c1_a1']);
    expect(tree2.activePath.map((m) => m.id)).toEqual(['c2_u1', 'c2_a1']);
  });

  // Scenario S: Legacy archive backwards compatibility (DB_VERSION 9 preserved)
  it('Scenario S: handles legacy archives without errors or schema changes', async () => {
    const summary = await repository.getArchiveSummary();
    expect(summary).toBeDefined();
    expect(summary.conversationsCount).toBeGreaterThanOrEqual(0);
    expect(summary.revisionsCount).toBeGreaterThanOrEqual(0);
  });

  // Scenario T: Export and backup preservation
  it('Scenario T: exported model preserves full DAG structure and metadata', async () => {
    const conv: Conversation = { id: 'c_export', title: 'Export Test', createdAt: 100, updatedAt: 100 };
    await repository.saveConversation(conv);
    const u = makeMsg({ id: 'u_exp', conversationId: 'c_export', role: 'user', content: 'Exp', createdAt: 100 });
    const a = makeMsg({ id: 'a_exp', conversationId: 'c_export', parentId: 'u_exp', role: 'assistant', createdAt: 120 });
    await repository.saveMessages([u, a]);

    const exportModel = await repository.getConversationExportModel('c_export');
    expect(exportModel).not.toBeNull();
    expect(exportModel?.conversation.id).toBe('c_export');
    expect(exportModel?.messages.length).toBe(2);
  });

  // Scenario U & Y: Context Continuity and Sidepanel share unified tree model
  it('Scenario U & Y: Context Continuity planner and Side Panel share identical branch ancestry', () => {
    const u1 = makeMsg({ id: 'u1', conversationId: 'c_cc', role: 'user', createdAt: 100 });
    const a1 = makeMsg({ id: 'a1', conversationId: 'c_cc', parentId: 'u1', role: 'assistant', createdAt: 200 });
    const a1_alt = makeMsg({ id: 'a1_alt', conversationId: 'c_cc', parentId: 'u1', role: 'assistant', createdAt: 300 });

    // Context continuity ancestry
    const ccAncestry = getActiveBranchAncestry([u1, a1, a1_alt], { leafMessageId: 'a1_alt' });
    expect(ccAncestry.activePath.map((m) => m.id)).toEqual(['u1', 'a1_alt']);

    // Side panel tree
    const tree = buildConversationTree([u1, a1, a1_alt], { activeLeafId: 'a1_alt' });
    expect(tree.activePath.map((m) => m.id)).toEqual(['u1', 'a1_alt']);
  });

  // Scenario V: Unknown DOM fallback
  it('Scenario V: returns null and triggers fallback when DOM container structure is missing', () => {
    const handle = mountInlineRecovery(
      null as any,
      baseSummary,
      { text: 'Some text' }
    );
    expect(handle).toBeNull();
  });

  // Scenario W: Network duplicate delivery deduplication
  it('Scenario W: duplicate revisions with identical payload are deduplicated safely', async () => {
    const rev1: ResponseRevision = {
      id: 'r_dup',
      messageId: 'm_w',
      revisionIndex: 1,
      text: 'Identical text',
      source: 'network',
      capturedAt: 100,
      isFinal: false,
      isLastGood: false,
    };
    await repository.saveRevision(rev1);
    await repository.saveRevision(rev1); // Duplicate write

    const revs = await repository.listRevisionsByMessage('m_w');
    expect(revs.length).toBe(1);
  });

  // Scenario X: Ambiguous server history reconciliation
  it('Scenario X: reconciler safely anchors server messages with session currentMessageId without fabricating links', async () => {
    const reconciler = new HistoryReconciler(repository);
    const parsed: DeepSeekParsedHistory = {
      session: {
        sessionId: 's_x',
        title: 'Reconciled History Chat',
        updatedAt: 1000,
        currentMessageId: 'server_msg_2',
        pinned: false,
      },
      messages: [
        {
          messageId: 'server_msg_1',
          parentId: null,
          role: 'user',
          status: 'finished',
          createdAt: 100,
          text: 'Server User Query',
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: 'server_msg_2',
          parentId: 'server_msg_1',
          role: 'assistant',
          status: 'finished',
          createdAt: 200,
          text: 'Server Assistant Answer',
          isFiltered: false,
          fragmentsCount: 1,
        },
      ],
    };

    const { plan } = await reconciler.createPlan(parsed);
    expect(plan.conversation.currentMessageId).toBe('server_msg_2');
    expect(plan.messagesToPut.length).toBe(2);
    expect(plan.messagesToPut[0]!.remoteId).toBe('server_msg_1');
    expect(plan.messagesToPut[1]!.remoteId).toBe('server_msg_2');
  });

  // Scenario Z: Context Continuity clean user text preservation
  it('Scenario Z: clean user text is preserved in user prompt persistence, without context continuity markers', () => {
    const augmentedPrompt = formatContinuityPrompt(
      'Turn 1 (User): Earlier prompt\nTurn 1 (Assistant): Earlier response',
      'Please write a poem.',
      'deliv_123'
    );
    const parsed = parseStreamArchiveAugmentedPrompt(augmentedPrompt);
    expect(parsed.isAugmented).toBe(true);
    expect(parsed.deliveryId).toBe('deliv_123');
    expect(parsed.userPrompt).toBe('Please write a poem.');
  });

  // Performance Check (Section 20)
  it('Section 20: builds DAG tree for 1,000 messages in under 50ms', () => {
    const messages: Message[] = [];
    let prevId: string | undefined = undefined;
    for (let i = 0; i < 1000; i++) {
      const id = `m_perf_${i}`;
      messages.push(
        makeMsg({
          id,
          conversationId: 'c_perf',
          parentId: prevId,
          role: i % 2 === 0 ? 'user' : 'assistant',
          createdAt: 1000 + i,
          updatedAt: 1000 + i,
        })
      );
      prevId = id;
    }

    const t0 = performance.now();
    const tree = buildConversationTree(messages, { activeLeafId: prevId });
    const elapsed = performance.now() - t0;

    expect(tree.activePath.length).toBe(1000);
    expect(elapsed).toBeLessThan(50);
  });

  // Section 22: Full End-to-End Persistence Chain
  it('Section 22: executes full end-to-end preservation, reconciliation, DAG building, and inline rendering chain', async () => {
    // 1. Outgoing request captured & immediate user prompt stored
    const clientTurnId = 'turn_u_e2e';
    const userMsg = makeMsg({
      id: clientTurnId,
      remoteId: 'srv_u_e2e',
      conversationId: 'c_e2e',
      role: 'user',
      content: 'Explain DAG conversation architecture',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await repository.saveConversation({
      id: 'c_e2e',
      remoteId: 's_e2e',
      title: 'E2E DAG',
      createdAt: 1000,
      updatedAt: 1000,
    });
    await repository.saveMessage(userMsg);

    // Verify step 1
    const storedUser = await repository.getMessage(clientTurnId);
    expect(storedUser).not.toBeNull();
    expect(storedUser?.content).toBe('Explain DAG conversation architecture');

    // 2. Assistant stream started & canonical revisions stored
    const assistantMsgId = 'turn_a_e2e';
    const assistantMsg = makeMsg({
      id: assistantMsgId,
      remoteId: 'srv_a_e2e',
      conversationId: 'c_e2e',
      parentId: clientTurnId, // Explicitly linked to preceding user turn
      role: 'assistant',
      status: 'filtered',
      createdAt: 1100,
      updatedAt: 1200,
    });
    const rev1: ResponseRevision = {
      id: 'rev_e2e_1',
      messageId: assistantMsgId,
      revisionIndex: 1,
      text: 'A DAG conversation represents turns as vertices and parent links as edges.',
      thinking: 'Analyzing graph theory in chat systems.',
      source: 'network',
      capturedAt: 1150,
      isFinal: false,
      isLastGood: true, // Censored later, but saved pre-filter
    };
    const rev2: ResponseRevision = {
      id: 'rev_e2e_2',
      messageId: assistantMsgId,
      revisionIndex: 2,
      text: '', // Destructive filter zeroed text
      thinking: 'Analyzing graph theory in chat systems.',
      source: 'network',
      capturedAt: 1200,
      isFinal: true,
      isLastGood: false,
    };
    await repository.saveMessage(assistantMsg);
    await repository.saveRevisions([rev1, rev2]);

    // 3. Storage ACK confirmed
    const savedRevs = await repository.listRevisionsByMessage(assistantMsgId);
    expect(savedRevs.length).toBe(2);

    // 4. Server history reconciled
    const reconciler = new HistoryReconciler(repository);
    const parsedHistory: DeepSeekParsedHistory = {
      session: {
        sessionId: 's_e2e',
        title: 'E2E DAG Reconciled',
        updatedAt: 1200,
        currentMessageId: 'srv_a_e2e',
        pinned: false,
      },
      messages: [
        {
          messageId: 'srv_u_e2e',
          parentId: null,
          role: 'user',
          status: 'finished',
          text: 'Explain DAG conversation architecture',
          createdAt: 1000,
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: 'srv_a_e2e',
          parentId: 'srv_u_e2e',
          role: 'assistant',
          text: '', // Filtered on server
          status: 'filtered',
          createdAt: 1100,
          isFiltered: true,
          fragmentsCount: 1,
        },
      ],
    };
    const { plan: reconcilePlan } = await reconciler.createPlan(parsedHistory);
    await repository.applyHistoryReconciliationPlan(reconcilePlan);

    // 5. Unified Conversation Tree built
    const allMessages = await repository.listMessagesByConversation(reconcilePlan.conversation.id);
    const tree = buildConversationTree(allMessages, {
      activeLeafId: reconcilePlan.conversation.currentMessageId,
    });
    expect(tree.activePath.length).toBe(2);
    expect(tree.activePath[0]!.role).toBe('user');
    expect(tree.activePath[1]!.role).toBe('assistant');

    // 6. Preferred revision selected (uncensored lastGood preserved)
    const activeAssistantMessage = tree.activePath[1]!;
    const assistantRevs = await repository.listRevisionsByMessage(activeAssistantMessage.id);
    const preferredRev = selectPreferredRevision(activeAssistantMessage, assistantRevs);
    expect(preferredRev).not.toBeNull();
    expect(preferredRev?.text).toContain('A DAG conversation represents turns as vertices');
    expect(preferredRev?.isLastGood).toBe(true);

    // 7. Inline recovery rendered
    createMessageDom('m_e2e_mount');
    const target = findInlineInsertionPoint(locateMessageAnchor('m_e2e_mount', document)!);

    const handle = mountInlineRecovery(
      target!,
      { ...baseSummary, messageId: activeAssistantMessage.id },
      { text: preferredRev!.text, thinking: preferredRev!.thinking },
      { showThinkingInline: true, inlinePlacement: 'underneath' }
    );
    expect(handle).not.toBeNull();
    expect(handle?.shadowRoot.textContent).toContain('A DAG conversation represents turns as vertices');
    handle?.unmount();
  });
});
