# Durable Raw Journal & ACK Persistence Architecture

> **Crash-Durable Persistence & Verification Specification**  
> **Status:** Production Ready (Evidence Integrity & Persistence Truth Gate Passed)  
> **Extension Version:** v0.2C.1.2  

---

## 1. Overview & Core Philosophy

The **Durable Raw Journal** is DeepSeek StreamArchive's append-only local persistence foundation. It captures observed DeepSeek response streams directly at transport time, buffering raw response text chunks and committing them into local IndexedDB storage in transactional batches **while generation is actively occurring**.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                              PAGE (MAIN WORLD)                         │
│  Fetch / XHR Interceptor ──> window.dispatchEvent(CustomEvent)         │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Bridge Envelope (Strict Bounds & Sanitization)
┌────────────────────────────────────▼───────────────────────────────────┐
│                       CONTENT SCRIPT (ISOLATED WORLD)                  │
│                                                                        │
│   Active Generation Session Verification (Host Anti-Spoofing Gate)     │
│          │                                                             │
│          ├───────────────────────────────┐                             │
│          ▼                               ▼                             │
│  [RawJournalBuffer]             [GenericSseDecoder]                    │
│   - Pre-append Memory Check              │                             │
│   - Size Flush (32 KiB)                  ▼                             │
│   - Timer Flush (500ms)         [DeepSeekProtocolDecoder]              │
│   - Finalize Barrier                     │                             │
│   - Monotonic Ordered Queue              ▼                             │
│   - In-flight ACK Identity Binding   Semantic Stream Events            │
│   - Forensic Evidence Retention          │                             │
│          │                                                             │
│          ▼ (chrome.runtime.sendMessage: Ordered Serial Pipeline)       │
└──────────┼─────────────────────────────────────────────────────────────┘
           │ PERSIST_RAW_STREAM_OPEN -> PERSIST_RAW_BATCH -> FINALIZE_RAW_STREAM
┌──────────▼─────────────────────────────────────────────────────────────┐
│                      BACKGROUND SERVICE WORKER                         │
│                                                                        │
│  [RawStreamRepository]                                                 │
│          │                                                             │
│          ├─ Identity validation & host anti-spoofing enforcement       │
│          ├─ Monotonic batch sequence validation (#1, #2, #3...)        │
│          ├─ Forensic chunk sequence continuity & gap tagging           │
│          ├─ Payload-aware idempotency comparison & conflict rejection  │
│          ├─ Idempotent terminal state finalization (no delta doubling) │
│          ▼ createRawWriteTransaction (IDBTransaction durability: strict│
│  IndexedDB Commit (tx.oncomplete)                                      │
│          │                                                             │
│          ▼ Authoritative ACK ({ success, streamKey, batchSeq, lastPersistedAt })
└────────────────────────────────────────────────────────────────────────┘
```

### Key Architectural Invariants:
1. **Decoupled Prior to Protocol Decoding:** Raw text is captured and buffered *before* or *in parallel with* SSE framing and protocol parsing. Even if DeepSeek's payload format changes, an abort occurs, or a decoder error triggers, the raw observed text is already durably preserved on disk as forensic evidence.
2. **Transactional Durability (ACK Pipeline):** A batch is considered persistent *only* when IndexedDB fires `tx.oncomplete`. The Background Service Worker does not acknowledge receipt until the transaction commits with strict durability hints.
3. **Strict In-Flight ACK Binding:** Content scripts validate that incoming ACKs match the active in-flight request identity (`streamKey`, `batchSeq`, `finalState`). Mismatched or unsolicited ACKs are rejected and keep the pending queue intact.
4. **Natural Storage Order Replay (Replay Truth):** Replay operates strictly on natural persisted storage order. Synthetic sorting is eliminated to expose rather than conceal storage anomalies, which are flagged in structured `ReplayAuditReport` diagnostics.
5. **Forensic Evidence Retention Across Gaps:** If chunk sequence gaps occur over the wire, incoming chunks are still committed to IndexedDB to ensure no observed data is discarded, while the stream is tagged with `integrity: 'gap_detected'` and `state: 'degraded'`.
6. **No Intermediate Canonical Entities:** Canonical entities (`Conversation`, `Message`, `ResponseRevision`, `RecoveryEvent`) are deliberately **not** created directly within the raw journal layer. Canonical promotion is strictly handled by downstream canonical layers
7. **Local-First & Zero-Leakage:** Only response text chunks are archived. Request bodies, user prompts, Authorization headers, cookies, query parameters, and URL anchors are strictly discarded before persistence.

---

## 2. Storage Schema (Version 2)

The database schema (`StreamArchiveDB`) is upgraded from Version 1 to Version 2 while strictly preserving all existing Version 1 object stores (`conversations`, `messages`, `revisions`, `recovery_events`).

### `raw_streams` Store
- **KeyPath:** `id` (Composite string key: `<producerSessionId>:<streamId>`)
- **Indexes:**
  - `openedAt` (integer timestamp)
  - `state` (`'active' | 'completed' | 'aborted' | 'error' | 'degraded'`)
  - `provisionalSessionId` (string, route session ID if present)
  - `updatedAt` (integer timestamp)

**Record Structure (`RawStreamRecord`):**
```typescript
interface RawStreamRecord {
  id: string; // `${producerSessionId}:${streamId}`
  producerSessionId: string;
  streamId: string;
  transport: 'fetch' | 'xhr';
  url: string; // Sanitized: origin + pathname only (chat.deepseek.com only)
  method: string; // Typically 'POST'
  provisionalSessionId?: string;
  captureProfileId?: string;
  state: 'active' | 'completed' | 'aborted' | 'error' | 'degraded';
  integrity?: 'pristine' | 'gap_detected' | 'degraded' | 'corrupt';
  openedAt: number;
  updatedAt: number;
  lastPersistedAt?: number;
  lastPersistedBatchSeq?: number;
  lastPersistedStreamSequence?: number;
  lastBatchAt?: number;
  finalizedAt?: number;
  totalChunks: number;
  totalChars: number;
  totalBatches: number;
  terminalReason?: string;
  error?: string;
  droppedChars?: number;
  durabilityGap?: boolean;
}
```

### `raw_stream_batches` Store
- **KeyPath:** `id` (Deterministic composite key: `<streamKey>:<batchSeq>`)
- **Indexes:**
  - `streamKey` (foreign reference to `raw_streams.id`)
  - `createdAt` (integer timestamp)
  - `batchSeq` (1-indexed monotonic integer)

**Record Structure (`StoredRawStreamBatch`):**
```typescript
interface StoredRawStreamBatch {
  id: string; // `${streamKey}:${batchSeq}`
  streamKey: string;
  batchSeq: number;
  chunks: Array<{
    streamSequence: number;
    chunkText: string;
    timestamp: number;
  }>;
  createdAt: number;
  charCount: number;
  persistedAt: number; // Set upon IndexedDB commit
}
```

---

## 3. Ordered Pipeline, Finalization Barrier & Memory Ceiling

### Monotonic Ordered ACK Chain
The bridge enforces strict serialized processing per stream:
```text
OPEN ACK -> BATCH 1 ACK -> BATCH 2 ACK -> ... -> FINAL BATCH ACK -> FINALIZE ACK
```
- Content script never dispatches `BATCH 1` before `OPEN` receives an authoritative ACK.
- Batches are sent strictly one by one in monotonic sequence (`batchSeq` 1, 2, 3...).
- Repository rejects any batch where `batchSeq !== (lastPersistedBatchSeq || 0) + 1` with `batch_sequence_gap`.
- Terminal transport events seal the buffer into a final batch and await all prior batch ACKs before dispatching `STREAMARCHIVE_FINALIZE_RAW_STREAM`.
- Only after `FINALIZE ACK` is the stream buffer evicted from memory.

### Flush Trigger Matrix
| Trigger | Threshold | Description |
|---|---|---|
| **Size Threshold** | `charCount >= 32,768` (32 KiB) | Flushes immediately to prevent unbounded buffer growth during high-speed token generation. |
| **Timer Threshold** | 500ms debounce | Flushes accumulated chunks if no new chunks arrive or between generation pauses. |
| **Terminal Event** | `complete`, `abort`, `error` | Flushes any remaining uncommitted chunks into a final batch prior to finalization barrier. |
| **Unload Hooks** | `pagehide`, `visibilitychange` | Best-effort flush of pending chunks upon tab backgrounding or navigation. |

### Pre-Append Memory Ceiling & Dropped Chunks Accounting
- Active tracked streams bound to 16 (`MAX_ACTIVE_KNOWN_STREAMS = 16`). Terminating streams awaiting `FINALIZE ACK` are protected against premature eviction.
- Memory ceiling evaluated *before* accepting incoming chunk:
  `pendingChars + currentBatchChars + incomingChunk.length > maxPendingChars` (512 KiB).
- When exceeded, the buffer immediately drops the incoming chunk, transitions to `state: 'degraded'`, marks `durabilityGap: true`, and updates `droppedChars`.
- `droppedChars` and `durabilityGap` are stored in `RawStreamRecord` upon finalization.

### Idempotency & Conflict Guard
- Duplicate deliveries of an identical batch payload return an idempotent ACK with original `persistedAt` without incrementing counters.
- Batches with conflicting payloads under an identical batch ID reject with `batch_id_conflict`, preserve original data untouched, and mark stream `degraded` with `durabilityGap = true`.
- Finalization is idempotent: repeated finalize requests return original `finalizedAt` without re-accumulating `droppedChars` or modifying committed state.
- Divergent finalize requests (conflicting terminal state, total chunks, or characters) are rejected with `finalize_conflict`.

---

## 4. Pure Deterministic Replay Engine & Audit Diagnostics

Stored raw batches can be replayed at any time without side effects or network calls using `replayRawBatches(batches, options)` or `replayRawStream(streamRecord, batches, options)`:

```typescript
import { replayRawStream } from './src/storage/raw-journal/replay';

const stream = await rawRepo.getStream('tab_1:stream_abc');
const batches = await rawRepo.listBatchesForStream('tab_1:stream_abc');
const result = replayRawStream(stream, batches);

console.log(result.projectedAnswer);    // Fully reconstructed response text
console.log(result.projectedThinking);  // Fully reconstructed thinking trace
console.log(result.filterTriggered);    // Boolean: true if censorship detected
console.log(result.isComplete);         // Boolean: true if completed cleanly (excludes quasi_status)
console.log(result.integrity);          // 'pristine' | 'gap_detected' | 'degraded' | 'corrupt'
console.log(result.audit);              // Structured ReplayAuditReport
```

### Replay Invariants:
- **No Synthetic Sorting:** Chunks are processed in natural persisted order to preserve forensic truth.
- **Granular Audit Report (`ReplayAuditReport`):** Detects duplicate sequences, sequence gaps, missing stream prefixes, invalid batch hashes, or foreign keys.
- **Pass-through Protocol Projection:** Passes raw text through `GenericSseDecoder` and `DeepSeekProtocolDecoder`.
- **Quasi-Status Safety:** Intermediate `quasi_status: "FINISHED"` is strictly excluded from `isComplete` evaluation.

---

## 5. Privacy, Security & Boundary Invariants

1. **Host Anti-Spoofing:** URL candidate predicates enforce strict origin matching (`chat.deepseek.com`). Requests to external domains or non-standard ports embedding candidate endpoints are rejected immediately.
2. **String Bounds & Identity Delimiters:** Composite stream keys are constructed as `${producerSessionId}:${streamId}`. Field validators forbid colon `:` characters in IDs to prevent composite key confusion. String lengths are strictly capped (`MAX_ID_CHARS = 128`, `MAX_URL_CHARS = 1024`, `MAX_REASON_CHARS = 256`, `MAX_METHOD_CHARS = 16`).
3. **URL Sanitization:** URLs are stripped of all search query parameters (`?foo=bar`) and hash anchors (`#baz`). Only `origin + pathname` is persisted.
4. **Zero Ingestion of Prompts or Auth Headers:** The raw journal captures response chunk text ONLY. No request payloads, user prompts, Bearer tokens, or cookies are ever buffered or written to disk.
5. **No Unrestricted Permissions:** Retains strict Manifest V3 permissions (`["storage", "sidePanel"]`). `unlimitedStorage` is deliberately omitted.
6. **Zero Production Logging of Sensitive Tokens:** Raw chunk content is never logged to standard output or console logs.

---

## 6. Canonical Promotion & Downstream Boundary

The Raw Journal acts as the forensic evidence foundation for the Canonical Model. While the Raw Journal remains append-only and forensic, the **Canonical Recorder** and **Replay Rebuilder** promote eligible streams into structured `Conversation`, `Message`, `ResponseRevision`, and `RecoveryEvent` entities:

- **Promotion Evaluation (`evaluateCanonicalPromotion`):** Only streams with terminal state (`completed`, `filtered`, or `interrupted`), `integrity: 'intact'`, and zero sequence gaps (`durabilityGap === false`) are eligible for canonical promotion.
- **Degraded Streams:** Streams marked with `integrity: 'gap_detected'` remain securely stored in the Raw Journal for forensic inspection but are prevented from creating corrupted or partial canonical messages.
- Detailed canonical model specifications are documented in [CANONICAL_MODEL.md](./CANONICAL_MODEL.md) and [ADR 0015](./ADR/0015-canonical-identity-and-passive-history-reconciliation.md).

