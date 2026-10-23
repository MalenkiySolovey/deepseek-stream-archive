# DeepSeek StreamArchive — Live Acceptance Testing Guide

> [!IMPORTANT]
> **LIVE MANUAL VERIFICATION REQUIRED**  
> Automated unit, fuzzing, mock-environment integration tests (367 passing across 53 test suites), and Playwright Chromium MV3 compatibility harness (6 passing end-to-end browser specifications) establish mathematical correctness of invariants and crash-durability. However, automated tests **cannot substitute for real user-authenticated sessions on `chat.deepseek.com`**.  
> This document specifies the exact protocol for conducting manual end-to-end acceptance testing against the live production DeepSeek web application.

---

## Prerequisites

1. **Build the Production Extension:**
   ```powershell
   cd workbench
   pnpm run build
   ```
   Verify that `.output/chrome-mv3` contains `manifest.json`, `background.js`, `content-scripts/content.js`, `content-scripts/interceptor.js`, and `sidepanel.html`.

2. **Load Unpacked Extension in Chrome:**
   - Open `chrome://extensions/`
   - Enable **Developer mode** (toggle in upper right).
   - Click **Load unpacked** and select:
     `C:\Users\Malenkiy_Solovey\Desktop\Codex\DeepSeek StreamArchive\workbench\.output\chrome-mv3`
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

## Acceptance Test Scenarios

### Scenario 1: Normal Unfiltered Response Generation

**Objective:** Verify passive streaming capture, monotonic checkpoints, and non-intrusive runtime under standard generation.

1. **Action:**
   - Start a new conversation or open an existing chat.
   - Send prompt: `"Explain the difference between TCP and UDP in 3 bullet points."`
2. **Observations during generation:**
   - Tokens render normally in DeepSeek's UI without stutter, delay, or flicker.
   - Side Panel **Diagnostics** tab shows pipeline stages advancing truthfully (Generation Candidate Observed: HEALTHY, Protocol Frame Decoded: HEALTHY, Canonical Checkpoint ACK Confirmed: HEALTHY).
   - No recovery badge appears in the page (generation is clean and unfiltered).
3. **Verification:**
   - Open the Side Panel: click the DeepSeek StreamArchive action icon in the Chrome extensions toolbar (or choose DeepSeek StreamArchive from Chrome's Side Panel dropdown).
   - Conversation appears in Archive Browser with updated title and timestamp.
   - Click on the conversation: prompt and assistant response display correctly with full text.
   - Status badge shows `reconciled` or `streaming -> finished`.

---

### Scenario 2: Safety Filter Trigger Mid-Stream (Pre-Filter Recovery)

**Objective:** Verify that when DeepSeek's server-side safety filter triggers mid-stream during natural conversation, pre-filter partial answer and thinking tokens are durably preserved and accessible via the overlay.

> [!NOTE]
> Guaranteed content filter and replacement verification is handled deterministically by automated browser test fixtures (`pnpm run test:e2e`). For live acceptance testing, **do NOT deliberately submit hazardous, illegal, or policy-violating prompts**. If a filter is naturally encountered during ordinary research or engineering queries, record observations below; otherwise record **NOT OBSERVED LIVE** (which is not a failure).

1. **Action:**
   - Observe natural query where server returns a filter mid-stream, or rely on automated E2E fixture verification.
2. **Observations during filter trigger:**
   - DeepSeek web UI streams several sentences or mathematical steps, then replaces the text with a canned template response.
   - Background service worker preserves the last-good unredacted tokens prior to replacement.
3. **Overlay Behavior:**
   - The original assistant message in DeepSeek DOM is **never mutated, altered, or replaced**.
   - An isolated **Anchored Badge** labeled `🛡️ Recovered Pre-Filter Response` appears floating above the message container.
   - If message is scrolled or unanchored, the **Floating Recovery Tray** in the bottom-right displays `[Recovered Original] Captured before filter`.
4. **Content Inspection:**
   - Click the recovery badge or tray item.
   - A modal card opens inside closed Shadow DOM.
   - Full pre-filter response text is rendered safely on-demand (zero snippet text leaked in page summary before click).
   - If thinking was generated before filter, click `Thought Process (Recovered)` to view collapsed chain-of-thought tokens.
   - Click **Copy Recovered Answer** -> verify clipboard contains full uncensored text.
   - Click **Dismiss** -> modal closes and badge is dismissed for this conversation.

---

### Scenario 3: Immediate Safety Filter Trigger

**Objective:** Verify system behavior when DeepSeek refuses generation immediately at token 0.

1. **Action:**
   - Send a prompt that causes immediate refusal without any preliminary tokens.
2. **Observations:**
   - DeepSeek UI displays standard refusal.
   - Background console logs terminal reason `filtered` with 0 answer tokens.
   - No ghost or corrupted `lastGood` revision is created.
   - Side panel records message status as `filtered` with 0 recovered revisions.

---

### Scenario 4: Fast Navigation & Mid-Stream Route Switch

**Objective:** Verify route-race isolation and ensure recovery state does not leak across conversation sessions.

1. **Action:**
   - Send a lengthy response prompt in Chat A (`/a/chat/s/SESSION_A`).
   - While generation is in-flight, immediately click a different conversation in DeepSeek's sidebar (Chat B: `/a/chat/s/SESSION_B`).
2. **Observations:**
   - Active URL changes to `SESSION_B`.
   - Content script detects route change via `routeEpoch` token.
   - Any recovery overlays, modals, or badges belonging to `SESSION_A` are **instantly cleared**.
   - No badges or tray items from `SESSION_A` bleed into `SESSION_B`.
   - Background coordinator for `SESSION_A` continues running in background until terminal checkpoint is persisted.
3. **Verification:**
   - Return to `SESSION_A` -> recovery badge displays cleanly for `SESSION_A`.

---

### Scenario 5: Full Page Reload & Passive History Reconciliation

**Objective:** Verify Truth 2 (Canonical Live) and Truth 3 (Server History) convergence after browser reload.

1. **Action:**
   - Perform Hard Reload (`Ctrl + F5`) on `chat.deepseek.com` inside an existing chat with a recovered message.
2. **Observations:**
   - DeepSeek reloads and passively fetches `history_messages` from `/api/v0/chat/history_messages`.
   - Content script intercepts the JSON stream incrementally and streams multi-batch chunks into `STORE_HISTORY_STAGING`.
   - Background executes `commitHistoryStagingPlan` atomically.
   - Provisional message IDs are reconciled to server UUIDs.
   - Existing `lastGood` pre-filter revisions in `STORE_REVISIONS` are **strictly preserved** and not overwritten by the canned server history version.
3. **Verification:**
   - Open Side Panel -> verify the assistant message shows 2 revisions: Revision 0 (Uncensored Live capture) and Revision 1 (Server history canned template).
   - Anchored recovery badge remains available on page for the message.

---

### Scenario 6: Network Interruption & Stream Abort

**Objective:** Verify crash durability when network drops or tab is abruptly closed.

1. **Action:**
   - Start generating a lengthy code response.
   - In DevTools -> **Network** tab -> toggle **Offline** mid-generation.
2. **Observations:**
   - DeepSeek displays network error.
   - Content script records network interruption terminal checkpoint.
   - Revisions captured prior to disconnect are durably flushed to IndexedDB.
   - Toggle Network back to **Online** -> open Side Panel -> verify partial answer is preserved with finish reason `network_error`.

---

### Scenario 7: Multi-Tab Concurrency

**Objective:** Verify that multiple DeepSeek tabs operate concurrently without cross-contamination.

1. **Action:**
   - Open Tab 1 with Conversation X and Tab 2 with Conversation Y.
   - Send prompts simultaneously in both tabs.
2. **Observations:**
   - Each tab maintains independent stream keys (`producerSessionId:streamId`).
   - Checkpoints from Tab 1 do not collide or interfere with Tab 2.
   - Staging manifests and raw journals are partitioned by session.

---

### Scenario 8: Side Panel Read-Only Archive Inspection

**Objective:** Verify integrity of Side Panel archive view across all message states.

1. **Action:**
   - Open Side Panel.
   - Search for conversations by title keyword.
   - Expand conversation message thread.
2. **Verification Points:**
   - User prompts and Assistant responses appear in correct chronological sequence.
   - Branch selector works for conversations with edited prompts / forks.
   - Filtered messages display a distinct visual indicator (`🛡️ Pre-filter version preserved`).
   - Thinking traces are collapsible.
   - Copy button correctly copies Markdown content.

---

## Acceptance Criteria Matrix

For logging real-world execution results, copy and fill out the [Live Acceptance Results Template](./LIVE_ACCEPTANCE_RESULTS_TEMPLATE.md).

| Check ID | Requirement | Success Indicator | Pass/Fail |
|---|---|---|---|
| **AC-01** | Zero DOM Mutation | No modifications to DeepSeek message elements | `[ ]` |
| **AC-02** | Closed Shadow DOM | Overlay contained entirely in `#shadow-root (closed)` | `[ ]` |
| **AC-03** | Route Isolation | Zero cross-conversation badge or snippet display | `[ ]` |
| **AC-04** | Last-Good Recovery | Full uncensored pre-filter text recoverable upon filter trigger | `[ ]` |
| **AC-05** | Terminal Durability | Checkpoint retry survives coordinator disposal until ACK | `[ ]` |
| **AC-06** | History Atomicity | Incomplete history stages never corrupt canonical database | `[ ]` |
| **AC-07** | Strict Permissions | Manifest restricted to `storage`, `sidePanel`, and `chat.deepseek.com` | `[ ]` |
| **AC-08** | Truth Convergence | Reconciled history retains live revisions without data loss | `[ ]` |

---

## Triage Guide for Live Testing

- **Badge does not appear on filtered message:**
  Check DevTools console. If DeepSeek's DOM lacks `data-message-id`, check if the floating tray in bottom-right rendered.
- **Side Panel shows empty conversation:**
  Check if IndexedDB `StreamArchiveDB` has records in `conversations` and `messages`. Check for any schema migration errors.
- **Service worker became dormant:**
  Verify that waking the service worker triggers retry delivery of pending canonical checkpoints without dropping sequence.
