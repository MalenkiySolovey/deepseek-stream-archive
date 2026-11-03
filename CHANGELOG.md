# Changelog

All notable changes to **DeepSeek StreamArchive** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-11-03

### Initial Release

#### Added
- **Passive Streaming Observation:**
  - Zero-tampering stream interception supporting both native `window.fetch` and `window.XMLHttpRequest`.
  - WHATWG-compliant incremental Server-Sent Events (SSE) framing engine with multi-byte UTF-8 split character handling.
  - Decoupled protocol decoders separating generic SSE events from DeepSeek-specific JSON patches.
- **Anti-Recall Invariant & Censorship Recovery:**
  - Detect-before-apply guard intercepting `CONTENT_FILTER` and `TEMPLATE_RESPONSE` patches before DOM replacement.
  - Immutable `isLastGood` revision snapshotting preserving complete pre-filtered answers and reasoning traces.
  - Rolling meaningful state tracking ensuring pre-filter text is preserved even when intermediate clearing frames precede filter status.
  - Forensic `RecoveryEvent` ledger linking retraction events to preserved text revisions.
- **Extension-Isolated Persistence:**
  - Chromium Manifest V3 IndexedDB storage (`StreamArchiveDB`, schema version 9) strictly isolated in extension origin.
  - Append-only crash-durable raw journal with monotonic sequence validation and offline replay verification.
  - Multi-source history reconciliation passively merging `/api/v0/chat/history_messages` into canonical DAG branches.
- **Side Panel Archive Browser:**
  - Native Chrome Side Panel interface built with Svelte 5 runes (`$state`, `$derived`, `$props`).
  - Branch-aware conversation tree (`Branch X of Y`) supporting regenerated answers and prompt edits.
  - Expandable DeepThink reasoning trace containers and chronological revision timeline drawer.
  - Fast client-side full-text search across conversations and preserved answers.
  - Bilingual localization support for English and Russian (`en` / `ru`).
- **In-Page Recovery Presentation:**
  - Non-intrusive floating recovery badges and session tray rendered in an isolated `#shadow-root (closed)`.
  - Optional user-configurable inline chat recovery mode replacing placeholder nodes reversibly.
  - Complete preservation of native DeepSeek action toolbar buttons (`Copy`, `Regenerate`, `Like`, `Dislike`, `Read aloud`, `Share`).
- **Human Export & Portable Backup:**
  - Single-thread export to clean Markdown (`.md`) and structured canonical JSON (`.json`).
  - Gzip-compressed portable full-archive backups (`.streamarchive.jsonl.gz`) utilizing native browser `CompressionStream`.
  - Two-mode atomic restore: **Replace Archive** (full rollback guarantee) and **Safe Merge Archive** (primary-key union with conflict prevention).
  - Decompression bomb guard with a 250 MiB uncompressed size ceiling.
- **Storage Observability & Retention:**
  - Storage quota observability via `navigator.storage.estimate()` and durable persistence requests (`navigator.storage.persist()`).
  - Configurable age-based pruning of raw HTTP transport streams (Forever, 30, 90, 180 days) with Protected Evidence Shield indefinitely preserving filtered and interrupted recovery data.
  - Safe 2-step single-conversation deletion with active stream guards.
- **Branch-Aware Context Continuity:**
  - Pure topological active branch lineage resolver isolating alternate sibling regenerations.
  - Uniform forensic cause eligibility (filtered, interrupted, stopped, and replaced turns participate equally).
  - Transparent preview modal with character counts, exclusion audits, and boundary disclosures.
  - Opt-in prompt augmentation delivering rescued context into subsequent model turns without manual copy-pasting.
  - Strict default OFF setting with single-use `manual_next` arming and automatic disarm after dispatch.
  - Durable IndexedDB receipt ledger (`context_continuity_receipts`) preventing infinite re-injection loops.
  - Clean user-turn presentation (`mountCleanUserTurn`) de-augmenting user bubbles via closed Shadow DOM with a collapsible `[View included context]` disclosure.

#### Reliability
- Resilient recovery resolution: multi-tier selection prioritizing valid substantive responses over empty intermediate states.
- Read-time legacy repair resolving historical empty recovery event targets to substantive revisions without requiring database schema migrations.
- Fail-open execution across all transport and DOM interaction boundaries, guaranteeing that DeepSeek web app functionality remains uninterrupted if an extension exception occurs.

#### Security & Privacy
- Manifest permissions strictly limited to `storage` and `sidePanel` with host `https://chat.deepseek.com/*`.
- Prohibited permissions strictly excluded (`<all_urls>`, `tabs`, `cookies`, `webRequest`, `downloads`, `scripting`).
- Zero remote-hosted code execution in compliance with Manifest V3.
- Zero credential, token, cookie, or password scraping.
- Safe token-based Markdown rendering with zero `innerHTML =`, zero `outerHTML =`, and zero `eval()`.
- 100% on-device storage in extension-origin IndexedDB with zero cloud dependency or analytics.

#### Known Limitations
- Operates exclusively on `https://chat.deepseek.com/*`. Third-party DeepSeek API clients or alternative frontends are not supported.
- Tokens filtered server-side before network transmission cannot be recovered.
- Targets Chromium-based browsers (Chrome 114+). Firefox is not supported in version 0.1.0.
