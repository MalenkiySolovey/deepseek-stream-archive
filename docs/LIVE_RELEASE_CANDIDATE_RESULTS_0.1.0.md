# Live Release Candidate Manual Acceptance Results (v0.1.0)

**Date**: 2026-11-03  
**Milestone**: `2F-LA — Final Release Candidate Manual Acceptance & Store Asset Staging`  
**Platform**: Google Chrome / Chromium 114+ (Manifest V3)  
**Database Schema**: `StreamArchiveDB` (Version 9)  
**Repository**: `https://github.com/MalenkiySolovey/deepseek-stream-archive`  

---

## 1. Release Package Identification

| Parameter | Specification | Audit Result | Status |
| :--- | :--- | :--- | :--- |
| **Package File** | `deepseek-stream-archive-0.1.0-chrome.zip` | Found at `.output/deepseek-stream-archive-0.1.0-chrome.zip` | **PASS** |
| **File Size** | `781,656 bytes` (`763.34 KB`) | Exactly `781,656 bytes` | **PASS** |
| **SHA-256 Checksum** | `75cf4da6c1c97c67c80f3e62bc35133d3907a76f608ad6486227a0e9b7d39e41` | Exactly matches local build & GitHub Actions runner | **PASS** |
| **Remote Equivalence** | GitHub Actions Run `41637272043` artifact | SHA-256 identical to remote workflow artifact | **PASS** |
| **Extracted Test Package** | `release-test\chrome-extension\` | 20 entries cleanly extracted and verified | **PASS** |

---

## 2. Manifest & Package Structure Verification

- **Manifest Version**: `3` (Manifest V3).
- **Extension Name**: `DeepSeek StreamArchive` (23 characters, <= 45 limit).
- **Extension Version**: `0.1.0` (Numeric dot-separated, matching `package.json`).
- **Minimum Chrome Version**: `"114"` (Officially required for `chrome.sidePanel` API).
- **Homepage URL**: `https://github.com/MalenkiySolovey/deepseek-stream-archive`.
- **Declared Permissions**: Strictly `['storage', 'sidePanel']`.
- **Declared Host Permissions**: Strictly `['https://chat.deepseek.com/*']`.
- **Forbidden Permissions Audit**:
  Verified zero forbidden permissions (`<all_urls>`, `tabs`, `activeTab`, `cookies`, `webRequest`, `webRequestBlocking`, `debugger`, `history`, `downloads`, `scripting`, `declarativeNetRequest`).
- **Bundle Hygiene**:
  Zero `.ts`, `.tsx`, `.svelte`, `.map`, `.env`, `.git`, or `node_modules` inside the distribution ZIP.

---

## 3. Clean Profile Installation & First-Run Defaults

1. **Clean Test Profile**:
   - Initialized outside Git in a clean temporary user data directory (`release-test/`).
   - Clean slate confirmed: Zero existing IndexedDB databases, zero `chrome.storage.local` keys, zero synthetic conversations.
2. **First-Run Behavior**:
   - Extension loaded unpacked from `release-test\chrome-extension\`.
   - Side panel opened cleanly on first launch without errors or crashes.
   - Initial state displayed empty archive state ("No conversations archived yet").
   - Zero prompts for account creation, login, or cloud sync.
   - Zero telemetry consent popups.
3. **Default Feature Configuration**:
   - **Context Continuity**: Strictly **OFF** by default (`enabled: false`).
   - **Delivery Mode**: Strictly **`manual_next`** by default.
   - **Include DeepThink**: Strictly **OFF** by default.
   - **Privacy Disclosure**: Visible callout in Settings clearly stating: *"When enabled, selected locally stored text is transmitted to DeepSeek as part of your prompt."*

---

## 4. Functional Smoke Verification (Extracted Release Package)

| Test Area | Procedure | Observed Behavior | Status |
| :--- | :--- | :--- | :--- |
| **Normal Generation** | Harmless clean prompt (`DSA-RC-01. Ответь только: RELEASE READY`) | Response captured token-by-token over SSE; canonical message committed to IndexedDB. | **PASS** |
| **Network Sanity** | DevTools network payload inspection | Outgoing prompt contains only user text; zero continuity markers attached while feature is OFF. | **PASS** |
| **Archive Browser** | Side panel conversation list inspection | Conversation card appears with correct turn count, timestamps, and message text; zero duplication. | **PASS** |
| **Search Function** | Search bar query for `DSA-RC-01` | Matching conversation immediately surfaced; search query cleared safely. | **PASS** |
| **Human Export** | Export conversation as Markdown & JSON | `.md` and `.json` files generated and downloaded with full turn text and UTF-8 characters preserved. | **PASS** |
| **Backup & Restore** | Export `.streamarchive.jsonl.gz`, delete conversation, restore | Backup created, pre-flight validated; conversation restored atomically with 100% record integrity. | **PASS** |
| **Inline Recovery** | Interrupted response simulation via closed Shadow DOM | Native placeholder hidden; inline recovery banner mounts with recovered answer and preserved native toolbar. | **PASS** |
| **Context Continuity** | Enable feature in `manual_next` mode, arm message, send turn | Prompt augmented with structured boundary markers; manual arm disarms after one turn; receipt saved. | **PASS** |
| **Page Reload (F5)** | Reload `chat.deepseek.com` after context continuity use | User bubble cleanly displays user-authored prompt; continuity disclosure rendered non-destructively. | **PASS** |
| **Retention Cleanup** | Configure 30-day retention policy and run manual cleanup | Expired raw streams pruned while keeping canonical conversation records 100% intact. | **PASS** |

---

## 5. UI, Theme & Localization Audits

- **Dark Theme Audit**:
  Tested across DeepSeek dark mode and Side Panel dark scheme (`#0f172a` / `#111827`). High contrast, crisp borders (`#334155`), readable code blocks (`#1f2937`), clear active states on tabs and buttons.
- **Light Theme Audit**:
  Inspected Side Panel under light mode. Clean typography, visible status pills, no disappearing or low-contrast elements.
- **Side Panel Width Adaptability**:
  Tested at 360px (narrow), 440px (standard), and 600px (wide). Flexbox layout adapts seamlessly; zero horizontal clipping, zero modal overflows.
- **Russian UI Audit (`ru`)**:
  Switched locale to Russian in Side Panel. All navigation tabs, card labels, recovery headers, settings toggles, and backup dialogues render grammatically accurate Russian copy.
- **English UI Audit (`en`)**:
  Switched locale to English. Clean, idiomatic English terminology matching Store Listing documentation.
- **Console Health**:
  Zero uncaught exceptions, zero unhandled promise rejections, zero private conversation bodies printed to browser console or service worker logs.

---

## 6. Security & Invariant Audit

- **Zero Remote Code**: Static bundle scan verified zero `<script src="http">`, zero `import("http")`, zero `new Worker("http")`.
- **Zero Dynamic String Evaluation**: Zero `eval()`, zero `new Function()` in application code.
- **Zero Insecure DOM APIs**: Injected and content scripts contain **zero `innerHTML`**, **zero `outerHTML`**, and **zero `insertAdjacentHTML`**.
- **Zero Credential Harvesting**: Zero access to `document.cookie`, zero extraction of user session tokens or Authorization headers.
- **Origin Isolation**: Extension IndexedDB is hosted exclusively in `chrome-extension://<id>`, inaccessible to web pages.
- **Fail-Open Strategy**: Interceptor wraps network calls passively; simulated extension errors leave native DeepSeek 100% operational.

---

## 7. Store Asset Staging Verification

All 5 store screenshots have been staged in `release-test\screenshots\` and verified:
1. `01-archive-browser-1280x800.png` (`61.92 KB`, SHA-256 `89468350f4...`): Archive Browser & Conversation Tree.
2. `02-inline-recovery-1280x800.png` (`85.61 KB`, SHA-256 `4179589550...`): In-Page Inline Recovered Response.
3. `03-revision-history-1280x800.png` (`66.68 KB`, SHA-256 `f8925a3c9e...`): Revision Timeline & Multi-Version Preservation.
4. `04-context-continuity-preview-1280x800.png` (`133.41 KB`, SHA-256 `024837401d...`): Context Continuity Planner & Preview.
5. `05-privacy-settings-1280x800.png` (`104.40 KB`, SHA-256 `998ca326b0...`): Privacy & Retention Controls.

- **Dimensions**: Strictly `1280 × 800` pixels across all 5 assets.
- **Privacy**: 100% synthetic scenarios; zero personal data.
- **Production Icon**: `icon-128.png` verified at 128×128 PNG.

---

## 8. Final Readiness State

```text
======================================================================
READINESS VERDICT:
READY FOR MANUAL CWS UPLOAD
======================================================================
```

**Reasoning**:
- The release candidate package (`deepseek-stream-archive-0.1.0-chrome.zip`, SHA-256 `75cf4da6...`) has passed all technical, security, clean-install, and functional gates.
- Remote CI build on GitHub Actions is 100% byte-for-byte identical to the local release package.
- All 5 required store screenshots are generated, verified, and staged.
- The manual Chrome Web Store Developer Console upload sequence is prepared in [`docs/CHROME_WEB_STORE_SUBMISSION_GUIDE.md`](./CHROME_WEB_STORE_SUBMISSION_GUIDE.md).
- The package is now ready for the user to upload to the Developer Dashboard.
