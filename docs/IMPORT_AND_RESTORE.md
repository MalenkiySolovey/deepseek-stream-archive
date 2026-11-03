# Import & Atomic Restore Architecture Guide

> **DeepSeek StreamArchive**  
> Status: Architecture Guide
> Scope: Safe Import, Validation & Atomic Restore of Portable Backup v1  

---

## 1. Architectural Overview

Restoring a user's conversational archive and raw network evidence is a high-stakes, security-critical operation. DeepSeek StreamArchive enforces a multi-stage, fail-closed validation pipeline ensuring that no data is written to IndexedDB until the backup archive is fully decompressed, parsed, authenticated, and verified for relational integrity.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                      Restore Execution Pipeline                        │
├────────────────────────────────────────────────────────────────────────┤
│ 1. File Selection & Bounded Ingestion                                  │
│    - Accepts .streamarchive.jsonl.gz (MIME: application/gzip)          │
│    - Preflight ceiling: 50 MiB compressed                              │
├────────────────────────────────────────────────────────────────────────┤
│ 2. Streaming Decompression & Envelope Validation                       │
│    - Decompression bomb barrier: max 250 MiB decompressed              │
│    - Line size limit: max 10 MiB | Record limit: max 500,000          │
│    - Monotonic store sequence & primary key sorting validation         │
│    - Record-level schema validation across all 6 durable stores        │
│    - Footer completion & exact record count reconciliation             │
├────────────────────────────────────────────────────────────────────────┤
│ 3. Relational Referential Integrity Validation (In-Memory Graph)       │
│    - Orphan message, revision, recovery event & raw batch rejection    │
│    - Directed acyclic graph (DAG) cycle detection                      │
│    - Conversation boundary cross-referencing checks                    │
│    - attempt_only / unmatched_capture parent isolation enforcement     │
│    - Pre-filter recovery pointer & isLastGood revision verification    │
├────────────────────────────────────────────────────────────────────────┤
│ 4. Concurrency & Generation Safety Barrier                             │
│    - Active DeepSeek stream gate (activeTransportStreams.size === 0)   │
├────────────────────────────────────────────────────────────────────────┤
│ 5. Restore Planning & User Preview Confirmation                        │
│    - Side-by-side comparison of local vs. backup store record counts   │
│    - Mode selection: Replace Archive vs. Merge Archive                 │
│    - Explicit destructive replacement warning & checkbox confirmation  │
│    - Safety backup creation option prior to commit                     │
├────────────────────────────────────────────────────────────────────────┤
│ 6. ONE Atomic IndexedDB Commit Transaction                             │
│    - Replace: 1 transaction across all 9 stores (6 durable + 3 eph.)   │
│    - Merge: 1 transaction across 6 durable stores with conflict abort  │
│    - Automatic abort & rollback on error (zero partial mutation)       │
├────────────────────────────────────────────────────────────────────────┤
│ 7. Post-Commit Read-Back Verification                                  │
│    - Queries live store counts and verifies parity before completion   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Security Bounds & Decompression Bomb Protection

To defend against malicious gzip archives designed to exhaust system memory, the streaming reader (`src/backup/reader.ts`) enforces strict dimensional limits:

| Parameter | Boundary Limit | Rationale |
| :--- | :--- | :--- |
| `MAX_IMPORT_COMPRESSED_BYTES` | **50 MiB** | A 100 MiB source database compresses to ~15–25 MiB in gzip; 50 MiB provides headroom while blocking runaway uploads. |
| `MAX_IMPORT_DECOMPRESSED_BYTES` | **250 MiB** | Restricts streaming decompression output. Aborts immediately if a small gzip payload expands into hundreds of megabytes. |
| `MAX_IMPORT_RECORDS` | **500,000** | Blocks micro-record object explosion attacks. |
| `MAX_IMPORT_LINE_CHARS` | **10 MiB** | Guards against single-line memory exhaustion. |

Streaming decompression uses the web-standard `DecompressionStream('gzip')` API, piping decompressed chunks through a stream reader with incremental newline buffering.

---

## 3. Validation Stages

### 3.1 Envelope & Store Structure
1. **Line 0 Manifest:** Must possess `kind="manifest"`, `format="deepseek-streamarchive-backup"`, and `formatVersion <= 1`.
2. **Store Order:** Records must strictly follow the canonical store order:
   `conversations` → `messages` → `revisions` → `recovery_events` → `raw_streams` → `raw_stream_batches`.
3. **Key Order:** Within each store, records must be sorted monotonically by primary key (`compareKeys(prev, curr) < 0`).
4. **Primary Key Uniqueness:** Duplicate primary keys within the same store are strictly rejected.
5. **Terminal Footer:** The final line must possess `kind="footer"`, `complete=true`, and exact per-store record counts matching observed record counts. No lines are permitted after the footer.

### 3.2 Record Schema Validation
Each record is validated field-by-field (`src/backup/record-validation.ts`) to ensure conformity with internal domain models:
- **`conversations`:** Valid `id` string, `createdAt`, `updatedAt`, optional `remoteId`, `title`.
- **`messages`:** Role (`user` | `assistant` | `system`), status (`streaming` | `finished` | `filtered` | `interrupted` | `error`), `identityState`, `projectionState`.
- **`revisions`:** `revisionIndex >= 0`, `source`, `capturedAt`, boolean flags `isFinal` and `isLastGood`.
- **`recovery_events`:** `kind` (`content_filter` | `interrupted_stream` | `patch_desync`), `detectedAt`.
- **`raw_streams`:** `producerSessionId`, `streamId`, `transport`, `url`, `state`, `totalChunks`, `totalChars`, `totalBatches`.
- **`raw_stream_batches`:** `streamKey`, `batchSeq >= 1`, chunk array schema validation.

### 3.3 Referential Integrity Validation (Relational DAG)
`src/restore/integrity.ts` builds an in-memory graph across all records and enforces referential invariants:
- **Conversation Scoping:** Every message must reference an existing conversation. If `parentId` is present, the parent message must reside in the exact same `conversationId`.
- **Tree Acyclicity:** Detects parent cycles via path traversal; rejects circular parent references.
- **Revision Linkage:** Every revision must reference an existing message.
- **Pre-Filter Recovery Integrity:** `recovery_events` with `recoveredRevisionId` must reference a revision belonging to the same message, and that revision **must** have `isLastGood === true`.
- **Retry Attempt Parent Isolation:** Messages with `projectionState === 'attempt_only'` or `'unmatched_capture'` must **not** participate in the message tree (must have `parentId === undefined`).
- **Raw Batch Linkage:** Every `raw_stream_batches` record must reference an existing `streamKey` in `raw_streams`.

---

## 4. Restore Modes

### 4.1 Replace Archive
- **Purpose:** Full disaster recovery and archive replacement.
- **Transaction Scope:** Executes in **ONE single readwrite transaction** covering all 9 stores:
  - 6 Durable Stores: `conversations`, `messages`, `revisions`, `recovery_events`, `raw_streams`, `raw_stream_batches`.
  - 3 Ephemeral Stores: `canonical_checkpoints`, `history_staging`, `history_staging_manifests`.
- **Rollback Guarantee:** All 9 stores are cleared and durable records inserted. If any error occurs (disk full, quota exceeded, constraint failure), the transaction aborts via `tx.abort()`. The existing local database remains **100% untouched**.
- **User Safety Guard:** Requires checking an explicit acknowledgment checkbox (`#confirm-replace-checkbox`). Provides a one-click button to create a safety backup before proceeding.

### 4.2 Safe Merge Archive
- **Purpose:** Non-destructive union of two distinct archive datasets (e.g. merging a backup from a secondary workstation).
- **Semantics:** Strict primary-key union across the 6 durable stores.
- **Duplicate Skipping:** If a backup record has the same primary key as an existing local record and is **semantically identical**, it is safely skipped without error.
- **Conflict Abort:** If a backup record shares a primary key with a local record but differs in content, timestamps, or state, the merge operation aborts completely.
- **Remote Identity Protection:** If a backup conversation has a `remoteId` (DeepSeek session ID) that already exists locally under a different conversation ID, the merge plan fails closed to prevent branch pollution.

---

## 5. Active Generation Stream Safety Barrier

Restore operations manipulate canonical history and the raw stream journal. Performing a restore while DeepSeek is actively streaming would introduce race conditions between live network batches and imported records.

The background worker inspects `activeTransportStreams.size`:
- If `activeTransportStreams.size > 0`, preflight marks `canRestore: false` with the error `restoreCloseActiveGeneration`.
- If an execution request arrives while a stream is running, it rejects immediately with an HTTP-style safety barrier.

---

## 6. Post-Commit Read-Back Verification

To guarantee durability and persistence truth:
1. After `tx.oncomplete` fires, the restore orchestrator initiates a readonly transaction querying `store.count()` across all 6 durable stores.
2. In **Replace Mode**, final store counts must match the backup footer counts exactly.
3. In **Merge Mode**, final store counts must be greater than or equal to the inserted counts.
4. If count verification fails, the restore returns `success: false` with error `restore_committed_but_verification_failed`.
