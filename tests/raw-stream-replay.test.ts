import { describe, it, expect } from 'vitest';
import { replayRawBatches } from '../src/storage/raw-journal/replay';
import type { RawStreamBatch } from '../src/storage/raw-journal/types';

describe('Raw Journal Pure Replay', () => {
  it('reconstructs normal completed response faithfully from multiple raw batches', () => {
    const batches: RawStreamBatch[] = [
      {
        id: 's1:1',
        streamKey: 'prod1:stream1',
        batchSeq: 1,
        chunks: [
          {
            streamSequence: 1,
            chunkText: 'data: {"o":"SET","p":"response/message_id","v":"msg_101"}\n\n',
            timestamp: 1000,
          },
          {
            streamSequence: 2,
            chunkText: 'data: {"o":"SET","p":"response/fragments/0/content","v":"Hello "}\n\n',
            timestamp: 1010,
          },
        ],
        createdAt: 1010,
        charCount: 130,
      },
      {
        id: 's1:2',
        streamKey: 'prod1:stream1',
        batchSeq: 2,
        chunks: [
          {
            streamSequence: 3,
            chunkText: 'data: {"o":"APPEND","p":"response/fragments/0/content","v":"world from DeepSeek!"}\n\n',
            timestamp: 1020,
          },
          {
            streamSequence: 4,
            chunkText: 'data: {"o":"SET","p":"response/status","v":"FINISHED"}\n\nevent: finish\ndata: {}\n\n',
            timestamp: 1030,
          },
        ],
        createdAt: 1030,
        charCount: 160,
      },
    ];

    const result = replayRawBatches(batches);

    expect(result.streamKey).toBe('prod1:stream1');
    expect(result.totalChunks).toBe(4);
    expect(result.sequenceGapsCount).toBe(0);
    expect(result.filterTriggered).toBe(false);
    expect(result.isComplete).toBe(true);
    expect(result.projectedAnswer).toBe('Hello world from DeepSeek!');
    expect(result.diagnostics.activeMessageId).toBe('msg_101');
    expect(result.diagnostics.finishControlObserved).toBe(true);

    // Verify semantic events sequence
    const eventTypes = result.semanticEvents.map((e) => e.type);
    expect(eventTypes).toContain('answer_delta');
    expect(eventTypes).toContain('stream_finished');
  });

  it('reconstructs thinking model response with projected thinking and answer', () => {
    const batches: RawStreamBatch[] = [
      {
        id: 's_think:1',
        streamKey: 'prod_think:stream_think',
        batchSeq: 1,
        chunks: [
          {
            streamSequence: 1,
            chunkText:
              'data: {"o":"SET","p":"response/fragments/0/type","v":"THINKING"}\n\n' +
              'data: {"o":"SET","p":"response/fragments/0/content","v":"Let me calculate 2 + 2."}\n\n',
            timestamp: 2000,
          },
        ],
        createdAt: 2000,
        charCount: 140,
      },
      {
        id: 's_think:2',
        streamKey: 'prod_think:stream_think',
        batchSeq: 2,
        chunks: [
          {
            streamSequence: 2,
            chunkText:
              'data: {"o":"SET","p":"response/fragments/1/type","v":"RESPONSE"}\n\n' +
              'data: {"o":"SET","p":"response/fragments/1/content","v":"The answer is 4."}\n\n' +
              'data: {"o":"SET","p":"response/status","v":"FINISHED"}\n\n',

            timestamp: 2020,
          },
        ],
        createdAt: 2020,
        charCount: 180,
      },
    ];

    const result = replayRawBatches(batches);

    expect(result.projectedThinking).toBe('Let me calculate 2 + 2.');
    expect(result.projectedAnswer).toBe('The answer is 4.');
    expect(result.isComplete).toBe(true);
  });

  it('detects censorship filter events and captures last-good state during replay', () => {
    const batches: RawStreamBatch[] = [
      {
        id: 's_filter:1',
        streamKey: 'prod_filter:stream_filter',
        batchSeq: 1,
        chunks: [
          {
            streamSequence: 1,
            chunkText:
              'data: {"o":"SET","p":"response/message_id","v":"msg_censored"}\n\n' +
              'data: {"o":"SET","p":"response/fragments/0/content","v":"Sensitive historical analysis before recall"}\n\n',
            timestamp: 3000,
          },
        ],
        createdAt: 3000,
        charCount: 180,
      },
      {
        id: 's_filter:2',
        streamKey: 'prod_filter:stream_filter',
        batchSeq: 2,
        chunks: [
          {
            streamSequence: 2,
            chunkText: 'data: {"o":"SET","p":"response/status","v":"CONTENT_FILTER"}\n\n',
            timestamp: 3050,
          },
        ],
        createdAt: 3050,
        charCount: 65,
      },
    ];

    const result = replayRawBatches(batches);

    expect(result.filterTriggered).toBe(true);
    expect(result.diagnostics.filterEventsCount).toBe(1);

    const filterEvt = result.semanticEvents.find((e) => e.type === 'filter_triggered');
    expect(filterEvt).toBeDefined();
    expect((filterEvt as any)?.reason).toBe('CONTENT_FILTER');
    expect((filterEvt as any)?.lastGood?.answer).toBe('Sensitive historical analysis before recall');
  });

  it('handles arbitrary chunk boundary fragmentation across SSE frames during replay', () => {
    // A single SSE frame split arbitrarily across multiple chunks
    const batches: RawStreamBatch[] = [
      {
        id: 's_frag:1',
        streamKey: 'p:s_frag',
        batchSeq: 1,
        chunks: [
          { streamSequence: 1, chunkText: 'data: {"o":"SE', timestamp: 10 },
          { streamSequence: 2, chunkText: 'T","p":"response/fragm', timestamp: 11 },
          { streamSequence: 3, chunkText: 'ents/0/content","v":"Frag', timestamp: 12 },
          { streamSequence: 4, chunkText: 'mented text"}\n\n', timestamp: 13 },
        ],
        createdAt: 13,
        charCount: 90,
      },
    ];

    const result = replayRawBatches(batches);
    expect(result.projectedAnswer).toBe('Fragmented text');
  });

  it('detects sequence gaps if raw chunks are missing', () => {
    const batches: RawStreamBatch[] = [
      {
        id: 's_gap:1',
        streamKey: 'p:s_gap',
        batchSeq: 1,
        chunks: [
          { streamSequence: 1, chunkText: 'data: {"o":"SET","p":"response/fragments/0/content","v":"Part 1"}\n\n', timestamp: 10 },
          // Missing sequence 2
          { streamSequence: 3, chunkText: 'data: {"o":"APPEND","p":"response/fragments/0/content","v":" Part 3"}\n\n', timestamp: 30 },
        ],
        createdAt: 30,
        charCount: 150,
      },
    ];

    const result = replayRawBatches(batches);
    expect(result.sequenceGapsCount).toBe(1);
  });
});
