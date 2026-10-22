import { describe, it, expect } from 'vitest';
import {
  normalizePathname,
  isDeepSeekGenerationEndpoint,
  GENERATION_ENDPOINTS,
} from '../src/adapters/deepseek/compatibility/candidate-policy';

describe('Endpoint Matching Bounds & Normalization', () => {
  describe('normalizePathname()', () => {
    it('normalizes standard absolute URLs', () => {
      expect(normalizePathname('https://chat.deepseek.com/api/v0/chat/completion')).toBe(
        '/api/v0/chat/completion'
      );
      expect(normalizePathname('https://chat.deepseek.com/api/v0/chat/edit_message')).toBe(
        '/api/v0/chat/edit_message'
      );
    });

    it('strips query parameters and hashes', () => {
      expect(
        normalizePathname('https://chat.deepseek.com/api/v0/chat/completion?session_id=123&token=secret#part')
      ).toBe('/api/v0/chat/completion');

      expect(normalizePathname('/api/v0/chat/regenerate?foo=bar#top')).toBe(
        '/api/v0/chat/regenerate'
      );
    });

    it('normalizes redundant and trailing slashes', () => {
      expect(normalizePathname('/api/v0/chat/completion/')).toBe('/api/v0/chat/completion');
      expect(normalizePathname('///api///v0//chat//completion///')).toBe('/api/v0/chat/completion');
    });

    it('handles relative paths without origin', () => {
      expect(normalizePathname('/api/v0/chat/continue')).toBe('/api/v0/chat/continue');
      expect(normalizePathname('api/v0/chat/continue')).toBe('/api/v0/chat/continue');
    });

    it('handles malformed or empty inputs gracefully without throwing', () => {
      expect(normalizePathname('')).toBe('');
      expect(normalizePathname(undefined as any)).toBe('');
      expect(normalizePathname(null as any)).toBe('');
      expect(normalizePathname('not a valid url ::: ///')).not.toBeNull();
    });
  });

  describe('isDeepSeekGenerationEndpoint() exact matching bounds', () => {
    it('accepts exact known generation paths', () => {
      for (const endpoint of GENERATION_ENDPOINTS) {
        expect(isDeepSeekGenerationEndpoint(`https://chat.deepseek.com${endpoint}`)).toBe(true);
        expect(isDeepSeekGenerationEndpoint(endpoint)).toBe(true);
        expect(isDeepSeekGenerationEndpoint(`${endpoint}?query=param`)).toBe(true);
        expect(isDeepSeekGenerationEndpoint(`${endpoint}/`)).toBe(true);
      }
    });

    it('rejects suffix / substring traps (strict anti-spoofing)', () => {
      // Substring trap: completion_fake or completion2
      expect(isDeepSeekGenerationEndpoint('https://chat.deepseek.com/api/v0/chat/completion_fake')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('/api/v0/chat/completion2')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('/api/v0/chat/completions')).toBe(false);

      // Suffix trap: sub-resource under completion
      expect(isDeepSeekGenerationEndpoint('https://chat.deepseek.com/api/v0/chat/completion/nested')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('/api/v0/chat/edit_message/preview')).toBe(false);

      // Prefix trap: different namespace
      expect(isDeepSeekGenerationEndpoint('/api/v1/chat/completion')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('/internal/api/v0/chat/completion')).toBe(false);
    });

    it('rejects non-generation endpoints', () => {
      expect(isDeepSeekGenerationEndpoint('/api/v0/chat/history_messages')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('/api/v0/chat/sessions')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('/api/v0/users/current')).toBe(false);
      expect(isDeepSeekGenerationEndpoint('/api/v0/balance')).toBe(false);
    });
  });
});
