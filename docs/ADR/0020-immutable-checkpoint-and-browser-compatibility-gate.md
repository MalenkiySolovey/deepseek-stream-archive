# ADR 0020: Immutable Checkpoint Delivery, Zero-Mutation Overlay, and Browser Compatibility Gate

## Status

Accepted

## Context

Following Milestone 2D.2.1, an in-depth code and architecture review uncovered several subtle integrity and architectural flaws:

1. **In-Place Mutation of Sealed Checkpoints:**  
   In `CanonicalStreamCoordinator`, when a terminal event was signaled while a non-terminal checkpoint was in-flight, the coordinator was observed mutating the in-flight checkpoint in place (`sealedToDeliver.isFinal = true`). This violated the fundamental definition of an immutable sealed checkpoint and could cause inconsistent delivery state between content script and background service worker.

2. **Terminal Finalization Race and Lost-ACK Recovery:**  
   If an ACK for sequence $N$ was delayed or lost over the extension runtime message bus, and a terminal event arrived while the coordinator was in backoff retry, simply mutating $N$ or discarding $N$ produced sequence gaps or duplicate revisions.

3. **DOM Query Vulnerability in Portal Lifecycle:**  
   The recovery overlay portal queried the host document (`document.getElementById` or `document.querySelector`) to detect if an overlay container was already present. This opened a potential vector where host page scripts or malicious third-party extensions could inject a spoofed element into the page DOM and tamper with extension overlay rendering.

4. **Checksum & Fingerprint Uniformity:**  
   Varying ad-hoc hashing and fingerprinting routines existed across raw journal records, checkpoints, and history staging manifests, lacking uniform canonical serialization and standard cryptographic primitives.

5. **Lack of Browser-Level Verification in CI:**  
   Unit and mock integration tests running in Node/jsdom verified individual algorithmic components but could not test the real Chrome MV3 execution lifecycle (Background Service Worker lifecycle, Content Script world isolation, Chrome Side Panel API, and Closed Shadow DOM encapsulation).

## Decision

We implement the following architectural invariants and compatibility mechanisms:

### 1. Strictly Immutable Sealed Checkpoints
- A checkpoint is sealed once its initial delivery attempt commences.
- Once sealed, all fields—including `checkpointSeq`, `conversation`, `message`, `revisions`, `recoveryEvents`, and `isFinal`—are strictly frozen and immutable.
- Checkpoint retry delivers the exact same payload with the identical cryptographic fingerprint (`checkpointFingerprint`).
- If a terminal event arrives while a non-terminal checkpoint sequence $N$ is awaiting ACK or retrying, the coordinator does not mutate $N$. Instead, it completes reliable delivery of sequence $N$, receives the background ACK, and subsequently emits sequence $N+1$ with `isFinal: true`. Monotonic continuity is strictly preserved.

### 2. In-Memory Portal Root Tracking & Zero Host-DOM Mutation
- The recovery overlay portal retains its host element reference strictly in memory (`portalHostElement`).
- The portal never performs generic DOM queries (`document.querySelector` or `document.getElementById`) to locate or manipulate overlay roots.
- If the host element is detached or disposed, the portal cleans up references internally without traversing or modifying host-owned page elements.
- The portal mounts inside a `#shadow-root (closed)` attached to its own in-memory container. Host page scripts have zero visibility into or access to the shadow root.

### 3. Cryptographic Web Crypto SHA-256 Fingerprinting
- All canonical entities (Canonical Checkpoints, Raw Batches, History Staging Manifests, Recovery Events) are hashed using the standard Web Crypto API (`crypto.subtle.digest('SHA-256')`).
- Canonical serialization sorts object keys deterministically and normalizes line endings prior to hashing, ensuring reproducible digest generation across processes.
- History staging manifest fingerprints bind the `stagingId`, `sessionId`, `expectedBatchCount`, and `expectedMessageCount` together, preventing batch substitution attacks.

### 4. History Manifest and Session Identity Validation
- `commitHistoryStagingPlan` validates that `manifest.sessionId === sessionRemoteId`.
- Ingest transactions enforce complete batch receipt (`receivedBatchCount === expectedBatchCount`) before applying updates to the canonical conversation and message stores.
- Duplicate history batch submissions are detected via fingerprint comparison and acknowledged idempotently without redundant storage writes.

### 5. Playwright MV3 Browser Compatibility Gate
- An automated browser compatibility test harness is established using Playwright Chromium (`test:e2e`).
- The harness runs against local synthetic fixtures reproducing DeepSeek's SSE protocol, chunk fragmentation, and content filter replacement events.
- **Zero External Network Requests:** The test suite operates under strict network isolation with zero calls to `chat.deepseek.com` or external servers.
- The suite validates 6 end-to-end scenarios:
  1. `normal-generation.spec.ts`
  2. `filter-replacement.spec.ts`
  3. `history-reconciliation.spec.ts`
  4. `route-isolation.spec.ts`
  5. `network-interruption.spec.ts`
  6. `degradation-profile.spec.ts`
- The browser compatibility gate is integrated into continuous integration (`.github/workflows/ci.yml`) and must pass on all PRs.

### 6. Truthful Live Acceptance Protocol
- Automated browser tests verify technical MV3 mechanics and architectural invariants.
- They do **not** replace live human testing against production DeepSeek infrastructure.
- The repository requires human sign-off documented in `docs/LIVE_ACCEPTANCE_RESULTS_TEMPLATE.md` before claiming verified production compatibility.
- Project status is explicitly marked `LIVE MANUAL VERIFICATION REQUIRED` until real authenticated tests are conducted.

## Consequences

- Checkpoint delivery is deterministic, crash-durable, and free of race conditions.
- Zero risk of prototype pollution or DOM tampering from host page scripts.
- Uniform SHA-256 digests provide cryptographic auditability of all persisted states.
- Browser test harness catches MV3-specific bugs before deployment.
- Strict separation between automated test verification and live manual production acceptance.
