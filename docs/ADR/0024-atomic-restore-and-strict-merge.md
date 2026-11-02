# ADR 0024: Atomic Archive Restore and Strict Merge Semantics

## Status
Accepted (Milestone 2E.2)

## Context
Following the implementation of Portable Backup v1 in Milestone 2E.1 (`.streamarchive.jsonl.gz`), users require the ability to restore their archives. Restoring an archive into IndexedDB introduces critical risks:
1. **Decompression & Resource Exhaustion (Zip/Gzip Bombs):** Untrusted or corrupted gzip archives could expand into gigabytes of data, causing browser tab crashes or memory exhaustion.
2. **Corrupted Relational State:** An imported backup could have orphan messages, cyclical tree hierarchies, or broken references to pre-filter recovered revisions.
3. **Partial Write Failure:** If a restore operation writes some records and fails halfway through, the local database is left in a corrupted hybrid state.
4. **Collision & Branch Pollution:** Merging incoming conversations with local conversations could accidentally overwrite user edits or conflate separate chats with the same remote DeepSeek session ID.

## Decision

### 1. Bounded Streaming Reader & Decompression Bomb Protection
We reject buffering entire files in uncompressed memory. `readPortableBackup()` uses `DecompressionStream('gzip')` with strict byte and entity bounds:
- `MAX_IMPORT_COMPRESSED_BYTES = 50 MiB`
- `MAX_IMPORT_DECOMPRESSED_BYTES = 250 MiB`
- `MAX_IMPORT_RECORDS = 500,000`
- `MAX_IMPORT_LINE_CHARS = 10 MiB`

If any boundary is exceeded during streaming decompression, the stream reader is cancelled immediately (`reader.cancel()`) and processing aborts with zero side effects.

### 2. Pre-Commit In-Memory Referential Integrity Graph
Before writing any data to IndexedDB, `validateBackupReferentialIntegrity()` constructs an in-memory directed graph of the materialized records:
- **Conversation Scoping:** Enforces that every message references an existing conversation, and every child message shares the identical `conversationId` with its parent.
- **Tree Acyclicity:** Enforces directed acyclic message trees; parent reference cycles are detected and rejected.
- **Pre-Filter Recovery Integrity:** `recovery_events` pointing to a `recoveredRevisionId` must reference a revision belonging to the same message with `isLastGood === true`.
- **Branch Tree Isolation:** Technical attempts (`attempt_only`) and partial captures (`unmatched_capture`) must not possess a `parentId`.

### 3. Replace Mode: Single-Transaction Atomic Replacement Across All 9 Stores
For Replace Archive, all 9 IndexedDB stores (6 durable stores + 3 ephemeral staging stores) are included in **ONE readwrite transaction**:
- The transaction clears all 9 stores.
- It inserts all backup records into the 6 durable stores.
- The 3 ephemeral stores (`canonical_checkpoints`, `history_staging`, `history_staging_manifests`) are left empty, ensuring no stale checkpoint or staging state leaks into the restored archive.
- If any write or quota error occurs, `tx.abort()` is called. The IndexedDB engine rolls back all changes, leaving the previous archive 100% intact.

### 4. Merge Mode: Strict Primary Key Union with Remote Identity Isolation
For Merge Archive:
- **Strict Primary-Key Union:** New records are inserted into durable stores. Identical records sharing the exact same primary key and payload are skipped idempotently.
- **Conflict Fail-Closed:** If an incoming record shares a primary key with an existing record but differs semantically, the merge operation aborts completely.
- **Remote Identity Protection:** If an incoming conversation has a `remoteId` (DeepSeek session ID) matching a different local conversation ID, the merge plan fails with a collision error to prevent cross-conversation branch pollution.

### 5. Active Stream Generation Barrier
Restore is strictly blocked if `activeTransportStreams.size > 0`. This prevents concurrent writes between in-flight network streaming and archive replacement.

### 6. Read-Back Count Parity Verification
Immediately following transaction completion (`tx.oncomplete`), the restore orchestrator opens a readonly transaction and reads the live `store.count()` for all 6 durable stores. Parity between the database counts and the backup metadata must be verified before the operation is reported as successful to the user.

### 7. Zero New Permissions
All restore operations operate entirely within the local extension runtime and existing sandboxed IndexedDB storage. Zero additional permissions (`chrome.downloads`, external network access) are required or requested.
