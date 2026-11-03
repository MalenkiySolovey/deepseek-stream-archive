export type MessageRole = 'user' | 'assistant' | 'system' | 'unknown';

export type MessageStatus =
  | 'streaming'
  | 'finished'
  | 'filtered'
  | 'incomplete'
  | 'timeout'
  | 'context_length_exceeded'
  | 'interrupted'
  | 'degraded'
  | 'unknown';

export type MessageIdentityState = 'provisional' | 'reconciled';

export type MessageProjectionState =
  | 'logical'
  | 'provisional_logical'
  | 'unmatched_capture'
  | 'attempt_only';

export interface Message {
  id: string;
  remoteId?: string;
  conversationId: string;
  parentId?: string;
  remoteParentId?: string;
  sourceRawStreamKey?: string;
  identityState: MessageIdentityState;
  projectionState?: MessageProjectionState;
  role: MessageRole;
  status: MessageStatus;
  content?: string;
  contextContinuityDeliveryId?: string;
  remoteCreatedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Pure helper to determine if a message represents a logical conversation turn.
 * Evaluates projectionState, falling back to role and identity for legacy records.
 */
export function isLogicalMessage(
  msg: Pick<Message, 'role' | 'identityState' | 'projectionState' | 'content'> & { status?: MessageStatus }
): boolean {
  if (msg.projectionState === 'logical' || msg.projectionState === 'provisional_logical') {
    return true;
  }
  if (msg.projectionState === 'attempt_only' || msg.projectionState === 'unmatched_capture') {
    return false;
  }
  // Legacy fallback:
  if (msg.identityState === 'reconciled') {
    return true;
  }
  if (msg.role === 'user' || msg.role === 'system') {
    return true;
  }
  if (msg.status === 'filtered' || msg.status === 'finished' || msg.status === 'streaming') {
    return true;
  }
  // For provisional assistant message with terminal failure status: only logical if it has content
  return (msg.content?.trim().length ?? 0) > 0;
}

export function isUnmatchedCapture(
  msg: Pick<Message, 'projectionState'>
): boolean {
  return msg.projectionState === 'unmatched_capture';
}

export function isAttemptOnly(
  msg: Pick<Message, 'projectionState'>
): boolean {
  return msg.projectionState === 'attempt_only';
}

/**
 * Generates a deterministic provisional Message ID from a raw stream key.
 * Guarantees unified local identity across live CanonicalRevisionRecorder and ReplayRebuilder.
 */
export function makeProvisionalMessageId(rawStreamKey: string): string {
  const sanitized = rawStreamKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `msg_${sanitized}`;
}

/**
 * Pure status and identity merge policy for canonical Messages.
 * Enforces:
 * - reconciled > provisional
 * - preservation of parentId, remoteParentId, content, sourceRawStreamKey
 * - non-destructive terminal status transitions (e.g. filtered never downgraded to finished or streaming)
 */
export function mergeCanonicalMessage(
  existing: Message | undefined,
  incoming: Message,
  provenance: 'live' | 'history' | 'replay'
): Message {
  if (!existing) {
    return incoming;
  }

  // 1. Identity State: reconciled > provisional
  const identityState: MessageIdentityState =
    existing.identityState === 'reconciled' || incoming.identityState === 'reconciled'
      ? 'reconciled'
      : 'provisional';

  // 2. Projection State:
  // - Reconciled identity implies logical projection
  // - Explicit incoming state overrides existing
  let projectionState: MessageProjectionState | undefined;
  if (identityState === 'reconciled') {
    projectionState = 'logical';
  } else if (incoming.projectionState) {
    projectionState = incoming.projectionState;
  } else {
    projectionState = existing.projectionState;
  }

  // 3. Identity & Tree linkages:
  // Invariant: attempt_only and unmatched_capture messages NEVER branch under parent
  const remoteId = incoming.remoteId || existing.remoteId;
  const parentId =
    projectionState === 'attempt_only' || projectionState === 'unmatched_capture'
      ? undefined
      : incoming.parentId !== undefined
      ? incoming.parentId
      : existing.parentId;
  const remoteParentId = incoming.remoteParentId || existing.remoteParentId;
  const content = incoming.content || existing.content;
  const sourceRawStreamKey = incoming.sourceRawStreamKey || existing.sourceRawStreamKey;

  // 4. Status Merge Policy
  let status: MessageStatus = existing.status;

  if (provenance === 'live') {
    if (existing.status === 'filtered') {
      status = 'filtered';
    } else if (incoming.status === 'filtered') {
      status = 'filtered';
    } else if (existing.status === 'finished') {
      status = 'finished';
    } else {
      status = incoming.status;
    }
  } else if (provenance === 'history') {
    if (existing.status === 'filtered' && incoming.status !== 'filtered') {
      status = 'filtered';
    } else {
      status = incoming.status;
    }
  } else if (provenance === 'replay') {
    if (existing.status === 'filtered' || existing.status === 'finished') {
      status = existing.status;
    } else {
      status = incoming.status;
    }
  }

  return {
    ...incoming,
    id: existing.id,
    remoteId,
    conversationId: existing.conversationId,
    parentId,
    remoteParentId,
    sourceRawStreamKey,
    identityState,
    projectionState,
    role: existing.role === 'unknown' ? incoming.role : existing.role,
    status,
    content,
    remoteCreatedAt: existing.remoteCreatedAt || incoming.remoteCreatedAt,
    createdAt: existing.createdAt || incoming.createdAt,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}
