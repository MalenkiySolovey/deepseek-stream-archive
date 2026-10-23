# In-Page Recovery Overlay Architecture

## Overview

The **Non-Destructive In-Page Recovery Overlay** allows users to view, copy, and inspect recovered DeepSeek responses (such as turns replaced by `CONTENT_FILTER` or truncated by network disconnects) directly within the `chat.deepseek.com` tab, while strictly adhering to the **Zero-Mutation Invariant**.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        DeepSeek Tab DOM                                │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │ <main class="chat-container">                                │     │
│   │   <div data-message-id="msg-101">                            │     │
│   │     "Sorry, I cannot answer this question."                  │     │
│   │   </div>  (UNTOUCHED - NO INJECTION, NO MUTATION)            │     │
│   └──────────────────────────────────────────────────────────────┘     │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │ <div data-streamarchive-overlay-root>                        │     │
│   │   #shadow-root (closed)                                      │     │
│   │     ├─ <style> (Scoped CSS reset & dark-theme glass)         │     │
│   │     └─ <div id="streamarchive-overlay-container">            │     │
│   │          ├─ [🛡️ Recovered Pre-Filter Response] (Anchored)    │     │
│   │          └─ [🛡️ StreamArchive Tray] (Session Fallback)        │     │
│   └──────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────┘
```

---

## Core Invariants

1. **Zero Host Page Mutation:**
   - Under no circumstances does StreamArchive inject DOM nodes into, or modify properties (`innerHTML`, `textContent`, classes) of DeepSeek's message elements.
   - No interaction with React internals (`__reactFiber`, props, state, hooks) or virtualized lists.
   - No SSE stream tampering or synthetic network packets injected into the page.

2. **Isolated Top-Level Portal:**
   - Mounts at `<div data-streamarchive-overlay-root>` directly on `document.documentElement`.
   - Uses `attachShadow({ mode: 'closed' })` for complete CSS and DOM containment.
   - Host styles, Tailwind resets, or page CSS cannot leak into the overlay; overlay styles cannot leak into the page.

3. **Strong vs. Fallback Identity Mapping:**
   - **Strong Identity Match:** When DeepSeek's DOM node exposes a remote message ID (e.g. `data-message-id="xxx"`) that matches a canonical message in storage with `status === 'filtered'` or `status === 'degraded'`, a floating badge is anchored above the message position.
   - **Weak / Absent Mapping Fallback:** If DeepSeek alters its DOM classes or omits message IDs, the overlay falls back to a **Session-Level Floating Recovery Tray** at the bottom-right of the viewport. Recoverable answers remain 100% accessible regardless of frontend layout changes.

4. **Privacy-Preserving Lazy Content Fetching:**
   - Page load and navigation emit `MESSAGE_GET_PAGE_RECOVERY_SUMMARY`, transferring strictly non-sensitive metadata (message IDs, remote IDs, status, recoveryKind, timestamps). **Zero text snippets or body previews** are transferred in summary responses.
   - Full response text and full chain-of-thought (`thinking`) are queried on-demand via dedicated `MESSAGE_GET_PAGE_RECOVERY_CONTENT` only when the user explicitly clicks a recovery badge or tray item.
   - The background endpoint verifies active route session matching, message membership, and verified `isLastGood` recovery event existence before releasing content.

5. **Route-Race Isolation & Lifecycle Management:**
   - Monotonic `routeEpoch` fencing prevents late IPC responses from rendering on newly navigated routes.
   - Modal caches and active summaries are immediately purged on URL changes.
   - Homepage and non-session routes (`/`, `/chat`, `/sign_in`) return null and remain completely inert.

6. **Safe Rendering & Content Security:**
   - Zero `innerHTML` and zero `eval`.
   - All text and reasoning chains are rendered via `document.createElement` and `textContent`.
   - Native `<details>` and `<summary>` elements provide collapsible reasoning inspection without external JavaScript dependencies.
   - Root host ownership is tracked via `WeakSet`; foreign spoof elements are evicted. If closed Shadow DOM attachment fails, the overlay safely disables itself rather than falling back to light DOM.
