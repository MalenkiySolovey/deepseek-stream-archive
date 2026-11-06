import type { Message } from '../models';
import type { StorageRepository, CanonicalCheckpointData } from '../contracts/storage-repository';
import {
  resolveUserParent,
  resolveAssistantParent,
  assignRemoteIdSafely,
  isValidRoleParentage,
} from '../parentage/parent-resolver';
import { logger } from '../../shared/logger';

export interface PersistUserTurnResult {
  success: boolean;
  messageId: string;
  parentId?: string;
  persistedAt: number;
  error?: string;
}

export interface PersistCanonicalCheckpointResult {
  success: boolean;
  streamKey: string;
  checkpointSeq: number;
  resolvedParentId?: string;
  error?: string;
}

/**
 * Production handler for persisting a user turn message with strict parentage resolution.
 * Used by both background.ts and test suites to eliminate code divergence.
 */
export async function persistUserTurnMessage(
  storageRepo: StorageRepository,
  userMsg: Message
): Promise<PersistUserTurnResult> {
  try {
    // 1. Ensure conversation record exists
    const existingConv = await storageRepo.getConversation(userMsg.conversationId);
    if (!existingConv) {
      await storageRepo.saveConversation({
        id: userMsg.conversationId,
        title: userMsg.content?.slice(0, 80) || 'New Conversation',
        createdAt: userMsg.createdAt,
        updatedAt: userMsg.updatedAt,
      });
    }

    // 2. Resolve parent link if remoteParentId was provided
    if (userMsg.remoteParentId && !userMsg.parentId) {
      try {
        const existingMsgs = await storageRepo.listMessagesByConversation(userMsg.conversationId);
        const resolved = resolveUserParent(userMsg, existingMsgs);
        if (resolved.parentId) {
          userMsg.parentId = resolved.parentId;
        }
      } catch (err) {
        logger.warn(`[CheckpointPersister] Failed resolving user parent: ${err}`);
      }
    }

    // 3. Strict role validation
    if (userMsg.parentId) {
      const existingMsgs = await storageRepo.listMessagesByConversation(userMsg.conversationId);
      const parentMsg = existingMsgs.find((m: Message) => m.id === userMsg.parentId);
      if (parentMsg && !isValidRoleParentage('user', parentMsg.role)) {
        logger.warn(
          `[CheckpointPersister] Rejected invalid role parentage: user message ${userMsg.id} cannot have ${parentMsg.role} message ${parentMsg.id} as parent`
        );
        userMsg.parentId = undefined;
      }
    }

    await storageRepo.saveMessages([userMsg]);

    return {
      success: true,
      messageId: userMsg.id,
      parentId: userMsg.parentId,
      persistedAt: Date.now(),
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error(`[CheckpointPersister] Error persisting user turn: ${errorMsg}`);
    return {
      success: false,
      messageId: userMsg.id,
      persistedAt: Date.now(),
      error: errorMsg,
    };
  }
}

/**
 * Production handler for persisting a canonical checkpoint with verified parentage and safe remoteId assignment.
 * Used by both background.ts and test suites to eliminate code divergence.
 */
export async function persistCanonicalCheckpointMessage(
  storageRepo: StorageRepository,
  checkpoint: CanonicalCheckpointData
): Promise<PersistCanonicalCheckpointResult> {
  const streamKey = checkpoint.streamKey;
  const checkpointSeq = checkpoint.checkpointSeq;

  try {
    const targetConvId = checkpoint.conversation?.id || checkpoint.message.conversationId;

    if (checkpoint.message.role === 'assistant' && targetConvId) {
      const asstMsg = checkpoint.message;
      const remoteParent = asstMsg.remoteParentId ? String(asstMsg.remoteParentId).trim() : undefined;

      const existingMsgs = await storageRepo.listMessagesByConversation(targetConvId);

      let needsParentResolution = !asstMsg.parentId || asstMsg.parentId === remoteParent;
      let hasParentageConflict = false;

      // Section 6: Check whether existing parentId contradicts remoteParentId
      if (!needsParentResolution && remoteParent && asstMsg.parentId) {
        const currentParent = existingMsgs.find((m: Message) => m.id === asstMsg.parentId);
        if (!currentParent || (currentParent.remoteId && String(currentParent.remoteId) !== remoteParent)) {
          needsParentResolution = true;
          hasParentageConflict = true;
        }
      }

      if (needsParentResolution) {
        const resolved = resolveAssistantParent(asstMsg as Message, existingMsgs);

        if (resolved.parentId) {
          asstMsg.parentId = resolved.parentId;

          // Section 5 (Atomicity): If the resolved parent user message lacked remoteId,
          // attach it to checkpoint.userMessage so BOTH are saved in a SINGLE atomic transaction!
          if (resolved.confirmedUserRemoteId) {
            const parentUser = existingMsgs.find((m: Message) => m.id === resolved.parentId);
            if (parentUser && !parentUser.remoteId) {
              const assignResult = assignRemoteIdSafely(
                parentUser,
                resolved.confirmedUserRemoteId,
                existingMsgs
              );
              if (assignResult.assigned) {
                checkpoint.userMessage = parentUser;
              }
            }
          }
        } else if (hasParentageConflict) {
          // If existing parentId directly contradicted remoteParentId and could not be resolved,
          // do NOT silently preserve the known false parentage:
          logger.warn(
            `[CheckpointPersister] Assistant ${asstMsg.id} had parentId ${asstMsg.parentId} conflicting with remoteParentId ${remoteParent}; unlinking until verified parent arrives.`
          );
          asstMsg.parentId = null;
        }
      }

      // Enforce strict role validation on assistant parent
      if (asstMsg.parentId) {
        const parentMsg = existingMsgs.find((m: Message) => m.id === asstMsg.parentId);
        if (parentMsg && !isValidRoleParentage('assistant', parentMsg.role)) {
          logger.warn(
            `[CheckpointPersister] Rejected invalid role parentage: assistant message ${asstMsg.id} cannot have ${parentMsg.role} message ${parentMsg.id} as parent`
          );
          asstMsg.parentId = null;
        }
      }
    }

    await storageRepo.saveCanonicalCheckpoint(checkpoint);

    return {
      success: true,
      streamKey,
      checkpointSeq,
      resolvedParentId: checkpoint.message.parentId || undefined,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.stack || err.message : String(err);
    logger.error(`[CheckpointPersister] Error persisting canonical checkpoint: ${errorMsg}`);
    return {
      success: false,
      streamKey,
      checkpointSeq,
      error: errorMsg,
    };
  }
}
