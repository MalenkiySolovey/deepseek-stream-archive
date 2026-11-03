import { describe, it, expect } from 'vitest';
import { augmentDeepSeekRequest } from '../src/adapters/deepseek/request/augment';
import type { ContextDeliveryEnvelope } from '../src/adapters/deepseek/request/types';

describe('DeepSeek Request Augmenter', () => {
  const baseEnvelope: ContextDeliveryEnvelope = {
    deliveryId: 'deliv-uuid-001',
    conversationId: 'conv-local-1',
    remoteConversationId: 'session-remote-100',
    expectedParentMessageId: 'msg-parent-leaf',
    formattedContext: '[StreamArchive recovered conversation context]\nRecovered answer: 42\n[End StreamArchive recovered conversation context]',
    sourceMessageIds: ['msg-rec-1'],
    sourceRevisionIds: ['rev-rec-1'],
    deliveryMode: 'manual_next',
    createdAt: 1000,
    expiresAt: 5000,
  };

  it('augments eligible request and strictly preserves all non-prompt fields', () => {
    const rawBody = JSON.stringify({
      chat_session_id: 'session-remote-100',
      parent_message_id: 'msg-parent-leaf',
      prompt: 'What was the result?',
      ref_file_ids: ['f1', 'f2'],
      thinking_enabled: true,
      search_enabled: false,
      preempt: false,
      custom_vendor_flag: 'keep-me',
    });

    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      method: 'POST',
      body: rawBody,
      envelope: baseEnvelope,
      now: 2000,
    });

    expect(result.augmented).toBe(true);
    if (!result.augmented) return;

    expect(result.deliveryId).toBe('deliv-uuid-001');
    expect(result.originalPrompt).toBe('What was the result?');
    expect(result.augmentedPrompt).toContain('[StreamArchive Context Continuity v1 — deliv-uuid-001]');
    expect(result.augmentedPrompt).toContain('Recovered answer: 42');
    expect(result.augmentedPrompt.endsWith('What was the result?')).toBe(true);

    const parsedAugmented = JSON.parse(result.augmentedBody);
    expect(parsedAugmented.chat_session_id).toBe('session-remote-100');
    expect(parsedAugmented.parent_message_id).toBe('msg-parent-leaf');
    expect(parsedAugmented.ref_file_ids).toEqual(['f1', 'f2']);
    expect(parsedAugmented.thinking_enabled).toBe(true);
    expect(parsedAugmented.search_enabled).toBe(false);
    expect(parsedAugmented.preempt).toBe(false);
    expect(parsedAugmented.custom_vendor_flag).toBe('keep-me');
    expect(parsedAugmented.prompt).toBe(result.augmentedPrompt);
  });

  it('fails open when endpoint is not a user-generation endpoint', () => {
    const rawBody = JSON.stringify({ prompt: 'test' });
    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/regenerate',
      method: 'POST',
      body: rawBody,
      envelope: baseEnvelope,
    });

    expect(result.augmented).toBe(false);
    if (result.augmented) return;
    expect(result.reason).toBe('not_candidate_endpoint');
    expect(result.originalBody).toBe(rawBody);
  });

  it('fails open when envelope is missing (null)', () => {
    const rawBody = JSON.stringify({ prompt: 'test' });
    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      body: rawBody,
      envelope: null,
    });

    expect(result.augmented).toBe(false);
    if (result.augmented) return;
    expect(result.reason).toBe('envelope_missing');
  });

  it('fails open when envelope is expired', () => {
    const rawBody = JSON.stringify({
      chat_session_id: 'session-remote-100',
      parent_message_id: 'msg-parent-leaf',
      prompt: 'test',
    });

    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      body: rawBody,
      envelope: baseEnvelope,
      now: 6000, // baseEnvelope.expiresAt is 5000
    });

    expect(result.augmented).toBe(false);
    if (result.augmented) return;
    expect(result.reason).toBe('envelope_expired');
  });

  it('fails open when body is not a string (e.g. FormData/Blob)', () => {
    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      body: new Uint8Array([1, 2, 3]),
      envelope: baseEnvelope,
      now: 2000,
    });

    expect(result.augmented).toBe(false);
    if (result.augmented) return;
    expect(result.reason).toBe('unsupported_body_type');
  });

  it('fails open on malformed JSON body', () => {
    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      body: '{ not valid json',
      envelope: baseEnvelope,
      now: 2000,
    });

    expect(result.augmented).toBe(false);
    if (result.augmented) return;
    expect(result.reason).toBe('malformed_json');
  });

  it('fails open on empty or whitespace prompt', () => {
    const rawBody = JSON.stringify({
      chat_session_id: 'session-remote-100',
      parent_message_id: 'msg-parent-leaf',
      prompt: '   ',
    });

    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      body: rawBody,
      envelope: baseEnvelope,
      now: 2000,
    });

    expect(result.augmented).toBe(false);
    if (result.augmented) return;
    expect(result.reason).toBe('empty_or_missing_prompt');
  });

  it('fails open and does not double-inject if prompt already has continuity marker', () => {
    const alreadyAugmentedPrompt = `[StreamArchive Context Continuity v1 — deliv-uuid-001]\nRecovered\n[End StreamArchive Context Continuity]\n\nUser question`;
    const rawBody = JSON.stringify({
      chat_session_id: 'session-remote-100',
      parent_message_id: 'msg-parent-leaf',
      prompt: alreadyAugmentedPrompt,
    });

    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      body: rawBody,
      envelope: baseEnvelope,
      now: 2000,
    });

    expect(result.augmented).toBe(false);
    if (result.augmented) return;
    expect(result.reason).toBe('already_augmented');
  });

  it('fails open on chat_session_id mismatch', () => {
    const rawBody = JSON.stringify({
      chat_session_id: 'different-session-999',
      parent_message_id: 'msg-parent-leaf',
      prompt: 'test question',
    });

    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      body: rawBody,
      envelope: baseEnvelope,
      now: 2000,
    });

    expect(result.augmented).toBe(false);
    if (result.augmented) return;
    expect(result.reason).toBe('session_id_mismatch');
  });

  it('fails open on parent_message_id mismatch', () => {
    const rawBody = JSON.stringify({
      chat_session_id: 'session-remote-100',
      parent_message_id: 'other-branch-leaf',
      prompt: 'test question',
    });

    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      body: rawBody,
      envelope: baseEnvelope,
      now: 2000,
    });

    expect(result.augmented).toBe(false);
    if (result.augmented) return;
    expect(result.reason).toBe('parent_message_id_mismatch');
  });

  it('allows augmentation when expectedParentMessageId is null', () => {
    const envNoParent: ContextDeliveryEnvelope = {
      ...baseEnvelope,
      expectedParentMessageId: null,
    };

    const rawBody = JSON.stringify({
      chat_session_id: 'session-remote-100',
      parent_message_id: 'any-leaf',
      prompt: 'Hello with unconstrained parent',
    });

    const result = augmentDeepSeekRequest({
      url: 'https://chat.deepseek.com/api/v0/chat/completion',
      body: rawBody,
      envelope: envNoParent,
      now: 2000,
    });

    expect(result.augmented).toBe(true);
  });
});
