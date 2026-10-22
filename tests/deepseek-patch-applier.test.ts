import { describe, it, expect } from 'vitest';
import {
  DeepSeekPatchApplier,
  MAX_BATCH_ITEMS,
  MAX_BATCH_DEPTH,
  MAX_ARRAY_INDEX,
} from '../src/adapters/deepseek/protocol/patch-applier';
import type { ProtocolWarningCode } from '../src/adapters/deepseek/protocol/types';

describe('DeepSeek Patch Applier', () => {
  it('applies basic SET operations to fragments and status', () => {
    const applier = new DeepSeekPatchApplier();

    applier.applyPatch({
      p: 'response/status',
      o: 'SET',
      v: 'RUNNING',
    });
    expect(applier.getStatus()).toBe('RUNNING');

    applier.applyPatch({
      p: 'response/fragments',
      o: 'SET',
      v: [{ type: 'RESPONSE', content: 'Initial' }],
    });
    expect(applier.getFragments()).toHaveLength(1);
    expect(applier.getFragments()[0]?.content).toBe('Initial');
  });

  it('applies APPEND operations to strings and arrays', () => {
    const applier = new DeepSeekPatchApplier();

    // Initialize fragment
    applier.applyPatch({
      p: 'response/fragments',
      o: 'SET',
      v: [{ type: 'RESPONSE', content: 'Hello' }],
    });

    // Append text to fragment 0
    applier.applyPatch({
      p: 'response/fragments/0/content',
      o: 'APPEND',
      v: ' world!',
    });
    expect(applier.getFragments()[0]?.content).toBe('Hello world!');

    // Append whole fragment
    applier.applyPatch({
      p: 'response/fragments',
      o: 'APPEND',
      v: [{ type: 'RESPONSE', content: 'Second fragment' }],
    });
    expect(applier.getFragments()).toHaveLength(2);
    expect(applier.getFragments()[1]?.content).toBe('Second fragment');
  });

  it('supports negative array indexes (-1 resolves to the tail element)', () => {
    const applier = new DeepSeekPatchApplier();

    applier.applyPatch({
      p: 'fragments',
      o: 'SET',
      v: [
        { type: 'THINK', content: 'Thinking...' },
        { type: 'RESPONSE', content: 'Start' },
      ],
    });

    // Update tail element using -1
    applier.applyPatch({
      p: 'fragments/-1/content',
      o: 'APPEND',
      v: ' and continuation',
    });

    const frags = applier.getFragments();
    expect(frags).toHaveLength(2);
    expect(frags[0]?.content).toBe('Thinking...');
    expect(frags[1]?.content).toBe('Start and continuation');
  });

  it('handles safe negative index bounds and rejects invalid out-of-bounds negative indexes', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(undefined, (code, msg) => {
      warnings.push({ code, msg });
    });

    // -1 on empty array is allowed (initializes first element)
    applier.applyPatch({
      p: 'fragments/-1/content',
      o: 'SET',
      v: 'Auto-initialized',
    });
    expect(applier.getFragments()).toHaveLength(1);
    expect(applier.getFragments()[0]?.content).toBe('Auto-initialized');

    // Out-of-bounds negative index like -999 on array of length 1
    applier.applyPatch({
      p: 'fragments/-999/content',
      o: 'SET',
      v: 'Should not apply',
    });

    expect(warnings.some((w) => w.code === 'invalid_negative_index')).toBe(true);
    expect(applier.getFragments()).toHaveLength(1);
    expect(applier.getFragments()[0]?.content).toBe('Auto-initialized');
  });

  it('rejects unknown operations according to strict whitelist without modifying state', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(undefined, (code, msg) => {
      warnings.push({ code, msg });
    });

    applier.applyPatch({
      p: 'response/status',
      o: 'SET',
      v: 'SAFE_STATUS',
    });

    // Attempt invalid operation 'DELETE' or 'MUTATE'
    applier.applyPatch({
      p: 'response/status',
      o: 'DELETE' as any,
      v: 'CORRUPTED',
    });

    expect(applier.getStatus()).toBe('SAFE_STATUS');
    expect(warnings.some((w) => w.code === 'unknown_operation')).toBe(true);
  });

  it('enforces bounds on array index upper limits (MAX_ARRAY_INDEX)', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(undefined, (code, msg) => {
      warnings.push({ code, msg });
    });

    applier.applyPatch({
      p: `fragments/${MAX_ARRAY_INDEX + 500}/content`,
      o: 'SET',
      v: 'Exceeds bounds',
    });

    expect(applier.getFragments().length).toBeLessThanOrEqual(MAX_ARRAY_INDEX);
    expect(warnings.some((w) => w.code === 'array_index_too_large')).toBe(true);
  });

  it('enforces bounds on BATCH size and recursion depth', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(undefined, (code, msg) => {
      warnings.push({ code, msg });
    });

    // 1. Oversized BATCH items (> 128)
    const massiveBatch = new Array(MAX_BATCH_ITEMS + 50).fill(null).map((_, i) => ({
      p: 'fragments',
      o: 'APPEND',
      v: [{ type: 'RESPONSE', content: `item_${i}` }],
    }));

    applier.applyPatch({
      o: 'BATCH',
      v: massiveBatch,
    });

    expect(warnings.some((w) => w.code === 'batch_too_large')).toBe(true);
    expect(applier.getFragments().length).toBe(0); // Entire oversized batch rejected without partial mutation

    // 2. Overly deep BATCH recursion (> 8)
    let deeplyNested: any = { p: 'status', o: 'SET', v: 'TOO_DEEP' };
    for (let i = 0; i < MAX_BATCH_DEPTH + 3; i++) {
      deeplyNested = { o: 'BATCH', v: [deeplyNested] };
    }

    applier.applyPatch(deeplyNested);
    expect(warnings.some((w) => w.code === 'batch_too_deep')).toBe(true);
    expect(applier.getStatus()).not.toBe('TOO_DEEP');
  });

  it('supports Variant B top-level response content and thinking_content', () => {
    const applier = new DeepSeekPatchApplier();

    // Direct content append
    applier.applyPatch({
      p: 'response/content',
      o: 'SET',
      v: 'Hello from Variant B',
    });
    applier.applyPatch({
      p: 'response/content',
      o: 'APPEND',
      v: ', chunk 2',
    });

    // Direct thinking_content append
    applier.applyPatch({
      p: 'response/thinking_content',
      o: 'SET',
      v: 'Thinking B initial',
    });
    applier.applyPatch({
      p: 'thinking_content',
      o: 'APPEND',
      v: ' continue',
    });

    expect(applier.getContent()).toBe('Hello from Variant B, chunk 2');
    expect(applier.getThinkingContent()).toBe('Thinking B initial continue');
    expect(applier.getState().response.content).toBe('Hello from Variant B, chunk 2');
  });

  it('supports pathless string append ({"v": "..."} appends to last fragment or content)', () => {
    const applier = new DeepSeekPatchApplier();

    applier.applyPatch({
      p: 'fragments',
      o: 'SET',
      v: [{ type: 'RESPONSE', content: 'Token1' }],
    });

    // Pathless append
    applier.applyPatch({
      v: 'Token2',
    });
    expect(applier.getFragments()[0]?.content).toBe('Token1Token2');

    applier.applyPatch({
      p: '',
      v: 'Token3',
    });
    expect(applier.getFragments()[0]?.content).toBe('Token1Token2Token3');
  });

  it('auto-grows fragment array when index exceeds current length', () => {
    const applier = new DeepSeekPatchApplier();

    // Target fragment 2 when array is empty
    applier.applyPatch({
      p: 'response/fragments/2/content',
      o: 'SET',
      v: 'Index 2 content',
    });

    const frags = applier.getFragments();
    expect(frags.length).toBeGreaterThanOrEqual(3);
    expect(frags[2]?.content).toBe('Index 2 content');
  });

  it('handles BATCH operations recursively with inherited path and operation', () => {
    const applier = new DeepSeekPatchApplier();

    applier.applyPatch({
      p: 'response',
      o: 'BATCH',
      v: [
        {
          p: 'fragments',
          o: 'SET',
          v: [{ type: 'RESPONSE', content: 'Batch Part 1' }],
        },
        {
          p: 'status',
          o: 'SET',
          v: 'FINISHED',
        },
      ],
    });

    expect(applier.getFragments()).toHaveLength(1);
    expect(applier.getFragments()[0]?.content).toBe('Batch Part 1');
    expect(applier.getStatus()).toBe('FINISHED');
  });

  it('rejects prototype pollution attacks (__proto__, prototype, constructor)', () => {
    const applier = new DeepSeekPatchApplier();

    applier.applyPatch({
      p: '__proto__/polluted',
      o: 'SET',
      v: 'malicious',
    });
    expect((Object.prototype as any).polluted).toBeUndefined();

    applier.applyPatch({
      p: 'constructor/prototype/polluted',
      o: 'SET',
      v: 'malicious',
    });
    expect((Object.prototype as any).polluted).toBeUndefined();

    applier.applyPatch({
      p: 'response/fragments/0/__proto__/polluted',
      o: 'SET',
      v: 'malicious',
    });
    expect((Object.prototype as any).polluted).toBeUndefined();
  });

  it('rejects paths exceeding maximum depth bounds', () => {
    const applier = new DeepSeekPatchApplier();
    const deepPath = new Array(40).fill('nested').join('/');

    // Should not throw or crash
    applier.applyPatch({
      p: deepPath,
      o: 'SET',
      v: 'too deep',
    });

    expect(applier.getState().response).toEqual({});
  });

  it('handles malformed, null, or empty patches gracefully without throwing', () => {
    const applier = new DeepSeekPatchApplier();

    expect(() => applier.applyPatch(null)).not.toThrow();
    expect(() => applier.applyPatch(undefined)).not.toThrow();
    expect(() => applier.applyPatch({} as any)).not.toThrow();
    expect(() => applier.applyPatch({ p: 'invalid', o: 'UNKNOWN_OP', v: 123 } as any)).not.toThrow();
  });

  it('rejects pathless patch with unknown operation without mutating state', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(undefined, (code, msg) => {
      warnings.push({ code, msg });
    });

    // Initial state
    applier.applyPatch({
      p: 'fragments',
      o: 'SET',
      v: [{ type: 'RESPONSE', content: 'Base content' }],
    });

    // Attempt pathless patch with unknown op 'DELETE' or 'REMOVE'
    applier.applyPatch({
      o: 'DELETE' as any,
      v: 'malicious payload',
    });

    expect(warnings.some((w) => w.code === 'unknown_operation')).toBe(true);
    expect(applier.getFragments()).toHaveLength(1);
    expect(applier.getFragments()[0]?.content).toBe('Base content');
  });

  it('rejects entire oversized SET fragments (> 1000 items) without partial mutation', () => {
    const warnings: { code: ProtocolWarningCode; msg: string }[] = [];
    const applier = new DeepSeekPatchApplier(undefined, (code, msg) => {
      warnings.push({ code, msg });
    });

    // 1001 fragments exceeds MAX_SET_FRAGMENTS_LIMIT (1000)
    const oversizedFragments = new Array(1001).fill(null).map((_, i) => ({
      type: 'RESPONSE',
      content: `frag_${i}`,
    }));

    applier.applyPatch({
      p: 'fragments',
      o: 'SET',
      v: oversizedFragments,
    });

    expect(warnings.some((w) => w.code === 'array_index_too_large')).toBe(true);
    expect(applier.getFragments()).toHaveLength(0); // Zero mutation
  });
});
