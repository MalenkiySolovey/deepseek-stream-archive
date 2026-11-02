# ADR 0023: Architecture for Human Export and Portable Archive Backup v1

## Status
Accepted (Milestone 2E.1)

## Context
Following the completion of live compatibility verification in Milestone 2D, users require the ability to extract their conversations from StreamArchive for two distinct use cases:
1. **Reading & Sharing:** Exporting individual conversation threads into standard Markdown or structured JSON for offline documentation, personal notes, or sharing.
2. **Disaster Recovery & Portability:** Creating a complete, restore-ready backup of their entire local archive that can be restored into another browser or extension instance in future Milestone 2E.2.

Treating human export and full backup as a single unified format creates severe compromises: human exports become cluttered with forensic wire chunks, while backups lose necessary transport and revision evidence required for authentic reconstruction.

## Decision

### 1. Two Decoupled Export Products
We explicitly separate the export layer into two distinct products:
- **Product 1: Human Conversation Export**
  - Scope: Single conversation.
  - Formats: Clean Markdown (`.md`, `human-markdown-v1`) and Canonical JSON (`.json`, `deepseek-streamarchive-conversation`, version 1).
  - Structure: Logical tree only. `attempt_only` records (0-char interrupted transport retries) are strictly excluded. Unmatched partial captures are placed in an isolated appendix.
- **Product 2: Portable Backup v1**
  - Scope: Entire local database.
  - Format: Line-delimited JSON (NDJSON) compressed with native gzip (`.streamarchive.jsonl.gz`).
  - Structure: Full evidence ledger including raw streams, chunk batches, immutable revisions, and recovery events.

### 2. File Format: JSONL + Native gzip
- **Why NDJSON:** Line-delimited JSON allows streaming record serialization and line-by-line parsing without loading entire multi-megabyte JSON trees into memory as a single object.
- **Why Native `CompressionStream`:** Modern Chromium supports `CompressionStream('gzip')` and `DecompressionStream('gzip')`. Using web-standard streams eliminates runtime dependencies (no JSZip, fflate, or pako required), preserving minimal bundle size.

### 3. Strict Store Whitelist and Explicit Exclusions
- **Included Stores:**
  - `conversations`, `messages`, `revisions`, `recovery_events`, `raw_streams`, `raw_stream_batches`.
  - All projection states (`logical`, `provisional_logical`, `unmatched_capture`, `attempt_only`) are preserved in backup.
- **Excluded Stores:**
  - `canonical_checkpoints`: Excluded because it represents an ephemeral live delivery and idempotency ledger for active in-flight streams. Restored databases start with zero pending live stream deliveries.
  - `history_staging` & `history_staging_manifests`: Excluded because they represent temporary buffers for in-flight history ingestion.
  - Ephemeral runtime state: Background worker epochs, diagnostic counters, UI selections.

### 4. Point-in-Time Readonly Snapshot
Backup data is extracted using a single multi-store readonly IndexedDB transaction:
`db.transaction(['conversations', 'messages', 'revisions', 'recovery_events', 'raw_streams', 'raw_stream_batches'], 'readonly')`
This guarantees point-in-time isolation: streaming writes occurring during backup creation do not create hybrid or corrupted states.

### 5. Memory Safety Boundary
An in-memory source threshold (`MAX_IN_MEMORY_PORTABLE_BACKUP_SOURCE_BYTES = 100 MiB`) protects browser processes from out-of-memory crashes. Archives exceeding this threshold abort cleanly with an explicit error message rather than producing partial files.

### 6. Compression vs. Encryption Policy
Portable Backup v1 is compressed with gzip but is **not encrypted**. Adding encryption without full key management and password recovery design is dangerous. Encryption is explicitly deferred to future security milestones. A clear local privacy warning is presented to the user prior to backup generation.

### 7. Zero `chrome.downloads` Permission
File saving operates via `window.showSaveFilePicker()` on user gesture, falling back to temporary `Blob` object URLs and hidden `<a download>` triggers. This eliminates the need for the dangerous `downloads` permission in `manifest.json`.

## Consequences
- **Positive:** Human exports remain clean, readable, and branch-aware.
- **Positive:** Backup v1 preserves 100% of forensic raw streams and revisions.
- **Positive:** Zero new runtime dependencies added to package bundle.
- **Positive:** Permissions remain strictly `storage` and `sidePanel`.
- **Negative:** Materializing multi-store snapshots in memory sets a 100 MiB upper bound for v1 full backups; streaming direct from IndexedDB cursors will be evaluated in future scaling phases.
