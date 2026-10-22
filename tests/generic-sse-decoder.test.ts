import { describe, it, expect } from 'vitest';
import { GenericSseDecoder } from '../src/transport/sse/decoder';

describe('GenericSseDecoder', () => {
  it('parses a basic single data event with LF', () => {
    const decoder = new GenericSseDecoder();
    const input = 'data: hello world\n\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      data: 'hello world',
    });
  });

  it('parses multiple events in sequence', () => {
    const decoder = new GenericSseDecoder();
    const input = 'data: first\n\ndata: second\n\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(2);
    expect(events[0]?.data).toBe('first');
    expect(events[1]?.data).toBe('second');
  });

  it('joins multiple data lines with a single newline character', () => {
    const decoder = new GenericSseDecoder();
    const input = 'data: line 1\ndata: line 2\ndata: line 3\n\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('line 1\nline 2\nline 3');
  });

  it('parses event and id fields correctly', () => {
    const decoder = new GenericSseDecoder();
    const input = 'event: message_delta\nid: evt_42\ndata: content payload\n\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('message_delta');
    expect(events[0]?.id).toBe('evt_42');
    expect(events[0]?.data).toBe('content payload');
  });

  it('parses valid integer retry and ignores invalid non-integer retry values', () => {
    const decoder = new GenericSseDecoder();
    const validRetry = 'retry: 5000\ndata: retry ok\n\n';
    const invalidRetry = 'retry: invalid_int\ndata: retry ignored\n\n';

    const ev1 = decoder.feed(validRetry);
    expect(ev1).toHaveLength(1);
    expect(ev1[0]?.retry).toBe(5000);

    const ev2 = decoder.feed(invalidRetry);
    expect(ev2).toHaveLength(1);
    expect(ev2[0]?.retry).toBeUndefined();
  });

  it('ignores comments starting with a colon', () => {
    const decoder = new GenericSseDecoder();
    const input = ': this is a heartbeat comment\n: another comment\ndata: actual data\n\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('actual data');
  });

  it('ignores unknown fields while preserving known fields', () => {
    const decoder = new GenericSseDecoder();
    const input = 'foo: bar\nbaz: qux\ndata: valid\n\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('valid');
  });

  it('handles field lines without a colon as empty value', () => {
    const decoder = new GenericSseDecoder();
    const input = 'data\n\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('');
  });

  it('strips only a single leading space after colon', () => {
    const decoder = new GenericSseDecoder();
    const input = 'data:   spaced text   \n\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(1);
    // Two leading spaces preserved
    expect(events[0]?.data).toBe('  spaced text   ');
  });

  it('supports CRLF (\\r\\n) line endings', () => {
    const decoder = new GenericSseDecoder();
    const input = 'event: test\r\ndata: crlf content\r\n\r\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('test');
    expect(events[0]?.data).toBe('crlf content');
  });

  it('supports single CR (\\r) line endings', () => {
    const decoder = new GenericSseDecoder();
    const input = 'event: test\rdata: cr content\r\r';

    const events = decoder.feed(input);
    events.push(...decoder.finish());
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe('test');
    expect(events[0]?.data).toBe('cr content');
  });

  it('supports mixed line endings within the same stream', () => {
    const decoder = new GenericSseDecoder();
    const input = 'data: part1\r\ndata: part2\ndata: part3\r\r';

    const events = decoder.feed(input);
    events.push(...decoder.finish());
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('part1\npart2\npart3');
  });

  it('ignores initial UTF-8 BOM if passed in text chunk', () => {
    const decoder = new GenericSseDecoder();
    const input = '\uFEFFdata: hello bom\n\n';

    const events = decoder.feed(input);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('hello bom');
  });

  it('discards incomplete trailing event data at EOF without blank line per WHATWG spec', () => {
    const decoder = new GenericSseDecoder();
    // Incomplete stream terminated without trailing blank line
    const chunk = 'data: completed event\n\ndata: incomplete trailing';

    const events = decoder.feed(chunk);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('completed event');

    const eofEvents = decoder.finish();
    expect(eofEvents).toHaveLength(0); // Incomplete data is discarded per standard
  });
});
