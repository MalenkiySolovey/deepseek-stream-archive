# ADR 0012: Durable Raw Journal & ACK Persistence Before Semantic Decoding

## Status
Accepted

## Context
In the transport and protocol layers, we constructed passive network transport interception (Fetch & XHR) and a robust protocol decoding engine for DeepSeek SSE streams.

However, in Chrome Manifest V3 (MV3), Background Service Workers are ephemeral and can be terminated at any moment. Furthermore, client tabs may crash, network connections can be severed, or DeepSeek may suddenly recall/censor an answer mid-generation. Most critically:
1. **Decoupling from Protocol Parser Risk:** If raw stream persistence only occurred after protocol parsing into high-level entities (`Conversation`, `Message`, `ResponseRevision`), any protocol decoder bug, unhandled patch variant, or future upstream DeepSeek API change would risk dropping the user's data before it reaches the disk.
2. **Ephemerality of In-Flight Tokens:** Tokens streamed over the wire represent the absolute ground truth of what the browser received. They must be saved locally *during* streaming generation, rather than waiting for response completion.
3. **True Durability:** An acknowledgment (ACK) sent back to the content script must represent an authoritative commit to disk (`tx.oncomplete` in IndexedDB), not merely an in-memory queue push.
4. **Strict Scope Discipline:** Creating canonical `Conversation`, `Message`, `ResponseRevision`, and `RecoveryEvent` entities from real streams must be handled by downstream canonical layers to ensure the storage and buffer pipeline is independently validated and hardened first.
5. **Privacy Boundaries:** Raw response chunks must be preserved, but request bodies, user prompts, Authorization headers, cookies, query strings, and hash anchors must never be captured or stored.

---

## Decision

We instituted the following architectural decisions:

### 1. Database Schema Upgrade to Version 2
- Upgraded `StreamArchiveDB` to `DB_VERSION = 2`.
- Preserved all Version 1 object stores (`conversations`, `messages`, `revisions`, `recovery_events`) without wiping data.
- Added two new dedicated stores:
  - `raw_streams`: Tracks stream-level metadata (`id`, `transport`, `url`, `provisionalSessionId`, `state`, `openedAt`, `updatedAt`, `totalChunks`, `totalChars`, `totalBatches`).
  - `raw_stream_batches`: Stores individual batches of chunks with a deterministic composite key (`<streamKey>:<batchSeq>`) and indexes on `streamKey`, `createdAt`, `batchSeq`.

### 2. Multi-Factory IndexedDB Cache & Clean Connection Lifecycle
- Replaced the global singleton database variable in `src/storage/db.ts` with a `WeakMap<IDBFactory, IDBDatabase>` cache and tracked active database set.
- Connected `db.onversionchange` handlers to automatically close connections upon database upgrades to eliminate connection blocking.

### 3. Content-Side Buffering (`RawJournalBuffer`)
- Intercepts raw text chunk events from transport capture *before* SSE framing and protocol decoding.
- Flushes batches on three distinct triggers:
  1. **Size Threshold:** When accumulated batch characters reach 32 KiB (`32,768` chars).
  2. **Timer Threshold:** 500ms debounce since the oldest unbuffered chunk.
  3. **Terminal Threshold:** Immediate flush when transport terminal events (`complete`, `abort`, `error`) arrive.
- Assigns monotonic `batchSeq` numbers (1, 2, 3...) per stream.
- Maintains un-ACKed batches in memory with exponential retry backoff (`250ms`, `1,000ms`, `4,000ms`, `10,000ms`).
- Degrades stream state if un-ACKed pending characters exceed memory ceiling (`524,288` chars = 512 KiB).

### 4. Background Service Worker as Sole IndexedDB Writer
- Content script communicates via typed extension messages (`PERSIST_RAW_STREAM_OPEN`, `PERSIST_RAW_BATCH`, `FINALIZE_RAW_STREAM`, `GET_RAW_JOURNAL_STATUS`).
- On `PERSIST_RAW_BATCH`, the Background worker executes an atomic readwrite transaction across `raw_streams` and `raw_stream_batches`.
- **Strict Durability Guarantee:** Returns ACK `{ success: true, batchSeq, persistedAt }` ONLY upon `tx.oncomplete`.
- **Idempotency Guarantee:** Duplicate deliveries of the same `batch.id` are committed idempotently without inflating parent stream counters (`totalBatches`, `totalChunks`, `totalChars`).

### 5. Pure Deterministic Replay Engine (`replayRawBatches`)
- Implemented a pure, side-effect-free replay function that takes an array of persisted raw batches, sorts chunks by `streamSequence`, validates sequence continuity, and feeds them through `GenericSseDecoder` and `DeepSeekProtocolDecoder`.
- Allows re-extracting complete projected answers, thinking traces, diagnostics, and censorship filter triggers at any time without network access.

### 6. Strict Privacy & Security Boundaries
- Sanitizes URLs to `origin + pathname` only, discarding query parameters (`?token=...`) and hash anchors (`#anchor`).
- Persists response stream text only; zero ingestion of user prompts, request bodies, or auth headers.
- Permissions remain strictly `["storage", "sidePanel"]`; `unlimitedStorage` is deliberately omitted.

---

## Consequences

- **Resilience:** Unfinished, cancelled, or aborted responses remain archived locally on disk in full detail up to the moment of interruption.
- **Protocol Agility:** Changes to DeepSeek's SSE payload formats do not cause data loss because the raw transport text is durably stored before decoding.
- **Auditable Durability:** The ACK pipeline provides cryptographic-level confidence that chunks are safely committed to disk before content scripts release in-memory buffers.
- **Clear Architectural Separation:** With the raw journal fully functional and tested, the canonical recorder focuses purely on canonical entity promotion (`ResponseRevision`, `RecoveryEvent`) from durable raw journal records.
