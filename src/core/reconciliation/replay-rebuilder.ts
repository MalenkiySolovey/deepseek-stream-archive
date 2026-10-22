import type { StorageRepository, ReplayPromotionPlan } from '../contracts';
import type { RawStreamRecord, RawStreamBatch } from '../../storage/raw-journal/types';
import { replayRawStream } from '../../storage/raw-journal/replay';
import { evaluateCanonicalPromotion } from '../../storage/raw-journal/promotion-gate';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../models';
import { computeContentFingerprint, makeProvisionalMessageId } from '../models';

export interface ReplayRebuildResult {
  promoted: boolean;
  reason?: string;
  conversationId?: string;
  messageId?: string;
  revisionsCount: number;
  recoveryEventsCount: number;
}

export class ReplayRebuilder {
  constructor(private readonly storage: StorageRepository) {}

  /**
   * Replays raw journal evidence and rebuilds canonical entities if eligible under promotion gate.
   */
  async rebuildStream(
    stream: RawStreamRecord,
    batches: RawStreamBatch[]
  ): Promise<ReplayRebuildResult> {
    const replayResult = replayRawStream(stream, batches);
    const evaluation = evaluateCanonicalPromotion(stream, replayResult);

    if (!evaluation.eligible) {
      return {
        promoted: false,
        reason: `Promotion rejected by gate: ${evaluation.reason || 'not_eligible'}`,
        revisionsCount: 0,
        recoveryEventsCount: 0,
      };
    }

    const now = Date.now();
    const sessionId = stream.provisionalSessionId || `replay_session_${stream.streamId}`;

    // 1. Conversation
    let conversation = await this.storage.getConversationByRemoteId(sessionId);
    if (!conversation) {
      conversation = {
        id: typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `conv_${sessionId}`,
        remoteId: sessionId,
        title: `Replayed Chat ${sessionId.slice(0, 8)}`,
        createdAt: stream.openedAt || now,
        updatedAt: stream.finalizedAt || now,
      };
    }

    // 2. Message
    const remoteMessageId = replayResult.diagnostics.activeMessageId || undefined;
    let existingMsg: Message | null = null;
    if (remoteMessageId) {
      existingMsg = await this.storage.getMessageByRemoteId(conversation.id, remoteMessageId);
    }

    const deterministicMessageId = makeProvisionalMessageId(stream.id);
    const messageId = existingMsg?.id || deterministicMessageId;

    let status: Message['status'] = 'finished';
    if (evaluation.terminalOutcome === 'filtered') {
      status = 'filtered';
    } else if (stream.state === 'degraded') {
      status = 'degraded';
    } else if (stream.state === 'aborted') {
      status = 'interrupted';
    }

    // Merge policy: reconciled > provisional; do not overwrite finished/filtered with degraded
    let finalStatus = status;
    if (existingMsg) {
      if (existingMsg.status === 'filtered' || existingMsg.status === 'finished') {
        finalStatus = existingMsg.status;
      }
    }

    const identityState = existingMsg?.identityState === 'reconciled' ? 'reconciled' : 'provisional';

    const message: Message = {
      id: messageId,
      remoteId: remoteMessageId || existingMsg?.remoteId,
      conversationId: conversation.id,
      parentId: existingMsg?.parentId,
      remoteParentId: existingMsg?.remoteParentId,
      content: existingMsg?.content,
      sourceRawStreamKey: stream.id,
      identityState,
      role: 'assistant',
      status: finalStatus,
      createdAt: existingMsg?.createdAt || stream.openedAt || now,
      updatedAt: stream.finalizedAt || now,
    };

    // 3. Revisions & Last-Good (Idempotent: 0 duplicates on repeated replay)
    const existingRevisions = await this.storage.listRevisionsByMessage(messageId);
    const existingRevIds = new Set(existingRevisions.map((r) => r.id));
    const existingRecoveryEvents = await this.storage.listRecoveryEvents(messageId);
    const existingRecIds = new Set(existingRecoveryEvents.map((r) => r.id));

    const revisionsToPut: ResponseRevision[] = [];
    const recoveryEventsToPut: RecoveryEvent[] = [];

    if (evaluation.isCensored && evaluation.lastGoodText) {
      // Content filter triggered: preserve pre-filter response as isLastGood revision
      const lastGoodRevId = `rev_replay_lastgood_${messageId}`;
      if (!existingRevIds.has(lastGoodRevId)) {
        const lastGoodRev: ResponseRevision = {
          id: lastGoodRevId,
          messageId,
          revisionIndex: existingRevisions.length + revisionsToPut.length,
          text: evaluation.lastGoodText,
          thinking: evaluation.lastGoodThinking,
          source: 'replay',
          capturedAt: stream.finalizedAt || now,
          isFinal: false,
          isLastGood: true,
          contentFingerprint: computeContentFingerprint(
            evaluation.lastGoodText,
            evaluation.lastGoodThinking,
            'incomplete',
            'replay'
          ),
        };
        revisionsToPut.push(lastGoodRev);
      }

      const recId = `rec_replay_${messageId}`;
      if (!existingRecIds.has(recId)) {
        const recoveryEvent: RecoveryEvent = {
          id: recId,
          messageId,
          kind: 'content_filter',
          detectedAt: stream.finalizedAt || now,
          recoveredRevisionId: lastGoodRevId,
          reason: 'Replayed raw journal stream contains CONTENT_FILTER terminal event',
        };
        recoveryEventsToPut.push(recoveryEvent);
      }

      // Final filtered template revision
      const filteredRevId = `rev_replay_final_${messageId}`;
      if (!existingRevIds.has(filteredRevId)) {
        const filteredRev: ResponseRevision = {
          id: filteredRevId,
          messageId,
          revisionIndex: existingRevisions.length + revisionsToPut.length,
          text: evaluation.candidateText,
          thinking: evaluation.candidateThinking.length > 0 ? evaluation.candidateThinking : undefined,
          source: 'replay',
          capturedAt: stream.finalizedAt || now,
          isFinal: true,
          isLastGood: false,
          contentFingerprint: computeContentFingerprint(
            evaluation.candidateText,
            evaluation.candidateThinking,
            'filtered',
            'replay'
          ),
        };
        revisionsToPut.push(filteredRev);
      }
    } else {
      // Standard completed response
      const normalRevId = `rev_replay_${messageId}_0`;
      if (!existingRevIds.has(normalRevId)) {
        const normalRev: ResponseRevision = {
          id: normalRevId,
          messageId,
          revisionIndex: existingRevisions.length + revisionsToPut.length,
          text: evaluation.candidateText,
          thinking: evaluation.candidateThinking.length > 0 ? evaluation.candidateThinking : undefined,
          source: 'replay',
          capturedAt: stream.finalizedAt || now,
          isFinal: true,
          isLastGood: false,
          contentFingerprint: computeContentFingerprint(
            evaluation.candidateText,
            evaluation.candidateThinking,
            'finished',
            'replay'
          ),
        };
        revisionsToPut.push(normalRev);
      }
    }

    // Single atomic transaction across all stores
    const plan: ReplayPromotionPlan = {
      conversation,
      message,
      revisions: revisionsToPut,
      recoveryEvents: recoveryEventsToPut,
    };
    await this.storage.applyReplayPromotionPlan(plan);

    return {
      promoted: true,
      conversationId: conversation.id,
      messageId,
      revisionsCount: revisionsToPut.length,
      recoveryEventsCount: recoveryEventsToPut.length,
    };
  }
}
