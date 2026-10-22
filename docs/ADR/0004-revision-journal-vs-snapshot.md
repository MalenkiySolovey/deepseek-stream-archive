# ADR 0004: Revision Journal & Buffered Flush Policy vs Single Snapshot Overwrites

## Status
Accepted

## Context
Existing anti-retract solutions make one of two flawed choices for tracking data during streaming generation:
1. **Single Latest Overwrite (e.g. `deepseek-anti-retract`):**
   Maintains a single key-value entry per turn (`messageBackup.set(key, latest)`). When DeepSeek replaces the answer with a refusal template, if the recorder happens to record that refusal string, the previous useful answer is completely overwritten and destroyed.
2. **Per-Token Database Commits:**
   Committing an IndexedDB transaction for every incoming SSE chunk/token generates hundreds of database write transactions per second. This causes significant CPU overhead, battery drain, and browser thread blocking.

Furthermore, a response can go through multiple meaningful phases:
- Initial thinking generation.
- Useful answer streaming.
- User editing the prompt.
- Model regenerating the answer.
- Network abort midway.
- Content filter intervention.

A single string cannot capture this lifecycle.

## Decision
1. **Append-Only Revision Journal Model:**
   A `Message` entity owns an ordered collection of `ResponseRevision` records:
   ```text
   Message (id: "msg_123", remoteId: "109842")
    ├── Revision 1 (rev: 1, text: "Thinking...", isThinking: true,  capturedAt: T1)
    ├── Revision 2 (rev: 2, text: "The solution is...",           capturedAt: T2)
    ├── Revision 3 (rev: 3, text: "The solution is... [Code]",    capturedAt: T3) [LAST GOOD]
    └── Revision 4 (rev: 4, text: "I cannot assist with this.",   capturedAt: T4, isFiltered: true)
   ```
   Each revision has a monotonically increasing revision index (`1, 2, 3...`), a timestamp, source metadata, and status tags (`final`, `filtered`, `interrupted`).

2. **Adaptive Memory Buffer with Hybrid Flush Policy:**
   During real-time streaming, tokens accumulate in an in-memory `RevisionBuffer`. Data is persisted to IndexedDB using a hybrid trigger policy:
   - **Debounced Time Threshold:** Commit a revision snapshot every `500ms` if new tokens have arrived.
   - **Size Threshold:** Commit immediately if uncommitted text exceeds `2,048 characters` (preventing massive loss on browser crash).
   - **Immediate Event Flush:** Flush immediately without delay upon:
     - Stream completion (`status === 'FINISHED'` or `[DONE]`).
     - Error or abort signals (`status === 'CONTENT_FILTER'`, `TEMPLATE_RESPONSE`, `net::ERR_*`).
     - Window unload / navigation events (`beforeunload`, `pagehide`).
     - Message regeneration / prompt edit triggers.

3. **Explicit "Last-Good Revision" Resolution:**
   When a message transitions to a filtered, retracted, or error state, the system automatically tags the immediate prior revision that contained substantive non-refusal content as the `LastGoodRevision`. This is the candidate presented to the user in recovery UI and inline badges.

## Consequences
- **Positive:**
  - Zero data loss: Even if the final event is a censorship replacement, the previous useful revision is preserved in the database journal.
  - High performance: Batching writes to at most 2 per second eliminates database thrashing.
  - Audit trail: Users can inspect how an answer evolved or compare regenerated alternatives.
- **Negative:**
  - Requires database retention policies (ADR 0007) to prune intermediate incremental revisions once a generation has successfully finalized without retraction.
