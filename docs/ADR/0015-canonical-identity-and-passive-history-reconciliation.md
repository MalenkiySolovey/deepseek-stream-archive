# ADR 0015: Canonical Identity Model and Passive History Reconciliation

## Status
Accepted

## Context
In this architecture, the Raw Journal provides a verified, append-only, and crash-durable evidence log of raw transport stream chunks. 

In the streaming architecture, the system must transform observed wire data into queryable domain entities:
- `Conversation`
- `Message`
- `ResponseRevision`
- `RecoveryEvent`

However, bridging raw transport streams with long-term user conversations presents several core architectural challenges:
1. **The Three Truths Separation:**
   - **Raw Evidence:** Immutable, append-only transport bytes and frames observed on the network.
   - **Live Canonical Record:** Streaming events assembled in real-time by the extension (subject to interruptions, tab crashes, and live censorship triggers).
   - **Server History:** Authoritative server-side tree returned by DeepSeek when loading past chats, reflecting server-persisted message IDs, parent links, and potential server-side content filter replacements (`CONTENT_FILTER`).
2. **Security & Privacy Boundaries:** DeepSeek authentication uses Bearer tokens and session tokens. Under no circumstances may the extension read `localStorage.userToken`, store bearer tokens, or initiate active out-of-band `fetch` requests to DeepSeek APIs from the background worker. All history data must be obtained strictly through *passive observation* of requests already initiated by the web application.
3. **Identity & Branching Lifecycles:** Live stream events initially have temporary or provisional identities (`provisionalSessionId`, `streamId`) and only later receive server-side `message_id` and `chat_session_id`. Conversations contain branched trees of prompts and regenerations. Reconciling server history must never collapse or erase sibling branches or overwrite censored "last-good" responses.

---

## Decision

We adopted the following architecture for canonical recording and history reconciliation:

### 1. Pure Passive Observation Architecture
- **Zero Token Extraction:** The extension never inspects or extracts `Authorization: Bearer <token>`, `localStorage.userToken`, or user cookies.
- **Zero Background Polling / Active Fetches:** The background service worker never initiates network requests to DeepSeek API endpoints.
- **Transparent Wire Tap:** Content scripts passively intercept requests to `/api/v0/chat/history_messages` initiated naturally by DeepSeek's frontend.
- **Strict Origin & Endpoint Lockdown:** Only exact matches against `https://chat.deepseek.com/api/v0/chat/history_messages` with allowlisted query parameters (`chat_session_id`, `cache_version`, etc.) are processed. Fragment identifiers, hash fragments, and foreign query keys are rejected.

### 2. Message Identity Model & Provisional State
- Every canonical `Message` entity supports:
  - `id`: Deterministic local UUID.
  - `remoteId`: Authoritative server message ID (e.g. `12345678`).
  - `remoteParentId`: Authoritative server parent message ID.
  - `parentId`: Local UUID pointing to parent `Message` in the conversation tree.
  - `identityState`: `'provisional' | 'reconciled'`. Live streamed messages start as `'provisional'` and upgrade to `'reconciled'` upon server history confirmation.
  - `sourceRawStreamKey`: Foreign key linking to the underlying `RawStreamRecord`.
  - `status`: Rich terminal status (`finished`, `filtered`, `incomplete`, `timeout`, `context_length_exceeded`, `interrupted`, `degraded`, `unknown`).

### 3. Canonical Revision Recorder & Anti-Recall (Last-Good Invariant)
- `CanonicalRecorder` consumes semantic events in real time.
- Upon receiving a `filter_triggered` event (or equivalent censorship event):
  1. The pre-filter text and thinking content is marked as an immutable revision with `isLastGood = true`.
  2. A canonical `RecoveryEvent` is generated containing `recoveredText`, `recoveredThinking`, and censorship metadata.
  3. The active message status transitions to `filtered`.
- Even if the server later replaces the text with a generic template response (`CONTENT_FILTER`), the local database retains the last-good revision, preserving user data against server-side retro-censorship.

### 4. History Reconciler & Two-Pass Tree Resolution
- When a passive history observation is received:
  1. **Pass 1 (Message Identity & Revision Ingestion):** Matches existing local messages by `remoteId`. If an existing message was recorded live with a last-good revision, that uncensored revision is preserved and not overwritten by a censored server template. New server messages are created with `identityState = 'reconciled'`.
  2. **Pass 2 (Parent Tree Linkage):** Maps each message's `remoteParentId` to the local parent message's `id`. Sibling branches (e.g. alternative regenerations) are preserved and never collapsed or deleted.
- **Strict Idempotency:** Repeated deliveries of the same history payload produce zero duplicate messages or revisions.

### 5. Deterministic Storage Indexing (Schema v3)
- IndexedDB schema upgraded to `DB_VERSION = 3`.
- Added compound index `conversationId_remoteId` (`['conversationId', 'remoteId']`) to the `messages` object store to enable fast, unambiguous lookups during history reconciliation.

---

## Consequences

### Positive
- **Guaranteed Anti-Censorship:** Content filtered in-flight is preserved as `isLastGood = true` revisions and `RecoveryEvent`s without losing server lineage.
- **Zero Risk of Credential Leaks:** Passive observation eliminates credential leakage, token storage, and session hijacking vectors entirely.
- **Preserved Conversation Trees:** Full branching histories with alternative regenerations remain intact.
- **Replay & Audit Verification:** Raw stream records can be deterministically replayed and promoted to canonical entities via `evaluateCanonicalPromotion()`.

### Negative / Trade-offs
- History reconciliation only occurs when the user browses their chat history in the DeepSeek web interface (since the extension never performs proactive background fetches).
- Provisional messages created during network drops before DeepSeek assigns a `message_id` require explicit reconciliation upon subsequent history visits.
