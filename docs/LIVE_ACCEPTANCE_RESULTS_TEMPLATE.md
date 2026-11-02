# DeepSeek StreamArchive — Live Acceptance Test Execution Report

> [!IMPORTANT]
> **INITIAL STATUS: LIVE MANUAL VERIFICATION REQUIRED**
> This template must be populated by a human tester conducting manual end-to-end verification against an authenticated, production web session at `https://chat.deepseek.com/`.
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
| **DeepSeek Web UI Observed Date/Time** | *(e.g., `2026-11-02 18:30 UTC`)* |
| **DeepSeek Model Selected** | *(e.g., DeepSeek-V3 / DeepSeek-R1 / DeepSeek-R1 Lite)* |
| **Extension ID** | *(from `chrome://extensions`, e.g., `kpmdf...`)* |
| **Install State** | `[ ] Fresh install / [ ] Existing StreamArchiveDB` |

> [!CAUTION]
> **Privacy Enforcement:**
> Do **NOT** record or commit:
> - Account email address, username, or phone number.
> - Session cookies (`Cookie: ...`) or authentication tokens (`Authorization: Bearer ...`).
> - Proprietary or personal conversation prompts/text.
> - Identifying user profile details or avatars.

---

## 2. Pre-Execution Verification Checklist

- [ ] Extension built cleanly via `pnpm run build` with zero compiler errors.
- [ ] Extension loaded unpacked into Chromium via `chrome://extensions/`.
- [ ] Extension permissions verified strictly limited to `storage` and `sidePanel`.
- [ ] Extension host permissions verified strictly limited to `https://chat.deepseek.com/*`.
- [ ] Chrome DevTools open on `chat.deepseek.com` and background service worker console active.
- [ ] Test user authenticated and logged into `chat.deepseek.com`.
- [ ] Evidence privacy rules reviewed: all personal identifiers will be redacted prior to attaching logs or screenshots.

---

## 3. Scenario Execution Results

### Scenario 1: Normal Unfiltered Response Generation (Mandatory)
- **Prompt Tested:** `"Explain the difference between TCP and UDP in 3 bullet points."`
- **Streaming Latency / Smoothness:** `[ ] Normal / [ ] Minor Stutter / [ ] Severe Lag`
- **Checkpoint Monotonicity:** `[ ] Monotonic continuous sequence / [ ] Gaps observed`
- **Side Panel Archive Appearance:** `[ ] Correct title and content / [ ] Missing or corrupted`
- **Recovery Badges Rendered:** `[ ] None (Expected) / [ ] False positive badge rendered`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter non-sensitive DevTools logs, coordinator output, and side panel notes here)
  ```

---

### Scenario 2: Safety Filter Trigger Mid-Stream (Conditional)
*Note: Do NOT intentionally submit harmful prompts. Rely on natural engineering/research prompts or mark `NOT OBSERVED LIVE` if no filter triggers during natural interaction. Deterministic filter behavior is verified by automated Playwright harness ([`tests/browser/filter-replacement.spec.ts`](file:///c:/Users/Malenkiy_Solovey/Desktop/Codex/DeepSeek%20StreamArchive/workbench/tests/browser/filter-replacement.spec.ts)). Marking `NOT OBSERVED LIVE` does not fail the mandatory baseline.*
- **Filter Event Observed:** `[ ] Yes / [ ] Not Encountered During Session`
- **DeepSeek Web UI Behavior:** `[ ] Replaced with canned template / [ ] Aborted / [ ] N/A`
- **Recovery Overlay Badge:** `[ ] Rendered above message / [ ] Rendered in floating tray / [ ] N/A`
- **Shadow DOM Isolation:** `[ ] Closed shadow root verified / [ ] Host DOM corrupted / [ ] N/A`
- **Recovered Text Integrity:** `[ ] Full pre-filter answer recovered / [ ] Truncated / [ ] N/A`
- **Chain of Thought (Thinking):** `[ ] Preserved in collapsible view / [ ] N/A`
- **Copy to Clipboard:** `[ ] Succeeded with full text / [ ] Failed / [ ] N/A`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] NOT OBSERVED LIVE / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter observed behavior and recovery drawer notes here)
  ```

---

### Scenario 3: Immediate Safety Filter Trigger (Conditional)
*Note: Do NOT deliberately submit harmful prompts to force refusal. If not naturally observed, mark `NOT OBSERVED LIVE`.*
- **Filter Event at Token 0 Observed:** `[ ] Yes / [ ] Not Encountered During Session`
- **Refusal Handled Gracefully:** `[ ] Yes (0 tokens stored, no ghost revision) / [ ] No / [ ] N/A`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] NOT OBSERVED LIVE / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter refusal handling notes here)
  ```

---

### Scenario 4: Fast Navigation & Mid-Stream Route Switch (Mandatory)
- **Action:** Switched from Chat A to Chat B mid-generation via client-side SPA navigation.
- **Route Invalidation:** `[ ] Route epoch updated, Chat A overlays immediately purged before Chat B data loads`
- **Cross-Session Leakage:** `[ ] Zero badges or trays from Chat A appeared in Chat B`
- **Background Integrity:** `[ ] Background coordinator for Chat A completed cleanly`
- **Return to Chat A:** `[ ] Chat A history and revisions displayed accurately on return`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter route isolation logs here)
  ```

---

### Scenario 5A: Passive History Reconciliation (Mandatory)
- **Action:** Hard Reload (`Ctrl + F5`) on `chat.deepseek.com` inside the normal captured conversation from Scenario 1.
- **History Request Interception:** `[ ] /api/v0/chat/history_messages captured passively`
- **Staging Atomicity:** `[ ] Incremental batches staged with valid manifest and remoteId`
- **Canonical Reconciliation:** `[ ] History reconciled without duplicate messages`
- **Chronological Ordering:** `[ ] Message ordering preserved strictly`
- **Provisional ID Resolution:** `[ ] Provisional message IDs mapped to server UUIDs`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter reconciliation logs and side panel revision drawer verification here)
  ```

---

### Scenario 5B: Pre-Filter Revision Preservation Across Server History (Conditional)
*Note: Applicable ONLY if Scenario 2 naturally encountered a filter event. If Scenario 2 was `NOT OBSERVED LIVE`, mark this as `N/A — NOT OBSERVED LIVE`.*
- **Action:** Hard Reload (`Ctrl + F5`) inside the filtered conversation from Scenario 2.
- **Pre-Filter Revision Intact:** `[ ] Revision 0 (lastGood) preserved intact`
- **Server Canned Version Recorded:** `[ ] Server history template saved as distinct subsequent revision without overwriting Revision 0`
- **Recovery Event Usability:** `[ ] Recovery card remains functional after reload`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] N/A — NOT OBSERVED LIVE / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter pre-filter preservation observations here)
  ```

---

### Scenario 6: Network Interruption & Stream Abort (Mandatory)
- **Action:** DevTools Network Offline toggled during active response generation.
- **Terminal Event Dispatched:** `[ ] Network error detected, abort checkpoint created`
- **Crash Durability:** `[ ] Partial response persisted to IndexedDB before disconnect`
- **Side Panel Status:** `[ ] Displays preserved tokens with finishReason 'network_error' without falsely reporting content_filter`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter network interruption recovery notes here)
  ```

---

### Scenario 7: Multi-Tab Concurrency (Mandatory)
- **Action:** Prompts submitted in Tab 1 (Chat X) and Tab 2 (Chat Y).
- **Stream Key Partitioning:** `[ ] Distinct producerSessionId:streamId keys active`
- **Data Cross-Talk:** `[ ] Zero collision or crosstalk between tab streams`
- **Archive Independence:** `[ ] Both conversations stored and accessible independently`
- **Result:** `[ ] PASS / [ ] FAIL / [ ] PENDING`
- **Notes / Observations:**
  ```text
  (Enter multi-tab observations here)
  ```

---

### Scenario 8: Side Panel Read-Only Archive Inspection (Mandatory)
- **Action:** Navigated archive history in Side Panel.
- **Chronological Thread:** `[ ] Accurate message ordering`
- **Branch Switcher:** `[ ] PASS / [ ] FAIL / [ ] N/A — no branch present` *(Note: Absence of forks in linear conversation is not a failure)*
- **Markdown Rendering:** `[ ] Rendered safely without innerHTML / eval`
- **Diagnostics Pipeline:** `[ ] Pipeline verification stages reflect truthful status`
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
| **AC-02** | Closed Shadow DOM | Recovery badge/modal contained entirely inside closed shadow root | `[ ] PASS / [ ] FAIL / [ ] N/A — synthetic E2E verified` |
| **AC-03** | Route Isolation | Zero cross-session recovery badges or content leakage across URLs | `[ ] PASS / [ ] FAIL` |
| **AC-04** | Last-Good Recovery | Full uncensored pre-filter text recoverable upon filter trigger | `[ ] PASS / [ ] FAIL / [ ] N/A — no natural filter observed` |
| **AC-05** | Terminal Durability | Terminal checkpoints persisted reliably through disposal and retry | `[ ] PASS / [ ] FAIL` |
| **AC-06** | History Atomicity | Incomplete history stages never corrupt canonical database | `[ ] PASS / [ ] FAIL` |
| **AC-07** | Strict Permissions | Manifest restricted to `storage`, `sidePanel`, and `chat.deepseek.com` | `[ ] PASS / [ ] FAIL` |
| **AC-08** | Truth Convergence | Reconciled history retains live revisions without data loss | `[ ] PASS / [ ] FAIL` |

---

## 5. Final Acceptance Conclusion

- [ ] **LIVE COMPATIBILITY BASELINE ACCEPTED** — All mandatory criteria passed (`PASS`), and all observed conditional criteria passed with zero failures. (Note: Synthetic E2E coverage verified for conditional scenarios not observed live).
- [ ] **REJECTED / DEFECTS IDENTIFIED** — Mandatory criteria or observed conditional criteria failed; defects logged below for remediation.
- [x] **LIVE MANUAL VERIFICATION REQUIRED** — Pending manual execution by human tester.

> [!NOTE]
> **Baseline Acceptance vs. Production Release:**
> Granting `LIVE COMPATIBILITY BASELINE ACCEPTED` confirms compatibility with the live DeepSeek web application under test.
> General distribution readiness (packaging, store listing, privacy compliance disclosures) belongs to Milestone 2E and subsequent release engineering phases.

**Tester Signature:** __________________________________
**Date:** ____________________
