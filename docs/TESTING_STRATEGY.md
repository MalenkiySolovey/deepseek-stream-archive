# Testing Strategy & Regression Corpus

> **DeepSeek StreamArchive**  
> Status: Quality Assurance & Testing Architecture  
> Date: 2026-10-06  

A browser extension that records live, undocumented third-party web streams will fail quickly unless backed by an exhaustive, automated testing strategy. This document defines the five testing tiers of StreamArchive.

---

## 1. The Core Regression Principle

> **Every DeepSeek protocol update that breaks parsing MUST produce:**
> 1. A new sanitized test fixture (`tests/fixtures/deepseek/...`).
> 2. A new automated Vitest regression test.
> 3. An updated compatibility profile or decoder version.
>
> **Never fix a compatibility issue by adding a random un-tested `if` check.** Old regression fixtures are permanent and must never be deleted.

---

## 2. Testing Tiers Overview

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. Generic SSE Chunk-Boundary Fuzz Tests (Unit)            │
│    - Byte slicing, UTF-8 boundaries, multi-event frames     │
├─────────────────────────────────────────────────────────────┤
│ 2. DeepSeek Protocol Fixture Tests (Unit)                  │
│    - Normal, Thinking, Filtered, Regenerate, Edit, Continue │
├─────────────────────────────────────────────────────────────┤
│ 3. Identity Resolution & Reconciliation Tests (Integration)│
│    - Virtualized DOM tail matching, duplicate deduplication │
├─────────────────────────────────────────────────────────────┤
│ 4. Persistence & Service Worker Resilience Tests (Unit)    │
│    - fake-indexeddb, ACK timeouts, worker restart recovery │
├─────────────────────────────────────────────────────────────┤
│ 5. End-to-End Browser Tests (Playwright)                   │
│    - Injection, side panel mounting, overlay card rendering │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Tier 1: Generic SSE Chunk-Boundary Tests

The streaming transport cannot assume that a single `read()` call on a network stream corresponds to exactly one SSE event or line. Chunks may arrive fragmented across any arbitrary byte offset.

### Test Specification: Deterministic Boundary Slicing
Given a canonical reference SSE stream (e.g., 50 lines of JSON events):
1. Feed the stream to `IncrementalSseDecoder` as a single chunk.
2. Feed the exact same stream sliced into:
   - **1-byte chunks** (every character fed individually).
   - **2-byte chunks**.
   - **5-byte chunks**.
   - **Multi-event chunks** (10 lines in one push).
   - **Split mid-UTF-8 character** (e.g. slicing a 3-byte Chinese character or 4-byte emoji between byte 1 and byte 2).
   - **Random deterministic seeds** (deterministic PRNG slicing at arbitrary boundaries: 7, 23, 119 bytes).
3. **Assertion:** Every single permutation MUST emit the exact same sequence of decoded `ServerSentEvent` objects.

---

## 4. Tier 2: DeepSeek Protocol Fixture Corpus

Fixtures reside in `tests/fixtures/deepseek/` as `.jsonl` or `.json` files recorded from live sessions with private prompts sanitized.

### Required Fixture Categories

| Category | File | Tested Behavior |
|---|---|---|
| **Normal Answer** | `normal-generation.jsonl` | Sequential tokens, patch ops (`APPEND`, `SET`), status `FINISHED`. |
| **DeepThink Reasoning** | `thinking-generation.jsonl` | Separate `type: 'THINK'` fragments; transitions from thinking to answer. |
| **Content Censored** | `content-filter.jsonl` | Output starts streaming useful text, then receives `status: 'CONTENT_FILTER'`; verifies extraction of last-good revision. |
| **Template Replacement** | `template-response.jsonl` | Fragment contains `type: 'TEMPLATE_RESPONSE'`; verifies retraction trigger. |
| **Regenerated Turn** | `regenerate.jsonl` | Same `parent_id`, higher `message_id`; verifies revision indexing. |
| **Edited Prompt** | `edit-prompt.jsonl` | New prompt branching from earlier tree node. |
| **Continue Generating** | `continue-stream.jsonl` | Second stream appends to existing assistant message without resetting turn. |
| **A/B Dual Shape (2026-06)** | `shape-fragments.json` | Text located inside `fragments[].content`. |
| **A/B Dual Shape (2026-08)** | `shape-toplevel.json` | Text located in top-level `content` & `thinking_content`. |
| **Negative Fragment Index** | `negative-index-1.jsonl` | Patch path contains `fragments/-1/content`. |
| **Batch Operation** | `batch-patches.jsonl` | `o: "BATCH"` containing an array of sub-patches. |

### Implemented Test Suites

- `tests/deepseek-patch-applier.test.ts`: SET, APPEND, REPLACE, BATCH recursion, inherited `p`/`o`, negative index `-1`, pathless string append `{"v": "..."}`, auto-growth, prototype pollution immunity (`__proto__`, `prototype`, `constructor`), and path depth bounds.
- `tests/deepseek-message-id.test.ts`: Nested message ID discovery (`message_id`, `msg_id`, `response_message_id`), depth limit <= 5, rejection of generic `id` / `chat_session_id`, scalar value conversion, and "later ID wins" resolution.
- `tests/deepseek-fragment-projector.test.ts`: Fragment classification (`RESPONSE` vs `THINK`/`THINKING` vs `TIP` vs `TEMPLATE_RESPONSE`), semantic diffing (`delta` vs `replace`).
- `tests/deepseek-filter-detection.test.ts`: Detect-before-apply guard verifying `lastGood` freezes pre-mutation state on `CONTENT_FILTER` and `TEMPLATE_RESPONSE`.
- `tests/deepseek-session-id.test.ts`: URL route parsing for modern `/a/chat/s/<uuid>` and legacy `/chat/s/<uuid>`.
- `tests/deepseek-protocol-decoder.test.ts`: End-to-end SSE parsing &rarr; protocol decoding &rarr; semantic events (`stream_start`, `message_id_identified`, `answer_delta`, `thinking_delta`, `stream_finished`).
- `tests/deepseek-reference-fixtures.test.ts`: Replays sanitized reference fixtures (`normal-completion.sse.txt`, `reasoning-completion.sse.txt`, `censored-completion.sse.txt`).
- `tests/deepseek-reverse-isolation.test.ts`: Verifies zero dependencies on storage, UI, or DOM in the DeepSeek protocol adapter layer.

---

## 5. Tier 3: Identity & Reconciliation Tests

Tests the `Reconciler` and `IdentityResolver` against complex edge cases discovered in upstream research:

1. **Virtualized DOM Rerender:**
   - 20 turns exist in history.
   - DOM only renders Turns 16 through 20.
   - User scrolls up, unmounting Turns 18–20.
   - Verify: Reconciler never creates duplicate turns or unlinks messages.
2. **Identical Prompt Repeated:**
   - User asks "Hello" twice in the same chat session.
   - Answers have identical character length.
   - Verify: Reconciler associates each answer strictly by chronological `message_id` and `parent_id`, never confusing the two turns.
3. **Missing Remote IDs:**
   - Live stream starts before DeepSeek emits `message_id`.
   - Verify: Reconciler assigns a local stable UUID, and seamlessly merges the remote ID once history data arrives.
4. **Multi-Source De-duplication:**
   - Same turn observed via real-time network stream, then read via `/history_messages`, then parsed via DOM fallback.
   - Verify: Result is a single canonical `Message` entity with merged metadata, not three duplicate records.

---

## 6. Tier 4: Persistence, Raw Journal & Storage Tests

Tested using `fake-indexeddb` and Vitest fake timers:

1. **Schema Migration v1 &rarr; v2 (`tests/database-migration.test.ts`):**
   - Populates database at Schema v1 (`conversations`, `messages`, `revisions`, `recovery_events`).
   - Upgrades database to Schema v2 (`raw_streams`, `raw_stream_batches`).
   - Asserts 100% preservation of all existing v1 records and verifies all v2 stores and indexes.
   - Tests multi-factory isolation and `db.onversionchange` close handlers.

2. **Durable Raw Repository Persistence (`tests/raw-journal-repository.test.ts`):**
   - Atomicity and `tx.oncomplete` durability guarantee across `raw_streams` and `raw_stream_batches`.
   - Batch idempotency: Re-submitting the same batch ID updates the batch record without double-counting stream counters.
   - Abort rollback: Aborting transactions ensures zero records are committed.
   - Background worker cold restart: Persisting data, closing connections, re-opening with a fresh repository instance, and validating data integrity.

3. **Content Script Buffering & ACK Retries (`tests/raw-journal-buffer.test.ts`):**
   - Threshold-driven batch flushes: size threshold (32 KiB) and timer threshold (500ms debounce).
   - Immediate flush on terminal events (`complete`, `abort`, `error`).
   - Un-ACKed batch retention in memory and exponential retry backoff on failure.
   - Memory ceiling guard: Degrades stream state if un-ACKed pending characters exceed 512 KiB.
   - URL sanitization: Verification that query params and hash anchors are stripped on stream open.

4. **Pure Deterministic Replay Engine (`tests/raw-stream-replay.test.ts`):**
   - Replays raw journal batches across normal, thinking (`<think>` / `thinking_content`), censorship/filter (`CONTENT_FILTER` / `TEMPLATE_RESPONSE`), and fragmented SSE chunks.
   - Verifies projected answer, thinking trace, sequence gap detection, and censorship interception.

5. **Raw Journal Integrity & Crash-Durability Gate (`tests/raw-journal-ordering-and-ack.test.ts`):**
   - **Monotonic Ordered Pipeline:** Guarantees `OPEN ACK -> BATCH 1 ACK -> BATCH 2 ACK -> ... -> FINAL BATCH ACK -> FINALIZE ACK`.
   - **Zero Synthetic Streams:** Rejects orphan batches and finalizations with `stream_not_open`. Rejects duplicate opens with conflicting URLs or transports with `stream_identity_conflict`.
   - **Payload-Aware Idempotency:** Verifies exact payload comparison on duplicate batch IDs; conflicting payloads reject with `batch_id_conflict` without overwriting data.
   - **Memory Ceiling & Dropped Chunks:** Verifies that when pending characters reach 512 KiB, chunks are dropped with exact `droppedChars` tracking and `durabilityGap` flags.
   - **Replay Completion & Integrity Gate:** Proves `quasi_status: "FINISHED"` does not mark streams complete; respects `ReplayTransportContext` and flags `integrity: 'complete' | 'degraded' | 'corrupt'`.
   - **Scalable Queries:** Verifies cursor-based stream listing and lightweight metadata aggregation without reading batch payloads.


---

## 7. Tier 5: Playwright End-to-End Tests

Automated headless Chromium tests:
1. **Extension Loading:** Extension boots in Chromium with MV3 manifest.
2. **Interception Injection:** Interceptor loads into `chat.deepseek.com` MAIN world before page scripts run.
3. **Bridge Communication:** Test page emits synthetic fetch response; verifies isolated content script receives validated event.
4. **Side Panel:** Side Panel loads successfully, opens on extension action click, and queries IndexedDB.

---

## 8. Tier 6: Protocol Hardening & Acceptance Gate Test Suites

StreamArchive includes four dedicated automated verification suites targeting protocol determinism, sequencing, and terminal semantics:

1. **Stream Sequence & Lifecycle Integrity (`tests/stream-sequence-integrity.test.ts`):**
   - Verifies monotonic sequence validation (`streamSequence: 0 -> 1 -> 2 -> ...`).
   - Verifies orphan chunk rejection (no decoder instantiated for unannounced chunks).
   - Verifies duplicate `open` detection and session degradation.
   - Verifies rejection and warning recording for events fed after terminal state.

2. **Terminal Semantics Disambiguation (`tests/deepseek-terminal-semantics.test.ts`):**
   - Verifies protocol completion via `[DONE]` or `status: "FINISHED"` emits `stream_finished`.
   - Verifies normal transport closure without protocol sentinel emits `stream_transport_ended`.
   - Verifies user cancellation (Stop button) emits `stream_interrupted` with `reason: 'transport_abort'` and **strictly never** triggers `filter_triggered`.
   - Verifies network errors emit `stream_interrupted` with error detail.
   - Verifies censorship followed by `FINISHED` preserves `lastGood` state.

3. **Diagnostics Aggregation & Double-Counting Immunity (`tests/deepseek-diagnostics-aggregation.test.ts`):**
   - Verifies that multiple batches for the same stream do not cumulatively inflate frame or operation counts.
   - Verifies that distinct concurrent streams are aggregated additively at query time.
   - Verifies that any sequence gap in an active stream marks aggregate compatibility as `degraded`.

4. **Dual Shape State Projection (`tests/deepseek-dual-shape.test.ts`):**
   - Verifies Variant A (`fragments[]`) projection and tags `projectionSource: 'fragments'`.
   - Verifies Variant B (`response.content` / `thinking_content`) projection and tags `projectionSource: 'top_level'`.
   - Verifies priority resolution (fragments win if both are present).
   - Verifies diff calculation never emits duplicate text tokens.

---

## 9. Tier 7: Current Protocol Reconciliation & Live Runtime Gate Test Suites

StreamArchive includes five dedicated test suites validating upstream live compatibility, strict bounds, and runtime gate determinism:

1. **Candidate Predicate & Transport Integration (`tests/deepseek-candidate-predicate.test.ts`):**
   - Verifies `createDeepSeekCandidatePredicate()` captures generation endpoints regardless of Content-Type (`application/octet-stream`, `text/event-stream`, or omitted).
   - Verifies end-to-end integration with both `installFetchCapture` and `installXhrCapture`.

2. **Endpoint Matching Bounds & Normalization (`tests/endpoint-matching-bounds.test.ts`):**
   - Verifies `normalizePathname()` collapses redundant slashes, strips query parameters, and trims trailing slashes.
   - Verifies exact matching rejects suffix/substring spoofing (e.g. `/completion_fake`, `/completion/nested`).

3. **Unclassified SSE Streams & Terminated Tombstones (`tests/unclassified-sse-and-tombstones.test.ts`):**
   - Verifies unclassified SSE endpoints are tracked without incrementing `orphanEventsCount`.
   - Verifies terminated streams retain tombstones in a bounded 128-item FIFO ring buffer so late chunks are counted as post-terminal violations rather than orphans.

4. **Live Runtime Observed Acceptance Gate (`tests/deepseek-live-observed-gate.test.ts`):**
   - Verifies decoder starts at `not_observed`.
   - Verifies multi-factor gate: promotion to `live_observed` requires valid endpoint, valid frame, valid patch, and content projection (or terminal status).
   - Verifies sequence gaps and threatening warnings permanently transition stream to `degraded`.

5. **DeepSeek Status Vocabulary & Lifecycle Model (`tests/deepseek-status-model.test.ts`):**
   - Verifies full status matrix: `FINISHED`, `CONTENT_FILTER`, `CONTEXT_LENGTH_EXCEEDED`, `INCOMPLETE`, `TIMEOUT`.
   - Verifies non-terminal behavior of `WIP` and `AUTO_CONTINUE`.
   - Verifies metadata flags: `has_pending_fragment`, `incomplete_message`, and `quasi_status`.

---

## 10. Tier 8: SSE Control Events & Final Protocol Gate Test Suites

StreamArchive includes four dedicated test suites bringing the automated regression corpus to **192 tests across 32 test files**:

1. **SSE Control Events & Status Authority (`tests/deepseek-sse-control-events.test.ts`):**
   - Verifies `ready` event extracts message ID safely and bypasses patch parsing.
   - Verifies `update_session` and `title` events do not mutate answer or thinking projections.
   - Verifies `quasi_status = FINISHED` does NOT close decoder or emit premature `stream_finished`.
   - **Anti-Recall Regression:** Verifies that early `quasi_status = FINISHED` followed by late destructive censorship BATCH (`status = CONTENT_FILTER` + `TEMPLATE_RESPONSE`) is intercepted, freezing unredacted `lastGoodState` prior to patch mutation, and concluding with `terminalReason: 'filtered'`.
   - Verifies authoritative `status = FINISHED` completes cleanly.
   - Verifies legal trailing control events (`finish`, `close`, `update_session`, `title`) do NOT increment `eventsAfterTerminalCount`.
   - Verifies unknown SSE event names are recorded diagnostically (`unknown_sse_event_name`) without crashing.
   - Verifies reference-derived realistic normal and filtered synthetic test fixtures.

2. **Patch Applier Bounds & Operation Validation (`tests/patch-applier-bounds-and-ops.test.ts`):**
   - Verifies strict atomic rejection of oversized BATCH operations (> 128 items).
   - Verifies atomic rejection of array APPEND operations exceeding capacity (`MAX_ARRAY_INDEX = 1000`) without partial truncation.
   - Verifies atomic rejection of snapshot fragments exceeding `MAX_ARRAY_INDEX` without partial slicing.
   - Verifies rejection of unknown operations and explicit pathless non-APPEND (`SET`, `REPLACE`).

3. **Native XHR Overload & Argument Integrity (`tests/xhr-native-overload.test.ts`):**
   - Verifies `Reflect.apply` preservation of all arguments for `XMLHttpRequest.prototype.open` (method, url, async, user, password) and `send(body)`.
   - Verifies single-installation sentinel (`XHR_HOOK_INSTALLED`) prevents double wrapping.

4. **Interceptor Double-Patch Protection (`tests/interceptor-double-patch.test.ts`):**
   - Verifies versioned sentinel `Symbol.for('__STREAMARCHIVE_MAIN_HOOK__')` and `window.__STREAMARCHIVE_HOOK_VERSION__` safely ignore redundant injection attempts.

---

## 11. Tier 9: Durable Raw Journal & ACK Pipeline Test Suites

## 12. Tier 10: Evidence Integrity & Persistence Truth Gate Test Suites

Dedicated test suite `tests/evidence-integrity-and-truth.test.ts` bringing the automated regression corpus to **246 tests across 38 test files**:

1. **ACK Identity Verification & Robust Queue Retention:**
   - Verifies content script buffer rejects OPEN ACKs with mismatched `streamKey`.
   - Verifies content script buffer rejects BATCH ACKs with mismatched `streamKey` or `batchSeq`, retaining pending batches in memory.
   - Verifies content script buffer rejects FINALIZE ACKs with mismatched `streamKey` or `finalState`.
   - Verifies strict retry backoff schedule prevents new chunks or flushes from bypassing backoff intervals.

2. **Repository Monotonic Ordering & Integrity Truth:**
   - Verifies repository requires initial batch to be `batchSeq: 1`; rejects out-of-order batches with `batch_sequence_gap`.
   - Verifies sequence gaps across batches reject with `batch_sequence_gap`.
   - Verifies forensic chunk retention across sequence gaps while tagging stream record with `integrity: 'gap_detected'` and `state: 'degraded'`.
   - Verifies idempotent finalization replaces `droppedChars` without delta doubling and returns original `finalizedAt`.
   - Verifies conflicting finalize requests reject with `finalize_conflict`.
   - Verifies `createdAt` comparison in batch payload equality check.
   - Verifies stream identity fields forbid `:` character delimiter.

3. **Replay Truth & Audit Diagnostics:**
   - Verifies pure replay engine operates in natural persisted storage order without synthetic chunk sorting.
   - Verifies comprehensive `ReplayAuditReport` diagnostics (duplicate sequences, sequence gaps, missing prefixes, foreign keys).
   - Verifies `replayRawStream` accepts `RawStreamRecord` directly.

4. **Host Anti-Spoofing & Bridge Bounds:**
   - Verifies candidate endpoint predicate rejects external origins (`https://evil.example`).
   - Verifies bridge transport validator strictly enforces ID character limits and forbids colons.
   - Verifies streams awaiting `FINALIZE ACK` are guarded against premature eviction during active stream capacity pressure.

---

## 13. Tier 11: Canonical Revision Recorder & Passive History Reconciliation Test Suites

StreamArchive includes dedicated test suites for the core domain model:

1. **Preflight Raw Journal Integrity Truth (`tests/preflight-raw-journal-truth.test.ts`):**
   - 17 tests verifying buffer destruction loss-window diagnostics, atomic ACK retries, strict monotonic batch sequence enforcement, and boundary checks.

2. **DeepSeek History Wire Parser & Security Policy (`tests/deepseek-history-parser.test.ts`):**
   - Verifies candidate endpoint predicates with exact origin lockdown (`https://chat.deepseek.com`), query parameter allowlisting, and hash fragment rejection.
   - Verifies payload schema validation, fragment type concatenation (`THINK` -> `thinking`, `RESPONSE` -> `text`), role normalization, and censorship status detection (`CONTENT_FILTER`).

3. **Canonical Revision Recorder & Anti-Recall Invariant (`tests/canonical-recorder.test.ts`):**
   - Verifies live progressive revision generation, last-good invariant preservation upon `filter_triggered`, and automatic `RecoveryEvent` persistence.

4. **Canonical History Reconciliation & Tree Resolution (`tests/canonical-reconciliation.test.ts`):**
   - Verifies two-pass parent resolution (`remoteParentId` -> local `parentId`), sibling branching preservation without collapsing, last-good protection against server template overwrite, strict idempotency on duplicate deliveries, and replay canonical reconstruction governed by `evaluateCanonicalPromotion()`.

---

## 14. Tier 12: Canonical Runtime Wiring & History Correctness Gate

StreamArchive introduces dedicated integration suites bringing the automated regression corpus to **305 tests across 46 test files**:

1. **Canonical Stream Coordinator (`tests/canonical-stream-coordinator.test.ts`):**
   - Verifies monotonic sequencing (`checkpointSeq`), debouncing of streaming token deltas, immediate un-debounced flushes on critical semantic boundaries (`message_id_identified`, `filter_triggered`, terminal events), in-flight promise chaining, and strict ACK identity validation.

2. **Live Canonical Runtime Integration (`tests/canonical-runtime-integration.test.ts`):**
   - Proves end-to-end integration between content script coordinator, bridge message protocol, and service worker storage repository.
   - Verifies live persistence of streaming tokens into durable IndexedDB checkpoints, mid-stream `remoteId` discovery, filter trigger event handling, template replacement, and recovery event generation.

3. **History Evolution & Content Fingerprinting (`tests/history-evolution-and-fingerprint.test.ts`):**
   - Verifies content fingerprint generation (`fp_<len>_<hash>`) and stable idempotency (0 revisions added on duplicate ingestion).
   - Verifies that genuine server evolution appends a new revision with `source: 'history'` while leaving existing live and last-good revisions intact.
   - Verifies seamless normalization of numeric and string remote IDs.
   - Verifies ancestor cycle detection in history trees, preventing cyclic loops in the local storage graph.

4. **Three Truths End-to-End Convergence (`tests/three-truths-e2e.test.ts`):**
   - Proves the full convergence of all three layers:
     - **Truth 1 (Raw Journal Evidence):** Untouched, append-only raw transport bytes and batches committed before decoding.
     - **Truth 2 (Live Canonical Record):** Content script coordinator flushes live checkpoints to IndexedDB, securing `isLastGood = true` pre-filter tokens and `RecoveryEvent`.
     - **Truth 3 (Server History):** Server history arrives with censored template, promotes message to `identityState: 'reconciled'`, appends server history revision, and preserves `isLastGood` revision.
   - Verifies `ReplayRebuilder` obeys the merge policy `reconciled > provisional`, preserving parent links and content without data degradation.

---

## 15. Tier 13: Canonical Integrity Preflight & Read-Only Archive Browser

The automated regression corpus contains **318 tests across 48 test files (100% green)**:

1. **Canonical Integrity Preflight (`tests/canonical-integrity-preflight.test.ts`):**
   - Verifies checkpoint ledger requires initial checkpoint sequence to be `seq: 0`.
   - Verifies checkpoint ledger rejects out-of-order checkpoints with sequence gaps (`checkpoint_sequence_gap`).
   - Verifies monotonic progression (`seq: 0` -> `seq: 1` -> `seq: 2`) commits checkpoints cleanly.
   - Verifies idempotent re-delivery of the last committed sequence returns success without re-writing.
   - Verifies immutable revision conflict prevention: duplicate revision IDs with conflicting text, index, or fingerprint abort transaction with `revision_conflict`.
   - Verifies idempotent revision re-puts with identical payloads succeed without error.
   - Verifies immutable recovery event conflict prevention: duplicate recovery event IDs with conflicting triggers or timestamps abort with `recovery_event_conflict`.
   - Verifies `applyReplayPromotionPlan` commits conversation, message, revisions, and recovery events atomically in a single IndexedDB transaction.
   - Verifies canonical message merging retains provisional linkages, enforces `reconciled > provisional`, and preserves `'filtered'` terminal status against downgrades.

2. **Archive Browser Queries (`tests/archive-browser-queries.test.ts`):**
   - Verifies `listArchiveConversations` navigates the `updatedAt` index descending (`'prev'`) with cursor-based pagination, accurate message counts, and recovery indicators.
   - Verifies `getArchiveConversation` retrieves the complete message tree hierarchy and correctly selects the preferred revision (`selectPreferredRevision` prioritizes `isLastGood = true`, then highest `revisionIndex`).
   - Verifies `getRevisionContent` loads full text, separated thinking traces, and capture metadata on-demand.

3. **Schema Version 5 Migration (`tests/database-migration.test.ts`):**
   - Verifies automatic migration from schema v4 to schema v5, creating `STORE_CANONICAL_CHECKPOINTS = 'canonical_checkpoints'` with keyPath `streamKey` and index `updatedAt`.

---

## 16. Tier 14: Non-Destructive In-Page Recovery Overlay (Milestone 2D.2)

1. **Overlay Portal Isolation (`tests/recovery-overlay-portal.test.ts`):**
   - Verifies closed Shadow DOM attachment and scoped stylesheet containment.
   - Proves zero DOM mutation of DeepSeek page container.
   - Verifies strong identity badge anchoring when remote IDs are present.
   - Verifies fallback floating tray rendering when DOM nodes are unanchored or virtualized.
   - Verifies lazy loading of full recovery text on user click.

2. **DOM Capability Probe & Message Locator (`tests/deepseek-dom-capability-probe.test.ts`):**
   - Verifies non-destructive layout probing and safe message node targeting.
   - Verifies fail-open handling when container or message elements are absent.

---

## 17. Tier 15: Trust Boundary, Durable Finalization & Live Readiness Gate (Milestone 2D.2.1)

The automated regression corpus contains **348 tests across 52 test files (100% green)**:

1. **Terminal Checkpoint Finalization & Retry Queue (`tests/canonical-checkpoint-integrity.test.ts`):**
   - Verifies terminal checkpoint retry backoff survives coordinator disposal until terminal outcome (`committed` or `failed`).
   - Verifies `awaitFinalPersistence()` resolves committed on ACK and failed on retry exhaustion.
   - Verifies new semantic events arriving during retry backoff do not bypass the retry timer (`needsFollowup`).
   - Verifies semantic SHA-256 fingerprint collision detection across all domain properties (parent ID, identity state, content byte variations with identical length, recovery reasons).
   - Verifies rejection of stale sequence numbers (`seq < lastCommittedSeq`).

2. **History Staging Manifest Integrity & Completeness Barrier (`tests/history-bounded-ingest.test.ts`):**
   - Verifies manifest persistence prior to batch ingestion.
   - Verifies duplicate open manifest idempotency and rejects configuration conflicts.
   - Enforces strict completeness barrier: missing batch indices or count mismatches reject reconciliation commit (`history_staging_incomplete`).
   - Verifies periodic stale staging cleanup (`cleanupStaleHistoryStaging`).

3. **In-Page Privacy Boundary & Route-Race Isolation (`tests/recovery-overlay-portal.test.ts`):**
   - Verifies zero summary queries on homepage or non-session routes.
   - Verifies monotonic route epoch tokens immediately purge cached state and discard late async responses on navigation.
   - Verifies complete removal of text snippets from summary payloads.
   - Verifies dedicated `MESSAGE_GET_PAGE_RECOVERY_CONTENT` validates route session match, message membership, and `isLastGood === true` status.
   - Verifies rejection of foreign or spoofed root elements and safe disablement if closed Shadow DOM attachment fails.

4. **DOM Identity Hardening (`tests/deepseek-dom-capability-probe.test.ts`):**
   - Verifies direct attribute comparison on verified `data-message-id` attributes without CSS string interpolation, eliminating selector injection vectors and generic selector false positives.

5. **Schema Version 7 Migration (`tests/database-migration.test.ts`):**
   - Verifies seamless multi-version migration preserving legacy data through v1..v6 and adding `STORE_HISTORY_STAGING_MANIFESTS` at `DB_VERSION = 7`.

> [!IMPORTANT]
> For instructions on executing real-world manual acceptance testing against live `chat.deepseek.com`, see the [Live Acceptance Testing Guide](./LIVE_ACCEPTANCE.md).
