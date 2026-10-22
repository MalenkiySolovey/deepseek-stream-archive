# ADR 0002: MAIN World Interception Boundary & Security Model

## Status
Accepted

## Context
Under Google Chrome Manifest V3, standard extension content scripts run in an `ISOLATED` world. They share the document DOM with the host web page but have a completely separate JavaScript execution environment.

DeepSeek performs its API communications via `window.fetch` and `XMLHttpRequest` running in the `MAIN` world (the page's execution context). An isolated content script cannot observe or wrap those function calls directly.

To observe streaming responses, code must execute in the `MAIN` world. However, running code in the `MAIN` world exposes the extension to significant security risks:
1. **Script Exposure:** Any JavaScript object, variable, or prototype in the `MAIN` world can be inspected, monkey-patched, or tampered with by the web page's scripts (e.g. DeepSeek's frontend or any third-party analytics script running on the page).
2. **Message Spoofing:** A script on the page can dispatch synthetic events to impersonate extension bridge messages.
3. **Privilege Escalation:** If privileged Chrome extension APIs or secrets (such as authentication tokens) are exposed to the `MAIN` world, malicious page scripts could compromise extension integrity.

## Decision
1. **Extreme Minimality:**
   The `MAIN`-world script (`interceptor.main.ts`) must be strictly minimal (under 250 LOC). It has a single responsibility: passively observe candidate HTTP/SSE streams and forward normalized raw chunks across the boundary.
2. **Zero Privileged State:**
   The `MAIN`-world script must contain NO extension secrets, NO IndexedDB access, NO UI rendering logic, and NO high-level business rules.
3. **Declarative Execution World:**
   In Manifest V3, we register the interceptor using declarative configuration (`"world": "MAIN"` in `manifest.json` content scripts) or `chrome.scripting.registerContentScripts`, rather than injecting `<script src="chrome.runtime.getURL(...)">` tags into the DOM (which is slower and detectable).
4. **Validated, One-Way Bridge Protocol:**
   - Communication from `MAIN` world to `ISOLATED` world uses custom DOM events on `window` (or a dedicated hidden bridge node) using non-enumerable, frozen event objects.
   - The isolated content script treats all messages received from the `MAIN` world as **untrusted user input**.
   - Every message payload is validated against a strict schema (type, sequence number, timestamp, data shape) before being passed to extension background processes.
5. **Passive Observation Only:**
   The interceptor does not mutate the page's `fetch` responses or rewrite SSE streams. It merely clones or tee-reads chunks in parallel to the page's consumption.

## Diagram
```text
┌────────────────────────────────────────────────────────┐
│                      MAIN WORLD                        │
│                                                        │
│  DeepSeek Frontend Code (Untrusted)                    │
│           │                                            │
│      calls window.fetch / XHR                          │
│           ▼                                            │
│  [ Minimal StreamArchive Interceptor ]                 │
│      - Clones response stream                          │
│      - Formats RawCaptureChunk                         │
│           │                                            │
│           │ window.dispatchEvent(ValidatedEvent)       │
└───────────┼────────────────────────────────────────────┘
            │  SECURITY BOUNDARY
┌───────────┼────────────────────────────────────────────┐
│           ▼                                            │
│  [ Isolated Content Script Bridge ]                    │
│      - Validates event schema & data types             │
│      - Rejects malformed or oversized payloads         │
│           │                                            │
│           │ chrome.runtime.sendMessage                 │
│           ▼                                            │
│  [ Background Service Worker ] (Privileged Extension)  │
│      - Canonical domain models                         │
│      - IndexedDB persistence                           │
└────────────────────────────────────────────────────────┘
```

## Consequences
- **Positive:**
  - Secure by design: Page scripts cannot corrupt the extension database or hijack extension privileges.
  - Performance: Minimal overhead in the page JS engine.
  - Resilient: Changes to extension UI or storage do not touch the `MAIN`-world interceptor.
- **Negative:**
  - Serialization overhead: All stream chunks must be serialized across the `MAIN` -> `ISOLATED` -> `BACKGROUND` boundaries.
