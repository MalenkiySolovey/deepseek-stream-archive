# ADR 0022: Transport Attempt Projections vs. Canonical Logical Messages & Sibling Branch Stabilization

## Status
Accepted

## Context
During live manual acceptance testing on production `chat.deepseek.com`, a critical identity distortion was discovered:
When an authenticated network interruption occurs during generation, the DeepSeek web client automatically performs transport retries (e.g. 3 consecutive XHR attempts for one prompt). 

StreamArchive's Raw Journal correctly recorded each individual attempt (`raw_streams` and `raw_stream_batches`). However, the streaming pipeline also projected each transport stream into a separate provisional canonical assistant `Message` with `makeProvisionalMessageId(rawStreamKey)`. 

When server history later arrived:
1. Only the final successful message matched a server remote ID.
2. The 2 prior failed retry attempts remained as provisional assistant messages (`status = 'interrupted'`, 0 characters, no remote ID).
3. The tree resolution phase linked all 3 messages under the same user prompt `parentId`, causing the Archive UI to render phantom sibling branches (`Branch 1 of 3`, `Branch 2 of 3`, `Branch 3 of 3`) and report 4 conversation messages instead of 2.

DeepSeek's page UI represents this as a single logical generation turn, not multiple conversation branches.

## Architectural Invariants & Decisions

### 1. Transport Attempt ≠ Canonical Logical Message
A fundamental separation of concerns is established:
- **Raw Journal (`raw_streams`, `raw_stream_batches`)**: High-fidelity forensic ledger of every network attempt (XHR #1, XHR #2, XHR #3). Raw evidence is never deleted, truncated, or merged.
- **Canonical Conversation Tree (`conversations`, `messages`, `revisions`)**: Models the user-facing logical conversation topology (`User -> Assistant`). Transport retry retries must not pollute the logical conversation branch topology.

### 2. Explicit Message Projection State (`MessageProjectionState`)
Rather than relying on implicit text heuristics, `Message` is augmented with an explicit projection taxonomy:
```typescript
export type MessageProjectionState =
  | 'logical'              // Authoritative logical turn (reconciled server message or confirmed turn)
  | 'provisional_logical'  // Active in-flight generation presumed logical
  | 'unmatched_capture'    // Partial text captured from stream, but not acknowledged by server history
  | 'attempt_only';        // Empty failed transport attempt (0 text, 0 thinking, no remote ID)
```

Pure predicates govern visibility and tree membership:
- `isLogicalMessage(msg)`: Evaluates whether the message is a true conversation turn. Returns `true` for `'logical'` and `'provisional_logical'`. Returns `false` for `'attempt_only'` and `'unmatched_capture'`.
- `isUnmatchedCapture(msg)`: Identifies meaningful superseded partial streams.
- `isAttemptOnly(msg)`: Identifies empty aborted transport connections.

### 3. Flush Guard for Empty Stream Checkpoints
`CanonicalRevisionRecorder.flush()` is hardened:
```typescript
if (this.accumulatedText === '' && this.accumulatedThinking === '') {
  return null;
}
```
Failed empty attempts never generate 0-character `ResponseRevision` records.

### 4. Tree Link Isolation & Zero Phantom Branches
`parentId` links in the canonical conversation graph represent direct conversation ancestry.
Non-logical records (`attempt_only` and `unmatched_capture`) must **never** possess a `parentId` in the conversation tree:
- In `mergeCanonicalMessage()`: If `projectionState` is `'attempt_only'` or `'unmatched_capture'`, `parentId` is strictly `undefined`.
- In `HistoryReconciler` Phase 3: Parent link resolution processes only `isLogicalMessage(m)`. Any unmatched provisional messages have their `parentId` cleared.
- Forensic provenance remains uncompromised: `remoteParentId` and `sourceRawStreamKey` are permanently retained on the record.

### 5. History Reconciler Leftover Classification
During server history ingestion, all messages in the conversation that were not matched by server remote IDs are evaluated:
- **Case A (Empty Attempt)**: 0 text, 0 thinking, no recovery events, no remote ID $\rightarrow$ Classified as `'attempt_only'`, `parentId = undefined`.
- **Case B (Partial Capture)**: Contains real captured text/thinking or recovery events $\rightarrow$ Preserved as `'unmatched_capture'`, `parentId = undefined`.

### 6. Archive UI Sibling Branch Integrity
In `ConversationView.svelte`:
- Conversation tree traversal and sibling grouping (`getSiblingInfo()`) evaluate only `isLogicalMessage()`.
- Sibling branch selector (`Branch X of Y`) appears **only** when genuine alternative assistant branches exist (e.g. true regenerate turns sharing `parentId`).
- Meaningful partial captures (`unmatched_capture`) are rendered in a distinct, dedicated technical section ("Unmatched Stream Captures") with raw stream provenance and copy capability, never as conversation branches.
- Empty transport attempts (`attempt_only`) are hidden from user conversation view.
- Conversation summary card counts only `isLogicalMessage()` in `messageCount`.

### 7. Idempotent Schema Migration & Database Repair
- Schema version bumped to `DB_VERSION = 8` with index `'projectionState'` added to `STORE_MESSAGES`.
- `repairCanonicalProjection()` provides idempotent, safe offline repair for existing databases from prior test cycles without deleting raw forensic streams.

### 8. Strict Rejection of Weak Auto-Merge
StreamArchive explicitly rejects heuristic auto-merging:
- NO merging based on string prefix or text similarity.
- NO merging based on timestamp proximity or DOM layout.
- Remote ID matching remains the sole authoritative gate for identity reconciliation.

## Consequences
- Single prompts with multiple transport retries display cleanly as 1 user prompt and 1 assistant answer.
- Conversation message count accurately reflects logical conversation size.
- Real regenerate turns continue to branch cleanly with full sibling navigation.
- Partial text captures remain accessible for audit and forensic recovery without polluting conversation semantics.
- Raw Journal integrity is 100% preserved.
