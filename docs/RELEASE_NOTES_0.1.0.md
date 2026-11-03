# DeepSeek StreamArchive — Release Notes (v0.1.0)

**Release Target**: `0.1.0`  
**Target Platform**: Google Chrome / Chromium 114+ (Manifest V3)  
**Database Schema**: `StreamArchiveDB` (Version 9)  
**License**: MIT  
**Repository**: `https://github.com/MalenkiySolovey/deepseek-stream-archive`  

---

## 1. Welcome to DeepSeek StreamArchive

**DeepSeek StreamArchive** is an open-source, local-first browser extension designed to protect your conversational interactions on `chat.deepseek.com`.

When using web-based AI clients, network dropouts, tab crashes, or server-side post-generation filters (`CONTENT_FILTER` / `TEMPLATE_RESPONSE`) often wipe away hundreds of tokens of high-quality code, technical analysis, or reasoning. StreamArchive captures responses token-by-token while they stream over Server-Sent Events (SSE), preserving pre-filtered and pre-crash revisions directly on your device.

> **Disclaimer**: DeepSeek StreamArchive is an independent community project and is not affiliated with, sponsored by, or endorsed by DeepSeek (Hangzhou DeepSeek Artificial Intelligence Co., Ltd.).

---

## 2. Key Features in Version 0.1.0

### 🛡️ Passive Stream Interception & Anti-Recall Recovery
- **Non-Invasive Observation**: Synchronously captures Server-Sent Events from `window.fetch` and `XMLHttpRequest` via a MAIN-world interceptor without adding latency or modifying native response streams.
- **Last-Good State Freezing**: Captures and freezes the complete pre-filtered answer and chain-of-thought before server-side replacement templates can wipe it from memory.
- **Fail-Open Strategy**: If any extension error occurs, native DeepSeek chat operations proceed without interruption.

### 💻 In-Page Recovery Presentation (Closed Shadow DOM)
- **Zero Page Pollution**: Recovery UI mounts in an isolated closed `#shadow-root` attached to the assistant message container, completely preventing page CSS leakage.
- **Inline Recovered Responses**: Option to view recovered answers directly inside the DeepSeek chat flow, with collapsible DeepThink reasoning traces and reversible suppression of server placeholder templates.
- **Toolbar Compatibility**: Leaves DeepSeek's native actions toolbar (`Copy`, `Regenerate`, `Like`, `Dislike`, `Read aloud`, `Share`) 100% intact with unbroken event listeners.

### 📑 Side Panel Conversation Archive (Svelte 5)
- **Local Archive Browser**: Clean, reactive sidebar interface built with Svelte 5 runes (`$state`, `$derived`, `$props`) accessible right alongside your conversations.
- **Branch-Aware DAG Navigation**: Tree switcher allowing seamless navigation through regenerated responses and prompt forks without losing historical turns.
- **Revision Timeline Drawer**: Chronological history of every captured revision with origin tags (`network` vs `history`), timestamps, and length statistics.
- **Safe Markdown Rendering**: Token-based Markdown parser rendering headers, tables, quotes, and code blocks safely with **zero `innerHTML`** and **zero `eval`**.
- **Bilingual Interface**: Full localization support for English and Russian (`en` / `ru`).

### 🔄 Branch-Aware Context Continuity (Optional & User-Controlled)
- **Seamless Context Resumption**: When a response is interrupted or filtered, Context Continuity enables you to continue the conversation naturally without retyping the lost answer.
- **Strictly OFF by Default**: Requires deliberate user opt-in in Settings.
- **Manual-Next Mode**: One-shot arming mode that augments exactly one user-initiated turn and then disarms automatically.
- **Transparent Delivery**: User-turn presentation displays a collapsible context disclosure, ensuring you always know what text was included.
- **Zero Autonomous Dispatch**: The extension never sends prompts or network requests on its own.

### 📦 Data Portability & Safe Deletion
- **Human-Readable Export**: Export any conversation as formatted Markdown (`.md`) or structured JSON (`.json`) with zero external permissions.
- **Portable Full Backup**: Create compressed full-archive backups (`.streamarchive.jsonl.gz`) with atomic restore and safe merge capabilities.
- **Automated Retention**: Configure safe evidence cleanup policies or purge the entire archive with a single confirmed action.

---

## 3. Privacy & Security Invariants

- **100% On-Device Storage**: All conversation archives, chunks, and metadata live in your browser's private IndexedDB (`chrome-extension://<id>`).
- **Zero External Telemetry**: Zero analytics, zero cloud servers, zero tracking pixels, zero external databases.
- **Least-Privilege Permissions**: Restricted strictly to `storage` (local settings) and `sidePanel` (UI display) on `https://chat.deepseek.com/*`.
- **Zero Credential Harvesting**: Never accesses `document.cookie`, user session tokens, or Authorization headers.

---

## 4. Known Boundaries & Limitations

1. **Host Scope**: Operates strictly on `https://chat.deepseek.com/*`. Third-party DeepSeek API clients or alternative frontends are not supported.
2. **Browser Requirements**: Google Chrome or Chromium-based browsers version 114+ (supports Manifest V3 Side Panel API). Firefox is not supported in version 0.1.0.
3. **Pre-Transmission Content**: Tokens filtered on the server before being transmitted over the network cannot be recovered.
