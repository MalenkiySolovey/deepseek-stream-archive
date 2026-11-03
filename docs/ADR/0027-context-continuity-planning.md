# ADR 0027: Branch-Aware Context Continuity Planning & Transparent Preview

## Status

Accepted

## Context

When DeepSeek assistant responses are truncated, replaced by canned safety templates, interrupted by transient network drops, or halted prematurely, the local StreamArchive database faithfully preserves the uncorrupted streaming text and DeepThink reasoning.

However, in the upstream DeepSeek web session, the server-side conversation history records only the canned rejection or incomplete turn. When the user continues the chat (e.g., asking "continue", "elaborate on point 2", or "summarize the code above"), the server model has zero awareness of the lost content, causing disorientation and hallucination.

Common naive solutions to this problem exhibit severe failure modes:
1. **Silent Request Mutation:** Intercepting and rewriting outgoing fetch/XHR request payloads (`prompt` or `messages`) behind the user's back violates user agency, risks catastrophic prompt injection, and destroys extension verifiability.
2. **Composer / DOM Hijacking:** Typing synthetic text into the textarea or accessing `__reactFiber` triggers race conditions, input lags, and React virtual DOM desynchronization.
3. **Cause-Biased Filtering:** Arbitrarily treating censorship recovery differently from network interruption recovery creates inconsistent context boundaries.
4. **Context Overflow:** Stuffing unbounded historical turns into subsequent prompts blows past model context limits and triggers server errors.
5. **Database Pollution:** Persisting speculative or synthetic "injected" events into IndexedDB compromises the immutable raw forensic journal.

## Decision

We introduce **Branch-Aware Context Continuity Planning & Transparent Preview (Milestone 2D.5A)** governed by the following architectural invariants:

### 1. Two-Phase Separation (2D.5A vs 2D.5B)
Milestone 2D.5 is strictly bisected:
- **Phase 2D.5A (This Milestone):** Pure, derived planning, branch-aware eligibility evaluation, bound clamping, disclosure formatting, and transparent Side Panel preview. **ZERO** outgoing network modifications, **ZERO** composer typing, **ZERO** request mutations.
- **Phase 2D.5B (Future Milestone):** Explicit context delivery / request augmentation, strictly guarded by user confirmation and explicit toggle.

### 2. Forensic Metadata vs Structural Eligibility Invariant
**CRITICAL ARCHITECTURAL RULE:** Recovery cause (`content_filter`, `template_response`, `network_interruption`, `user_stop`, `client_abort`, `other`, `unknown`) is purely informational metadata, **NOT** an eligibility or exclusion gate.
Filtered, interrupted, stopped, and replaced responses participate equally in Context Continuity if all structural canonical invariants are satisfied.

### 3. Pure Topological Branch Ancestry
Lineage is derived strictly from the canonical DAG topology (`parentId`), never from DOM order or local wall-clock timestamps:
- Traces upward from the active leaf message or downward using user sibling selections (`branchSelections`).
- Sibling branches created by native `Regenerate` remain completely isolated: candidates on alternate sibling branches are marked `wrong_branch` and excluded.
- Cycles are safely broken without infinite loops.
- Non-logical turns (`isAttemptOnly: true`, `isUnmatchedCapture: true`) are stripped prior to topological resolution.

### 4. Pure Derived Non-Durable State (`DB_VERSION = 8` Invariant)
A `ContextContinuityPlan` is purely derived on-demand from canonical state.
- **Zero IndexedDB migrations:** Schema remains strictly at `DB_VERSION = 8`.
- **Zero durable synthetic records:** No fake `ContextInjection` events or mock messages are written to IndexedDB.
- Single read-only transaction across `[messages, revisions, recovery_events]` queries all necessary data with zero N+1 overhead.

### 5. Clamped Budgets & Safe Slicing
Plans enforce strict deterministic bounds (`DEFAULT_CONTINUITY_LIMITS`):
- `maxBlocks`: 4
- `maxTextChars`: 12,000
- `maxThinkingChars`: 6,000
- **Whole-block preference:** Newer turns are prioritized whole; older turns are dropped entirely rather than fragmenting context.
- **Surrogate-pair safe UTF-16 slicing:** String boundaries never split UTF-16 surrogate pairs (`\uD800`–`\uDBFF`).
- **Visible truncation disclosures:** Any omission or truncation is explicitly disclosed in the plan preview.

### 6. Strict Default OFF & DeepThink Discretion
- Context Continuity defaults strictly to `enabled: false`.
- Inclusion of recovered DeepThink reasoning defaults strictly to `includeThinking: false` to respect token budgets and privacy.
- Settings are persisted in `chrome.storage.local`.

### 7. Transparent Inspection & Manual Bridging
Before any future active delivery mechanism exists, users can:
- Inspect derived context metrics and exclusion reasons directly in the Side Panel Conversation View.
- Review formatted payload with boundaries (`[StreamArchive recovered conversation context]`).
- Copy the formatted payload via a single click to manually paste into DeepSeek composer if desired.

## Consequences

### Positive
- Users gain full visibility into what context was lost and how it can be bridged.
- Complete network isolation and passive capture invariants remain 100% untampered.
- Zero risk of React virtual DOM corruption or breaking native DeepSeek toolbar actions.
- Full bilingual EN/RU interface with accessible modals and stats grids.
- Tested by 49 unit tests and a Playwright E2E browser spec.

### Neutral
- Context injection into the upstream model is not automated in 2D.5A; manual copying is required until Phase 2D.5B.
- Character budgets limit maximum historical context to prevent token overflows.
