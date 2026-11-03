import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { closeExtensionDatabase } from '../src/storage/db';
import {
  type Message,
  type ResponseRevision,
  type RecoveryEvent,
  selectPreferredRevision,
} from '../src/core/models';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { evaluateContinuityEligibility } from '../src/context-continuity/eligibility';
import { buildConversationMarkdown, buildConversationJson } from '../src/export';

describe('Pre-Filter Recovery Correctness & Read-Time Legacy Repair', () => {
  let fakeFactory: IDBFactory;
  let storage: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    storage = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase();
  });

  it('selectPreferredRevision selects earlier non-empty network revision when lastGood was recorded with 0 chars (Live Bug Fix)', () => {
    const message: Message = {
      id: 'msg-live-filtered',
      conversationId: 'conv-1',
      identityState: 'reconciled',
      projectionState: 'logical',
      role: 'assistant',
      status: 'filtered',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const revisions: ResponseRevision[] = [
      {
        id: 'rev_385',
        messageId: 'msg-live-filtered',
        revisionIndex: 385,
        text: 'REAL PRE-FILTER RESPONSE: Complete 11038 chars mathematical analysis.',
        source: 'network',
        capturedAt: 1100,
        isFinal: false,
        isLastGood: false,
      },
      {
        id: 'rev_386',
        messageId: 'msg-live-filtered',
        revisionIndex: 386,
        text: '',
        source: 'network',
        capturedAt: 1200,
        isFinal: false,
        isLastGood: false,
      },
      {
        id: 'rev_387',
        messageId: 'msg-live-filtered',
        revisionIndex: 387,
        text: '',
        source: 'network',
        capturedAt: 1300,
        isFinal: false,
        isLastGood: true, // Bogus 0-char lastGood recorded by old buggy code
      },
    ];

    const preferred = selectPreferredRevision(message, revisions);
    expect(preferred).not.toBeNull();
    // Invariant: Must select rev_385 with 11038 chars, NOT rev_387 with 0 chars!
    expect(preferred!.id).toBe('rev_385');
    expect(preferred!.text).toBe('REAL PRE-FILTER RESPONSE: Complete 11038 chars mathematical analysis.');
  });

  it('selectPreferredRevision prefers valid non-empty lastGood when present', () => {
    const message: Message = {
      id: 'msg-normal-filter',
      conversationId: 'conv-1',
      identityState: 'reconciled',
      projectionState: 'logical',
      role: 'assistant',
      status: 'filtered',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const revisions: ResponseRevision[] = [
      {
        id: 'rev_0',
        messageId: 'msg-normal-filter',
        revisionIndex: 0,
        text: 'Normal response before filter.',
        source: 'network',
        capturedAt: 1000,
        isFinal: false,
        isLastGood: true,
      },
    ];

    const preferred = selectPreferredRevision(message, revisions);
    expect(preferred).not.toBeNull();
    expect(preferred!.id).toBe('rev_0');
    expect(preferred!.text).toBe('Normal response before filter.');
  });

  it('StorageRepository.getRecoveryMetadataForConversation repairs legacy corrupted RecoveryEvents pointing to 0-char revisions', async () => {
    const convId = 'conv-legacy-repair';
    await storage.saveConversation({
      id: convId,
      title: 'Legacy Recovery Test',
      createdAt: 1000,
      updatedAt: 2000,
    });

    const msgId = 'msg-legacy-corrupted';
    await storage.saveMessage({
      id: msgId,
      conversationId: convId,
      identityState: 'reconciled',
      projectionState: 'logical',
      role: 'assistant',
      status: 'filtered',
      createdAt: 1000,
      updatedAt: 2000,
    });

    // #385 meaningful network revision
    const usefulText = 'Important pre-filter answer content.';
    await storage.saveRevision({
      id: 'rev_385_good',
      messageId: msgId,
      revisionIndex: 385,
      text: usefulText,
      source: 'network',
      capturedAt: 1100,
      isFinal: false,
      isLastGood: false,
    });

    // #387 empty Last Good revision (corrupted)
    await storage.saveRevision({
      id: 'rev_387_empty',
      messageId: msgId,
      revisionIndex: 387,
      text: '',
      source: 'network',
      capturedAt: 1300,
      isFinal: false,
      isLastGood: true,
    });

    // RecoveryEvent pointing to empty revision
    await storage.saveRecoveryEvent({
      id: 'rec_legacy_1',
      messageId: msgId,
      kind: 'content_filter',
      detectedAt: 1300,
      recoveredRevisionId: 'rev_387_empty',
      reason: 'CONTENT_FILTER',
    });

    // Query recovery metadata
    const metadata = await storage.getRecoveryMetadataForConversation(convId);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.messageId).toBe(msgId);
    expect(metadata[0]!.hasLastGood).toBe(true);
    // Invariant: read-time legacy repair resolves to rev_385_good, NOT rev_387_empty!
    expect(metadata[0]!.recoveredRevisionId).toBe('rev_385_good');
  });

  it('evaluates Context Continuity eligibility with repaired non-empty revision', () => {
    const message: Message = {
      id: 'msg-continuity-test',
      conversationId: 'conv-cont',
      identityState: 'provisional',
      projectionState: 'logical',
      role: 'assistant',
      status: 'filtered',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const revisions: ResponseRevision[] = [
      {
        id: 'rev_net_useful',
        messageId: 'msg-continuity-test',
        revisionIndex: 0,
        text: 'Pre-filter assistant response for continuity.',
        source: 'network',
        capturedAt: 1000,
        isFinal: false,
        isLastGood: false,
      },
      {
        id: 'rev_empty_lastgood',
        messageId: 'msg-continuity-test',
        revisionIndex: 1,
        text: '',
        source: 'network',
        capturedAt: 1100,
        isFinal: false,
        isLastGood: true,
      },
    ];

    const recoveryEvents: RecoveryEvent[] = [
      {
        id: 'rec_test',
        messageId: 'msg-continuity-test',
        kind: 'content_filter',
        detectedAt: 1100,
        recoveredRevisionId: 'rev_empty_lastgood',
      },
    ];

    const result = evaluateContinuityEligibility({
      message,
      revisions,
      recoveryEvents,
      activeBranchMessageIds: new Set(['msg-continuity-test']),
      targetConversationId: 'conv-cont',
    });

    expect(result.eligible).toBe(true);
    expect(result.candidateRevision).toBeDefined();
    // Must select the meaningful revision with real text
    expect(result.candidateRevision!.id).toBe('rev_net_useful');
    expect(result.candidateRevision!.text).toBe('Pre-filter assistant response for continuity.');
  });

  it('exports conversation with repaired recovery content instead of empty strings', () => {
    const conversation = {
      id: 'conv-export-test',
      title: 'Export Recovery Test',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const message: Message = {
      id: 'msg-export-1',
      conversationId: 'conv-export-test',
      identityState: 'reconciled',
      projectionState: 'logical',
      role: 'assistant',
      status: 'filtered',
      createdAt: 1000,
      updatedAt: 2000,
    };

    const revisions: ResponseRevision[] = [
      {
        id: 'rev_1',
        messageId: 'msg-export-1',
        revisionIndex: 1,
        text: 'Substantive pre-filter derivations.',
        source: 'network',
        capturedAt: 1000,
        isFinal: false,
        isLastGood: false,
      },
      {
        id: 'rev_2',
        messageId: 'msg-export-1',
        revisionIndex: 2,
        text: '',
        source: 'network',
        capturedAt: 1100,
        isFinal: false,
        isLastGood: true,
      },
    ];

    const recoveryEvents: RecoveryEvent[] = [
      {
        id: 'rec_export_1',
        messageId: 'msg-export-1',
        kind: 'content_filter',
        detectedAt: 1100,
        recoveredRevisionId: 'rev_2',
      },
    ];

    const model = {
      conversation,
      messages: [
        {
          message,
          revisions,
          recoveryEvents,
        },
      ],
    };

    // 1. Markdown Export
    const md = buildConversationMarkdown(model, {
      format: 'markdown',
      branches: 'all',
      includeReasoning: true,
      includeRevisions: false,
      includeRecovery: true,
    });

    expect(md).toContain('### Recovery');
    expect(md).toContain('Substantive pre-filter derivations.');

    // 2. JSON Export
    const jsonStr = buildConversationJson(model, {
      format: 'json',
      branches: 'all',
      includeReasoning: true,
      includeRevisions: false,
      includeRecovery: true,
    });
    const parsed = JSON.parse(jsonStr);
    expect(parsed.messages[0].recovery.lastGoodText).toBe('Substantive pre-filter derivations.');
  });
});
