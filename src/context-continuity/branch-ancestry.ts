import type { Message } from '../core/models';
import { buildConversationTree } from '../core/conversation-tree';

export interface ActiveBranchAncestryResult {
  activeMessageIds: Set<string>;
  activePath: Message[];
  depthMap: Map<string, number>;
  leafMessageId: string | null;
}

/**
 * Pure topological resolver for the active canonical branch path.
 *
 * Uses the unified ConversationTree DAG engine to guarantee 100% identity
 * and branch path parity between Side Panel presentation, Export, and Context Continuity.
 */
export function getActiveBranchAncestry(
  messages: Message[],
  options?: {
    leafMessageId?: string;
    branchSelections?: Record<string, number>;
  }
): ActiveBranchAncestryResult {
  const tree = buildConversationTree(messages, {
    activeLeafId: options?.leafMessageId,
    branchSelections: options?.branchSelections,
  });

  return {
    activeMessageIds: tree.activeMessageIds,
    activePath: tree.activePath,
    depthMap: tree.depthMap,
    leafMessageId: tree.activeLeafId,
  };
}
