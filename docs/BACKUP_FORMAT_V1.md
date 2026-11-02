# DeepSeek StreamArchive — Portable Backup Format v1 Specification

> **Document Status:** Normative Public Specification  
> **Format Identifier:** `deepseek-streamarchive-backup`  
> **Format Version:** `1`  
> **Standard File Extension:** `.streamarchive.jsonl.gz`  
> **MIME Content-Type:** `application/gzip`  
> **Encoding:** UTF-8  
> **Compression:** gzip (RFC 1952)  
> **Target Release:** Milestone 2E.1  

---

## 1. Overview & Purpose

The **Portable Backup Format v1** is a versioned, self-contained, append-only file format designed to preserve the complete durable evidence and canonical conversational state of a DeepSeek StreamArchive instance.

### Primary Design Goals:
1. **Restore-Oriented Completeness:** Preserves not only high-level human conversation text, but also immutable revision history (`revisions`), censorship recovery markers (`recovery_events`), and raw transport evidence (`raw_streams`, `raw_stream_batches`).
2. **Crash Durability & Atomicity:** Written from a single multi-store read-only transaction ensuring point-in-time snapshot consistency.
3. **Strict Validation & Tamper-Detection:** Mandates a header manifest, deterministic record sequence, and a terminal footer record with exact item counts. Incomplete or corrupted files are rejected unconditionally.
4. **Zero-Dependency Portability:** Logical stream consists of line-delimited JSON (NDJSON) compressed with standard gzip, decodable via standard tools (`gunzip`, `jq`, `zcat`) without proprietary binaries.

---

## 2. File Envelope & Compression

A valid Portable Backup v1 file consists of a gzip-compressed UTF-8 byte stream.
Decompressing the byte stream produces line-delimited JSON (NDJSON), where every line is a standalone, single-line JSON object terminated by a newline character (`\n` or `\r\n`).

```text
[ Physical File: .streamarchive.jsonl.gz ]
              ↓
    [ gzip decompression ]
              ↓
Line 0:   Manifest Record (kind="manifest")
Line 1:   Store Record 1  (kind="record", store="conversations")
Line ...: Store Record N  (kind="record", store="...")
Line EOF: Footer Record   (kind="footer", complete=true)
```

---

## 3. Normative Record Kinds

Every JSON line in the uncompressed stream contains a top-level `"kind"` discriminator:

| Record Kind | Position in File | Cardinality | Purpose |
|---|---|---|---|
| `manifest` | **Line 0 only** | Exactly 1 | Declares format identity, format version, source database metadata, and privacy markers. |
| `record` | **Lines 1 to N-1** | 0 or more | Encapsulates an individual stored entity from a whitelisted database store. |
| `footer` | **Final line only** | Exactly 1 | Concludes the backup, confirms completion barrier (`complete: true`), and declares exact counts. |

---

## 4. Manifest Record (Line 0)

The first line of the file must be a JSON object with `"kind": "manifest"`.

### Schema:
```json
{
  "kind": "manifest",
  "format": "deepseek-streamarchive-backup",
  "formatVersion": 1,
  "createdAt": 1730500000000,
  "appVersion": "0.1.0",
  "sourceDatabase": "StreamArchiveDB",
  "sourceDatabaseVersion": 8,
  "encoding": "utf-8",
  "compression": "gzip",
  "includedStores": [
    "conversations",
    "messages",
    "revisions",
    "recovery_events",
    "raw_streams",
    "raw_stream_batches"
  ],
  "excludedStores": [
    "canonical_checkpoints",
    "history_staging",
    "history_staging_manifests"
  ],
  "privacy": {
    "containsConversationContent": true,
    "containsReasoning": true,
    "containsRecoveredContent": true,
    "containsRawNetworkEvidence": true
  }
}
```

### Manifest Invariants:
- `format` must strictly equal `"deepseek-streamarchive-backup"`.
- `formatVersion` must equal `1`. Parsers must reject `formatVersion > 1` with `unsupported_backup_version`.
- `encoding` must equal `"utf-8"`.
- `compression` must equal `"gzip"`.

---

## 5. Store Whitelist & Record Sequence

### 5.1 Included Stores (Normative Order)
Records must appear in the following strict store sequence:

1. `conversations` — Logical chat threads and metadata (`keyPath: "id"`).
2. `messages` — Conversation tree turns, parent links, and projection states (`keyPath: "id"`).
3. `revisions` — Immutable text revisions, DeepThink reasoning, and content fingerprints (`keyPath: "id"`).
4. `recovery_events` — Structured censorship audit markers and recovery references (`keyPath: "id"`).
5. `raw_streams` — Transport session metadata and integrity status (`keyPath: "id"`).
6. `raw_stream_batches` — Append-only raw response chunks and wire captures (`keyPath: "id"`).

Once records for store $A$ conclude and records for store $B$ begin, no further records for store $A$ may appear. Violations must be rejected with `stores_out_of_order`.

### 5.2 Deterministic Record Ordering
Within each store block, records must be ordered in ascending lexicographical order by primary key (`id`):
$$\text{record}_{i}.\text{value}.\text{id} \le \text{record}_{i+1}.\text{value}.\text{id}$$

### 5.3 Excluded Ephemeral Stores
The following stores are intentionally excluded from Portable Backup v1:
- `canonical_checkpoints`: Transient live streaming delivery and deduplication ledger. Restored instances start with no active in-flight stream deliveries.
- `history_staging` & `history_staging_manifests`: Ephemeral staging buffers for in-flight server history queries.
- Runtime diagnostics, background service worker epochs, active UI state, search queries, language selection.

---

## 6. Footer Record (Final Line)

The final line of the file must be a JSON object with `"kind": "footer"`.

### Schema:
```json
{
  "kind": "footer",
  "complete": true,
  "counts": {
    "conversations": 12,
    "messages": 45,
    "revisions": 50,
    "recovery_events": 2,
    "raw_streams": 15,
    "raw_stream_batches": 60
  }
}
```

### Footer Invariants:
- `complete` must strictly equal `true`.
- `counts` must contain non-negative integers for all 6 included stores.
- Every count declared in `counts` must match the exact number of records observed in the file for that store. Any discrepancy results in an immediate `footer_count_mismatch` validation error.
- **No data lines are permitted after the footer record.**

---

## 7. Memory & Safety Limits

- **Maximum In-Memory Source Threshold:** `MAX_IN_MEMORY_PORTABLE_BACKUP_SOURCE_BYTES = 104,857,600` (100 MiB).
- If database evidence exceeds the in-memory threshold, the snapshot process aborts cleanly with an explicit error.
- **Fail-Safe Integrity:** No partial or corrupt backup file is ever emitted or marked as successful.

---

## 8. Validation Rules for Importers (Preview for 2E.2)

A conforming reader/validator MUST:
1. Decompress the gzip container and reject any stream errors (`corrupt_gzip_stream`).
2. Verify line 0 is a valid JSON manifest with `format: "deepseek-streamarchive-backup"` and `formatVersion: 1`.
3. Reject `formatVersion > 1` with `unsupported_backup_version`.
4. Validate that each record belongs to the 6 whitelisted stores in monotonic store sequence.
5. Validate primary key sorting within each store block.
6. Verify the terminal footer record exists with `complete: true`.
7. Verify footer counts match actual records exactly.
8. Reject any extra lines following the footer.

---

## 9. Privacy & Security Notice

> [!WARNING]
> **Unencrypted Local File:**  
> Portable Backup v1 files are compressed with gzip but are **not encrypted**.
> A backup file contains:
> - User prompts and assistant responses
> - DeepThink chain-of-thought reasoning traces
> - Preserved pre-filter responses recovered before censorship
> - Raw HTTP streaming chunks and wire evidence
>
> Users must store backup files securely and avoid uploading them to untrusted locations.
