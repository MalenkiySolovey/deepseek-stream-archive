# ADR 0018: Non-Destructive In-Page Recovery Overlay

## Status

Accepted

## Context

While Milestone 2D.1 implemented a read-only Archive Browser inside the browser Side Panel, users frequently need instant in-context recovery when DeepSeek's post-generation safety filter triggers or when a network disconnect aborts a generation mid-stream.

Common extension patterns for in-page overlays attempt to:
1. Replace or mutate the DOM text inside the web app's message elements.
2. Hook into React fiber nodes to modify component state.
3. Inject synthetic SSE events or manipulate the host response stream.

In complex, virtualized single-page applications like DeepSeek (`chat.deepseek.com`), these approaches cause fatal frontend crashes, desynchronize React's virtual DOM reconciliation, trigger anti-tamper heuristics, and risk corrupting user session state.

## Decision

We adopt a **Non-Destructive In-Page Recovery Overlay** architecture with the following principles:

1. **Zero DOM Mutation Inside Host Nodes:**
   DeepSeek's response DOM is treated as strictly read-only. No children are appended to message containers; no element properties are mutated.

2. **Top-Level Closed Shadow DOM Portal:**
   The entire overlay UI is mounted as a single top-level portal on `document.documentElement`:
   ```html
   <div data-streamarchive-overlay-root>
     #shadow-root (closed)
   </div>
   ```
   Closed Shadow DOM provides complete CSS cascading isolation and prevents page scripts from querying overlay elements via `document.querySelector`.

3. **Two-Tier Identity Mapping:**
   - **Strong Anchor:** If `probeDeepSeekDom` and `locateMessageAnchor` identify a DOM node with an authoritative `data-message-id` matching a recoverable canonical message, an **Anchored Badge** floats above that node's viewport coordinates.
   - **Session Fallback Tray:** If DOM nodes are virtualized out of the viewport, use obfuscated classes, or lack ID attributes, the overlay renders a **Floating Recovery Tray** in the bottom-right corner.

4. **Lazy Retrieval Over Bridge:**
   Initial page queries (`MESSAGE_GET_PAGE_RECOVERY_SUMMARY`) transfer light metadata only. Full text and thinking blocks are transferred via `MESSAGE_GET_REVISION_CONTENT` only upon explicit user click.

5. **Safe Rendering:**
   Zero `innerHTML` or `eval` in rendering cards or Markdown text. Copy to clipboard is provided via `navigator.clipboard.writeText`.

## Consequences

- **Stability:** Virtualized lists and React re-renders in DeepSeek do not disrupt or clash with StreamArchive.
- **Resilience:** Even if DeepSeek completely renames its CSS classes or shifts DOM structures, recovered content remains accessible via the session tray fallback.
- **Performance:** Lightweight metadata summaries prevent memory bloat in the content script; full texts are loaded on demand.
