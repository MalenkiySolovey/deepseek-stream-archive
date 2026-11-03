import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { validateRecordRecoveryDiagnosticRequest } from '../src/bridge/validation';
import { MESSAGE_RECORD_RECOVERY_DIAGNOSTIC } from '../src/bridge/messages';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';

describe('Structural Diagnostics Metrics (Section 19)', () => {
  let repository: IndexedDbStorageRepository;

  beforeEach(async () => {
    indexedDB = new IDBFactory();
    repository = new IndexedDbStorageRepository();
  });

  it('accurately calculates structural metrics across user edits, assistant regenerations, and unconfirmed parents', async () => {
    const conv: Conversation = {
      id: 'conv_diag_1',
      title: 'Diagnostics Test Conversation',
      createdAt: 1000,
      updatedAt: 2000,
    };
    await repository.saveConversation(conv);

    // Initial user prompt (root)
    const u1: Message = {
      id: 'u1',
      conversationId: 'conv_diag_1',
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1000,
      updatedAt: 1000,
    };
    // Edit 1 of user prompt (sibling under root)
    const u1_edit: Message = {
      id: 'u1_edit',
      conversationId: 'conv_diag_1',
      role: 'user',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1050,
      updatedAt: 1050,
    };
    // Assistant response 1 to u1
    const a1: Message = {
      id: 'a1',
      conversationId: 'conv_diag_1',
      parentId: 'u1',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1100,
      updatedAt: 1100,
    };
    // Assistant response 2 (regenerate) to u1
    const a1_regen: Message = {
      id: 'a1_regen',
      conversationId: 'conv_diag_1',
      parentId: 'u1',
      role: 'assistant',
      status: 'filtered',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1200,
      updatedAt: 1200,
    };
    // Orphan assistant message with missing parent
    const a_orphan: Message = {
      id: 'a_orphan',
      conversationId: 'conv_diag_1',
      parentId: 'non_existent_turn_id',
      role: 'assistant',
      status: 'finished',
      identityState: 'provisional',
      projectionState: 'provisional_logical',
      createdAt: 1300,
      updatedAt: 1300,
    };

    await repository.saveMessages([u1, u1_edit, a1, a1_regen, a_orphan]);

    // Revisions
    // Normal revision
    const r1: ResponseRevision = {
      id: 'rev_1',
      messageId: 'a1',
      revisionIndex: 1,
      text: 'Healthy response text',
      source: 'network',
      capturedAt: 1100,
      isFinal: true,
      isLastGood: false,
    };
    // Recovery revision with text & thinking
    const r2_good: ResponseRevision = {
      id: 'rev_2_good',
      messageId: 'a1_regen',
      revisionIndex: 1,
      text: 'Pre-filtered text preserved',
      thinking: 'Thinking process',
      source: 'network',
      capturedAt: 1180,
      isFinal: false,
      isLastGood: true,
    };
    // Recovery revision with thinking ONLY
    const r3_thinking_only: ResponseRevision = {
      id: 'rev_3_thinking_only',
      messageId: 'a_orphan',
      revisionIndex: 1,
      text: '',
      thinking: 'Only philosophical thoughts captured',
      source: 'network',
      capturedAt: 1290,
      isFinal: true,
      isLastGood: true,
    };

    await repository.saveRevisions([r1, r2_good, r3_thinking_only]);

    const summary = await repository.getArchiveSummary();

    expect(summary.conversationsCount).toBe(1);
    expect(summary.messagesCount).toBe(5);
    expect(summary.userMessagesCount).toBe(2); // u1, u1_edit
    expect(summary.assistantMessagesCount).toBe(3); // a1, a1_regen, a_orphan
    expect(summary.userPromptVariantsCount).toBe(1); // 1 edit variant under root
    expect(summary.assistantVariantsCount).toBe(1); // 1 regenerate variant under u1
    expect(summary.reconciledMessagesCount).toBe(2); // u1, a1
    expect(summary.provisionalMessagesCount).toBe(3); // u1_edit, a1_regen, a_orphan
    expect(summary.unconfirmedParentMessagesCount).toBe(1); // a_orphan pointing to non-existent parent
    expect(summary.idConflictsCount).toBe(0);
    expect(summary.recoveriesWithTextCount).toBe(1); // r2_good
    expect(summary.recoveriesWithThinkingOnlyCount).toBe(1); // r3_thinking_only
  });

  it('detects remoteId conflicts if same remoteId is assigned to multiple messages in a conversation', async () => {
    const conv: Conversation = {
      id: 'conv_conflict',
      title: 'Conflict Test',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await repository.saveConversation(conv);

    const m1: Message = {
      id: 'local_1',
      remoteId: 'server_msg_99',
      conversationId: 'conv_conflict',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const m2: Message = {
      id: 'local_2',
      remoteId: 'server_msg_99', // duplicate remoteId
      conversationId: 'conv_conflict',
      role: 'assistant',
      status: 'finished',
      identityState: 'provisional',
      createdAt: 1010,
      updatedAt: 1010,
    };

    await repository.saveMessages([m1, m2]);
    const summary = await repository.getArchiveSummary();
    expect(summary.idConflictsCount).toBe(1);
  });

  it('validates RecordRecoveryDiagnosticRequest strictly and handles all kind variants', () => {
    const req1 = validateRecordRecoveryDiagnosticRequest({
      type: MESSAGE_RECORD_RECOVERY_DIAGNOSTIC,
      kind: 'inline_success',
    });
    expect(req1).not.toBeNull();
    expect(req1?.kind).toBe('inline_success');

    const req2 = validateRecordRecoveryDiagnosticRequest({
      type: MESSAGE_RECORD_RECOVERY_DIAGNOSTIC,
      kind: 'fallback_render',
    });
    expect(req2).not.toBeNull();
    expect(req2?.kind).toBe('fallback_render');

    const req3 = validateRecordRecoveryDiagnosticRequest({
      type: MESSAGE_RECORD_RECOVERY_DIAGNOSTIC,
      kind: 'dom_mapping_error',
    });
    expect(req3).not.toBeNull();
    expect(req3?.kind).toBe('dom_mapping_error');

    // Invalid payload
    expect(validateRecordRecoveryDiagnosticRequest(null)).toBeNull();
    expect(
      validateRecordRecoveryDiagnosticRequest({
        type: MESSAGE_RECORD_RECOVERY_DIAGNOSTIC,
        kind: 'unsupported_kind',
      })
    ).toBeNull();
  });
});
