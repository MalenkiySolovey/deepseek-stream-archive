import { describe, it, expect } from 'vitest';
import {
  isDeepSeekHistoryEndpoint,
  extractHistorySessionId,
  DEEPSEEK_HISTORY_ENDPOINT,
} from '../src/adapters/deepseek/history/capture-policy';
import { DeepSeekHistoryParser } from '../src/adapters/deepseek/history/parser';

describe('DeepSeek History Capture Policy & Parser', () => {
  describe('capture-policy endpoint validation', () => {
    it('accepts valid https://chat.deepseek.com history endpoints with chat_session_id', () => {
      const url = 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=session-uuid-123';
      expect(isDeepSeekHistoryEndpoint(url)).toBe(true);
      expect(extractHistorySessionId(url)).toBe('session-uuid-123');
    });

    it('accepts relative /api/v0/chat/history_messages path with chat_session_id', () => {
      const url = '/api/v0/chat/history_messages?chat_session_id=sess-456';
      expect(isDeepSeekHistoryEndpoint(url)).toBe(true);
      expect(extractHistorySessionId(url)).toBe('sess-456');
    });

    it('rejects foreign origin domains attempting to impersonate DeepSeek', () => {
      expect(isDeepSeekHistoryEndpoint('https://evil.com/api/v0/chat/history_messages?chat_session_id=123')).toBe(false);
      expect(isDeepSeekHistoryEndpoint('https://chat.deepseek.com.evil.com/api/v0/chat/history_messages?chat_session_id=123')).toBe(false);
      expect(isDeepSeekHistoryEndpoint('http://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=123')).toBe(false);
      expect(isDeepSeekHistoryEndpoint('https://chat.deepseek.com:8443/api/v0/chat/history_messages?chat_session_id=123')).toBe(false);
    });

    it('rejects generation streaming endpoints or unrelated endpoints', () => {
      expect(isDeepSeekHistoryEndpoint('https://chat.deepseek.com/api/v0/chat/completion')).toBe(false);
      expect(isDeepSeekHistoryEndpoint('https://chat.deepseek.com/api/v0/chat_session/fetch_page')).toBe(false);
      expect(isDeepSeekHistoryEndpoint('https://chat.deepseek.com/api/v0/chat/history_messages')).toBe(false); // missing chat_session_id
    });

    it('rejects requests containing unallowlisted query parameters', () => {
      const poisonedUrl = 'https://chat.deepseek.com/api/v0/chat/history_messages?chat_session_id=123&token=malicious';
      expect(isDeepSeekHistoryEndpoint(poisonedUrl)).toBe(false);
    });
  });

  describe('DeepSeekHistoryParser', () => {
    it('parses complete history payload with multi-round branching, thinking, and fragments', () => {
      const samplePayload = {
        code: 0,
        msg: '',
        data: {
          biz_code: 0,
          biz_msg: '',
          biz_data: {
            chat_session: {
              id: 'sess-abc-789',
              title: 'Advanced Agentic Coding',
              model_type: 'deepseek-r1',
              pinned: true,
              updated_at: 1710000000,
              current_message_id: 'msg-3',
            },
            chat_messages: [
              {
                message_id: 'msg-1',
                parent_id: null,
                role: 'user',
                status: 'FINISHED',
                inserted_at: 1709999900,
                fragments: [
                  { id: 1, type: 'REQUEST', content: 'Explain quantum entanglement' },
                ],
              },
              {
                message_id: 'msg-2',
                parent_id: 'msg-1',
                role: 'assistant',
                status: 'FINISHED',
                inserted_at: 1709999950,
                fragments: [
                  { id: 1, type: 'THINK', content: 'Analyzing EPR paradox...' },
                  { id: 2, type: 'THINK', content: 'Formulating physical explanation.' },
                  { id: 3, type: 'RESPONSE', content: 'Quantum entanglement is a phenomenon ' },
                  { id: 4, type: 'RESPONSE', content: 'where pairs of particles interact.' },
                ],
              },
              {
                // Branching sibling message (e.g. regenerated from same parent msg-1)
                message_id: 'msg-3',
                parent_id: 'msg-1',
                role: 'assistant',
                status: 'FINISHED',
                inserted_at: 1709999980,
                fragments: [
                  { id: 1, type: 'THINK', content: 'Alternative perspective...' },
                  { id: 2, type: 'RESPONSE', content: 'In quantum physics, entanglement means...' },
                ],
              },
            ],
          },
        },
      };

      const result = DeepSeekHistoryParser.parse(JSON.stringify(samplePayload));
      expect(result).not.toBeNull();
      expect(result!.session.sessionId).toBe('sess-abc-789');
      expect(result!.session.title).toBe('Advanced Agentic Coding');
      expect(result!.session.pinned).toBe(true);
      expect(result!.session.updatedAt).toBe(1710000000000);

      expect(result!.messages).toHaveLength(3);

      const userMsg = result!.messages[0]!;
      expect(userMsg.messageId).toBe('msg-1');
      expect(userMsg.parentId).toBeNull();
      expect(userMsg.role).toBe('user');
      expect(userMsg.text).toBe('Explain quantum entanglement');
      expect(userMsg.thinking).toBeUndefined();

      const assistantMsg1 = result!.messages[1]!;
      expect(assistantMsg1.messageId).toBe('msg-2');
      expect(assistantMsg1.parentId).toBe('msg-1');
      expect(assistantMsg1.role).toBe('assistant');
      expect(assistantMsg1.thinking).toBe('Analyzing EPR paradox...\nFormulating physical explanation.');
      expect(assistantMsg1.text).toBe('Quantum entanglement is a phenomenon where pairs of particles interact.');
      expect(assistantMsg1.isFiltered).toBe(false);

      const siblingMsg = result!.messages[2]!;
      expect(siblingMsg.messageId).toBe('msg-3');
      expect(siblingMsg.parentId).toBe('msg-1'); // Preserves identical parentId without collapsing
      expect(siblingMsg.text).toBe('In quantum physics, entanglement means...');
    });

    it('identifies CONTENT_FILTER and TEMPLATE_RESPONSE fragments in history', () => {
      const filteredPayload = {
        code: 0,
        data: {
          biz_code: 0,
          biz_data: {
            chat_session: { id: 'sess-filter', title: 'Filtered Chat' },
            chat_messages: [
              {
                message_id: 'msg-censored',
                parent_id: 'msg-user',
                role: 'assistant',
                status: 'CONTENT_FILTER',
                fragments: [
                  { id: 1, type: 'THINK', content: 'Evaluating safety boundaries...' },
                  { id: 2, type: 'TEMPLATE_RESPONSE', content: 'Content unavailable due to safety review.' },
                ],
              },
            ],
          },
        },
      };

      const result = DeepSeekHistoryParser.parse(filteredPayload);
      expect(result).not.toBeNull();
      const msg = result!.messages[0]!;
      expect(msg.isFiltered).toBe(true);
      expect(msg.status).toBe('filtered');
      expect(msg.templateResponse).toBe('Content unavailable due to safety review.');
      expect(msg.thinking).toBe('Evaluating safety boundaries...');
    });

    it('gracefully handles user message with direct content string fallback', () => {
      const payload = {
        code: 0,
        data: {
          biz_data: {
            chat_session: { id: 'sess-direct' },
            chat_messages: [
              {
                message_id: 'm-direct',
                role: 'user',
                content: 'Direct prompt without fragments',
              },
            ],
          },
        },
      };

      const result = DeepSeekHistoryParser.parse(payload);
      expect(result).not.toBeNull();
      expect(result!.messages[0]!.text).toBe('Direct prompt without fragments');
    });

    it('normalizes numeric IDs into strings across session and messages', () => {
      const payload = {
        code: 0,
        data: {
          biz_data: {
            chat_session: {
              id: 998877,
              current_message_id: 1002,
              title: 'Numeric Session',
            },
            chat_messages: [
              {
                message_id: 1001,
                parent_id: null,
                role: 'user',
                content: 'Hello',
              },
              {
                message_id: 1002,
                parent_id: 1001,
                role: 'assistant',
                status: 'FINISHED',
                response_content: 'Hi there!',
              },
            ],
          },
        },
      };

      const result = DeepSeekHistoryParser.parse(payload);
      expect(result).not.toBeNull();
      expect(result!.session.sessionId).toBe('998877');
      expect(result!.session.currentMessageId).toBe('1002');
      expect(result!.messages[0]!.messageId).toBe('1001');
      expect(result!.messages[0]!.parentId).toBeNull();
      expect(result!.messages[1]!.messageId).toBe('1002');
      expect(result!.messages[1]!.parentId).toBe('1001');
    });

    it('resolves session ID from context when payload omits chat_session object', () => {
      const payload = {
        code: 0,
        data: {
          biz_data: {
            chat_messages: [
              {
                message_id: 'm-only',
                role: 'user',
                content: 'Orphaned session message',
              },
            ],
          },
        },
      };

      // Without context, fails because session ID cannot be resolved
      expect(DeepSeekHistoryParser.parse(payload)).toBeNull();

      // With expectedSessionId in context, resolves successfully
      const result = DeepSeekHistoryParser.parse(payload, { expectedSessionId: 'sess-query-uuid' });
      expect(result).not.toBeNull();
      expect(result!.session.sessionId).toBe('sess-query-uuid');
      expect(result!.messages).toHaveLength(1);
    });

    it('rejects history payload when payload session ID mismatches expectedSessionId', () => {
      const payload = {
        code: 0,
        data: {
          biz_data: {
            chat_session: { id: 'sess-real' },
            chat_messages: [],
          },
        },
      };

      const result = DeepSeekHistoryParser.parse(payload, { expectedSessionId: 'sess-wrong' });
      expect(result).toBeNull();
    });

    it('defaults assistant status to unknown (never finished) when status is missing', () => {
      const payload = {
        code: 0,
        data: {
          biz_data: {
            chat_session: { id: 'sess-status-test' },
            chat_messages: [
              {
                message_id: 'm-user',
                role: 'user',
                content: 'Prompt',
              },
              {
                message_id: 'm-asst',
                role: 'assistant',
                // status omitted!
                fragments: [{ type: 'RESPONSE', content: 'Partial answer' }],
              },
            ],
          },
        },
      };

      const result = DeepSeekHistoryParser.parse(payload);
      expect(result).not.toBeNull();
      expect(result!.messages[0]!.status).toBe('finished'); // user message
      expect(result!.messages[1]!.status).toBe('unknown'); // assistant message defaults to unknown
    });

    it('enforces dual-shape: ignores REQUEST fragments in assistant message and separates THINK', () => {
      const payload = {
        code: 0,
        data: {
          biz_data: {
            chat_session: { id: 'sess-dual' },
            chat_messages: [
              {
                message_id: 'm-asst-dual',
                role: 'assistant',
                status: 'FINISHED',
                fragments: [
                  { type: 'REQUEST', content: 'Injected user prompt echo' },
                  { type: 'THINK', content: 'Inner reasoning' },
                  { type: 'RESPONSE', content: 'Actual response' },
                ],
              },
            ],
          },
        },
      };

      const result = DeepSeekHistoryParser.parse(payload);
      expect(result).not.toBeNull();
      expect(result!.messages[0]!.text).toBe('Actual response'); // REQUEST NOT included
      expect(result!.messages[0]!.thinking).toBe('Inner reasoning');
    });

    it('deduplicates identical duplicate remote message IDs in a single history payload', () => {
      const payload = {
        code: 0,
        data: {
          biz_data: {
            chat_session: { id: 'sess-dup' },
            chat_messages: [
              { message_id: 'dup-1', role: 'user', content: 'First' },
              { message_id: 'dup-1', role: 'user', content: 'First' },
              { message_id: 'dup-2', role: 'assistant', content: 'Second' },
            ],
          },
        },
      };

      const result = DeepSeekHistoryParser.parse(payload);
      expect(result).not.toBeNull();
      expect(result!.messages).toHaveLength(2);
      expect(result!.messages.map((m) => m.messageId)).toEqual(['dup-1', 'dup-2']);
    });

    it('rejects history payload when duplicate remote message ID has conflicting content or metadata', () => {
      const payload = {
        code: 0,
        data: {
          biz_data: {
            chat_session: { id: 'sess-dup-conflict' },
            chat_messages: [
              { message_id: 'dup-1', role: 'user', content: 'Original text' },
              { message_id: 'dup-1', role: 'user', content: 'Conflicting duplicate text' },
            ],
          },
        },
      };

      const result = DeepSeekHistoryParser.parse(payload);
      expect(result).toBeNull();
    });

    it('rejects invalid or error payloads', () => {
      expect(DeepSeekHistoryParser.parse(null)).toBeNull();
      expect(DeepSeekHistoryParser.parse('')).toBeNull();
      expect(DeepSeekHistoryParser.parse('{ malformed json }')).toBeNull();
      expect(DeepSeekHistoryParser.parse({ code: 401, msg: 'Unauthorized' })).toBeNull();
      expect(DeepSeekHistoryParser.parse({ code: 0, data: { biz_code: 500 } })).toBeNull();
      expect(DeepSeekHistoryParser.parse({ code: 0, data: { biz_data: {} } })).toBeNull(); // missing session id
    });
  });
});
