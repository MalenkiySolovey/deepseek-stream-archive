# Context Continuity Delivery & Prompt Augmentation

## 1. Overview

**Milestone 2D.5B** delivers the execution phase of StreamArchive's Context Continuity architecture. While Milestone 2D.5A introduced branch-aware planning, bound clamping, and transparent preview, Milestone 2D.5B allows locally recovered assistant responses (from content filters, network drops, or client aborts) to be explicitly delivered into subsequent DeepSeek model turns without manual copy-pasting.

```text
[Locally Recovered Assistant Response]
               ↓
   Context Continuity Planner (2D.5A)
               ↓
   Delivery Envelope Armed (2D.5B)
               ↓
Outgoing User Generation Request Intercepted
               ↓
  Prompt Augmented with Context Disclosures
               ↓
   DeepSeek Model Answers with Full Context
               ↓
   Durable Continuity Receipt Committed
```

---

## 2. Core Architectural Invariants

### 2.1 Strict Default OFF
- Context Continuity defaults strictly to `enabled: false`.
- When disabled, zero request mutation occurs under any condition.
- When enabled, the user chooses between two delivery modes:
  - **`manual_next` (Default):** Single-use armed delivery. The user clicks "Use continuity for next message" (`⚡ Use continuity for next message` / `⚡ Восстановить контекст в следующем сообщении`). The next outgoing request on the active branch is augmented, and the envelope is immediately disarmed.
  - **`automatic`:** The active branch is continuously monitored; if eligible context exists that has not yet been bridged, the next prompt is automatically augmented without requiring manual arming.

### 2.2 Fail-Open Invariant
Under **zero circumstances** may StreamArchive corrupt, stall, or prevent an outgoing prompt from reaching DeepSeek.
If any validation fails:
- Target endpoint does not match `/api/v0/chat/completion`
- HTTP method is not `POST`
- Request body is not valid JSON string (e.g., FormData, Blob, Stream)
- Target session ID does not match `envelope.remoteConversationId`
- Target parent message ID does not match `envelope.expectedParentMessageId`
- Prompt is missing, empty, or whitespace-only
- Delivery envelope has expired (5-minute TTL)
- Prompt is already augmented with a valid continuity marker

**The original request is dispatched completely unmodified.**

### 2.3 Non-Prompt Body Preservation
Only the `prompt` attribute in the JSON payload is augmented.
All other request fields—such as `chat_session_id`, `parent_message_id`, `ref_file_ids`, `thinking_enabled`, `search_enabled`, `preempt`, and `model_type`—are preserved byte- and value-identical.

### 2.4 Delimiter Marker & Retry Idempotency
Augmented prompts are enclosed in unambiguous delimiter boundaries:
```text
[StreamArchive Context Continuity v1 — <deliveryId>]
---
[DeepSeek Assistant Context (Recovered Turn)]
<assistantResponseText>
---
[End StreamArchive Context Continuity]

<userAuthoredPrompt>
```
If DeepSeek's frontend executes multiple transport retries upon network turbulence, `hasContinuityMarker(prompt)` detects the boundary marker and skips re-augmentation, preventing duplicated disclosures.

### 2.5 Route Navigation Isolation
When navigating between chat sessions via DeepSeek's client-side SPA navigation, any active armed envelope is synchronously revoked, guaranteeing that context from Conversation A is never accidentally delivered into Conversation B.

---

## 3. Operational Receipt Ledger (`DB_VERSION = 9`)

To provide auditability, monitor delivery health, and prevent infinite re-injection loops, schema version 9 introduces the `context_continuity_receipts` object store.

### 3.1 Receipt Schema
```typescript
export interface ContextContinuityReceipt {
  id: string; // Unique receipt ID
  deliveryId: string; // Delivery envelope ID
  conversationId: string; // Local conversation ID
  remoteConversationId?: string; // DeepSeek chat_session_id
  parentMessageId?: string | null; // DeepSeek parent_message_id
  sourceMessageIds: string[]; // Message IDs whose text was included
  sourceRevisionIds: string[]; // Revision IDs whose text was included
  deliveryMode: 'automatic' | 'manual_next';
  state: 'dispatched' | 'response_observed' | 'bridged' | 'failed';
  rawStreamKey?: string; // Associated raw transport stream key
  resultingMessageId?: string; // Resulting assistant message ID
  error?: string;
  createdAt: number;
  updatedAt: number;
}
```

### 3.2 State Lifecycle
1. `dispatched`: Prompt was augmented and dispatched across the network.
2. `response_observed`: Outgoing request resulted in an active incoming SSE stream from DeepSeek.
3. `bridged`: Terminal canonical checkpoint was persisted, verifying the model answered the turn.
4. `failed`: Outgoing stream was aborted or failed.

### 3.3 Infinite Re-Injection Prevention
When `buildContextContinuityPlan` evaluates candidates, all message IDs belonging to receipts in state `bridged` are excluded via `alreadyBridgedIds`. Once a recovered turn has been successfully bridged into the conversation, it is never injected into subsequent turns again.

### 3.4 Backup Non-Pollution
The `context_continuity_receipts` store contains operational transport telemetry only and is listed in `EXCLUDED_BACKUP_STORES`. Portable Backup v1 remains frozen at `formatVersion: 1`.

---

## 4. History Reconciliation & UI Presentation

When passive history synchronization ingests user turns containing continuity markers:
1. `parseStreamArchiveAugmentedPrompt` isolates and removes the delimiter block.
2. The user's clean authored text is preserved in `message.content`.
3. The delivery ID is stored in `message.contextContinuityDeliveryId`.
4. The Side Panel and UI present the clean user message with an attached badge:
   `🔄 Context Continuity attached` / `🔄 Контекст StreamArchive прикреплен`.
