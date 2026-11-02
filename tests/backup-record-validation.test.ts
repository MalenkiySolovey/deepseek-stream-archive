import { describe, it, expect } from 'vitest';
import {
  validateConversationRecord,
  validateMessageRecord,
  validateRevisionRecord,
  validateRecoveryEventRecord,
  validateRawStreamRecord,
  validateRawStreamBatchRecord,
  isRecordSemanticallyIdentical,
} from '../src/backup/record-validation';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';
import type { RawStreamRecord, RawStreamBatch } from '../src/storage/raw-journal/types';

describe('Backup Record Validation (Field-Level DB Schema V8 Contracts)', () => {
  describe('validateConversationRecord', () => {
    it('accepts valid conversation', () => {
      const conv: Conversation = {
        id: 'conv-1',
        title: 'Quantum Computing',
        createdAt: 1700000000000,
        updatedAt: 1700000001000,
        remoteId: 'remote-chat-123',
      };
      const res = validateConversationRecord(conv);
      expect(res.valid).toBe(true);
      expect(res.record?.id).toBe('conv-1');
    });

    it('rejects invalid or missing required fields', () => {
      expect(validateConversationRecord(null).valid).toBe(false);
      expect(validateConversationRecord({ id: '', title: 'T', createdAt: 1, updatedAt: 1 }).valid).toBe(false);
      expect(validateConversationRecord({ id: '1', title: 123, createdAt: 1, updatedAt: 1 }).valid).toBe(false);
      expect(validateConversationRecord({ id: '1', title: 'T', createdAt: -5, updatedAt: 1 }).valid).toBe(false);
      expect(validateConversationRecord({ id: '1', title: 'T', createdAt: 1, updatedAt: NaN }).valid).toBe(false);
      expect(validateConversationRecord({ id: '1', title: 'T', createdAt: 1, updatedAt: 1, remoteId: 42 }).valid).toBe(false);
    });
  });

  describe('validateMessageRecord', () => {
    it('accepts valid logical assistant message', () => {
      const msg: Message = {
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        projectionState: 'logical',
        content: 'Hello world',
        createdAt: 1700000002000,
        updatedAt: 1700000003000,
      };
      const res = validateMessageRecord(msg);
      expect(res.valid).toBe(true);
      expect(res.record?.role).toBe('assistant');
    });

    it('rejects invalid roles, statuses, and projectionStates', () => {
      const base: Message = {
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'assistant',
        status: 'finished',
        identityState: 'reconciled',
        createdAt: 1700000002000,
        updatedAt: 1700000003000,
      };

      expect(validateMessageRecord({ ...base, role: 'invalid_role' }).valid).toBe(false);
      expect(validateMessageRecord({ ...base, status: 'invalid_status' }).valid).toBe(false);
      expect(validateMessageRecord({ ...base, identityState: 'invalid_identity' }).valid).toBe(false);
      expect(validateMessageRecord({ ...base, projectionState: 'bad_projection' }).valid).toBe(false);
    });
  });

  describe('validateRevisionRecord', () => {
    it('accepts valid revision with thinking and lastGood', () => {
      const rev: ResponseRevision = {
        id: 'rev-1',
        messageId: 'msg-1',
        revisionIndex: 0,
        text: 'The answer is 42.',
        thinking: 'Let me think...',
        source: 'network',
        capturedAt: 1700000002500,
        isFinal: true,
        isLastGood: true,
        contentFingerprint: 'fp_123',
      };
      const res = validateRevisionRecord(rev);
      expect(res.valid).toBe(true);
      expect(res.record?.text).toBe('The answer is 42.');
    });

    it('rejects negative revisionIndex or non-boolean flags', () => {
      const base: ResponseRevision = {
        id: 'rev-1',
        messageId: 'msg-1',
        revisionIndex: -1,
        text: 'test',
        source: 'network',
        capturedAt: 1000,
        isFinal: true,
        isLastGood: false,
      };
      expect(validateRevisionRecord(base).valid).toBe(false);
      expect(validateRevisionRecord({ ...base, revisionIndex: 0, isFinal: 'yes' }).valid).toBe(false);
      expect(validateRevisionRecord({ ...base, revisionIndex: 0, source: 'unknown_source' }).valid).toBe(false);
    });
  });

  describe('validateRecoveryEventRecord', () => {
    it('accepts valid recovery event', () => {
      const rec: RecoveryEvent = {
        id: 'rec-1',
        messageId: 'msg-1',
        kind: 'content_filter',
        detectedAt: 1700000003000,
        recoveredRevisionId: 'rev-1',
        reason: 'Server triggered CONTENT_FILTER',
      };
      const res = validateRecoveryEventRecord(rec);
      expect(res.valid).toBe(true);
    });

    it('rejects invalid kind or missing recoveredRevisionId', () => {
      expect(validateRecoveryEventRecord({ id: 'r', messageId: 'm', kind: 'bad', detectedAt: 1, recoveredRevisionId: 'rev' }).valid).toBe(false);
      expect(validateRecoveryEventRecord({ id: 'r', messageId: 'm', kind: 'content_filter', detectedAt: 1, recoveredRevisionId: '' }).valid).toBe(false);
    });
  });

  describe('validateRawStreamRecord & RawStreamBatch', () => {
    it('accepts valid raw stream and batch', () => {
      const stream: RawStreamRecord = {
        id: 'session-1:stream-1',
        producerSessionId: 'session-1',
        streamId: 'stream-1',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion',
        method: 'POST',
        state: 'completed',
        openedAt: 1700000000000,
        updatedAt: 1700000005000,
        totalChunks: 10,
        totalChars: 500,
        totalBatches: 2,
      };
      expect(validateRawStreamRecord(stream).valid).toBe(true);

      const batch: RawStreamBatch = {
        id: 'session-1:stream-1:1',
        streamKey: 'session-1:stream-1',
        batchSeq: 1,
        chunks: [
          { streamSequence: 0, chunkText: 'data: {"chunk": 1}\n\n', timestamp: 1700000001000 },
        ],
        createdAt: 1700000001000,
        charCount: 22,
      };
      expect(validateRawStreamBatchRecord(batch).valid).toBe(true);
    });

    it('rejects malformed raw stream or negative counts', () => {
      expect(validateRawStreamRecord({ id: '1', producerSessionId: 's', streamId: '1', transport: 'ws' }).valid).toBe(false);
      expect(validateRawStreamBatchRecord({ id: '1', streamKey: 'k', batchSeq: -1, chunks: [], createdAt: 1, charCount: 0 }).valid).toBe(false);
    });
  });

  describe('isRecordSemanticallyIdentical', () => {
    it('identifies exact conversation duplicates', () => {
      const a: Conversation = { id: 'c1', title: 'T', createdAt: 100, updatedAt: 200, remoteId: 'r1' };
      const b: Conversation = { id: 'c1', title: 'T', createdAt: 100, updatedAt: 200, remoteId: 'r1' };
      const c: Conversation = { id: 'c1', title: 'Modified', createdAt: 100, updatedAt: 200, remoteId: 'r1' };

      expect(isRecordSemanticallyIdentical('conversations', a, b)).toBe(true);
      expect(isRecordSemanticallyIdentical('conversations', a, c)).toBe(false);
    });

    it('identifies exact message duplicates and detects differences', () => {
      const a: Message = { id: 'm1', conversationId: 'c1', role: 'assistant', status: 'finished', identityState: 'reconciled', createdAt: 100, updatedAt: 200 };
      const b: Message = { id: 'm1', conversationId: 'c1', role: 'assistant', status: 'finished', identityState: 'reconciled', createdAt: 100, updatedAt: 200 };
      const changedContent: Message = { ...a, content: 'Different text' };

      expect(isRecordSemanticallyIdentical('messages', a, b)).toBe(true);
      expect(isRecordSemanticallyIdentical('messages', a, changedContent)).toBe(false);
    });

    it('identifies exact revision duplicates', () => {
      const a: ResponseRevision = { id: 'r1', messageId: 'm1', revisionIndex: 0, text: 'hi', source: 'network', capturedAt: 100, isFinal: true, isLastGood: false };
      const b: ResponseRevision = { id: 'r1', messageId: 'm1', revisionIndex: 0, text: 'hi', source: 'network', capturedAt: 100, isFinal: true, isLastGood: false };
      const changedText: ResponseRevision = { ...a, text: 'hello' };

      expect(isRecordSemanticallyIdentical('revisions', a, b)).toBe(true);
      expect(isRecordSemanticallyIdentical('revisions', a, changedText)).toBe(false);
    });
  });
});
