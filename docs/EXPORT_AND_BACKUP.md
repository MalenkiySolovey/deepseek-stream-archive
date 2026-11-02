# Export & Backup Architecture Guide

> **DeepSeek StreamArchive**  
> Status: Milestone 2E.1 Guide  
> Scope: Human Conversation Export & Portable Archive Backup  

---

## 1. Two Distinct Products: Human Export vs. Portable Backup

StreamArchive strictly separates conversational export into two distinct architectural products tailored for different operational objectives:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        StreamArchive Export Layer                      │
├───────────────────────────────────┬────────────────────────────────────┤
│       1. Human Conversation       │       2. Portable Archive          │
│              Export               │              Backup                │
├───────────────────────────────────┼────────────────────────────────────┤
│ Target: Reading, sharing, notes   │ Target: Complete restore (Milestone│
│                                   │ 2E.2), disaster recovery           │
│ Formats: Markdown (.md),          │ Format: StreamArchive Backup v1    │
│          Canonical JSON (.json)   │ (.streamarchive.jsonl.gz)          │
│ Scope: Single conversation thread │ Scope: Full local IndexedDB store  │
│ Contents: Clean logical tree,     │ Contents: Canonical models +       │
│           reasoning, recovery     │           revisions + raw journals │
│ Technical Noise: EXCLUDED         │ Technical Noise: PRESERVED         │
│ (attempt_only hidden)             │ (full forensic evidence intact)    │
└───────────────────────────────────┴────────────────────────────────────┘
```

---

## 2. Product 1: Human Conversation Export

Accessible from the conversation view in the Side Panel via the **Export** button.

### 2.1 Available Formats
1. **Human-Readable Markdown (`.md`):**
   - Deterministic Markdown structure (`human-markdown-v1`).
   - Clean headings for `## User` and `## Assistant`.
   - Preserves DeepThink chain-of-thought blocks under `### DeepThink`.
   - Distinct callouts for pre-filter recovered responses under `### Recovery`.
   - Preserves raw DeepSeek reference tokens (e.g. `[reference:0]`) without inventing hallucinated URLs.
   - Plain text rendering: zero executable scripts, zero HTML injection.
2. **Canonical Structured JSON (`.json`):**
   - Stable DTO format: `deepseek-streamarchive-conversation`, `formatVersion: 1`.
   - Independent of internal database schema version (`DB_VERSION`).
   - Contains conversation metadata, tree turns, parent relationships, and optional recovery payloads.

### 2.2 Sibling Branch Handling
- When a user clicked *Regenerate* or edited a prompt in DeepSeek, multiple logical assistant turns exist under the same parent turn.
- **Export Options:**
  - **All branches (Default):** Exports each alternative with explicit numbering (`## Assistant — Branch 1 of 2`, `## Assistant — Branch 2 of 2`).
  - **Active branch only:** Exports only the currently selected or primary branch, omitting superseded alternatives.

### 2.3 Technical Retries & Unmatched Captures Policy
- **`attempt_only` Records:** Technical transport attempts that dropped with 0 tokens (e.g. network retries) are **strictly excluded** from human exports.
- **`unmatched_capture` Records:** Interrupted streams that captured meaningful partial text but were superseded by server history are isolated into an optional appendix section at the bottom of the document (`## Unmatched Stream Captures`), never polluting the conversation tree.

### 2.4 Safe Filename Generation
Filenames are generated deterministically via [`sanitizeExportFilename`](../src/export/filename.ts):
- Illegal characters (`\ / : * ? " < > |`) and control characters are removed or converted to hyphens.
- Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) are safely prefixed.
- Length bounded to 60 characters without breaking multi-byte Unicode surrogate pairs.
- Pattern: `<Sanitized-Title>_<YYYY-MM-DD>.<ext>` (e.g. `REST-GraphQL-gRPC_2026-11-02.md`).
- Fallback: `deepseek-conversation_<shortId>_<YYYY-MM-DD>.<ext>`.

---

## 3. Product 2: Portable Backup v1

Accessible from **Settings & Storage** in the Side Panel via **Create Portable Backup**.

### 3.1 Format Specification
- Standard file naming: `deepseek-streamarchive-backup_<YYYY-MM-DD>.streamarchive.jsonl.gz`.
- Logical format: Line-delimited JSON (NDJSON).
- Native Compression: `CompressionStream('gzip')` without external dependencies.
- Normative contract defined in [Backup Format v1 Specification](./BACKUP_FORMAT_V1.md).

### 3.2 Stores Policy
- **Included Stores:**
  - `conversations`
  - `messages` (including all projection states: `logical`, `provisional_logical`, `unmatched_capture`, `attempt_only`)
  - `revisions` (including `isLastGood` pre-filter revisions)
  - `recovery_events` (censorship audit records)
  - `raw_streams` (transport session records)
  - `raw_stream_batches` (raw captured wire chunks)
- **Excluded Stores:**
  - `canonical_checkpoints` (transient in-flight delivery ledger)
  - `history_staging` & `history_staging_manifests` (transient in-flight history buffers)
  - Runtime diagnostics, epochs, and search states.

### 3.3 Consistent Point-in-Time Snapshot
The snapshot is read within **ONE multi-store readonly transaction** across all 6 included stores.
Writes committed while backup serialization is underway do not create hybrid states.

### 3.4 Memory Safety Ceiling
- `MAX_IN_MEMORY_PORTABLE_BACKUP_SOURCE_BYTES = 100 MiB`.
- If database evidence exceeds the in-memory threshold, the process halts safely without producing corrupted or partial backups.

---

## 4. Safe File Saving Strategy

Chromium browser extensions cannot use native filesystem pickers without user activation.
StreamArchive implements a two-tier adapter:
1. **Primary: `window.showSaveFilePicker()`**
   - Invoked directly from the user's click gesture on the Export/Backup button.
   - User cancellation (`AbortError`) returns silently to idle state.
2. **Fallback: `BlobDownloadFallbackAdapter`**
   - Used when `showSaveFilePicker` is unavailable or throws non-cancel errors.
   - Uses temporary hidden `<a download>` anchor with `URL.createObjectURL(blob)`, revoking object URLs after download initiation.
3. **Zero `chrome.downloads` Permission:**
   - Manifest V3 permissions remain strictly `storage` and `sidePanel`.
