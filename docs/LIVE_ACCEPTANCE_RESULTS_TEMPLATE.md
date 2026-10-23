# DeepSeek StreamArchive — Live Acceptance Test Execution Report

> [!IMPORTANT]
> **INITIAL STATUS: LIVE MANUAL VERIFICATION REQUIRED**  
> This template must be populated by a human tester conducting manual end-to-end verification against the authenticated, production web application at `https://chat.deepseek.com/`.  
> Automated unit, fuzzing, integration, and browser harness test suites cannot substitute for this live acceptance report.

---

## 1. Test Environment Metadata

| Metadata Field | Recorded Value |
|---|---|
| **Test Execution Date (UTC)** | `YYYY-MM-DD HH:MM:SS UTC` |
| **Tester Name / Handle** | *(e.g., QA Engineer / GitHub Username)* |
| **Browser Version** | *(from `chrome://version`, e.g., Google Chrome 130.0.6723.70)* |
| **Operating System** | *(e.g., Windows 11 Pro 23H2 / macOS 14.5 / Ubuntu 24.04)* |
| **Extension Git Commit SHA** | *(e.g., `git rev-parse HEAD`)* |
| **Extension Version** | `0.1.0` (MV3) |
| **Extension Build Directory** | `.output/chrome-mv3` |
| **Target Web App URL** | `https://chat.deepseek.com/` |
| **DeepSeek Account Tier** | *(Free / DeepSeek-V3 / DeepSeek-R1 Pro)* |

---

## 2. Pre-Execution Verification Checklist

- [ ] Extension built cleanly via `pnpm run build` with zero compiler errors.
- [ ] Extension loaded unpacked into Chromium via `chrome://extensions/`.
- [ ] Extension permissions verified strictly limited to `storage` and `sidePanel`.
- [ ] Extension host permissions verified strictly limited to `https://chat.deepseek.com/*`.
- [ ] Chrome DevTools open on `chat.deepseek.com` and background service worker console active.
- [ ] Test user authenticated and logged into `chat.deepseek.com`.

---

## 3. Scenario Execution Results

### Scenario 1: Normal Unfiltered Response Generation
- **Prompt Tested:** `"Explain the difference between TCP and UDP in 3 bullet points."`
- **Streaming Latency / Smoothness:** `[ ] Normal / [ ] Minor Stutter / [ ] Severe Lag`
- **Checkpoint Monotonicity:** `[ ] Monotonic continuous sequence / [ ] Gaps observed`
- **Side Panel Archive Appearance:** `[ ] Correct title and content / [ ] Missing or corrupted`
- **Recovery Badges Rendered:** `[ ] None (Expected) / [ ] False positive badge rendered`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter DevTools logs, coordinator output, and side panel screenshots or notes here)
  ```

---

### Scenario 2: Safety Filter Trigger Mid-Stream (Pre-Filter Recovery)
*Note: Do NOT intentionally submit harmful prompts. Rely on natural engineering/research prompts or mark `NOT OBSERVED LIVE` if no filter triggers during natural interaction. Deterministic filter behavior is verified by automated Playwright harness (`filter-replacement.spec.ts`).*
- **Filter Event Observed:** `[ ] Yes / [ ] Not Encountered During Session`
- **DeepSeek Web UI Behavior:** `[ ] Replaced with canned template / [ ] Aborted / [ ] Other`
- **Recovery Overlay Badge:** `[ ] Rendered above message / [ ] Rendered in floating tray / [ ] None`
- **Shadow DOM Isolation:** `[ ] Closed shadow root verified / [ ] Host DOM corrupted`
- **Recovered Text Integrity:** `[ ] Full pre-filter answer recovered / [ ] Truncated / [ ] Missing`
- **Chain of Thought (Thinking):** `[ ] Preserved in collapsible view / [ ] N/A`
- **Copy to Clipboard:** `[ ] Succeeded with full text / [ ] Failed`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] NOT OBSERVED LIVE / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter observed behavior and recovery drawer notes here)
  ```

---

### Scenario 3: Immediate Safety Filter Trigger
- **Filter Event at Token 0 Observed:** `[ ] Yes / [ ] Not Encountered During Session`
- **Refusal Handled Gracefully:** `[ ] Yes (0 tokens stored, no ghost revision) / [ ] No`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] NOT OBSERVED LIVE / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter refusal handling notes here)
  ```

---

### Scenario 4: Fast Navigation & Mid-Stream Route Switch
- **Action:** Switched from Chat A to Chat B mid-generation.
- **Route Epoch Invalidation:** `[ ] Route epoch updated, Chat A overlays immediately purged`
- **Cross-Session Leakage:** `[ ] Zero badges or trays from Chat A appeared in Chat B`
- **Background Integrity:** `[ ] Background coordinator for Chat A completed cleanly`
- **Return to Chat A:** `[ ] Chat A overlay displayed accurately on return`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter route isolation logs here)
  ```

---

### Scenario 5: Full Page Reload & Passive History Reconciliation
- **Action:** Hard Reload (`Ctrl + F5`) on `chat.deepseek.com` inside an existing chat with recovered messages.
- **History Request Interception:** `[ ] /api/v0/chat/history_messages captured passively`
- **Staging Atomicity:** `[ ] Incremental batches staged with valid manifest and remoteId`
- **Atomic Commit:** `[ ] History reconciled without overwriting live pre-filter revisions`
- **Provisional ID Resolution:** `[ ] Provisional message IDs mapped to server UUIDs`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter reconciliation logs and side panel revision drawer verification here)
  ```

---

### Scenario 6: Network Interruption & Stream Abort
- **Action:** DevTools Network Offline toggled during active response generation.
- **Terminal Event Dispatched:** `[ ] Network error detected, abort checkpoint created`
- **Crash Durability:** `[ ] Partial response persisted to IndexedDB before disconnect`
- **Side Panel Status:** `[ ] Displays preserved tokens with finishReason 'network_error'`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter network interruption recovery notes here)
  ```

---

### Scenario 7: Multi-Tab Concurrency
- **Action:** Prompts submitted concurrently in Tab 1 and Tab 2.
- **Stream Key Partitioning:** `[ ] Distinct producerSessionId:streamId keys active`
- **Data Cross-Talk:** `[ ] Zero collision between tab streams`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter multi-tab observations here)
  ```

---

### Scenario 8: Side Panel Read-Only Archive Inspection
- **Action:** Navigated archive history in Side Panel.
- **Chronological Thread:** `[ ] Accurate message ordering`
- **Branch Switcher:** `[ ] Branch forks navigable without UI crash`
- **Markdown Rendering:** `[ ] Rendered safely without innerHTML / eval`
- **Diagnostics Pipeline:** `[ ] All 14 verification stages reflect truthful status`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter side panel verification notes here)
  ```

---

## 4. Invariant & Acceptance Criteria Sign-Off

| Check ID | Requirement | Criterion | Evaluated Result |
|---|---|---|---|
| **AC-01** | Zero DOM Mutation | DeepSeek message DOM nodes remain completely unmodified | `[ ] PASS / [ ] FAIL` |
| **AC-02** | Closed Shadow DOM | Recovery badge/modal contained entirely inside closed shadow root | `[ ] PASS / [ ] FAIL` |
| **AC-03** | Route Isolation | Zero cross-session recovery badges or content leakage across URLs | `[ ] PASS / [ ] FAIL` |
| **AC-04** | Last-Good Recovery | Full uncensored pre-filter text recoverable upon filter trigger | `[ ] PASS / [ ] FAIL / [ ] N/A` |
| **AC-05** | Terminal Durability | Terminal checkpoints persisted reliably through disposal and retry | `[ ] PASS / [ ] FAIL` |
| **AC-06** | History Atomicity | Incomplete history stages never corrupt canonical database | `[ ] PASS / [ ] FAIL` |
| **AC-07** | Strict Permissions | Manifest restricted to `storage`, `sidePanel`, and `chat.deepseek.com` | `[ ] PASS / [ ] FAIL` |
| **AC-08** | Truth Convergence | Reconciled history retains live revisions without data loss | `[ ] PASS / [ ] FAIL` |

---

## 5. Final Acceptance Conclusion

- [ ] **ACCEPTED FOR PRODUCTION USE** — All mandatory criteria passed without critical defects.
- [ ] **REJECTED / DEFECTS IDENTIFIED** — Critical defects logged below for remediation.
- [x] **LIVE MANUAL VERIFICATION REQUIRED** — Pending execution by human tester.

**Tester Signature:** __________________________________  
**Date:** ____________________  
