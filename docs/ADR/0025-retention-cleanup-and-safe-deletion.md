# ADR 0025: Retention, Cleanup & Safe Archive Deletion Architecture

## Status
Accepted (Milestone 2E.3) — Reconciles and supersedes ADR 0007.

## Context
Early in the project, ADR 0007 envisioned a rolling FIFO buffer for raw journal events to bound disk storage. However, as the system matured across Milestones 2A through 2E.2:
1. **Forensic Value:** The Raw Journal became an authoritative forensic ledger proving pre-filter text recovery, transport anomalies, network drops, and message reconciliation provenance.
2. **Silent Loss Risk:** A naive rolling FIFO buffer would silently discard raw chunks corresponding to pre-filter recoveries or unfinalized stream diagnostics.
3. **Canonical Decoupling:** Users rely on canonical conversation history remaining permanent, whereas raw HTTP chunks are auxiliary forensic evidence that can be safely pruned when unneeded.
4. **Race Conditions & Eviction:** In-flight network captures could conflict with simultaneous deletion or cleanup operations, risking inconsistent relational state in IndexedDB.

## Decision

### 1. Default to Permanent Evidence (`forever`)
We reject automated silent pruning by default. The retention mode defaults to `forever`. Pruning raw evidence is an explicit user choice (`30`, `90`, or `180` days) configured in extension Settings.

### 2. Protected Evidence Shield
Age alone is never sufficient to prune a raw transport stream. All raw streams are evaluated through the deterministic `evaluateRawStreamRetention` policy engine:
- **Active Stream Shield:** Any stream currently actively writing is strictly shielded.
- **Recovery Provenance Shield:** Any raw stream linked to a message with `status === 'filtered'`, an authoritative `RecoveryEvent`, or a revision marked `isLastGood === true` is shielded indefinitely.
- **Forensic Anomaly Shield:** Any stream with non-intact integrity, durability gaps, dropped characters, terminal error states (`aborted`, `error`, `degraded`), recorded error strings, or unmatched captures is preserved for diagnosis.

### 3. Strict Decoupling of Canonical History and Raw Journal
Pruning raw streams and batches (`raw_streams`, `raw_stream_batches`) **NEVER** deletes or mutates canonical conversations, messages, or revisions. The application can fully render and export conversations even after their underlying raw transport chunks have been pruned.

### 4. Single-Transaction Atomic Cascade Deletion with Stale Barrier
Single-conversation deletion removes a targeted conversation and all its dependent artifacts:
- **Stale State Barrier:** Re-validates `conversation.updatedAt === clientProvidedUpdatedAt`. Concurrent updates abort deletion to prevent deleting newly appended content.
- **Active Stream Guard:** Rejects deletion if an active stream is currently capturing into the conversation.
- **Atomic Rollback:** Executes within **ONE readwrite IndexedDB transaction** across `conversations`, `messages`, `revisions`, `recovery_events`, `raw_streams`, `raw_stream_batches`, and `canonical_checkpoints`. Any runtime error triggers `tx.abort()`.

### 5. Multi-Store Archive Purge
The Settings UI provides two explicit destructive actions:
- **Purge Raw Evidence Only:** Clears `raw_streams` and `raw_stream_batches` while retaining 100% of canonical conversations, messages, revisions, and recovery events.
- **Clear Entire Archive:** Clears all 9 IndexedDB stores, resetting the database to an empty baseline while preserving user settings in `chrome.storage.local`. Requires an explicit confirmation checkbox.

### 6. Opportunistic Scheduling with Zero New Permissions
Automated retention cleanup runs opportunistically:
- On MV3 service worker initialization.
- After terminal stream finalization.
- Throttled to at most once per 24 hours via `chrome.storage.local`.
- Zero new permissions (`alarms` is rejected; no `setInterval` polling loops).

### 7. Storage Observability & Persistence Truth
The extension queries real browser storage metrics via `navigator.storage.estimate()` and persistence status via `navigator.storage.persisted()`. It provides a one-click persistence request via `navigator.storage.persist()`. Per-entity byte counts are rejected in favor of exact record counts directly from IndexedDB.

## Consequences

### Positive
- Zero risk of silent deletion of recovered pre-filter text or forensic anomaly evidence.
- Fully atomic deletions guarantee no orphaned records or broken foreign references.
- Clock injection allows 100% deterministic unit and benchmark testing of retention logic.
- Complies strictly with MV3 manifest security bounds (only `storage` and `sidePanel`).

### Negative
- Heavy users with `forever` retention may consume substantial disk space over time; mitigated by visual storage warnings and prominent maintenance actions in Settings.
