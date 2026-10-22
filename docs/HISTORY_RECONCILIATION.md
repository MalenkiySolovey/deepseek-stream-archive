# Passive History Reconciliation & Tree Resolution

## Overview
StreamArchive implements **Passive History Reconciliation**. DeepSeek's web frontend fetches past conversations via `/api/v0/chat/history_messages`. Rather than attempting to scrape user tokens or poll this endpoint in the background, DeepSeek StreamArchive passively taps responses already requested by the browser, parsing and reconciling them into the local canonical conversation store.

---

## 1. Security & Passive Observation Principles

### Hard Architectural Boundaries
1. **Zero Token Inspection:**
   - The extension never inspects `Authorization: Bearer ...` headers, `localStorage.userToken`, cookies, or session storage.
2. **Zero Proactive Network Requests:**
   - The service worker never issues `fetch()` or `XMLHttpRequest` calls to DeepSeek APIs.
   - History data is ingested **solely** when the user naturally interacts with the web app.
3. **Endpoint Allowlisting & Sanitization:**
   - Origin must strictly be `https://chat.deepseek.com`.
   - Pathname must strictly be `/api/v0/chat/history_messages`.
   - Query parameters are strictly filtered against an allowlist (`chat_session_id`, `cache_version`, `before_message_id`, etc.).
   - URLs containing fragment identifiers (`#`) or unexpected search parameters are dropped.

---

## 2. DeepSeek History Wire Schema

When DeepSeek returns history messages, the payload structure adheres to:

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "biz_code": 0,
    "biz_msg": "success",
    "chat_session": {
      "id": "1a2b3c4d-...",
      "title": "Discussion on Quantum Computing",
      "created_at": 1728345600,
      "updated_at": 1728345700
    },
    "chat_messages": [
      {
        "id": 1001,
        "chat_session_id": "1a2b3c4d-...",
        "parent_id": null,
        "role": "USER",
        "content": "Explain quantum superposition",
        "created_at": 1728345601
      },
      {
        "id": 1002,
        "chat_session_id": "1a2b3c4d-...",
        "parent_id": 1001,
        "role": "ASSISTANT",
        "fragments": [
          { "type": "THINK", "content": "The user is asking about..." },
          { "type": "RESPONSE", "content": "Quantum superposition is..." }
        ],
        "status": "FINISHED",
        "created_at": 1728345605
      }
    ]
  }
}
```

### Parser Responsibilities (`DeepSeekHistoryParser`):
- Normalizes IDs via `normalizeRemoteId`: numbers (`1001`) and trimmed strings ($\le 128$ chars) are unified into string keys.
- Normalizes roles (`USER` -> `'user'`, `ASSISTANT` -> `'assistant'`).
- Concatenates fragments: `THINK` into `thinking`, `RESPONSE` into `text`. `REQUEST` fragments are never mixed into assistant responses.
- Detects server censorship status (`CONTENT_FILTER` / template notices). Assistant messages without explicit terminal status default to `'unknown'` (never prematurely `'finished'`).
- Handles dual session ID sources: resolves from payload or query params when `chat_session` wrapper is omitted.
- **Duplicate Remote Message ID Handling:**
  - If duplicate entries have identical content, role, and parent, they are deduplicated.
  - If duplicate entries have conflicting contents or roles, the parser rejects the payload as corrupt (`return null`), preventing inconsistent message tree states.
- Validates schema structure, rejecting payloads with non-zero response codes or malformed fields.

---

## 3. Bounded Transport & Concurrency Control

### Bounded Chunked Transport Across Boundary
- To prevent main thread freezing on multi-megabyte history payloads, the MAIN world network interceptor chunks responses into $\le 64\text{ KB}$ segments (`MAX_HIST_CHUNK_SIZE`).
- Dispatches sequential envelopes (`history.open`, `history.chunk`, `history.complete`, `history.abort`) across `window.postMessage`.
- Bounded memory limits: max payload 25MB, max 1000 chunks.
- In `src/transport/fetch/capture.ts`, cloned bodies are read using an incremental `TextDecoder` stream reader that aborts safely if the 25MB ceiling is exceeded.

### Background Concurrency Serialization
- The background service worker queues incoming reconciliation requests per remote session ID using `historyQueuesBySessionId = new Map<string, Promise<void>>()`.
- Prevents race conditions from simultaneous tab loads or rapid navigation.

---

## 4. Reconciliation Algorithm (`HistoryReconciler`)

Reconciliation builds an in-memory `HistoryReconciliationPlan` committed in a single atomic transaction:

### Pass 1: Identity & Message Ingestion
1. Finds or creates the local `Conversation` matching `session.sessionId`.
2. For each message in `messages`:
   - Queries IndexedDB using the compound index `['conversationId', 'remoteId']`.
   - **Case A: Existing Local Message Found (`mergeCanonicalMessage`):**
     - Upgrades `identityState` to `'reconciled'` (enforces `reconciled > provisional`).
     - Retains existing tree links (`parentId`, `remoteParentId`, `sourceRawStreamKey`) if incoming payload lacks them.
     - Updates `remoteParentId` with server's `parentId`.
     - For user messages, preserves prompt text in `Message.content`.
     - **Non-Destructive Status Transitions:** If local message status is `'filtered'`, server history updates cannot downgrade it to `'finished'`.
     - If the message contains an `isLastGood` revision and the server message is a `CONTENT_FILTER` template, the server text is **not** permitted to overwrite or demote the uncensored `isLastGood` revision.
     - Compares incoming content against existing revisions via `contentFingerprint` (`fp_<len>_<hash>`). If identical, 0 revisions created. If content evolved, appends a new revision with `source: 'history'`.
   - **Case B: New Server Message (Not Previously Observed):**
     - Creates a new `Message` entity with `identityState: 'reconciled'`.
     - Sets `remoteId = String(msg.messageId)` and `remoteParentId = String(msg.parentId)`.
     - Appends an initial `ResponseRevision` containing the parsed text, thinking, and `contentFingerprint`.

### Pass 2: Tree Linkage & Cycle Prevention
1. Resolves `parentId` for all messages in the conversation:
   - Maps `remoteParentId` to local parent `id`.
   - **Ancestor Cycle Detection:** Traverses parent pointers from proposed parent back to root. If a cycle is detected (e.g. A $\to$ B $\to$ A), the cyclic link is broken to preserve a valid tree graph.
2. **Branching Preservation:**
   - In DeepSeek, users can branch by editing a prompt or clicking "Regenerate".
   - This creates multiple child messages with the same `parentId`.
   - Sibling branches are retained and never collapsed, overwritten, or pruned.

### Pass 3: Atomic Transaction Commit
- The entire plan (`conversation`, `messagesToPut`, `revisionsToPut`) is committed atomically via `storageRepo.applyHistoryReconciliationPlan(plan)`, eliminating partial write states.

### Idempotency Guarantee
- Delivering the identical history payload repeatedly produces zero duplicate messages, zero duplicate revisions, zero duplicate updates, and zero corrupted tree pointers.
