/**
 * Referential Integrity Validator for Portable Backup Archives.
 *
 * Validates the complete imported relational graph prior to writing to IndexedDB.
 * Enforces tree acyclicity, conversation scoping, revision linkage,
 * pre-filter censorship recovery pointers, and raw stream identity mapping.
 */

import type { MaterializedPortableBackup } from '../backup/reader';

export interface IntegrityValidationError {
  code: string;
  message: string;
  entityId?: string;
  relatedId?: string;
}

export interface IntegrityValidationResult {
  valid: boolean;
  errors: IntegrityValidationError[];
}

/**
 * Validates relational invariants across all materialized records in a backup.
 * Pure function: does NOT perform I/O or database writes.
 */
export function validateBackupReferentialIntegrity(
  backup: MaterializedPortableBackup
): IntegrityValidationResult {
  const errors: IntegrityValidationError[] = [];

  const conversationMap = new Map<string, (typeof backup.records.conversations)[0]>();
  for (const conv of backup.records.conversations) {
    conversationMap.set(conv.id, conv);
  }

  const messageMap = new Map<string, (typeof backup.records.messages)[0]>();
  for (const msg of backup.records.messages) {
    messageMap.set(msg.id, msg);
  }

  const revisionMap = new Map<string, (typeof backup.records.revisions)[0]>();
  for (const rev of backup.records.revisions) {
    revisionMap.set(rev.id, rev);
  }

  const rawStreamMap = new Map<string, (typeof backup.records.raw_streams)[0]>();
  for (const stream of backup.records.raw_streams) {
    rawStreamMap.set(stream.id, stream);
  }

  // 1. Validate Messages
  for (const msg of backup.records.messages) {
    // 1a. conversationId reference
    if (!conversationMap.has(msg.conversationId)) {
      errors.push({
        code: 'orphan_message',
        message: `Message "${msg.id}" references non-existent conversation "${msg.conversationId}".`,
        entityId: msg.id,
        relatedId: msg.conversationId,
      });
    }

    // 1b. parentId reference & conversation scoping
    if (msg.parentId) {
      if (msg.parentId === msg.id) {
        errors.push({
          code: 'self_parent_cycle',
          message: `Message "${msg.id}" has parentId pointing to itself.`,
          entityId: msg.id,
        });
      } else {
        const parent = messageMap.get(msg.parentId);
        if (!parent) {
          errors.push({
            code: 'missing_parent_message',
            message: `Message "${msg.id}" references non-existent parent message "${msg.parentId}".`,
            entityId: msg.id,
            relatedId: msg.parentId,
          });
        } else if (parent.conversationId !== msg.conversationId) {
          errors.push({
            code: 'cross_conversation_parent',
            message: `Message "${msg.id}" (conv: "${msg.conversationId}") has parent "${parent.id}" in a different conversation ("${parent.conversationId}").`,
            entityId: msg.id,
            relatedId: parent.id,
          });
        }
      }
    }

    // 1c. Projection state invariants (2D.3)
    if (msg.projectionState === 'attempt_only' && msg.parentId) {
      errors.push({
        code: 'attempt_only_has_parent',
        message: `Message "${msg.id}" is marked attempt_only but has parentId "${msg.parentId}". Technical attempts must not participate in the branch tree.`,
        entityId: msg.id,
      });
    }
    if (msg.projectionState === 'unmatched_capture' && msg.parentId) {
      errors.push({
        code: 'unmatched_capture_has_parent',
        message: `Message "${msg.id}" is marked unmatched_capture but has parentId "${msg.parentId}". Unmatched captures must not participate in the branch tree.`,
        entityId: msg.id,
      });
    }
  }

  // 1d. Message Tree Cycle Detection
  for (const msg of backup.records.messages) {
    if (!msg.parentId) continue;
    const visited = new Set<string>([msg.id]);
    let curr = messageMap.get(msg.parentId);
    while (curr && curr.parentId) {
      if (visited.has(curr.parentId)) {
        errors.push({
          code: 'parent_cycle_detected',
          message: `Message tree cycle detected involving message "${curr.parentId}".`,
          entityId: curr.parentId,
        });
        break;
      }
      visited.add(curr.id);
      curr = messageMap.get(curr.parentId);
    }
  }

  // 2. Validate Revisions
  for (const rev of backup.records.revisions) {
    const parentMsg = messageMap.get(rev.messageId);
    if (!parentMsg) {
      errors.push({
        code: 'orphan_revision',
        message: `Revision "${rev.id}" references non-existent message "${rev.messageId}".`,
        entityId: rev.id,
        relatedId: rev.messageId,
      });
    }
  }

  // 3. Validate Recovery Events
  for (const rec of backup.records.recovery_events) {
    const msg = messageMap.get(rec.messageId);
    if (!msg) {
      errors.push({
        code: 'orphan_recovery_event',
        message: `RecoveryEvent "${rec.id}" references non-existent message "${rec.messageId}".`,
        entityId: rec.id,
        relatedId: rec.messageId,
      });
    }

    if (rec.recoveredRevisionId) {
      const rev = revisionMap.get(rec.recoveredRevisionId);
      if (!rev) {
        errors.push({
          code: 'missing_recovered_revision',
          message: `RecoveryEvent "${rec.id}" references non-existent recoveredRevisionId "${rec.recoveredRevisionId}".`,
          entityId: rec.id,
          relatedId: rec.recoveredRevisionId,
        });
      } else {
        if (rev.messageId !== rec.messageId) {
          errors.push({
            code: 'recovered_revision_message_mismatch',
            message: `RecoveryEvent "${rec.id}" for message "${rec.messageId}" references revision "${rev.id}" belonging to message "${rev.messageId}".`,
            entityId: rec.id,
            relatedId: rev.id,
          });
        }
        if (!rev.isLastGood) {
          errors.push({
            code: 'recovered_revision_not_last_good',
            message: `RecoveryEvent "${rec.id}" references revision "${rev.id}" which is not flagged isLastGood.`,
            entityId: rec.id,
            relatedId: rev.id,
          });
        }
      }
    }
  }

  // 4. Validate Raw Stream Batches
  for (const batch of backup.records.raw_stream_batches) {
    if (!rawStreamMap.has(batch.streamKey)) {
      errors.push({
        code: 'orphan_raw_batch',
        message: `RawStreamBatch "${batch.id}" references non-existent streamKey "${batch.streamKey}".`,
        entityId: batch.id,
        relatedId: batch.streamKey,
      });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
