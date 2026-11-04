// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import type { Message, ResponseRevision, RecoveryEvent, Conversation } from '../src/core/models';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';
import { locateMessageAnchor } from '../src/adapters/deepseek/dom/message-locator';

describe('Critical Defect 1: Identity, Regenerate, Edit, and Filtered Recovery Integrity', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    (globalThis as any).IDBKeyRange = IDBKeyRange;
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
    document.body.innerHTML = '';
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Mandatory Scenario 1: One prompt, two Regenerates; ONLY second is filtered
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 1: One user prompt, two Regenerate responses; only second filtered -> recovery only on 2nd', async () => {
    const conv: Conversation = {
      id: 'conv-sc1',
      remoteId: 'remote-sess-1',
      title: 'Regenerate Filter Test 1',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const userMsg: Message = {
      id: 'u1',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Explain nuclear chemistry.',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(userMsg);

    // Assistant branch 1: normal response
    const a1: Message = {
      id: 'a1',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Nuclear chemistry studies radioactivity and nuclear processes.',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await storageRepo.saveMessage(a1);

    // Assistant branch 2: regenerated and filtered
    const a2: Message = {
      id: 'a2',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Here is sensitive pre-filter uncensored chemistry text.',
      createdAt: 1200,
      updatedAt: 1200,
    };
    await storageRepo.saveMessage(a2);

    await storageRepo.saveRevision({
      id: 'rev-a2-lastgood',
      messageId: a2.id,
      revisionIndex: 1,
      text: a2.content!,
      source: 'network',
      capturedAt: 1200,
      isFinal: false,
      isLastGood: true,
    });

    await storageRepo.saveRecoveryEvent({
      id: 'rec-a2',
      messageId: a2.id,
      kind: 'content_filter',
      detectedAt: 1200,
      recoveredRevisionId: 'rev-a2-lastgood',
      reason: 'CONTENT_FILTER',
    });

    // Server history arrives:
    // hm1 is normal branch 1; hm2 is filtered placeholder for branch 2
    const parsedHistory: DeepSeekParsedHistory = ({
      session: {
        sessionId: 'remote-sess-1',
        title: 'Regenerate Filter Test 1',
      },
      messages: [
        {
          messageId: 'remote-u1',
          role: 'user',
          text: 'Explain nuclear chemistry.',
          status: 'finished',
          isFiltered: false,
        },
        {
          messageId: 'remote-a1',
          parentId: 'remote-u1',
          role: 'assistant',
          text: 'Nuclear chemistry studies radioactivity and nuclear processes.',
          status: 'finished',
          isFiltered: false,
        },
        {
          messageId: 'remote-a2',
          parentId: 'remote-u1',
          role: 'assistant',
          text: "Sorry, that's beyond my current scope.",
          status: 'filtered',
          isFiltered: true,
        },
      ],
    } as any);

    const reconciler = new HistoryReconciler(storageRepo);
    const result = await reconciler.reconcile(parsedHistory);

    // Check recovered metadata
    const recoverySummaries = await storageRepo.getRecoveryMetadataForConversation(conv.id);
    expect(recoverySummaries.length).toBe(1);

    const rec = recoverySummaries[0]!;
    expect(rec.messageId).toBe('a2');
    // a2 must have remoteId = 'remote-a2' (the filtered server message)
    expect(rec.remoteId).toBe('remote-a2');
    // CRITICAL: a2 must NOT have remote-a1 (the normal message)!
    expect(rec.remoteId).not.toBe('remote-a1');

    const msgA1 = await storageRepo.getMessage('a1');
    expect(msgA1?.remoteId).toBe('remote-a1');

    const msgA2 = await storageRepo.getMessage('a2');
    expect(msgA2?.remoteId).toBe('remote-a2');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Mandatory Scenario 2: Two filtered responses with identical server placeholder
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 2: Two filtered responses under same prompt with identical placeholder -> do NOT guess or cross-link', async () => {
    const conv: Conversation = {
      id: 'conv-sc2',
      remoteId: 'remote-sess-2',
      title: 'Ambiguous Filtered Regenerates',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const userMsg: Message = {
      id: 'u-sc2',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Ambiguous prompt',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(userMsg);

    // Both a1 and a2 are filtered under the same parent
    const a1: Message = {
      id: 'a1-sc2',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Pre-filter variant 1',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await storageRepo.saveMessage(a1);
    await storageRepo.saveRevision({
      id: 'rev-sc2-1',
      messageId: a1.id,
      revisionIndex: 1,
      text: a1.content!,
      source: 'network',
      capturedAt: 1100,
      isFinal: false,
      isLastGood: true,
    });
    await storageRepo.saveRecoveryEvent({
      id: 'rec-sc2-1',
      messageId: a1.id,
      kind: 'content_filter',
      detectedAt: 1100,
      recoveredRevisionId: 'rev-sc2-1',
    });

    const a2: Message = {
      id: 'a2-sc2',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Pre-filter variant 2',
      createdAt: 1200,
      updatedAt: 1200,
    };
    await storageRepo.saveMessage(a2);
    await storageRepo.saveRevision({
      id: 'rev-sc2-2',
      messageId: a2.id,
      revisionIndex: 1,
      text: a2.content!,
      source: 'network',
      capturedAt: 1200,
      isFinal: false,
      isLastGood: true,
    });
    await storageRepo.saveRecoveryEvent({
      id: 'rec-sc2-2',
      messageId: a2.id,
      kind: 'content_filter',
      detectedAt: 1200,
      recoveredRevisionId: 'rev-sc2-2',
    });

    // Server history arrives with two filtered placeholders under the same parent
    const parsedHistory: DeepSeekParsedHistory = ({
      session: { sessionId: 'remote-sess-2' },
      messages: [
        {
          messageId: 'remote-u-sc2',
          role: 'user',
          text: 'Ambiguous prompt',
          status: 'finished',
          isFiltered: false,
        },
        {
          messageId: 'remote-filtered-1',
          parentId: 'remote-u-sc2',
          role: 'assistant',
          text: "Sorry, that's beyond my current scope.",
          status: 'filtered',
          isFiltered: true,
        },
        {
          messageId: 'remote-filtered-2',
          parentId: 'remote-u-sc2',
          role: 'assistant',
          text: "Sorry, that's beyond my current scope.",
          status: 'filtered',
          isFiltered: true,
        },
      ],
    } as any);

    const reconciler = new HistoryReconciler(storageRepo);
    const result = await reconciler.reconcile(parsedHistory);

    // Invariant: Because it is ambiguous (2 candidates and 2 server messages with identical placeholders),
    // the reconciler MUST NOT GUESS.
    // Neither candidate should be arbitrarily mapped to remote-filtered-1 or 2!
    const updatedA1 = await storageRepo.getMessage('a1-sc2');
    const updatedA2 = await storageRepo.getMessage('a2-sc2');

    // Both remain preserved locally
    expect(updatedA1?.content).toBe('Pre-filter variant 1');
    expect(updatedA2?.content).toBe('Pre-filter variant 2');

    // Neither has borrowed or guessed remoteId
    const recoverySummaries = await storageRepo.getRecoveryMetadataForConversation(conv.id);
    for (const rec of recoverySummaries) {
      // remoteId should be undefined (unconfirmed) rather than falsely bound
      expect(rec.remoteId).toBeUndefined();
    }
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Mandatory Scenario 3: First response filtered, second normal
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 3: First response filtered, second normal -> recovery only on 1st', async () => {
    const conv: Conversation = {
      id: 'conv-sc3',
      remoteId: 'remote-sess-3',
      title: 'Filtered First Normal Second',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const userMsg: Message = {
      id: 'u-sc3',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Generate poem',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(userMsg);

    // Branch 1: filtered
    const a1: Message = {
      id: 'a1-sc3',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Pre-filter poem lines',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await storageRepo.saveMessage(a1);
    await storageRepo.saveRevision({
      id: 'rev-sc3-1',
      messageId: a1.id,
      revisionIndex: 1,
      text: a1.content!,
      source: 'network',
      capturedAt: 1100,
      isFinal: false,
      isLastGood: true,
    });
    await storageRepo.saveRecoveryEvent({
      id: 'rec-sc3-1',
      messageId: a1.id,
      kind: 'content_filter',
      detectedAt: 1100,
      recoveredRevisionId: 'rev-sc3-1',
    });

    // Branch 2: normal
    const a2: Message = {
      id: 'a2-sc3',
      conversationId: conv.id,
      parentId: userMsg.id,
      role: 'assistant',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Roses are red, violets are blue.',
      createdAt: 1200,
      updatedAt: 1200,
    };
    await storageRepo.saveMessage(a2);

    const parsedHistory: DeepSeekParsedHistory = ({
      session: { sessionId: 'remote-sess-3' },
      messages: [
        {
          messageId: 'remote-u-sc3',
          role: 'user',
          text: 'Generate poem',
          status: 'finished',
          isFiltered: false,
        },
        {
          messageId: 'remote-sc3-filtered',
          parentId: 'remote-u-sc3',
          role: 'assistant',
          text: "Sorry, that's beyond my current scope.",
          status: 'filtered',
          isFiltered: true,
        },
        {
          messageId: 'remote-sc3-normal',
          parentId: 'remote-u-sc3',
          role: 'assistant',
          text: 'Roses are red, violets are blue.',
          status: 'finished',
          isFiltered: false,
        },
      ],
    } as any);

    const reconciler = new HistoryReconciler(storageRepo);
    const result = await reconciler.reconcile(parsedHistory);

    const updatedA1 = await storageRepo.getMessage('a1-sc3');
    const updatedA2 = await storageRepo.getMessage('a2-sc3');
    expect(updatedA1?.remoteId).toBe('remote-sc3-filtered');
    expect(updatedA2?.remoteId).toBe('remote-sc3-normal');

    const recoverySummaries = await storageRepo.getRecoveryMetadataForConversation(conv.id);
    expect(recoverySummaries.length).toBe(1);
    expect(recoverySummaries[0]!.messageId).toBe('a1-sc3');
    expect(recoverySummaries[0]!.remoteId).toBe('remote-sc3-filtered');
    expect(recoverySummaries[0]!.remoteId).not.toBe('remote-sc3-normal');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Mandatory Scenario 4: Filtering after Edit
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 4: Filtering after Edit -> recovery binds only to edited turn, never original prompt turn', async () => {
    const conv: Conversation = {
      id: 'conv-sc4',
      remoteId: 'remote-sess-4',
      title: 'Edit and Filter Test',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    // Turn 1: Original prompt & normal assistant response
    const u1: Message = {
      id: 'u1-sc4',
      conversationId: conv.id,
      remoteId: 'remote-u1-sc4',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Original prompt',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(u1);

    const a1: Message = {
      id: 'a1-sc4',
      conversationId: conv.id,
      remoteId: 'remote-a1-sc4',
      parentId: u1.id,
      remoteParentId: u1.remoteId,
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Original normal answer',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await storageRepo.saveMessage(a1);

    // Turn 2: User Edits prompt u1 -> creates new user turn u2 with NO parentId (root edit)
    const u2: Message = {
      id: 'u2-sc4',
      conversationId: conv.id,
      role: 'user',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Edited prompt with sensitive phrase',
      createdAt: 1200,
      updatedAt: 1200,
    };
    await storageRepo.saveMessage(u2);

    // Assistant response to edited prompt is filtered
    const a2: Message = {
      id: 'a2-sc4',
      conversationId: conv.id,
      parentId: u2.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Pre-filter answer to edited prompt',
      createdAt: 1300,
      updatedAt: 1300,
    };
    await storageRepo.saveMessage(a2);
    await storageRepo.saveRevision({
      id: 'rev-sc4-a2',
      messageId: a2.id,
      revisionIndex: 1,
      text: a2.content!,
      source: 'network',
      capturedAt: 1300,
      isFinal: false,
      isLastGood: true,
    });
    await storageRepo.saveRecoveryEvent({
      id: 'rec-sc4-a2',
      messageId: a2.id,
      kind: 'content_filter',
      detectedAt: 1300,
      recoveredRevisionId: 'rev-sc4-a2',
    });

    // Server history arrives containing both edited branches
    const parsedHistory: DeepSeekParsedHistory = ({
      session: { sessionId: 'remote-sess-4' },
      messages: [
        {
          messageId: 'remote-u1-sc4',
          role: 'user',
          text: 'Original prompt',
          status: 'finished',
          isFiltered: false,
        },
        {
          messageId: 'remote-a1-sc4',
          parentId: 'remote-u1-sc4',
          role: 'assistant',
          text: 'Original normal answer',
          status: 'finished',
          isFiltered: false,
        },
        {
          messageId: 'remote-u2-sc4',
          role: 'user',
          text: 'Edited prompt with sensitive phrase',
          status: 'finished',
          isFiltered: false,
        },
        {
          messageId: 'remote-a2-sc4',
          parentId: 'remote-u2-sc4',
          role: 'assistant',
          text: "Sorry, that's beyond my current scope.",
          status: 'filtered',
          isFiltered: true,
        },
      ],
    } as any);

    const reconciler = new HistoryReconciler(storageRepo);
    const result = await reconciler.reconcile(parsedHistory);

    const updatedA2 = await storageRepo.getMessage('a2-sc4');
    expect(updatedA2?.remoteId).toBe('remote-a2-sc4');

    const recoverySummaries = await storageRepo.getRecoveryMetadataForConversation(conv.id);
    expect(recoverySummaries.length).toBe(1);
    expect(recoverySummaries[0]!.messageId).toBe('a2-sc4');
    expect(recoverySummaries[0]!.remoteId).toBe('remote-a2-sc4');
    // Must NOT link to original a1 remote ID
    expect(recoverySummaries[0]!.remoteId).not.toBe('remote-a1-sc4');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Mandatory Scenario 5: Partial server history with only ONE of several branches
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 5: Partial server history with only 1 branch present -> unrepresented branch remains preserved locally without false binding', async () => {
    const conv: Conversation = {
      id: 'conv-sc5',
      remoteId: 'remote-sess-5',
      title: 'Partial Server History Test',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const u1: Message = {
      id: 'u-sc5',
      conversationId: conv.id,
      remoteId: 'remote-u-sc5',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Tell me a story',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(u1);

    // Branch 1: Captured locally and was filtered
    const a1: Message = {
      id: 'a1-sc5',
      conversationId: conv.id,
      parentId: u1.id,
      remoteParentId: u1.remoteId,
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Branch 1 pre-filter story text',
      createdAt: 1100,
      updatedAt: 1100,
    };
    await storageRepo.saveMessage(a1);
    await storageRepo.saveRevision({
      id: 'rev-sc5-a1',
      messageId: a1.id,
      revisionIndex: 1,
      text: a1.content!,
      source: 'network',
      capturedAt: 1100,
      isFinal: false,
      isLastGood: true,
    });
    await storageRepo.saveRecoveryEvent({
      id: 'rec-sc5-a1',
      messageId: a1.id,
      kind: 'content_filter',
      detectedAt: 1100,
      recoveredRevisionId: 'rev-sc5-a1',
    });

    // Branch 2: Captured locally and was normal
    const a2: Message = {
      id: 'a2-sc5',
      conversationId: conv.id,
      parentId: u1.id,
      remoteParentId: u1.remoteId,
      role: 'assistant',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      content: 'Branch 2 normal story text',
      createdAt: 1200,
      updatedAt: 1200,
    };
    await storageRepo.saveMessage(a2);

    // Now server history returns ONLY branch 2 (normal). Branch 1 placeholder is NOT present in server history!
    const parsedHistory: DeepSeekParsedHistory = ({
      session: { sessionId: 'remote-sess-5' },
      messages: [
        {
          messageId: 'remote-u-sc5',
          role: 'user',
          text: 'Tell me a story',
          status: 'finished',
          isFiltered: false,
        },
        {
          messageId: 'remote-a2-sc5',
          parentId: 'remote-u-sc5',
          role: 'assistant',
          text: 'Branch 2 normal story text',
          status: 'finished',
          isFiltered: false,
        },
      ],
    } as any);

    const reconciler = new HistoryReconciler(storageRepo);
    const result = await reconciler.reconcile(parsedHistory);

    const updatedA1 = await storageRepo.getMessage('a1-sc5');
    const updatedA2 = await storageRepo.getMessage('a2-sc5');

    // a2 matched remote-a2-sc5
    expect(updatedA2?.remoteId).toBe('remote-a2-sc5');

    // CRITICAL: a1 was filtered, but server message was normal.
    // Filtered candidate MUST NOT match normal server message!
    // a1 must remain without remoteId (unconfirmed), and MUST NOT steal remote-a2-sc5!
    expect(updatedA1?.remoteId).toBeUndefined();

    // Check recovery metadata
    const recoverySummaries = await storageRepo.getRecoveryMetadataForConversation(conv.id);
    expect(recoverySummaries.length).toBe(1);
    expect(recoverySummaries[0]!.messageId).toBe('a1-sc5');
    // remoteId is undefined because it is unconfirmed on server
    expect(recoverySummaries[0]!.remoteId).toBeUndefined();
    expect(recoverySummaries[0]!.remoteId).not.toBe('remote-a2-sc5');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Mandatory Scenario 6: Recovery after page reload
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 6: Recovery after page reload -> retrieves exact persisted recovery metadata without peer borrowing', async () => {
    const conv: Conversation = {
      id: 'conv-sc6',
      remoteId: 'remote-sess-6',
      title: 'Reload Test',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveConversation(conv);

    const asstMsg: Message = {
      id: 'asst-sc6',
      remoteId: 'remote-asst-sc6',
      conversationId: conv.id,
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Pre-filter text survives reload',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(asstMsg);

    await storageRepo.saveRevision({
      id: 'rev-sc6',
      messageId: asstMsg.id,
      revisionIndex: 1,
      text: asstMsg.content!,
      source: 'network',
      capturedAt: 1000,
      isFinal: false,
      isLastGood: true,
    });

    await storageRepo.saveRecoveryEvent({
      id: 'rec-sc6',
      messageId: asstMsg.id,
      kind: 'content_filter',
      detectedAt: 1000,
      recoveredRevisionId: 'rev-sc6',
      reason: 'CONTENT_FILTER',
    });

    // Simulate page reload: new repository instance querying the same database
    const freshRepo = new IndexedDbStorageRepository(fakeFactory);
    const recs = await freshRepo.getRecoveryMetadataForConversation(conv.id);

    expect(recs.length).toBe(1);
    expect(recs[0]!.messageId).toBe('asst-sc6');
    expect(recs[0]!.remoteId).toBe('remote-asst-sc6');
    expect(recs[0]!.hasLastGood).toBe(true);
    expect(recs[0]!.recoveredRevisionId).toBe('rev-sc6');
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Mandatory Scenario 7: Branch switching in DeepSeek without local tree switching
  // ──────────────────────────────────────────────────────────────────────────
  it('Scenario 7: Branch switching in DeepSeek -> anchor locates only active DOM branch, never wrong branch', () => {
    // DOM setup: DeepSeek chat view with branch 2 active (remote-b2)
    document.body.innerHTML = `
      <div id="chat-root">
        <div class="message-row" data-message-id="remote-b2">
          <div class="message-content">Branch 2 normal answer text</div>
        </div>
      </div>
    `;

    // Attempt to locate anchor for branch 1 (remote-b1, which is filtered but not currently in DOM)
    const anchorB1 = locateMessageAnchor('remote-b1', document);
    expect(anchorB1).toBeNull(); // Must NOT find an anchor!

    // Locate anchor for branch 2 (remote-b2, which is normal and in DOM)
    const anchorB2 = locateMessageAnchor('remote-b2', document);
    expect(anchorB2).not.toBeNull();
    expect(anchorB2?.element.getAttribute('data-message-id')).toBe('remote-b2');

    // User clicks DeepSeek branch switch button "< 1/2 >" in UI:
    // DeepSeek swaps the DOM element to branch 1:
    document.body.innerHTML = `
      <div id="chat-root">
        <div class="message-row" data-message-id="remote-b1">
          <div class="message-content">Sorry, that's beyond my current scope.</div>
        </div>
      </div>
    `;

    // Now branch 1 is located and ready for recovery mounting!
    const anchorB1AfterSwitch = locateMessageAnchor('remote-b1', document);
    expect(anchorB1AfterSwitch).not.toBeNull();
    expect(anchorB1AfterSwitch?.element.getAttribute('data-message-id')).toBe('remote-b1');

    // And branch 2 is no longer in DOM
    const anchorB2AfterSwitch = locateMessageAnchor('remote-b2', document);
    expect(anchorB2AfterSwitch).toBeNull();
  });
});
