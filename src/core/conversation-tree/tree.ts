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
      observedPath: [],
      observedLeafId: null,
      isArchiveViewingObservedPath: true,
      unlinkedMessages: [],
      unlinkedDetails: [],
      nodeMap: new Map(),
      depthMap: new Map(),
      activeMessageIds: new Set(),
      getNode: () => undefined,
      diagnostics: {
        userBranchGroupCount: 0,
        assistantVariantGroupCount: 0,
        orphanPromptsCount: 0,
        orphanAssistantCount: 0,
        unresolvedParentLinksCount: 0,
        activeLeafId: null,
        observedLeafId: null,
        isArchiveViewingObservedPath: true,
        newMessagesOutsideViewCount: 0,
      },
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

    if (m.parentId) {
      if (idMap.has(m.parentId)) {
        pId = m.parentId;
      } else if (remoteIdMap.has(String(m.parentId))) {
        const mappedFromParent = remoteIdMap.get(String(m.parentId));
        if (mappedFromParent && idMap.has(mappedFromParent)) {
          pId = mappedFromParent;
        }
      }
    }

    if (!pId && m.remoteParentId) {
      const mapped = remoteIdMap.get(String(m.remoteParentId));
      if (mapped && idMap.has(mapped)) {
        pId = mapped;
      } else if (idMap.has(String(m.remoteParentId))) {
        pId = String(m.remoteParentId);
      }
    }

    // For assistant messages without explicit parentage:
    // Only resolve to preceding user message if completely unambiguous
    // (e.g. legacy linear v0.1.0 archive with exactly 1 candidate user prompt in conversation).
    // In branched or multi-prompt conversations, never guess chronologically.
    if (!pId && m.role === 'assistant') {
      const candidateUserMsgs: T[] = [];
      for (let j = i - 1; j >= 0; j--) {
        if (sortedMessages[j]!.role === 'user') {
          candidateUserMsgs.push(sortedMessages[j]!);
        }
      }
      if (candidateUserMsgs.length === 1) {
        pId = candidateUserMsgs[0]!.id;
      }
    }

    // For user messages with remoteParentId in a linear sequence without branching,
    // where the preceding assistant's remoteId was not yet populated:
    if (!pId && m.role === 'user' && m.remoteParentId) {
      const candidateAssistantMsgs: T[] = [];
      for (let j = i - 1; j >= 0; j--) {
        if (sortedMessages[j]!.role === 'assistant') {
          candidateAssistantMsgs.push(sortedMessages[j]!);
        }
      }
      if (candidateAssistantMsgs.length === 1) {
        pId = candidateAssistantMsgs[0]!.id;
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
  const unlinkedDetails: import('./types').UnlinkedMessageDetail<T>[] = [];

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
        unlinkedDetails.push({
          message: m,
          reason: 'cycle_detected',
          attemptedParentId: parentId,
          attemptedRemoteParentId: m.remoteParentId ? String(m.remoteParentId) : undefined,
        });
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
        let reason: import('./types').UnlinkedMessageReason = 'missing_parent_id';
        if (m.remoteParentId && !parentId) {
          reason = 'unresolved_remote_parent';
        } else if (m.parentId && !nodeMap.has(m.parentId)) {
          reason = 'parent_not_yet_persisted';
        }
        unlinkedDetails.push({
          message: m,
          reason,
          attemptedParentId: m.parentId ? String(m.parentId) : undefined,
          attemptedRemoteParentId: m.remoteParentId ? String(m.remoteParentId) : undefined,
        });
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
    const detailIdx = unlinkedDetails.findIndex((d) => d.message.id === earliest.id);
    if (detailIdx !== -1) {
      unlinkedDetails.splice(detailIdx, 1);
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

  // 7b. Subtree Metadata for intelligent downward branch selection (linear O(N))
  const subtreeLatestTimestamp = new Map<string, number>();
  const computeLatest = (node: ConversationTreeNode<T>): number => {
    let latest = node.message.updatedAt || node.message.createdAt || 0;
    for (const child of node.children) {
      const childLatest = computeLatest(child);
      if (childLatest > latest) {
        latest = childLatest;
      }
    }
    subtreeLatestTimestamp.set(node.message.id, latest);
    return latest;
  };
  for (const root of roots) {
    computeLatest(root);
  }

  // 7c. Compute Observed DeepSeek Path (independent of StreamArchive view)
  const serverCurrentMessageId = options?.conversation?.currentMessageId
    ? String(options.conversation.currentMessageId)
    : null;

  let observedLeafNode: ConversationTreeNode<T> | null = null;
  if (serverCurrentMessageId) {
    let target = nodeMap.get(serverCurrentMessageId);
    if (!target) {
      for (const n of nodeMap.values()) {
        if (n.message.remoteId && String(n.message.remoteId) === serverCurrentMessageId) {
          target = n;
          break;
        }
      }
    }
    if (target) {
      observedLeafNode = target;
    }
  }

  // If server current message ID wasn't provided or not found, observed path defaults to the most recently updated branch
  if (!observedLeafNode && roots.length > 0) {
    let curr: ConversationTreeNode<T> | undefined = roots[0];
    let bestTime = -1;
    for (let i = 0; i < roots.length; i++) {
      const t = subtreeLatestTimestamp.get(roots[i]!.message.id) ?? 0;
      if (t > bestTime) {
        bestTime = t;
        curr = roots[i];
      }
    }
    while (curr && curr.children.length > 0) {
      let nextChild = curr.children[0]!;
      let nextTime = -1;
      for (const child of curr.children) {
        const t = subtreeLatestTimestamp.get(child.message.id) ?? 0;
        if (t > nextTime) {
          nextTime = t;
          nextChild = child;
        }
      }
      curr = nextChild;
    }
    observedLeafNode = curr || null;
  }

  const observedNodes: ConversationTreeNode<T>[] = [];
  const observedAncestorIds = new Set<string>();
  if (observedLeafNode) {
    let curr: ConversationTreeNode<T> | null = observedLeafNode;
    const visited = new Set<string>();
    while (curr && !visited.has(curr.message.id)) {
      visited.add(curr.message.id);
      observedNodes.unshift(curr);
      observedAncestorIds.add(curr.message.id);
      curr = curr.parent;
    }
  }
  const observedLeafId = observedLeafNode ? observedLeafNode.message.id : null;
  const observedPath = observedNodes.map((n) => n.message);

  // 8. Active Path Selection (StreamArchive independent view)
  const activeNodes: ConversationTreeNode<T>[] = [];
  const activeMessageIds = new Set<string>();
  const depthMap = new Map<string, number>();
  let activeLeafId: string | null = null;

  // If explicit leaf was requested, walk upward from that leaf
  if (options?.activeLeafId && nodeMap.has(options.activeLeafId)) {
    const targetLeafNode = nodeMap.get(options.activeLeafId)!;
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
  } else if (roots.length > 0) {
    const viewSelection = options?.viewSelection;
    const branchSelections = options?.branchSelections || {};

    // Root selection:
    let chosenRoot: ConversationTreeNode<T> | undefined;

    // 1. Stable root ID from viewSelection
    if (viewSelection?.selectedRootId) {
      chosenRoot = roots.find((r) => r.message.id === viewSelection.selectedRootId);
    }
    if (!chosenRoot && viewSelection?.selectedChildByParent?.['__root__']) {
      const targetId = viewSelection.selectedChildByParent['__root__'];
      chosenRoot = roots.find((r) => r.message.id === targetId);
    }

    // 2. Fallback to branchSelections (string ID or legacy number)
    if (!chosenRoot && branchSelections['__root__'] !== undefined) {
      const sel = branchSelections['__root__'];
      if (typeof sel === 'string') {
        chosenRoot = roots.find((r) => r.message.id === sel);
      } else if (typeof sel === 'number') {
        const clampedIdx = Math.max(0, Math.min(sel, roots.length - 1));
        chosenRoot = roots[clampedIdx];
      }
    }

    // 3. Fallback for initial unselected view: follow DeepSeek's observed path if available
    if (!chosenRoot && observedAncestorIds.size > 0) {
      chosenRoot = roots.find((r) => observedAncestorIds.has(r.message.id));
    }

    // 4. Default: newest root
    if (!chosenRoot) {
      let bestIdx = 0;
      let bestTime = -1;
      for (let i = 0; i < roots.length; i++) {
        const t = subtreeLatestTimestamp.get(roots[i]!.message.id) ?? 0;
        if (t > bestTime) {
          bestTime = t;
          bestIdx = i;
        }
      }
      chosenRoot = roots[bestIdx]!;
    }

    let current: ConversationTreeNode<T> | undefined = chosenRoot;
    const visited = new Set<string>();
    let currentDepth = 0;

    while (current && !visited.has(current.message.id)) {
      visited.add(current.message.id);
      activeNodes.push(current);
      activeMessageIds.add(current.message.id);
      depthMap.set(current.message.id, currentDepth++);
      activeLeafId = current.message.id;

      const children: ConversationTreeNode<T>[] = current.children;
      if (!children || children.length === 0) {
        break;
      }

      let chosenChild: ConversationTreeNode<T> | undefined;

      // 1. Check stable child ID in viewSelection
      if (viewSelection?.selectedChildByParent?.[current.message.id]) {
        const targetChildId = viewSelection.selectedChildByParent[current.message.id];
        chosenChild = children.find((c: ConversationTreeNode<T>) => c.message.id === targetChildId);
      }

      // 2. Check branchSelections (string ID or number)
      if (!chosenChild && branchSelections[current.message.id] !== undefined) {
        const sel = branchSelections[current.message.id];
        if (typeof sel === 'string') {
          chosenChild = children.find((c: ConversationTreeNode<T>) => c.message.id === sel);
        } else if (typeof sel === 'number') {
          const clampedIdx = Math.max(0, Math.min(sel, children.length - 1));
          chosenChild = children[clampedIdx];
        }
      }

      // 3. Fallback when user has no explicit choice for this fork:
      // If one of the children is part of observed DeepSeek path, pick it (initial view matches DeepSeek)
      if (!chosenChild && observedAncestorIds.size > 0) {
        chosenChild = children.find((c: ConversationTreeNode<T>) => observedAncestorIds.has(c.message.id));
      }

      // 4. Fallback: pick child with newest timestamp
      if (!chosenChild) {
        let bestChild: ConversationTreeNode<T> = children[0]!;
        let bestTime = -1;
        for (const child of children) {
          const t = subtreeLatestTimestamp.get(child.message.id) ?? 0;
          if (t > bestTime) {
            bestTime = t;
            bestChild = child;
          }
        }
        chosenChild = bestChild;
      }

      current = chosenChild;
    }
  }

  // 9. Compute Diagnostic Metrics
  let userBranchGroupCount = roots.length > 1 ? 1 : 0;
  let assistantVariantGroupCount = 0;

  for (const node of nodeMap.values()) {
    if (node.message.role === 'user' && !node.isRoot && node.userBranchIndex === 0 && node.userBranchCount > 1) {
      userBranchGroupCount++;
    }
    if (node.message.role === 'assistant' && node.assistantVariantIndex === 0 && node.assistantVariantCount > 1) {
      assistantVariantGroupCount++;
    }
  }

  let orphanPromptsCount = 0;
  let orphanAssistantCount = 0;
  for (const unlinked of unlinkedMessages) {
    if (unlinked.role === 'user') {
      orphanPromptsCount++;
    } else {
      orphanAssistantCount++;
    }
  }

  let unresolvedParentLinksCount = 0;
  for (const m of sortedMessages) {
    if (m.parentId && !idMap.has(m.parentId)) {
      unresolvedParentLinksCount++;
    } else if (m.remoteParentId && !remoteIdMap.has(String(m.remoteParentId))) {
      unresolvedParentLinksCount++;
    }
  }

  const isArchiveViewingObservedPath = Boolean(!observedLeafId || activeLeafId === observedLeafId);
  const newMessagesOutsideViewCount = observedPath.filter((m) => !activeMessageIds.has(m.id)).length;
  const activePath = activeNodes.map((n) => n.message);

  return {
    roots,
    activePath,
    activeNodes,
    activeLeafId,
    observedPath,
    observedLeafId,
    isArchiveViewingObservedPath,
    unlinkedMessages,
    unlinkedDetails,
    nodeMap,
    depthMap,
    activeMessageIds,
    getNode: (id: string) => nodeMap.get(id),
    diagnostics: {
      userBranchGroupCount,
      assistantVariantGroupCount,
      orphanPromptsCount,
      orphanAssistantCount,
      unresolvedParentLinksCount,
      activeLeafId,
      observedLeafId,
      isArchiveViewingObservedPath,
      newMessagesOutsideViewCount,
    },
  };
}
