import { describe, it, expect } from 'vitest';
import { Utf8StreamDecoder } from '../src/transport/utf8/decoder';

describe('Utf8StreamDecoder', () => {
  it('decodes simple ASCII text chunks', () => {
    const decoder = new Utf8StreamDecoder();
    const encoder = new TextEncoder();

    const chunk1 = encoder.encode('Hello, ');
    const chunk2 = encoder.encode('World!');

    expect(decoder.decode(chunk1)).toBe('Hello, ');
    expect(decoder.decode(chunk2)).toBe('World!');
    expect(decoder.flush()).toBe('');
  });

  it('correctly reassembles Cyrillic (Russian) multi-byte characters split across chunks', () => {
    const decoder = new Utf8StreamDecoder();
    const encoder = new TextEncoder();
    const text = 'Привет, мир!';
    const bytes = encoder.encode(text);

    // Split the bytes into 1-byte chunks, cutting every multi-byte character in half
    let reconstructed = '';
    for (let i = 0; i < bytes.length; i++) {
      reconstructed += decoder.decode(bytes.subarray(i, i + 1));
    }
    reconstructed += decoder.flush();

    expect(reconstructed).toBe(text);
    expect(reconstructed.includes('\uFFFD')).toBe(false);
  });

  it('correctly reassembles CJK (Chinese) 3-byte characters split across chunks', () => {
    const decoder = new Utf8StreamDecoder();
    const encoder = new TextEncoder();
    const text = '你好世界，深度探索！';
    const bytes = encoder.encode(text);

    // Split bytes across arbitrary cuts
    let reconstructed = '';
    for (let i = 0; i < bytes.length; i += 2) {
      reconstructed += decoder.decode(bytes.subarray(i, Math.min(i + 2, bytes.length)));
    }
    reconstructed += decoder.flush();

    expect(reconstructed).toBe(text);
  });

  it('correctly reassembles Emoji (4-byte) code points split across chunks', () => {
    const decoder = new Utf8StreamDecoder();
    const encoder = new TextEncoder();
    const text = '🚀 🤖 🌟 🧠';
    const bytes = encoder.encode(text);

    // Feed byte by byte
    let reconstructed = '';
    for (let i = 0; i < bytes.length; i++) {
      reconstructed += decoder.decode(bytes.subarray(i, i + 1));
    }
    reconstructed += decoder.flush();

    expect(reconstructed).toBe(text);
  });

  it('ignores initial UTF-8 BOM (\\uFEFF)', () => {
    const decoder = new Utf8StreamDecoder();
    // UTF-8 BOM is 0xEF, 0xBB, 0xBF
    const bomAndText = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62, 0x63]); // BOM + 'abc'

    const decoded = decoder.decode(bomAndText);
    expect(decoded).toBe('abc');
    expect(decoded.charCodeAt(0)).toBe(0x61);
  });

  it('handles empty chunks and repeated flushes gracefully', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(new Uint8Array([]))).toBe('');
    expect(decoder.flush()).toBe('');
    expect(decoder.flush()).toBe('');
  });
});
