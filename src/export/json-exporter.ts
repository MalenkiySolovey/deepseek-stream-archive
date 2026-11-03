import type { ConversationExportModel, ConversationExportOptions, ConversationExportV1 } from './types';
import { isLogicalMessage, isUnmatchedCapture, selectPreferredRevision } from '../core/models';
import { buildConversationTree } from '../core/conversation-tree';

/**
 * Build the canonical ConversationExportV1 DTO object from a conversation model.
 */
export function buildConversationExportDto(
  model: ConversationExportModel,
  options: ConversationExportOptions
): ConversationExportV1 {
  const { conversation, messages } = model;

  // 1. Filter logical messages and unmatched captures (attempt_only is excluded)
  const logicalTurns = messages.filter((m) => isLogicalMessage(m.message));
  const unmatchedTurns = messages.filter(
    (m) => isUnmatchedCapture(m.message) && (
      (m.message.content && m.message.content.trim().length > 0) ||
      m.revisions.some((r) => r.text.trim().length > 0)
    )
  );

  // 2. Build DAG conversation tree for active branch isolation
  const tree = buildConversationTree(
    logicalTurns.map((item) => item.message),
    { branchSelections: options.branchSelections }
  );

  // 3. Filter items according to branch option
  let exportItems: typeof logicalTurns = [];
  if (options.branches === 'active') {
    exportItems = logicalTurns.filter((item) => tree.activeMessageIds.has(item.message.id));
  } else {
    exportItems = logicalTurns;
  }

  // 4. Map logical turns into export DTO format
  const exportMessages = exportItems.map((item) => {
    const { message, revisions, recoveryEvents } = item;
    const node = tree.getNode(message.id);
    const hasBranches = Boolean(
      node && (node.userBranchCount > 1 || node.assistantVariantCount > 1)
    );
    const branchIndex = node
      ? node.userBranchCount > 1
        ? node.userBranchIndex + 1
        : node.assistantVariantIndex + 1
      : 1;
    const branchCount = node
      ? node.userBranchCount > 1
        ? node.userBranchCount
        : node.assistantVariantCount
      : 1;

    const preferred = selectPreferredRevision(message, revisions);
    const contentText = preferred?.text ?? message.content ?? '';
    const thinkingText = options.includeReasoning ? (preferred?.thinking ?? undefined) : undefined;

    // Build recovery payload if applicable
    let recoveryPayload: ConversationExportV1['messages'][0]['recovery'];
    if (options.includeRecovery) {
      const lastGoodRev =
        revisions.find((r) => r.isLastGood && (r.text.trim().length > 0 || (r.thinking && r.thinking.trim().length > 0))) ||
        [...revisions].reverse().find((r) => r.source === 'network' && (r.text.trim().length > 0 || (r.thinking && r.thinking.trim().length > 0)));
      const primaryEvent = recoveryEvents[0];
      const hasMeaningfulContent = Boolean(lastGoodRev && (lastGoodRev.text.trim().length > 0 || (lastGoodRev.thinking && lastGoodRev.thinking.trim().length > 0)));
      if (hasMeaningfulContent && (message.status === 'filtered' || primaryEvent)) {
        recoveryPayload = {
          event: {
            id: primaryEvent?.id ?? `rec_${message.id}`,
            kind: primaryEvent?.kind ?? 'content_filter',
            detectedAt: primaryEvent?.detectedAt ?? message.updatedAt,
            reason: primaryEvent?.reason,
          },
          lastGoodText: lastGoodRev!.text,
          lastGoodThinking: options.includeReasoning ? lastGoodRev!.thinking : undefined,
        };
      }
    }

    // Build revisions array if requested
    let revisionsPayload: ConversationExportV1['messages'][0]['revisions'];
    if (options.includeRevisions && revisions.length > 0) {
      const sortedRevs = [...revisions].sort((a, b) => a.revisionIndex - b.revisionIndex);
      revisionsPayload = sortedRevs.map((r) => ({
        id: r.id,
        revisionIndex: r.revisionIndex,
        source: r.source,
        capturedAt: r.capturedAt,
        isFinal: r.isFinal,
        isLastGood: r.isLastGood,
        text: r.text,
        thinking: options.includeReasoning ? r.thinking : undefined,
      }));
    }

    return {
      id: message.id,
      remoteId: message.remoteId,
      parentId: message.parentId,
      role: message.role,
      status: message.status,
      identityState: message.identityState,
      projectionState: message.projectionState || 'logical',
      branchIndex: hasBranches ? branchIndex : undefined,
      branchCount: hasBranches ? branchCount : undefined,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      content: contentText,
      thinking: thinkingText,
      recovery: recoveryPayload,
      revisions: revisionsPayload,
    };
  });

  // 5. Map unmatched captures (if any)
  const unmatchedCapturesPayload = unmatchedTurns.length > 0
    ? unmatchedTurns.map((item) => {
        const pref = selectPreferredRevision(item.message, item.revisions);
        return {
          id: item.message.id,
          sourceRawStreamKey: item.message.sourceRawStreamKey,
          createdAt: item.message.createdAt,
          text: pref?.text ?? item.message.content ?? '',
          thinking: options.includeReasoning ? (pref?.thinking ?? undefined) : undefined,
        };
      })
    : undefined;

  return {
    format: 'deepseek-streamarchive-conversation',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    exportOptions: {
      branches: options.branches,
      includeReasoning: options.includeReasoning,
      includeRevisions: options.includeRevisions,
      includeRecovery: options.includeRecovery,
    },
    conversation: {
      id: conversation.id,
      remoteId: conversation.remoteId,
      title: conversation.title || 'Untitled Conversation',
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    },
    messages: exportMessages,
    unmatchedCaptures: unmatchedCapturesPayload,
  };
}

/**
 * Serialize a conversation model into formatted JSON string.
 */
export function buildConversationJson(
  model: ConversationExportModel,
  options: ConversationExportOptions
): string {
  const dto = buildConversationExportDto(model, options);
  return JSON.stringify(dto, null, 2);
}
