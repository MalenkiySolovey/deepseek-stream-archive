import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { IndexedDbStorageRepository } from '../src/storage/repositories/storage-repository-impl';
import { openExtensionDatabase, closeExtensionDatabase } from '../src/storage/db';
import type { ContextContinuityReceipt } from '../src/context-continuity/types';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';
import { buildConversationDeletionPlan, deleteConversationCascade } from '../src/storage/retention/deletion';
import { executeAtomicReplace } from '../src/restore/replace';
import type { MaterializedPortableBackup } from '../src/backup/reader';

describe('Context Continuity Receipts Ledger & Lifecycle', () => {
  let fakeFactory: IDBFactory;
  let repo: IndexedDbStorageRepository;

  beforeEach(() => {
    fakeFactory = new IDBFactory();
    repo = new IndexedDbStorageRepository(fakeFactory);
  });

  afterEach(() => {
    closeExtensionDatabase(fakeFactory);
  });

  const sampleReceipt: ContextContinuityReceipt = {
    id: 'deliv-001',
    conversationId: 'conv-rec-1',
    remoteConversationId: 'session-remote-100',
    parentMessageId: 'msg-leaf',
    sourceMessageIds: ['msg-rec-1', 'msg-rec-2'],
    sourceRevisionIds: ['rev-rec-1', 'rev-rec-2'],
    deliveryMode: 'manual_next',
    state: 'dispatched',
    createdAt: 1000,
    updatedAt: 1000,
  };

  it('records, retrieves and updates delivery receipts', async () => {
    await repo.recordContinuityReceipt(sampleReceipt);

    const retrieved = await repo.getContinuityReceipt('deliv-001');
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe('deliv-001');
    expect(retrieved?.state).toBe('dispatched');
    expect(retrieved?.sourceMessageIds).toEqual(['msg-rec-1', 'msg-rec-2']);

    // Update to response_observed
    await repo.updateContinuityReceipt('deliv-001', {
      state: 'response_observed',
      rawStreamKey: 'prod_1:stream_abc',
    });

    const updated = await repo.getContinuityReceipt('deliv-001');
    expect(updated?.state).toBe('response_observed');
    expect(updated?.rawStreamKey).toBe('prod_1:stream_abc');
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(1000);

    // Update to bridged
    await repo.updateContinuityReceipt('deliv-001', {
      state: 'bridged',
      resultingMessageId: 'msg-assistant-result',
    });

    const final = await repo.getContinuityReceipt('deliv-001');
    expect(final?.state).toBe('bridged');
    expect(final?.resultingMessageId).toBe('msg-assistant-result');
  });

  it('lists receipts for conversation and derives bridged message IDs', async () => {
    const receipt1: ContextContinuityReceipt = {
      ...sampleReceipt,
      id: 'deliv-001',
      state: 'bridged',
      sourceMessageIds: ['msg-1', 'msg-2'],
      createdAt: 1000,
    };
    const receipt2: ContextContinuityReceipt = {
      ...sampleReceipt,
      id: 'deliv-002',
      state: 'dispatched', // Not yet bridged!
      sourceMessageIds: ['msg-3'],
      createdAt: 2000,
    };
    const receipt3: ContextContinuityReceipt = {
      ...sampleReceipt,
      id: 'deliv-003',
      state: 'bridged',
      sourceMessageIds: ['msg-4'],
      createdAt: 3000,
    };

    await repo.recordContinuityReceipt(receipt1);
    await repo.recordContinuityReceipt(receipt2);
    await repo.recordContinuityReceipt(receipt3);

    const list = await repo.getContinuityReceiptsForConversation('conv-rec-1');
    expect(list).toHaveLength(3);
    expect(list[0]?.id).toBe('deliv-001');
    expect(list[1]?.id).toBe('deliv-002');
    expect(list[2]?.id).toBe('deliv-003');

    const bridgedIds = await repo.getBridgedMessageIdsForConversation('conv-rec-1');
    expect(bridgedIds.has('msg-1')).toBe(true);
    expect(bridgedIds.has('msg-2')).toBe(true);
    expect(bridgedIds.has('msg-4')).toBe(true);
    // msg-3 was only dispatched, not bridged
    expect(bridgedIds.has('msg-3')).toBe(false);
  });

  it('automatically excludes already-bridged messages in buildContextContinuityPlan', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const conv: Conversation = {
      id: 'conv-rec-1',
      remoteId: 'session-remote-100',
      title: 'Continuity Conversation',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await repo.saveConversation(conv);

    const msg1: Message = {
      id: 'msg-rec-1',
      conversationId: 'conv-rec-1',
      remoteId: 'remote-msg-1',
      role: 'assistant',
      status: 'interrupted',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1100,
      updatedAt: 1100,
    };
    const msg2: Message = {
      id: 'msg-rec-2',
      conversationId: 'conv-rec-1',
      remoteId: 'remote-msg-2',
      parentId: 'msg-rec-1',
      role: 'assistant',
      status: 'interrupted',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 1200,
      updatedAt: 1200,
    };

    const rev1: ResponseRevision = {
      id: 'rev-1',
      messageId: 'msg-rec-1',
      revisionIndex: 1,
      text: 'First recovered block',
      source: 'network',
      capturedAt: 1100,
      isFinal: true,
      isLastGood: true,
    };
    const rev2: ResponseRevision = {
      id: 'rev-2',
      messageId: 'msg-rec-2',
      revisionIndex: 1,
      text: 'Second recovered block',
      source: 'network',
      capturedAt: 1200,
      isFinal: true,
      isLastGood: true,
    };

    const rec1: RecoveryEvent = {
      id: 'rec-1',
      messageId: 'msg-rec-1',
      recoveredRevisionId: 'rev-1',
      kind: 'network_interruption',
      detectedAt: 1100,
    };
    const rec2: RecoveryEvent = {
      id: 'rec-2',
      messageId: 'msg-rec-2',
      recoveredRevisionId: 'rev-2',
      kind: 'content_filter',
      detectedAt: 1200,
    };

    await repo.saveMessage(msg1);
    await repo.saveMessage(msg2);
    await repo.saveRevision(rev1);
    await repo.saveRevision(rev2);
    await repo.saveRecoveryEvent(rec1);
    await repo.saveRecoveryEvent(rec2);

    // Initial plan without any bridged receipts: both are eligible
    const initialPlan = await repo.buildContextContinuityPlan('conv-rec-1', {
      settings: { enabled: true, includeThinking: false, deliveryMode: 'manual_next' },
    });
    expect(initialPlan?.eligibleBlockCount).toBe(2);

    // Record receipt marking msg-rec-1 as bridged
    await repo.recordContinuityReceipt({
      id: 'deliv-msg1',
      conversationId: 'conv-rec-1',
      remoteConversationId: 'session-remote-100',
      parentMessageId: null,
      sourceMessageIds: ['msg-rec-1'],
      sourceRevisionIds: ['rev-1'],
      deliveryMode: 'manual_next',
      state: 'bridged',
      createdAt: 1300,
      updatedAt: 1300,
    });

    // Rebuild plan: msg-rec-1 must now be excluded with reason already_bridged!
    const updatedPlan = await repo.buildContextContinuityPlan('conv-rec-1', {
      settings: { enabled: true, includeThinking: false, deliveryMode: 'manual_next' },
    });
    expect(updatedPlan?.eligibleBlockCount).toBe(1);
    expect(updatedPlan?.eligibleBlocks[0]?.sourceMessageId).toBe('msg-rec-2');

    const excluded = updatedPlan?.excludedBlocks.find((b) => b.sourceMessageId === 'msg-rec-1');
    expect(excluded).toBeDefined();
    expect(excluded?.reason).toBe('already_bridged');
  });

  it('cascades deletion of continuity receipts when conversation is deleted', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    const conv: Conversation = {
      id: 'conv-del-1',
      remoteId: 'session-remote-del',
      title: 'To Delete',
      createdAt: 1000,
      updatedAt: 1000,
    };
    await repo.saveConversation(conv);

    await repo.recordContinuityReceipt({
      id: 'deliv-to-delete',
      conversationId: 'conv-del-1',
      remoteConversationId: 'session-remote-del',
      parentMessageId: null,
      sourceMessageIds: ['msg-1'],
      sourceRevisionIds: ['rev-1'],
      deliveryMode: 'manual_next',
      state: 'bridged',
      createdAt: 1100,
      updatedAt: 1100,
    });

    const before = await repo.getContinuityReceipt('deliv-to-delete');
    expect(before).not.toBeNull();

    const plan = await buildConversationDeletionPlan(db, 'conv-del-1', new Set());
    await deleteConversationCascade(db, plan, new Set());

    const after = await repo.getContinuityReceipt('deliv-to-delete');
    expect(after).toBeNull();
  });

  it('clears receipts on atomic archive replacement', async () => {
    const db = await openExtensionDatabase(fakeFactory);
    await repo.recordContinuityReceipt(sampleReceipt);

    const emptyBackup: MaterializedPortableBackup = {
      manifest: {
        kind: 'manifest',
        format: 'deepseek-streamarchive-backup',
        formatVersion: 1,
        createdAt: Date.now(),
        appVersion: '0.1.0',
        sourceDatabase: 'StreamArchiveDB',
        sourceDatabaseVersion: 9,
        encoding: 'utf-8',
        compression: 'gzip',
        includedStores: ['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'],
        excludedStores: ['canonical_checkpoints', 'history_staging', 'history_staging_manifests', 'context_continuity_receipts'],
        privacy: {
          containsConversationContent: false,
          containsReasoning: false,
          containsRecoveredContent: false,
          containsRawNetworkEvidence: false,
        },
      },
      records: {
        conversations: [],
        messages: [],
        revisions: [],
        recovery_events: [],
        raw_streams: [],
        raw_stream_batches: [],
      },
      footer: {
        kind: 'footer',
        complete: true,
        counts: {
          conversations: 0,
          messages: 0,
          revisions: 0,
          recovery_events: 0,
          raw_streams: 0,
          raw_stream_batches: 0,
        },
      },
    };

    await executeAtomicReplace(db, emptyBackup);

    const afterReplace = await repo.getContinuityReceipt('deliv-001');
    expect(afterReplace).toBeNull();
  });
});
