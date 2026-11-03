# DeepSeek StreamArchive — Release Checklist

This checklist must be verified before submitting any release of **DeepSeek StreamArchive** to the Chrome Web Store.

---

## 1. Source Hygiene & Environment
- [ ] Working tree is clean (`git status --short` returns zero modified or untracked files).
- [ ] Working branch is `main` or an official release branch.
- [ ] Dependencies are locked in `pnpm-lock.yaml` with zero security vulnerabilities (`pnpm audit`).
- [ ] Version in `package.json` matches target release version (e.g. `0.1.0`).
- [ ] `CHANGELOG.md` is updated with all changes under the versioned release header.

## 2. Manifest & Store Policy Compliance
- [ ] `manifest_version` is strictly `3`.
- [ ] `name` is strictly `"DeepSeek StreamArchive"` (length <= 45 chars).
- [ ] `version` in `manifest.json` matches `package.json`.
- [ ] `minimum_chrome_version` is declared as `"114"`.
- [ ] `homepage_url` points to official GitHub repository.
- [ ] `permissions` contains strictly `['storage', 'sidePanel']`.
- [ ] Prohibited permissions (`<all_urls>`, `tabs`, `activeTab`, `cookies`, `webRequest`, `debugger`, `history`, `scripting`) are absent.
- [ ] `host_permissions` contains strictly `['https://chat.deepseek.com/*']`.
- [ ] Single-purpose compliance: extension exclusively captures, preserves, recovers, and continues DeepSeek chat streams locally.
- [ ] Unofficial community disclaimer is present in documentation and store listing.

## 3. Security & Privacy Invariants
- [ ] Zero remotely hosted code: no external `<script src="https://...">`, `import('https://...')`, or `new Worker('https://...')`.
- [ ] Zero execution of dynamic strings: no `eval()` and no `new Function()`.
- [ ] Zero credential harvesting: no access to `document.cookie`, no reading user session tokens or Authorization headers.
- [ ] Content scripts and injected scripts use zero `innerHTML`, `outerHTML`, or `insertAdjacentHTML`.
- [ ] Content scripts avoid probing React internals (`__reactFiber`, `__reactProps`).
- [ ] Safe Markdown parser escapes raw HTML and constructs DOM via safe elements and text nodes.
- [ ] Context Continuity is disabled by default (`enabled: false`), defaults to `manual_next`, and requires explicit user consent before sending augmentations.
- [ ] `PRIVACY.md` accurately describes local IndexedDB storage, zero analytics, zero accounts, and data deletion mechanisms.

## 4. Automated Quality Gates
- [ ] `pnpm run typecheck` passes with 0 TypeScript errors.
- [ ] `pnpm run test` passes 100% of Vitest unit and integration suites.
- [ ] `pnpm run build` cleanly builds `.output/chrome-mv3`.
- [ ] `pnpm run test:e2e` passes 100% of Playwright Chromium MV3 end-to-end tests across multiple consecutive runs.
- [ ] `pnpm run zip` packages extension cleanly into `.output/deepseek-stream-archive-<version>-chrome.zip`.
- [ ] `pnpm run release:audit` completes with 0 failures.

## 5. Manual Smoke Tests & Functional Verification
- [ ] **Clean Install**: Unpacked extension loads in Chrome without warnings, errors, or permission prompts beyond defaults.
- [ ] **Stream Interception**: Interceptor mounts in MAIN world; real-time streaming tokens are captured without disrupting native DeepSeek UI.
- [ ] **Side Panel UI**: Side panel opens cleanly, displays conversation list, search, filters, and inspector.
- [ ] **Inline Recovery**: When a response is filtered or fails, the inline recovery banner renders safely via Shadow DOM without native page style leakage.
- [ ] **Context Continuity**: Explicit prompt augmentation works cleanly with collapsible context disclosure and reversible placeholder hiding.
- [ ] **Data Export**: Human export (Markdown / JSON) and Portable Backup (.streamarchive.jsonl.gz) generate valid files.
- [ ] **Backup Restore**: Atomic restore and merge function safely with pre-flight validation.
- [ ] **Retention & Deletion**: Deleting sessions, purging archives, and automated retention cleanup work reliably without database corruption.
- [ ] **Fail-Open Behavior**: Disabling extension features or simulating network drops leaves native DeepSeek fully operational.

## 6. Store Assets & Listing
- [ ] High-resolution PNG icons exist at all required sizes (`16x16`, `32x32`, `48x48`, `128x128`).
- [ ] Favicon / ICO assets exist for side panel and browser UI.
- [ ] Store listing short description is under 132 characters (neutral terminology).
- [ ] Store listing detailed description is prepared in English and Russian (`docs/CHROME_WEB_STORE_LISTING.md`).
- [ ] Five neutral synthetic screenshots are staged matching `docs/STORE_ASSETS.md` (no personal data, no real user chats).
- [ ] Marquee and small promotional tiles are ready.
- [ ] Chrome Web Store Privacy tab answers match `docs/CHROME_WEB_STORE_PRIVACY_DISCLOSURES.md`.
- [ ] Reviewer instructions and credentials notice are ready for submission notes.

## 7. Packaging & Distribution
- [ ] Distribution ZIP contains no source files (`.ts`, `.svelte`, `.test.ts`), no source maps, no `.git`, no `.env`, and no `node_modules`.
- [ ] SHA-256 hash of the distribution ZIP is recorded in `docs/RELEASE_READINESS_<version>.md`.
- [ ] GitHub Actions CI run on `main` is completely green.
- [ ] GitHub Actions `release-candidate.yml` workflow run successfully produces downloadable ZIP artifact with matching hash.
