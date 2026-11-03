# ADR 0028: Explicit Context Delivery & Prompt Augmentation

## Status

Accepted

## Context

In Milestone 2D.5A (ADR 0027), StreamArchive established pure, branch-aware Context Continuity planning and transparent Side Panel inspection. While users could preview and manually copy recovered assistant context, continuing an upstream DeepSeek conversation required manual copy-pasting into the composer.

Bridging this gap by automating context delivery poses severe risks if implemented naively:
1. **Silent Request Tampering:** Mutating outgoing network requests without explicit user intent violates user consent and security boundaries.
2. **Double-Injection on Network Retries:** DeepSeek's web client frequently performs multiple XHR/fetch transport retries when network conditions fluctuate; augmenting every retry attempt causes duplicated, compounding disclosures.
3. **Session or Branch Bleed:** Injecting context intended for Branch A into Branch B or an unrelated chat session causes severe model disorientation.
4. **Infinite Re-Injection Loops:** If the system continually re-injects the same recovered response in turn after turn, prompt tokens are wasted and conversation coherence degrades.
5. **Loss of Author Intent:** Prefixing user prompts permanently distorts the user's canonical message history unless the augmentation envelope is cleanly detected, parsed, and transparently badged.
6. **Fragile DOM Automation:** Programmatically typing into textarea inputs or poking React fibers triggers event listener races, React reconciliation collisions, and input locks.

## Decision

We introduce **Explicit Context Delivery & Prompt Augmentation (Milestone 2D.5B)** governed by the following architectural invariants:

### 1. Strict Default OFF & User Sovereignty
- Context Continuity defaults strictly to `enabled: false`.
- Outgoing requests are **NEVER** mutated when the feature is disabled.
- The user maintains granular control over delivery modes:
  - `manual_next`: (Default mode when enabled) Context delivery requires explicit single-use arming via the Side Panel ("Use continuity for next message" / "Восстановить контекст в следующем сообщении"). Upon the first successful request augmentation, the envelope is consumed and automatically disarmed.
  - `automatic`: Proactively prepares an envelope for the active branch and augments the next outgoing eligible generation request without requiring repetitive manual clicks.

### 2. Fail-Open Invariant
Under **NO** circumstances may StreamArchive abort, stall, or corrupt an outgoing user request if context delivery cannot be proven 100% safe.
If any check fails:
- Endpoint is not candidate (`/api/v0/chat/completion` or user generation endpoint)
- Method is not `POST`
- Request body is unsupported (FormData, Blob, Stream, non-JSON)
- JSON parsing fails or prompt is missing/empty
- Session ID (`chat_session_id`) or parent message ID (`parent_message_id`) does not match the active envelope
- Delivery envelope has expired (5-minute TTL)
- Prompt is already augmented with a valid continuity marker

**The original request is passed through completely untouched.**

### 3. Non-Prompt Body Invariant
When prompt augmentation succeeds, StreamArchive only modifies `body.prompt`.
All other payload attributes—including `chat_session_id`, `parent_message_id`, `ref_file_ids`, `thinking_enabled`, `search_enabled`, `preempt`, and `model_type`—are preserved byte- and value-identical.

### 4. Idempotency & Double-Injection Prevention
Augmented prompts are enclosed in unambiguous delimiter markers:
```text
[StreamArchive Context Continuity v1 — <deliveryId>]
---
<formattedContext>
---
[End StreamArchive Context Continuity]

<userPrompt>
```
If DeepSeek's frontend retries an outgoing generation request, `hasContinuityMarker(prompt)` detects the existing delimiter and skips re-augmentation, guaranteeing single delivery.

### 5. Durable Operational Ledger (`DB_VERSION = 9`)
To record delivery telemetry, ensure auditability, and break infinite re-injection loops, schema version is bumped to `DB_VERSION = 9` with a dedicated store:
- `STORE_CONTEXT_CONTINUITY_RECEIPTS`: records `ContextContinuityReceipt` objects indexed by `conversationId`, `state`, `createdAt`, and `rawStreamKey`.
- **Receipt Lifecycle:**
  - `dispatched`: Prompt was augmented and dispatched across the network.
  - `response_observed`: Outgoing request resulted in an active incoming SSE stream.
  - `bridged`: Terminal canonical checkpoint was persisted, confirming the model received and responded to the augmented context.
  - `failed`: Terminal stream was aborted or failed.
- **Already-Bridged Filtering:** When planning future continuity turns, `getBridgedMessageIdsForConversation` feeds all previously bridged message IDs into `alreadyBridgedIds`, ensuring a recovered turn is bridged exactly once per branch.

### 6. Portable Backup v1 Frozen Guarantee
`context_continuity_receipts` represents ephemeral operational state and transport telemetry.
It is explicitly added to `EXCLUDED_BACKUP_STORES`. Portable Backup v1 remains frozen at `formatVersion: 1`, ensuring complete backward and forward backup compatibility.

### 7. Transparent History Reconciliation
When passive history ingestion encounters an augmented user prompt from DeepSeek's server history:
- `parseStreamArchiveAugmentedPrompt` extracts the original user-authored text.
- The canonical `Message` record stores the clean user prompt in `content` and records `contextContinuityDeliveryId`.
- The Side Panel and UI render the clean user prompt alongside a transparent indicator badge:
  `🔄 Context Continuity attached` / `🔄 Контекст StreamArchive прикреплен`.

### 8. Route Isolation & Synchronous Revocation
If the user navigates between chats via client-side SPA route transitions, `interceptor.content.ts` synchronously catches the navigation event and revokes any armed delivery envelope, preventing cross-session context leakage.

## Consequences

### Positive
- Fully automated or one-click context recovery in live DeepSeek conversations.
- Zero copy-pasting required to bridge filtered or network-interrupted assistant answers.
- Strict fail-open guarantees prevent broken user prompts or failed generations.
- Complete operational traceability via durable receipts.
- Portable Backup format remains untouched and frozen.
- Clean canonical user history without repetitive disclosure boilerplate.

### Negative / Trade-offs
- Outgoing augmented requests consume slightly more context tokens corresponding to the recovered text length (clamped by `DEFAULT_CONTINUITY_LIMITS`).
- Requires MAIN-world fetch and XHR request hooks to transparently augment candidate JSON payloads prior to network dispatch.
