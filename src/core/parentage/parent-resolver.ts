import type { Message, MessageRole } from '../models';
import { logger } from '../../shared/logger';

/**
 * Validates strict role alternation invariant between a child message and its proposed parent.
 *
 * Rules:
 * 1. A USER message's parent must be an ASSISTANT, or null/undefined (if root).
 *    USER -> USER is strictly prohibited.
 * 2. An ASSISTANT message's parent must be a USER.
 *    ASSISTANT -> ASSISTANT is strictly prohibited.
 *    ASSISTANT without a parent is not a valid logical turn.
 */
export function isValidRoleParentage(
  childRole: MessageRole,
  parentRole?: MessageRole | null
): boolean {
  if (childRole === 'user') {
    if (!parentRole) return true; // root user prompt
    return parentRole === 'assistant';
  }

  if (childRole === 'assistant') {
    return parentRole === 'user';
  }

  // System or other roles
  return true;
}

export interface ResolvedParentResult {
  parentId?: string;
  matchedBy?: 'direct_remote_id' | 'direct_local_id' | 'stream_key' | 'sibling_match';
  confirmedUserRemoteId?: string;
}

/**
 * Resolves the parent ID for a USER message within a conversation.
 *
 * Priority:
 * 1. Direct confirmed match: an assistant message whose remoteId or id matches userMsg.remoteParentId
 * 2. Confirmed sibling match: another user turn in this conversation that shares the same remoteParentId
 *    and already has a verified assistant parentId (Edit fork).
 *
 * Invariant: Never guesses chronologically. If unresolvable, returns undefined.
 */
export function resolveUserParent(
  userMsg: Message,
  existingMsgs: Message[]
): ResolvedParentResult {
  if (!userMsg.remoteParentId) {
    return {};
  }

  const targetRemote = String(userMsg.remoteParentId).trim();
  if (targetRemote === '' || targetRemote === '0' || targetRemote === 'null' || targetRemote === 'undefined') {
    return {};
  }

  // 1. Direct match: assistant message with remoteId or local id matching remoteParentId
  const directAssistant = existingMsgs.find(
    (m) =>
      m.role === 'assistant' &&
      m.conversationId === userMsg.conversationId &&
      ((m.remoteId && String(m.remoteId) === targetRemote) || m.id === targetRemote)
  );

  if (directAssistant && isValidRoleParentage('user', directAssistant.role)) {
    return {
      parentId: directAssistant.id,
      matchedBy: directAssistant.id === targetRemote ? 'direct_local_id' : 'direct_remote_id',
    };
  }

  // 2. Sibling user turn match (Edit branch fork): if another user turn in this conversation
  // already shares the same remoteParentId, this user turn is an Edit sibling branching under the same parent!
  const siblingUser = existingMsgs.find(
    (m) =>
      m.role === 'user' &&
      m.id !== userMsg.id &&
      m.conversationId === userMsg.conversationId &&
      m.remoteParentId &&
      String(m.remoteParentId) === targetRemote &&
      m.parentId
  );

  if (siblingUser?.parentId) {
    const parentCandidate = existingMsgs.find(
      (m) => m.id === siblingUser.parentId && m.conversationId === userMsg.conversationId
    );
    if (parentCandidate && isValidRoleParentage('user', parentCandidate.role)) {
      return {
        parentId: parentCandidate.id,
        matchedBy: 'sibling_match',
      };
    }
  }

  return {};
}

/**
 * Resolves the parent ID for an ASSISTANT message within a conversation.
 *
 * Priority:
 * 1. Confirmed local request / stream match: user message with identical sourceRawStreamKey
 * 2. Direct confirmed server match: user message with remoteId matching asstMsg.remoteParentId
 * 3. Confirmed sibling assistant match: another assistant with identical non-empty remoteParentId
 *    that has a verified user parentId (Regenerate variant).
 *
 * Invariant: Zero chronological guessing! Never picks the last-finished assistant or last user.
 */
export function resolveAssistantParent(
  asstMsg: Message,
  existingMsgs: Message[]
): ResolvedParentResult {
  const targetConvId = asstMsg.conversationId;
  const remoteParent = asstMsg.remoteParentId ? String(asstMsg.remoteParentId).trim() : undefined;

  // 1. Local live generation pairing via sourceRawStreamKey
  if (asstMsg.sourceRawStreamKey) {
    const streamUser = existingMsgs.find(
      (m) =>
        m.role === 'user' &&
        m.conversationId === targetConvId &&
        m.sourceRawStreamKey === asstMsg.sourceRawStreamKey
    );
    if (streamUser && isValidRoleParentage('assistant', streamUser.role)) {
      return {
        parentId: streamUser.id,
        matchedBy: 'stream_key',
        confirmedUserRemoteId: remoteParent,
      };
    }
  }

  if (!remoteParent || remoteParent === '' || remoteParent === '0' || remoteParent === 'null' || remoteParent === 'undefined') {
    return {};
  }

  // 2. Direct match by remoteId of user message
  const directUser = existingMsgs.find(
    (m) =>
      m.role === 'user' &&
      m.conversationId === targetConvId &&
      m.remoteId &&
      String(m.remoteId) === remoteParent
  );

  if (directUser && isValidRoleParentage('assistant', directUser.role)) {
    return {
      parentId: directUser.id,
      matchedBy: 'direct_remote_id',
    };
  }

  // 3. Sibling assistant match (Regenerate variant): another assistant shares the same remoteParentId
  const siblingAsst = existingMsgs.find(
    (m) =>
      m.role === 'assistant' &&
      m.id !== asstMsg.id &&
      m.conversationId === targetConvId &&
      m.remoteParentId &&
      String(m.remoteParentId) === remoteParent &&
      m.parentId
  );

  if (siblingAsst?.parentId) {
    const parentCandidate = existingMsgs.find(
      (m) => m.id === siblingAsst.parentId && m.conversationId === targetConvId
    );
    if (parentCandidate && isValidRoleParentage('assistant', parentCandidate.role)) {
      return {
        parentId: parentCandidate.id,
        matchedBy: 'sibling_match',
        confirmedUserRemoteId: remoteParent,
      };
    }
  }

  // Zero guesswork: if not proven, leave unresolved!
  return {};
}

export interface AssignRemoteIdResult {
  assigned: boolean;
  conflictWithId?: string;
  previousRemoteId?: string;
}

/**
 * Assigns a server remoteId to a message safely, checking for conflicts.
 *
 * Invariant: Within a single conversation, no two distinct local messages may claim
 * the same remoteId. If another message already holds this remoteId, records conflict
 * and refuses assignment.
 */
export function assignRemoteIdSafely(
  targetMsg: Message,
  candidateRemoteId: string | undefined,
  existingMsgs: Message[]
): AssignRemoteIdResult {
  if (!candidateRemoteId) {
    return { assigned: false };
  }

  const cleaned = String(candidateRemoteId).trim();
  if (cleaned === '' || cleaned === '0' || cleaned === 'null' || cleaned === 'undefined') {
    return { assigned: false };
  }

  // Check if target already has this exact remoteId
  if (targetMsg.remoteId && String(targetMsg.remoteId) === cleaned) {
    return { assigned: true, previousRemoteId: targetMsg.remoteId };
  }

  // Check for conflicts across existing messages in the same conversation
  const conflicting = existingMsgs.find(
    (m) =>
      m.id !== targetMsg.id &&
      m.conversationId === targetMsg.conversationId &&
      m.remoteId &&
      String(m.remoteId) === cleaned
  );

  if (conflicting) {
    logger.warn(
      `[ParentResolver] RemoteId conflict detected: message ${targetMsg.id} attempted to claim remoteId ${cleaned}, but it is already held by message ${conflicting.id}. Assignment rejected.`
    );
    return {
      assigned: false,
      conflictWithId: conflicting.id,
      previousRemoteId: targetMsg.remoteId,
    };
  }

  targetMsg.remoteId = cleaned;
  return { assigned: true, previousRemoteId: targetMsg.remoteId };
}
