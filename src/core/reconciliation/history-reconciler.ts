import type { StorageRepository, HistoryReconciliationPlan } from '../contracts';
import type {
  Conversation,
  Message,
  ResponseRevision,
} from '../models';
import type { DeepSeekParsedHistory } from '../../adapters/deepseek/history/types';

export interface HistoryReconciliationResult {
  conversationId: string;
  isNewConversation: boolean;
  messagesCreated: number;
  messagesUpdated: number;
  revisionsCreated: number;
  treeLinksResolved: number;
}

import { computeContentFingerprint } from '../models';
export { computeContentFingerprint };

export class HistoryReconciler {
  constructor(private readonly storage: StorageRepository) {}

  /**
   * Reconciles a passively captured server history payload into the canonical storage model.
   *
   * Enforces:
   * 1. Strong-identity matching: exact remoteId matching.
   * 2. Atomic two-pass parent resolution: remoteParentId -> local parentId without graph cycles.
   * 3. Sibling branching: sibling branches sharing parentId remain distinct.
   * 4. Network last-good preservation: uncensored lastGood revisions are never overwritten by history.
   * 5. Stable content fingerprinting: identical content produces 0 duplicate revisions; updated content appends revision.
   * 6. User content preservation in Message.content.
   * 7. Atomic batch commit via HistoryReconciliationPlan.
   */
  async createPlan(
    parsed: DeepSeekParsedHistory
  ): Promise<{ plan: HistoryReconciliationPlan; result: HistoryReconciliationResult }> {
    const { session, messages } = parsed;
    const now = Date.now();

    // ── Phase 1: Conversation Reconciliation ──
    const existingConv = await this.storage.getConversationByRemoteId(session.sessionId);
    let isNewConversation = false;
    let conversation: Conversation;

    if (!existingConv) {
      conversation = {
        id: typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `conv_${session.sessionId}`,
        remoteId: session.sessionId,
        title: session.title,
        createdAt: session.updatedAt || now,
        updatedAt: Math.max(session.updatedAt || now, now),
      };
      isNewConversation = true;
    } else {
      conversation = {
        ...existingConv,
        title: session.title || existingConv.title,
        updatedAt: Math.max(session.updatedAt || existingConv.updatedAt, existingConv.updatedAt),
      };
    }

    // ── Phase 2: Message Reconciliation & Revisions Planning ──
    const existingMessages = await this.storage.listMessagesByConversation(conversation.id);
    const existingByRemoteId = new Map<string, Message>();
    for (const em of existingMessages) {
      if (em.remoteId) {
        existingByRemoteId.set(em.remoteId, em);
      }
    }

    let messagesCreated = 0;
    let messagesUpdated = 0;
    let revisionsCreated = 0;

    const messagesToPut: Message[] = [];
    const revisionsToPut: ResponseRevision[] = [];

    for (const hm of messages) {
      const existing = existingByRemoteId.get(hm.messageId);

      if (existing) {
        // Message already exists from live streaming or previous history
        const updatedMsg: Message = { ...existing };
        let modified = false;

        // Upgrade identity state to reconciled
        if (updatedMsg.identityState !== 'reconciled') {
          updatedMsg.identityState = 'reconciled';
          modified = true;
        }

        // Reconcile remoteParentId if missing
        if (hm.parentId && updatedMsg.remoteParentId !== hm.parentId) {
          updatedMsg.remoteParentId = hm.parentId;
          modified = true;
        }

        // Reconcile terminal status if currently streaming or unknown, or if server marks filtered
        if (hm.status === 'filtered' && updatedMsg.status !== 'filtered') {
          updatedMsg.status = 'filtered';
          modified = true;
        } else if (
          (updatedMsg.status === 'streaming' || updatedMsg.status === 'unknown') &&
          hm.status !== updatedMsg.status
        ) {
          updatedMsg.status = hm.status;
          modified = true;
        }

        // For user messages, preserve prompt text in content
        if (hm.role === 'user' && hm.text.length > 0 && !updatedMsg.content) {
          updatedMsg.content = hm.text;
          modified = true;
        }

        // Evaluate revisions using content fingerprinting
        if (hm.text.length > 0 || hm.thinking) {
          const currentRevisions = await this.storage.listRevisionsByMessage(updatedMsg.id);
          const historyRevisions = currentRevisions.filter((r) => r.source === 'history');
          const latestHist = historyRevisions[historyRevisions.length - 1];
          const incomingFingerprint = computeContentFingerprint(hm.text, hm.thinking);

          // Check if latest history revision is identical to incoming payload (Idempotency)
          const isIdentical =
            latestHist &&
            (latestHist.contentFingerprint
              ? latestHist.contentFingerprint === incomingFingerprint
              : latestHist.text === hm.text && (latestHist.thinking || '') === (hm.thinking || ''));

          if (!isIdentical) {
            // Content has evolved or this is the first history revision
            const revIndex = currentRevisions.length;
            const histRev: ResponseRevision = {
              id: typeof crypto !== 'undefined' && crypto.randomUUID
                ? crypto.randomUUID()
                : `rev_hist_${updatedMsg.id}_${revIndex}`,
              messageId: updatedMsg.id,
              revisionIndex: revIndex,
              text: hm.text,
              thinking: hm.thinking,
              source: 'history',
              capturedAt: hm.createdAt || now,
              isFinal: true,
              isLastGood: false, // Invariant: network uncensored lastGood revision is preserved and never overwritten
              contentFingerprint: incomingFingerprint,
            };
            revisionsToPut.push(histRev);
            revisionsCreated++;
          }
        }

        if (modified) {
          updatedMsg.updatedAt = now;
          messagesToPut.push(updatedMsg);
          existingByRemoteId.set(hm.messageId, updatedMsg);
          messagesUpdated++;
        }
      } else {
        // New message discovered through history
        const newMsgId =
          typeof crypto !== 'undefined' && crypto.randomUUID
            ? crypto.randomUUID()
            : `msg_hist_${hm.messageId}`;

        const newMsg: Message = {
          id: newMsgId,
          remoteId: hm.messageId,
          conversationId: conversation.id,
          remoteParentId: hm.parentId || undefined,
          identityState: 'reconciled',
          role: hm.role,
          status: hm.status,
          content: hm.role === 'user' ? hm.text : undefined,
          createdAt: hm.createdAt || now,
          updatedAt: hm.createdAt || now,
        };

        messagesToPut.push(newMsg);
        existingByRemoteId.set(hm.messageId, newMsg);
        messagesCreated++;

        if (hm.text.length > 0 || hm.thinking) {
          const rev: ResponseRevision = {
            id: typeof crypto !== 'undefined' && crypto.randomUUID
              ? crypto.randomUUID()
              : `rev_${newMsgId}_0`,
            messageId: newMsgId,
            revisionIndex: 0,
            text: hm.text,
            thinking: hm.thinking,
            source: 'history',
            capturedAt: hm.createdAt || now,
            isFinal: true,
            isLastGood: false,
            contentFingerprint: computeContentFingerprint(hm.text, hm.thinking),
          };
          revisionsToPut.push(rev);
          revisionsCreated++;
        }
      }
    }

    // ── Phase 3: Two-Pass Parent Link Resolution with Cycle Detection ──
    const combinedMessages = new Map<string, Message>();
    for (const em of existingMessages) {
      combinedMessages.set(em.id, em);
    }
    for (const pm of messagesToPut) {
      combinedMessages.set(pm.id, pm);
    }

    const remoteToLocalMap = new Map<string, string>();
    for (const m of combinedMessages.values()) {
      if (m.remoteId) {
        remoteToLocalMap.set(m.remoteId, m.id);
      }
    }

    let treeLinksResolved = 0;

    for (const m of combinedMessages.values()) {
      if (m.remoteParentId) {
        const expectedParentId = remoteToLocalMap.get(m.remoteParentId);
        if (expectedParentId && expectedParentId !== m.id) {
          // Cycle check: verify expectedParentId does not lead back to m.id
          let current: string | undefined = expectedParentId;
          let hasCycle = false;
          const visited = new Set<string>([m.id]);

          while (current) {
            if (visited.has(current)) {
              hasCycle = true;
              break;
            }
            visited.add(current);
            const parentMsg = combinedMessages.get(current);
            current = parentMsg?.parentId;
          }

          if (!hasCycle && m.parentId !== expectedParentId) {
            m.parentId = expectedParentId;
            treeLinksResolved++;
            if (!messagesToPut.some((p) => p.id === m.id)) {
              messagesToPut.push(m);
            }
          }
        }
      }
    }

    const plan: HistoryReconciliationPlan = {
      conversation,
      messagesToPut,
      revisionsToPut,
      treeLinksResolved,
    };

    const result: HistoryReconciliationResult = {
      conversationId: conversation.id,
      isNewConversation,
      messagesCreated,
      messagesUpdated,
      revisionsCreated,
      treeLinksResolved,
    };

    return { plan, result };
  }

  async reconcile(parsed: DeepSeekParsedHistory): Promise<HistoryReconciliationResult> {
    const { plan, result } = await this.createPlan(parsed);
    await this.storage.applyHistoryReconciliationPlan(plan);
    return result;
  }
}
