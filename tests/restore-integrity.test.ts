import { describe, it, expect } from 'vitest';
import { validateBackupReferentialIntegrity } from '../src/restore/integrity';
import type { MaterializedPortableBackup } from '../src/backup/reader';
import { PORTABLE_BACKUP_FORMAT, PORTABLE_BACKUP_FORMAT_VERSION } from '../src/backup/format';

function makeBaseBackup(): MaterializedPortableBackup {
  return {
    manifest: {
      kind: 'manifest',
      format: PORTABLE_BACKUP_FORMAT,
      formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
      createdAt: 1700000000000,
      appVersion: '0.1.0',
      sourceDatabase: 'StreamArchiveDB',
      sourceDatabaseVersion: 8,
      encoding: 'utf-8',
      compression: 'gzip',
      includedStores: ['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'],
      excludedStores: ['canonical_checkpoints', 'history_staging', 'history_staging_manifests'],
      privacy: {
        containsConversationContent: true,
        containsReasoning: true,
        containsRecoveredContent: true,
        containsRawNetworkEvidence: true,
      },
    },
    records: {
      conversations: [
        { id: 'conv-1', title: 'Conversation 1', createdAt: 100, updatedAt: 200 },
      ],
      messages: [
        {
          id: 'msg-u1',
          conversationId: 'conv-1',
          role: 'user',
          status: 'finished',
          identityState: 'reconciled',
          projectionState: 'logical',
          createdAt: 110,
          updatedAt: 110,
        },
        {
          id: 'msg-a1',
          conversationId: 'conv-1',
          parentId: 'msg-u1',
          role: 'assistant',
          status: 'finished',
          identityState: 'reconciled',
          projectionState: 'logical',
          createdAt: 120,
          updatedAt: 120,
        },
      ],
      revisions: [
        {
          id: 'rev-1',
          messageId: 'msg-a1',
          revisionIndex: 0,
          text: 'Hello user',
          source: 'network',
          capturedAt: 120,
          isFinal: true,
          isLastGood: true,
        },
      ],
      recovery_events: [],
      raw_streams: [
        {
          id: 'p1:s1',
          producerSessionId: 'p1',
          streamId: 's1',
          transport: 'fetch',
          url: 'https://chat.deepseek.com/chat/completion',
          method: 'POST',
          state: 'completed',
          openedAt: 115,
          updatedAt: 125,
          totalChunks: 2,
          totalChars: 50,
          totalBatches: 1,
        },
      ],
      raw_stream_batches: [
        {
          id: 'p1:s1:1',
          streamKey: 'p1:s1',
          batchSeq: 1,
          chunks: [{ streamSequence: 0, chunkText: 'data: 1\n\n', timestamp: 116 }],
          createdAt: 116,
          charCount: 11,
        },
      ],
    },
    footer: {
      kind: 'footer',
      complete: true,
      counts: {
        conversations: 1,
        messages: 2,
        revisions: 1,
        recovery_events: 0,
        raw_streams: 1,
        raw_stream_batches: 1,
      },
    },
  };
}

describe('Referential Integrity Validation (Pre-Commit Graph Safety)', () => {
  it('passes on a valid consistent relational graph', () => {
    const backup = makeBaseBackup();
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  it('rejects orphan message pointing to missing conversation', () => {
    const backup = makeBaseBackup();
    backup.records.messages[0]!.conversationId = 'non-existent-conv';
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'orphan_message')).toBe(true);
  });

  it('rejects message with self-parent link', () => {
    const backup = makeBaseBackup();
    backup.records.messages[0]!.parentId = backup.records.messages[0]!.id;
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'self_parent_cycle')).toBe(true);
  });

  it('rejects message pointing to missing parent message', () => {
    const backup = makeBaseBackup();
    backup.records.messages[1]!.parentId = 'ghost-parent-msg';
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'missing_parent_message')).toBe(true);
  });

  it('rejects message pointing to cross-conversation parent', () => {
    const backup = makeBaseBackup();
    backup.records.conversations.push({ id: 'conv-2', title: 'Conv 2', createdAt: 300, updatedAt: 300 });
    backup.records.messages.push({
      id: 'msg-u2',
      conversationId: 'conv-2',
      parentId: 'msg-u1', // Parent is in conv-1!
      role: 'user',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      createdAt: 310,
      updatedAt: 310,
    });
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'cross_conversation_parent')).toBe(true);
  });

  it('rejects message tree cycles (A -> B -> C -> A)', () => {
    const backup = makeBaseBackup();
    // conv-1 has msg-u1 and msg-a1 (parent: msg-u1)
    // Make msg-u1 point to msg-a1:
    backup.records.messages[0]!.parentId = 'msg-a1';
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'parent_cycle_detected')).toBe(true);
  });

  it('rejects attempt_only or unmatched_capture messages with parent links (2D.3 invariant)', () => {
    const backup = makeBaseBackup();
    backup.records.messages[1]!.projectionState = 'attempt_only';
    // msg-a1 has parentId = 'msg-u1'
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'attempt_only_has_parent')).toBe(true);

    backup.records.messages[1]!.projectionState = 'unmatched_capture';
    const res2 = validateBackupReferentialIntegrity(backup);
    expect(res2.valid).toBe(false);
    expect(res2.errors.some((e) => e.code === 'unmatched_capture_has_parent')).toBe(true);
  });

  it('rejects orphan revision pointing to missing message', () => {
    const backup = makeBaseBackup();
    backup.records.revisions[0]!.messageId = 'ghost-msg';
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'orphan_revision')).toBe(true);
  });

  it('rejects recovery event pointing to missing recovered revision or mismatch message', () => {
    const backup = makeBaseBackup();
    backup.records.recovery_events.push({
      id: 'rec-1',
      messageId: 'msg-a1',
      kind: 'content_filter',
      detectedAt: 125,
      recoveredRevisionId: 'ghost-rev',
    });
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'missing_recovered_revision')).toBe(true);

    // Mismatched message
    backup.records.recovery_events[0]!.recoveredRevisionId = 'rev-1';
    backup.records.recovery_events[0]!.messageId = 'msg-u1'; // rev-1 belongs to msg-a1!
    const res2 = validateBackupReferentialIntegrity(backup);
    expect(res2.valid).toBe(false);
    expect(res2.errors.some((e) => e.code === 'recovered_revision_message_mismatch')).toBe(true);

    // Not lastGood
    backup.records.recovery_events[0]!.messageId = 'msg-a1';
    backup.records.revisions[0]!.isLastGood = false;
    const res3 = validateBackupReferentialIntegrity(backup);
    expect(res3.valid).toBe(false);
    expect(res3.errors.some((e) => e.code === 'recovered_revision_not_last_good')).toBe(true);
  });

  it('rejects orphan raw batch pointing to missing raw stream', () => {
    const backup = makeBaseBackup();
    backup.records.raw_stream_batches[0]!.streamKey = 'missing-stream-key';
    const res = validateBackupReferentialIntegrity(backup);
    expect(res.valid).toBe(false);
    expect(res.errors.some((e) => e.code === 'orphan_raw_batch')).toBe(true);
  });
});
