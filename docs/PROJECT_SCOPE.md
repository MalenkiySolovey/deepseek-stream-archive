# Project Scope & Boundaries

> **DeepSeek StreamArchive**  
> Status: Product Charter & Boundaries Definition  
> Date: 2026-10-06  

This document delineates the exact boundaries of DeepSeek StreamArchive. It defines what belongs in the core product and explicitly lists non-goals to prevent feature bloat.

---

## 1. Product Positioning & Value Proposition

### Working Title
**DeepSeek StreamArchive**

### Concise Tagline
> **Never lose a DeepSeek response after it reaches your browser.**

### Value Statement
DeepSeek StreamArchive is a local-first browser extension that records DeepSeek responses while they stream, preserves revisions before filtering or failure, reconciles them against conversation history, and provides durable local archiving, search, diagnostics, and recovery.

### Honest Boundary on "Never"
The tagline expresses our architectural commitment: once generated text tokens reach the user's browser, StreamArchive's streaming recorder ensures they are not lost due to subsequent client-side replacement, `CONTENT_FILTER`, network disconnection, or page navigation. 

*Engineering honesty statement:* Data that the server terminates or filters *before* transmitting to the browser cannot be captured by any client extension.

---

## 2. Core Scope (What StreamArchive IS)

The core scope is structured into nine foundational capabilities:

1. **Passive Streaming Capture:**
   - Real-time observation of DeepSeek completion streams (`/api/v0/chat/completion`, `edit_message`, `regenerate`, `continue`, `resume_stream`) across `fetch` and `XHR`.
   - Streaming event parsing and incremental buffer management without mutating page network requests.
2. **Multi-Source Redundancy:**
   - Primary: Real-time network streaming recorder.
   - Secondary: History API reconciliation (`/api/v0/chat/history_messages`).
   - Tertiary: Confidence-scored DOM fallback extraction.
3. **Canonical Identity & Revision Management:**
   - Stable identity resolution pairing USER prompts and ASSISTANT answers via server keys (`message_id`, `parent_id`) and content hashing.
   - Append-only revision journaling preserving intermediate drafts, thinking traces, and "last-good" responses before filtering.
4. **Resilient Local Persistence:**
   - Extension-isolated IndexedDB database (`StreamArchiveDB`) for long-term durable storage of conversations, messages, revisions, and recovery events.
   - `chrome.storage.local` for settings, active compatibility profiles, and UI state.
   - Transaction acknowledgement pipeline resilient against MV3 Service Worker suspension.
5. **Non-Destructive Recovery:**
   - Detection of retraction markers (`CONTENT_FILTER`, `TEMPLATE_RESPONSE`, refusal patterns, network interruptions).
   - Display of preserved revisions via isolated inline badges/cards (Shadow DOM) and one-click clipboard copying.
   - Zero destructive direct DOM mutation of living reactive frontend nodes.
6. **Local Archive & Side Panel Interface:**
   - Chrome MV3 Side Panel interface allowing users to browse saved conversations, view revision timelines, filter by status (censored, interrupted, normal), and inspect thinking processes.
   - Fast full-text search across all locally preserved responses.
7. **Transparent Export & Portability:**
   - High-fidelity export of conversations and individual revisions to standard Markdown, JSON, and JSONL formats.
   - Local backup creation and restoration without cloud lock-in.
8. **Compatibility Profiles & Capability Probes:**
   - Declarative versioned compatibility profiles isolating DeepSeek selectors, endpoints, and status markers.
   - Real-time runtime capability probe exposing diagnostic health (Capture: OK, History: OK, DOM: OK, Status: Degraded/Compatible).
9. **Raw Protocol Event Retention (Configurable / Opt-in):**
   - Configurable circular log of raw SSE data frames allowing offline replay through newer decoder versions when protocols change.

---

## 3. Explicit Non-Goals (What StreamArchive IS NOT)

To maintain architectural focus, StreamArchive explicitly rejects the following product categories:

| Category | Rejection Rationale |
|---|---|
| **Generic DeepSeek Enhancement Suite** | Better DeepSeek already provides TTS, voice input, web search scrapers, and UI themes. StreamArchive is not a kitchen-sink customization tool. |
| **Bypass Proxy / VPN / Remote Uncensoring Backend** | StreamArchive does not route traffic through third-party unblocking proxies or remote LLM re-writers. It operates 100% locally in the browser. |
| **Cloud Synchronization Service** | StreamArchive is strictly local-first. We do not run external user accounts, cloud databases, or remote telemetry backends. |
| **RAG / Document Management / Knowledge Base** | We are not an enterprise search engine or vector database. External PDF parsing and RAG integrations are out of scope. |
| **MCP / Agent Execution Platform** | StreamArchive is a conversation preserver and recovery layer, not an autonomous agent orchestrator. |
| **AI Prompt Marketplace / Sharing Portal** | We do not host public prompt libraries, social sharing feeds, or user rating systems. |
| **Active Chat Rewriter / Shadow Context Injection (Default)** | We do not automatically prepend hidden text or alter outgoing messages to the model by default, as this alters the server contract and can trigger bans. |

---

## 4. Current Architecture & Roadmap

### Active Architecture:
1. **Network Streaming Capture:** Real-time passive observation of SSE tokens over Fetch & XHR.
2. **Protocol Decoding & Anti-Recall:** Safe patch applier, thinking/answer projection, detect-before-apply censorship guard.
3. **Durable Raw Journaling:** Append-only persistence in extension-isolated IndexedDB with monotonic ordering and replay audit.
4. **Canonical Revision Recorder:** Conversation tree, Message branching, immutable ResponseRevisions, RecoveryEvents.
5. **Passive History Reconciliation:** Passively captured history integration without active polling or credential access.
6. **Side Panel Archive Browser:** Responsive Svelte 5 browser with branch switching, collapsible reasoning, revision history, and safe Markdown rendering.

### Planned Enhancements:
- **In-Page Recovery UX:** Non-destructive inline recovery cards via isolated Shadow DOM.
- **Export Formats:** Structured Markdown and JSON conversation exports.
- **Multi-Browser Support:** Firefox Add-on port following WebExtension standards.
