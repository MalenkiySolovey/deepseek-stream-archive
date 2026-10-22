# ADR 0014: Raw Evidence Integrity, Monotonic Ordering, and Replay Truth Gate

## Status
Accepted

## Context
During storage auditing, an architectural review of the storage and evidence replay pipeline identified several critical risks preventing the system from serving as an audit-proof, forensic foundation for the canonical revision recorder:

1. **ACK Identity Verification:** Content script buffers received generic `{ success: true }` ACKs without validating that the returned `streamKey`, `batchSeq`, or `finalState` corresponded to the active in-flight request, allowing potential crosstalk or misrouted ACKs across concurrent streams.
2. **Replay Truth vs. Synthetic Sorting:** Replay logic previously applied synthetic chunk sorting (`allChunks.sort((a,b) => a.streamSequence - b.streamSequence)`), masking storage-level non-monotonicity, chunk sequence gaps, duplicate sequence numbers, and interleaved writes. This created an illusion of clean streams during replay while hiding underlying data anomalies.
3. **Repository Sequence Enforcement:** The repository lacked strict validation requiring batches to start at `batchSeq: 1` and proceed strictly monotonically (`(lastPersistedBatchSeq || 0) + 1`), permitting out-of-order commits or undetectable batch skips.
4. **Finalize Idempotency & Metadata Conflict:** Repeated `finalizeStream` requests could re-accumulate `droppedChars` deltas rather than treating values as absolute, and conflicting finalize requests (e.g. differing terminal states, total characters, or event counts) were not formally audited or rejected.
5. **Host Anti-Spoofing & Transport Bounds:** URL candidate predicates evaluated relative paths without strictly enforcing origin boundaries (`chat.deepseek.com`), creating theoretical spoofing surface. Furthermore, stream identity fields permitted colon `:` delimiters, which risked collision with the composite `producerSessionId:streamId` key format.
6. **Pre-Append Memory Ceiling:** Memory ceiling checks evaluated current buffer size rather than including incoming chunk size, permitting single oversized chunks to breach buffer limits.

---

## Decision

To establish an immutable, verifiable, and forensic evidence log before promotion, we adopted the following architectural controls:

### 1. Strict ACK Identity Verification
- All ACK responses across the extension bridge must carry the exact `streamKey`, and where applicable, `batchSeq`, `finalState`, or `finalizedAt`.
- The content script `RawJournalBuffer` validates all incoming ACKs against in-flight request identity. Any mismatched or malformed ACK is rejected with warning logs, the in-flight state is preserved, and retry backoff is scheduled.
- Streams awaiting `FINALIZE ACK` remain active in the buffer to prevent premature eviction during capacity pressure.

### 2. Strict Monotonic Sequence & Batch Continuity
- `RawStreamRepository.persistBatch()` enforces that the first batch of any stream must have `batchSeq === 1`.
- Subsequent batches must strictly satisfy `batchSeq === (lastPersistedBatchSeq || 0) + 1`. Any out-of-order batch is rejected with `batch_sequence_gap`, and the stream is transitioned to `integrity: 'degraded'`.
- Chunks within batches are validated for sequence gaps (`streamSequence === expectedSequence`). In accordance with forensic preservation principles, out-of-order chunks are still committed to IndexedDB to preserve raw observed evidence, while the stream is permanently flagged with `integrity: 'gap_detected'` and `state: 'degraded'`.

### 3. Replay Truth & Forensic Audit Diagnostics
- Synthetic chunk sorting is eliminated from replay operations. Chunks are replayed in their natural persisted storage order.
- Replay generates a structured `ReplayAuditReport` detailing:
  - `duplicateBatchSeq`: List of duplicate batch sequence numbers.
  - `duplicateStreamSequence`: List of duplicate chunk stream sequences.
  - `batchGap`: Details on missing or skipped batch sequences.
  - `chunkGap`: Details on missing or non-contiguous chunk sequences.
  - `foreignStreamKey`: Any batch associated with a mismatched stream key.
  - `missingPrefix`: Detection of streams that did not begin with batch #1.
  - `invalidDeterministicId`: Any batch ID failing deterministic hash calculation.
- `replayRawStream` accepts a `RawStreamRecord` directly, eliminating fragile composite string splits.

### 4. Idempotent Finalization with Conflict Rejection
- `finalizeStream` treats `droppedChars` as an absolute terminal value rather than an incremental delta.
- Multiple identical finalizations return the original `finalizedAt` timestamp without mutating metadata.
- If a subsequent finalize request contains conflicting metadata (different `finalState`, divergent total counts, or non-matching reasons), it is rejected with `finalize_conflict`, preserving existing durable evidence unaltered.

### 5. Origin Anti-Spoofing and Bridge Bounds
- Candidate endpoint detection enforces strict origin validation (`chat.deepseek.com`) and rejects non-standard protocols, ports, or rogue hostnames.
- Bridge validation strictly forbids `:` in `producerSessionId` and `streamId` (`invalid_stream_identity`) to preserve deterministic composite key partitioning (`${producerSessionId}:${streamId}`).
- String lengths are hard-capped (`MAX_ID_CHARS = 128`, `MAX_URL_CHARS = 1024`, `MAX_REASON_CHARS = 256`, `MAX_METHOD_CHARS = 16`).

### 6. Pre-Append Memory Ceiling
- `RawJournalBuffer` evaluates memory constraints *before* appending incoming chunks:
  `pendingChars + currentBatchChars + incomingChunk.length > maxPendingChars`
- Oversized chunks are dropped immediately, marking `durabilityGap: true`, updating `droppedChars`, and degrading stream integrity.

### 7. Storage Persistence & Durability Assurance
- Best-effort `navigator.storage.persist()` is invoked from the content script and exposed via an interactive button in the SidePanel UI.
- Direct UI indicators display storage quota, persistence grant status, and stream integrity health.

---

## Consequences

### Positive
- **Forensic Fidelity:** Persisted data accurately mirrors observed wire events without synthetic massaging.
- **Auditability:** Any corruption, gap, or out-of-order event is explicitly preserved and surfaced in audit reports rather than concealed.
- **Robust Multi-Stream Isolation:** Strict ACK and streamKey validation eliminates cross-stream race conditions.
- **Safety Gate Met:** The Raw Journal is now proven robust and crash-durable, establishing durable raw storage.

### Negative / Trade-offs
- Forensic preservation of sequence gaps means downstream replay consumers must handle non-contiguous sequences; this is explicitly exposed via `ReplayAuditReport`.
- Rejected out-of-order batches require upstream producers to resend sequentially.
