import { describe, it, expect } from 'vitest';
import {
  isDeepSeekUserGenerationEndpoint,
  normalizeEndpointPath,
  parseDeepSeekRequestBody,
} from '../src/adapters/deepseek/request/parser';

describe('DeepSeek Request Parser & Predicate', () => {
  describe('normalizeEndpointPath', () => {
    it('normalizes full URLs and relative paths', () => {
      expect(normalizeEndpointPath('https://chat.deepseek.com/api/v0/chat/completion')).toBe(
        '/api/v0/chat/completion'
      );
      expect(
        normalizeEndpointPath('https://chat.deepseek.com/api/v0/chat/completion?client=web#frag')
      ).toBe('/api/v0/chat/completion');
      expect(normalizeEndpointPath('/api/v0/chat/completion')).toBe('/api/v0/chat/completion');
      expect(normalizeEndpointPath('/api/v0/chat/completion?foo=bar')).toBe(
        '/api/v0/chat/completion'
      );
    });
  });

  describe('isDeepSeekUserGenerationEndpoint', () => {
    it('accepts completion and edit_message with POST', () => {
      expect(
        isDeepSeekUserGenerationEndpoint(
          'https://chat.deepseek.com/api/v0/chat/completion',
          'POST'
        )
      ).toBe(true);
      expect(isDeepSeekUserGenerationEndpoint('/api/v0/chat/completion', 'post')).toBe(true);
      expect(
        isDeepSeekUserGenerationEndpoint('https://chat.deepseek.com/api/v0/chat/edit_message')
      ).toBe(true);
    });

    it('rejects GET requests even on generation endpoints', () => {
      expect(
        isDeepSeekUserGenerationEndpoint(
          'https://chat.deepseek.com/api/v0/chat/completion',
          'GET'
        )
      ).toBe(false);
    });

    it('rejects endpoints that do not accept user-authored prompts', () => {
      expect(
        isDeepSeekUserGenerationEndpoint(
          'https://chat.deepseek.com/api/v0/chat/regenerate',
          'POST'
        )
      ).toBe(false);
      expect(
        isDeepSeekUserGenerationEndpoint('https://chat.deepseek.com/api/v0/chat/continue', 'POST')
      ).toBe(false);
      expect(
        isDeepSeekUserGenerationEndpoint(
          'https://chat.deepseek.com/api/v0/chat/resume_stream',
          'POST'
        )
      ).toBe(false);
      expect(
        isDeepSeekUserGenerationEndpoint(
          'https://chat.deepseek.com/api/v0/chat/history_messages',
          'GET'
        )
      ).toBe(false);
      expect(
        isDeepSeekUserGenerationEndpoint(
          'https://chat.deepseek.com/api/v0/users/current',
          'GET'
        )
      ).toBe(false);
    });
  });

  describe('parseDeepSeekRequestBody', () => {
    it('parses valid DeepSeek JSON request bodies', () => {
      const raw = JSON.stringify({
        chat_session_id: 'session-123',
        parent_message_id: 'msg-456',
        prompt: 'Hello DeepSeek',
        ref_file_ids: ['file-1', 'file-2'],
        thinking_enabled: true,
        search_enabled: false,
      });

      const parsed = parseDeepSeekRequestBody(raw);
      expect(parsed).not.toBeNull();
      expect(parsed?.chat_session_id).toBe('session-123');
      expect(parsed?.parent_message_id).toBe('msg-456');
      expect(parsed?.prompt).toBe('Hello DeepSeek');
      expect(parsed?.ref_file_ids).toEqual(['file-1', 'file-2']);
      expect(parsed?.thinking_enabled).toBe(true);
      expect(parsed?.search_enabled).toBe(false);
    });

    it('returns null on non-string inputs (fail-open for FormData, Blob, Streams)', () => {
      expect(parseDeepSeekRequestBody(null)).toBeNull();
      expect(parseDeepSeekRequestBody(undefined)).toBeNull();
      expect(parseDeepSeekRequestBody({ prompt: 'test' })).toBeNull();
      expect(parseDeepSeekRequestBody(new Uint8Array([1, 2, 3]))).toBeNull();
    });

    it('returns null on invalid JSON strings', () => {
      expect(parseDeepSeekRequestBody('{ malformed json')).toBeNull();
      expect(parseDeepSeekRequestBody('')).toBeNull();
      expect(parseDeepSeekRequestBody('   ')).toBeNull();
      expect(parseDeepSeekRequestBody('["array", "not", "object"]')).toBeNull();
      expect(parseDeepSeekRequestBody('"string literal"')).toBeNull();
    });
  });
});
