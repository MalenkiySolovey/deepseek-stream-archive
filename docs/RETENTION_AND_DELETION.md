# Retention, Cleanup & Safe Deletion Architecture (Milestone 2E.3)

## 1. Overview & Core Philosophy

DeepSeek StreamArchive is designed as a local-first, crash-durable forensic recorder and recovery extension. While early milestones established non-destructive stream capture and immutable history reconstruction, unmanaged storage growth presents eviction and quota risks in browser environments.

Milestone 2E.3 introduces controlled lifecycle management for local archive data without compromising forensic or canonical guarantees:

```text
Storage Observability & Persistence Truth
                 ↓
Raw Evidence Retention Policy (forever [default], 30, 90, 180 days)
                 ↓
Protected Evidence Shield (Anomalies, Recoveries, Active Streams)
                 ↓
Safe Conversation Deletion (Cascade, Stale Barrier, Atomic Rollback)
                 ↓
Maintenance Actions (Clean Up Now, Purge Raw, Clear Archive)
```

### The Cardinal Rule of Retention
> **Retention prunes raw transport evidence to reclaim disk space, but canonical conversation history is NEVER deleted automatically.**

Conversations, messages, and response revisions remain permanent in the local archive until the user explicitly deletes them via single-conversation deletion or whole-archive purge.

---

## 2. Storage Observability & Persistence Truth

### 2.1 Native Storage Measurement
Storage consumption is determined strictly via the standard Web API:
- `navigator.storage.estimate()`: Queries the extension origin's usage and quota in bytes.
- Zero synthetic byte estimations: The UI does not fabricate per-conversation or per-message byte breakdowns, as browsers manage physical disk allocations, compression, and SQLite B-tree clustering at the origin level.

### 2.2 Exact Entity Composition
To give users actionable insight without misleading byte estimates, the extension provides exact record counts directly from IndexedDB:
- **Canonical History:**
  - Conversations count
  - Messages count
  - Response revisions count
- **Raw Evidence Ledger:**
  - Raw HTTP transport streams count
  - Raw stream batches count
  - Raw captured character count

### 2.3 Storage Persistence Status
Chromium engines may mark IndexedDB storage as "best-effort" (eligible for eviction under disk pressure).
- `navigator.storage.persisted()`: Queries whether the origin is granted durable persistence.
- `navigator.storage.persist()`: Allows the user to request durable persistence with a single click in Settings.
- Visual badge displays exact status: `Granted (Durable)` or `Standard (Best Effort)`.

---

## 3. Raw Evidence Retention Policy

### 3.1 Policy Modes
Users configure retention in Settings (`chrome.storage.local` key `rawRetention`):
- `forever` (Default): Raw streams and batches are kept indefinitely.
- `30`: Raw streams older than 30 days are eligible for automatic age-pruning.
- `90`: Raw streams older than 90 days are eligible for automatic age-pruning.
- `180`: Raw streams older than 180 days are eligible for automatic age-pruning.

### 3.2 Protected Evidence Shield
Age alone is never sufficient to delete a raw stream. The pure policy engine (`evaluateRawStreamRetention`) enforces the **Protected Evidence Shield**:

1. **Active Stream Shield:** Any stream currently actively recording (`active` state or present in `activeTransportStreams`) is strictly shielded.
2. **Recovery Provenance Shield:** Any raw stream associated with:
   - A message with `status === 'filtered'`
   - A `RecoveryEvent` entry (e.g. content filter replacement)
   - A revision marked `isLastGood === true`
   is shielded indefinitely. The user must never lose the cryptographic or transport proof of recovered pre-filter text.
3. **Forensic Anomaly & Integrity Shield:** Any raw stream exhibiting capture defects is shielded indefinitely:
   - Degraded integrity (`stream.integrity !== 'intact'`)
   - Durability gap (`stream.durabilityGap === true`)
   - Dropped characters (`stream.droppedChars > 0`)
   - Terminal error or interruption states (`aborted`, `error`, `degraded`)
   - Recorded error messages (`stream.error` present)
   - Unmatched captures (`msg.projectionState === 'unmatched_capture'`)
4. **Age Cutoff Boundary:** A stream is only pruned if its `openedAt <= now - days * 86,400,000` AND all shields above evaluate to false.

---

## 4. Safe Single-Conversation Deletion

Single-conversation deletion removes a specific conversation from the local archive. It is engineered with multi-layered safety barriers:

### 4.1 2-Step Confirmation Flow
1. User clicks the **Delete** button in `ConversationView`.
2. A preview modal displays:
   - Conversation title
   - Created and last updated timestamps
   - Message and revision counts to be deleted
   - Associated raw streams and batches to be purged
   - An option to **Download Safety Backup First** (triggers `.streamarchive.jsonl.gz` export)
3. User must click the explicit "Confirm Delete" action.

### 4.2 Concurrency & Stale State Barrier
To protect against race conditions:
- **Active Stream Guard:** If any in-flight stream is currently being captured for this conversation, deletion is rejected immediately with `ActiveStreamGuardError`.
- **Stale State Barrier:** The client sends the conversation's `updatedAt` timestamp in the deletion request. The database transaction re-verifies that `conv.updatedAt === requestedUpdatedAt`. If a concurrent sync or stream updated the conversation in the background, the transaction aborts with `StaleConversationError`.

### 4.3 Atomic Cascade Rollback
Deletion runs in **ONE readwrite IndexedDB transaction** across all affected stores:
- `conversations`
- `messages`
- `revisions`
- `recovery_events`
- `raw_streams` (referenced by messages of this conversation)
- `raw_stream_batches`
- `canonical_checkpoints`

If any step fails or an unexpected exception occurs, `tx.abort()` is invoked immediately, rolling back all deletions atomically and leaving the archive intact.

---

## 5. Maintenance Actions in Settings

The Settings tab provides three deliberate maintenance operations:

| Action | Target | Canonical Impact | Use Case |
|---|---|---|---|
| **Clean Up Now** | Expired, non-shielded raw streams & batches | **None.** Conversations and messages 100% preserved. | Reclaim disk space according to configured retention policy without waiting for background cycle. |
| **Delete Raw Evidence** | All raw streams and batches across entire archive | **None.** Conversations, messages, revisions, and recovery events 100% preserved. | Reclaim maximum disk space while keeping all chat transcripts and pre-filter recoveries. |
| **Delete All Local Archive Data** | All 9 IndexedDB stores | **Complete.** Resets extension to factory clean state. | Full privacy purge or archive reset. Requires explicit confirmation checkbox. |

---

## 6. Opportunistic Rate-Limited Scheduling

Automatic retention cleanup runs opportunistically with **zero new browser permissions**:
- **Triggers:**
  1. On MV3 Service Worker startup (`onInstalled` / worker initialization).
  2. After terminal stream finalization.
- **Rate Limit:** At most once every 24 hours (`lastAutomaticCleanupAt` stored in `chrome.storage.local`).
- **No Background Polling:**
  - NO `alarms` permission.
  - NO `setInterval` loops.
  - NEVER runs if retention policy is `forever`.

---

## 7. Explicit Local Deletion Notice

> [!IMPORTANT]
> **Local Deletion Privacy Notice:**
> All deletion and cleanup operations in DeepSeek StreamArchive operate **strictly inside the local browser storage (IndexedDB & chrome.storage)**.
>
> Deleting conversations or raw evidence in StreamArchive **DOES NOT** delete, modify, or affect conversations, server logs, or account data hosted on DeepSeek servers (`https://chat.deepseek.com`). DeepSeek server-side data management must be performed directly in the DeepSeek web interface.
