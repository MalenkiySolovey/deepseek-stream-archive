import { describe, it, expect } from 'vitest';
import type {
  Conversation,
  Message,
  MessageRole,
  MessageStatus,
  ResponseRevision,
  RecoveryEvent,
  RecoveryKind,
  CaptureSource,
} from '../src/core/models';

describe('Domain Models & Invariant Rules', () => {
  describe('Conversation Model', () => {
    it('creates a valid conversation with local and optional remote metadata', () => {
      const conv: Conversation = {
        id: 'conv-local-1',
        title: 'DeepSeek Research Session',
        createdAt: 1710000000000,
        updatedAt: 1710000005000,
        remoteId: 'deepseek-chat-9988',
      };

      expect(conv.id).toBe('conv-local-1');
      expect(conv.remoteId).toBe('deepseek-chat-9988');
      expect(conv.updatedAt).toBeGreaterThanOrEqual(conv.createdAt);
    });

    it('round-trips conversation through JSON serialization without data loss', () => {
      const conv: Conversation = {
        id: 'conv-json',
        title: 'JSON roundtrip',
        createdAt: 100,
        updatedAt: 200,
      };

      const serialized = JSON.stringify(conv);
      const parsed = JSON.parse(serialized) as Conversation;

      expect(parsed).toEqual(conv);
    });
  });

  describe('Message Model', () => {
    it('supports valid roles and statuses', () => {
      const validRoles: MessageRole[] = ['user', 'assistant', 'system', 'unknown'];
      const validStatuses: MessageStatus[] = [
        'streaming',
        'finished',
        'filtered',
        'incomplete',
        'timeout',
        'context_length_exceeded',
        'interrupted',
        'degraded',
        'unknown',
      ];

      for (const role of validRoles) {
        for (const status of validStatuses) {
          const msg: Message = {
            id: `msg-${role}-${status}`,
            conversationId: 'conv-test',
            identityState: 'provisional',
            role,
            status,
            createdAt: 1000,
            updatedAt: 2000,
          };
          expect(msg.role).toBe(role);
          expect(msg.status).toBe(status);
          expect(msg.identityState).toBe('provisional');
        }
      }
    });

    it('supports message tree threading via parentId and remoteParentId', () => {
      const parentMsg: Message = {
        id: 'msg-parent',
        remoteId: 'remote-parent-1',
        conversationId: 'conv-thread',
        identityState: 'reconciled',
        role: 'user',
        status: 'finished',
        createdAt: 1000,
        updatedAt: 1000,
      };

      const childMsg: Message = {
        id: 'msg-child',
        remoteId: 'remote-child-1',
        conversationId: 'conv-thread',
        parentId: parentMsg.id,
        remoteParentId: parentMsg.remoteId,
        sourceRawStreamKey: 'prod1:stream1',
        identityState: 'reconciled',
        role: 'assistant',
        status: 'finished',
        createdAt: 1005,
        updatedAt: 1010,
      };

      expect(childMsg.parentId).toBe(parentMsg.id);
      expect(childMsg.remoteParentId).toBe(parentMsg.remoteId);
      expect(childMsg.sourceRawStreamKey).toBe('prod1:stream1');
      expect(childMsg.conversationId).toBe(parentMsg.conversationId);
    });
  });

  describe('ResponseRevision Model', () => {
    it('supports granular revision journaling with thinking and source metadata', () => {
      const validSources: CaptureSource[] = ['network', 'history', 'dom', 'replay', 'synthetic'];

      validSources.forEach((source, index) => {
        const rev: ResponseRevision = {
          id: `rev-${index}`,
          messageId: 'msg-target',
          revisionIndex: index,
          text: `Revision text from ${source}`,
          thinking: `Detailed chain-of-thought tokens for ${source}`,
          source,
          capturedAt: 1710000000000 + index * 1000,
          isFinal: index === validSources.length - 1,
          isLastGood: true,
        };

        expect(rev.source).toBe(source);
        expect(rev.revisionIndex).toBe(index);
        expect(rev.thinking).toBeDefined();
      });
    });

    it('correctly models censored / recalled state where last good revision differs from final', () => {
      const lastGoodRev: ResponseRevision = {
        id: 'rev-good',
        messageId: 'msg-target',
        revisionIndex: 0,
        text: 'Detailed uncensored technical answer captured from stream',
        source: 'synthetic',
        capturedAt: 1710000000,
        isFinal: false,
        isLastGood: true,
      };

      const censoredRev: ResponseRevision = {
        id: 'rev-censored',
        messageId: 'msg-target',
        revisionIndex: 1,
        text: "I'm sorry, I cannot continue this response.",
        source: 'synthetic',
        capturedAt: 1710000005,
        isFinal: true,
        isLastGood: false,
      };

      expect(lastGoodRev.isLastGood).toBe(true);
      expect(censoredRev.isLastGood).toBe(false);
      expect(censoredRev.isFinal).toBe(true);
      expect(lastGoodRev.revisionIndex).toBeLessThan(censoredRev.revisionIndex);
    });
  });

  describe('RecoveryEvent Model', () => {
    it('supports all recovery classification kinds', () => {
      const kinds: RecoveryKind[] = [
        'content_filter',
        'template_response',
        'network_interruption',
        'dom_replacement',
        'synthetic',
      ];

      for (const kind of kinds) {
        const event: RecoveryEvent = {
          id: `evt-${kind}`,
          messageId: 'msg-rec',
          kind,
          detectedAt: Date.now(),
          recoveredRevisionId: 'rev-good',
          reason: `Triggered by ${kind} rule`,
        };

        expect(event.kind).toBe(kind);
        expect(event.recoveredRevisionId).toBe('rev-good');
      }
    });
  });
});
