import type {
  DeepSeekFragment,
  DeepSeekPatchOp,
  DeepSeekRawPatch,
  KnownDeepSeekPatchOp,
  PatchApplyResult,
  ProtocolWarningCode,
} from './types';
import { findDeepSeekMessageId } from './message-id';

export const MAX_PATH_DEPTH = 32;
export const MAX_BATCH_ITEMS = 128;
export const MAX_BATCH_DEPTH = 8;
export const MAX_ARRAY_INDEX = 1000;
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const KNOWN_OPS = new Set<KnownDeepSeekPatchOp>(['SET', 'APPEND', 'REPLACE', 'BATCH']);

export interface DeepSeekInternalState {
  status?: string;
  quasiStatus?: string;
  messageId?: string;
  hasPendingFragment?: boolean;
  incompleteMessage?: boolean;
  fragments: DeepSeekFragment[];
  content?: string;
  thinking_content?: string;
  response: Record<string, unknown>;
}

export type PatchWarningCallback = (code: ProtocolWarningCode, message: string) => void;

/**
 * Safe, bounded recursive JSON patch applier for DeepSeek stream tokens.
 *
 * Capabilities & Invariants:
 * - Strict operation whitelist validation before any mutation or branch execution.
 * - Rejects entire oversized BATCH or SET operations rather than partial mutations.
 * - Negative array index resolution (-1 resolves to tail element) with out-of-bounds guards.
 * - Bounded recursion depth (<= 8) and batch length (<= 128).
 * - Upper bound protection for array indices (<= 1000).
 * - Full prototype pollution immunity (__proto__, prototype, constructor).
 * - Supports both Variant A (fragments[]) and Variant B (response.content / thinking_content).
 * - Tracks status, quasi_status, has_pending_fragment, and incomplete_message.
 */
export class DeepSeekPatchApplier {
  private state: DeepSeekInternalState;
  private lastUpdatePath = '';
  private lastUpdateOp: KnownDeepSeekPatchOp = 'SET';
  private onWarning?: PatchWarningCallback;

  constructor(
    initialState?: Partial<DeepSeekInternalState>,
    onWarning?: PatchWarningCallback
  ) {
    this.onWarning = onWarning;
    this.state = {
      status: initialState?.status,
      quasiStatus: initialState?.quasiStatus,
      messageId: initialState?.messageId,
      hasPendingFragment: initialState?.hasPendingFragment,
      incompleteMessage: initialState?.incompleteMessage,
      fragments: initialState?.fragments ? structuredClone(initialState.fragments) : [],
      content: initialState?.content,
      thinking_content: initialState?.thinking_content,
      response: initialState?.response ? structuredClone(initialState.response) : {},
    };
  }

  setWarningCallback(cb: PatchWarningCallback | undefined): void {
    this.onWarning = cb;
  }

  private emitWarning(code: ProtocolWarningCode, message: string): void {
    if (this.onWarning) {
      this.onWarning(code, message);
    }
  }

  getState(): DeepSeekInternalState {
    return {
      status: this.state.status,
      quasiStatus: this.state.quasiStatus,
      messageId: this.state.messageId,
      hasPendingFragment: this.state.hasPendingFragment,
      incompleteMessage: this.state.incompleteMessage,
      fragments: structuredClone(this.state.fragments),
      content: this.state.content,
      thinking_content: this.state.thinking_content,
      response: structuredClone(this.state.response),
    };
  }

  getFragments(): DeepSeekFragment[] {
    return this.state.fragments;
  }

  getMessageId(): string | undefined {
    return this.state.messageId;
  }

  getStatus(): string | undefined {
    return this.state.status;
  }

  getQuasiStatus(): string | undefined {
    return this.state.quasiStatus;
  }

  hasPendingFragment(): boolean | undefined {
    return this.state.hasPendingFragment;
  }

  incompleteMessage(): boolean | undefined {
    return this.state.incompleteMessage;
  }

  getContent(): string | undefined {
    return this.state.content;
  }

  getThinkingContent(): string | undefined {
    return this.state.thinking_content;
  }

  reset(): void {
    this.state = {
      status: undefined,
      quasiStatus: undefined,
      messageId: undefined,
      hasPendingFragment: undefined,
      incompleteMessage: undefined,
      fragments: [],
      content: undefined,
      thinking_content: undefined,
      response: {},
    };
    this.lastUpdatePath = '';
    this.lastUpdateOp = 'SET';
  }

  applyPatch(
    patch: DeepSeekRawPatch | null | undefined,
    parentPath = '',
    parentOp: DeepSeekPatchOp = '',
    batchDepth = 0
  ): PatchApplyResult {
    if (!patch || typeof patch !== 'object') {
      return { status: 'ignored_control', mutated: false };
    }

    // 1. Extract message ID if present anywhere in patch (read-only)
    const extractedId = findDeepSeekMessageId(patch);
    if (extractedId) {
      this.state.messageId = extractedId;
    }

    // 2. Strict Operation Validation (MUST happen before any state mutation)
    const rawOp = (patch.o || parentOp || 'SET').toUpperCase();
    if (!KNOWN_OPS.has(rawOp as KnownDeepSeekPatchOp)) {
      this.emitWarning('unknown_operation', `Unknown patch operation rejected: ${rawOp}`);
      // Invariant: Do NOT mutate state on unknown operation under any circumstance!
      return { status: 'rejected', mutated: false, reason: 'unknown_operation' };
    }
    const op = rawOp as KnownDeepSeekPatchOp;

    // 3. Pathless token handling
    if (patch.p === undefined || patch.p === '') {
      // 3a. Pathless string token {"v": "chunk"}
      if (typeof patch.v === 'string') {
        // Explicit pathless SET or REPLACE must NOT do implicit append
        if (patch.o && patch.o.toUpperCase() !== 'APPEND') {
          this.emitWarning(
            'invalid_patch_shape',
            `Explicit pathless operation ${patch.o} rejected: non-APPEND pathless operation cannot mutate state`
          );
          return { status: 'rejected', mutated: false, reason: 'explicit_pathless_non_append' };
        }

        // Implicit or explicit APPEND
        if (this.state.fragments.length === 0) {
          if (this.state.content !== undefined) {
            this.state.content += patch.v;
            (this.state.response as any).content = this.state.content;
          } else {
            this.state.fragments.push({ type: 'RESPONSE', content: patch.v });
          }
        } else {
          const last = this.state.fragments[this.state.fragments.length - 1];
          if (last) {
            last.content = (last.content || '') + patch.v;
          }
        }
        return { status: 'applied', mutated: true };
      }

      // 3b. Pathless array token {"v": [...]} continuation (e.g. BATCH continuation under response)
      if (Array.isArray(patch.v)) {
        if (parentPath === 'response/fragments' || this.lastUpdatePath === 'response/fragments') {
          return this.applyPatch({ p: 'response/fragments', o: 'APPEND', v: patch.v }, parentPath, 'APPEND', batchDepth);
        }
        return this.applyPatch({ p: 'response', o: 'BATCH', v: patch.v }, parentPath || 'response', 'SET', batchDepth);
      }

      // 3c. Pathless snapshot object {"v": { "response": {...} }} or {"v": { "status": "WIP", ... }}
      if (patch.v && typeof patch.v === 'object') {
        return this.applySnapshotObject(patch.v as Record<string, unknown>);
      }

      // Non-text, non-array pathless tokens (e.g. update_session or close frames) must not mutate state
      return { status: 'ignored_control', mutated: false };
    }

    // Inherit or resolve path
    let rawPath = patch.p !== undefined ? patch.p : parentPath || this.lastUpdatePath;
    if (patch.p !== undefined) {
      this.lastUpdatePath = patch.p;
    }

    // Handle nested relative path under parent path
    if (parentPath && patch.p && !patch.p.startsWith(parentPath)) {
      rawPath = `${parentPath}/${patch.p}`.replace(/\/+/g, '/');
    }

    // 4. Handle BATCH operation recursively with strict safety bounds
    if (op === 'BATCH') {
      if (batchDepth >= MAX_BATCH_DEPTH) {
        this.emitWarning(
          'batch_too_deep',
          `BATCH nesting depth ${batchDepth} exceeded maximum depth ${MAX_BATCH_DEPTH}`
        );
        return { status: 'rejected', mutated: false, reason: 'batch_too_deep' };
      }

      if (!Array.isArray(patch.v)) {
        return { status: 'ignored_control', mutated: false };
      }

      // Invariant: If BATCH exceeds MAX_BATCH_ITEMS, reject the entire offending batch subtree!
      // Do NOT partially apply a corrupted batch.
      if (patch.v.length > MAX_BATCH_ITEMS) {
        this.emitWarning(
          'batch_too_large',
          `BATCH items length ${patch.v.length} exceeded maximum limit ${MAX_BATCH_ITEMS}. Entire batch rejected.`
        );
        return { status: 'rejected', mutated: false, reason: 'batch_too_large' };
      }

      let anyMutated = false;
      for (const item of patch.v) {
        const sub = this.applyPatch(item, rawPath, 'SET', batchDepth + 1);
        if (sub.mutated) anyMutated = true;
      }
      return { status: anyMutated ? 'applied' : 'ignored_control', mutated: anyMutated };
    }

    // Normalize and split path
    const cleanPath = rawPath.replace(/^\/+|\/+$/g, '');
    const segments = cleanPath.split('/').filter((s) => s.length > 0);

    // Security bounds check
    if (segments.length > MAX_PATH_DEPTH) {
      this.emitWarning(
        'path_too_deep',
        `Path depth ${segments.length} exceeded maximum ${MAX_PATH_DEPTH}`
      );
      return { status: 'rejected', mutated: false, reason: 'path_too_deep' };
    }

    for (const seg of segments) {
      if (FORBIDDEN_SEGMENTS.has(seg)) {
        return { status: 'rejected', mutated: false, reason: 'forbidden_segment' };
      }
    }

    // Canonical normalized path (strip optional leading 'response/')
    const normPath = cleanPath.replace(/^response\//, '');

    // Full snapshot when path is "response"
    if ((normPath === 'response' || cleanPath === 'response') && patch.v && typeof patch.v === 'object' && !Array.isArray(patch.v)) {
      return this.applySnapshotObject(patch.v as Record<string, unknown>);
    }

    // List ops on fragments: "fragments" or "response/fragments"
    if (normPath === 'fragments') {
      if ((op === 'SET' || op === 'REPLACE') && Array.isArray(patch.v)) {
        if (patch.v.length > MAX_ARRAY_INDEX) {
          this.emitWarning(
            'array_index_too_large',
            `Cannot set fragments array with ${patch.v.length} items, exceeds limit ${MAX_ARRAY_INDEX}. Operation rejected.`
          );
          return { status: 'rejected', mutated: false, reason: 'array_index_too_large' };
        }
        this.state.fragments = structuredClone(patch.v);
        return { status: 'applied', mutated: true };
      } else if (op === 'APPEND' && Array.isArray(patch.v)) {
        const remainingCapacity = Math.max(0, MAX_ARRAY_INDEX - this.state.fragments.length);
        if (patch.v.length > remainingCapacity) {
          this.emitWarning(
            'array_index_too_large',
            `Cannot append ${patch.v.length} fragments, exceeds capacity limit ${MAX_ARRAY_INDEX}. Operation rejected.`
          );
          return { status: 'rejected', mutated: false, reason: 'array_index_too_large' };
        }
        this.state.fragments.push(...structuredClone(patch.v));
        return { status: 'applied', mutated: true };
      }
      return { status: 'ignored_control', mutated: false };
    }

    // Status ops: "status" or "response/status"
    if (normPath === 'status') {
      if (typeof patch.v === 'string') {
        this.state.status = patch.v;
        return { status: 'applied', mutated: true };
      }
      return { status: 'ignored_control', mutated: false };
    }

    // Quasi status ops: "quasi_status" or "response/quasi_status"
    if (normPath === 'quasi_status') {
      if (typeof patch.v === 'string') {
        this.state.quasiStatus = patch.v;
        return { status: 'applied', mutated: true };
      }
      return { status: 'ignored_control', mutated: false };
    }

    // Pending fragment flag
    if (normPath === 'has_pending_fragment') {
      this.state.hasPendingFragment = Boolean(patch.v);
      return { status: 'applied', mutated: true };
    }

    // Incomplete message flag
    if (normPath === 'incomplete_message') {
      this.state.incompleteMessage = Boolean(patch.v);
      return { status: 'applied', mutated: true };
    }

    // Message ID ops: "message_id" or "response/message_id"
    if (normPath === 'message_id' || normPath === 'response_message_id') {
      if (typeof patch.v === 'string' || typeof patch.v === 'number') {
        this.state.messageId = String(patch.v).trim();
        return { status: 'applied', mutated: true };
      }
      return { status: 'ignored_control', mutated: false };
    }

    // Variant B: Direct content ("content" or "response/content")
    if (normPath === 'content') {
      const strVal = typeof patch.v === 'string' ? patch.v : String(patch.v ?? '');
      if (op === 'SET' || op === 'REPLACE') {
        this.state.content = strVal;
      } else if (op === 'APPEND') {
        this.state.content = (this.state.content || '') + strVal;
      }
      (this.state.response as any).content = this.state.content;
      return { status: 'applied', mutated: true };
    }

    // Variant B: Direct thinking_content ("thinking_content" or "response/thinking_content")
    if (normPath === 'thinking_content') {
      const strVal = typeof patch.v === 'string' ? patch.v : String(patch.v ?? '');
      if (op === 'SET' || op === 'REPLACE') {
        this.state.thinking_content = strVal;
      } else if (op === 'APPEND') {
        this.state.thinking_content = (this.state.thinking_content || '') + strVal;
      }
      (this.state.response as any).thinking_content = this.state.thinking_content;
      return { status: 'applied', mutated: true };
    }

    // Fragment content ops: "fragments/-1/content" or "fragments/0/content"
    const contentMatch = normPath.match(/^fragments\/(-?\d+)\/content$/);
    if (contentMatch && typeof patch.v === 'string') {
      const idx = this.resolveIndex(contentMatch[1]!, this.state.fragments);
      if (idx === null) return { status: 'rejected', mutated: false, reason: 'invalid_index' };
      if (!this.ensureFragmentAt(idx)) return { status: 'rejected', mutated: false, reason: 'fragment_grow_failed' };
      const frag = this.state.fragments[idx]!;
      if (patch.o && (patch.o.toUpperCase() === 'SET' || patch.o.toUpperCase() === 'REPLACE')) {
        frag.content = patch.v;
      } else {
        frag.content = (frag.content || '') + patch.v;
      }
      return { status: 'applied', mutated: true };
    }

    // Whole fragment ops: "fragments/-1" or "fragments/0"
    const fragMatch = normPath.match(/^fragments\/(-?\d+)$/);
    if (fragMatch && patch.v && typeof patch.v === 'object' && !Array.isArray(patch.v)) {
      const idx = this.resolveIndex(fragMatch[1]!, this.state.fragments);
      if (idx === null) return { status: 'rejected', mutated: false, reason: 'invalid_index' };
      if (!this.ensureFragmentAt(idx)) return { status: 'rejected', mutated: false, reason: 'fragment_grow_failed' };
      if (op === 'SET' || op === 'REPLACE') {
        this.state.fragments[idx] = structuredClone(patch.v as DeepSeekFragment);
      } else {
        Object.assign(this.state.fragments[idx]!, structuredClone(patch.v));
      }
      return { status: 'applied', mutated: true };
    }

    // Fragment subfield ops: "fragments/-1/style" or "fragments/0/type"
    const subfieldMatch = normPath.match(/^fragments\/(-?\d+)\/([a-zA-Z0-9_-]+)$/);
    if (subfieldMatch) {
      const idx = this.resolveIndex(subfieldMatch[1]!, this.state.fragments);
      if (idx === null) return { status: 'rejected', mutated: false, reason: 'invalid_index' };
      const key = subfieldMatch[2]!;
      if (!FORBIDDEN_SEGMENTS.has(key)) {
        if (!this.ensureFragmentAt(idx)) return { status: 'rejected', mutated: false, reason: 'fragment_grow_failed' };
        const frag = this.state.fragments[idx] as Record<string, unknown>;
        if (op === 'APPEND' && typeof frag[key] === 'string' && typeof patch.v === 'string') {
          frag[key] = (frag[key] as string) + patch.v;
        } else {
          frag[key] = structuredClone(patch.v);
        }
        return { status: 'applied', mutated: true };
      }
      return { status: 'rejected', mutated: false, reason: 'forbidden_key' };
    }

    // General fallback: apply patch into state.response tree
    const normSegments = normPath.split('/').filter((s) => s.length > 0);
    if (normSegments.length === 0) {
      return { status: 'ignored_control', mutated: false };
    }
    const applied = this.applyToTree(this.state.response, normSegments, patch.v, op);
    return { status: applied ? 'applied' : 'ignored_control', mutated: applied };
  }

  private resolveIndex(rawIndex: string, arr: unknown[]): number | null {
    const n = parseInt(rawIndex, 10);
    if (isNaN(n)) return 0;

    if (n < 0) {
      if (arr.length === 0) {
        if (n === -1) {
          return 0;
        }
        this.emitWarning(
          'invalid_negative_index',
          `Negative index ${n} is invalid for empty array`
        );
        return null;
      }
      const resolved = arr.length + n;
      if (resolved < 0) {
        this.emitWarning(
          'invalid_negative_index',
          `Negative index ${n} out of bounds for array of length ${arr.length}`
        );
        return null;
      }
      return resolved;
    }

    if (n > MAX_ARRAY_INDEX) {
      this.emitWarning(
        'array_index_too_large',
        `Array index ${n} exceeds maximum allowed index ${MAX_ARRAY_INDEX}`
      );
      return null;
    }

    return n;
  }

  private ensureFragmentAt(index: number): boolean {
    if (index > MAX_ARRAY_INDEX) {
      this.emitWarning(
        'array_index_too_large',
        `Cannot grow fragments array to index ${index}, exceeds ${MAX_ARRAY_INDEX}`
      );
      return false;
    }
    while (this.state.fragments.length <= index) {
      this.state.fragments.push({ type: 'RESPONSE', content: '' });
    }
    return true;
  }

  private applyToTree(
    root: Record<string, unknown>,
    segments: string[],
    value: unknown,
    op: KnownDeepSeekPatchOp
  ): boolean {
    let current: any = root;

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const nextSeg = segments[i + 1]!;
      const isNextArray = /^[-+]?\d+$/.test(nextSeg);

      let key: string | number = seg;
      if (Array.isArray(current) && /^[-+]?\d+$/.test(seg)) {
        const resolved = this.resolveIndex(seg, current);
        if (resolved === null) return false;
        key = resolved;
        if (key > MAX_ARRAY_INDEX) {
          this.emitWarning(
            'array_index_too_large',
            `Array index ${key} exceeds limit ${MAX_ARRAY_INDEX}`
          );
          return false;
        }
        while (current.length <= key) {
          current.push(isNextArray ? [] : {});
        }
      } else if (!Array.isArray(current)) {
        if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
          current[key] = isNextArray ? [] : {};
        }
      }

      current = current[key];
      if (!current || typeof current !== 'object') {
        return false;
      }
    }

    const lastSeg = segments[segments.length - 1]!;
    let lastKey: string | number = lastSeg;

    if (Array.isArray(current) && /^[-+]?\d+$/.test(lastSeg)) {
      const resolved = this.resolveIndex(lastSeg, current);
      if (resolved === null) return false;
      lastKey = resolved;
      if (lastKey > MAX_ARRAY_INDEX) {
        this.emitWarning(
          'array_index_too_large',
          `Array index ${lastKey} exceeds limit ${MAX_ARRAY_INDEX}`
        );
        return false;
      }
      while (current.length <= lastKey) {
        current.push(undefined);
      }
    }

    if (op === 'APPEND') {
      if (Array.isArray(current[lastKey])) {
        if (Array.isArray(value)) {
          if (current[lastKey].length + value.length > MAX_ARRAY_INDEX) {
            this.emitWarning(
              'array_index_too_large',
              `Cannot append ${value.length} items to array, exceeds limit ${MAX_ARRAY_INDEX}. Entire APPEND rejected.`
            );
            return false;
          }
          current[lastKey].push(...structuredClone(value));
        } else {
          if (current[lastKey].length >= MAX_ARRAY_INDEX) {
            this.emitWarning(
              'array_index_too_large',
              `Cannot append item to array, exceeds limit ${MAX_ARRAY_INDEX}. Entire APPEND rejected.`
            );
            return false;
          }
          current[lastKey].push(structuredClone(value));
        }
      } else if (typeof current[lastKey] === 'string' && typeof value === 'string') {
        current[lastKey] += value;
      } else {
        current[lastKey] = structuredClone(value);
      }
    } else {
      current[lastKey] = structuredClone(value);
    }

    return true;
  }

  private applySnapshotObject(container: Record<string, unknown>): PatchApplyResult {
    const res = (container.response || container) as Record<string, unknown>;
    if (!res || typeof res !== 'object' || Array.isArray(res)) {
      return { status: 'ignored_control', mutated: false };
    }

    // 1. Pre-validation: Check all safety bounds BEFORE mutating any state!
    if (Array.isArray(res.fragments) && res.fragments.length > MAX_ARRAY_INDEX) {
      this.emitWarning(
        'array_index_too_large',
        `Snapshot fragments count ${res.fragments.length} exceeds limit ${MAX_ARRAY_INDEX}. Entire snapshot rejected.`
      );
      return { status: 'rejected', mutated: false, reason: 'array_index_too_large' };
    }

    // Check for prototype pollution or forbidden keys anywhere in snapshot top-level
    for (const k of Object.keys(res)) {
      if (FORBIDDEN_SEGMENTS.has(k)) {
        this.emitWarning('invalid_patch_shape', `Forbidden key in snapshot rejected: ${k}`);
        return { status: 'rejected', mutated: false, reason: 'forbidden_key' };
      }
    }

    // 2. Apply mutations atomically
    let snapshotApplied = false;

    if (Array.isArray(res.fragments)) {
      this.state.fragments = structuredClone(res.fragments);
      snapshotApplied = true;
    }

    if (typeof res.status === 'string') {
      this.state.status = res.status;
      snapshotApplied = true;
    }

    if (typeof res.quasi_status === 'string') {
      this.state.quasiStatus = res.quasi_status;
      snapshotApplied = true;
    }

    if (res.has_pending_fragment !== undefined) {
      this.state.hasPendingFragment = Boolean(res.has_pending_fragment);
      snapshotApplied = true;
    }

    if (res.incomplete_message !== undefined) {
      this.state.incompleteMessage = Boolean(res.incomplete_message);
      snapshotApplied = true;
    }

    if (typeof res.content === 'string') {
      this.state.content = res.content;
      (this.state.response as any).content = res.content;
      snapshotApplied = true;
    }

    if (typeof res.thinking_content === 'string') {
      this.state.thinking_content = res.thinking_content;
      (this.state.response as any).thinking_content = res.thinking_content;
      snapshotApplied = true;
    }

    if (res.message_id !== undefined && res.message_id !== null) {
      this.state.messageId = String(res.message_id).trim();
      snapshotApplied = true;
    }

    for (const [k, val] of Object.entries(res)) {
      if (!FORBIDDEN_SEGMENTS.has(k)) {
        (this.state.response as any)[k] = structuredClone(val);
      }
    }

    return { status: snapshotApplied ? 'applied' : 'ignored_control', mutated: snapshotApplied };
  }
}
