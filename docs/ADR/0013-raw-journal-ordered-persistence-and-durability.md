# ADR 0013: Raw Journal Ordered Persistence, Idempotency, and Crash-Durability Gate

## Status
Accepted

## Context
During persistence auditing, an external code review of the persistence architecture identified several critical integrity, ordering, and scalability risks:

1. **Ordering Race Conditions Over the Bridge:** Content script buffering could dispatch `STREAMARCHIVE_PERSIST_RAW_BATCH` messages before receiving acknowledgment for `STREAMARCHIVE_PERSIST_RAW_STREAM_OPEN`, and could send `STREAMARCHIVE_FINALIZE_RAW_STREAM` while earlier batches were still inflight or undergoing retry backoff.
2. **Synthetic Metadata Fabrication:** The persistence repository synthesized placeholder stream records (with hardcoded synthetic URLs and methods) if a batch or finalize request arrived for an unopened stream key, masking upstream transport errors and corrupting auditability.
3. **Weak Batch Idempotency:** The repository only checked for existing batch keys, silently updating records without verifying whether incoming chunk contents matched previously committed data, risking silent overwrite if batch IDs collided.
4. **Memory Ceiling & DoS Vulnerabilities:** If background persistence stalled or crashed, content script buffer memory could grow without hard bounds or drop chunks silently without recording durability gaps.
5. **Storage Metadata Scalability Flaw:** `getJournalMetadata()` called `raw_stream_batches.getAll()`, reading all raw text chunk payloads into Service Worker memory on every status query, an unsustainable pattern for large journals.
6. **Replay Quasi-Status Bug:** Pure replay logic treated DeepSeek's intermediate `quasi_status: "FINISHED"` as authoritative stream completion, which could misclassify interrupted or censored streams as successfully completed.
7. **Premature Buffer Teardown:** Content scripts lacked a finalization barrier, risking teardown before pending batch retries concluded.

---

## Decision

To establish a verified crash-durable, append-only persistence foundation before implementing the canonical recorder, we enacted the following architectural decisions:

### 1. Strictly Ordered Pipeline & ACK Chain
We enforced a strict monotonic pipeline lifecycle per stream:
```text
OPEN
  ↓ (await OPEN ACK)
BATCH 1
  ↓ (await BATCH 1 ACK)
BATCH 2
  ↓ (await BATCH 2 ACK)
...
FINAL BATCH
  ↓ (await FINAL BATCH ACK)
FINALIZE
  ↓ (await FINALIZE ACK)
CLEANUP
```
No subsequent message is transmitted across the bridge until the preceding request receives an authoritative ACK from the Background Service Worker confirming IndexedDB transactional commit (`tx.oncomplete`).

### 2. Elimination of Synthetic Placeholder Streams
- The repository strictly rejects `persistBatch` and `finalizeStream` calls for unopened stream keys with typed error `stream_not_open`.
- Content script `RawJournalBuffer` strictly rejects chunks for un-opened or non-generation streams, never fabricating ghost buffer states.
- Duplicate opens with conflicting URLs or transports are rejected with `stream_identity_conflict`.

### 3. Payload-Aware Idempotency & Conflict Detection
- When receiving a batch with an existing `batch.id`, the repository compares the exact sequence, character count, chunk count, timestamps, and chunk texts.
- **Identical Payload:** Treated as an idempotent re-delivery; returns existing `persistedAt` timestamp without re-writing or inflating stream counters.
- **Conflicting Payload:** Rejects immediately with `batch_id_conflict`, preserves existing committed data untouched, and persists `state: 'degraded'` and `durabilityGap: true` on the parent stream record.

### 4. Finalization Barrier & Graceful Degradation
- When a terminal transport event (`complete`, `abort`, `error`) occurs, the content script seals remaining buffered chunks into a final batch.
- The buffer waits for all earlier in-flight and queued batches to achieve ACK before dispatching `STREAMARCHIVE_FINALIZE_RAW_STREAM`.
- Only upon receiving authoritative `FINALIZE ACK` is the stream buffer evicted from content memory.
- Added `pagehide` and `visibilitychange` listeners for best-effort buffer flushes prior to tab closure.

### 5. Hard Memory Ceilings, DoS Bounds & Durability Accounting
- Implemented `maxActiveKnownStreams = 16` to guard against request-storm denial of service.
- When `totalPendingChars` (queued batches + current buffer) reaches `maxPendingChars = 524,288` (512 KiB), the buffer transitions to `state: 'degraded'`, marks `durabilityGap: true`, ceases buffering, and tracks `droppedChars`.
- `droppedChars` and `durabilityGap` are propagated through finalization into `RawStreamRecord` for full persistence honesty.

### 6. Scheduler Abstraction
- Introduced a `Scheduler` interface (`setTimeout`, `clearTimeout`) to decouple timer logic from unmanaged window globals, enabling predictable retry backoff testing (`250ms`, `1s`, `4s`, `10s`, then `30s` slow retry) and deterministic cleanup.

### 7. Strict Transaction Durability & Scalable Metadata
- Exported `createRawWriteTransaction(db, stores, 'strict')` using standard `IDBTransactionOptions` with fallback.
- Optimized `listStreams(limit)` using cursor traversal over the `openedAt` index in descending order (`'prev'`), eliminating in-memory sorting of all records.
- Optimized `getJournalMetadata()` to aggregate statistics exclusively from `raw_streams` records without touching `raw_stream_batches`, adding `navigator.storage.estimate()` and `navigator.storage.persisted()` telemetry.

### 8. Authoritative Replay Semantics & Integrity Evaluation
- Removed `quasi_status === 'FINISHED'` and non-standard statuses from `isComplete` evaluation in `replayRawBatches`.
- Introduced `ReplayTransportContext` to ensure aborts and errors emit appropriate `stream_interrupted` semantic events.
- Added `ReplayIntegrity` analysis (`complete`, `degraded`, `corrupt`) based on stream key consistency, batch continuity, and transport status.

### 9. Side Panel Honesty Display
- Updated UI to reflect "Captured ≠ Pending ≠ Durable", displaying committed text versus pending gaps, dropped character warnings, and storage persistence status.

---

## Consequences

- **True Append-Only Durability:** Raw response streams are guaranteed crash-durable, append-only, and idempotent.
- **No Poisoned Data:** Conflicting batch payloads and orphan events cannot corrupt the local archive.
- **Safe Promotion Foundation:** Canonical entity mapping (Conversations, Messages, Revisions) can now be performed with total confidence against durable raw stream batches.
