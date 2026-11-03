import { describe, it, expect } from 'vitest';
import type { Message, ResponseRevision, RecoveryEvent } from '../src/core/models';
import {
  evaluateContinuityEligibility,
  getRecoveryCause,
  findUsableRevision,
} from '../src/context-continuity/eligibility';
import type { ContinuityRecoveryCause } from '../src/context-continuity/types';

describe('Context Continuity Eligibility Evaluator', () => {
  const conversationId = 'conv-test-123';

  function createTestMessage(overrides?: Partial<Message>): Message {
    return {
      id: 'msg-assistant-1',
      conversationId,
      identityState: 'provisional',
      role: 'assistant',
      createdAt: 1000,
      updatedAt: 1000,
      status: 'finished',
      ...overrides,
    };
  }

  function createTestRevision(overrides?: Partial<ResponseRevision>): ResponseRevision {
    return {
      id: 'rev-1',
      messageId: 'msg-assistant-1',
      revisionIndex: 1,
      source: 'network',
      text: 'Recovered answer text from local archive.',
      capturedAt: 1000,
      isFinal: true,
      isLastGood: false,
      ...overrides,
    };
  }

  describe('Mandatory Invariant: Recovery Cause is Forensic Metadata, Not an Eligibility Filter', () => {
    const causesToTest: Array<{
      label: string;
      expectedCause: ContinuityRecoveryCause;
      recoveryEvent?: RecoveryEvent;
      messageOverrides?: Partial<Message>;
    }> = [
      {
        label: 'content_filter (censorship recovery)',
        expectedCause: 'content_filter',
        recoveryEvent: {
          id: 'rec-1',
          messageId: 'msg-assistant-1',
          recoveredRevisionId: 'rev-1',
          kind: 'content_filter',
          reason: 'Sensitive topic filtered by server',
          detectedAt: 1000,
        },
      },
      {
        label: 'template_response (safe canned fallback)',
        expectedCause: 'template_response',
        recoveryEvent: {
          id: 'rec-2',
          messageId: 'msg-assistant-1',
          recoveredRevisionId: 'rev-1',
          kind: 'template_response',
          reason: 'Sorry, that is beyond my current scope',
          detectedAt: 1000,
        },
      },
      {
        label: 'network_interruption (socket drop / XHR failure)',
        expectedCause: 'network_interruption',
        recoveryEvent: {
          id: 'rec-3',
          messageId: 'msg-assistant-1',
          recoveredRevisionId: 'rev-1',
          kind: 'network_interruption',
          reason: 'Stream transport closed prematurely',
          detectedAt: 1000,
        },
      },
      {
        label: 'user_stop (client-side generation halt)',
        expectedCause: 'user_stop',
        recoveryEvent: {
          id: 'rec-4',
          messageId: 'msg-assistant-1',
          recoveredRevisionId: 'rev-1',
          kind: 'network_interruption',
          reason: 'user_stop manually clicked',
          detectedAt: 1000,
        },
      },
      {
        label: 'client_abort (navigation or tab close abort)',
        expectedCause: 'client_abort',
        recoveryEvent: {
          id: 'rec-5',
          messageId: 'msg-assistant-1',
          recoveredRevisionId: 'rev-1',
          kind: 'network_interruption',
          reason: 'client_abort signal',
          detectedAt: 1000,
        },
      },
    ];

    for (const testCase of causesToTest) {
      it(`evaluates identically as eligible for cause: ${testCase.label}`, () => {
        const msg = createTestMessage(testCase.messageOverrides);
        const rev = createTestRevision({ messageId: msg.id, isLastGood: true });
        const events = testCase.recoveryEvent ? [testCase.recoveryEvent] : [];

        const result = evaluateContinuityEligibility({
          message: msg,
          revisions: [rev],
          recoveryEvents: events,
          activeBranchMessageIds: new Set([msg.id]),
          targetConversationId: conversationId,
        });

        expect(result.eligible).toBe(true);
        expect(result.reason).toBe('eligible');
        expect(result.recoveryCause).toBe(testCase.expectedCause);
        expect(result.candidateRevision?.id).toBe(rev.id);
      });
    }
  });

  describe('Structural Eligibility Conditions', () => {
    it('excludes messages from another conversation (conversation_mismatch)', () => {
      const msg = createTestMessage({ conversationId: 'other-conv' });
      const rev = createTestRevision();

      const result = evaluateContinuityEligibility({
        message: msg,
        revisions: [rev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([msg.id]),
        targetConversationId: conversationId,
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('conversation_mismatch');
    });

    it('excludes user messages (not_logical_assistant)', () => {
      const msg = createTestMessage({ role: 'user' });
      const rev = createTestRevision();

      const result = evaluateContinuityEligibility({
        message: msg,
        revisions: [rev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([msg.id]),
        targetConversationId: conversationId,
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('not_logical_assistant');
    });

    it('excludes non-logical attempt-only or unmatched messages (not_logical_assistant)', () => {
      const attemptMsg = createTestMessage({ projectionState: 'attempt_only' });
      const unmatchedMsg = createTestMessage({ projectionState: 'unmatched_capture' });
      const rev = createTestRevision();

      const resAttempt = evaluateContinuityEligibility({
        message: attemptMsg,
        revisions: [rev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([attemptMsg.id]),
        targetConversationId: conversationId,
      });
      expect(resAttempt.eligible).toBe(false);
      expect(resAttempt.reason).toBe('not_logical_assistant');

      const resUnmatched = evaluateContinuityEligibility({
        message: unmatchedMsg,
        revisions: [rev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([unmatchedMsg.id]),
        targetConversationId: conversationId,
      });
      expect(resUnmatched.eligible).toBe(false);
      expect(resUnmatched.reason).toBe('not_logical_assistant');
    });

    it('excludes messages not in the active branch (wrong_branch)', () => {
      const msg = createTestMessage();
      const rev = createTestRevision();

      const result = evaluateContinuityEligibility({
        message: msg,
        revisions: [rev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set(['different-branch-msg']),
        targetConversationId: conversationId,
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('wrong_branch');
    });

    it('excludes messages already in server history by message id or remoteId (already_in_server_history)', () => {
      const msg = createTestMessage({ remoteId: 'remote-123' });
      const rev = createTestRevision();

      // Check by message id
      const resById = evaluateContinuityEligibility({
        message: msg,
        revisions: [rev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([msg.id]),
        targetConversationId: conversationId,
        serverHistoryAuthoritativeIds: new Set([msg.id]),
      });
      expect(resById.eligible).toBe(false);
      expect(resById.reason).toBe('already_in_server_history');

      // Check by remoteId
      const resByRemoteId = evaluateContinuityEligibility({
        message: msg,
        revisions: [rev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([msg.id]),
        targetConversationId: conversationId,
        serverHistoryAuthoritativeIds: new Set(['remote-123']),
      });
      expect(resByRemoteId.eligible).toBe(false);
      expect(resByRemoteId.reason).toBe('already_in_server_history');
    });

    it('excludes reconciled finished assistant messages with history revision (already_in_server_history)', () => {
      const msg = createTestMessage({ identityState: 'reconciled', status: 'finished' });
      const historyRev = createTestRevision({ source: 'history', text: 'Server history text' });

      const result = evaluateContinuityEligibility({
        message: msg,
        revisions: [historyRev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([msg.id]),
        targetConversationId: conversationId,
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('already_in_server_history');
    });

    it('excludes messages marked as already bridged into context (already_bridged)', () => {
      const msg = createTestMessage();
      const rev = createTestRevision();

      const result = evaluateContinuityEligibility({
        message: msg,
        revisions: [rev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([msg.id]),
        targetConversationId: conversationId,
        alreadyBridgedIds: new Set([msg.id]),
      });

      expect(result.eligible).toBe(false);
      expect(result.reason).toBe('already_bridged');
    });

    it('excludes messages with no revisions or only empty whitespace revisions (no_usable_revision)', () => {
      const msg = createTestMessage();

      // No revisions
      const resNoRev = evaluateContinuityEligibility({
        message: msg,
        revisions: [],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([msg.id]),
        targetConversationId: conversationId,
      });
      expect(resNoRev.eligible).toBe(false);
      expect(resNoRev.reason).toBe('no_usable_revision');

      // Empty revision
      const emptyRev = createTestRevision({ text: '   ', thinking: ' ' });
      const resEmpty = evaluateContinuityEligibility({
        message: msg,
        revisions: [emptyRev],
        recoveryEvents: [],
        activeBranchMessageIds: new Set([msg.id]),
        targetConversationId: conversationId,
      });
      expect(resEmpty.eligible).toBe(false);
      expect(resEmpty.reason).toBe('no_usable_revision');
    });
  });

  describe('Usable Revision Priority', () => {
    it('prioritizes revision pointed to by RecoveryEvent.recoveredRevisionId', () => {
      const msg = createTestMessage();
      const rev1 = createTestRevision({ id: 'rev-1', text: 'Text 1', isLastGood: true });
      const rev2 = createTestRevision({ id: 'rev-2', text: 'Text 2 (Recovered)' });
      const event: RecoveryEvent = {
        id: 'ev-1',
        messageId: msg.id,
        recoveredRevisionId: 'rev-2',
        kind: 'content_filter',
        reason: 'filtered',
        detectedAt: 1000,
      };

      const usable = findUsableRevision(msg, [rev1, rev2], [event]);
      expect(usable?.id).toBe('rev-2');
    });

    it('prioritizes isLastGood revision when no RecoveryEvent pointer exists', () => {
      const msg = createTestMessage();
      const rev1 = createTestRevision({ id: 'rev-1', text: 'Draft 1' });
      const rev2 = createTestRevision({ id: 'rev-2', text: 'Last Good Text', isLastGood: true });
      const rev3 = createTestRevision({ id: 'rev-3', text: 'Subsequent broken text' });

      const usable = findUsableRevision(msg, [rev1, rev2, rev3]);
      expect(usable?.id).toBe('rev-2');
    });

    it('allows revision with empty text but non-empty thinking', () => {
      const msg = createTestMessage();
      const rev = createTestRevision({ id: 'rev-think', text: '', thinking: 'Deep reasoning process.' });

      const usable = findUsableRevision(msg, [rev]);
      expect(usable?.id).toBe('rev-think');
      expect(usable?.thinking).toBe('Deep reasoning process.');
    });
  });

  describe('Recovery Cause Extraction', () => {
    it('falls back to message.status when no RecoveryEvent exists', () => {
      const filteredMsg = createTestMessage({ status: 'filtered' });
      expect(getRecoveryCause(filteredMsg)).toBe('content_filter');

      const interruptedMsg = createTestMessage({ status: 'interrupted' });
      expect(getRecoveryCause(interruptedMsg)).toBe('network_interruption');

      const regularMsg = createTestMessage({ status: 'finished' });
      expect(getRecoveryCause(regularMsg)).toBe('unknown');
    });
  });
});
