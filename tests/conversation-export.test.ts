import { describe, it, expect } from 'vitest';
import type { ConversationExportModel, ConversationExportOptions } from '../src/export/types';
import { buildConversationMarkdown } from '../src/export/markdown-exporter';
import { buildConversationExportDto, buildConversationJson } from '../src/export/json-exporter';
import type { Conversation, Message, ResponseRevision, RecoveryEvent } from '../src/core/models';

describe('Human Conversation Export (Markdown & Structured JSON)', () => {
  const baseConversation: Conversation = {
    id: 'conv_export_1',
    remoteId: 'remote_session_999',
    title: 'Comparing Distributed Architectures',
    createdAt: 1730500000000,
    updatedAt: 1730500100000,
  };

  const userMessage: Message = {
    id: 'msg_u1',
    conversationId: 'conv_export_1',
    role: 'user',
    status: 'finished',
    identityState: 'reconciled',
    projectionState: 'logical',
    content: 'Explain the difference between TCP and UDP with [reference:0].',
    createdAt: 1730500000000,
    updatedAt: 1730500000000,
  };

  const asstMessage: Message = {
    id: 'msg_a1',
    conversationId: 'conv_export_1',
    parentId: 'msg_u1',
    remoteId: 'remote_msg_101',
    role: 'assistant',
    status: 'finished',
    identityState: 'reconciled',
    projectionState: 'logical',
    content: 'TCP provides reliable, ordered stream delivery [reference:0]. UDP is connectionless and datagram-oriented.',
    createdAt: 1730500010000,
    updatedAt: 1730500050000,
  };

  const asstRevision: ResponseRevision = {
    id: 'rev_a1_0',
    messageId: 'msg_a1',
    revisionIndex: 0,
    source: 'network',
    isFinal: true,
    isLastGood: false,
    text: asstMessage.content!,
    thinking: 'Analyzing the protocol tradeoffs: reliability vs speed. Selecting bullet points.',
    capturedAt: 1730500045000,
  };

  it('generates deterministic human Markdown for a standard linear conversation', () => {
    const model: ConversationExportModel = {
      conversation: baseConversation,
      messages: [
        { message: userMessage, revisions: [], recoveryEvents: [] },
        { message: asstMessage, revisions: [asstRevision], recoveryEvents: [] },
      ],
    };

    const options: ConversationExportOptions = {
      format: 'markdown',
      branches: 'all',
      includeReasoning: true,
      includeRevisions: false,
      includeRecovery: true,
    };

    const md = buildConversationMarkdown(model, options);

    expect(md).toContain('# Comparing Distributed Architectures');
    expect(md).toContain('- **Conversation ID:** `conv_export_1`');
    expect(md).toContain('- **DeepSeek Session ID:** `remote_session_999`');
    expect(md).toContain('- **StreamArchive Format:** `human-markdown-v1`');
    expect(md).toContain('## User');
    expect(md).toContain('Explain the difference between TCP and UDP with [reference:0].');
    expect(md).toContain('## Assistant');
    expect(md).toContain('- **Status:** `finished`');
    expect(md).toContain('- **Remote ID:** `remote_msg_101`');
    expect(md).toContain('TCP provides reliable, ordered stream delivery [reference:0].');
    expect(md).toContain('### DeepThink');
    expect(md).toContain('Analyzing the protocol tradeoffs');
    // Ensure raw reference token is preserved
    expect(md).toContain('[reference:0]');
  });

  it('omits DeepThink reasoning when includeReasoning is false', () => {
    const model: ConversationExportModel = {
      conversation: baseConversation,
      messages: [
        { message: userMessage, revisions: [], recoveryEvents: [] },
        { message: asstMessage, revisions: [asstRevision], recoveryEvents: [] },
      ],
    };

    const options: ConversationExportOptions = {
      format: 'markdown',
      branches: 'all',
      includeReasoning: false,
      includeRevisions: false,
      includeRecovery: true,
    };

    const md = buildConversationMarkdown(model, options);
    expect(md).not.toContain('### DeepThink');
    expect(md).not.toContain('Analyzing the protocol tradeoffs');
    expect(md).toContain('TCP provides reliable, ordered stream delivery');
  });

  it('correctly labels and numbers real sibling branches when multiple assistant responses exist', () => {
    const asstMessage2: Message = {
      id: 'msg_a2_regen',
      conversationId: 'conv_export_1',
      parentId: 'msg_u1',
      remoteId: 'remote_msg_102',
      role: 'assistant',
      status: 'finished',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: 'Alternative viewpoint: UDP offers minimal protocol latency, ideal for gaming.',
      createdAt: 1730500060000,
      updatedAt: 1730500090000,
    };

    const asstRevision2: ResponseRevision = {
      id: 'rev_a2_0',
      messageId: 'msg_a2_regen',
      revisionIndex: 0,
      source: 'network',
      isFinal: true,
      isLastGood: false,
      text: asstMessage2.content!,
      capturedAt: 1730500085000,
    };

    const model: ConversationExportModel = {
      conversation: baseConversation,
      messages: [
        { message: userMessage, revisions: [], recoveryEvents: [] },
        { message: asstMessage, revisions: [asstRevision], recoveryEvents: [] },
        { message: asstMessage2, revisions: [asstRevision2], recoveryEvents: [] },
      ],
    };

    // 1. Export all branches
    const mdAll = buildConversationMarkdown(model, {
      format: 'markdown',
      branches: 'all',
      includeReasoning: false,
      includeRevisions: false,
      includeRecovery: true,
    });

    expect(mdAll).toContain('## Assistant — Branch 1 of 2');
    expect(mdAll).toContain('## Assistant — Branch 2 of 2');
    expect(mdAll).toContain('TCP provides reliable');
    expect(mdAll).toContain('Alternative viewpoint: UDP');

    // 2. Export active branch only (select branch index 1)
    const mdActive = buildConversationMarkdown(model, {
      format: 'markdown',
      branches: 'active',
      includeReasoning: false,
      includeRevisions: false,
      includeRecovery: true,
      branchSelections: { msg_u1: 1 },
    });

    expect(mdActive).not.toContain('## Assistant — Branch 1 of 2');
    expect(mdActive).toContain('## Assistant — Branch 2 of 2');
    expect(mdActive).toContain('Alternative viewpoint: UDP');
    expect(mdActive).not.toContain('TCP provides reliable');
  });

  it('truthfully exports censored recovery events and preserved pre-filter text', () => {
    const censoredMsg: Message = {
      id: 'msg_censored_1',
      conversationId: 'conv_export_1',
      parentId: 'msg_u1',
      role: 'assistant',
      status: 'filtered',
      identityState: 'reconciled',
      projectionState: 'logical',
      content: "I'm sorry, but I cannot answer this request according to safety policy.",
      createdAt: 1730500010000,
      updatedAt: 1730500050000,
    };

    const lastGoodRev: ResponseRevision = {
      id: 'rev_last_good',
      messageId: 'msg_censored_1',
      revisionIndex: 0,
      source: 'network',
      isFinal: false,
      isLastGood: true,
      text: 'Detailed uncensored technical explanation generated before server filter trigger...',
      thinking: 'Pre-filter thought process regarding cryptography and key exchange protocols.',
      capturedAt: 1730500030000,
    };

    const serverTemplateRev: ResponseRevision = {
      id: 'rev_template',
      messageId: 'msg_censored_1',
      revisionIndex: 1,
      source: 'history',
      isFinal: true,
      isLastGood: false,
      text: censoredMsg.content!,
      capturedAt: 1730500050000,
    };

    const recEvent: RecoveryEvent = {
      id: 'rec_event_1',
      messageId: 'msg_censored_1',
      kind: 'content_filter',
      detectedAt: 1730500035000,
      recoveredRevisionId: 'rev_last_good',
    };

    const model: ConversationExportModel = {
      conversation: baseConversation,
      messages: [
        { message: userMessage, revisions: [], recoveryEvents: [] },
        {
          message: censoredMsg,
          revisions: [lastGoodRev, serverTemplateRev],
          recoveryEvents: [recEvent],
        },
      ],
    };

    const md = buildConversationMarkdown(model, {
      format: 'markdown',
      branches: 'all',
      includeReasoning: true,
      includeRevisions: false,
      includeRecovery: true,
    });

    expect(md).toContain('### Recovery');
    expect(md).toContain('StreamArchive Recovery');
    expect(md).toContain('DeepSeek replaced this response after CONTENT_FILTER.');
    expect(md).toContain('Detailed uncensored technical explanation generated before server filter trigger...');
    expect(md).toContain('Pre-filter thought process regarding cryptography');
  });

  it('strictly excludes attempt_only records from human export while isolating unmatched captures in appendix', () => {
    // 2D.3 scenario: 1 user prompt, 2 empty interrupted transport attempts, 1 partial capture, 1 final assistant
    const attemptOnly1: Message = {
      id: 'msg_attempt_1',
      conversationId: 'conv_export_1',
      role: 'assistant',
      status: 'interrupted',
      identityState: 'provisional',
      projectionState: 'attempt_only',
      content: '',
      createdAt: 1730500005000,
      updatedAt: 1730500006000,
    };

    const attemptOnly2: Message = {
      id: 'msg_attempt_2',
      conversationId: 'conv_export_1',
      role: 'assistant',
      status: 'interrupted',
      identityState: 'provisional',
      projectionState: 'attempt_only',
      content: '',
      createdAt: 1730500007000,
      updatedAt: 1730500008000,
    };

    const unmatchedCapture: Message = {
      id: 'msg_unmatched_1',
      conversationId: 'conv_export_1',
      sourceRawStreamKey: 'prod_sess:stream_xhr_2',
      role: 'assistant',
      status: 'interrupted',
      identityState: 'provisional',
      projectionState: 'unmatched_capture',
      content: 'Partial network response captured before the socket closed abruptly.',
      createdAt: 1730500009000,
      updatedAt: 1730500015000,
    };

    const model: ConversationExportModel = {
      conversation: baseConversation,
      messages: [
        { message: userMessage, revisions: [], recoveryEvents: [] },
        { message: attemptOnly1, revisions: [], recoveryEvents: [] },
        { message: attemptOnly2, revisions: [], recoveryEvents: [] },
        { message: unmatchedCapture, revisions: [], recoveryEvents: [] },
        { message: asstMessage, revisions: [asstRevision], recoveryEvents: [] },
      ],
    };

    // 1. Markdown export verification
    const md = buildConversationMarkdown(model, {
      format: 'markdown',
      branches: 'all',
      includeReasoning: false,
      includeRevisions: false,
      includeRecovery: true,
    });

    // Zero fake branch selectors should exist
    expect(md).not.toContain('Branch 1 of 3');
    expect(md).not.toContain('msg_attempt_1');
    expect(md).not.toContain('msg_attempt_2');

    // Unmatched capture must appear in distinct appendix
    expect(md).toContain('## Unmatched Stream Captures');
    expect(md).toContain('Capture `prod_sess:stream_xhr_2`');
    expect(md).toContain('Partial network response captured before the socket closed');

    // 2. Structured JSON DTO verification
    const dto = buildConversationExportDto(model, {
      format: 'json',
      branches: 'all',
      includeReasoning: true,
      includeRevisions: false,
      includeRecovery: true,
    });

    expect(dto.format).toBe('deepseek-streamarchive-conversation');
    expect(dto.formatVersion).toBe(1);
    // Messages must contain ONLY user and logical assistant (2 total)
    expect(dto.messages).toHaveLength(2);
    expect(dto.messages[0]?.role).toBe('user');
    expect(dto.messages[1]?.role).toBe('assistant');
    // attempt_only records must be completely absent from messages
    expect(dto.messages.some((m) => m.projectionState === 'attempt_only')).toBe(false);

    // Unmatched captures must be partitioned into dedicated array
    expect(dto.unmatchedCaptures).toBeDefined();
    expect(dto.unmatchedCaptures).toHaveLength(1);
    expect(dto.unmatchedCaptures![0]?.sourceRawStreamKey).toBe('prod_sess:stream_xhr_2');
    expect(dto.unmatchedCaptures![0]?.text).toContain('Partial network response captured');
  });

  it('renders optional revision history when includeRevisions is enabled', () => {
    const rev0: ResponseRevision = {
      id: 'rev_0',
      messageId: 'msg_a1',
      revisionIndex: 0,
      source: 'network',
      isFinal: false,
      isLastGood: false,
      text: 'Draft 0 streaming...',
      capturedAt: 1730500020000,
    };
    const rev1: ResponseRevision = {
      id: 'rev_1',
      messageId: 'msg_a1',
      revisionIndex: 1,
      source: 'history',
      isFinal: true,
      isLastGood: false,
      text: 'Final version from server history.',
      capturedAt: 1730500050000,
    };

    const model: ConversationExportModel = {
      conversation: baseConversation,
      messages: [
        { message: userMessage, revisions: [], recoveryEvents: [] },
        { message: asstMessage, revisions: [rev0, rev1], recoveryEvents: [] },
      ],
    };

    const md = buildConversationMarkdown(model, {
      format: 'markdown',
      branches: 'all',
      includeReasoning: false,
      includeRevisions: true,
      includeRecovery: false,
    });

    expect(md).toContain('### Revision History');
    expect(md).toContain('#### Revision 0 (network)');
    expect(md).toContain('Draft 0 streaming...');
    expect(md).toContain('#### Revision 1 (history)');
    expect(md).toContain('Final version from server history.');

    const json = buildConversationJson(model, {
      format: 'json',
      branches: 'all',
      includeReasoning: false,
      includeRevisions: true,
      includeRecovery: false,
    });

    const parsed = JSON.parse(json);
    expect(parsed.messages[1].revisions).toHaveLength(2);
    expect(parsed.messages[1].revisions[0].text).toBe('Draft 0 streaming...');
  });
});
