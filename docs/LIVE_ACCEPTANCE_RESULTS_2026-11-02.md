# DeepSeek StreamArchive — Live Acceptance Execution Report (2026-11-02)

> [!IMPORTANT]
> **VERDICT: LIVE COMPATIBILITY BASELINE ACCEPTED**
> - **Execution Date:** 2026-11-02
> - **Automated Compatibility Baseline:** 379 unit/integration tests passing (55 suites), 10 Playwright Chromium MV3 browser compatibility tests passing (9 specs) with fail-closed network isolation.
> - **Manual Production Verification:** Verified against production user session at `https://chat.deepseek.com/`.
> - **Scope & Limits:** This baseline certifies extension non-destructive operation, passive transport capture, and crash durability against current production DeepSeek. It does **not** constitute a permanent guarantee against future DeepSeek web changes, nor does it represent Chrome Web Store publication readiness.

---

## 1. Test Environment Metadata

| Metadata Field | Recorded Value |
|---|---|
| **Test Execution Date** | 2026-11-02 |
| **Operating System** | Windows 11 Version 26H2 |
| **Browser Version** | Google Chrome 156.0.8078.74 (Official Build, 64-bit) |
| **Accepted Git Commit SHA** | `c75d0caf37331bad5206e7db72c300d15b5250bb` |
| **Extension Version** | `0.1.0` (Chromium Manifest V3) |
| **Extension Build Directory** | `.output/chrome-mv3` |
| **Target Web App URL** | `https://chat.deepseek.com/` |
| **Current Observed Transport** | `XMLHttpRequest` streaming with SSE payload (`text/event-stream`) |
| **Database Schema** | `StreamArchiveDB` (Version 8) |
| **Install State** | Existing `StreamArchiveDB` v7 database upgraded and repaired to v8 |

---

## 2. Invariant Preflight & Permissions

- [x] Extension built cleanly via `pnpm run build` with zero compiler errors.
- [x] Extension loaded unpacked into Chromium via `chrome://extensions/`.
- [x] Extension permissions verified strictly limited to: `storage`, `sidePanel`.
- [x] Extension host permissions verified strictly limited to: `https://chat.deepseek.com/*`.
- [x] Zero external network egress, zero third-party scripts, zero analytics/telemetry.
- [x] Privacy rules strictly enforced: zero account emails, tokens, cookies, auth headers, or private user texts recorded.

---

## 3. Scenario Execution Results

### Scenario 1: Normal Unfiltered Response Generation (Mandatory)
- **Observed Behavior:**
  - Outgoing streaming requests captured via passive XMLHttpRequest interception.
  - Streaming tokens render in DeepSeek's frontend with zero stutter, delay, or DOM interference.
  - Raw Journal commits sequential batches into `STORE_RAW_STREAMS` and `STORE_RAW_STREAM_BATCHES`.
  - Canonical stream coordinator commits monotonic checkpoints with truthful state progression.
  - Side Panel reflects complete prompt and assistant response with exact character counts.
- **Verdict:** **`PASS`**

---

### Scenario 2 & 3: Content Filter Replacement & Token-0 Refusal (Conditional)
- **Status & Provenance:**
  - A natural `CONTENT_FILTER` with `TEMPLATE_RESPONSE` replacement was observed during live testing on parent build `e90837bf32f42fd1cc606d7353fac36c0b4f804b`.
  - The unredacted pre-filter last-good text was frozen into an immutable `isLastGood` revision, and a structured `RecoveryEvent` was durably stored.
  - The recovery badge and modal card in closed Shadow DOM rendered correctly without host-DOM mutation.
  - Upon migration from `StreamArchiveDB` v7 to v8 on commit `c75d0caf37331bad5206e7db72c300d15b5250bb`, the historical recovery record remained fully intact and readable in the Side Panel.
  - No synthetic hazardous prompts were submitted to force a re-trigger on `c75d0ca`.
  - Automated mathematical correctness and DOM isolation of content filter replacement are verified by Playwright suite (`tests/browser/filter-replacement.spec.ts`).
- **Verdict:** **`PASS (Observed on parent build e90837b; preserved across v8 upgrade; automated E2E verified)`**

---

### Scenario 4: Fast Navigation & Mid-Stream Route Switch (Mandatory)
- **Observed Behavior:**
  - Client navigated from Chat A (`/a/chat/s/SESSION_A`) to Chat B (`/a/chat/s/SESSION_B`) during active generation via client-side SPA navigation (`pushState`).
  - Content script detected route transition; overlay state for Chat A was immediately revoked before Chat B data resolved.
  - Zero recovery badges or drawer cards from Chat A leaked into Chat B.
  - Background coordinator for Chat A finalized cleanly without sequence corruption.
- **Verdict:** **`PASS`**

---

### Scenario 5A: Passive History Reconciliation (Mandatory)
- **Observed Behavior:**
  - Hard Reload (`Ctrl + F5`) executed on `chat.deepseek.com` inside an existing conversation.
  - Extension passively captured `/api/v0/chat/history_messages`.
  - Incremental history batches staged into `STORE_HISTORY_STAGING` and committed via `commitHistoryStagingPlan` atomically.
  - Provisional streaming message IDs reconciled to server UUIDs without duplicate messages or corrupted ordering.
  - Reconciled conversation survived reload idempotently.
- **Verdict:** **`PASS`**

---

### Scenario 6: Network Interruption & Transport Retry Stabilization (Mandatory)
- **Observed Behavior:**
  - OS-level network disconnect triggered mid-generation.
  - DeepSeek web client performed 3 automatic connection attempts (XHR attempts #1, #2, #3).
  - StreamArchive committed each transport attempt into `raw_streams` as independent forensic evidence.
  - Empty interrupted attempts were classified as `projectionState: 'attempt_only'` with `parentId: undefined`.
  - **Critical Invariant:** In the Archive conversation view, zero phantom sibling branches (`Branch 1 of 3`) appeared. Exactly 1 logical assistant message was displayed under the user prompt.
  - Following page reload and server history sync, the single logical message reconciled cleanly.
- **Verdict:** **`PASS`**

---

### Scenario 7: Multi-Tab Concurrency (Mandatory)
- **Observed Behavior:**
  - Separate chat sessions operated simultaneously in two independent browser tabs.
  - Distinct `producerSessionId:streamId` keys maintained complete partition; zero cross-talk observed in raw journals or canonical stores.
- **Verdict:** **`PASS`**

---

### Scenario 8: Side Panel Read-Only Archive Inspection (Mandatory)
- **Observed Behavior:**
  - Side panel browsed through archived linear conversations and branched sessions.
  - True regenerations displayed the branch switcher (`Branch X of Y`) correctly.
  - DeepThink reasoning traces collapsed and expanded cleanly.
  - Token-safe Markdown reader rendered text without `innerHTML` or `eval`.
  - Diagnostics tab truthfully reported background runtime epoch and pipeline status.
- **Verdict:** **`PASS`**

---

## 4. Invariant & Acceptance Criteria Sign-Off

| Check ID | Requirement | Criterion | Evaluated Result |
|---|---|---|---|
| **AC-01** | Zero DOM Mutation | DeepSeek message DOM nodes remain completely unmodified | **`PASS`** |
| **AC-02** | Closed Shadow DOM | Recovery badge/modal contained entirely inside closed shadow root | **`PASS`** (Live observed + E2E verified) |
| **AC-03** | Route Isolation | Zero cross-session recovery badges or content leakage across URLs | **`PASS`** |
| **AC-04** | Last-Good Recovery | Full uncensored pre-filter text recoverable upon filter trigger | **`PASS`** (Live observed + E2E verified) |
| **AC-05** | Terminal Durability | Terminal checkpoints persisted reliably through disposal and retry | **`PASS`** |
| **AC-06** | History Atomicity | Incomplete history stages never corrupt canonical database | **`PASS`** |
| **AC-07** | Strict Permissions | Manifest restricted to `storage`, `sidePanel`, and `chat.deepseek.com` | **`PASS`** |
| **AC-08** | Truth Convergence | Reconciled history retains live revisions without data loss | **`PASS`** |
| **AC-09** | Transport Retry Stabilization | Client-side transport retries never spawn phantom canonical branches | **`PASS`** |

---

## 5. Final Acceptance Decision

- [x] **LIVE COMPATIBILITY BASELINE ACCEPTED** — All mandatory criteria passed (`PASS`), observed conditional criteria passed with zero failures, and automated synthetic E2E suites confirm mathematical correctness.
- [ ] **REJECTED / DEFECTS IDENTIFIED**
- [ ] **LIVE MANUAL VERIFICATION REQUIRED**

**Sign-off Date:** 2026-11-02  
**Status:** Baseline Accepted. Next engineering phase: Milestone 2E (Human Export & Portable Backup).
