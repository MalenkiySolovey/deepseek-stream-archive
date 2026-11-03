import { isLogicalMessage, type Message } from '../models';
import type {
  BuildConversationTreeOptions,
  ConversationTreeNode,
  ConversationTreeResult,
} from './types';

/**
 * Deterministic sibling comparator:
 * Primary: createdAt ascending
 * Secondary: remoteCreatedAt ascending
 * Tertiary: local id string comparison
 */
function compareMessageOrder(a: Message, b: Message): number {
  if (a.createdAt !== b.createdAt) {
    return a.createdAt - b.createdAt;
  }
  const rA = a.remoteCreatedAt ?? 0;
  const rB = b.remoteCreatedAt ?? 0;
  if (rA !== rB) {
    return rA - rB;
  }
  return a.id.localeCompare(b.id);
}

/**
 * Builds a deterministic Conversation DAG Tree from flat canonical messages.
 *
 * Enforces:
 * 1. Strict DAG invariants (zero cycles, safe cycle breaking).
 * 2. Multi-tier ID resolution (local id, remoteId, remoteParentId).
 * 3. Clear bifurcation between:
 *    - User Edits (sibling user turns branching under the same preceding assistant turn or root)
 *    - Assistant Regenerates (sibling assistant turns branching under the same user turn)
 * 4. Authoritative leaf path resolution (from conversation.currentMessageId or explicit leaf)
 *    falling back to branchSelections downward traversal.
 * 5. Full preservation of orphan / unlinked turns in unlinkedMessages without corrupting activePath.
 */
export function buildConversationTree<T extends Message = Message>(
  messages: T[],
  options?: BuildConversationTreeOptions
): ConversationTreeResult<T> {
  const logicalTurns = messages.filter((m) => isLogicalMessage(m));

  if (logicalTurns.length === 0) {
    return {
      roots: [],
      activePath: [],
      activeNodes: [],
      activeLeafId: null,
      unlinkedMessages: [],
      nodeMap: new Map(),
      depthMap: new Map(),
      activeMessageIds: new Set(),
      getNode: () => undefined,
    };
  }

  // 1. Indexing: local id -> message, remoteId -> local id
  const idMap = new Map<string, T>();
  const remoteIdMap = new Map<string, string>();

  for (const m of logicalTurns) {
    idMap.set(m.id, m);
    if (m.remoteId) {
      remoteIdMap.set(String(m.remoteId), m.id);
    }
  }

  // 2. Sort messages chronologically for consistent fallback scans
  const sortedMessages = [...logicalTurns].sort(compareMessageOrder);

  // 3. Resolve parent ID for each message
  const resolvedParentIds = new Map<string, string | null>();

  for (let i = 0; i < sortedMessages.length; i++) {
    const m = sortedMessages[i]!;

    let pId: string | null = null;

    if (m.parentId && idMap.has(m.parentId)) {
      pId = m.parentId;
    } else if (m.remoteParentId) {
      const mapped = remoteIdMap.get(String(m.remoteParentId));
      if (mapped && idMap.has(mapped)) {
        pId = mapped;
      } else if (idMap.has(String(m.remoteParentId))) {
        pId = String(m.remoteParentId);
      }
    }

    // Fallback for assistant messages without explicit parentage:
    // pair with nearest preceding user message
    if (!pId && m.role === 'assistant') {
      for (let j = i - 1; j >= 0; j--) {
        if (sortedMessages[j]!.role === 'user') {
          pId = sortedMessages[j]!.id;
          break;
        }
      }
    }

    // Invariant: Message cannot be its own parent
    if (pId === m.id) {
      pId = null;
    }

    resolvedParentIds.set(m.id, pId);
  }

  // 4. Create Tree Nodes
  const nodeMap = new Map<string, ConversationTreeNode<T>>();

  for (const m of logicalTurns) {
    const node: ConversationTreeNode<T> = {
      message: m,
      parent: null,
      children: [],
      userBranches: [],
      userBranchIndex: 0,
      userBranchCount: 1,
      assistantVariants: [],
      assistantVariantIndex: 0,
      assistantVariantCount: 1,
      depth: 0,
      isRoot: false,
      isLeaf: true,
    };
    nodeMap.set(m.id, node);
  }

  // 5. Connect parents and children with cycle detection
  const roots: ConversationTreeNode<T>[] = [];
  const unlinkedMessages: T[] = [];

  for (const m of sortedMessages) {
    const node = nodeMap.get(m.id)!;
    const parentId = resolvedParentIds.get(m.id);

    if (parentId && nodeMap.has(parentId)) {
      // Check for cycles by walking up the proposed parent's ancestry
      let isCyclic = false;
      let ancestor: ConversationTreeNode<T> | null = nodeMap.get(parentId)!;
      while (ancestor) {
        if (ancestor.message.id === m.id) {
          isCyclic = true;
          break;
        }
        ancestor = ancestor.parent;
      }

      if (!isCyclic) {
        const parentNode = nodeMap.get(parentId)!;
        node.parent = parentNode;
        parentNode.children.push(node);
        parentNode.isLeaf = false;
      } else {
        // Cycle detected: isolate node into unlinkedMessages to prevent infinite loops
        unlinkedMessages.push(m);
      }
    } else {
      // No parent resolved
      if (m.role === 'user' && !m.parentId && !m.remoteParentId) {
        // Legitimate conversation root prompt
        node.isRoot = true;
        roots.push(node);
      } else if (!m.parentId && !m.remoteParentId && m.role === 'user') {
        node.isRoot = true;
        roots.push(node);
      } else {
        // Had an unresolvable parentId/remoteParentId, or assistant orphan
        unlinkedMessages.push(m);
      }
    }
  }

  // If no root user message was found (e.g. malformed or partial archive),
  // pick earliest message(s) as provisional roots to preserve presentation
  if (roots.length === 0 && sortedMessages.length > 0) {
    const earliest = sortedMessages[0]!;
    const fallbackNode = nodeMap.get(earliest.id)!;
    fallbackNode.isRoot = true;
    roots.push(fallbackNode);
    // Remove from unlinked if it was placed there
    const unlinkedIdx = unlinkedMessages.findIndex((u) => u.id === earliest.id);
    if (unlinkedIdx !== -1) {
      unlinkedMessages.splice(unlinkedIdx, 1);
    }
  }

  // 6. Sort all children and roots deterministically
  roots.sort((a, b) => compareMessageOrder(a.message, b.message));
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => compareMessageOrder(a.message, b.message));
  }

  // 7. Compute Depths and Sibling Metadata
  // For roots: they represent userBranches at root level
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!;
    root.userBranches = roots;
    root.userBranchIndex = i;
    root.userBranchCount = roots.length;
    root.depth = 0;
  }

  // Recursive depth and sibling assignment
  const assignTreeMetadata = (node: ConversationTreeNode<T>, currentDepth: number) => {
    node.depth = currentDepth;

    const children = node.children;
    if (children.length === 0) {
      node.isLeaf = true;
      return;
    }

    node.isLeaf = false;

    // Categorize children by role:
    if (node.message.role === 'user') {
      // Children of user message are assistant responses (Regenerate variants)
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        child.assistantVariants = children;
        child.assistantVariantIndex = i;
        child.assistantVariantCount = children.length;
        assignTreeMetadata(child, currentDepth + 1);
      }
    } else {
      // Children of assistant message (or system/root) are user prompts (Edit forks)
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        child.userBranches = children;
        child.userBranchIndex = i;
        child.userBranchCount = children.length;
        assignTreeMetadata(child, currentDepth + 1);
      }
    }
  };

  for (const root of roots) {
    assignTreeMetadata(root, 0);
  }

  // 8. Active Path Selection
  const activeNodes: ConversationTreeNode<T>[] = [];
  const activeMessageIds = new Set<string>();
  const depthMap = new Map<string, number>();
  let activeLeafId: string | null = null;

  // Determine target leaf if available:
  let targetLeafNode: ConversationTreeNode<T> | undefined;

  if (options?.activeLeafId && nodeMap.has(options.activeLeafId)) {
    targetLeafNode = nodeMap.get(options.activeLeafId);
  } else if (options?.conversation?.currentMessageId) {
    const remoteIdStr = String(options.conversation.currentMessageId);
    const localId = remoteIdMap.get(remoteIdStr) || remoteIdStr;
    if (nodeMap.has(localId)) {
      targetLeafNode = nodeMap.get(localId);
    } else {
      // Search by remoteId directly
      for (const node of nodeMap.values()) {
        if (node.message.remoteId && String(node.message.remoteId) === remoteIdStr) {
          targetLeafNode = node;
          break;
        }
      }
    }
  }

  if (targetLeafNode) {
    // ── Upward traversal from target leaf to root ──
    const path: ConversationTreeNode<T>[] = [];
    const visited = new Set<string>();
    let curr: ConversationTreeNode<T> | null = targetLeafNode;

    while (curr && !visited.has(curr.message.id)) {
      visited.add(curr.message.id);
      path.unshift(curr);
      curr = curr.parent;
    }

    activeLeafId = targetLeafNode.message.id;
    for (let i = 0; i < path.length; i++) {
      const node = path[i]!;
      activeNodes.push(node);
      activeMessageIds.add(node.message.id);
      depthMap.set(node.message.id, i);
    }
  } else {
    // ── Downward traversal using branchSelections from root ──
    const branchSelections = options?.branchSelections || {};
    const defaultRootIdx = 0;
    const rootIdx = branchSelections['__root__'] ?? defaultRootIdx;
    const clampedRootIdx = Math.max(0, Math.min(rootIdx, roots.length - 1));

    let current: ConversationTreeNode<T> | undefined = roots[clampedRootIdx];
    const visited = new Set<string>();
    let currentDepth = 0;

    while (current && !visited.has(current.message.id)) {
      visited.add(current.message.id);
      activeNodes.push(current);
      activeMessageIds.add(current.message.id);
      depthMap.set(current.message.id, currentDepth++);
      activeLeafId = current.message.id;

      const children = current.children;
      if (!children || children.length === 0) {
        break;
      }

      // Branch index: if not specified, default to 0 for deterministic stability,
      // or latest child if preferLatestByDefault is requested
      const defaultChildIdx = options?.preferLatestByDefault ? children.length - 1 : 0;
      const selIdx = branchSelections[current.message.id] ?? defaultChildIdx;
      const clampedIdx = Math.max(0, Math.min(selIdx, children.length - 1));
      current = children[clampedIdx];
    }
  }

  const activePath = activeNodes.map((n) => n.message);

  return {
    roots,
    activePath,
    activeNodes,
    activeLeafId,
    unlinkedMessages,
    nodeMap,
    depthMap,
    activeMessageIds,
    getNode: (id: string) => nodeMap.get(id),
  };
}
