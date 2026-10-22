import { describe, it, expect } from 'vitest';
import { DeepSeekProtocolDecoder } from '../src/adapters/deepseek/protocol/decoder';
import { DeepSeekPatchApplier } from '../src/adapters/deepseek/protocol/patch-applier';

describe('DeepSeek Status Vocabulary & Lifecycle Model', () => {
  describe('PatchApplier status model tracking', () => {
    it('tracks standard status and non-terminal WIP', () => {
      const applier = new DeepSeekPatchApplier();

      applier.applyPatch({ p: 'status', o: 'SET', v: 'WIP' });
      expect(applier.getStatus()).toBe('WIP');

      applier.applyPatch({ p: 'status', o: 'SET', v: 'FINISHED' });
      expect(applier.getStatus()).toBe('FINISHED');
    });

    it('tracks quasi_status when provided in DeepSeek response', () => {
      const applier = new DeepSeekPatchApplier();

      applier.applyPatch({ p: 'quasi_status', o: 'SET', v: 'CONTENT_FILTER' });
      expect(applier.getQuasiStatus()).toBe('CONTENT_FILTER');
    });

    it('tracks has_pending_fragment and incomplete_message flags', () => {
      const applier = new DeepSeekPatchApplier();

      expect(applier.hasPendingFragment()).toBeUndefined();
      expect(applier.incompleteMessage()).toBeUndefined();

      applier.applyPatch({ p: 'has_pending_fragment', o: 'SET', v: true });
      applier.applyPatch({ p: 'incomplete_message', o: 'SET', v: false });

      expect(applier.hasPendingFragment()).toBe(true);
      expect(applier.incompleteMessage()).toBe(false);
    });
  });

  describe('ProtocolDecoder Terminal Reasoning Matrix', () => {
    it('maps FINISHED without pending flags to completed reason', () => {
      const decoder = new DeepSeekProtocolDecoder('status_1');
      const events = decoder.feed({
        data: JSON.stringify({ p: 'status', o: 'SET', v: 'FINISHED' }),
      });

      const finishEvt = events.find((e) => e.type === 'stream_finished');
      expect(finishEvt).toBeDefined();
      expect(finishEvt?.terminalReason).toBe('completed');
      expect(decoder.getDiagnostics().lastTerminalReason).toBe('completed');
    });

    it('maps FINISHED with has_pending_fragment=true to incomplete reason', () => {
      const decoder = new DeepSeekProtocolDecoder('status_2');
      const events = decoder.feed({
        data: JSON.stringify({
          o: 'BATCH',
          v: [
            { p: 'has_pending_fragment', o: 'SET', v: true },
            { p: 'status', o: 'SET', v: 'FINISHED' },
          ],
        }),
      });

      const finishEvt = events.find((e) => e.type === 'stream_finished');
      expect(finishEvt).toBeDefined();
      expect(finishEvt?.terminalReason).toBe('incomplete');
      expect(finishEvt?.hasPendingFragment).toBe(true);
    });

    it('maps CONTEXT_LENGTH_EXCEEDED to truncated_context_limit reason', () => {
      const decoder = new DeepSeekProtocolDecoder('status_3');
      const events = decoder.feed({
        data: JSON.stringify({ p: 'status', o: 'SET', v: 'CONTEXT_LENGTH_EXCEEDED' }),
      });

      const finishEvt = events.find((e) => e.type === 'stream_finished');
      expect(finishEvt).toBeDefined();
      expect(finishEvt?.terminalReason).toBe('truncated_context_limit');
    });

    it('maps INCOMPLETE to incomplete reason', () => {
      const decoder = new DeepSeekProtocolDecoder('status_4');
      const events = decoder.feed({
        data: JSON.stringify({ p: 'status', o: 'SET', v: 'INCOMPLETE' }),
      });

      const finishEvt = events.find((e) => e.type === 'stream_finished');
      expect(finishEvt).toBeDefined();
      expect(finishEvt?.terminalReason).toBe('incomplete');
    });

    it('maps TIMEOUT to timeout reason', () => {
      const decoder = new DeepSeekProtocolDecoder('status_5');
      const events = decoder.feed({
        data: JSON.stringify({ p: 'status', o: 'SET', v: 'TIMEOUT' }),
      });

      const finishEvt = events.find((e) => e.type === 'stream_finished');
      expect(finishEvt).toBeDefined();
      expect(finishEvt?.terminalReason).toBe('timeout');
    });

    it('treats WIP as non-terminal allowing subsequent chunks', () => {
      const decoder = new DeepSeekProtocolDecoder('status_wip');
      const wipEvents = decoder.feed({
        data: JSON.stringify({ p: 'status', o: 'SET', v: 'WIP' }),
      });

      // No terminal stream_finished event emitted
      expect(wipEvents.some((e) => e.type === 'stream_finished')).toBe(false);

      // Next chunk is accepted normally without event_after_terminal
      const nextEvents = decoder.feed({
        data: JSON.stringify({
          p: 'fragments',
          o: 'SET',
          v: [{ type: 'RESPONSE', content: 'Still working...' }],
        }),
      });

      expect(nextEvents.some((e) => e.type === 'answer_delta')).toBe(true);
      expect(decoder.getDiagnostics().eventsAfterTerminalCount).toBe(0);
    });
  });
});
