# ADR 0021: Fail-Closed Browser Harness Network Isolation, Runtime Diagnostics Epochs, and SPA Route Revocation

## Status

Accepted

## Context

Following Milestone 2D.2.2, a comprehensive integrity and harness audit identified critical discrepancies and resilience gaps:

1. **Harness Network Leakage Risk (Fail-Open Egress):**  
   The initial Playwright browser fixture intercepted requests to `https://chat.deepseek.com` but utilized `return route.continue()` for unhandled routes. If an unmocked endpoint or unexpected telemetry request occurred, real outbound network requests could be dispatched from the test browser. Furthermore, harness documentation falsely claimed that tests ran against a localhost HTTP fixture server.

2. **Runtime Mutation of Sealed Checkpoint Callbacks:**  
   While `CanonicalStreamCoordinator` marked sealed checkpoints as read-only at the type level, the actual in-memory checkpoint object passed to asynchronous persistence callbacks (`onCheckpoint`) was mutable. A misbehaving callback could theoretically tamper with the payload between retry attempts.

3. **Conflation of Ephemeral Runtime Diagnostics and Durable Archive Evidence:**  
   In Chrome MV3, Background Service Workers are frequently suspended and restarted by the browser process. Previous diagnostics reported cumulative in-memory counters (e.g., seen streams, raw batches, handshake states) alongside IndexedDB database counts without distinguishing between current runtime process lifetime and permanent archive storage.

4. **Synthetic PopState vs. True SPA Navigation:**  
   Route isolation tests previously dispatched artificial `window.dispatchEvent(new PopStateEvent('popstate'))`. Real single-page application (SPA) routing in modern Chromium uses `history.pushState()`, `history.replaceState()`, or the modern Chromium `navigation` API, which do not fire `popstate` events on forward transitions.

5. **Payload Shape & Transport Coverage Gaps:**  
   DeepSeek servers emit conversation histories in two distinct wire formats: fragmented array structure (`fragments[]`) and flat fields (`content` + `thinking_content`). Browser E2E coverage previously tested only one format and omitted `XMLHttpRequest` streaming transport.

---

## Decision

We implement the following architectural solutions and invariants across the runtime and testing infrastructure:

### 1. Fail-Closed Intercepted-Origin Network Architecture
- All browser tests operate under a strict **Deny-by-Default** network policy managed by `FailClosedFixtureRouter`.
- Every HTTP and HTTPS network request is matched against an explicit `FixtureRegistry`.
- Any unregistered HTTP/HTTPS request is immediately aborted with `blockedbyclient` and recorded in `NetworkAuditManager`.
- Zero `route.continue()` calls are permitted for HTTP or HTTPS traffic. Only internal browser schemes (`chrome-extension://`, `data:`, `blob:`) pass through.
- At the end of every test execution, `router.audit.assertClean()` verifies zero unexpected external network requests occurred.

### 2. Runtime Immutability & Defensive Checkpoint Cloning
- In `CanonicalStreamCoordinator`, sealed checkpoints are encapsulated in a `SealedCheckpointState` container that completely separates the immutable payload (`payload`) from mutable delivery metadata (`attempts`).
- Sealed checkpoint payloads are recursively frozen via `deepFreeze()`.
- Whenever a checkpoint is dispatched to `onCheckpoint`, a detached defensive deep clone is passed. In-flight callback mutations cannot alter the internal sealed state or subsequent retry deliveries.
- `awaitFinalPersistence` supports an `'unconfirmed'` result state for timeouts, preventing unbounded pending promises.

### 3. Separation of Runtime Diagnostics Epochs and Durable Evidence
- The Background Service Worker generates a unique `runtimeEpochId` and records `runtimeStartedAt` upon each service worker initialization.
- Pipeline diagnostic stages (`PipelineDiagnosticStage`) strictly measure events observed during the **current service worker epoch** (`runtimeRawBatchesCount`, `runtimeRawStreamsCount`, `runtimeCanonicalCheckpointsCount`, `runtimeRevisionsCommittedCount`).
- Permanent storage counts from IndexedDB (`StreamArchiveDB`) are segregated into an explicit `DurableArchiveEvidence` structure (`totalRawStreams`, `totalBatches`, `totalConversations`, `totalMessages`, `totalRevisions`, `reconciledMessages`).
- The sidepanel Diagnostics view cleanly delineates active runtime epoch status from durable historical evidence.

### 4. Real SPA Navigation Interception & Immediate Pre-Revocation
- The recovery overlay portal listens to the Chromium `navigation` API (`navigate` destination pre-revocation and `currententrychange`) and intercepts `history.pushState` / `history.replaceState` in the isolated world.
- When navigation to a new session URL begins, all active recovery modals, badges, and cached state from the preceding session are revoked **immediately** before network responses or summaries for the destination session arrive, guaranteeing zero cross-session recovery leakage.

### 5. Comprehensive Dual-Shape and Transport Browser Coverage
- Browser E2E suites cover both DeepSeek history wire shapes: `fragments[]` and flat `content`/`thinking_content`.
- Browser E2E suites verify both `window.fetch` and `XMLHttpRequest` streaming response interception.
- Browser E2E suites verify MV3 service worker lifecycle, proving that durable archive evidence persists while runtime diagnostics cleanly reset across epochs.

---

## Consequences

- **Air-Gap Safety:** Browser compatibility tests can be run safely in restricted CI environments with absolute certainty that zero external network egress occurs.
- **Accurate Diagnostic Transparency:** Users and developers inspecting the Diagnostics tab can distinguish between current service worker pipeline activity and total historical storage.
- **Adversarial Resilience:** Checkpoint delivery is mathematically immune to callback mutation attacks, and closed shadow roots protect page DOM integrity.
- **Zero Live Simulation Pretence:** Harness documentation and codebase comments truthfully acknowledge synthetic fixture boundaries and maintain that **live manual verification on `chat.deepseek.com` is required** before production deployment.
