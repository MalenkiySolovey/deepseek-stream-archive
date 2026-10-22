import { describe, it, expect } from 'vitest';
import { extractSessionIdFromUrl } from '../src/adapters/deepseek/context/session-id';

describe('DeepSeek Session ID Route Parsing', () => {
  it('extracts session ID from modern route (/a/chat/s/<id>)', () => {
    const url = 'https://chat.deepseek.com/a/chat/s/0192e21b-8519-74d3-882e-6701ba32c142';
    expect(extractSessionIdFromUrl(url)).toBe('0192e21b-8519-74d3-882e-6701ba32c142');
  });

  it('extracts session ID from legacy route (/chat/s/<id>)', () => {
    const url = 'https://chat.deepseek.com/chat/s/abc-123-session';
    expect(extractSessionIdFromUrl(url)).toBe('abc-123-session');
  });

  it('strips query parameters and hash fragments', () => {
    const url = 'https://chat.deepseek.com/a/chat/s/my_session_id?model=deepseek-chat#top';
    expect(extractSessionIdFromUrl(url)).toBe('my_session_id');
  });

  it('returns null for non-session routes or landing pages', () => {
    expect(extractSessionIdFromUrl('https://chat.deepseek.com/')).toBeNull();
    expect(extractSessionIdFromUrl('https://chat.deepseek.com/chat')).toBeNull();
    expect(extractSessionIdFromUrl('https://chat.deepseek.com/a/chat')).toBeNull();
    expect(extractSessionIdFromUrl('https://chat.deepseek.com/sign_in')).toBeNull();
    expect(extractSessionIdFromUrl('')).toBeNull();
    expect(extractSessionIdFromUrl(null as any)).toBeNull();
  });
});
