import type { ConversationExportModel, ConversationExportOptions } from './types';
import { isLogicalMessage, isUnmatchedCapture, selectPreferredRevision } from '../core/models';

/**
 * Format a timestamp into an ISO 8601 string or fallback.
 */
function formatIso(ts: number): string {
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
}

/**
 * Build a deterministic human-readable Markdown export from a conversation model.
 */
export function buildConversationMarkdown(
  model: ConversationExportModel,
  options: ConversationExportOptions
): string {
  const { conversation, messages } = model;
  const lines: string[] = [];

  // Header metadata
  lines.push(`# ${conversation.title || 'Untitled Conversation'}`);
  lines.push('');
  lines.push(`- **Conversation ID:** \`${conversation.id}\``);
  lines.push(`- **DeepSeek Session ID:** \`${conversation.remoteId || 'N/A'}\``);
  lines.push(`- **Exported:** ${formatIso(Date.now())}`);
  lines.push(`- **StreamArchive Format:** \`human-markdown-v1\``);
  lines.push('');
  lines.push('---');
  lines.push('');

  // 1. Separate logical conversation turns from unmatched captures
  // attempt_only records are strictly excluded from human export
  const logicalTurns = messages.filter((m) => isLogicalMessage(m.message));
  const unmatchedTurns = messages.filter(
    (m) => isUnmatchedCapture(m.message) && (
      (m.message.content && m.message.content.trim().length > 0) ||
      m.revisions.some((r) => r.text.trim().length > 0)
    )
  );

  // 2. Group siblings by parentId to compute branch counts
  const groups = new Map<string, typeof logicalTurns>();
  for (const item of logicalTurns) {
    const parentKey = item.message.parentId || '__root__';
    if (!groups.has(parentKey)) {
      groups.set(parentKey, []);
    }
    groups.get(parentKey)!.push(item);
  }

  // 3. Select items to export based on branch options
  let exportItems: typeof logicalTurns = [];
  if (options.branches === 'active') {
    for (const item of logicalTurns) {
      const parentKey = item.message.parentId || '__root__';
      const siblings = groups.get(parentKey)!;
      if (siblings.length > 1) {
        const activeIdx = options.branchSelections?.[parentKey] ?? 0;
        if (siblings[activeIdx]?.message.id === item.message.id) {
          exportItems.push(item);
        }
      } else {
        exportItems.push(item);
      }
    }
  } else {
    // All branches included
    exportItems = logicalTurns;
  }

  // 4. Render each message
  for (const item of exportItems) {
    const { message, revisions, recoveryEvents } = item;
    const parentKey = message.parentId || '__root__';
    const siblings = groups.get(parentKey) || [];
    const hasBranches = siblings.length > 1;
    const branchIndex = siblings.findIndex((s) => s.message.id === message.id) + 1;

    // Heading based on role and branch
    if (message.role === 'user') {
      lines.push('## User');
      lines.push('');
      lines.push(message.content || '');
      lines.push('');
      continue;
    }

    if (message.role === 'system') {
      lines.push('## System');
      lines.push('');
      lines.push(message.content || '');
      lines.push('');
      continue;
    }

    // Assistant message
    const branchLabel = hasBranches ? ` — Branch ${branchIndex} of ${siblings.length}` : '';
    lines.push(`## Assistant${branchLabel}`);
    lines.push('');

    // Metadata lines
    const statusText = message.status === 'interrupted'
      ? 'interrupted (client abort / network dropout)'
      : message.status;
    lines.push(`- **Status:** \`${statusText}\``);
    lines.push(`- **Captured:** ${formatIso(message.createdAt)}`);
    if (message.remoteId) {
      lines.push(`- **Remote ID:** \`${message.remoteId}\``);
    }
    lines.push('');

    // Primary content from preferred revision or direct message content
    const preferred = selectPreferredRevision(message, revisions);
    const contentText = preferred?.text ?? message.content ?? '';
    const thinkingText = preferred?.thinking;

    if (contentText.trim().length > 0) {
      lines.push(contentText);
      lines.push('');
    }

    // DeepThink Chain-of-Thought Reasoning
    if (options.includeReasoning && thinkingText && thinkingText.trim().length > 0) {
      lines.push('### DeepThink');
      lines.push('');
      lines.push(thinkingText);
      lines.push('');
    }

    // Pre-Filter Censorship Recovery
    if (options.includeRecovery) {
      const lastGoodRev =
        revisions.find((r) => r.isLastGood && (r.text.trim().length > 0 || (r.thinking && r.thinking.trim().length > 0))) ||
        [...revisions].reverse().find((r) => r.source === 'network' && (r.text.trim().length > 0 || (r.thinking && r.thinking.trim().length > 0)));
      const isFiltered = message.status === 'filtered' || recoveryEvents.length > 0;
      const hasMeaningfulContent = Boolean(lastGoodRev && (lastGoodRev.text.trim().length > 0 || (lastGoodRev.thinking && lastGoodRev.thinking.trim().length > 0)));

      if (isFiltered && hasMeaningfulContent && lastGoodRev) {
        lines.push('### Recovery');
        lines.push('');
        lines.push('> **StreamArchive Recovery**');
        lines.push('>');
        lines.push('> DeepSeek replaced this response after CONTENT_FILTER.');
        lines.push('> A last-good pre-filter revision was preserved locally.');
        lines.push('');
        lines.push(lastGoodRev.text);
        lines.push('');

        if (options.includeReasoning && lastGoodRev.thinking && lastGoodRev.thinking.trim().length > 0) {
          lines.push('#### Preserved Thought Process');
          lines.push('');
          lines.push(lastGoodRev.thinking);
          lines.push('');
        }
      }
    }

    // Optional Revision History
    if (options.includeRevisions && revisions.length > 0) {
      lines.push('### Revision History');
      lines.push('');
      const sortedRevs = [...revisions].sort((a, b) => a.revisionIndex - b.revisionIndex);
      for (const rev of sortedRevs) {
        lines.push(`#### Revision ${rev.revisionIndex} (${rev.source})`);
        lines.push(`- **Captured:** ${formatIso(rev.capturedAt)}`);
        lines.push(`- **Final:** ${rev.isFinal ? 'Yes' : 'No'}`);
        lines.push(`- **Last-Good:** ${rev.isLastGood ? 'Yes' : 'No'}`);
        lines.push('');
        if (rev.text.trim().length > 0) {
          lines.push(rev.text);
          lines.push('');
        }
        if (options.includeReasoning && rev.thinking && rev.thinking.trim().length > 0) {
          lines.push(`*Reasoning (${rev.thinking.length} chars):*`);
          lines.push('');
          lines.push(rev.thinking);
          lines.push('');
        }
      }
    }
  }

  // 5. Appendix for non-empty unmatched captures (if any exist)
  if (unmatchedTurns.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## Unmatched Stream Captures');
    lines.push('');
    lines.push('> *These captures represent partial streaming text recorded before a network interruption, but were not part of the final server conversation tree.*');
    lines.push('');

    for (const item of unmatchedTurns) {
      const streamKey = item.message.sourceRawStreamKey || item.message.id;
      const pref = selectPreferredRevision(item.message, item.revisions);
      const text = pref?.text ?? item.message.content ?? '';
      lines.push(`### Capture \`${streamKey}\``);
      lines.push(`- **Captured:** ${formatIso(item.message.createdAt)}`);
      lines.push(`- **Length:** ${text.length} characters`);
      lines.push('');
      lines.push(text);
      lines.push('');
    }
  }

  return lines.join('\n');
}
