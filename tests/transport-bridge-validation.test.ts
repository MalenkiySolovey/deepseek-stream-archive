import { describe, it, expect } from 'vitest';
import {
  validateBridgeEnvelope,
  validateTransportEventPayload,
} from '../src/bridge/validation';
import {
  BRIDGE_SOURCE_TAG,
  BRIDGE_PROTOCOL_VERSION,
  type StreamArchiveBridgeEnvelope,
} from '../src/bridge/protocol';
import type { TransportEvent } from '../src/transport/types';

describe('Transport Bridge Validation', () => {
  it('accepts a valid transport event envelope and payload', () => {
    const validTransportEvent: TransportEvent = {
      producerSessionId: 'prod_123',
      streamId: 'stream_456',
      sequence: 1,
      streamSequence: 0,
      timestamp: Date.now(),
      transport: 'fetch',
      type: 'chunk',
      chunkText: 'data: test\n\n',
      metadata: {
        method: 'POST',
        url: 'https://chat.deepseek.com/api/v0/chat',
        contentType: 'text/event-stream',
      },
    };

    const envelope: StreamArchiveBridgeEnvelope<TransportEvent> = {
      source: BRIDGE_SOURCE_TAG,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      eventId: 'evt_1',
      type: 'transport.event',
      timestamp: Date.now(),
      payload: validTransportEvent,
    };

    const validatedEnvelope = validateBridgeEnvelope(envelope);
    expect(validatedEnvelope).not.toBeNull();

    const validatedPayload = validateTransportEventPayload(envelope.payload);
    expect(validatedPayload).not.toBeNull();
    expect(validatedPayload?.streamId).toBe('stream_456');
    expect(validatedPayload?.streamSequence).toBe(0);
    expect(validatedPayload?.chunkText).toBe('data: test\n\n');
  });

  it('rejects transport payloads with negative or non-integer sequences', () => {
    const base: TransportEvent = {
      producerSessionId: 'prod_1',
      streamId: 'stream_1',
      sequence: -5,
      streamSequence: 0,
      timestamp: Date.now(),
      transport: 'fetch',
      type: 'open',
    };

    expect(validateTransportEventPayload(base)).toBeNull();
    expect(validateTransportEventPayload({ ...base, sequence: 1.5 })).toBeNull();
    expect(validateTransportEventPayload({ ...base, sequence: NaN })).toBeNull();
  });

  it('rejects transport payloads with blank or missing IDs', () => {
    const badProducer = {
      producerSessionId: '   ',
      streamId: 'stream_1',
      sequence: 1,
      timestamp: Date.now(),
      transport: 'fetch',
      type: 'open',
    };

    const badStream = {
      producerSessionId: 'prod_1',
      streamId: '',
      sequence: 1,
      timestamp: Date.now(),
      transport: 'fetch',
      type: 'open',
    };

    expect(validateTransportEventPayload(badProducer)).toBeNull();
    expect(validateTransportEventPayload(badStream)).toBeNull();
  });

  it('rejects unknown transport or event types', () => {
    const badTransport = {
      producerSessionId: 'prod_1',
      streamId: 'stream_1',
      sequence: 1,
      timestamp: Date.now(),
      transport: 'websocket',
      type: 'open',
    };

    const badType = {
      producerSessionId: 'prod_1',
      streamId: 'stream_1',
      sequence: 1,
      timestamp: Date.now(),
      transport: 'fetch',
      type: 'drop_database',
    };

    expect(validateTransportEventPayload(badTransport)).toBeNull();
    expect(validateTransportEventPayload(badType)).toBeNull();
  });

  it('rejects chunk events without valid chunkText', () => {
    const missingChunkText = {
      producerSessionId: 'prod_1',
      streamId: 'stream_1',
      sequence: 1,
      timestamp: Date.now(),
      transport: 'fetch',
      type: 'chunk',
      // chunkText is missing
    };

    expect(validateTransportEventPayload(missingChunkText)).toBeNull();
  });
});
