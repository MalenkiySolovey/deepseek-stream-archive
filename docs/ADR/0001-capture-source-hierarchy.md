# ADR 0001: Multi-Source Capture Hierarchy (Network-First, History, DOM)

## Status
Accepted

## Context
Third-party web extensions that preserve or back up AI conversations typically rely on one of three capture methods:
1. **DOM Scraping** (e.g. `deepseek-anti-retract`): Queries rendered HTML elements (such as `.ds-markdown`).
2. **Network Stream Interception** (e.g. `CATIOR`, `G-124`): Monkey-patches `fetch`/`XHR` in the page context to observe SSE streams.
3. **History API Queries** (e.g. `headroom`, `deepseek-backup-web`): Fetches `/api/v0/chat/history_messages` after completion.

Each method in isolation suffers from fatal failure modes:
- **DOM alone:** DeepSeek utilizes a virtualized list (`.ds-virtual-list`). Only turns currently visible in the viewport exist in the DOM. Intermediate generation states can be cleared before the DOM updates. Content filtered by DeepSeek is actively replaced with refusal strings, permanently wiping previous innerHTML.
- **Network alone:** If network interception starts late (page already loaded), if the tab reloads midway through generation, or if the connection drops, network capture will miss historical context or be incomplete.
- **History alone:** When DeepSeek triggers `CONTENT_FILTER` or `TEMPLATE_RESPONSE`, the server rewrites or censors the message in the history database. The generated tokens that already reached the user's browser are discarded on the server and cannot be fetched via `/history_messages`.

## Decision
DeepSeek StreamArchive establishes a strict **3-tier capture redundancy hierarchy**:

```text
Priority 1: Real-Time Network Streaming Capture
             ↓ (reconciles with)
Priority 2: DeepSeek History API Reconciliation
             ↓ (falls back to if unavailable)
Priority 3: DOM Fallback Extraction
```

1. **Network Streaming Capture (Primary):**
   - Intercepts chunked responses from `/api/v0/chat/completion`, `edit_message`, `regenerate`, `continue`, and `resume_stream`.
   - Records tokens incrementally as they stream into the browser.
   - Preserves the "last-good" revision before any `CONTENT_FILTER` or retraction signal is received.
2. **History Reconciliation (Secondary / Authoritative for Identity):**
   - When navigation occurs or after a stream concludes, queries or passively inspects `/api/v0/chat/history_messages`.
   - Supplies canonical server identifiers (`chat_session_id`, `message_id`, `parent_id`, timestamps).
   - Reconciles streaming drafts against finalized server state without overwriting filtered text preserved by the streaming capture.
3. **DOM Fallback (Tertiary / Last Resort):**
   - Active only when network capture fails (e.g., unexpected protocol shift, unsupported browser environment, or legacy un-intercepted turns).
   - Uses a confidence-scoring selector engine rather than a single hard-coded CSS selector.
   - Never overwrites high-confidence network or history records.

## Consequences
- **Positive:**
  - Complete immunity to virtualized DOM scrolling artifacts.
  - Guarantees capture of tokens that were displayed on screen before server-side retraction.
  - Turns loaded from past sessions are reconciled with stable server IDs.
- **Negative:**
  - Requires maintaining a stateful reconciliation engine (`Reconciler`) that matches streaming drafts to history messages and resolves conflicts based on source precedence.
