# DeepSeek Web Stream Protocol Specification

> **Version:** 2026-10 Reference (SSE Control Plane Reconciled)  
> **Status:** Active / Specification & Architecture  
> **Target Platform:** `chat.deepseek.com` (Web Client)

---

## 1. Executive Summary

This document specifies the reverse-engineered streaming protocol utilized by the DeepSeek Web Chat interface (`chat.deepseek.com`). DeepSeek does not use standard OpenAI chunk streaming (`choices[0].delta.content`); instead, it employs a custom **JSON Patch stream over Server-Sent Events (SSE)** with a multi-event control plane (`ready`, `update_session`, `message`, `finish`, `title`, `close`).

Production traffic primarily runs over `XMLHttpRequest` (`/api/v0/chat/completion`, `edit_message`, `regenerate`, `continue`, `resume_stream`), retaining `fetch` as fallback. Streams deliver granular object mutations, array splices, status transitions, and fragment updates directly to the browser client.

---

## 2. Platform Boundary & Pipeline Architecture

StreamArchive strictly decouples transport framing from platform semantics:

```text
┌─────────────────────────────────────────────────────────────┐
│                      MAIN World Tap                         │
│  window.fetch / XMLHttpRequest (Synchronous Passive Clone)  │
│  Preserves arguments via Reflect.apply, single-install sentinel
└──────────────────────────────┬──────────────────────────────┘
                               │ CustomEvent Envelope
┌──────────────────────────────▼──────────────────────────────┐
│                    ISOLATED World Script                    │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │                 GenericSseDecoder                   │   │
│   │ WHATWG SSE Framing (data:, event:, CRLF, comments) │   │
│   └──────────────────────────┬──────────────────────────┘   │
│                              │ SseEvent (event, data, id)   │
│   ┌──────────────────────────▼──────────────────────────┐   │
│   │              DeepSeekProtocolDecoder                │   │
│   │  SSE Control Plane: ready, message, finish, close...│   │
│   │  Status Authority: status (authoritative)           │   │
│   │                    quasi_status (advisory only)     │   │
│   │  Anti-Recall Guard: Intercepts late CONTENT_FILTER  │   │
│   │  JSON Patch Parsing, Atomic Bounds, Safe -1 Indices │   │
│   │  Dual Content Shape (Variant A & Variant B)         │   │
│   │  Live Runtime Acceptance Gate (not_observed -> live)│   │
│   └──────────────────────────┬──────────────────────────┘   │
│                              │ DeepSeekSemanticEvent[]      │
└──────────────────────────────┼──────────────────────────────┘
                               │ chrome.runtime.sendMessage (FIFO queue)
┌──────────────────────────────▼──────────────────────────────┐
│              Background Service Worker (MV3)                │
│   Composite Stream Map: ${producerSessionId}:${streamId}    │
│   Aggregated Diagnostics & Independent Warnings Push        │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Streaming Framing & Patch Grammar

### 3.1 Packet Envelope
Each SSE frame delivers an envelope containing:
- `event` *(string, optional)*: SSE control event name (`ready`, `update_session`, `message`, `finish`, `title`, `close`). Defaults to `message`.
- `p` *(path, optional string)*: Slash-delimited path indicating target in the state tree (e.g. `response/fragments/0/content`, `response/content`).
- `o` *(operation, optional string)*: Mutation opcode (`SET`, `APPEND`, `REPLACE`, `BATCH`). Strictly whitelisted.
- `v` *(value, any)*: Payload applied at path `p`.

### 3.2 Supported Operations & Hardened Bounds

| Opcode | Target Type | Behavior | Hardened Bounds |
| :--- | :--- | :--- | :--- |
| `SET` | Any | Overwrites target at path with `v`. Auto-grows arrays up to `MAX_ARRAY_INDEX`. | Array Index $\le 1000$<br>Fragments $\le 1000$ (atomic reject) |
| `APPEND` | String | Appends string `v` to existing string (`target += v`). | Path Depth $\le 32$ |
| `APPEND` | Array | Appends items from array `v` to target array (`target.push(...v)`). | Array Length $\le 1000$ (atomic reject) |
| `REPLACE` | Any | Equivalent to `SET`. Overwrites existing object/value. | Prototype Keys Forbidden |
| `BATCH` | Array | Recursively executes array of child patches. | Max Items $\le 128$ (atomic reject)<br>Max Depth $\le 8$ |

Unknown opcodes (e.g. `DELETE`, `MUTATE`) are rejected without mutating state and record `unknown_operation` warnings. Operation whitelist validation occurs FIRST before any pathless branch. Explicit pathless `SET` or `REPLACE` is rejected atomically (`explicit_pathless_non_append`).

### 3.3 Path Syntax & Negative Index Resolution

1. **Relative & Absolute Paths:**
   - Paths may be prefixed with `response/` or start directly (e.g. `fragments` vs `response/fragments`). The parser normalizes them.
2. **Safe Negative Array Indexes:**
   - DeepSeek frequently addresses the active fragment using `-1` (e.g. `response/fragments/-1/content`).
   - `-1` on an empty array initializes the first element at index 0.
   - For an array of length $L$, index $-n$ resolves to $L - n$.
   - Out-of-bounds negative indices ($|n| > L$) record `invalid_negative_index` warnings and are safely ignored without mutating or corrupting the array.
3. **Pathless String Append:**
   - DeepSeek often sends pathless text tokens: `{"v": " world"}` where `p` is omitted or empty.
   - When `p` is missing and `typeof v === 'string'`, the string is appended directly to the tail fragment (Variant A) or `content` (Variant B).
4. **Inherited Paths in BATCH:**
   - A parent patch `{ p: "response", o: "BATCH", v: [ ... ] }` causes child patches with `p: "status"` to resolve as `response/status`.

### 3.4 Status Authority vs. Provisional `quasi_status`

A critical protocol distinction exists between authoritative terminal status and provisional advisory indicators:

1. **`status` is Authoritative:**
   - The values `FINISHED`, `CONTENT_FILTER`, `CONTEXT_LENGTH_EXCEEDED`, `INCOMPLETE`, and `TIMEOUT` on `status` are semantic terminal sources that conclude the stream.
2. **`quasi_status` is Purely Advisory:**
   - DeepSeek often issues `quasi_status: "FINISHED"` prior to completing internal safety review or while trailing tokens are in transit.
   - **`quasi_status` NEVER irrevocably terminates the stream as completed.** Doing so would introduce an anti-recall race condition where a late censorship batch (`status = CONTENT_FILTER`) is dropped.
3. **Trailing Control Events Tolerance:**
   - Legal control events (`finish`, `close`, `update_session`, `title`) arriving after terminal resolution are legal and do NOT increment `eventsAfterTerminalCount`.

| Status Code | Authority | Meaning | Mapped Terminal Reason |
|:---|:---|:---|:---|
| `FINISHED` | Authoritative Terminal | Generation concluded successfully (unless pending flags set). | `completed` (or `incomplete` if flags set) |
| `CONTENT_FILTER` | Authoritative Terminal | Generation halted or replaced by safety filter. | `filtered` |
| `CONTEXT_LENGTH_EXCEEDED` | Authoritative Terminal | Prompt or response exceeded model context limit. | `truncated_context_limit` |
| `INCOMPLETE` | Authoritative Terminal | Stream interrupted or incomplete on server. | `incomplete` |
| `TIMEOUT` | Authoritative Terminal | Server or gateway connection timed out. | `timeout` |
| `WIP` | Non-Terminal | Work-in-progress indicator; stream continues receiving chunks. | None (active) |
| `AUTO_CONTINUE` | Non-Terminal | Platform auto-continue mode; generation continues. | None (active) |
| `quasi_status` | Advisory / Provisional | Pre-terminal preview indicator; ignored for stream termination. | None (advisory only) |

### 3.5 SSE Control Events Plane

DeepSeek SSE stream delivers structured control events:
- `ready`: Emits `request_message_id`, `response_message_id`, and `model_type`. The decoder records message IDs immediately and bypasses patch parsing.
- `message`: Standard JSON Patch payload (`p`, `o`, `v`).
- `finish`: Trailing completion indicator.
- `close`: Final stream closing frame with optional UI click behaviors.
- `update_session`: Carries `updated_at` timestamp.
- `title`: Carries conversation title generation updates.
- Unknown SSE events: Diagnostically logged under `unknownSseEventNames` with warning `unknown_sse_event_name` without crashing.

### 3.6 Candidate Predicate & Normalized Endpoint Matching

- `isDeepSeekGenerationEndpoint(url)` performs exact normalized matching against declared endpoints (`/api/v0/chat/completion`, `edit_message`, `regenerate`, `continue`, `resume_stream`).
- `normalizePathname(url)` strips query parameters, hash fragments, and redundant slashes, and eliminates trailing slashes.
- Candidate predicate evaluates endpoint identity independently of `meta.contentType`, allowing streams with `application/octet-stream` or custom headers to be captured.

---

## 4. Dual Upstream Content Shapes & Projection

DeepSeek production traffic can deliver generated text in two distinct structures:

### 4.1 Variant A: Typed Fragments Array (`fragments[]`)
The response maintains an array of discrete typed fragments:
```typescript
export interface DeepSeekFragment {
  id?: number | string;
  type: string; // 'RESPONSE' | 'THINK' | 'TIP' | 'TEMPLATE_RESPONSE'
  content: string;
  style?: string;
}
```
- **Whitelist Projection:**
  - `type === 'RESPONSE'`: Assistant answer text.
  - `type === 'THINK' | 'THINKING'`: Model reasoning / chain of thought.
  - Excluded types: `TIP`, `TEMPLATE_RESPONSE`, `REQUEST`, `TOOL_*`, `SEARCH*`.
  - Naive regex emoji heuristics (`^[⚠⛔]`) are strictly forbidden.

### 4.2 Variant B: Direct Top-Level Response Fields
DeepSeek alternative/fallback streaming formats emit text directly to top-level fields:
- `response.content`: Assistant answer text.
- `response.thinking_content`: Model reasoning text.

### 4.3 Unified Content Projection
`projectDeepSeekState(state)` dynamically inspects state:
1. Inspects `fragments[]` first. If present and producing content, projects with `projectionSource: 'fragments'`.
2. If fragments are empty, falls back to `content` and `thinking_content` with `projectionSource: 'top_level'`.
3. If neither contains text, yields `projectionSource: 'none'`.

---

## 5. Terminal Event Taxonomy & Stream Sequencing

### 5.1 Strict Monotonic Stream Sequencing & Stream Isolation
To prevent race conditions, out-of-order execution, and corruption:
- `streamSequence` must advance monotonically: `0 -> 1 -> 2 -> ...`.
- Sequence 0 is consumed exclusively by `open`.
- **Unclassified SSE Streams:** Endpoints that are not generation streams are tracked in `unclassifiedStreamIds`. Their chunks are dropped silently and never increment `orphanEventsCount`. Their URLs are reported to Background via `MESSAGE_RECORD_PROTOCOL_OBSERVATION`.
- **Terminated Stream Tombstones:** Terminated streams are retained in a 128-item ring buffer. Chunks arriving on terminated streams increment `eventsAfterTerminalCount` rather than `orphanEventsCount`.
- **Orphan Chunks:** Genuinely unassociated chunks arriving without an active or unclassified session increment `orphanEventsCount` and are dropped.
- **Sequence Gaps:** Any sequence gap transitions the stream to `degraded` and ceases decoder feeding.

### 5.2 Disambiguated Terminal Events
The terminal lifecycle distinguishes four explicit semantic event types:

| Semantic Event Type | Trigger Condition | Status Code |
|---|---|---|
| `stream_finished` | Terminal status (`FINISHED`, `CONTENT_FILTER`, etc.) or `data: [DONE]`. | Status code |
| `stream_transport_ended` | HTTP connection completed normally without explicit protocol completion sentinel. | `TRANSPORT_ENDED` |
| `stream_interrupted` | User clicked "Stop" button (`transport_abort`) or low-level network failure (`transport_error`). | `transport_abort` / error |
| `stream_degraded` | Stream degraded due to sequence gap or critical anomaly. | `stream_degraded` |

> [!IMPORTANT]
> **Client Abort is NEVER Censorship:** A client-side abort (e.g. Stop button) is cleanly reported as `stream_interrupted` and is never conflated with `CONTENT_FILTER` or refusal templates.

---

## 6. Censorship & Anti-Recall (Detect-Before-Apply)

### 6.1 The Censorship Pattern
When DeepSeek's server-side safety classifier triggers during or after generation, it issues a destructive `BATCH` patch after the full text and thinking tokens have already been streamed:
```json
{
  "p": "response",
  "o": "BATCH",
  "v": [
    {
      "p": "fragments",
      "o": "SET",
      "v": [
        {
          "type": "TEMPLATE_RESPONSE",
          "content": "I apologize, but I cannot fulfill this request based on safety guidelines."
        }
      ]
    },
    {
      "p": "status",
      "o": "SET",
      "v": "CONTENT_FILTER"
    }
  ]
}
```

### 6.2 The Detect-Before-Apply Guard
1. **Bounded Structural Scan:** Before passing any patch to `PatchApplier`, `DeepSeekProtocolDecoder` executes a bounded scan (max depth 5, max nodes 50, `WeakSet` cycle protection).
2. **Structural Checks Only:**
   - `obj.status === 'CONTENT_FILTER'` or `obj.quasi_status === 'CONTENT_FILTER'`
   - `p === 'status' | 'response/status' | 'quasi_status'` with `v === 'CONTENT_FILTER'`
   - `obj.type === 'TEMPLATE_RESPONSE'`
   - Literal text mentioning `"CONTENT_FILTER"` within assistant generated output does NOT trigger censorship.
3. **State Freeze (`lastGood`):** If a filter marker is detected, the decoder immediately freezes the **pre-mutation state**:
   - Complete un-censored `answer` text and `thinking` text.
   - Projection source tag (`projectionSource`).
   - Exact fragments snapshot.
   - Message ID and session ID.
   - Trigger timestamp and reason.
4. **Event Emission:** A `filter_triggered` semantic event is dispatched containing the frozen `lastGood` state.

---

## 7. Diagnostics & Double-Counting Immunity

To ensure telemetry accuracy:
- The Background Service Worker maintains `streamDiagnosticsMap` keyed by composite key: `${producerSessionId}:${streamId}`.
- Each content script batch delivers an absolute snapshot for its stream.
- Independent diagnostics snapshots are dispatched when warnings increase, even if a frame emitted 0 semantic events.
- Distinct sets (`seenFetchStreams`, `seenXhrStreams`, `activeTransportStreams`) track live transport counts accurately.

---

## 8. Live Runtime Acceptance Gate

The extension explicitly separates automated test verification from live runtime state:

- **Automated Protocol Tests:** `Verified (132+ passed)` (static badge confirming build-time test integrity).
- **Current Live Runtime State:** Dynamic state of live traffic on `chat.deepseek.com`:
  - `not_observed`: Default initial state. No valid live DeepSeek stream processed in current session.
  - `live_observed`: Multi-factor gate passed: known generation endpoint + at least 1 valid SSE frame + at least 1 valid patch op + content projection (answer/thinking) or explicit terminal status reached.
  - `degraded`: Sequence gaps, threatening protocol warnings, or integrity violations encountered.
  - `incompatible`: Upstream breaking changes detected.

---

## 9. History Endpoint Protocol (`/api/v0/chat/history_messages`)

In addition to live SSE streams, DeepSeek provides REST endpoints for browsing previous conversation turns:
- **Endpoint:** `https://chat.deepseek.com/api/v0/chat/history_messages`
- **Method:** `GET`
- **Parameters:** `chat_session_id` (UUID), `cache_version`, etc.
- **Payload Structure:** Returns `chat_session` metadata and `chat_messages` array with structured `fragments` (`THINK`, `RESPONSE`, `REQUEST`), `parent_id` links, and status.
- **Passive Ingestion:** StreamArchive intercepts these responses passively via MAIN-world taps without inspecting Authorization headers or issuing out-of-band requests. See [HISTORY_RECONCILIATION.md](./HISTORY_RECONCILIATION.md) for full wire schema, parsing, and tree reconciliation rules.

