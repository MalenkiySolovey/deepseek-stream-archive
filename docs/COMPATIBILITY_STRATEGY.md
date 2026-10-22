# Compatibility Profiles & Capability Probes

> **DeepSeek StreamArchive**  
> Status: Compatibility & Diagnostic Architecture  
> Date: 2026-10-06  

DeepSeek frequently updates its web application without public notice: moving endpoint paths, reorganizing JSON structures, alternating CSS classes, and A/B testing payload formats across user cohorts. 

StreamArchive does not assume that DeepSeek's frontend is static. Instead, it isolates volatile assumptions inside **Declarative Compatibility Profiles** and continuously monitors system health via a **Runtime Capability Probe**.

---

## 1. DeepSeek Compatibility Profiles

### 1.1 Profile Structure
All DeepSeek-specific endpoints, regex signatures, status keywords, and CSS fallback selectors are encapsulated in a versioned profile contract:

```ts
export interface DeepSeekCompatibilityProfile {
  id: string; // e.g. "deepseek-2026-q3"
  label: string;
  minExtensionVersion: string;
  
  // Endpoint Matching
  endpoints: {
    completionUrls: string[]; // e.g. ["/api/v0/chat/completion", "/api/v0/chat/edit_message"]
    historyUrl: string;       // e.g. "/api/v0/chat/history_messages"
    sessionsUrl: string;      // e.g. "/api/v0/chat_session/fetch_page"
    stopUrl: string;          // e.g. "/api/v0/chat/stop_stream"
  };

  // Protocol Signatures
  protocol: {
    statusMarkers: {
      finished: string[];    // ["FINISHED"]
      filtered: string[];    // ["CONTENT_FILTER"]
      template: string[];    // ["TEMPLATE_RESPONSE"]
    };
    fragmentKeys: string[];  // ["fragments", "thinking_content", "content"]
    patchOperations: string[]; // ["APPEND", "SET", "REPLACE", "BATCH"]
    messageIdKeys: RegExp;   // /^(message_id|msg_id|response_message_id)$/i
  };

  // DOM Fallback Strategies
  dom: {
    messageContainer: string[];
    userRoleMarkers: string[];
    assistantRoleMarkers: string[];
    thinkingContainer: string[];
  };
}
```

### 1.2 Profile Architecture: Built-in TypeScript vs Declarative Remote Updates
1. **Built-in TypeScript Profiles (First-Class / Offline-First):**
   The primary profiles are bundled directly as TypeScript modules (`src/adapters/deepseek/compatibility/profiles/`). They are typed, verified by Vitest fixtures, and function 100% offline.
2. **Optional Declarative Remote Snapshot (Safe Future Extension):**
   In future versions, the extension may optionally download a declarative JSON file (similar to `better-deepseek`'s `remote-config.json`) containing updated CSS selectors and endpoint aliases.
   *Security Boundary:* Remote configuration contains **ONLY data** (strings, regexes, arrays). Remote executable JavaScript or `eval()` is strictly prohibited.

---

## 2. Runtime Capability Probe & Diagnostics

Rather than failing silently when an unannounced DeepSeek update occurs, StreamArchive includes a continuous **Capability Probe** that audits each integration layer.

### 2.1 The Diagnostic Health Matrix

The extension monitors 10 distinct capabilities:

| Probe ID | Probed Component | Passive Detection Method |
|---|---|---|
| `probe:main-interceptor` | MAIN World Hook | Handshake event received on bridge init. |
| `probe:fetch-wrap` | Fetch Observation | At least one `window.fetch` successfully wrapped and invoked. |
| `probe:xhr-wrap` | XHR Observation | `XMLHttpRequest.prototype.open` successfully wrapped and invoked. |
| `probe:stream-candidate` | Endpoint Match | Observed an HTTP request matching candidate completion URLs. |
| `probe:sse-decoder` | Generic SSE Framing | SSE lines successfully split into `event:` and `data:`. |
| `probe:protocol-decode` | DeepSeek Patching | JSON patches (`p`, `o`, `v`) successfully decoded into message fragments. |
| `probe:identity-resolve`| Message ID Extraction | Stable `message_id` observed in chunk payload. |
| `probe:history-api` | History Reconciliation | Successfully intercepted or queried `/history_messages`. |
| `probe:dom-fallback` | DOM Selector Health | Verified that fallback selectors match current page DOM elements. |
| `probe:storage` | IndexedDB Storage | Write/read transaction verified on extension startup. |

### 2.2 Probe States
Each probe reports one of four states:
1. `OK (✓)`: Capability observed and functioning as expected.
2. `UNOBSERVED (○)`: Not yet observed in the current session (e.g. user hasn't sent a prompt yet; passive waiting).
3. `DEGRADED (⚠)`: Primary path failed, but fallback is actively compensating (e.g., streaming format changed, but History API successfully captured the response).
4. `FAILED (✗)`: Capability broken and no fallback available.

---

## 3. Explicit Degraded Modes

If DeepSeek changes a layer, StreamArchive automatically degrades gracefully rather than aborting:

### Scenario A: Streaming Format Altered (History + DOM Survives)
- *Observed Failure:* DeepSeek alters SSE patch JSON format. `probe:protocol-decode` fails.
- *Degraded Action:*
  1. Status set to `DEGRADED: Streaming Format Unknown`.
  2. The system triggers fallback to History API reconciliation and DOM capture.
  3. UI informs user: *"Streaming recorder paused due to DeepSeek update. Responses are being preserved via History & DOM."*
  4. Raw SSE stream is saved to Raw Event Journal for subsequent replay once a decoder update is released.

### Scenario B: CSS Selectors Mutate (Streaming + History Survives)
- *Observed Failure:* DeepSeek rehashes class names (e.g. `.d7dc56a8` changes). `probe:dom-fallback` fails.
- *Degraded Action:*
  1. Real-time network capture and history reconciliation continue at 100% fidelity.
  2. Inline overlay badges fall back to viewport-anchored positioning.
  3. Archive in Side Panel remains 100% operational.

---

## 4. Passive vs Active Probing Policy

- **Passive Probing Only:** StreamArchive probes capabilities **strictly by passively observing natural user interactions**.
- **No Synthetic Traffic:** The extension will **never** send automated dummy chat prompts to DeepSeek to "test" capabilities. Synthetic generation can consume user API quotas, alter conversation history, or violate site terms.

---

## 5. Browser Platform Compatibility: Chromium vs Firefox

### 5.1 Chromium (Chrome, Edge, Brave, Opera)
- **Current Architecture:** Manifest V3 with declarative `content_scripts[].world = "MAIN"` registered at `document_start`.
- **Status:** Supported natively. Chromium browsers cleanly execute `entrypoints/interceptor.content.ts` in the page execution context at `document_start`, providing reliable, synchronous monkey-patching of `window.fetch` and `XMLHttpRequest` before the web application boots.

### 5.2 Firefox Compatibility (Planned Future Path)
- **Current Limitation:** Firefox does not yet support declarative `"world": "MAIN"` in `manifest.json` content scripts identically to Chromium.
- **Future Architecture:** To support Firefox without fragmenting core transport code, StreamArchive will utilize WXT's `injectScript` utility or a dynamic script-tag injection mechanism from the ISOLATED world at `document_start`.
- **Isolation Guarantee:** The transport contracts (`src/transport/`) and the bridge envelope protocol remain 100% engine-agnostic; only the script bootstrap mechanism will vary by target browser.

---

## 6. Live Acceptance Gate & Compatibility States

To provide high assurance against unexpected breaking changes from upstream DeepSeek updates, StreamArchive implements a formal multi-factor **Live Acceptance Gate**.

### 6.1 State Separation
The system strictly separates **automated verification** from **live runtime observation**:
- **Automated Protocol Tests:** Displays static verification badge `Automated Decoder Specs: Verified at build` confirming test suite integrity (192 unit tests across 32 test files).
- **Current Live Runtime State:** Dynamic diagnostic indicator reflecting live session traffic on `chat.deepseek.com`:
  - `not_observed`: Default starting state for any decoder session.
  - `live_observed`: Promoted in real runtime logic when multi-factor criteria are satisfied.
  - `degraded`: Transitioned upon sequence gaps, threatening protocol warnings, or integrity anomalies.
  - `incompatible`: Upstream breaking changes detected.

### 6.2 Multi-Factor Runtime Promotion Criteria
`DeepSeekProtocolDecoder` evaluates `evaluateLiveObservedGate()` after each frame. Promotion from `not_observed` to `live_observed` occurs only when all four criteria are fulfilled:
1. **Endpoint Identity:** Traffic originates from a normalized generation endpoint (`/api/v0/chat/completion`, `edit_message`, `regenerate`, `continue`, `resume_stream`).
2. **Valid SSE Framing:** At least 1 non-empty WHATWG SSE frame successfully parsed (`validFramesSeen >= 1`).
3. **Valid JSON Patch:** At least 1 whitelisted patch operation applied (`validPatchesSeen >= 1`).
4. **Content Projection or Terminal Status:** The state produces non-empty projected answer or thinking text, OR reaches an explicit recognized terminal status (`FINISHED`, `CONTENT_FILTER`, `CONTEXT_LENGTH_EXCEEDED`, `INCOMPLETE`, `TIMEOUT`).

### 6.3 SSE Control Plane & Status Authority Hardening
To eliminate anti-recall races and premature closures:
1. **Authoritative Status Authority:** Only `status` is authoritative for stream termination (`FINISHED`, `CONTENT_FILTER`, etc.). `quasi_status` is purely advisory and provisional.
2. **Anti-Recall Censorship Gate:** Streams do not close on `quasi_status = FINISHED`, allowing subsequent destructive censorship BATCH (`status = CONTENT_FILTER`) to be intercepted and the unredacted `lastGoodState` to be frozen.
3. **Control Event Handling:** `ready` extracts message IDs without patch parsing; trailing `finish`, `close`, `update_session`, and `title` events do not increment `eventsAfterTerminalCount`.
4. **Unknown SSE Events:** Handled gracefully via `unknownSseEventNames` diagnostic tracking without crashing.

### 6.4 Degraded State Invariant
If a sequence gap or integrity-threatening warning (`malformed_json`, `unknown_operation`, `batch_too_deep`, `array_index_too_large`, etc.) occurs, the stream transitions permanently to `degraded`. Degraded sessions cannot transition back to `live_observed`.


