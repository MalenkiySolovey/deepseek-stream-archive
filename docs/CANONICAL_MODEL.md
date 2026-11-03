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
| projectionState?: 'logical' | 'provisional_logical' | 'unmatched_capture' | 'attempt_only' |
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

## 2. Storage Schema & Indexing (Schema Version 8)

The IndexedDB schema is managed in `src/storage/schema.ts` and `src/storage/db.ts`:

- **Database Name:** `StreamArchiveDB`
- **Database Version:** `8`
- **Object Stores:**
  - `conversations` (keyPath: `id`)
    - index: `remoteId`
    - index: `updatedAt`
  - `messages` (keyPath: `id`)
    - index: `conversationId`
    - index: `remoteId`
    - index: `parentId`
    - index: `createdAt`
    - index: `conversationId_remoteId` (compound index: `['conversationId', 'remoteId']`)
    - index: `identityState` (`'provisional'` vs `'reconciled'`)
    - index: `projectionState` (`'logical'`, `'provisional_logical'`, `'unmatched_capture'`, `'attempt_only'`)
  - `revisions` (keyPath: `id`)
    - index: `messageId`
    - index: `capturedAt`
    - index: `isLastGood`
  - `recovery_events` (keyPath: `id`)
    - index: `messageId`
    - index: `detectedAt`
  - `canonical_checkpoints` (keyPath: `streamKey`)
    - index: `updatedAt`
  - `raw_streams` (keyPath: `id`)
  - `raw_stream_batches` (keyPath: `id`)
  - `history_staging` (keyPath: `id`)
  - `history_staging_manifests` (keyPath: `stagingId`)

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

---

## 6. Transport Attempt Projections vs. Canonical Logical Messages (Schema v8)

When network drops occur during generation, DeepSeek's frontend automatically triggers transport retry attempts (e.g., 3 XHR attempts for one prompt). StreamArchive enforces a strict architectural invariant:

**Transport attempt $\neq$ canonical conversation message.**

1. **Raw Journal Evidence:**
   Every transport attempt is permanently retained in `raw_streams` and `raw_stream_batches`. Raw evidence is never deleted, merged, or altered.

2. **Message Projection Taxonomy (`projectionState`):**
   - `'logical'`: Reconciled server history message or confirmed logical conversation turn.
   - `'provisional_logical'`: Active or in-flight provisional stream presumed logical until history reconciliation.
   - `'unmatched_capture'`: Partial text or reasoning captured from a stream that was superseded by retries and not accepted into server history.
   - `'attempt_only'`: Empty failed transport attempt (0 text, 0 thinking, no remote ID, terminal failure status).

3. **Tree Link Isolation & Sibling Branch Integrity:**
   - Non-logical records (`attempt_only` and `unmatched_capture`) are prohibited from having a `parentId` in the canonical tree (`parentId = undefined`).
   - Sibling branching in `ConversationView.svelte` evaluates only `isLogicalMessage()`. Empty attempts never produce phantom sibling selectors (`Branch 1 of 3`).
   - Real regenerate turns sharing `parentId` in server history strictly preserve full multi-branch navigation.
   - Partial captures are safely preserved and exposed in a dedicated "Unmatched Captures" technical view with raw stream provenance.
   - `listArchiveConversations` counts only `isLogicalMessage()` in `messageCount`.
   - `repairCanonicalProjection()` provides idempotent, safe migration for legacy databases.

---

## 7. Export & Backup Projections (Milestone 2E.1)

The canonical data model provides deterministic, read-only projections for external consumption and backup:

### 7.1 Single Conversation Export Model (`ConversationExportModel`)
- **Clean Logical Message Tree:**
  - Only records satisfying `isLogicalMessage(m)` are projected into the conversation message sequence.
  - Technical retry attempts (`attempt_only`) are strictly excluded from export representations.
  - Unmatched partial stream captures (`unmatched_capture`) are segregated into an `unmatchedCaptures` collection, preserving forensic provenance without corrupting the conversational narrative.
- **Preferred Revision Resolution:**
  - For each message, the export model projects `preferredRevision` via `selectPreferredRevision()`, which prioritizes uncensored last-good text (`isLastGood === true`) over server-overwritten content filter templates.
  - If selected by user options, full revision history and recovery events are attached to each turn.
- **Branch Awareness:**
  - Parent/child relationships (`parentId`) are mapped into sibling branch indices (`siblingBranchIndex`, `siblingBranchCount`).
  - Exporters can either follow the active path or serialize all sibling branches with explicit branch indicators (`Branch X of Y`).
- **Reference Token Preservation:**
  - Syntactic reference and search tokens (e.g. `[reference:0]`, `[citation:1]`) are preserved verbatim without mutation or accidental stripping.

### 7.2 Structured Canonical JSON Export (`ConversationExportV1`)
- Schema contract:
  ```typescript
  {
    format: 'deepseek-streamarchive-conversation',
    formatVersion: 1,
    exportedAt: string, // ISO-8601 UTC
    generator: 'deepseek-streamarchive',
    generatorVersion: string,
    conversation: { id, title, createdAt, updatedAt, remoteId },
    messages: MessageExportModel[],
    unmatchedCaptures?: UnmatchedCaptureExportModel[]
  }
  ```

### 7.3 Human Markdown Export (`human-markdown-v1`)
- Formatted for readability in modern Markdown readers, Obsidian, GitHub, and text viewers.
- Includes YAML frontmatter, conversation title, generation metadata, and branch indicators.
- DeepThink reasoning traces are rendered in native collapsible `<details>` blocks when enabled.
- Pre-filter censorship recoveries are highlighted with blockquotes detailing pre-filter text and recovery provenance.

### 7.4 Multi-Store Portable Backup Snapshot (`PortableBackupSnapshot`)
- Captured in a single atomic read-only IndexedDB transaction across 6 stores:
  1. `conversations`
  2. `messages`
  3. `revisions`
  4. `recovery_events`
  5. `raw_streams`
  6. `raw_stream_batches`
- Records within each store are sorted deterministically by primary key `id` ascending.
- Enforces memory ceiling (`MAX_IN_MEMORY_PORTABLE_BACKUP_SOURCE_BYTES = 100 MiB`) to prevent service worker OOM in large archives.
- Serialized into compressed newline-delimited JSON (`.streamarchive.jsonl.gz`) with strict format manifest and record count footer.

---

## 8. Retention Independence & Safe Cascade Deletion (Milestone 2E.3)

### 8.1 Independence from Raw Evidence Pruning
Canonical domain entities (`conversations`, `messages`, `revisions`, `recovery_events`) are strictly decoupled from raw transport streams (`raw_streams`, `raw_stream_batches`):
- **Zero Automatic Canonical Deletion:** Automatic retention pruning operates exclusively on raw streams and batches. Canonical messages and revisions are **never** deleted by retention policies.
- **Permanent Reading & Exportability:** A conversation whose underlying raw streams have been pruned remains 100% accessible in the Side Panel, searchable, and exportable to Markdown or JSON.

### 8.2 Safe Single-Conversation Cascade Deletion
When a user explicitly deletes an individual conversation via the Side Panel interface:
- **Active Stream Guard:** Deletion is rejected immediately if any in-flight stream is currently recording into the conversation.
- **Stale State Barrier:** Deletion validates `conversation.updatedAt === clientProvidedUpdatedAt`. Concurrent background writes abort the deletion with `StaleConversationError`.
- **Atomic Multi-Store Transaction:** Deletion executes in **ONE readwrite IndexedDB transaction** covering `conversations`, `messages`, `revisions`, `recovery_events`, referenced `raw_streams`, `raw_stream_batches`, and `canonical_checkpoints`.
- **Atomic Rollback:** If any store operation encounters an error or quota failure, `tx.abort()` is called immediately, leaving the database completely unmodified.

For full architectural details, see [RETENTION_AND_DELETION.md](./RETENTION_AND_DELETION.md) and [ADR 0025](./ADR/0025-retention-cleanup-and-safe-deletion.md).

---

## 9. Context Continuity Derived Model (Milestone 2D.5A)

The canonical message tree provides pure topological lineage resolution for Context Continuity:

### 9.1 Derived Non-Durable Projection
- Plans (`ContextContinuityPlan`) are pure, non-durable in-memory projections derived on-demand from `messages`, `revisions`, and `recovery_events`.
- **Zero Schema Migrations:** Strictly preserves `DB_VERSION = 8` without creating new stores or persistent context injection records.

### 9.2 Structural Invariants
- **Active Branch Isolation:** Evaluates `parentId` chains to determine active branch membership. Candidates belonging to alternate regeneration branches are marked `wrong_branch` and excluded.
- **Forensic Cause Invariant:** Recovery cause is purely informational metadata. Filtered responses, interrupted network responses, user stop halts, and template replacements participate equally in continuity evaluation.
- **Safe Clamping:** Enforces strict limits (`maxBlocks: 4`, `maxTextChars: 12000`, `maxThinkingChars: 6000`) with surrogate-safe UTF-16 slicing and visible omission disclosures.

For full architectural details, see [CONTEXT_CONTINUITY.md](./CONTEXT_CONTINUITY.md) and [ADR 0027](./ADR/0027-context-continuity-planning.md).
