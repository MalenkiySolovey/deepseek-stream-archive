import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { CanonicalStreamCoordinator } from '../src/core/recorder/canonical-stream-coordinator';
import { HistoryReconciler } from '../src/core/reconciliation/history-reconciler';
import {
  MESSAGE_PERSIST_CANONICAL_CHECKPOINT,
  type PersistCanonicalCheckpointRequest,
} from '../src/bridge/messages';
import { validatePersistCanonicalCheckpointRequest } from '../src/bridge/validation';
import { closeExtensionDatabase } from '../src/storage/db';
import {
  isLogicalMessage,
  type Message,
  type Conversation,
  type ResponseRevision,
  type RecoveryEvent,
} from '../src/core/models';
import { getActiveBranchAncestry } from '../src/context-continuity/branch-ancestry';
import type { DeepSeekParsedHistory } from '../src/adapters/deepseek/history/types';

describe('Edit Branching & Sticky Filter Preservation (10 Core Regression Scenarios)', () => {
  let fakeFactory: IDBFactory;
  let storageRepo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storageRepo = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
    closeExtensionDatabase();
  });

  const createCoordinator = (options: {
    streamId: string;
    sessionId: string;
    producerSessionId?: string;
    requestPrompt?: string;
    requestParentMessageId?: string | null;
  }) => {
    return new CanonicalStreamCoordinator({
      producerSessionId: options.producerSessionId || `prod_${options.streamId}`,
      streamId: options.streamId,
      provisionalSessionId: options.sessionId,
      requestPrompt: options.requestPrompt,
      requestParentMessageId: options.requestParentMessageId,
      conversationTitle: `Session ${options.sessionId}`,
      onCheckpoint: async (dto) => {
        const req: PersistCanonicalCheckpointRequest = {
          type: MESSAGE_PERSIST_CANONICAL_CHECKPOINT,
          checkpoint: {
            streamKey: dto.streamKey,
            checkpointSeq: dto.checkpointSeq,
            isTerminal: dto.isFinal,
            conversation: dto.conversation,
            userMessage: dto.userMessage,
            message: dto.message,
            revisions: dto.revisions,
            recoveryEvents: dto.recoveryEvents,
          },
        };
        const validated = validatePersistCanonicalCheckpointRequest(req);
        if (!validated) {
          return { success: false, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, error: 'invalid' };
        }
        await storageRepo.saveCanonicalCheckpoint(validated.checkpoint);
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq, persistedAt: Date.now() };
      },
      debounceMs: 10,
    });
  };

  // 1. Ordinary Edit
  it('Scenario 1: Ordinary Edit preserves Prompt A -> Answer A and Prompt B -> Answer B in separate branches', async () => {
    const sessionId = 'sess-edit-1';

    // Turn 1: Prompt A -> Answer A
    const coordA = createCoordinator({
      streamId: 'stream-1a',
      sessionId,
      requestPrompt: 'Explain bubblesort in Python',
      requestParentMessageId: null,
    });
    coordA.feedSemanticEvent({
      streamId: 'stream-1a',
      sequence: 1,
      timestamp: 1000,
      type: 'answer_delta',
      delta: 'def bubblesort(arr): ...',
    });
    coordA.feedSemanticEvent({
      streamId: 'stream-1a',
      sequence: 2,
      timestamp: 1050,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coordA.awaitFinalPersistence(2000);

    // Turn 2: User clicks Edit on Prompt A -> Prompt B -> Answer B
    const coordB = createCoordinator({
      streamId: 'stream-1b',
      sessionId,
      requestPrompt: 'Explain quicksort in Python',
      requestParentMessageId: null, // Same root parent
    });
    coordB.feedSemanticEvent({
      streamId: 'stream-1b',
      sequence: 1,
      timestamp: 2000,
      type: 'answer_delta',
      delta: 'def quicksort(arr): ...',
    });
    coordB.feedSemanticEvent({
      streamId: 'stream-1b',
      sequence: 2,
      timestamp: 2050,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coordB.awaitFinalPersistence(2000);

    const detail = await storageRepo.getArchiveConversation(sessionId);
    expect(detail).not.toBeNull();
    const logical = detail!.messages.filter((m) => isLogicalMessage(m));
    expect(logical).toHaveLength(4); // 2 User Prompts + 2 Assistant Answers

    // Branch 1: Root selection 0
    const branch1 = getActiveBranchAncestry(logical, { branchSelections: { __root__: 0 } });
    expect(branch1.activePath).toHaveLength(2);
    expect(branch1.activePath[0]!.content).toBe('Explain bubblesort in Python');
    expect(branch1.activePath[1]!.id).toBe(
      detail!.messages.find((m) => m.role === 'assistant' && m.sourceRawStreamKey?.includes('stream-1a'))?.id
    );

    // Branch 2: Root selection 1
    const branch2 = getActiveBranchAncestry(logical, { branchSelections: { __root__: 1 } });
    expect(branch2.activePath).toHaveLength(2);
    expect(branch2.activePath[0]!.content).toBe('Explain quicksort in Python');
    expect(branch2.activePath[1]!.id).toBe(
      detail!.messages.find((m) => m.role === 'assistant' && m.sourceRawStreamKey?.includes('stream-1b'))?.id
    );
  });

  // 2. Three sequential edits
  it('Scenario 2: Three sequential edits (A -> B -> C -> D) preserves all 4 prompt/response branches', async () => {
    const sessionId = 'sess-edit-seq';
    const prompts = ['Prompt A', 'Prompt B', 'Prompt C', 'Prompt D'];
    const answers = ['Answer A', 'Answer B', 'Answer C', 'Answer D'];

    for (let i = 0; i < 4; i++) {
      const coord = createCoordinator({
        streamId: `stream-seq-${i}`,
        sessionId,
        requestPrompt: prompts[i],
        requestParentMessageId: null,
      });
      coord.feedSemanticEvent({
        streamId: `stream-seq-${i}`,
        sequence: 1,
        timestamp: 1000 + i * 100,
        type: 'answer_delta',
        delta: answers[i],
      });
      coord.feedSemanticEvent({
        streamId: `stream-seq-${i}`,
        sequence: 2,
        timestamp: 1050 + i * 100,
        type: 'stream_finished',
        status: 'FINISHED',
        terminalReason: 'completed',
      });
      await coord.awaitFinalPersistence(2000);
    }

    const detail = await storageRepo.getArchiveConversation(sessionId);
    const logical = detail!.messages.filter((m) => isLogicalMessage(m));
    expect(logical).toHaveLength(8); // 4 prompts + 4 answers

    for (let i = 0; i < 4; i++) {
      const branch = getActiveBranchAncestry(logical, { branchSelections: { __root__: i } });
      expect(branch.activePath).toHaveLength(2);
      expect(branch.activePath[0]!.content).toBe(prompts[i]);
    }
  });

  // 3. Edit with filtering after substantive text
  it('Scenario 3: Edit with filtering after substantive text recovers text with sticky filtered status', async () => {
    const sessionId = 'sess-edit-filter';

    // Turn 1: Normal Prompt A
    const coordA = createCoordinator({
      streamId: 'stream-fa',
      sessionId,
      requestPrompt: 'Normal inquiry',
      requestParentMessageId: null,
    });
    coordA.feedSemanticEvent({
      streamId: 'stream-fa',
      sequence: 1,
      timestamp: 1000,
      type: 'answer_delta',
      delta: 'Normal safe response content.',
    });
    coordA.feedSemanticEvent({
      streamId: 'stream-fa',
      sequence: 2,
      timestamp: 1050,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coordA.awaitFinalPersistence(2000);

    // Turn 2: Edit prompt that gets filtered mid-stream
    const coordB = createCoordinator({
      streamId: 'stream-fb',
      sessionId,
      requestPrompt: 'Sensitive inquiry',
      requestParentMessageId: null,
    });
    coordB.feedSemanticEvent({
      streamId: 'stream-fb',
      sequence: 1,
      timestamp: 2000,
      type: 'answer_delta',
      delta: 'Valuable mathematical analysis before censorship occurs...',
    });
    coordB.feedSemanticEvent({
      streamId: 'stream-fb',
      sequence: 2,
      timestamp: 2050,
      type: 'filter_triggered',
      reason: 'CONTENT_FILTER',
      lastGood: {
        answer: 'Valuable mathematical analysis before censorship occurs...',
        thinking: '',
        capturedAt: 2050,
        reason: 'CONTENT_FILTER',
        projectionSource: 'none',
      },
    });
    // DeepSeek closes connection with finish frame
    coordB.feedSemanticEvent({
      streamId: 'stream-fb',
      sequence: 3,
      timestamp: 2060,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coordB.awaitFinalPersistence(2000);

    const detail = await storageRepo.getArchiveConversation(sessionId);
    const msgs = detail!.messages;
    const asstB = msgs.find((m) => m.role === 'assistant' && m.sourceRawStreamKey?.includes('stream-fb'))!;
    expect(asstB).toBeDefined();

    // Sticky filter check
    expect(asstB.status).toBe('filtered');
    expect(asstB.recoveryEvents).toHaveLength(1);
    expect(asstB.preferredRevision?.isLastGood).toBe(true);
    expect(asstB.preferredRevision?.text).toContain('Valuable mathematical analysis');

    // Archive summary recoveredCount check
    const convSummary = await storageRepo.listArchiveConversations();
    expect(convSummary.items[0]?.recoveredCount).toBe(1);
  });

  // 4. Edit with immediate refusal (no fake recovery)
  it('Scenario 4: Edit with immediate refusal produces zero fake recovery events', async () => {
    const sessionId = 'sess-edit-refusal';

    const coord = createCoordinator({
      streamId: 'stream-refusal',
      sessionId,
      requestPrompt: 'Direct refusal prompt',
      requestParentMessageId: null,
    });
    // Immediate filter with 0 text
    coord.feedSemanticEvent({
      streamId: 'stream-refusal',
      sequence: 1,
      timestamp: 1000,
      type: 'filter_triggered',
      reason: 'CONTENT_FILTER',
      lastGood: {
        answer: '',
        thinking: '',
        capturedAt: 1000,
        reason: 'CONTENT_FILTER',
        projectionSource: 'none',
      },
    });
    coord.feedSemanticEvent({
      streamId: 'stream-refusal',
      sequence: 2,
      timestamp: 1010,
      type: 'stream_finished',
      status: 'CONTENT_FILTER',
      terminalReason: 'filtered',
    });
    await coord.awaitFinalPersistence(2000);

    const detail = await storageRepo.getArchiveConversation(sessionId);
    const asst = detail!.messages.find((m) => m.role === 'assistant')!;
    expect(asst).toBeDefined();
    expect(asst.recoveryEvents).toHaveLength(0); // Zero fake recovery events on 0 text
  });

  // 5. Duplicate message IDs in history
  it('Scenario 5: Duplicate message IDs in history reconcile cleanly without dropping conversation', async () => {
    const reconciler = new HistoryReconciler(storageRepo);
    const sessionId = 'sess-dup-test';

    const parsed: DeepSeekParsedHistory = {
      session: {
        sessionId,
        title: 'Duplicate Test Session',
        updatedAt: 1000,
        pinned: false,
      },
      messages: [
        {
          messageId: 'msg-u1',
          parentId: null,
          role: 'user',
          text: 'User prompt',
          status: 'finished',
          createdAt: 1000,
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: 'msg-a1',
          parentId: 'msg-u1',
          role: 'assistant',
          text: 'First version text',
          status: 'finished',
          createdAt: 1010,
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          // Duplicate identical messageId (safe duplicate)
          messageId: 'msg-a1',
          parentId: 'msg-u1',
          role: 'assistant',
          text: 'First version text',
          status: 'finished',
          createdAt: 1010,
          isFiltered: false,
          fragmentsCount: 1,
        },
      ],
    };

    const res = await reconciler.reconcile(parsed);
    expect(res.messagesCreated).toBe(2);

    const conv = await storageRepo.getConversationByRemoteId(sessionId);
    expect(conv).not.toBeNull();
    const msgs = await storageRepo.listMessagesByConversation(conv!.id);
    expect(msgs).toHaveLength(2);
  });

  // 6. Edit + Regenerate
  it('Scenario 6: Edit + Regenerate maintains distinct hierarchy between sibling prompts and sibling responses', async () => {
    const sessionId = 'sess-edit-regen';

    // Turn 1: Prompt A -> Response A
    const coordA = createCoordinator({
      streamId: 'stream-pA',
      sessionId,
      requestPrompt: 'Prompt A',
      requestParentMessageId: null,
    });
    coordA.feedSemanticEvent({
      streamId: 'stream-pA',
      sequence: 1,
      timestamp: 1000,
      type: 'answer_delta',
      delta: 'Response A',
    });
    coordA.feedSemanticEvent({
      streamId: 'stream-pA',
      sequence: 2,
      timestamp: 1050,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coordA.awaitFinalPersistence(2000);

    // Turn 2: Edit Prompt A -> Prompt B -> Response B1
    const coordB1 = createCoordinator({
      producerSessionId: 'prod_1_b1',
      streamId: 'stream-pB-r1',
      sessionId,
      requestPrompt: 'Prompt B',
      requestParentMessageId: null,
    });
    coordB1.feedSemanticEvent({
      streamId: 'stream-pB-r1',
      sequence: 1,
      timestamp: 2000,
      type: 'answer_delta',
      delta: 'Response B1',
    });
    coordB1.feedSemanticEvent({
      streamId: 'stream-pB-r1',
      sequence: 2,
      timestamp: 2050,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coordB1.awaitFinalPersistence(2000);

    // Turn 3: User regenerates response to Prompt B -> Response B2 (same prompt parent)
    const detailB1 = await storageRepo.getArchiveConversation(sessionId);
    const userPromptB = detailB1!.messages.find((m) => m.content === 'Prompt B')!;

    const coordB2 = new CanonicalStreamCoordinator({
      producerSessionId: 'prod_2_b2',
      streamId: 'stream-pB-r2',
      provisionalSessionId: sessionId,
      // Regenerate does not resend prompt text, targets userPromptB
      conversationTitle: 'Session',
      onCheckpoint: async (dto) => {
        dto.message.parentId = userPromptB.id; // child of Prompt B
        await storageRepo.saveCanonicalCheckpoint({
          streamKey: dto.streamKey,
          checkpointSeq: dto.checkpointSeq,
          isTerminal: dto.isFinal,
          message: dto.message,
          revisions: dto.revisions,
          recoveryEvents: dto.recoveryEvents,
        });
        return { success: true, streamKey: dto.streamKey, checkpointSeq: dto.checkpointSeq };
      },
      debounceMs: 10,
    });
    coordB2.feedSemanticEvent({
      streamId: 'stream-pB-r2',
      sequence: 1,
      timestamp: 3000,
      type: 'answer_delta',
      delta: 'Response B2 (regenerated)',
    });
    coordB2.feedSemanticEvent({
      streamId: 'stream-pB-r2',
      sequence: 2,
      timestamp: 3050,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coordB2.awaitFinalPersistence(2000);

    const fullDetail = await storageRepo.getArchiveConversation(sessionId);
    const logical = fullDetail!.messages.filter((m) => isLogicalMessage(m));
    expect(logical).toHaveLength(5); // 2 Prompts (A, B) + 3 Responses (A, B1, B2)

    // Branch A
    const branchA = getActiveBranchAncestry(logical, { branchSelections: { __root__: 0 } });
    expect(branchA.activePath[0]!.content).toBe('Prompt A');
    expect(branchA.activePath[1]!.sourceRawStreamKey).toContain('stream-pA');

    // Branch B with Response B1
    const branchB1 = getActiveBranchAncestry(logical, {
      branchSelections: { __root__: 1, [userPromptB.id]: 0 },
    });
    expect(branchB1.activePath[0]!.content).toBe('Prompt B');
    expect(branchB1.activePath[1]!.sourceRawStreamKey).toContain('stream-pB-r1');

    // Branch B with Regenerated Response B2
    const branchB2 = getActiveBranchAncestry(logical, {
      branchSelections: { __root__: 1, [userPromptB.id]: 1 },
    });
    expect(branchB2.activePath[0]!.content).toBe('Prompt B');
    expect(branchB2.activePath[1]!.sourceRawStreamKey).toContain('stream-pB-r2');
  });

  // 7. Edit + History reconciliation
  it('Scenario 7: History sync preserves local recovered edited revisions without erasing them', async () => {
    const sessionId = 'sess-edit-hist';
    const reconciler = new HistoryReconciler(storageRepo);

    // Live Turn 1: Filtered Edit
    const coord = createCoordinator({
      streamId: 'stream-live-filtered',
      sessionId,
      requestPrompt: 'Uncensored request',
      requestParentMessageId: null,
    });
    coord.feedSemanticEvent({
      streamId: 'stream-live-filtered',
      sequence: 1,
      timestamp: 1000,
      type: 'answer_delta',
      delta: 'Critical uncensored analysis text',
    });
    coord.feedSemanticEvent({
      streamId: 'stream-live-filtered',
      sequence: 2,
      timestamp: 1050,
      type: 'filter_triggered',
      reason: 'CONTENT_FILTER',
      lastGood: {
        answer: 'Critical uncensored analysis text',
        thinking: '',
        capturedAt: 1050,
        reason: 'CONTENT_FILTER',
        projectionSource: 'none',
      },
    });
    coord.feedSemanticEvent({
      streamId: 'stream-live-filtered',
      sequence: 3,
      timestamp: 1060,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coord.awaitFinalPersistence(2000);

    // DeepSeek history arrives containing an alternate branch / sanitized response
    const historyParsed: DeepSeekParsedHistory = {
      session: {
        sessionId,
        title: 'History Title',
        updatedAt: 2000,
        pinned: false,
      },
      messages: [
        {
          messageId: 'remote-u1',
          parentId: null,
          role: 'user',
          text: 'Sanitized request',
          status: 'finished',
          createdAt: 2000,
          isFiltered: false,
          fragmentsCount: 1,
        },
        {
          messageId: 'remote-a1',
          parentId: 'remote-u1',
          role: 'assistant',
          text: 'Sanitized response',
          status: 'finished',
          createdAt: 2010,
          isFiltered: false,
          fragmentsCount: 1,
        },
      ],
    };

    await reconciler.reconcile(historyParsed);

    const detail = await storageRepo.getArchiveConversation(sessionId);
    const msgs = detail!.messages;

    // Verify local recovered filtered message is preserved as provisional_logical and filtered
    const recovered = msgs.find((m) => m.role === 'assistant' && m.sourceRawStreamKey?.includes('stream-live-filtered'))!;
    expect(recovered).toBeDefined();
    expect(recovered.status).toBe('filtered');
    expect(recovered.projectionState).toBe('provisional_logical');
    expect(recovered.recoveryEvents).toHaveLength(1);
    expect(recovered.preferredRevision?.isLastGood).toBe(true);
  });

  // 8. Reload / persistence check
  it('Scenario 8: Database reload preserves all edited branches and recovery metadata', async () => {
    const sessionId = 'sess-reload-test';

    const coord = createCoordinator({
      streamId: 'stream-reload-1',
      sessionId,
      requestPrompt: 'Persist this prompt',
      requestParentMessageId: null,
    });
    coord.feedSemanticEvent({
      streamId: 'stream-reload-1',
      sequence: 1,
      timestamp: 1000,
      type: 'answer_delta',
      delta: 'Persist this answer',
    });
    coord.feedSemanticEvent({
      streamId: 'stream-reload-1',
      sequence: 2,
      timestamp: 1050,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    await coord.awaitFinalPersistence(2000);

    // Create fresh repository instance on the same factory (simulating extension reload)
    const freshRepo = new IndexedDbStorageRepository(fakeFactory);
    const reloaded = await freshRepo.getArchiveConversation(sessionId);
    expect(reloaded).not.toBeNull();
    const logical = reloaded!.messages.filter((m) => isLogicalMessage(m));
    expect(logical).toHaveLength(2);
    const userPrompt = logical.find((m) => m.role === 'user');
    expect(userPrompt?.content).toBe('Persist this prompt');
    const asstResp = logical.find((m) => m.role === 'assistant');
    expect(asstResp?.preferredRevision?.text).toBe('Persist this answer');
  });

  // 9. Two tabs / multiple sessions isolation
  it('Scenario 9: Two simultaneous sessions in different tabs maintain complete branch isolation', async () => {
    const coordTab1 = createCoordinator({
      streamId: 'stream-tab1',
      sessionId: 'sess-tab1',
      requestPrompt: 'Tab 1 prompt',
      requestParentMessageId: null,
    });
    const coordTab2 = createCoordinator({
      streamId: 'stream-tab2',
      sessionId: 'sess-tab2',
      requestPrompt: 'Tab 2 prompt',
      requestParentMessageId: null,
    });

    coordTab1.feedSemanticEvent({
      streamId: 'stream-tab1',
      sequence: 1,
      timestamp: 1000,
      type: 'answer_delta',
      delta: 'Tab 1 answer',
    });
    coordTab2.feedSemanticEvent({
      streamId: 'stream-tab2',
      sequence: 1,
      timestamp: 1000,
      type: 'answer_delta',
      delta: 'Tab 2 answer',
    });

    coordTab1.feedSemanticEvent({
      streamId: 'stream-tab1',
      sequence: 2,
      timestamp: 1050,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });
    coordTab2.feedSemanticEvent({
      streamId: 'stream-tab2',
      sequence: 2,
      timestamp: 1050,
      type: 'stream_finished',
      status: 'FINISHED',
      terminalReason: 'completed',
    });

    await Promise.all([coordTab1.awaitFinalPersistence(2000), coordTab2.awaitFinalPersistence(2000)]);

    const detail1 = await storageRepo.getArchiveConversation('sess-tab1');
    const detail2 = await storageRepo.getArchiveConversation('sess-tab2');

    expect(detail1!.messages.filter((m) => isLogicalMessage(m))).toHaveLength(2);
    expect(detail2!.messages.filter((m) => isLogicalMessage(m))).toHaveLength(2);

    expect(detail1!.messages.every((m) => m.conversationId === 'sess-tab1')).toBe(true);
    expect(detail2!.messages.every((m) => m.conversationId === 'sess-tab2')).toBe(true);
  });

  // 10. Backward compatibility with v0.1.0 archives
  it('Scenario 10: Backward compatibility with v0.1.0 records without requestPrompt or missing parentId', async () => {
    const convId = 'conv-legacy-v010';
    await storageRepo.saveConversation({
      id: convId,
      remoteId: 'remote-legacy',
      title: 'Legacy v0.1.0 Archive',
      createdAt: 1000,
      updatedAt: 1000,
    });

    // Legacy User prompt with parentId: undefined
    const userMsg: Message = {
      id: 'msg-legacy-u',
      conversationId: convId,
      role: 'user',
      status: 'finished',
      content: 'Legacy prompt text',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await storageRepo.saveMessage(userMsg);

    // Legacy Assistant response with parentId: undefined
    const asstMsg: Message = {
      id: 'msg-legacy-a',
      conversationId: convId,
      role: 'assistant',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1010,
      updatedAt: 1010,
    };
    await storageRepo.saveMessage(asstMsg);
    await storageRepo.saveRevision({
      id: 'rev-legacy-a-0',
      messageId: 'msg-legacy-a',
      revisionIndex: 0,
      text: 'Legacy assistant answer text',
      source: 'network',
      capturedAt: 1010,
      isFinal: true,
      isLastGood: false,
    });

    const detail = await storageRepo.getArchiveConversation(convId);
    expect(detail).not.toBeNull();
    const logical = detail!.messages.filter((m) => isLogicalMessage(m));
    expect(logical).toHaveLength(2);

    // Topological resolution with read-time fallback
    const ancestry = getActiveBranchAncestry(logical);
    expect(ancestry.activePath).toHaveLength(2);
    expect(ancestry.activePath[0]!.id).toBe('msg-legacy-u');
    expect(ancestry.activePath[1]!.id).toBe('msg-legacy-a');
  });
});
