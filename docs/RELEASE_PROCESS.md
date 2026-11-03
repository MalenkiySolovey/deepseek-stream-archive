# DeepSeek StreamArchive — Release Process Guide

This document defines the official step-by-step procedure for preparing, validating, packaging, and publishing releases of **DeepSeek StreamArchive** to the Chrome Web Store.

---

## 1. Release Lifecycle Overview

```text
Version Bump & Changelog Update
              ↓
Local Automated Verification Pipeline
(typecheck → test → build → test:e2e → zip → release:audit)
              ↓
Git Commit & Tagging (vX.Y.Z)
              ↓
Push to origin/main & CI Verification
              ↓
Trigger Release Candidate Workflow (GitHub Actions)
              ↓
Download & Audit Distribution Artifact (.zip)
              ↓
Upload to Chrome Web Store Developer Dashboard
              ↓
Submit for Google Review
```

---

## 2. Versioning Policy

- Follow **Semantic Versioning 2.0.0** (`MAJOR.MINOR.PATCH`).
- For Chrome Web Store compliance, the version string must be strictly numeric dot-separated integers (e.g. `0.1.0`).
- The canonical version is declared in `package.json`. WXT automatically propagates this to `manifest.json`.
- For detailed versioning rules and migration policies, consult [VERSIONING.md](VERSIONING.md).

---

## 3. Pre-Release Verification Pipeline

All verification steps must succeed without warnings or skips:

```bash
# Step 1: TypeScript type checking
pnpm run typecheck

# Step 2: Full Vitest test suite
pnpm run test

# Step 3: Production extension build
pnpm run build

# Step 4: Playwright Chromium MV3 end-to-end tests
pnpm run test:e2e

# Step 5: Distribution ZIP archive packaging
pnpm run zip

# Step 6: Security and Store readiness audit
pnpm run release:audit
```

---

## 4. Documentation & Artifact Updates

Before cutting a release commit:

1. **CHANGELOG.md**:
   - Move entries from `[Unreleased]` to a versioned header (e.g., `## [0.1.0] - YYYY-MM-DD`).
   - Group entries by `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, and `Security`.
2. **docs/RELEASE_READINESS_X.Y.Z.md**:
   - Generate or update the release readiness report with exact artifact SHA-256 hashes and test run summaries.
3. **docs/RELEASE_CHECKLIST.md**:
   - Complete every checkbox in the checklist.

---

## 5. Tagging & Git Procedure

```bash
# 1. Commit all prepared files
git add .
git commit -m "chore: release vX.Y.Z"

# 2. Create signed or annotated tag
git tag -a vX.Y.Z -m "Release vX.Y.Z"

# 3. Push commit and tag to GitHub
git push origin main
git push origin vX.Y.Z
```

---

## 6. GitHub Actions Release Candidate Workflow

1. Navigate to repository **Actions** tab on GitHub:
   `https://github.com/MalenkiySolovey/deepseek-stream-archive/actions`
2. Select **Release Candidate Build & Package**.
3. Click **Run workflow** selecting the release tag or `main` branch.
4. Verify the CI run completes with green status:
   - TypeScript verification
   - Vitest suite
   - Production build
   - Playwright E2E suite
   - WXT ZIP packaging
   - Release audit script
5. Download the packaged artifact:
   `deepseek-stream-archive-X.Y.Z-chrome.zip`.
6. Verify the SHA-256 checksum against your local build:
   ```bash
   Get-FileHash -Algorithm SHA256 .output/deepseek-stream-archive-X.Y.Z-chrome.zip
   ```

---

## 7. Chrome Web Store Submission Procedure

1. Sign in to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Select **DeepSeek StreamArchive** (or click *New Item* for the initial submission).
3. **Package Tab**:
   - Upload `deepseek-stream-archive-X.Y.Z-chrome.zip`.
   - Verify that the manifest version matches `X.Y.Z`.
4. **Store Listing Tab**:
   - Verify descriptions, screenshots, icons, and promotional tiles match [CHROME_WEB_STORE_LISTING.md](CHROME_WEB_STORE_LISTING.md) and [STORE_ASSETS.md](STORE_ASSETS.md).
5. **Privacy Tab**:
   - Complete questionnaire according to [CHROME_WEB_STORE_PRIVACY_DISCLOSURES.md](CHROME_WEB_STORE_PRIVACY_DISCLOSURES.md).
   - Verify privacy policy link points to:
     `https://github.com/MalenkiySolovey/deepseek-stream-archive/blob/main/PRIVACY.md`.
6. **Reviewer Notes**:
   - Copy reviewer notes verbatim from [CHROME_WEB_STORE_LISTING.md](CHROME_WEB_STORE_LISTING.md).
7. Click **Submit for Review**.

---

## 8. Rollback and Hotfix Procedure

If a critical issue is discovered post-release:

1. Immediately create a hotfix branch from `vX.Y.Z`:
   ```bash
   git checkout -b hotfix/X.Y.Z+1 vX.Y.Z
   ```
2. Implement the fix with accompanying tests.
3. Bump patch version in `package.json` (`X.Y.Z+1`).
4. Run full pre-release pipeline (`pnpm run typecheck && pnpm run test && pnpm run build && pnpm run test:e2e && pnpm run zip && pnpm run release:audit`).
5. Commit, tag (`vX.Y.Z+1`), push, and submit the hotfix package immediately to the Chrome Web Store with an expedited review note describing the fix.
