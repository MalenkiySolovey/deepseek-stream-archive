/**
 * Generic stateful streaming UTF-8 decoder.
 * Correctly reassembles multi-byte Unicode code points (Cyrillic, CJK, emoji, etc.)
 * split across arbitrary byte chunk boundaries.
 */
export class Utf8StreamDecoder {
  private decoder: TextDecoder;
  private hasSeenFirstChunk = false;

  constructor() {
    this.decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
  }

  /**
   * Decodes an incoming Uint8Array chunk into text.
   * Internal decoder state preserves incomplete trailing multi-byte sequences.
   */
  decode(chunk: Uint8Array | ArrayBuffer): string {
    const uint8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (uint8.length === 0) {
      return '';
    }

    let text = this.decoder.decode(uint8, { stream: true });

    // Handle leading UTF-8 BOM (\uFEFF) on the first chunk
    if (!this.hasSeenFirstChunk) {
      this.hasSeenFirstChunk = true;
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
    }

    return text;
  }

  /**
   * Flushes any remaining bytes in the decoder's internal buffer.
   */
  flush(): string {
    const text = this.decoder.decode();
    return text;
  }

  /**
   * Resets decoder state for a new stream.
   */
  reset(): void {
    this.decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: false });
    this.hasSeenFirstChunk = false;
  }
}
