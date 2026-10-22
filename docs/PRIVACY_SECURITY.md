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
| `scripting` | Declarative or programmatic injection of the minimal MAIN-world interceptor. |
| `host_permissions: ["https://chat.deepseek.com/*"]` | Intercepting streaming responses on the DeepSeek web application and rendering non-destructive inline recovery badges. |

StreamArchive requests **zero unnecessary permissions** (e.g. no `<all_urls>`, no `webRequestBlocking`, no `cookies`, no `history`).

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

