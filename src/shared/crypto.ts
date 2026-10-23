/**
 * Cryptographic helpers for StreamArchive.
 * Provides standard, deterministic SHA-256 calculation and canonical checkpoint serialization.
 * Uses Web Crypto API (globalThis.crypto.subtle) with FIPS 180-4 standard pure JS fallback.
 */

// Initial SHA-256 hash values (first 32 bits of the fractional parts of the square roots of the first 8 primes 2..19)
const H_INIT = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

// SHA-256 round constants (first 32 bits of the fractional parts of the cube roots of the first 64 primes 2..311)
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

export function computeSha256Sync(data: string): string {
  const utf8Bytes: number[] = [];
  for (let i = 0; i < data.length; i++) {
    let charCode = data.charCodeAt(i);
    if (charCode < 0x80) {
      utf8Bytes.push(charCode);
    } else if (charCode < 0x800) {
      utf8Bytes.push(0xc0 | (charCode >> 6), 0x80 | (charCode & 0x3f));
    } else if (charCode < 0xd800 || charCode >= 0xe000) {
      utf8Bytes.push(
        0xe0 | (charCode >> 12),
        0x80 | ((charCode >> 6) & 0x3f),
        0x80 | (charCode & 0x3f)
      );
    } else {
      // Surrogate pair
      i++;
      charCode = 0x10000 + (((charCode & 0x3ff) << 10) | (data.charCodeAt(i) & 0x3ff));
      utf8Bytes.push(
        0xf0 | (charCode >> 18),
        0x80 | ((charCode >> 12) & 0x3f),
        0x80 | ((charCode >> 6) & 0x3f),
        0x80 | (charCode & 0x3f)
      );
    }
  }

  const bitLength = utf8Bytes.length * 8;
  utf8Bytes.push(0x80);
  while ((utf8Bytes.length % 64) !== 56) {
    utf8Bytes.push(0x00);
  }

  const highBitLen = Math.floor(bitLength / 0x100000000);
  const lowBitLen = bitLength >>> 0;
  utf8Bytes.push(
    (highBitLen >>> 24) & 0xff,
    (highBitLen >>> 16) & 0xff,
    (highBitLen >>> 8) & 0xff,
    highBitLen & 0xff,
    (lowBitLen >>> 24) & 0xff,
    (lowBitLen >>> 16) & 0xff,
    (lowBitLen >>> 8) & 0xff,
    lowBitLen & 0xff
  );

  const H = new Uint32Array(H_INIT);
  const W = new Uint32Array(64);

  for (let chunkStart = 0; chunkStart < utf8Bytes.length; chunkStart += 64) {
    for (let t = 0; t < 16; t++) {
      const idx = chunkStart + t * 4;
      W[t] =
        (utf8Bytes[idx]! << 24) |
        (utf8Bytes[idx + 1]! << 16) |
        (utf8Bytes[idx + 2]! << 8) |
        utf8Bytes[idx + 3]!;
    }
    for (let t = 16; t < 64; t++) {
      const w15 = W[t - 15]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const w2 = W[t - 2]!;
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) >>> 0;
    }

    let a = H[0]!;
    let b = H[1]!;
    let c = H[2]!;
    let d = H[3]!;
    let e = H[4]!;
    let f = H[5]!;
    let g = H[6]!;
    let h = H[7]!;

    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[t]! + W[t]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    H[0] = (H[0]! + a) >>> 0;
    H[1] = (H[1]! + b) >>> 0;
    H[2] = (H[2]! + c) >>> 0;
    H[3] = (H[3]! + d) >>> 0;
    H[4] = (H[4]! + e) >>> 0;
    H[5] = (H[5]! + f) >>> 0;
    H[6] = (H[6]! + g) >>> 0;
    H[7] = (H[7]! + h) >>> 0;
  }

  let hex = '';
  for (let i = 0; i < 8; i++) {
    hex += H[i]!.toString(16).padStart(8, '0');
  }
  return hex;
}

export async function computeSha256(data: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === 'function') {
    const encoder = new TextEncoder();
    const hashBuf = await subtle.digest('SHA-256', encoder.encode(data));
    const hashArray = Array.from(new Uint8Array(hashBuf));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return computeSha256Sync(data);
}

/**
 * Deterministic JSON serialization ensuring stable property ordering for canonical fingerprinting.
 * Arrays preserve their semantic order; object keys are sorted alphabetically.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries: string[] = [];
  for (const k of keys) {
    if (obj[k] !== undefined) {
      entries.push(`${JSON.stringify(k)}:${canonicalStringify(obj[k])}`);
    }
  }
  return `{${entries.join(',')}}`;
}

export interface CanonicalCheckpointFingerprintInput {
  streamKey: string;
  checkpointSeq: number;
  isTerminal: boolean;
  conversation?: {
    id: string;
    remoteId?: string;
    title?: string;
    createdAt?: number;
    updatedAt?: number;
  };
  message: {
    id: string;
    conversationId: string;
    remoteId?: string;
    role: string;
    status: string;
    content?: string;
    parentId?: string;
    remoteParentId?: string;
    identityState?: string;
    createdAt?: number;
    updatedAt?: number;
  };
  revisions: Array<{
    id: string;
    messageId: string;
    revisionIndex: number;
    text: string;
    thinking?: string;
    source: string;
    capturedAt: number;
    isFinal: boolean;
    isLastGood: boolean;
    contentFingerprint?: string;
  }>;
  recoveryEvents?: Array<{
    id: string;
    messageId: string;
    kind: string;
    detectedAt: number;
    recoveredRevisionId?: string;
    reason?: string;
  }>;
}

export function serializeCanonicalCheckpointForFingerprint(
  input: CanonicalCheckpointFingerprintInput
): string {
  const normalized = {
    streamKey: input.streamKey,
    checkpointSeq: input.checkpointSeq,
    isTerminal: Boolean(input.isTerminal),
    conversation: input.conversation
      ? {
          id: input.conversation.id,
          remoteId: input.conversation.remoteId ?? null,
          title: input.conversation.title ?? null,
        }
      : null,
    message: {
      id: input.message.id,
      conversationId: input.message.conversationId,
      remoteId: input.message.remoteId ?? null,
      role: input.message.role,
      status: input.message.status,
      content: input.message.content ?? null,
      parentId: input.message.parentId ?? null,
      remoteParentId: input.message.remoteParentId ?? null,
      identityState: input.message.identityState ?? null,
    },
    revisions: input.revisions.map((r) => ({
      id: r.id,
      messageId: r.messageId,
      revisionIndex: r.revisionIndex,
      text: r.text,
      thinking: r.thinking ?? null,
      source: r.source,
      capturedAt: r.capturedAt,
      isFinal: Boolean(r.isFinal),
      isLastGood: Boolean(r.isLastGood),
      contentFingerprint: r.contentFingerprint ?? null,
    })),
    recoveryEvents: (input.recoveryEvents || []).map((e) => ({
      id: e.id,
      messageId: e.messageId,
      kind: e.kind,
      detectedAt: e.detectedAt,
      recoveredRevisionId: e.recoveredRevisionId ?? null,
      reason: e.reason ?? null,
    })),
  };

  return canonicalStringify(normalized);
}

export function computeCanonicalCheckpointFingerprintSync(
  input: CanonicalCheckpointFingerprintInput
): string {
  const serialized = serializeCanonicalCheckpointForFingerprint(input);
  return computeSha256Sync(serialized);
}

export async function computeCanonicalCheckpointFingerprint(
  input: CanonicalCheckpointFingerprintInput
): Promise<string> {
  const serialized = serializeCanonicalCheckpointForFingerprint(input);
  return computeSha256(serialized);
}
