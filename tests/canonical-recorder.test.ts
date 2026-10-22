import { describe, it, expect } from 'vitest';
import { CanonicalRevisionRecorder } from '../src/core/recorder/canonical-recorder';
import type { DeepSeekSemanticEvent } from '../src/adapters/deepseek/protocol/types';

describe('CanonicalRevisionRecorder', () => {
  it('buffers and flushes streaming deltas with incremental revision indices', () => {
    const recorder = new CanonicalRevisionRecorder({
      conversationId: 'conv-123',
      messageId: 'msg-rec-1',
      remoteMessageId: 'remote-rec-1',
      sourceRawStreamKey: 'prod:stream-1',
      flushIntervalMs: 100,
      minCharsForFlush: 10,
    });

    recorder.feedDelta({ text: 'Hello, ' });
    recorder.feedDelta({ text: 'DeepSeek StreamArchive!' });
    recorder.feedDelta({ thinking: 'Initial thought step.' });

    const rev1 = recorder.flush(false);
    expect(rev1).not.toBeNull();
    expect(rev1!.revisionIndex).toBe(0);
    expect(rev1!.text).toBe('Hello, DeepSeek StreamArchive!');
    expect(rev1!.thinking).toBe('Initial thought step.');
    expect(rev1!.isFinal).toBe(false);
    expect(rev1!.isLastGood).toBe(false);

    // No changes -> flush returns null
    expect(recorder.flush(false)).toBeNull();

    recorder.feedDelta({ text: ' Additional tokens.' });
    const rev2 = recorder.flush(true);
    expect(rev2).not.toBeNull();
    expect(rev2!.revisionIndex).toBe(1);
    expect(rev2!.isFinal).toBe(true);
    expect(recorder.getRevisions()).toHaveLength(2);
  });

  it('preserves pre-filter content as isLastGood revision and creates RecoveryEvent on filter_triggered', () => {
    const recorder = new CanonicalRevisionRecorder({
      conversationId: 'conv-censor',
      messageId: 'msg-censor',
      remoteMessageId: 'remote-censored-msg',
    });

    // 1. Stream normal uncensored tokens
    recorder.feedSemanticEvent({
      streamId: 's-1',
      sequence: 1,
      timestamp: 1000,
      type: 'thinking_delta',
      delta: 'Analyzing complex security inquiry...',
    });
    recorder.feedSemanticEvent({
      streamId: 's-1',
      sequence: 2,
      timestamp: 1001,
      type: 'answer_delta',
      delta: 'Here is the uncensored technical explanation before safety review.',
    });

    // 2. DeepSeek server triggers content filter with lastGood payload
    recorder.feedSemanticEvent({
      streamId: 's-1',
      sequence: 3,
      timestamp: 1002,
      type: 'filter_triggered',
      lastGood: {
        answer: 'Here is the uncensored technical explanation before safety review.',
        thinking: 'Analyzing complex security inquiry...',
        capturedAt: 1710000000,
        reason: 'CONTENT_FILTER',
        projectionSource: 'top_level',
      },
      reason: 'CONTENT_FILTER',
    });

    expect(recorder.getCurrentStatus()).toBe('filtered');
    const lastGood = recorder.getLastGoodRevision();
    expect(lastGood).not.toBeNull();
    expect(lastGood!.isLastGood).toBe(true);
    expect(lastGood!.text).toBe('Here is the uncensored technical explanation before safety review.');
    expect(lastGood!.thinking).toBe('Analyzing complex security inquiry...');

    const recoveryEvents = recorder.getRecoveryEvents();
    expect(recoveryEvents).toHaveLength(1);
    expect(recoveryEvents[0]!.kind).toBe('content_filter');
    expect(recoveryEvents[0]!.recoveredRevisionId).toBe(lastGood!.id);

    // 3. Server replaces content with template apology
    recorder.feedSemanticEvent({
      streamId: 's-1',
      sequence: 4,
      timestamp: 1003,
      type: 'answer_replace',
      fullText: 'Sorry, I cannot answer this request.',
    });

    const finalRev = recorder.flush(true);
    expect(finalRev).not.toBeNull();
    expect(finalRev!.text).toBe('Sorry, I cannot answer this request.');
    expect(finalRev!.isLastGood).toBe(false);
    expect(finalRev!.isFinal).toBe(true);

    // Ensure the last-good revision remained untouched
    expect(recorder.getLastGoodRevision()!.text).toBe(
      'Here is the uncensored technical explanation before safety review.'
    );

    const messageSnapshot = recorder.buildMessageSnapshot();
    expect(messageSnapshot.status).toBe('filtered');
    expect(messageSnapshot.remoteId).toBe('remote-censored-msg');
  });

  it('enforces strictly monotonic revisionIndex across initial flush, lastGood snapshot, and final flush', () => {
    const recorder = new CanonicalRevisionRecorder({
      conversationId: 'conv-mono',
      messageId: 'msg-mono',
    });

    recorder.feedDelta({ text: 'Draft response chunk 1' });
    const rev0 = recorder.flush(false);
    expect(rev0?.revisionIndex).toBe(0);

    recorder.feedDelta({ text: ' Draft response chunk 2' });
    recorder.feedSemanticEvent({
      streamId: 's-mono',
      sequence: 2,
      timestamp: 1000,
      type: 'filter_triggered',
      lastGood: {
        answer: 'Draft response chunk 1 Draft response chunk 2',
        thinking: '',
        capturedAt: 1000,
        reason: 'CONTENT_FILTER',
        projectionSource: 'top_level',
      },
    });

    const lastGood = recorder.getLastGoodRevision();
    expect(lastGood?.revisionIndex).toBe(1);

    recorder.feedSemanticEvent({
      streamId: 's-mono',
      sequence: 3,
      timestamp: 1001,
      type: 'answer_replace',
      fullText: 'Apology replacement.',
    });

    const rev2 = recorder.flush(true);
    expect(rev2?.revisionIndex).toBe(2);

    const allRevs = recorder.getRevisions();
    expect(allRevs).toHaveLength(3);
    expect(allRevs.map((r) => r.revisionIndex)).toEqual([0, 1, 2]);
  });

  it('updates remoteMessageId when later valid message_id_identified arrives', () => {
    const recorder = new CanonicalRevisionRecorder({
      conversationId: 'c-test',
      messageId: 'm-test',
      remoteMessageId: 'id-initial',
    });

    expect(recorder.getRemoteMessageId()).toBe('id-initial');

    recorder.feedSemanticEvent({
      streamId: 's-1',
      sequence: 1,
      timestamp: 100,
      type: 'message_id_identified',
      messageId: 'id-later-authoritative',
    });

    expect(recorder.getRemoteMessageId()).toBe('id-later-authoritative');
    const snapshot = recorder.buildMessageSnapshot();
    expect(snapshot.remoteId).toBe('id-later-authoritative');
  });

  it('prevents duplicate lastGood revisions and RecoveryEvents on repeated filter_triggered events', () => {
    const recorder = new CanonicalRevisionRecorder({
      conversationId: 'c-filter-dup',
      messageId: 'm-filter-dup',
    });

    recorder.feedDelta({ text: 'Pre-censor text' });

    // First filter event
    recorder.feedSemanticEvent({
      streamId: 's-dup',
      sequence: 1,
      timestamp: 100,
      type: 'filter_triggered',
      lastGood: {
        answer: 'Pre-censor text',
        thinking: '',
        capturedAt: 100,
        reason: 'CONTENT_FILTER',
        projectionSource: 'top_level',
      },
    });

    // Duplicate filter event on the same incident
    recorder.feedSemanticEvent({
      streamId: 's-dup',
      sequence: 2,
      timestamp: 101,
      type: 'filter_triggered',
      lastGood: {
        answer: 'Pre-censor text',
        thinking: '',
        capturedAt: 101,
        reason: 'CONTENT_FILTER',
        projectionSource: 'top_level',
      },
    });

    expect(recorder.getRecoveryEvents()).toHaveLength(1);
    expect(recorder.getRevisions().filter((r) => r.isLastGood)).toHaveLength(1);
  });

  it('handles terminal semantics correctly without defaulting transport ended to finished', () => {
    const recorderA = new CanonicalRevisionRecorder({
      conversationId: 'c-term-a',
      messageId: 'm-term-a',
    });
    recorderA.feedSemanticEvent({
      streamId: 's-term-a',
      sequence: 1,
      timestamp: 100,
      type: 'stream_transport_ended',
    });
    // Transport ended without status must NOT be 'finished'!
    expect(recorderA.getCurrentStatus()).toBe('incomplete');

    const recorderB = new CanonicalRevisionRecorder({
      conversationId: 'c-term-b',
      messageId: 'm-term-b',
    });
    recorderB.feedSemanticEvent({
      streamId: 's-term-b',
      sequence: 1,
      timestamp: 100,
      type: 'stream_error',
      error: 'Connection reset',
    });
    expect(recorderB.getCurrentStatus()).toBe('interrupted');

    const recorderC = new CanonicalRevisionRecorder({
      conversationId: 'c-term-c',
      messageId: 'm-term-c',
    });
    recorderC.feedSemanticEvent({
      streamId: 's-term-c',
      sequence: 1,
      timestamp: 100,
      type: 'stream_finished',
      terminalReason: 'completed',
      status: 'FINISHED',
    });
    expect(recorderC.getCurrentStatus()).toBe('finished');
  });

  it('builds honest message snapshot preserving remote IDs and stream key', () => {
    const recorder = new CanonicalRevisionRecorder({
      conversationId: 'c-test',
      messageId: 'm-test',
      remoteMessageId: 'remote-msg-99',
      parentId: 'm-parent',
      remoteParentId: 'remote-parent-99',
      sourceRawStreamKey: 'prod_session:stream_uuid',
    });

    const snapshot = recorder.buildMessageSnapshot();
    expect(snapshot.id).toBe('m-test');
    expect(snapshot.remoteId).toBe('remote-msg-99');
    expect(snapshot.parentId).toBe('m-parent');
    expect(snapshot.remoteParentId).toBe('remote-parent-99');
    expect(snapshot.sourceRawStreamKey).toBe('prod_session:stream_uuid');
    expect(snapshot.identityState).toBe('provisional');
  });
});
