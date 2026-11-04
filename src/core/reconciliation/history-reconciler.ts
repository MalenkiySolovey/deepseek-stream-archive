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

import { computeContentFingerprint, isLogicalMessage } from '../models';
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
    const existingConv =
      (await this.storage.getConversationByRemoteId(session.sessionId)) ||
      (await this.storage.getConversation(session.sessionId));
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
        currentMessageId: session.currentMessageId || undefined,
      };
      isNewConversation = true;
    } else {
      conversation = {
        ...existingConv,
        title: session.title || existingConv.title,
        updatedAt: Math.max(session.updatedAt || existingConv.updatedAt, existingConv.updatedAt),
        currentMessageId: session.currentMessageId || existingConv.currentMessageId || undefined,
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

    // Index unmatched provisional user messages for linking to authoritative server history
    const unmatchedProvisionalUser = existingMessages.filter(
      (m) => m.role === 'user' && !m.remoteId && m.identityState !== 'reconciled'
    );
    // Index unmatched provisional assistant messages for linking to authoritative server history
    const unmatchedProvisionalAssistant = existingMessages.filter(
      (m) => m.role === 'assistant' && !m.remoteId && m.identityState !== 'reconciled'
    );

    let messagesCreated = 0;
    let messagesUpdated = 0;
    let revisionsCreated = 0;

    const messagesToPut: Message[] = [];
    const revisionsToPut: ResponseRevision[] = [];

    for (const hm of messages) {
      let existing = existingByRemoteId.get(hm.messageId);

      // Associate unmatched provisional user turn with authoritative history turn
      if (!existing && hm.role === 'user') {
        const matchIdx = unmatchedProvisionalUser.findIndex((cand) => {
          // Content must always match between user turns
          if (!cand.content || !hm.text || cand.content !== hm.text) {
            return false;
          }

          if (hm.parentId) {
            // Child turn: parent must be confirmed
            if (cand.remoteParentId && cand.remoteParentId === hm.parentId) {
              return true;
            }
            if (cand.parentId) {
              const localParent = existingMessages.find((m) => m.id === cand.parentId);
              if (localParent?.remoteId && localParent.remoteId === hm.parentId) {
                return true;
              }
            }
            // Without proven parentage, do not match child turns
            return false;
          } else {
            // Root turn: cand must also be root (no parent)
            if (cand.remoteParentId || cand.parentId) {
              return false;
            }
            // Disambiguation: Ensure no other root candidate has the exact same content
            const duplicateRoots = unmatchedProvisionalUser.filter(
              (c) => !c.remoteParentId && !c.parentId && c.content === hm.text
            );
            // Invariant: Server history must also contain exactly ONE root message with this content
            const serverDuplicateRoots = messages.filter(
              (m) => m.role === 'user' && !m.parentId && m.text === hm.text
            );
            if (serverDuplicateRoots.length !== 1) {
              return false;
            }
            if (duplicateRoots.length === 1) {
              return true;
            }
            // If multiple provisional roots exist (e.g. from network transport retries),
            // match the unique one that has a logical assistant child:
            const candidatesWithLogicalChild = duplicateRoots.filter(
              (c) =>
                existingMessages.some(
                  (m) => m.role === 'assistant' && m.parentId === c.id && isLogicalMessage(m)
                ) ||
                messagesToPut.some(
                  (m) => m.role === 'assistant' && m.parentId === c.id && isLogicalMessage(m)
                )
            );
            if (candidatesWithLogicalChild.length === 1 && candidatesWithLogicalChild[0]!.id === cand.id) {
              return true;
            }
            return false;
          }
        });
        if (matchIdx >= 0) {
          existing = unmatchedProvisionalUser.splice(matchIdx, 1)[0]!;
          existing.remoteId = hm.messageId;
          existingByRemoteId.set(hm.messageId, existing);
        }
      }

      // Associate unmatched provisional assistant turn with authoritative history turn
      if (!existing && hm.role === 'assistant') {
        const parentUser = hm.parentId ? existingByRemoteId.get(hm.parentId) : undefined;
        const matchIdx = unmatchedProvisionalAssistant.findIndex((cand) => {
          // 1. Negative parent disqualification:
          if (cand.remoteParentId && hm.parentId && cand.remoteParentId !== hm.parentId) {
            return false;
          }
          if (
            parentUser &&
            cand.parentId &&
            cand.parentId !== parentUser.id &&
            existingMessages.some((m) => m.id === cand.parentId)
          ) {
            return false;
          }

          // 2. Positive proof of identity requires confirmed parentage match or ghost parent with verified content:
          const hasParentMatch = Boolean(
            (parentUser && cand.parentId && cand.parentId === parentUser.id) ||
            (cand.remoteParentId && hm.parentId && cand.remoteParentId === hm.parentId)
          );

          const isGhostParentWithContentMatch = Boolean(
            parentUser &&
            cand.parentId &&
            !existingMessages.some((m) => m.id === cand.parentId) &&
            cand.content &&
            hm.text &&
            cand.content.trim() === hm.text.trim()
          );

          if (!hasParentMatch && !isGhostParentWithContentMatch) {
            // Invariant: Never match an assistant message without confirmed parentage or verified content proof!
            // Identical text alone on live messages or conversation-wide uniqueness is NEVER proof of identity.
            return false;
          }

          // 3. Content matching & Filtered message handling
          const candText = (cand.content || '').trim();
          const histText = (hm.text || '').trim();

          const isCandFiltered = cand.status === 'filtered';
          const isHmFiltered = hm.status === 'filtered' || hm.isFiltered || Boolean(hm.templateResponse);

          // All candidates under this confirmed parent
          const candidatesUnderParent = unmatchedProvisionalAssistant.filter((c) =>
            Boolean(
              (parentUser && c.parentId && c.parentId === parentUser.id) ||
              (c.remoteParentId && hm.parentId && c.remoteParentId === hm.parentId) ||
              (parentUser && c.parentId && !existingMessages.some((m) => m.id === c.parentId) && c.content && hm.text && c.content.trim() === hm.text.trim())
            )
          );

          // Invariant: A filtered candidate can NEVER match a normal server message,
          // and a normal candidate can NEVER match a filtered server message!
          if (Boolean(isCandFiltered) !== Boolean(isHmFiltered)) {
            return false;
          }

          if (isCandFiltered && isHmFiltered) {
            // When a message is filtered, DeepSeek replaces server content with a canned template response.
            // Consequently, candidate text (the pre-filter content) and server text (the template response)
            // will NEVER match by content equality.
            const filteredCandidates = candidatesUnderParent.filter((c) => c.status === 'filtered');
            const filteredServer = messages.filter(
              (m) =>
                m.role === 'assistant' &&
                (m.parentId || undefined) === (hm.parentId || undefined) &&
                (m.status === 'filtered' || m.isFiltered || Boolean(m.templateResponse))
            );

            // Strict disambiguation: Only match if there is exactly 1 filtered candidate AND
            // exactly 1 filtered server message under this confirmed parent!
            // If there are multiple filtered regenerates or multiple filtered server messages,
            // never guess! Keep them separate and leave remoteId unresolved.
            if (filteredCandidates.length === 1 && filteredServer.length === 1) {
              return cand.id === filteredCandidates[0]!.id;
            }
            return false;
          }

          if (candText !== histText) {
            return false;
          }

          // 4. Disambiguation under this confirmed parent for normal messages:
          const sameTextCandidatesUnderParent = candidatesUnderParent.filter(
            (c) => (c.content || '').trim() === histText
          );

          // Server history messages under same parent with identical content (e.g. Regenerate responses with identical text)
          const sameTextServerUnderParent = messages.filter(
            (m) =>
              m.role === 'assistant' &&
              (m.parentId || undefined) === (hm.parentId || undefined) &&
              (m.text || '').trim() === histText
          );

          // Invariant: If there are multiple regenerate variants with identical text under the same parent
          // (either locally or on the server), do NOT guess! Keep records separate until proven.
          return (
            sameTextCandidatesUnderParent.length === 1 &&
            sameTextServerUnderParent.length === 1
          );
        });
        if (matchIdx >= 0) {
          existing = unmatchedProvisionalAssistant.splice(matchIdx, 1)[0]!;
          existing.remoteId = hm.messageId;
          existingByRemoteId.set(hm.messageId, existing);
        }
      }

      if (existing) {
        // Message already exists from live streaming or previous history
        const updatedMsg: Message = { ...existing };
        let modified = false;

        // Upgrade identity state to reconciled and projectionState to logical
        if (updatedMsg.identityState !== 'reconciled') {
          updatedMsg.identityState = 'reconciled';
          modified = true;
        }
        if (updatedMsg.projectionState !== 'logical') {
          updatedMsg.projectionState = 'logical';
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
          if (hm.continuityDeliveryId && !updatedMsg.contextContinuityDeliveryId) {
            updatedMsg.contextContinuityDeliveryId = hm.continuityDeliveryId;
          }
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
          projectionState: 'logical',
          role: hm.role,
          status: hm.status,
          content: hm.role === 'user' ? hm.text : undefined,
          contextContinuityDeliveryId: hm.continuityDeliveryId,
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

    // ── Phase 2b: Unmatched Provisional Messages Classification ──
    const matchedRemoteIds = new Set(messages.map((m) => m.messageId));
    for (const em of existingMessages) {
      if (em.remoteId && matchedRemoteIds.has(em.remoteId)) {
        continue;
      }
      if (em.identityState === 'reconciled') {
        continue;
      }

      if (em.role === 'user') {
        // Distinguish genuine alternate user edit branches from unfulfilled technical transport retries:
        // A technical transport retry:
        // 1. Has NO logical assistant children in this conversation
        // 2. An identical reconciled user turn exists in the conversation with identical parentage (both root or identical parent)
        const hasLogicalAssistant =
          existingMessages.some(
            (a) => a.role === 'assistant' && a.parentId === em.id && isLogicalMessage(a)
          ) ||
          messagesToPut.some(
            (a) => a.role === 'assistant' && a.parentId === em.id && isLogicalMessage(a)
          );

        const emParentKey = em.parentId || em.remoteParentId || '__root__';
        const hasReconciledDuplicateTurn =
          existingMessages.some((other) => {
            if (other.id === em.id || other.role !== 'user' || other.identityState !== 'reconciled') return false;
            if (other.content?.trim() !== em.content?.trim()) return false;
            const otherParentKey = other.parentId || other.remoteParentId || '__root__';
            return otherParentKey === emParentKey;
          }) ||
          messagesToPut.some((other) => {
            if (other.id === em.id || other.role !== 'user' || other.identityState !== 'reconciled') return false;
            if (other.content?.trim() !== em.content?.trim()) return false;
            const otherParentKey = other.parentId || other.remoteParentId || '__root__';
            return otherParentKey === emParentKey;
          });

        if (!hasLogicalAssistant && hasReconciledDuplicateTurn) {
          if (em.projectionState !== 'attempt_only') {
            const updatedMsg: Message = {
              ...em,
              projectionState: 'attempt_only',
              parentId: undefined,
              updatedAt: now,
            };
            const existingIdx = messagesToPut.findIndex((p) => p.id === em.id);
            if (existingIdx >= 0) {
              messagesToPut[existingIdx] = updatedMsg;
            } else {
              messagesToPut.push(updatedMsg);
              messagesUpdated++;
            }
          }
          continue;
        }

        // Genuine user turn (e.g. alternate user edit branch with content):
        if (em.content && em.content.trim().length > 0) {
          if (em.projectionState !== 'provisional_logical' && em.projectionState !== 'logical') {
            const updatedMsg: Message = {
              ...em,
              projectionState: 'provisional_logical',
              updatedAt: now,
            };
            const existingIdx = messagesToPut.findIndex((p) => p.id === em.id);
            if (existingIdx >= 0) {
              messagesToPut[existingIdx] = updatedMsg;
            } else {
              messagesToPut.push(updatedMsg);
              messagesUpdated++;
            }
          }
        }
        continue;
      }

      if (em.role !== 'assistant') {
        continue;
      }

      // Check whether this unmatched provisional assistant message has any captured revisions or recovery events
      const currentRevs = await this.storage.listRevisionsByMessage(em.id);
      const currentRecs = await this.storage.listRecoveryEvents(em.id);
      const isRecovered =
        em.status === 'filtered' ||
        currentRecs.length > 0 ||
        currentRevs.some((r) => r.isLastGood);

      if (isRecovered) {
        // Invariant: Filtered/recovered messages are NEVER degraded to unmatched_capture!
        // DeepSeek omits censored responses from history, but StreamArchive preserves them as logical turns.
        if (em.projectionState !== 'provisional_logical' || em.status !== 'filtered') {
          const updatedMsg: Message = {
            ...em,
            projectionState: 'provisional_logical',
            status: 'filtered',
            updatedAt: now,
          };
          const existingIdx = messagesToPut.findIndex((p) => p.id === em.id);
          if (existingIdx >= 0) {
            messagesToPut[existingIdx] = updatedMsg;
          } else {
            messagesToPut.push(updatedMsg);
            messagesUpdated++;
          }
        }
        continue;
      }

      // Invariant: Completed assistant generations (e.g. from prior regenerate branches)
      // must NOT be degraded to unmatched_capture or have parentId wiped!
      // They represent legitimate alternate response variants in the conversation tree.
      if (em.status === 'finished') {
        if (em.projectionState !== 'provisional_logical' && em.projectionState !== 'logical') {
          const updatedMsg: Message = {
            ...em,
            projectionState: 'provisional_logical',
            updatedAt: now,
          };
          const existingIdx = messagesToPut.findIndex((p) => p.id === em.id);
          if (existingIdx >= 0) {
            messagesToPut[existingIdx] = updatedMsg;
          } else {
            messagesToPut.push(updatedMsg);
            messagesUpdated++;
          }
        }
        continue;
      }

      const hasContent =
        (em.content && em.content.trim().length > 0) ||
        currentRevs.some((r) => r.text.length > 0 || (r.thinking && r.thinking.length > 0));

      const targetProjection: import('../models').MessageProjectionState = hasContent
        ? 'unmatched_capture'
        : 'attempt_only';

      if (em.projectionState !== targetProjection || em.parentId !== undefined) {
        const updatedMsg: Message = {
          ...em,
          projectionState: targetProjection,
          parentId: undefined, // Invariant: Unmatched captures and attempts NEVER branch under the user prompt
          updatedAt: now,
        };
        const existingIdx = messagesToPut.findIndex((p) => p.id === em.id);
        if (existingIdx >= 0) {
          messagesToPut[existingIdx] = updatedMsg;
        } else {
          messagesToPut.push(updatedMsg);
          messagesUpdated++;
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
      // INVARIANT: Only logical messages are linked as children in the conversation tree.
      // attempt_only and unmatched_capture records must NEVER have parentId assigned.
      if (!isLogicalMessage(m)) {
        if (m.parentId !== undefined) {
          m.parentId = undefined;
          if (!messagesToPut.some((p) => p.id === m.id)) {
            messagesToPut.push(m);
          }
        }
        continue;
      }

      let expectedParentId: string | undefined;
      if (m.remoteParentId) {
        expectedParentId = remoteToLocalMap.get(m.remoteParentId);
      }
      if (!expectedParentId && m.parentId) {
        if (remoteToLocalMap.has(m.parentId)) {
          expectedParentId = remoteToLocalMap.get(m.parentId);
        } else if (combinedMessages.has(m.parentId)) {
          expectedParentId = m.parentId;
        }
      }
      if (!expectedParentId && m.remoteParentId) {
        const targetRemote = String(m.remoteParentId);
        const sibling = Array.from(combinedMessages.values()).find(
          (other) =>
            other.id !== m.id &&
            other.role === m.role &&
            other.remoteParentId &&
            String(other.remoteParentId) === targetRemote &&
            other.parentId
        );
        if (sibling?.parentId && combinedMessages.has(sibling.parentId)) {
          expectedParentId = sibling.parentId;
        }
      }
      if (!expectedParentId && m.role === 'assistant') {
        const candidateUser = Array.from(combinedMessages.values()).find(
          (u) =>
            u.role === 'user' &&
            ((m.sourceRawStreamKey && u.sourceRawStreamKey === m.sourceRawStreamKey) ||
              (m.remoteParentId && u.remoteId === m.remoteParentId))
        );
        if (candidateUser) {
          expectedParentId = candidateUser.id;
        }
      }
      if (!expectedParentId && m.parentId && combinedMessages.has(m.parentId)) {
        expectedParentId = m.parentId;
      }

      if (expectedParentId && expectedParentId !== m.id) {
          const parentMsg = combinedMessages.get(expectedParentId);
          // Invariant: Assistant message parent MUST be a user message!
          // User message parent MUST be an assistant message (or null).
          const isRoleValid =
            (m.role === 'assistant' && (!parentMsg || parentMsg.role === 'user')) ||
            (m.role === 'user' && (!parentMsg || parentMsg.role === 'assistant'));

          if (!isRoleValid) {
            continue;
          }

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
            const parent = combinedMessages.get(current);
            current = parent?.parentId;
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
