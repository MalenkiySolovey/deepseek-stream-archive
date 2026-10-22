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

export interface Message {
  id: string;
  remoteId?: string;
  conversationId: string;
  parentId?: string;
  remoteParentId?: string;
  sourceRawStreamKey?: string;
  identityState: MessageIdentityState;
  role: MessageRole;
  status: MessageStatus;
  content?: string;
  remoteCreatedAt?: number;
  createdAt: number;
  updatedAt: number;
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

  // 2. Identity & Tree linkages: never clear existing values if incoming is missing/undefined
  const remoteId = incoming.remoteId || existing.remoteId;
  const parentId = incoming.parentId || existing.parentId;
  const remoteParentId = incoming.remoteParentId || existing.remoteParentId;
  const content = incoming.content || existing.content;
  const sourceRawStreamKey = incoming.sourceRawStreamKey || existing.sourceRawStreamKey;

  // 3. Status Merge Policy
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
    role: existing.role === 'unknown' ? incoming.role : existing.role,
    status,
    content,
    remoteCreatedAt: existing.remoteCreatedAt || incoming.remoteCreatedAt,
    createdAt: existing.createdAt || incoming.createdAt,
    updatedAt: Math.max(existing.updatedAt, incoming.updatedAt),
  };
}
