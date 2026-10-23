# Upstream Technical Analysis & Architectural Contrast

## 1. Executive Summary

Prior to developing **DeepSeek StreamArchive**, we conducted an architectural audit of existing browser extensions and user scripts aimed at DeepSeek chat backup, archiving, and anti-recall/content filter recovery.

While several tools demonstrate clever heuristics for detecting streaming SSE patches, our audit identified systematic failure modes across five fundamental engineering dimensions:
1. **DOM Stability & React Virtualization Safety**
2. **Security, Privacy, and Execution Isolation**
3. **Data Durability & Sequence Monotonicity**
4. **State Machine Lifecycle & Route Isolation**
5. **Supply Chain & Automated Verifiability**

This document details the comparative analysis and formalizes why StreamArchive rejected common upstream patterns in favor of our hardened architecture.

---

## 2. Comparative Architectural Matrix

| Dimension | Typical Upstream Approach (e.g., `deepseek-anti-recall`, `anti-retract`) | DeepSeek StreamArchive Invariant Architecture |
|---|---|---|
| **DOM Interaction** | Modifies host DOM; replaces `div.markdown` or appends buttons into React message containers. | **Zero DOM Mutation:** Host page nodes remain 100% untouched. Overlays float via closed Shadow DOM portal. |
| **CSS & Styling** | Injects un-namespaced `<style>` tags into `<head>`, risking collisions with host Tailwind/CSS modules. | **Closed Shadow Root:** Enclosed within `#shadow-root (closed)` with zero CSS bleed in or out. |
| **Data Privacy** | Stores uncensored tokens in `window.__anti_recall__` or `localStorage` of `chat.deepseek.com`. | **Extension Origin Isolation:** All tokens saved in `chrome-extension://` IndexedDB; page scripts have zero access. |
| **Content Leaks** | Exposes recovered text snippets in DOM summaries or floating badges before user clicks. | **Privacy-First Lazy Retrieval:** Summaries contain only metadata flags; text loaded into memory only upon user click. |
| **Delivery Ordering** | Unordered or debounced event emission without sequence enforcement or ACKs. | **Monotonic Canonical Delivery:** Strict sequence numbers (`seq = lastCommitted + 1`) and immutable checkpoints. |
| **Route Navigation** | Stale overlays persist across single-page app route switches (`/a/chat/s/<id>`). | **Route Epoch Fencing:** Monotonic route tokens purge overlays instantly upon URL change. |
| **Network Footprint** | Active API polling or external telemetry backends. | **Zero External Network:** Passive-only streaming tap; zero external network calls; strict manifest permissions. |
| **Verification Gate** | Manual ad-hoc verification or Node-only unit tests without browser runtime validation. | **Dual Gate:** 367 Vitest unit tests + Playwright MV3 Chromium harness with synthetic offline fixtures. |

---

## 3. Detailed Failure Mode Analysis of Upstream Patterns

### 3.1 Host DOM Mutation & Virtualization Collisions
Many existing anti-recall user scripts intercept the `CONTENT_FILTER` SSE event and immediately mutate the DOM:
```javascript
// Upstream anti-pattern: direct host DOM mutation
const messageNode = document.querySelector('.message-assistant:last-child');
messageNode.innerHTML = savedAnswer; // CRITICAL BUG: Corrupts React fiber and crashes virtualized scroller
```
- **Consequence:** DeepSeek's modern frontend uses virtualized scrollers and React 18 Concurrent Mode. Mutating DOM nodes directly or altering child node counts causes React fiber reconciliation mismatches, resulting in uncaught invariant errors, blank screens, and inability to continue chatting.
- **StreamArchive Solution:** StreamArchive never modifies, appends to, or removes any element owned by `chat.deepseek.com`. Overlays are anchored using read-only bounding box calculations (`getBoundingClientRect`) and rendered inside a single independent portal host detached from the message tree.

### 3.2 Main World Storage & Security Leaks
Several community extensions save captured tokens in the page's `localStorage` or attach them to `window`:
```javascript
// Upstream anti-pattern: storing sensitive tokens in web page scope
window.__SAVED_RESPONSES__[chatId] = fullText;
```
- **Consequence:** Any script running on `chat.deepseek.com` (including DeepSeek's own telemetry scripts or any third-party script loaded on the domain) can inspect `window` and read the user's uncensored prompts, reasoning steps, and filtered outputs.
- **StreamArchive Solution:** Captured tokens are immediately piped across the Main World boundary via structured `window.postMessage` to the Content Script Isolated World, and from there to the Extension Background Service Worker via Chrome runtime messaging. Persisted data resides solely in the extension's private IndexedDB database (`chrome-extension://<id>/StreamArchiveDB`).

### 3.3 Checkpoint Mutability and Lost ACKs
In early extension prototypes, streaming updates mutated a single pending checkpoint object in memory:
```javascript
// Upstream anti-pattern: mutating in-flight delivery state
if (terminalEventReceived) {
  inFlightCheckpoint.isFinal = true; // CRITICAL BUG: Corrupts in-flight retry hash
}
```
- **Consequence:** If an ACK was dropped or delayed over the browser IPC bus, retrying the modified object caused sequence conflicts, checksum mismatches, or silent packet loss in the background repository.
- **StreamArchive Solution (ADR 0020):** Once a canonical checkpoint is sealed, it is strictly immutable. If a terminal event occurs during a retry of sequence $N$, sequence $N$ is delivered reliably with its original payload, followed by sequence $N+1$ bearing `isFinal: true`.

### 3.4 Route Race & Cross-Conversation Leakage
In single-page applications (SPAs), users frequently switch between conversations in the sidebar while an asynchronous storage query or network stream is resolving.
- **Consequence:** An overlay query started on Chat A resolves after the user opens Chat B. Community extensions routinely display badges and recovered text from Chat A inside Chat B.
- **StreamArchive Solution:** Every navigation event increments an in-memory `routeEpoch` integer and purges active overlays. When a background recovery query returns, the content script discards the payload unless `payload.routeEpoch === currentRouteEpoch` and `payload.sessionId === currentSessionId`.

---

## 4. Synthesis & Contribution

By learning from the vulnerabilities and architectural shortcomings of prior upstream tools, **DeepSeek StreamArchive** establishes a new standard for local-first, privacy-preserving browser archiving:
- Fully compliant with Chromium Manifest V3 and CSP standards.
- Safe alongside React Concurrent Mode and virtualized rendering.
- Deterministically verified through automated browser test harnesses before live deployment.
