# Context Continuity & Branch-Aware Planning

## 1. Overview

**Context Continuity** is StreamArchive's mechanism for bridging conversational context when DeepSeek assistant responses are truncated, replaced by safety filters, interrupted by network failures, or stopped prematurely.

While DeepSeek's server-side history retains only the censored boilerplate or truncated fragment, StreamArchive preserves the pristine uncorrupted response locally. Context Continuity evaluates the canonical conversation DAG, identifies locally preserved responses on the active branch, and constructs a bounded, disclosure-rich context plan that allows future prompts to maintain coherent continuity.

---

## 2. Core Architectural Guarantees

### Absolute Passive Transport Invariant
- **ZERO unsolicited outgoing request modifications:** By default, StreamArchive modifies **no** outgoing fetch/XHR request payloads, adds **no** custom HTTP headers, and tampers with **no** network transport buffers unless Context Continuity is explicitly armed by the user.
- **ZERO composer / DOM typing:** StreamArchive does **not** inject text into DeepSeek's textarea or manipulate React internal fibers (`__reactFiber` / `__reactProps`).
- **Passive capture integrity:** Raw SSE stream capture and canonical event processing remain 100% passive and forensic.

### Forensic Cause vs Eligibility Orthogonality
- **Invariant:** Recovery cause (`content_filter`, `template_response`, `network_interruption`, `user_stop`, `client_abort`, `other`, `unknown`) is purely informational forensic metadata, **NOT** an eligibility gate.
- Filtered responses, interrupted network responses, manually stopped responses, and client-aborted responses participate under the **identical structural eligibility rules**.

### Derived Non-Durable Plans
- Plans are derived purely on-demand in memory.
- **Excluded from Backup:** Operational receipts and dispatch states are strictly operational in IndexedDB and excluded from Portable Backup.
- **Zero synthetic database entries:** No mock records or speculative events are written to IndexedDB.
- A single read-only transaction queries `[messages, revisions, recovery_events]` to prevent N+1 transactional round-trips.

---

## 3. Structural Eligibility Rules

To be included in a `ContextContinuityPlan`, a message must satisfy all of the following conditions evaluated by `evaluateContinuityEligibility()`:

1. **Conversation Integrity:** `message.conversationId === targetConversationId`.
2. **Logical Assistant Turn:** `message.role === 'assistant'` and `isLogicalMessage(message)` is true (non-logical turns with `attempt_only` or `unmatched_capture` are strictly excluded).
3. **Active Canonical Branch Ancestry:** The message must be an ancestor or node of the currently active branch path. Sibling turns from alternate regenerations are excluded with reason `wrong_branch`.
4. **Server History Deduplication:** If the message is already present in DeepSeek's authoritative server history (verified via `serverHistoryAuthoritativeIds`, `message.remoteId`, or reconciled history revisions), it is excluded with reason `already_in_server_history`.
5. **Downstream Context Bridging:** If a response was already bridged into downstream context, it is excluded with reason `already_bridged` to prevent double-injection.
6. **Usable Locally Preserved Content:** The message must possess a valid, non-empty text revision or thinking revision. Revisions pointed to by an authoritative `RecoveryEvent` or marked `isLastGood` take precedence.

---

## 4. Topological Branch Ancestry Algorithm

Lineage is resolved purely from message topology (`parentId`), completely independent of DOM order or timestamps:

- **Upward Traversal:** When an explicit `leafMessageId` is provided (e.g. from the currently viewed message), the algorithm traces upward through `parentId` pointers to the conversation root, recording exact topological depths.
- **Downward Traversal:** When tracing from root, the algorithm walks child groupings, applying user sibling choices from `branchSelections` (defaulting to sibling 0).
- **Cycle Resistance:** A visited set breaks any circular `parentId` loops safely.
- **Attempt Filtering:** Attempt-only artifacts and unmatched captures are pruned before tree traversal.

---

## 5. Budget Clamping & Truncation Safety

To ensure context stays well within model context limits, plans apply strict bounds (`DEFAULT_CONTINUITY_LIMITS`):

- **Maximum Blocks:** 4 responses (`maxBlocks = 4`).
- **Maximum Assistant Text:** 12,000 UTF-16 code units (`maxTextChars = 12000`).
- **Maximum Thinking Text:** 6,000 UTF-16 code units (`maxThinkingChars = 6000`).

### Whole-Block Preference
When the candidate set exceeds `maxBlocks`, the planner selects the newest relevant turns whole, completely omitting older blocks rather than including confusing fragments. Omissions are visibly recorded (`omittedBlockCount`) and disclosed in the header notice.

### Surrogate-Safe UTF-16 Slicing
When a single response block exceeds character limits, `sliceSafeUtf16()` ensures that high surrogates (`0xD800`–`0xDBFF`) are never separated from low surrogates, preventing Unicode corruption. A visible disclosure marker is appended:
`[... Truncated to fit Context Continuity character budget ...]`

---

## 6. Output Formatting & Boundaries

The formatted plan produces deterministic markdown with clear boundary delimiters:

```markdown
[StreamArchive recovered conversation context]

[Note: 1 older recovered response(s) omitted to respect Context Continuity limit]

Recovered assistant response 1
Recovery cause: content_filter

Recovered DeepThink:
1. Deconstruct premises.
2. Outline core mathematical model.

Recovered answer:
Full uncorrupted analytical explanation preserved from local archive.

---

Recovered assistant response 2
Recovery cause: network_interruption

Partial response captured before socket closure.

[End StreamArchive recovered conversation context]
```

---

## 7. User Experience in Side Panel

### Settings Tab
- **Enable Context Continuity:** Toggle switch in Side Panel Settings. Defaults strictly to **OFF**.
- **Include DeepThink Reasoning:** Optional sub-toggle. Defaults strictly to **OFF**.
- Settings persist across browser sessions in `chrome.storage.local`.

### Conversation View Header
- When Context Continuity is enabled, a dedicated **"🔄 Preview Continuity"** button appears in the conversation header.
- Clicking the button derives the active branch plan via background messaging and opens the **Context Continuity Preview Modal**.

### Transparent Preview Modal
- **Metrics Grid:** Displays eligible response count, total text characters, DeepThink status, and omitted blocks.
- **Disclaimer Banner:** Highlights that Context Continuity is non-destructive and derived.
- **Payload Preview:** Formatted markdown viewer ready for inspection.
- **Copy Action:** "Copy Preview" button copies the formatted payload to clipboard for instant manual pasting into DeepSeek composer.
- **Exclusion Audit:** Collapsible disclosure listing every excluded message and its structural reason (`wrong_branch`, `already_in_server_history`, etc.).

---

## 8. Capability Summary

| Capability | Scope | Status |
| :--- | :--- | :--- |
| **Context Continuity Planning** | Branch-aware planning, pure derived state, zero network modification, Side Panel transparent preview & copy. | **Complete** |
| **Explicit Context Delivery** | Explicit user-controlled prompt augmentation, `manual_next` single-use arming, and clean user-turn presentation. | **Complete** |
