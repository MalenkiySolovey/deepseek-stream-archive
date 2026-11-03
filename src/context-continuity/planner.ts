import type { Message, ResponseRevision, RecoveryEvent } from '../core/models';
import { getActiveBranchAncestry } from './branch-ancestry';
import { evaluateContinuityEligibility } from './eligibility';
import { formatContinuityContext } from './formatter';
import {
  type ContextContinuityBlock,
  type ContextContinuityExclusion,
  type ContextContinuityPlan,
  type ContextContinuitySettings,
  type ContextContinuityLimits,
  DEFAULT_CONTINUITY_LIMITS,
} from './types';

export interface ContextContinuityPlannerInput {
  conversationId: string;
  messages: Message[];
  revisionsMap: Map<string, ResponseRevision[]>;
  recoveryEventsMap?: Map<string, RecoveryEvent[]>;
  branchOptions?: {
    leafMessageId?: string;
    branchSelections?: Record<string, number>;
  };
  settings: ContextContinuitySettings;
  limits?: Partial<ContextContinuityLimits>;
  serverHistoryAuthoritativeIds?: Set<string>;
  alreadyBridgedIds?: Set<string>;
  now?: number;
}

/**
 * Truncates a UTF-16 string to at most maxChars without breaking Unicode surrogate pairs.
 * If truncated, appends a visible disclosure notice.
 */
export function sliceSafeUtf16(
  text: string,
  maxChars: number
): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  let end = maxChars;
  // If end falls between a high surrogate and low surrogate, retreat by 1 so high surrogate isn't orphaned
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }

  const sliced = text.slice(0, end);
  const notice = '\n\n[... Truncated to fit Context Continuity character budget ...]';
  return {
    text: sliced + notice,
    truncated: true,
  };
}

/**
 * Pure deterministic planner for Context Continuity.
 *
 * Algorithm:
 * 1. Resolves canonical active branch path (stripping attempt_only and non-logical turns).
 * 2. Evaluates structural eligibility for every message in the conversation.
 * 3. Collects eligible blocks matching the active branch.
 * 4. Selects newest relevant blocks respecting maxBlocks and character budgets.
 * 5. Re-sorts selected blocks into chronological order (oldest -> newest).
 * 6. Discloses omissions and truncations visibly.
 */
export function buildContextContinuityPlan(
  input: ContextContinuityPlannerInput
): ContextContinuityPlan {
  const {
    conversationId,
    messages,
    revisionsMap,
    recoveryEventsMap,
    branchOptions,
    settings,
    serverHistoryAuthoritativeIds,
    alreadyBridgedIds,
  } = input;

  const now = input.now ?? Date.now();
  const limits: ContextContinuityLimits = {
    maxBlocks: input.limits?.maxBlocks ?? DEFAULT_CONTINUITY_LIMITS.maxBlocks,
    maxTextChars: input.limits?.maxTextChars ?? DEFAULT_CONTINUITY_LIMITS.maxTextChars,
    maxThinkingChars: input.limits?.maxThinkingChars ?? DEFAULT_CONTINUITY_LIMITS.maxThinkingChars,
  };

  // If user disabled Context Continuity, return clean empty plan
  if (!settings.enabled) {
    return {
      conversationId,
      branchLeafId: null,
      eligibleBlocks: [],
      excludedBlocks: [],
      eligibleBlockCount: 0,
      excludedBlockCount: 0,
      totalTextChars: 0,
      totalThinkingChars: 0,
      truncated: false,
      omittedBlockCount: 0,
      formattedPreview: '',
      createdAt: now,
    };
  }

  // 1. Resolve active branch ancestry
  const ancestry = getActiveBranchAncestry(messages, branchOptions);

  // 2. Evaluate eligibility across messages
  const candidates: ContextContinuityBlock[] = [];
  const excludedBlocks: ContextContinuityExclusion[] = [];
  const seenMessageIds = new Set<string>();

  // Ensure deterministic iteration order
  const sortedMessages = [...messages].sort((a, b) => a.createdAt - b.createdAt);

  for (const msg of sortedMessages) {
    // Deduplication by stable message ID
    if (seenMessageIds.has(msg.id)) {
      excludedBlocks.push({
        sourceMessageId: msg.id,
        reason: 'duplicate_identity',
        recoveryCause: 'unknown',
      });
      continue;
    }
    seenMessageIds.add(msg.id);

    const revisions = revisionsMap.get(msg.id) || [];
    const recoveryEvents = recoveryEventsMap?.get(msg.id) || [];

    const evalResult = evaluateContinuityEligibility({
      message: msg,
      revisions,
      recoveryEvents,
      activeBranchMessageIds: ancestry.activeMessageIds,
      targetConversationId: conversationId,
      serverHistoryAuthoritativeIds,
      alreadyBridgedIds,
    });

    if (!evalResult.eligible) {
      // Exclude messages that were not eligible (only record if message is in current conversation and an assistant turn)
      if (msg.role === 'assistant' && msg.conversationId === conversationId) {
        excludedBlocks.push({
          sourceMessageId: msg.id,
          reason: evalResult.reason as Exclude<typeof evalResult.reason, 'eligible'>,
          recoveryCause: evalResult.recoveryCause,
        });
      }
    } else {
      const candidateRev = evalResult.candidateRevision!;
      const branchDepth = ancestry.depthMap.get(msg.id) ?? 0;

      candidates.push({
        sourceMessageId: msg.id,
        sourceRevisionId: candidateRev.id,
        assistantText: candidateRev.text,
        thinkingText: settings.includeThinking ? candidateRev.thinking : undefined,
        recoveryCause: evalResult.recoveryCause,
        branchDepth,
        originalTextLength: candidateRev.text.length,
        originalThinkingLength: (candidateRev.thinking || '').length,
      });
    }
  }

  // Sort candidates by branch depth ascending (chronological order)
  candidates.sort((a, b) => a.branchDepth - b.branchDepth);

  // 3. Newest-first selection respecting limits
  const selectedBlocks: ContextContinuityBlock[] = [];
  let currentTextChars = 0;
  let currentThinkingChars = 0;
  let omittedBlockCount = 0;
  let planTruncated = false;

  for (let i = candidates.length - 1; i >= 0; i--) {
    const cand = candidates[i]!;

    if (selectedBlocks.length >= limits.maxBlocks) {
      omittedBlockCount++;
      planTruncated = true;
      continue;
    }

    const textLen = cand.assistantText.length;
    const thinkLen = cand.thinkingText?.length ?? 0;

    if (currentTextChars + textLen > limits.maxTextChars) {
      // If this is the newest candidate block and it is itself oversized
      if (selectedBlocks.length === 0) {
        const sliced = sliceSafeUtf16(cand.assistantText, limits.maxTextChars);
        const slicedThink = cand.thinkingText
          ? sliceSafeUtf16(cand.thinkingText, limits.maxThinkingChars)
          : undefined;

        selectedBlocks.push({
          ...cand,
          assistantText: sliced.text,
          thinkingText: slicedThink?.text,
          truncated: true,
        });
        currentTextChars += sliced.text.length;
        currentThinkingChars += slicedThink?.text.length ?? 0;
        planTruncated = true;
      } else {
        // Exceeds text budget; omit older block
        omittedBlockCount++;
        planTruncated = true;
      }
    } else {
      // Fits within text budget
      const blockToAdd: ContextContinuityBlock = { ...cand };
      if (blockToAdd.thinkingText && currentThinkingChars + thinkLen > limits.maxThinkingChars) {
        const remainThink = Math.max(0, limits.maxThinkingChars - currentThinkingChars);
        const slicedThink = sliceSafeUtf16(blockToAdd.thinkingText, remainThink);
        blockToAdd.thinkingText = slicedThink.text;
        blockToAdd.truncated = true;
        planTruncated = true;
      }

      selectedBlocks.push(blockToAdd);
      currentTextChars += blockToAdd.assistantText.length;
      currentThinkingChars += blockToAdd.thinkingText?.length ?? 0;
    }
  }

  // 4. Re-sort selected blocks back into chronological order (oldest -> newest)
  selectedBlocks.sort((a, b) => a.branchDepth - b.branchDepth);

  const totalTextChars = selectedBlocks.reduce((acc, b) => acc + b.assistantText.length, 0);
  const totalThinkingChars = selectedBlocks.reduce(
    (acc, b) => acc + (b.thinkingText?.length ?? 0),
    0
  );

  // 5. Generate formatted preview
  const formattedPreview = formatContinuityContext(
    {
      eligibleBlocks: selectedBlocks,
      truncated: planTruncated,
      omittedBlockCount,
    },
    { includeThinking: settings.includeThinking }
  );

  return {
    conversationId,
    branchLeafId: ancestry.leafMessageId,
    eligibleBlocks: selectedBlocks,
    excludedBlocks,
    eligibleBlockCount: selectedBlocks.length,
    excludedBlockCount: excludedBlocks.length,
    totalTextChars,
    totalThinkingChars,
    truncated: planTruncated,
    omittedBlockCount,
    formattedPreview,
    createdAt: now,
  };
}
