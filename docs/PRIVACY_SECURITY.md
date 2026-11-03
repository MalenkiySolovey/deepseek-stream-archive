# Privacy & Security Model

> **DeepSeek StreamArchive**  
> Status: Security & Privacy Architecture  
> Date: 2026-10-06  

DeepSeek StreamArchive handles highly confidential user information: complete conversational histories, personal prompts, code snippets, reasoning traces, and generated answers. This document specifies the threat model, privacy safeguards, and security architecture designed to protect user data.

---

## 1. Privacy Principles

### 1.1 100% Local-First
- **Zero External Telemetry:** The extension contains zero tracking pixels, Google Analytics, PostHog, Sentry, or third-party telemetry libraries.
- **Zero Remote Storage:** Conversations are stored exclusively within the local browser's IndexedDB partition on the user's disk. No central servers, cloud syncing, or remote databases are operated.
- **Offline Capable:** The core archiving and retrieval engine operates fully without an internet connection once installed.

### 1.2 Zero Credential Harvesting
- DeepSeek authentication tokens (`Authorization: Bearer <token>`, `localStorage.userToken`, session cookies) must **NEVER** be persisted as conversation metadata or stored in IndexedDB.
- When inspecting HTTP request headers to track session IDs, the authorization header is explicitly ignored and discarded.

### 1.3 Console Redaction
- In production builds, full prompts and complete AI responses must **never** be printed to `console.log` or `console.debug`.
- Log entries are restricted to operational metadata, e.g.:
  ```text
  [StreamArchive] Saved batch #14 | Turn: msg_10948 | 1,420 chars | Source: network
  ```

---

## 2. Threat Model & Boundaries

### 2.1 Threat Vectors

| Threat Actor | Threat Vector | Mitigation in StreamArchive |
|---|---|---|
| **Malicious Page Scripts on `chat.deepseek.com`** | Attempts to inspect or delete stored conversations by probing `window` or `localStorage`. | **Strict Origin Isolation:** IndexedDB is hosted solely inside `chrome-extension://<id>`. Page scripts have zero filesystem or storage access to the extension origin. |
| **Tampered Page Context** | Page scripts attempt to spoof capture events across the MAIN/ISOLATED bridge. | **Bridge Schema Validation:** Isolated content script validates types, IDs, and structure of every message crossing the boundary. |
| **Service Worker Interruption** | Browser terminates MV3 Service Worker mid-stream, causing token loss. | **Resilient ACK Pipeline:** In-memory queue retains uncommitted batches in content script until explicit DB transaction commit is acknowledged. |
| **Leaked Bug Reports** | User shares diagnostic logs containing private prompts. | **Automatic Diagnostic Redaction:** Exporting diagnostic traces strips all text tokens and prompts, leaving only JSON keys, lengths, and error codes. |

---

## 3. Multi-World Execution Security Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│ 1. MAIN WORLD (chat.deepseek.com)                           │
│    Trust Level: UNTRUSTED PAGE REALM                        │
│    - Contains: interceptor.main.ts                          │
│    - Capabilities: Clones fetch / XHR response streams     │
│    - Restrictions: Zero extension APIs, zero secrets,       │
│      zero business logic, zero storage access               │
└──────────────────────────────┬──────────────────────────────┘
                               │ CustomEvent (Frozen Data)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. ISOLATED CONTENT SCRIPT (chat.deepseek.com)              │
│    Trust Level: CONTROLLED BRIDGE REALM                     │
│    - Contains: content.ts, bridge/page-to-content.ts        │
│    - Capabilities: Runtime schema validation,               │
│      DOM overlay cards, chrome.runtime messaging            │
│    - Restrictions: NO IndexedDB open under page origin      │
└──────────────────────────────┬──────────────────────────────┘
                               │ chrome.runtime.sendMessage
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. EXTENSION CONTEXT (chrome-extension://<extension-id>)    │
│    Trust Level: FULL PRIVILEGED EXTENSION REALM             │
│    - Contains: background.ts (Service Worker),              │
│      sidepanel.html, StreamArchiveDB                        │
│    - Capabilities: IndexedDB ACID transactions,             │
│      export generation, sidepanel rendering                 │
│    - Completely inaccessible to page scripts                │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Bridge Protocol Security Specification

1. **Non-Enumerable Event Dispatch:**
   The `MAIN`-world interceptor passes events using `window.dispatchEvent` with strongly typed, sealed payloads:
   ```ts
   interface BridgeCaptureEvent {
     version: 1;
     seq: number;
     streamId: string;
     timestamp: number;
     type: 'chunk' | 'complete' | 'abort';
     payload: string; // Raw SSE chunk or error reason
   }
   ```
2. **Strict Validation Pipeline:**
   Upon receiving a bridge event, the isolated content script executes:
   - Verification that event data is a valid JSON string (or structured clone).
   - Validation that `version === 1`.
   - Type verification of `seq`, `streamId`, and `timestamp`.
   - Rejection of oversized frames (> 1 MB per chunk).

---

## 5. Raw Event Retention & Privacy Controls

1. **Strict Response-Only Capture:**
   The Durable Raw Journal (`raw_streams`, `raw_stream_batches`) stores **only** application-level response text chunks.
   - **Zero Request Ingestion:** User prompts, outgoing request bodies, parameters, and headers are strictly discarded.
   - **Zero Credential Capture:** Bearer tokens, cookies, and authentication headers are never inspected or written to disk.
   - **URL Sanitization:** URLs are stripped of query parameters (`?token=...`) and hash anchors (`#...`) before persistence; only `origin + pathname` is retained.

2. **User-Configurable Retention & Resource Bounds:**
   Raw protocol journaling (preserving raw SSE chunks in IndexedDB):
   - Confined strictly to extension-origin IndexedDB (`chrome-extension://<id>`).
   - Default: Monotonic batches retained locally for anti-recall replay and offline reconstruction.
   - Operates under standard browser quota without requiring `unlimitedStorage`.
   - **Host Anti-Spoofing & Origin Lockdown:** Candidate endpoint validation restricts capture strictly to the official origin (`https://chat.deepseek.com`). Requests to external hostnames, non-standard ports, or rogue origins embedding candidate endpoint paths are immediately rejected.
   - **Composite Key Integrity:** Session and stream identifiers (`producerSessionId`, `streamId`) forbid delimiter colon `:` characters (`invalid_stream_identity`) to guarantee unforgeable deterministic partition boundaries. All fields enforce hard string length limits (`MAX_ID_CHARS = 128`, `MAX_URL_CHARS = 1024`, `MAX_REASON_CHARS = 256`, `MAX_METHOD_CHARS = 16`).
   - **Hard Payload Bounds:** Bridge chunks capped at 64 KiB (`MAX_BRIDGE_CHUNK_CHARS = 65,536`). Batches capped at 128 KiB (`MAX_RAW_BATCH_CHARS = 131,072`) and 500 chunks max.
   - **Content Script Memory Ceiling:** Total pending un-ACKed characters capped at 512 KiB (`MAX_PENDING_CHARS = 524,288`) evaluated *before* appending incoming chunks. Excess chunks are dropped with exact `droppedChars` tracking and stream degradation to prevent tab OOM.
   - **DoS Stream Bounds:** Active tracked streams bounded to 16 (`MAX_ACTIVE_KNOWN_STREAMS = 16`) to prevent memory exhaustion under request floods. Streams awaiting `FINALIZE ACK` are guarded against premature eviction.

3. **Selective Deletion & Purging:**
   Users have granular controls in the Side Panel:
   - *Delete Turn:* Wipes the specific turn and all associated revisions.
   - *Delete Conversation:* Purges the entire thread from IndexedDB.
   - *Clear All Data:* One-click total database wipe with confirmation.

4. **Data Export Transparency:**
   Exported backups are generated as unencrypted, human-readable JSON files so the user can verify exactly what data is exported.

---

## 6. Chrome Web Store Permissions Justification

| Permission | Technical Requirement |
|---|---|
| `storage` | Storing user preferences, retention flags, and UI states in `chrome.storage.local`. |
| `sidePanel` | Hosting the persistent archive viewer, search panel, and revision inspector. |
| `host_permissions: ["https://chat.deepseek.com/*"]` | Intercepting streaming responses on the DeepSeek web application and rendering non-destructive inline recovery badges. |

---

## 7. In-Page Presentation & Rendering Security (Milestone 2D.4)

1. **Closed Shadow DOM Isolation:**
   Both overlay portals and inline recovery hosts are mounted using `attachShadow({ mode: 'closed' })`. This prevents page scripts from querying, reading, or tampering with recovered response contents via `document.querySelector` or `.shadowRoot`.

2. **Zero Sensitive Attributes in Host DOM:**
   The host element `<div data-streamarchive-inline-recovery-host="<messageId>">` exposes only an internal message identifier. No recovered response text, tokens, or reasoning traces are ever written into host attributes.

3. **Pure DOM Fragment Safe Markdown Parsing:**
   To guarantee absolute protection against DOM-based XSS, StreamArchive strictly forbids `innerHTML`, `outerHTML`, and `insertAdjacentHTML`. All markdown parsing (`parseSafeMarkdown()`) generates a tokenized AST, and DOM elements (`<p>`, `<h1>`–`<h6>`, `<ul>`, `<ol>`, `<li>`, `<blockquote>`, `<pre>`, `<code>`) are constructed via `document.createElement()` and populated with `document.createTextNode()`. Raw HTML tags inside assistant responses are rendered purely as harmless escaped plain text.

4. **Reversible Host Placeholder Suppression:**
   In inline mode, the DeepSeek refusal placeholder (`.ds-markdown`) is suppressed using `style.display = 'none'`. This modification is tracked in isolated extension memory (`InlineRecoveryLedger`) and is restored to its exact original value upon mode change, message dismissal, or SPA navigation.

5. **DeepSeek Native Action Toolbar Integrity:**
   The host's native toolbar (`Copy`, `Regenerate`, `Like`, `Dislike`, `Read aloud`, `Share`) is never moved, modified, cloned, or covered. It remains fully interactive within DeepSeek's host DOM. Dedicated extension actions ("Copy recovered response") are strictly confined inside the closed Shadow DOM.

StreamArchive requests **zero unnecessary permissions** (e.g. no `scripting`, no `<all_urls>`, no `webRequest`, no `webRequestBlocking`, no `cookies`, no `tabs`, no `history`). Declarative content scripts with `"world": "MAIN"` eliminate the need for `scripting` permission.

---

## 7. Passive History Capture Security Bounds

1. **Zero Credential / Token Access:**
   - The extension **never** reads `localStorage.userToken`, session cookies, or `Authorization: Bearer <token>` headers.
2. **Zero Out-of-Band Network Traffic:**
   - The background worker **never** initiates active HTTP `fetch()` or `XHR` calls to DeepSeek history endpoints.
   - History capture operates **strictly** by passively observing responses to `/api/v0/chat/history_messages` that the web application initiates on its own.
3. **Strict Query Parameter Allowlisting:**
   - Candidate history endpoints are matched against exact origin (`https://chat.deepseek.com`) and pathname (`/api/v0/chat/history_messages`).
   - Query parameters are strictly filtered against an allowlist (`chat_session_id`, `cache_version`, `before_message_id`, etc.). Any unexpected query parameters, hashes, or fragments are discarded before forwarding.

---

## 8. In-Page Recovery Trust Boundaries & Route Isolation

1. **Exact Route Session Boundary:**
   - Background queries (`MESSAGE_GET_PAGE_RECOVERY_SUMMARY`) require an exact match with the active route session ID (`remoteId === routeSessionId`).
   - Non-session routes (`/`, `/chat`, `/sign_in`) and homepage return null immediately, guaranteeing that recovery indicators from one conversation never leak into another.
2. **Zero Snippet Leakage:**
   - Page recovery summaries transfer only metadata (`messageId`, `remoteId`, `recoveryKind`, timestamps). Pre-filter text snippets are strictly forbidden from summary payloads.
3. **Authoritative Recovery Validation:**
   - Dedicated endpoint `MESSAGE_GET_PAGE_RECOVERY_CONTENT` validates that:
     - The requested message belongs to the active conversation.
     - A structured `RecoveryEvent` exists for the turn.
     - The target revision is verified as `isLastGood === true`.
4. **Closed Shadow DOM & Anti-Spoofing:**
   - All recovery UI is mounted within `attachShadow({ mode: 'closed' })`. Page scripts have zero DOM query access to recovery cards or clipboard buttons.
   - Unowned or spoofed root elements injected by page scripts are immediately evicted via `WeakSet` ownership tracking. If closed Shadow DOM attachment fails, the overlay disables itself safely rather than degrading to light DOM.

---

## 9. Export & Backup Security Boundary (Milestone 2E.1)

1. **Zero Network Transmission:**
   - Conversation export (Markdown and JSON) and Portable Archive Backup (`.streamarchive.jsonl.gz`) operate **strictly 100% client-side**.
   - No external servers, telemetry, cloud storage, or third-party APIs are contacted during generation, serialization, compression, or file saving.

2. **Zero `chrome.downloads` Permission:**
   - StreamArchive refuses to request the powerful `chrome.downloads` manifest permission.
   - File saving utilizes modern web standards:
     - Primary: `window.showSaveFilePicker()` via the File System Access API, ensuring that file writes occur only to a location explicitly chosen by the user in an operating-system file picker dialog.
     - Fallback: Transient `<a download>` object URLs (`URL.createObjectURL(blob)`), revocable immediately after triggering.
   - Cancellation by the user in the file picker dialog is handled gracefully without errors.

3. **Safe Filename Sanitization:**
   - File titles are strictly sanitized before passing to save dialogs:
     - Strips OS path separators (`/`, `\`), control characters (`0x00`-`0x1F`, `0x7F`-`0x9F`), and Windows forbidden characters (`<`, `>`, `:`, `"`, `|`, `?`, `*`).
     - Neutralizes Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, `LPT1`-`LPT9`).
     - Normalizes spaces, bounds name length to $\le 60$ characters, and appends a UTC ISO date stamp (`YYYY-MM-DD`).

4. **Unencrypted Portable Backup Disclosure:**
   - Backup format v1 uses standard gzip compression over line-delimited JSON.
   - The backup contains unencrypted conversation text, thinking traces, and raw journal streams.
   - The extension Side Panel displays explicit warnings informing the user to store backup files in encrypted volumes or secure locations.

5. **In-Memory Resource Ceilings:**
   - Backup snapshots enforce a conservative 100 MiB raw text size limit (`MAX_IN_MEMORY_PORTABLE_BACKUP_SOURCE_BYTES`) evaluated inside the snapshot transaction to protect against out-of-memory errors in browser processes.

---

## 10. Import & Restore Security Model (Milestone 2E.2)

1. **Decompression Bomb Protection:**
   - Gzip stream reading enforces deterministic safety bounds: `MAX_IMPORT_COMPRESSED_BYTES = 50 MiB`, `MAX_IMPORT_DECOMPRESSED_BYTES = 250 MiB`, `MAX_IMPORT_RECORDS = 500,000`, `MAX_IMPORT_LINE_CHARS = 10 MiB`.
   - Streaming reader cancels decompression immediately (`reader.cancel()`) upon encountering an oversized payload.

2. **Pre-Commit Referential Integrity Barrier:**
   - No data is written to the database until the materialized relational graph is verified in memory for DAG acyclicity, message conversation scoping, `attempt_only` parent isolation, and valid `isLastGood` pointers for recovery events.

3. **Atomic Single-Transaction Guarantee:**
   - In Replace Mode, all 9 stores are cleared and populated within a single transaction. Any operational failure triggers `tx.abort()`, leaving the previous database 100% intact.
   - In Merge Mode, primary key collisions with conflicting payloads abort the transaction completely.

4. **Active Stream Concurrency Protection:**
   - Restore execution is strictly blocked while active DeepSeek generation streams are running (`activeTransportStreams.size > 0`).

5. **Zero New Permissions:**
   - Restore operates entirely through standard file input (`<input type="file">`) and local IndexedDB operations without external network requests or supplementary permissions.

---

## 11. Retention & Deletion Privacy Boundaries (Milestone 2E.3)

1. **Local-Only Deletion Scope:**
   - Deletion of conversations, raw streams, or the entire archive operates **exclusively within local browser storage** (IndexedDB and `chrome.storage.local`).
   - The extension makes zero API requests to delete, synchronize, or report deletions to DeepSeek servers (`https://chat.deepseek.com`). DeepSeek server-side conversation logs remain under the user's manual control on the DeepSeek platform.

2. **Zero Extra Permissions & Passive Opportunistic Execution:**
   - Automatic retention scheduling does not request the `alarms` permission, nor does it run long-polling background timers.
   - It executes opportunistically only on service worker initialization and stream finalization, capped at once per 24 hours.
   - Deletion operations do not require `chrome.browsingData` or `unlimitedStorage` permissions.

3. **Protection of Pre-Filter Evidence:**
   - The retention engine's Protected Evidence Shield ensures that pre-filter text and censorship proof (`RecoveryEvent`, `isLastGood`) are never purged automatically by age.
   - Users retain full sovereign control to purge raw evidence manually (`Delete Raw Evidence`) while preserving 100% of canonical conversations and pre-filter recoveries.

4. **Atomic Rollback & Failure Isolation:**
   - Single-conversation cascade deletions and whole-archive purges execute in single atomic transactions. If browser storage or transaction failure occurs, all changes roll back immediately via `tx.abort()`, preventing corrupted or partially deleted relational states.

---

## 12. Context Continuity Privacy & Safety Boundaries (Milestone 2D.5A)

1. **Zero Outgoing Request Mutation:**
   - Context Continuity operates in Phase 2D.5A strictly as a local derived planner. It does **not** alter outgoing fetch/XHR request payloads, does **not** append custom headers, and does **not** type into the DeepSeek textarea.
2. **Strict Default OFF:**
   - Context Continuity is disabled by default (`enabled: false`). DeepThink reasoning traces are also excluded by default (`includeThinking: false`).
3. **Surrogate-Safe Truncation & Disclosure:**
   - Hard character budgets (12,000 text chars, 6,000 thinking chars) prevent prompt overflows. Surrogate pairs are never broken, and all omissions are explicitly disclosed in the formatted preview.
4. **Zero Persistent Relational Mutations:**
   - Plans are transient in-memory derivations (`DB_VERSION = 8` strictly preserved). No speculative or artificial injection records are written to IndexedDB.


