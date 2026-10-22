# ADR 0009: Stream Integrity, Monotonic Sequencing, and Terminal Semantics

## Status
Accepted

## Context
During the protocol hardening phase, detailed architectural review and fuzzing revealed several edge cases and hardening requirements across the stream capture and protocol pipeline:

1. **Ordering & Sequencing Vulnerabilities:** If network chunks or bridge events arrive out of order, or if orphan chunks arrive without a preceding `open` event, decoders could be instantiated prematurely or state could become corrupted.
2. **Ambiguous Terminal Semantics:** Previously, transport closure was conflated with protocol completion (`stream_finished`). Crucially, when a user clicked the "Stop" button in the DeepSeek UI (emitting an HTTP abort), there was a risk of misidentifying the sudden halt as a censorship refusal (`CONTENT_FILTER`) or leaving the session in an undefined state.
3. **Cumulative Diagnostics Double-Counting:** The Background Service Worker previously aggregated diagnostics sent in each batch using cumulative addition (`+=`), causing single streams with multiple batch updates to report inflated frame and operation counts (e.g., reporting 30 frames for a 15-frame stream).
4. **Dual Upstream Content Shapes:** DeepSeek web production traffic can present generated text either through an array of typed fragments (`response.fragments[]`) or via direct top-level fields (`response.content` and `response.thinking_content`).
5. **Denial-of-Service / Memory Bounds:** Patch appliers required bounded recursion for nested `BATCH` operations, maximum batch size limits, maximum array indexing limits, and safe negative index resolution.
6. **Fragile Content Classification:** Early prototypes relied on a naive emoji heuristic (`^[⚠⛔]`) to detect system notices, risking false positives on legitimate user content containing emojis.

---

## Decision

We instituted the following hardening principles and architectural designs:

### 1. Monotonic Stream Sequence Tracking
- `ActiveStreamSession` in the ISOLATED content script tracks `expectedStreamSequence`.
- An `open` event is strictly required before any chunks are processed. Orphan chunks are rejected immediately and recorded as diagnostics; they never create an uninitialized decoder.
- Sequences must advance strictly monotonically (`0 -> 1 -> 2 -> ...`). Any gap immediately marks the stream session as `degraded` and ceases decoder feeding to prevent state corruption.
- Duplicate `open` events and post-terminal events are recorded and ignored.

### 2. Disambiguated Terminal Event Taxonomy
We replaced the monolithic completion signal with a strictly typed terminal taxonomy:
- **`stream_finished`**: Emitted ONLY when the protocol explicitly signals completion (via `data: [DONE]` sentinel or `response.status === 'FINISHED'`).
- **`stream_transport_ended`**: Emitted when the underlying HTTP connection closes cleanly without an explicit protocol terminal sentinel.
- **`stream_interrupted`**: Emitted when the stream terminates due to client-side cancellation (e.g. user pressing "Stop" button) or low-level network errors. **Under no circumstances is an abort event treated as censorship.**
- **`stream_degraded`**: Emitted if sequence gaps or critical protocol violations force the stream to degrade.

### 3. Absolute Per-Stream Diagnostics Snapshots
- The Background Service Worker maintains `Map<string, DeepSeekProtocolDiagnosticsData>` keyed by `streamId`.
- Incoming batches overwrite the absolute snapshot for their specific stream rather than cumulatively incrementing global counters.
- Global metrics are dynamically computed at query time by summing across distinct stream entries in the map, providing 100% immunity to batch-frequency double-counting.

### 4. Dual Shape Projection & Diagnostic Tagging
- `projectDeepSeekState(state)` dynamically inspects both Variant A (`fragments[]`) and Variant B (`response.content` / `response.thinking_content`).
- Priority is given to `fragments[]` if present; otherwise, it cleanly falls back to top-level content fields.
- Every projected event and diagnostic report is tagged with its `projectionSource`: `'fragments'`, `'top_level'`, or `'none'`.

### 5. Whitelist-Based Fragment Projection
- Fragment classification is strictly whitelist-based: only `type === 'RESPONSE'` maps to answer text, and only `type === 'THINK' | 'THINKING'` maps to reasoning text.
- Refusal templates (`TEMPLATE_RESPONSE`, `TIP`) and auxiliary fragments (`REQUEST`, `TOOL_*`) are explicitly excluded.
- The crude regex emoji heuristic (`^[⚠⛔]`) was completely removed.

### 6. Patch Applier Security & Resource Bounds
- Whitelisted operations: strictly `SET`, `APPEND`, `REPLACE`, `BATCH`. Unknown operations are rejected without mutating state and emit `unknown_operation` warnings.
- Bounds enforced:
  - `MAX_BATCH_ITEMS = 128`
  - `MAX_BATCH_DEPTH = 8`
  - `MAX_ARRAY_INDEX = 1000`
  - `MAX_PATH_DEPTH = 32`
- Safe negative array index resolution: negative indexes out of bounds (e.g. `-999` on array of length 2) record `invalid_negative_index` warnings rather than wrapping or corrupting arrays.

### 7. Explicit Acceptance Gate
- Distinct compatibility states are introduced: `not_observed`, `automated_verified`, `live_observed`, `degraded`, `incompatible`.
- Automated test suites verify `automated_verified`.
- Capturing and replaying real live traces on `chat.deepseek.com` validates transition to `live_observed`.

---

## Consequences

### Positive
- **Guaranteed Stream Determinism:** Strict sequencing ensures no out-of-order execution or corrupt patch states.
- **Truthful Status Reporting:** Aborting a generation (Stop button) is cleanly reported as `stream_interrupted` without corrupting diagnostics or firing false censorship alerts.
- **Accurate Metric Telemetry:** Diagnostics double-counting is entirely eliminated.
- **Future-Proof Upstream Compatibility:** Both current and alternative DeepSeek stream formats (Variant A and Variant B) are supported out of the box.
- **DoS Immunity:** High-volume or adversarial streams cannot trigger deep recursion stacks or excessive array allocations.

### Negative / Trade-offs
- An out-of-order chunk causes the session to degrade rather than attempting complex in-flight re-ordering. Given browser HTTP streams deliver sequentially, this fail-safe approach prioritizes data safety over speculative recovery.
