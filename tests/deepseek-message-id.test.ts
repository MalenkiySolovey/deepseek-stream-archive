import { describe, it, expect } from 'vitest';
import { findDeepSeekMessageId } from '../src/adapters/deepseek/protocol/message-id';

describe('DeepSeek Message ID Extractor', () => {
  it('extracts message_id, msg_id, and response_message_id from top level', () => {
    expect(findDeepSeekMessageId({ message_id: 'msg_101' })).toBe('msg_101');
    expect(findDeepSeekMessageId({ msg_id: 'msg_102' })).toBe('msg_102');
    expect(findDeepSeekMessageId({ response_message_id: 'msg_103' })).toBe('msg_103');
  });

  it('extracts case-insensitively and converts numeric IDs to string', () => {
    expect(findDeepSeekMessageId({ Message_Id: 987654321 })).toBe('987654321');
    expect(findDeepSeekMessageId({ RESPONSE_MESSAGE_ID: 12345 })).toBe('12345');
  });

  it('deliberately rejects bare id, chat_session_id, and parent_message_id', () => {
    expect(findDeepSeekMessageId({ id: 'some_id' })).toBeNull();
    expect(findDeepSeekMessageId({ chat_session_id: 'sess_123' })).toBeNull();
    expect(findDeepSeekMessageId({ parent_message_id: 'parent_456' })).toBeNull();
  });

  it('finds nested message IDs in objects and arrays within depth bounds', () => {
    const payload = {
      response: {
        meta: {
          inner: {
            message_id: 'deep_msg_01',
          },
        },
      },
    };
    expect(findDeepSeekMessageId(payload)).toBe('deep_msg_01');

    const arrayPayload = {
      response: {
        choices: [
          { dummy: true },
          { response_message_id: 'arr_msg_02' },
        ],
      },
    };
    expect(findDeepSeekMessageId(arrayPayload)).toBe('arr_msg_02');
  });

  it('enforces depth limit of 5 and avoids infinite recursion', () => {
    // Exactly depth 5
    const depth5 = {
      l1: {
        l2: {
          l3: {
            l4: {
              l5: {
                message_id: 'valid_at_5',
              },
            },
          },
        },
      },
    };
    expect(findDeepSeekMessageId(depth5)).toBe('valid_at_5');

    // Depth 6 (exceeds max depth 5)
    const depth6 = {
      l1: {
        l2: {
          l3: {
            l4: {
              l5: {
                l6: {
                  message_id: 'too_deep',
                },
              },
            },
          },
        },
      },
    };
    expect(findDeepSeekMessageId(depth6)).toBeNull();
  });

  it('returns null for non-objects, empty objects, or non-scalar IDs', () => {
    expect(findDeepSeekMessageId(null)).toBeNull();
    expect(findDeepSeekMessageId(undefined)).toBeNull();
    expect(findDeepSeekMessageId('string')).toBeNull();
    expect(findDeepSeekMessageId(123)).toBeNull();
    expect(findDeepSeekMessageId({})).toBeNull();
    expect(findDeepSeekMessageId({ message_id: {} })).toBeNull();
    expect(findDeepSeekMessageId({ message_id: '' })).toBeNull();
    expect(findDeepSeekMessageId({ message_id: '   ' })).toBeNull();
  });
});
