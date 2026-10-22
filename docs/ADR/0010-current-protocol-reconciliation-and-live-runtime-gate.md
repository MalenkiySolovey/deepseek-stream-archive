# ADR 0010: Current Protocol Reconciliation and Live Runtime Acceptance Gate

## Status
Accepted

## Context
During protocol analysis, we integrated and audited an additional active upstream reference implementation (`deepseek-archive-liuxd`, MIT License, HEAD `ab202db`, 2026-09-24). Live traffic audits against modern DeepSeek chat infrastructure revealed critical discrepancies and operational edges that required architectural reconciliation before promotion (persistence):

1. **Transport Primacy & Content-Type Independence:**
   - Production DeepSeek chat utilizes `XMLHttpRequest` as primary generation transport (`/api/v0/chat/completion`, `edit_message`, `regenerate`, `continue`, `resume_stream`), retaining `fetch` as fallback.
   - Live generation streams may return `application/octet-stream` or omitted content types, meaning filtering candidate streams on `text/event-stream` causes silent drop of real generations.
   - Endpoint matching previously permitted suffix/substring spoofing or failed on trailing slashes and query strings.

2. **Protocol Semantics & Sentinel Invariants:**
   - Modern DeepSeek web streams do NOT rely on standard `[DONE]` sentinels; completion is signaled structurally via status vocabulary or connection closure (`event: close`).
   - Status vocabulary is multi-state: terminal statuses (`FINISHED`, `CONTENT_FILTER`, `CONTEXT_LENGTH_EXCEEDED`, `INCOMPLETE`, `TIMEOUT`) and non-terminal states (`WIP`).
   - DeepSeek censorship operates by complete text and thinking tokens being streamed first, followed by a terminal `BATCH` patch changing status to `CONTENT_FILTER` and replacing fragments with `TEMPLATE_RESPONSE`.
   - Bare string checks for `v === 'CONTENT_FILTER'` caused false positives when the assistant legitimately generated code or explanations mentioning that identifier.

3. **Runtime Diagnostics & Lifecycle Isolation:**
   - Background Service Worker was conflating automated test passing (`automated_verified`) with live session verification.
   - Unclassified SSE streams (e.g. notifications, metrics) incremented orphan event counts because they lacked a protocol session.
   - Late chunks arriving after stream completion were counted as orphan events rather than post-terminal violations.
   - Stream diagnostics in the Background worker did not distinguish identical stream IDs across producer reloads.

---

## Decision

We enacted the following architectural decisions across the platform boundary:

### 1. Endpoint Matching & Candidate Predicate Decoupling
- `createDeepSeekCandidatePredicate()` verifies ONLY normalized pathname matching against `GENERATION_ENDPOINTS` (`isDeepSeekGenerationEndpoint(meta.url)`).
- Generic Content-Type filtering is delegated to transport interceptors (`isEventStream || isCandidate`), ensuring streams returning `application/octet-stream` are captured without disruption.
- `normalizePathname()` normalizes redundant slashes, strips query parameters and hash anchors, and eliminates trailing slashes while maintaining strict anti-spoofing exact matching.

### 2. Multi-Factor Live Acceptance Gate
- `DeepSeekProtocolDecoder` initializes strictly at `compatibilityState: 'not_observed'`.
- Promotion to `live_observed` requires meeting four concurrent criteria:
  1. Valid generation endpoint identified.
  2. At least one valid SSE frame parsed.
  3. At least one valid JSON patch operation applied.
  4. Content projection confirmed (non-empty projected answer or thinking) OR explicit terminal status reached.
- Any integrity-threatening warning (`unknown_operation`, `malformed_json`, `invalid_path`, `path_too_deep`, `batch_too_deep`, `array_index_too_large`, `invalid_negative_index`, `stream_sequence_gap`, `duplicate_open`) transitions the stream permanently to `degraded`.
- Side Panel displays automated test status ("Verified (132+ passed)") separate from live runtime state ("Not observed yet" / "Live Observed" / "Degraded").

### 3. Structural Censorship Detection (Detect-Before-Apply)
- Replaced naive string search with bounded structural scan (`MAX_SCAN_DEPTH = 5`, `MAX_SCAN_NODES = 50`).
- Detection requires:
  - Structural field match: `obj.status === 'CONTENT_FILTER'` or `obj.quasi_status === 'CONTENT_FILTER'`.
  - Or explicit patch path: `p === 'status' | 'response/status' | 'quasi_status'` with `v === 'CONTENT_FILTER'`.
  - Or typed refusal fragment: `obj.type === 'TEMPLATE_RESPONSE'`.
- Content strings containing `"The constant is CONTENT_FILTER"` never trigger false positives.

### 4. Patch Applier Whitelist First & Atomic Rejection
- `applyPatch()` validates operation whitelist (`SET`, `APPEND`, `REPLACE`, `BATCH`) FIRST before any pathless branch.
- Oversized BATCH (> 128 items) and oversized SET fragments (> 1000 items) are rejected entirely with zero mutation, preventing partial corruption.
- Operation diagnostics counting is strictly bounded (`MAX_BATCH_DEPTH = 8`, `MAX_SCAN_NODES = 50`).

### 5. Unclassified Streams & Terminated Tombstones
- Content Script tracks unclassified SSE streams in `unclassifiedStreamIds = new Set<string>()`. Chunks on unclassified streams are silently dropped and never increment `orphanEventsCount`.
- Unclassified endpoint pathnames are reported to Background via `MESSAGE_RECORD_PROTOCOL_OBSERVATION` to populate diagnostics.
- Terminated streams are recorded in a bounded FIFO ring buffer (`terminatedStreamIds = new Set<string>()`, max 128). Subsequent arrivals are counted as `eventsAfterTerminalCount`, preventing orphan inflation.
- Warning-only frames immediately deliver a diagnostics snapshot even if 0 semantic events were emitted.

### 6. Background Composite Stream Tracking
- Transport streams are tracked using composite keys: `${producerSessionId}:${streamId}`.
- Distinct sets (`seenFetchStreams`, `seenXhrStreams`, `activeTransportStreams`) guarantee accurate metrics across Service Worker lifecycle.

---

## Consequences

### Positive
- Live DeepSeek web chat streaming is captured reliably regardless of whether `fetch` or `XMLHttpRequest` is chosen by the client app or if headers omit `text/event-stream`.
- Complete immunity to false positive censorship alarms from normal assistant output.
- Clean separation between test verification and real live browser runtime state.
- Bounded memory and algorithmic complexity protecting against malicious or malformed SSE streams.
- Zero persistence of real conversations to disk/storage before promotion acceptance.

### Negative / Trade-offs
- Added in-memory tracking in content script for unclassified streams and terminated tombstones (mitigated by strict 128-entry FIFO bounds).
- Background Service Worker requires composite key parsing for stream mapping.
