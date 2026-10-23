# Canonical Domain Model & Anti-Recall Architecture

## Overview
StreamArchive introduces the **Canonical Storage Boundary** for DeepSeek StreamArchive. While the Raw Journal (`raw_streams`, `raw_batches`) records immutable, append-only transport bytes and frames, the Canonical Model translates these observations into a structured, queryable, and branch-aware conversation history.

---

## 1. Domain Entities

```
+-----------------------------------------------------------------------------+
|                               Conversation                                  |
| id: string (UUID)                                                           |
| title: string                                                               |
| createdAt: number, updatedAt: number                                        |
| remoteId?: string (DeepSeek chat_session_id)                                |
| metadata?: Record<string, unknown>                                          |
+-----------------------------------------------------------------------------+
                                      |
                                      | 1:N
                                      v
+-----------------------------------------------------------------------------+
|                                  Message                                    |
| id: string (UUID)                                                           |
| conversationId: string                                                      |
| role: 'user' | 'assistant' | 'system'                                       |
| createdAt: number, updatedAt: number                                        |
| parentId?: string (local tree link)                                         |
| remoteId?: string (DeepSeek message_id)                                     |
| remoteParentId?: string (server parent message_id)                          |
| identityState: 'provisional' | 'reconciled'                                 |
| sourceRawStreamKey?: string (composite producerSessionId:streamId)          |
| status: 'streaming' | 'finished' | 'filtered' | 'incomplete' | ...         |
+-----------------------------------------------------------------------------+
               |                                              |
          1:N  |                                         0:N  |
               v                                              v
+-----------------------------+               +-------------------------------+
|       ResponseRevision      |               |         RecoveryEvent         |
| id: string (UUID)           |               | id: string (UUID)             |
| messageId: string           |               | messageId: string             |
| revisionIndex: number       |               | capturedAt: number            |
| text: string                |               | originalMessageId: string     |
| thinking?: string           |               | recoveredText: string         |
| isLastGood?: boolean        |               | recoveredThinking?: string    |
| capturedAt: number          |               | triggerReason: string         |
| source: CaptureSource       |               | filterMetadata?: ...          |
+-----------------------------+               +-------------------------------+
```

### Key Entity Invariants:
1. **`Conversation`**:
   - Represents a logical thread of interaction.
   - Tied to `remoteId` (DeepSeek's `chat_session_id`) once observed.
2. **`Message`**:
   - Represents a single turn in the tree.
   - May branch (multiple child messages sharing the same `parentId`), accommodating DeepSeek's regeneration and edit features.
   - Tracks `identityState`:
     - `'provisional'`: Created from live streaming before server reconciliation.
     - `'reconciled'`: Verified against authoritative server history.
   - Preserves both `remoteId` (server ID) and `parentId` (local tree link).
3. **`ResponseRevision`**:
   - Captures text and reasoning snapshots over time.
   - Append-only and ordered by `revisionIndex`.
   - `isLastGood = true`: Flagged on the last complete or uncensored revision before a server-side content filter intervention or stream termination.
4. **`RecoveryEvent`**:
   - Recorded when DeepSeek triggers censorship or content replacement.
   - Stores pre-censorship text and reasoning to guarantee user recovery.

---

---

## 2. Storage Schema & Indexing (Schema Version 5)

The IndexedDB schema is managed in `src/storage/schema.ts` and `src/storage/db.ts`:

- **Database Name:** `deepseek_streamarchive_db`
- **Database Version:** `5`
- **Object Stores:**
  - `conversations` (keyPath: `id`)
    - index: `remoteId`
    - index: `updatedAt`
  - `messages` (keyPath: `id`)
    - index: `conversationId`
    - index: `remoteId`
    - index: `parentId`
    - index: `conversationId_remoteId` (compound index: `['conversationId', 'remoteId']`)
    - index: `identityState` (`'provisional'` vs `'reconciled'`)
  - `revisions` (keyPath: `id`)
    - index: `messageId`
    - index: `capturedAt`
  - `recovery_events` (keyPath: `id`)
    - index: `messageId`
    - index: `capturedAt`
  - `canonical_checkpoints` (keyPath: `streamKey`)
    - index: `updatedAt`
  - `raw_streams` (keyPath: `id`)
  - `raw_batches` (keyPath: `id`)

### Canonical Checkpoint Ledger (`canonical_checkpoints`):
Tracks live progressive persistence progress per active stream:
- **Ledger Record:** `{ streamKey, producerSessionId, rawStreamId, conversationId, messageId, lastCommittedSeq, createdAt, updatedAt }`.
- **Sequence Verification:**
  - Initial checkpoint requires `checkpointSeq === 0`.
  - Monotonic progression requires `checkpointSeq === lastCommittedSeq + 1`.
  - Retried checkpoint with `checkpointSeq === lastCommittedSeq` returns an idempotent ACK without re-writing.
  - Checkpoints with gaps (`checkpointSeq > lastCommittedSeq + 1`) or regressions (`checkpointSeq < lastCommittedSeq`) reject immediately with `checkpoint_sequence_gap`.
- **Immutable Revision Conflict Prevention:**
  - If a revision with the given `id` already exists, `isRevisionPayloadIdentical()` verifies text, thinking, source, index, and fingerprint.
  - If payload is identical, it is treated as an idempotent re-put.
  - If payload conflicts, the checkpoint transaction aborts and rejects with typed error `revision_conflict`.
- **Immutable Recovery Event Conflict Prevention:**
  - If a recovery event with the given `id` already exists, `isRecoveryEventIdentical()` verifies trigger kind, detected time, and revision pointer. Conflicting events reject with `recovery_event_conflict`.

---

## 3. The Last-Good Invariant & Canonical Message Merge Policy

DeepSeek's streaming protocol emits server-side censorship events in two forms:
1. **Live Stream Events:** SSE patches transitioning message status to `CONTENT_FILTER`, often accompanied by an abrupt close or replacement of text.
2. **History Endpoints:** Subsequent requests to `/api/v0/chat/history_messages` replace the censored response with a generic canned notice (`status: 'CONTENT_FILTER'`).

### Anti-Recall Mechanism:
- When `CanonicalRecorder` detects `filter_triggered`:
  - It creates an immutable `ResponseRevision` marked with `isLastGood: true`, containing all streamed text and reasoning up to the trigger.
  - It records a `RecoveryEvent` documenting the interception time, stream ID, and trigger reason.
  - The message status is set to `'filtered'`.
- When `HistoryReconciler` processes the server's history response:
  - If a local message already has an `isLastGood` revision, **the censored server template does NOT overwrite the last-good revision**.
  - A new revision may be appended documenting the server's template response, but the last-good revision remains preserved as authoritative user evidence.

### Canonical Message Merge Policy (`mergeCanonicalMessage`):
- **Identity Hierarchy:** Server history overrides provisional state (`reconciled > provisional`). A reconciled turn is never demoted to provisional.
- **Linkage Retention:** Existing `parentId`, `remoteParentId`, and `sourceRawStreamKey` are strictly preserved if incoming data lacks them.
- **Non-Destructive Status Transitions:** If an existing turn has status `'filtered'`, server history updates cannot downgrade it to `'finished'`, preserving user recovery truth.

---

## 4. Replay Promotion & Archive Read Queries

### Replay Promotion Plan (`ReplayPromotionPlan`):
In addition to live streaming ingestion, the system supports deterministic reconstruction of canonical entities from raw journal logs via `replayAndReconstructCanonical()`.
- Promotion plan evaluation is governed by `evaluateCanonicalPromotion(record)`.
- Promotion applies atomically across `conversations`, `messages`, `revisions`, and `recovery_events` via `storageRepo.applyReplayPromotionPlan(plan)` in a single transaction.

### Metadata-First Archive Read Queries:
To support scalable browsing without loading multi-megabyte text payloads into UI memory at once, the repository exposes metadata-first queries:
1. **`listArchiveConversations(options)`:**
   - Navigates the `updatedAt` index descending (`'prev'`) using cursor pagination.
   - Computes `messageCount`, `hasRecoveredContent`, and preview snippet without fetching all revision bodies.
2. **`getArchiveConversation(id)`:**
   - Retrieves full tree hierarchy and message metadata (`ArchiveMessageSummary`).
   - Automatically selects preferred revision per message (`selectPreferredRevision` prioritizes `isLastGood === true`, then highest `revisionIndex`).
3. **`getRevisionContent(revisionId)`:**
   - On-demand loader for individual revision text, thinking traces, and timestamps.

---

## 5. Checkpoint Delivery Integrity & Terminal Locking

To prevent sequence gaps and divergent payload replays:
1. **Sealed Checkpoints & Terminal Finalization:** The `CanonicalStreamCoordinator` seals checkpoint sequences immutably upon first delivery attempt. Under no circumstances does a sealed checkpoint mutate `isFinal`, revisions, or sequences in place. On NACK or transport failure, the exact sequence and payload are retried with bounded exponential backoff (`[250ms, 1s, 4s, 10s, 30s]`) without advancing sequence numbers. If a terminal event arrives while retrying a pending checkpoint sequence $N$, the coordinator completes delivery and receipt of ACK for sequence $N$, then emits sequence $N+1$ marked `isFinal: true`, guaranteeing sequence continuity without gaps or conflicts. When the stream completes, terminal retry timers survive coordinator disposal until an authoritative ACK is received or max retries are exhausted. Callers await `awaitFinalPersistence()` to guarantee terminal commit before teardown.
2. **Durable Semantic Checkpoint Fingerprints:** A SHA-256 fingerprint of the checkpoint payload (covering conversation title/remoteId, message parentId, remoteParentId, identityState, content, revisions, and recoveryEvents) is computed before opening the IndexedDB transaction and stored in `STORE_CANONICAL_CHECKPOINTS`. Re-deliveries of committed sequences are checked for fingerprint matching: matching fingerprints succeed idempotently; differing fingerprints reject with `checkpoint_conflict`. Checkpoints with `seq < lastCommittedSeq` are rejected as `stale_checkpoint`.
3. **Terminal Checkpoint Locking:** Once a terminal checkpoint (`isTerminal: true`) commits, the repository locks the stream against any higher sequence numbers (`terminal_checkpoint_locked`), ensuring exactly one final checkpoint per stream.
4. **History Staging Manifests & Completeness Barrier (Schema v7):** Incremental history slices require an explicit manifest stored in `STORE_HISTORY_STAGING_MANIFESTS` tracking expected batches and messages. Bounded history slices are staged in `STORE_HISTORY_STAGING` and committed atomically into canonical stores via `commitHistoryStagingPlan()`, requiring `receivedBatchCount === expectedBatchCount`. If incomplete, the commit transaction aborts and clears staging.
