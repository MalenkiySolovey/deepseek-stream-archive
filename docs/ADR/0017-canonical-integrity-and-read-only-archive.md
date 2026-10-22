# ADR 0017: Canonical Integrity Preflight & Read-Only Archive Browser

## Status
Accepted

## Context
In StreamArchive, DeepSeek StreamArchive completed the capture, raw evidence journal, and canonical models (Conversation, Message, ResponseRevision, RecoveryEvent). However, an integrity review identified residual risks:
1. **Checkpoint Sequence Enforcement:** Checkpoints could arrive out-of-order or with gaps if not validated against a durable ledger.
2. **Payload Mutability:** Revisions and recovery events could theoretically be overwritten if conflicting payloads reused the same ID.
3. **Identity Regressions:** Merging live or history data could downgrade reconciled messages to provisional or overwrite terminal `filtered` status.
4. **Provisional ID Divergence:** Live streaming and raw journal replay rebuilder generated divergent local provisional IDs for the same stream.
5. **IPC & Storage Quadratic Overhead:** `CanonicalStreamCoordinator` repeatedly re-sent all previous revisions on every checkpoint.
6. **Conflicting History Duplicates:** Server history payloads containing duplicate remote message IDs with conflicting payloads were skipped rather than rejected.
7. **User Interface Boundary:** Users lacked a native UI within the extension to view saved conversations, navigate branch trees, inspect thinking, and copy uncensored responses preserved prior to content filtering.

## Decisions

### 1. Durable Checkpoint Ledger (`STORE_CANONICAL_CHECKPOINTS`)
- Upgraded database schema to `DB_VERSION = 5` with object store `canonical_checkpoints` keyed by `streamKey`.
- Checkpoints must start strictly at sequence 0 (`seq = 0`). Non-zero initial sequence throws `checkpoint_sequence_gap`.
- Subsequent checkpoints must advance monotonically (`seq = lastCommitted + 1`).
- Sequence gaps (`seq > lastCommitted + 1`) are rejected, aborting the write transaction.
- Duplicate checkpoints (`seq === lastCommitted`) are handled idempotently without mutating state.

### 2. Immutable Revision and Recovery Event Payloads
- Revisions and recovery events are immutable.
- Existing payloads with identical contents (`isRevisionPayloadIdentical`, `isRecoveryEventIdentical`) are permitted as idempotent writes.
- Any conflicting modification to existing revision text, thinking, status, or recovery event throws `revision_conflict` or `recovery_event_conflict`.

### 3. Canonical Message Identity & Merge Policy
- Pure merge policy in `mergeCanonicalMessage()`:
  - Identity state: `reconciled > provisional`. Once reconciled, a message cannot revert to provisional.
  - Status transitions: terminal states (`filtered`, `finished`) cannot be downgraded to `streaming`. Specifically, `filtered` is preserved across live, replay, and history merges.
  - Linkage preservation: `parentId`, `remoteParentId`, `content`, and `sourceRawStreamKey` are non-destructively preserved.

### 4. Unified Provisional Message ID
- Deterministic formula `makeProvisionalMessageId(rawStreamKey)` is enforced across both `CanonicalStreamCoordinator` and `ReplayRebuilder`.

### 5. Incremental Checkpoint Slicing & Serial Queue
- `CanonicalStreamCoordinator` slices revisions and recovery events from `lastAckedRevisionCount` and `lastAckedRecoveryEventCount`.
- Counters advance only upon matching successful ACK.
- Checkpoints are queued sequentially, eliminating concurrency races.
- Checkpoints fire on new revisions, recovery events, remote ID identification, or terminal events.

### 6. Conflicting Duplicate Remote ID Rejection in History
- `DeepSeekHistoryParser` compares duplicate remote message IDs:
  - Identical duplicates are safely deduplicated.
  - Conflicting duplicates (different role, parentId, status, text, or thinking) reject the entire payload (`return null`), guaranteeing zero partial ingestion.

### 7. Read-Only Side Panel Archive Browser
- Built entirely in Svelte 5 runes within the Chrome Extension Side Panel.
- Primary tabs: `Archive` (default), `Diagnostics`, `Settings`.
- Conversation list: metadata-first cursor pagination (`updatedAt` descending), search filter, recovery shield badge.
- Conversation detail view: message thread, branch switcher (`Branch X of Y`), collapsible thinking box, safe markdown renderer (zero `innerHTML` / zero `eval`).
- Recovery Preview Card: prominently displays pre-filtered last-good text with one-click copy.
- Localization: dictionary-based `en` and `ru` support.

### 8. Architectural & Security Bounds
- Extension permissions strictly `["storage", "sidePanel"]`.
- Host permissions strictly `https://chat.deepseek.com/*`.
- Zero in-page DOM injection or page alteration.
- Zero authenticated API polling or credential access.

## Consequences
- Guarantees append-only, crash-durable canonical persistence with zero corruption risks.
- Provides an immediate, clean, local-first UI for users to view and recover their DeepSeek conversations.
- Establishes a verified foundation for in-page recovery.
