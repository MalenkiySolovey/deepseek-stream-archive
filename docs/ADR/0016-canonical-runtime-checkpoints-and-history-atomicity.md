# ADR 0016: Canonical Runtime Checkpoints, Bounded History Transport, and Atomic Reconciliation

## Status
Accepted

## Context
Initial implementations introduced unit-level components of `CanonicalRecorder`, `DeepSeekHistoryParser`, `HistoryReconciler`, and `ReplayRebuilder`. However, integrating these components into a live, production-grade Chrome MV3 extension revealed several critical runtime challenges:

1. **Content Script State Authority vs. Service Worker Ephemerality:**
   In Chrome MV3, the background service worker can terminate after 30 seconds of inactivity. Streaming generation in DeepSeek often lasts several minutes. If stream state accumulation or debouncing lived in the service worker, termination would drop streaming tokens. Therefore, the content script must serve as the state accumulation authority during live generation, emitting atomic checkpoints to IndexedDB via the background worker.

2. **MAIN to ISOLATED World Boundary Limits:**
   Large history responses from `/api/v0/chat/history_messages` can exceed hundreds of kilobytes or even megabytes for extensive chat sessions. Transferring unbounded payloads across `window.postMessage` in a single message risks browser stuttering, memory spikes, or serialization failures.

3. **Remote ID Shape Discrepancies:**
   DeepSeek APIs alternate between numeric IDs (`1001`) and string IDs (`"1001"`), and chat session wrappers may occasionally omit the `chat_session` object in `/history_messages`. Mismatches in ID types cause missed joins and duplicate messages.

4. **Concurrency & Atomicity across the Three Truths:**
   Rapid user navigation or concurrent history observations could trigger race conditions. If history reconciliation wrote records across multiple independent transactions, an interrupted write would leave orphaned messages or broken tree links. Furthermore, repeated reconciliation must be strictly idempotent without overwriting live uncensored `isLastGood = true` revisions.

---

## Decision

We resolved these architectural requirements through the following designs:

### 1. Canonical Stream Coordinator (`CanonicalStreamCoordinator`)
- **Location:** Runs in the content script under `ActiveStreamSession`.
- **Monotonic Sequencing:** Every checkpoint carries a strictly monotonic `checkpointSeq` (0, 1, 2...).
- **Dual Flush Mechanics:**
  - *Debounced flushes:* Regular token deltas (`thinking_delta`, `answer_delta`) are debounced (500ms default) to avoid saturating storage transactions.
  - *Immediate flushes:* Critical semantic boundaries trigger an immediate, un-debounced flush:
    - Authoritative message ID discovered (`message_id_identified`).
    - Content filter triggered (`filter_triggered`) to lock `isLastGood = true` immediately.
    - Terminal protocol and transport events (`stream_finished`, `stream_transport_ended`, `stream_interrupted`, `stream_error`).
- **In-Flight Chaining & ACK Verification:** Ensures only one checkpoint is in-flight at any time; subsequent flushes are chained. Background ACKs are verified for `streamKey` and `checkpointSeq` match.

### 2. Bounded Chunked History Transport across Main-World Boundary
- **Interceptor Chunks:** The MAIN world network interceptor splits observed history JSON bodies into chunks of $\le 64\text{ KB}$ (`MAX_HIST_CHUNK_SIZE = 65536`).
- **Chunk Envelopes:** Dispatches sequential events (`history.open`, `history.chunk`, `history.complete`, `history.abort`) with monotonic chunk indices.
- **Resource Limits:** Enforces hard bounds: maximum total payload size of 25MB and maximum 1000 chunks. Payloads violating bounds are safely dropped without throwing.
- **Content-Side Reassembly & Pre-validation:** Reassembled payloads in `content.ts` are validated against schema and parsed by `DeepSeekHistoryParser` before forwarding to the background worker.

### 3. Remote ID Normalization & Dual Shape Handling
- **Normalization:** `normalizeRemoteId` converts numeric IDs (`1001`) and trimmed strings ($\le 128$ chars) into canonical string keys. NaNs, objects, and empty strings are rejected.
- **Dual Shape Separation:** `RESPONSE` fragments populate assistant text, while `THINK` fragments populate reasoning text. `REQUEST` fragments are never mixed into assistant responses.
- **Fallback Session ID:** When `chat_session` is omitted from the JSON payload, the parser extracts the session ID from allowlisted URL query parameters (`chat_session_id`).

### 4. Atomic Storage Operations (Schema v4)
- **Schema Upgrade (`DB_VERSION = 4`):** Added the `identityState` index on `STORE_MESSAGES` to allow indexed querying of provisional vs. reconciled messages.
- **Atomic Checkpoint Commit:** `storageRepo.saveCanonicalCheckpoint(checkpoint)` writes `Conversation`, `Message`, `ResponseRevision[]`, and `RecoveryEvent[]` within a single strict transaction.
- **Atomic History Commit:** `HistoryReconciler` constructs a complete `HistoryReconciliationPlan` in memory and executes it via `storageRepo.applyHistoryReconciliationPlan(plan)` in a single transaction.
- **Summary Optimization:** `getArchiveSummary` utilizes IndexedDB cursor scanning and `.count()` queries rather than loading large string content into memory.

### 5. Content Fingerprinting & Tree Cycle Protection
- **Content Fingerprint:** Revisions compute deterministic `contentFingerprint` strings (`fp_<length>_<hash>`). Identical history re-ingestion detects matching fingerprints and creates 0 duplicate revisions. Updated server content creates an appended revision with `source: 'history'`.
- **Tree Linkage & Cycle Prevention:** Two-pass resolution connects `remoteParentId` to local `parentId`. Ancestor path traversal detects and breaks potential cyclic references, preserving valid tree graphs.
- **Replay Rebuilder Merge Policy:** Follows `reconciled > provisional`. Messages already reconciled by server history retain their reconciled state, parent links, and content during raw journal rebuilts.

---

## Consequences

- **Guaranteed Convergence:** Raw Journal Evidence, Live Canonical Record, and Server History converge in IndexedDB without data degradation or retro-censorship loss.
- **High Durability:** In-progress streaming text is saved in durable IndexedDB checkpoints even during active generation, surviving abrupt tab closes.
- **Zero Privacy Leakage:** Permissions remain strictly `["storage", "sidePanel"]`. No bearer tokens or private keys are ever read or transmitted.
- **Performance:** Low CPU overhead with debounced checkpoints, bounded 64KB message passing, and streaming cursor operations.
