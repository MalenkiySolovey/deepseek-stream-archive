import { isLogicalMessage, type Message } from '../core/models';

export interface ActiveBranchAncestryResult {
  activeMessageIds: Set<string>;
  activePath: Message[];
  depthMap: Map<string, number>;
  leafMessageId: string | null;
}

/**
 * Pure topological resolver for the active canonical branch path.
 *
 * Rules:
 * 1. Only logical conversation turns participate (attempt_only and unmatched_capture are stripped).
 * 2. If a specific leafMessageId is provided, traverses upward via parentId to root.
 * 3. Otherwise, traces downward from root using branchSelections (defaulting to 0 for each sibling fork).
 * 4. Assigns deterministic topological depth (0 for root, incrementing to leaf).
 */
export function getActiveBranchAncestry(
  messages: Message[],
  options?: {
    leafMessageId?: string;
    branchSelections?: Record<string, number>;
  }
): ActiveBranchAncestryResult {
  const logicalTurns = messages.filter((m) => isLogicalMessage(m));
  const messageMap = new Map<string, Message>();
  for (const m of logicalTurns) {
    messageMap.set(m.id, m);
  }

  // ── Strategy A: Upward traversal from explicit leaf ──
  if (options?.leafMessageId && messageMap.has(options.leafMessageId)) {
    const activePath: Message[] = [];
    const activeMessageIds = new Set<string>();
    const visited = new Set<string>();

    let current: Message | undefined = messageMap.get(options.leafMessageId);
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      activePath.unshift(current);
      activeMessageIds.add(current.id);
      let nextParentId = current.parentId;
      if (!nextParentId && current.role === 'assistant') {
        const currIdx = logicalTurns.findIndex((m) => m.id === current!.id);
        if (currIdx > 0) {
          for (let j = currIdx - 1; j >= 0; j--) {
            if (logicalTurns[j]!.role === 'user') {
              nextParentId = logicalTurns[j]!.id;
              break;
            }
          }
        }
      }
      current = nextParentId ? messageMap.get(nextParentId) : undefined;
    }

    const depthMap = new Map<string, number>();
    for (let i = 0; i < activePath.length; i++) {
      depthMap.set(activePath[i]!.id, i);
    }

    return {
      activeMessageIds,
      activePath,
      depthMap,
      leafMessageId: options.leafMessageId,
    };
  }

  // ── Strategy B: Downward traversal using branchSelections from root ──
  const groups = new Map<string, Message[]>();
  for (let i = 0; i < logicalTurns.length; i++) {
    const m = logicalTurns[i]!;
    let parentKey = m.parentId || '__root__';
    if (!m.parentId && m.role === 'assistant') {
      for (let j = i - 1; j >= 0; j--) {
        if (logicalTurns[j]!.role === 'user') {
          parentKey = logicalTurns[j]!.id;
          break;
        }
      }
    }
    if (!groups.has(parentKey)) {
      groups.set(parentKey, []);
    }
    groups.get(parentKey)!.push(m);
  }

  // Ensure deterministic sibling ordering (by createdAt ascending, then id)
  for (const list of groups.values()) {
    list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  const activePath: Message[] = [];
  const activeMessageIds = new Set<string>();
  const depthMap = new Map<string, number>();

  const roots = groups.get('__root__') || [];
  if (roots.length === 0) {
    return {
      activeMessageIds,
      activePath,
      depthMap,
      leafMessageId: null,
    };
  }

  const rootIndex = options?.branchSelections?.['__root__'] ?? 0;
  let current: Message | undefined = roots[Math.max(0, Math.min(rootIndex, roots.length - 1))];

  let depth = 0;
  const visited = new Set<string>();

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    activePath.push(current);
    activeMessageIds.add(current.id);
    depthMap.set(current.id, depth++);

    const children = groups.get(current.id);
    if (!children || children.length === 0) {
      break;
    }

    const selIndex = options?.branchSelections?.[current.id] ?? 0;
    const clampedIndex = Math.max(0, Math.min(selIndex, children.length - 1));
    current = children[clampedIndex];
  }

  const leafMessageId = activePath.length > 0 ? activePath[activePath.length - 1]!.id : null;

  return {
    activeMessageIds,
    activePath,
    depthMap,
    leafMessageId,
  };
}
