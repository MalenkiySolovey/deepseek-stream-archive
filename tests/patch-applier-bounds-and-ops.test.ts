import { describe, it, expect } from 'vitest';
import { DeepSeekPatchApplier, MAX_ARRAY_INDEX, MAX_BATCH_ITEMS } from '../src/adapters/deepseek/protocol/patch-applier';
import type { ProtocolWarningCode } from '../src/adapters/deepseek/protocol/types';

describe('DeepSeek Patch Applier Bounds & Operation Validation', () => {
  it('rejects unknown operations atomically without mutating state', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(
      { fragments: [{ type: 'RESPONSE', content: 'Base content' }] },
      (code, msg) => warnings.push({ code, msg })
    );

    const res = applier.applyPatch({
      o: 'DELETE' as any,
      v: 'destructive',
    });

    expect(res.status).toBe('rejected');
    expect(res.mutated).toBe(false);
    expect(warnings.some((w) => w.code === 'unknown_operation')).toBe(true);
    expect(applier.getFragments()[0]?.content).toBe('Base content');
  });

  it('rejects explicit pathless SET or REPLACE and does not implicit append', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(
      { fragments: [{ type: 'RESPONSE', content: 'Original text' }] },
      (code, msg) => warnings.push({ code, msg })
    );

    // 1. Explicit pathless SET
    const setRes = applier.applyPatch({
      o: 'SET',
      v: 'attempted override',
    });
    expect(setRes.status).toBe('rejected');
    expect(setRes.mutated).toBe(false);
    expect(warnings.some((w) => w.code === 'invalid_patch_shape')).toBe(true);
    expect(applier.getFragments()[0]?.content).toBe('Original text');

    // 2. Explicit pathless REPLACE
    const replaceRes = applier.applyPatch({
      o: 'REPLACE',
      v: 'attempted replace',
    });
    expect(replaceRes.status).toBe('rejected');
    expect(replaceRes.mutated).toBe(false);
    expect(applier.getFragments()[0]?.content).toBe('Original text');

    // 3. Observed pathless token without "o" works as implicit append
    const appendRes = applier.applyPatch({
      v: ' appended',
    });
    expect(appendRes.status).toBe('applied');
    expect(appendRes.mutated).toBe(true);
    expect(applier.getFragments()[0]?.content).toBe('Original text appended');

    // 4. Explicit pathless APPEND works
    const explicitAppendRes = applier.applyPatch({
      o: 'APPEND',
      v: ' more',
    });
    expect(explicitAppendRes.status).toBe('applied');
    expect(explicitAppendRes.mutated).toBe(true);
    expect(applier.getFragments()[0]?.content).toBe('Original text appended more');
  });

  it('rejects snapshot fragments replacement atomically if fragments length exceeds MAX_ARRAY_INDEX', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(
      { fragments: [{ id: 1, type: 'RESPONSE', content: 'Kept intact' }] },
      (code, msg) => warnings.push({ code, msg })
    );

    const oversizedFragments = Array.from({ length: MAX_ARRAY_INDEX + 5 }, (_, i) => ({
      id: i,
      type: 'RESPONSE',
      content: `Item ${i}`,
    }));

    const res = applier.applyPatch({
      v: {
        response: {
          status: 'WIP',
          fragments: oversizedFragments,
        },
      },
    });

    // Entire snapshot rejected atomically, no partial slice and no status mutation!
    expect(res.status).toBe('rejected');
    expect(res.mutated).toBe(false);
    expect(warnings.some((w) => w.code === 'array_index_too_large')).toBe(true);
    expect(applier.getFragments().length).toBe(1);
    expect(applier.getFragments()[0]?.content).toBe('Kept intact');
    expect(applier.getStatus()).toBeUndefined();
  });

  it('rejects tree APPEND operation atomically if array capacity would be exceeded', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(
      undefined,
      (code, msg) => warnings.push({ code, msg })
    );

    // Initial array with 900 items
    const baseItems = Array.from({ length: 900 }, (_, i) => `item_${i}`);
    applier.applyPatch({
      p: 'response/custom_list',
      o: 'SET',
      v: baseItems,
    });

    expect((applier.getState().response as any).custom_list.length).toBe(900);

    // Attempting to append 150 items would exceed MAX_ARRAY_INDEX (1000)
    const extraItems = Array.from({ length: 150 }, (_, i) => `extra_${i}`);
    applier.applyPatch({
      p: 'response/custom_list',
      o: 'APPEND',
      v: extraItems,
    });

    expect(warnings.some((w) => w.code === 'array_index_too_large')).toBe(true);
    // Entire append rejected, no partial slicing!
    expect((applier.getState().response as any).custom_list.length).toBe(900);
  });

  it('rejects oversized BATCH operations atomically without mutating state', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(
      { status: 'WIP' },
      (code, msg) => warnings.push({ code, msg })
    );

    const oversizedBatchOps = Array.from({ length: MAX_BATCH_ITEMS + 10 }, (_, i) => ({
      p: 'response/status',
      v: `MODIFIED_${i}`,
    }));

    const res = applier.applyPatch({
      p: 'response',
      o: 'BATCH',
      v: oversizedBatchOps,
    });

    expect(res.status).toBe('rejected');
    expect(res.mutated).toBe(false);
    expect(warnings.some((w) => w.code === 'batch_too_large')).toBe(true);
    expect(applier.getStatus()).toBe('WIP'); // Unmodified
  });
});
