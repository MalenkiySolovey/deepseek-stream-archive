import type { Conversation, Message } from '../models';

export interface ConversationTreeNode<T extends Message = Message> {
  message: T;
  parent: ConversationTreeNode<T> | null;
  children: ConversationTreeNode<T>[];

  // User edit forks (sibling user messages sharing the same preceding assistant turn or root)
  userBranches: ConversationTreeNode<T>[];
  userBranchIndex: number;
  userBranchCount: number;

  // Assistant regenerate variants (sibling assistant responses sharing the same user prompt parent)
  assistantVariants: ConversationTreeNode<T>[];
  assistantVariantIndex: number;
  assistantVariantCount: number;

  depth: number;
  isRoot: boolean;
  isLeaf: boolean;
}

export interface ArchiveViewSelection {
  conversationId: string;
  selectedChildByParent: Record<string, string>;
  selectedRootId?: string;
  updatedAt: number;
}

export interface ConversationTreeDiagnostics {
  userBranchGroupCount: number;
  assistantVariantGroupCount: number;
  orphanPromptsCount: number;
  orphanAssistantCount: number;
  unresolvedParentLinksCount: number;
  activeLeafId: string | null;
  observedLeafId: string | null;
  isArchiveViewingObservedPath: boolean;
  newMessagesOutsideViewCount: number;
}

export interface ConversationTreeResult<T extends Message = Message> {
  roots: ConversationTreeNode<T>[];
  activePath: T[];
  activeNodes: ConversationTreeNode<T>[];
  activeLeafId: string | null;
  observedPath: T[];
  observedLeafId: string | null;
  isArchiveViewingObservedPath: boolean;
  unlinkedMessages: T[];
  nodeMap: Map<string, ConversationTreeNode<T>>;
  depthMap: Map<string, number>;
  activeMessageIds: Set<string>;
  getNode(id: string): ConversationTreeNode<T> | undefined;
  diagnostics: ConversationTreeDiagnostics;
}

export interface BuildConversationTreeOptions {
  conversation?: (Pick<Conversation, 'id' | 'remoteId'> & { currentMessageId?: string | null }) | null;
  branchSelections?: Record<string, number | string>;
  viewSelection?: ArchiveViewSelection | null;
  activeLeafId?: string;
  preferLatestByDefault?: boolean;
}
