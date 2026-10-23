# ADR 0019: Recovery Trust Boundary, Durable Finalization, and History Manifest Integrity

## Status

Accepted

## Context

Following the initial delivery of the In-Page Recovery Overlay and Canonical Delivery in Milestone 2D.2, an exhaustive architectural review revealed several critical trust boundary and durability failure modes:

1. **Terminal Checkpoint Destruction on Disposal:**
   When content scripts received a terminal SSE event (`stream_finished`), calling `coordinator.dispose()` prematurely destroyed the retry backoff timer and rejected waiters with `coordinator_disposed`. If the terminal transport checkpoint encountered transient background worker dormancy or message loss, the terminal checkpoint was discarded without retrying.

2. **History Staging Incompleteness & Atomic Barrier:**
   The multi-batch history staging store introduced in DB v6 lacked an explicit session manifest. If a network interruption or tab closure truncated a multi-page history capture, a subsequent reconciliation could ingest a partial session, creating dangling message hierarchies or corrupting identity resolution.

3. **Cross-Conversation Recovery Leakage:**
   When background handlers received `MESSAGE_GET_PAGE_RECOVERY_SUMMARY` on unauthenticated routes (e.g., homepage `https://chat.deepseek.com/`), fallback queries returned the first stored conversation in IndexedDB, displaying recovery badges and metadata belonging to unrelated conversations.

4. **Lazy-Content Privacy Breach via Summaries:**
   Early recovery summaries included text snippets of pre-filter answers in the initial page payload, exposing recovered sensitive content in the content script memory space before explicit user interaction.

5. **Recovery Authority Validation:**
   The bridge lacked an authoritative endpoint to validate whether a requested revision truly represented a verified `lastGood` pre-filter recovery event associated with the active route session.

6. **DOM Identity Fragility & CSS Selector Injection:**
   Interpolating unescaped message IDs into DOM `querySelector` strings created selector syntax vulnerabilities and allowed generic `#id` or `[data-id]` tags to trigger false anchor associations.

7. **Client-Side Route Race Isolation:**
   In single-page app navigation, asynchronous IPC requests initiated on Route A could resolve after the user navigated to Route B, causing overlay badges from Route A to render in Route B.

## Decision

We establish strict trust boundary, durable finalization, and staging integrity guarantees across all components:

### 1. Durable Terminal Finalization Lifecycle
- `CanonicalStreamCoordinator.dispose()` distinguishes between streaming checkpoints and terminal checkpoints. If `isTerminalRequested` or `pendingCheckpoint?.isFinal` is true and terminal persistence has not yet succeeded, the coordinator marks itself disposed but **never cancels the retry backoff timer**.
- Callers in `entrypoints/content.ts` await `coordinator.awaitFinalPersistence(35000)` to guarantee terminal delivery before completing stream processing.
- The coordinator exposes bounded exponential backoff with a hard ceiling (`maxRetryAttempts`), resolving waiters truthfully with `committed` on ACK or `failed` on retry exhaustion.

### 2. History Staging Manifests (Schema Version 7)
- Bump schema to `DB_VERSION = 7` with dedicated store `STORE_HISTORY_STAGING_MANIFESTS = 'history_staging_manifests'`.
- Every incremental history ingest must first persist a manifest record (`stagingId`, `sessionId`, `expectedBatchCount`, `expectedMessageCount`, `state: 'open'`).
- `saveHistoryStagingBatch` validates manifest existence, open state, session identity, and batch bounds before persisting chunks.
- `commitHistoryStagingPlan` enforces a strict completeness barrier (`receivedBatchCount === expectedBatchCount`). If any batch is missing, the commit transaction aborts and clears staging.
- Periodic background maintenance invokes `cleanupStaleHistoryStaging(ttl)` to clean orphan staging data older than 5 minutes.

### 3. Exact Route Session Isolation
- `MESSAGE_GET_PAGE_RECOVERY_SUMMARY` mandates an exact match (`conversation.remoteId === currentRouteSessionId`).
- If `currentRouteSessionId` is null, empty, or corresponds to non-session routes (`/`, `/chat`, `/sign_in`), the background script returns `null` immediately. Zero fallback to other conversations.
- Message sender validation (`isAuthorizedSender`) verifies that caller origin strictly matches `https://chat.deepseek.com` or internal extension runtime.

### 4. Snippet-Free Metadata & Lazy Retrieval
- `PageRecoveryMessageSummary` contains strictly non-sensitive indicators: `messageId`, `remoteId`, `role`, `status`, `hasLastGood`, `recoveryKind: 'authoritative_recovery' | 'partial_capture'`, `capturedAt`.
- Snippet previews are completely removed from the content script tray and summary payloads.
- Sensitive text and reasoning chains are transferred only via dedicated `MESSAGE_GET_PAGE_RECOVERY_CONTENT` upon explicit user click.
- The background content endpoint verifies:
  1. Active conversation matches `currentRouteSessionId`.
  2. Target message belongs to that conversation.
  3. For authoritative recovery, a corresponding `RecoveryEvent` exists and points to an immutable revision with `isLastGood === true`.

### 5. Verified DOM Attribute Authority
- Message anchor location (`locateMessageAnchor`) is restricted exclusively to elements possessing the verified `data-message-id` attribute.
- Direct normalized attribute comparison is used instead of string interpolation into CSS selectors, eliminating selector injection vectors and generic selector false positives.

### 6. Route Epoch Fencing
- The overlay portal increments a monotonic `routeEpoch` token on every URL change and navigation event.
- Late asynchronous IPC responses whose token does not match the active `routeEpoch` or active `currentSessionId` are discarded immediately.
- Modal content caches and active message selections are purged immediately upon route navigation.

### 7. Shadow DOM Enforcement & Spoof Root Eviction
- Foreign or unowned DOM elements bearing `data-streamarchive-overlay-root` are evicted and replaced by an owned host tracked via `WeakSet`.
- Invariant: If closed Shadow DOM attachment fails, the overlay **disables itself safely**. It never falls back to light DOM where page scripts could inspect or modify it.

## Consequences

- **Integrity:** Terminal checkpoints and multi-batch history sessions are resilient against crashes, worker sleeps, and transport drops.
- **Privacy:** User conversation content cannot leak across routes, sessions, or into content script background state without explicit user interaction.
- **Security:** DOM query injection and page-script inspection are completely mitigated via attribute scanning and closed Shadow DOM isolation.
- **Accuracy:** Truthful diagnostics and status reports eliminate silent data truncation or false positive recovery displays.
