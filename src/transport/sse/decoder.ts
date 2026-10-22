import type { SseEvent } from './types';

/**
 * Standard-compliant Generic Server-Sent Events (SSE) Parser.
 * Implements WHATWG EventSource specification:
 * - Line endings: LF (\n), CRLF (\r\n), and single CR (\r).
 * - Multi-line `data:` fields joined with \n.
 * - Leading single space after colon stripped.
 * - Comments starting with `:` ignored.
 * - Dispatch occurs strictly upon encountering an empty (blank) line.
 * - Incomplete trailing event data at EOF without blank line is discarded.
 * - Opaque string data (no JSON / domain semantics).
 */
export class GenericSseDecoder {
  private buffer = '';
  private dataLines: string[] = [];
  private currentEventName: string | undefined = undefined;
  private lastEventId: string | undefined = undefined;
  private currentRetry: number | undefined = undefined;
  private hasSeenFirstChunk = false;

  /**
   * Feeds a text chunk into the decoder, returning any completed SSE events.
   */
  feed(chunk: string): SseEvent[] {
    if (!chunk) {
      return [];
    }

    let text = chunk;
    if (!this.hasSeenFirstChunk) {
      this.hasSeenFirstChunk = true;
      if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
      }
    }

    this.buffer += text;
    const events: SseEvent[] = [];

    let pos = 0;
    while (pos < this.buffer.length) {
      const cr = this.buffer.indexOf('\r', pos);
      const lf = this.buffer.indexOf('\n', pos);

      let lineEnd = -1;
      let nextPos = -1;

      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // Found CR first
        if (cr === this.buffer.length - 1) {
          // CR is at the very end of the buffer; wait for next chunk to determine if CRLF
          break;
        }
        lineEnd = cr;
        nextPos = this.buffer[cr + 1] === '\n' ? cr + 2 : cr + 1;
      } else if (lf !== -1) {
        // Found LF first
        lineEnd = lf;
        nextPos = lf + 1;
      } else {
        // No line terminator found in remaining buffer
        break;
      }

      const line = this.buffer.slice(pos, lineEnd);
      pos = nextPos;

      const event = this.processLine(line);
      if (event) {
        events.push(event);
      }
    }

    // Retain unprocessed tail
    this.buffer = this.buffer.slice(pos);
    return events;
  }

  /**
   * Finalizes the stream at EOF.
   * Discards incomplete trailing events not followed by a blank line,
   * per WHATWG specification.
   */
  finish(): SseEvent[] {
    const events: SseEvent[] = [];

    // If buffer ends with trailing CR, process that last line
    if (this.buffer === '\r') {
      const event = this.processLine('');
      if (event) {
        events.push(event);
      }
      this.buffer = '';
    } else if (this.buffer.length > 0) {
      // Process remaining line if non-empty, but without a trailing blank line,
      // WHATWG SSE specification states incomplete buffered events are NOT dispatched.
      this.buffer = '';
    }

    // Reset stream state
    this.dataLines = [];
    this.currentEventName = undefined;
    this.currentRetry = undefined;

    return events;
  }

  /**
   * Resets parser state for reuse.
   */
  reset(): void {
    this.buffer = '';
    this.dataLines = [];
    this.currentEventName = undefined;
    this.lastEventId = undefined;
    this.currentRetry = undefined;
    this.hasSeenFirstChunk = false;
  }

  /**
   * Processes a single extracted line.
   */
  private processLine(line: string): SseEvent | null {
    // Blank line -> Dispatch event
    if (line === '') {
      if (this.dataLines.length === 0) {
        // No data accumulated; reset transient event fields
        this.currentEventName = undefined;
        this.currentRetry = undefined;
        return null;
      }

      const event: SseEvent = {
        data: this.dataLines.join('\n'),
      };

      if (this.currentEventName !== undefined) {
        event.event = this.currentEventName;
      }
      if (this.lastEventId !== undefined) {
        event.id = this.lastEventId;
      }
      if (this.currentRetry !== undefined) {
        event.retry = this.currentRetry;
      }

      // Reset event buffer
      this.dataLines = [];
      this.currentEventName = undefined;
      this.currentRetry = undefined;

      return event;
    }

    // Comment line -> Ignore
    if (line.startsWith(':')) {
      return null;
    }

    // Field processing
    const colonIndex = line.indexOf(':');
    let field: string;
    let value: string;

    if (colonIndex !== -1) {
      field = line.slice(0, colonIndex);
      value = line.slice(colonIndex + 1);
      // Remove single leading space if present
      if (value.startsWith(' ')) {
        value = value.slice(1);
      }
    } else {
      field = line;
      value = '';
    }

    switch (field) {
      case 'data':
        this.dataLines.push(value);
        break;

      case 'event':
        this.currentEventName = value;
        break;

      case 'id':
        // If value contains NULL (U+0000), ignore
        if (!value.includes('\0')) {
          this.lastEventId = value;
        }
        break;

      case 'retry':
        // Must consist only of ASCII decimal digits
        if (/^\d+$/.test(value)) {
          this.currentRetry = parseInt(value, 10);
        }
        break;

      default:
        // Ignore unknown fields
        break;
    }

    return null;
  }
}
