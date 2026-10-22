import { describe, it, expect } from 'vitest';
import {
  validateBridgeEnvelope,
  validateSyntheticPayload,
} from '../src/bridge/validation';
import {
  BRIDGE_SOURCE_TAG,
  BRIDGE_PROTOCOL_VERSION,
  type StreamArchiveBridgeEnvelope,
  type SyntheticTestPayload,
} from '../src/bridge/protocol';

describe('Bridge Runtime Validation', () => {
  it('accepts a valid bridge envelope', () => {
    const validEnvelope: StreamArchiveBridgeEnvelope<SyntheticTestPayload> = {
      source: BRIDGE_SOURCE_TAG,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      eventId: 'evt_12345',
      type: 'synthetic.test',
      timestamp: Date.now(),
      payload: {
        testId: 't1',
        conversationTitle: 'Test Conversation',
        promptText: 'Hello prompt',
        responseText: 'Hello response',
        source: 'synthetic',
      },
    };

    const result = validateBridgeEnvelope(validEnvelope);
    expect(result).not.toBeNull();
    expect(result?.source).toBe(BRIDGE_SOURCE_TAG);
    expect(result?.protocolVersion).toBe(1);
    expect(result?.eventId).toBe('evt_12345');
    expect(result?.type).toBe('synthetic.test');
  });

  it('rejects an envelope with invalid or spoofed source', () => {
    const spoofed = {
      source: 'foreign-script',
      protocolVersion: 1,
      eventId: 'evt_1',
      type: 'synthetic.test',
      timestamp: Date.now(),
      payload: {},
    };

    expect(validateBridgeEnvelope(spoofed)).toBeNull();
  });

  it('rejects an envelope with mismatched protocol version', () => {
    const wrongVersion = {
      source: BRIDGE_SOURCE_TAG,
      protocolVersion: 99,
      eventId: 'evt_1',
      type: 'synthetic.test',
      timestamp: Date.now(),
      payload: {},
    };

    expect(validateBridgeEnvelope(wrongVersion)).toBeNull();
  });

  it('rejects an envelope with missing or empty eventId', () => {
    const noEventId = {
      source: BRIDGE_SOURCE_TAG,
      protocolVersion: 1,
      eventId: '   ',
      type: 'synthetic.test',
      timestamp: Date.now(),
      payload: {},
    };

    expect(validateBridgeEnvelope(noEventId)).toBeNull();
  });

  it('rejects an envelope with unknown event type', () => {
    const unknownType = {
      source: BRIDGE_SOURCE_TAG,
      protocolVersion: 1,
      eventId: 'evt_1',
      type: 'arbitrary.eval.code',
      timestamp: Date.now(),
      payload: {},
    };

    expect(validateBridgeEnvelope(unknownType)).toBeNull();
  });

  it('rejects an envelope with non-positive or invalid timestamp', () => {
    const badTime = {
      source: BRIDGE_SOURCE_TAG,
      protocolVersion: 1,
      eventId: 'evt_1',
      type: 'synthetic.test',
      timestamp: -500,
      payload: {},
    };

    expect(validateBridgeEnvelope(badTime)).toBeNull();
  });

  it('rejects non-object or null raw inputs', () => {
    expect(validateBridgeEnvelope(null)).toBeNull();
    expect(validateBridgeEnvelope(undefined)).toBeNull();
    expect(validateBridgeEnvelope('random string')).toBeNull();
    expect(validateBridgeEnvelope(12345)).toBeNull();
    expect(validateBridgeEnvelope([1, 2, 3])).toBeNull();
  });

  describe('Synthetic Payload Validation', () => {
    it('accepts a valid synthetic test payload', () => {
      const valid: SyntheticTestPayload = {
        testId: 'test-99',
        conversationTitle: 'Title',
        promptText: 'Prompt',
        responseText: 'Response text',
        source: 'synthetic',
      };

      const result = validateSyntheticPayload(valid);
      expect(result).not.toBeNull();
      expect(result?.testId).toBe('test-99');
      expect(result?.source).toBe('synthetic');
    });

    it('rejects payload with non-synthetic source', () => {
      const invalid = {
        testId: 'test-99',
        conversationTitle: 'Title',
        promptText: 'Prompt',
        responseText: 'Response text',
        source: 'network',
      };

      expect(validateSyntheticPayload(invalid)).toBeNull();
    });

    it('rejects payload with empty responseText', () => {
      const invalid = {
        testId: 'test-99',
        conversationTitle: 'Title',
        promptText: 'Prompt',
        responseText: '   ',
        source: 'synthetic',
      };

      expect(validateSyntheticPayload(invalid)).toBeNull();
    });
  });

  describe('Raw Journal Bridge Validation & URL Sanitization', () => {
    it('sanitizes stream URLs by removing query parameters and hashes', async () => {
      const { sanitizeStreamUrl } = await import('../src/bridge/validation');
      expect(sanitizeStreamUrl('https://chat.deepseek.com/api/v0/chat/completion?token=xyz#title')).toBe(
        'https://chat.deepseek.com/api/v0/chat/completion'
      );
      expect(sanitizeStreamUrl('https://chat.deepseek.com/api/v0/chat/completion')).toBe(
        'https://chat.deepseek.com/api/v0/chat/completion'
      );
      expect(sanitizeStreamUrl('/api/v0/chat/completion?param=1')).toBe(
        'https://chat.deepseek.com/api/v0/chat/completion'
      );
    });

    it('validates RawStreamChunk correctly', async () => {
      const { validateRawStreamChunk } = await import('../src/bridge/validation');
      const valid = { streamSequence: 5, chunkText: 'data: 123\n\n', timestamp: 12345 };
      expect(validateRawStreamChunk(valid)).toEqual(valid);

      expect(validateRawStreamChunk({ streamSequence: -1, chunkText: 'a', timestamp: 1 })).toBeNull();
      expect(validateRawStreamChunk({ streamSequence: 0, chunkText: 123, timestamp: 1 })).toBeNull();
      expect(validateRawStreamChunk({ streamSequence: 0, chunkText: 'a', timestamp: 0 })).toBeNull();
    });

    it('validates RawStreamBatch correctly', async () => {
      const { validateRawStreamBatch } = await import('../src/bridge/validation');
      const valid = {
        id: 'p:s:1',
        streamKey: 'p:s',
        batchSeq: 1,
        chunks: [{ streamSequence: 1, chunkText: 'hello', timestamp: 100 }],
        createdAt: 100,
        charCount: 5,
      };
      expect(validateRawStreamBatch(valid)).toEqual(valid);

      expect(validateRawStreamBatch({ ...valid, batchSeq: 0 })).toBeNull();
      expect(validateRawStreamBatch({ ...valid, chunks: 'not-array' })).toBeNull();
      expect(validateRawStreamBatch({ ...valid, chunks: [{ streamSequence: -1 }] })).toBeNull();
    });

    it('validates PersistRawStreamOpenRequest correctly', async () => {
      const { validatePersistRawStreamOpenRequest } = await import('../src/bridge/validation');
      const validReq = {
        type: 'STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN',
        producerSessionId: 'p1',
        streamId: 's1',
        transport: 'fetch',
        url: 'https://chat.deepseek.com/api/v0/chat/completion?auth=token#hash',
        method: 'POST',
        provisionalSessionId: 'route1',
        openedAt: 1000,
      };

      const result = validatePersistRawStreamOpenRequest(validReq);
      expect(result).not.toBeNull();
      expect(result?.url).toBe('https://chat.deepseek.com/api/v0/chat/completion');
      expect(result?.producerSessionId).toBe('p1');

      expect(validatePersistRawStreamOpenRequest({ ...validReq, type: 'OTHER' })).toBeNull();
      expect(validatePersistRawStreamOpenRequest({ ...validReq, transport: 'ws' })).toBeNull();
    });

    it('validates FinalizeRawStreamRequest correctly', async () => {
      const { validateFinalizeRawStreamRequest } = await import('../src/bridge/validation');
      const validReq = {
        type: 'STREAMARCHIVE_FINALIZE_RAW_STREAM',
        streamKey: 'p1:s1',
        finalState: 'completed',
        terminalReason: 'finished',
      };

      const result = validateFinalizeRawStreamRequest(validReq);
      expect(result).not.toBeNull();
      expect(result?.finalState).toBe('completed');

      expect(validateFinalizeRawStreamRequest({ ...validReq, finalState: 'unknown_state' })).toBeNull();
      expect(validateFinalizeRawStreamRequest({ ...validReq, streamKey: '' })).toBeNull();
    });
  });
});

