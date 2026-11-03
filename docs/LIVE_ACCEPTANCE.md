# DeepSeek StreamArchive — Live Acceptance Testing Guide

> [!IMPORTANT]
> **LIVE MANUAL VERIFICATION REQUIRED**
> - **Automated Synthetic Compatibility:** **PASSED** (373 Vitest unit/integration tests across 54 suites, 9 Playwright Chromium MV3 end-to-end tests across 8 specifications with zero external network egress).
> - **Mandatory Live Compatibility:** **PENDING HUMAN EXECUTION** against an authenticated, production user session at `https://chat.deepseek.com/`.
> - **Conditional Filter Recovery:** Record only if naturally observed; do **NOT** deliberately submit policy-violating prompts.
>
> Automated unit, fuzzing, mock-environment integration tests, and Playwright Chromium MV3 compatibility harness establish mathematical correctness of invariants and crash-durability. However, automated tests **cannot substitute for real user-authenticated sessions on `chat.deepseek.com`**.
> This document specifies the exact protocol for conducting manual end-to-end acceptance testing against the live production DeepSeek web application.

---

## 1. Mandatory vs. Conditionally Observable Live Checks

To ensure safe, ethical, and deterministic verification, live testing distinguishes strictly between two categories of checks:

### 1.1 Mandatory Live Checks
Checks that a human tester can safely and deterministically reproduce during ordinary, benign interactions:
- **Scenario 1:** Normal Unfiltered Response Generation
- **Scenario 4:** Fast Navigation & Mid-Stream Route Switch
- **Scenario 5A:** Passive History Reconciliation (Normal Captured Chat)
- **Scenario 6:** Network Interruption, Stream Abort & Transport Retry Stabilization
- **Scenario 7:** Multi-Tab Concurrency
- **Scenario 8:** Side Panel Read-Only Archive Inspection
- **AC-01, AC-03, AC-05, AC-06, AC-07, AC-08, AC-09:** Architectural, privacy, and retry stabilization invariants.

All mandatory checks must be evaluated and must achieve a **`PASS`** verdict.

### 1.2 Conditionally Observable Live Checks
Checks that depend strictly on non-deterministic server-side safety triggers from production DeepSeek:
- **Scenario 2:** Mid-Stream Content Filter Replacement & Pre-Filter Recovery Overlay
- **Scenario 3:** Immediate Token-0 Safety Filter Refusal
- **Scenario 5B:** Pre-Filter Revision Preservation Across Server History Reconciliation
- **AC-02:** Closed Shadow DOM Overlay (when recovery badge/modal rendered)
- **AC-04:** Last-Good Recovery Text Preservation

> [!CAUTION]
> **Safety & Ethics Policy:** Do **NOT** deliberately submit hazardous, illegal, sexually explicit, hate speech, or policy-violating prompts to trigger server-side filters.
> - If an authentic filter is naturally encountered during ordinary research or engineering queries, record observations thoroughly.
> - If no natural filter occurs during the testing session, mark the check as **`NOT OBSERVED LIVE`** or **`N/A`**.
> - Recording **`NOT OBSERVED LIVE`** or **`N/A`** for conditional checks **does NOT constitute a failure**, because verification of content filter replacement and recovery overlay mechanics is provided by the automated compatibility test suite ([`tests/browser/filter-replacement.spec.ts`](../tests/browser/filter-replacement.spec.ts)).

---

## 2. Evidence & Data Privacy Rules

When logging DevTools output, console traces, or screenshots into acceptance reports:

### Permitted Evidence:
- Extension diagnostic counters, runtime epochs, and pipeline stage states.
- System error codes and transport event counts.
- Non-sensitive message IDs and timestamps.
- Generic, non-confidential test prompts (e.g. TCP vs. UDP).
- Extension Side Panel UI screenshots.

### Strictly Prohibited from Reports & Git Commits:
- User account email address, phone number, or login names.
- Identifying avatars or user profile details.
- Cookie headers (`Cookie: ...`), session tokens, or `Authorization: Bearer` headers.
- Private personal or commercial conversation transcripts.
- DevTools network request headers containing credentials.

> [!TIP]
> If a screenshot or console dump contains user identifying information, blur or redact it prior to saving or committing.

---

## 3. Prerequisites

1. **Build the Production Extension:**
   ```powershell
   pnpm run build
   ```
   Verify that `.output/chrome-mv3` contains `manifest.json`, `background.js`, `content-scripts/content.js`, `content-scripts/interceptor.js`, and `sidepanel.html`.

2. **Load Unpacked Extension in Chrome:**
   - Open `chrome://extensions/`
   - Enable **Developer mode** (toggle in upper right).
   - Click **Load unpacked** and select:
     `.output/chrome-mv3`
   - Confirm extension details:
     - Version: `0.1.0`
     - Permissions: strictly `storage`, `sidePanel`
     - Host Permissions: `https://chat.deepseek.com/*`

3. **Open DevTools Console:**
   - Navigate to `https://chat.deepseek.com/` and log in.
   - Open Chrome DevTools (`F12`) on the DeepSeek tab to monitor content script logs.
   - On `chrome://extensions/`, click **service worker** under DeepSeek StreamArchive to open the background service worker console.
   - Filter logs by `[StreamArchive]`.

---

## 4. Acceptance Test Scenarios

### Scenario 1: Normal Unfiltered Response Generation (Mandatory)

**Objective:** Verify passive streaming capture, monotonic checkpoints, and non-intrusive runtime under standard generation.

1. **Action:**
   - Start a new conversation or open an existing chat.
   - Send prompt: `"Explain the difference between TCP and UDP in 3 bullet points."`
2. **Observations during generation:**
   - Tokens render normally in DeepSeek's UI without stutter, delay, or flicker.
   - Side Panel **Diagnostics** tab shows pipeline stages advancing truthfully (`Generation Candidate Observed: HEALTHY`, `Protocol Frame Decoded: HEALTHY`, `Canonical Checkpoint ACK Confirmed: HEALTHY`).
   - No recovery badge appears in the page (generation is clean and unfiltered).
3. **Verification:**
   - Open the Side Panel: click the DeepSeek StreamArchive action icon in the Chrome extensions toolbar (or choose DeepSeek StreamArchive from Chrome's Side Panel dropdown).
   - Conversation appears in Archive Browser with updated title and timestamp.
   - Click on the conversation: prompt and assistant response display correctly with full text.
   - Status badge shows `reconciled` or `streaming -> finished`.
4. **Verdict:** `PASS` / `FAIL` (Mandatory)

---

### Scenario 2: Safety Filter Trigger Mid-Stream (Conditional)

**Objective:** Verify that when DeepSeek's server-side safety filter triggers mid-stream during natural conversation, pre-filter partial answer and thinking tokens are durably preserved and accessible via the overlay.

> [!NOTE]
> Guaranteed content filter and replacement verification is handled deterministically by automated browser test fixtures (`pnpm run test:e2e`). For live acceptance testing, **do NOT deliberately submit hazardous, illegal, or policy-violating prompts**. If a filter is naturally encountered during ordinary research or engineering queries, record observations below; otherwise record **NOT OBSERVED LIVE** (which is not a failure).

1. **Action:**
   - Observe natural query where server returns a filter mid-stream, or rely on automated E2E fixture verification.
2. **Observations during filter trigger (if naturally observed):**
   - DeepSeek web UI streams several sentences or mathematical steps, then replaces the text with a canned template response.
   - Background service worker preserves the last-good unredacted tokens prior to replacement.
3. **Overlay Behavior (if naturally observed):**
   - The original assistant message in DeepSeek DOM is **never mutated, altered, or replaced**.
   - An isolated **Anchored Badge** labeled `🛡️ Recovered Pre-Filter Response` appears floating above the message container.
   - If message is scrolled or unanchored, the **Floating Recovery Tray** in the bottom-right displays `[Recovered Original] Captured before filter`.
4. **Content Inspection (if naturally observed):**
   - Click the recovery badge or tray item.
   - A modal card opens inside closed Shadow DOM.
   - Full pre-filter response text is rendered safely on-demand (zero snippet text leaked in page summary before click).
   - If thinking was generated before filter, click `Thought Process (Recovered)` to view collapsed chain-of-thought tokens.
   - Click **Copy Recovered Answer** -> verify clipboard contains full uncensored text.
   - Click **Dismiss** -> modal closes and badge is dismissed for this conversation.
5. **Verdict:**
   - `PASS`: Observed naturally and verified all recovery mechanics.
   - `FAIL`: Observed naturally but pre-filter tokens lost or DOM corrupted.
   - `NOT OBSERVED LIVE`: No natural filter occurred during test session.
   - **Automated Evidence:** Verified by [`tests/browser/filter-replacement.spec.ts`](../tests/browser/filter-replacement.spec.ts).
   - **Release Impact:** Does not fail mandatory live baseline.

---

### Scenario 3: Immediate Safety Filter Trigger (Conditional)

**Objective:** Verify system behavior when DeepSeek refuses generation immediately at token 0.

1. **Action:**
   - Observe natural query that results in immediate refusal, if one occurs naturally.
   - Do **NOT** deliberately submit harmful prompts to force refusal.
2. **Observations (if naturally observed):**
   - DeepSeek UI displays standard refusal.
   - Background console logs terminal reason `filtered` with 0 answer tokens.
   - No ghost or corrupted `lastGood` revision is created.
   - Side panel records message status as `filtered` with 0 recovered revisions.
3. **Verdict:**
   - `PASS`: Observed naturally and handled gracefully.
   - `FAIL`: Observed naturally but produced corrupted revision or crash.
   - `NOT OBSERVED LIVE`: No immediate refusal occurred during test session.

---

### Scenario 4: Fast Navigation & Mid-Stream Route Switch (Mandatory)

**Objective:** Verify route-race isolation and ensure recovery state does not leak across conversation sessions.

1. **Action:**
   - Send a lengthy response prompt in Chat A (`/a/chat/s/SESSION_A`).
   - While generation is in-flight, immediately click a different conversation in DeepSeek's sidebar (Chat B: `/a/chat/s/SESSION_B`) via standard client-side SPA navigation.
2. **Observations:**
   - Active URL changes to `SESSION_B`.
   - Content script detects route change via `routeEpoch` token and SPA navigation hooks (`history.pushState` / `navigation` API).
   - Any recovery overlays, modals, or badges belonging to `SESSION_A` are **instantly cleared** before `SESSION_B` data resolves.
   - No badges or tray items from `SESSION_A` bleed into `SESSION_B`.
   - Background coordinator for `SESSION_A` continues running until terminal checkpoint is safely persisted.
3. **Verification:**
   - Return to `SESSION_A` -> verify conversation history and revisions displayed cleanly.
4. **Verdict:** `PASS` / `FAIL` (Mandatory)

---

### Scenario 5A: Passive History Reconciliation (Mandatory)

**Objective:** Verify Truth 2 (Canonical Live) and Truth 3 (Server History) convergence after browser reload on a normal conversation.

1. **Action:**
   - Perform Hard Reload (`Ctrl + F5`) on `chat.deepseek.com` inside the normal captured conversation from Scenario 1.
2. **Observations:**
   - DeepSeek reloads and passively fetches `history_messages` from `/api/v0/chat/history_messages`.
   - Content script intercepts the JSON stream incrementally and streams batches into `STORE_HISTORY_STAGING`.
   - Background service worker executes `commitHistoryStagingPlan` atomically.
   - Provisional message IDs are cleanly reconciled to stable server UUIDs.
   - Conversation and messages survive with zero duplication.
   - Message order remains strictly chronological.
   - Captured live revision is retained and remains readable in Side Panel.
3. **Verification:**
   - Open Side Panel -> verify conversation message status is `reconciled`.
   - Click message -> verify prompt and response match live captured text.
4. **Verdict:** `PASS` / `FAIL` (Mandatory)

---

### Scenario 5B: Pre-Filter Revision Preservation Across Server History (Conditional)

**Objective:** Verify that server history reconciliation never overwrites preserved `lastGood` pre-filter revisions with canned refusal templates.

1. **Applicability:**
   - Executed **only** if Scenario 2 actually encountered a natural mid-stream content filter.
   - If Scenario 2 was `NOT OBSERVED LIVE`, mark this scenario as `N/A — NOT OBSERVED LIVE`.
2. **Action (if filter was observed in Scenario 2):**
   - Perform Hard Reload (`Ctrl + F5`) on `chat.deepseek.com` inside the filtered conversation.
3. **Observations:**
   - DeepSeek reloads and fetches server history containing the canned refusal template.
   - Existing `lastGood` pre-filter revisions in `STORE_REVISIONS` are **strictly preserved**.
   - Server history version is recorded as a new revision without destroying Revision 0 (`isLastGood`).
   - Recovery event metadata and anchored badges remain functional.
4. **Verdict:**
   - `PASS`: Observed naturally and pre-filter revision preserved.
   - `FAIL`: Observed naturally but server canned text overwrote pre-filter revision.
   - `N/A — NOT OBSERVED LIVE`: No natural filter occurred during test session. Automated verification provided by [`tests/browser/history-reconciliation.spec.ts`](../tests/browser/history-reconciliation.spec.ts).

---

### Scenario 6: Network Interruption, Stream Abort & Transport Retry Stabilization (Mandatory)

**Objective:** Verify crash durability when network drops or tab is abruptly closed, and ensure automatic client-side transport retries do not spawn fake conversation branches or phantom messages.

1. **Action:**
   - Start generating a response to a long prompt (e.g. `"Write a comprehensive 500-word essay on the history of cryptography"`).
   - In DevTools -> **Network** tab -> toggle **Offline** mid-generation.
   - Observe DeepSeek client behavior (DeepSeek web UI may perform 1 to 3 automatic reconnection attempts via XHR/fetch before displaying a retry button or error).
   - Toggle Network back to **Online** and allow DeepSeek to finish or retry, or reload the page to trigger passive history reconciliation.
2. **Observations:**
   - DeepSeek UI handles network error or completes upon reconnection.
   - Content script and interceptor capture each transport attempt as an independent raw stream in `raw_streams` / `raw_stream_batches`.
   - Revisions captured prior to disconnect are durably flushed to IndexedDB.
   - Empty interrupted transport attempts are classified as `projectionState: 'attempt_only'` with `parentId: undefined` (never linked into the canonical conversation tree).
   - Any meaningful partial text captured during interrupted attempts is preserved as `projectionState: 'unmatched_capture'` and rendered cleanly in the dedicated "Unmatched Stream Captures" container in the Side Panel, without polluting the linear chat tree.
   - Open Side Panel -> verify the conversation contains exactly the expected logical messages (e.g. 1 user prompt and 1 assistant response).
   - **Crucial Invariant:** Verify that **zero phantom branch selectors** (e.g. `Branch 1 of 3`) appear. Sibling branching appears *only* when genuine user edits or regenerations occur.
3. **Verification after page reload (Passive History Reconciliation):**
   - Reload the page (`Ctrl + F5`) -> server history reconciles the logical assistant message.
   - Confirm message count remains exact (e.g. 2 messages total, not 4 or 5).
   - Verify all raw transport attempts remain preserved in raw storage for forensic replay.
4. **Verdict:** `PASS` / `FAIL` (Mandatory)

---

### Scenario 7: Multi-Tab Concurrency (Mandatory)

**Objective:** Verify that multiple DeepSeek tabs operate concurrently without cross-contamination.

1. **Action:**
   - Open Tab 1 with Conversation X and Tab 2 with Conversation Y.
   - Send prompts in both tabs.
2. **Observations:**
   - Each tab maintains independent stream keys (`producerSessionId:streamId`).
   - Checkpoints from Tab 1 do not collide or interfere with Tab 2.
   - Staging manifests and raw journals are partitioned by session.
   - Both conversations appear independently in the Side Panel archive.
3. **Verdict:** `PASS` / `FAIL` (Mandatory)

---

### Scenario 8: Side Panel Read-Only Archive Inspection (Mandatory)

**Objective:** Verify integrity of Side Panel archive view across all message states.

1. **Action:**
   - Open Side Panel.
   - Search for conversations by title keyword.
   - Expand conversation message thread.
2. **Verification Points:**
   - User prompts and Assistant responses appear in correct chronological sequence.
   - **Branch Switcher:** If testing a conversation with edited prompts / forks, verify branch switcher navigates alternatives without error. (If testing a linear conversation without forks, mark Branch Switcher as `N/A — no branch present`).
   - Thinking traces are collapsible.
   - Copy button correctly copies Markdown content.
   - Safe rendering: zero `innerHTML` or `eval` used.
3. **Verdict:** `PASS` / `FAIL` (Mandatory)

---

## 5. Acceptance Criteria Matrix

For logging real-world execution results, copy and fill out the [Live Acceptance Results Template](./LIVE_ACCEPTANCE_RESULTS_TEMPLATE.md).

| Check ID | Requirement | Success Indicator | Evaluation Rule |
|---|---|---|---|
| **AC-01** | Zero DOM Mutation | No modifications to DeepSeek message elements | `PASS / FAIL` (Mandatory) |
| **AC-02** | Closed Shadow DOM | Overlay contained entirely in `#shadow-root (closed)` | `PASS / FAIL / N/A` (Conditional; N/A permitted only when no recovery overlay was naturally triggered; automated E2E verified) |
| **AC-03** | Route Isolation | Zero cross-conversation badge or snippet display | `PASS / FAIL` (Mandatory) |
| **AC-04** | Last-Good Recovery | Full uncensored pre-filter text recoverable upon filter trigger | `PASS / FAIL / N/A` (Conditional; N/A only when no natural production filter event occurred) |
| **AC-05** | Terminal Durability | Checkpoint retry survives coordinator disposal until ACK | `PASS / FAIL` (Mandatory) |
| **AC-06** | History Atomicity | Incomplete history stages never corrupt canonical database | `PASS / FAIL` (Mandatory) |
| **AC-07** | Strict Permissions | Manifest restricted to `storage`, `sidePanel`, and `chat.deepseek.com` | `PASS / FAIL` (Mandatory) |
| **AC-08** | Truth Convergence | Reconciled history retains live revisions without data loss | `PASS / FAIL` (Mandatory) |
| **AC-09** | Transport Retry Stabilization | Client-side transport retries never spawn phantom canonical branches or messages | `PASS / FAIL` (Mandatory) |

---

## 6. Final Acceptance Decision Semantics

The human tester evaluates acceptance using three strict verdict classes:

- **`PASS`**: The requirement was observable during testing and performed strictly according to architectural specifications.
- **`FAIL`**: The requirement was observable and revealed a defect, data corruption, DOM mutation, or privacy leak.
- **`N/A / NOT OBSERVED LIVE`**: The production condition did not occur naturally (e.g. no mid-stream filter encountered; conversation had no branches). **Permitted ONLY for explicitly conditional criteria.**

### Baseline Sign-Off Rule:
The verdict **`LIVE COMPATIBILITY BASELINE ACCEPTED`** may be granted if and only if:
1. **All mandatory criteria** evaluated to **`PASS`**.
2. **All observed conditional criteria** evaluated to **`PASS`** (with zero `FAIL` verdicts).
3. Any unobserved conditional criteria are documented as **`NOT OBSERVED LIVE`** (with automated synthetic E2E test coverage cited).

> [!NOTE]
> **Why "LIVE COMPATIBILITY BASELINE ACCEPTED" instead of "ACCEPTED FOR PRODUCTION USE"?**
> Achieving the live compatibility baseline confirms that the extension binary operates correctly and non-destructively against the current production DeepSeek web application.
> It does **not** signify that the project is packaged or released for general public distribution. Chrome Web Store publishing, packaging pipelines, privacy disclosure filings, and support policies are managed under the release engineering guidelines.

---

## 7. Triage Guide for Live Testing

- **Badge does not appear on filtered message:**
  Check DevTools console. If DeepSeek's DOM lacks message ID attributes, check if the floating recovery tray in the bottom-right rendered.
- **Side Panel shows empty conversation:**
  Check if IndexedDB `StreamArchiveDB` has records in `conversations` and `messages`. Check for any schema migration errors.
- **Service worker became dormant:**
  Verify that waking the service worker triggers retry delivery of pending canonical checkpoints without dropping sequence.
