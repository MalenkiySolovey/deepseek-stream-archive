# Versioning Policy & Release Numbering

> **Project:** DeepSeek StreamArchive  
> **Current Version:** `0.1.0` (Release Candidate)  
> **Schema Standard:** Semantic Versioning 2.0.0 & Chrome Extension Manifest Version Rules  

---

## 1. Principles & Standard Compliance

DeepSeek StreamArchive follows **Semantic Versioning 2.0.0** (`MAJOR.MINOR.PATCH`) while strictly conforming to Chromium Manifest V3 version string specifications.

### 1.1 Chrome Web Store Numeric Version Constraints
Chromium requires that the `version` field in `manifest.json` consists of one to four dot-separated integers between 0 and 65535:
```text
MAJOR.MINOR.PATCH[.BUILD]
```
- No alphabetic characters or suffixes (e.g. `-rc1`, `-beta`) are permitted in Chrome `manifest.json`.
- Each number must be an integer between `0` and `65535`.
- Version comparisons are performed numerically per component (e.g. `0.1.0` < `0.1.1` < `0.2.0`).

---

## 2. Release Progression Policy

| Version Tier | Purpose & Scope | Release Stage |
|:---:|---|:---:|
| **`0.1.0`** | **Initial Public Release for Chrome / Chromium**.<br>Full functional parity: stream capture, recovery, inline presentation, export, backup/restore, retention, and Context Continuity. | Public Release |
| **`0.1.x`** | Post-release patches, store review adjustments, and bug fixes. | Hotfix / Patch |
| **`0.2.0`** | Multi-browser compatibility and Firefox Add-on support. | Feature Expansion |
| **`1.0.0`** | General Availability (GA) following production store deployment and multi-browser stability. | Public GA |

*Policy Rule:* The version must **not** be arbitrarily bumped to `1.0.0` until the extension is proven in live public store distribution and multi-browser environments.

---

## 3. Authoritative Version Source

To eliminate conflicting version declarations across repository configurations:
- **Primary Authority:** `package.json` defines the canonical project version.
- **Manifest Synchronization:** `wxt.config.ts` must declare a version identical to `package.json`.
- **Automated Validation:** The `release:audit` script asserts that `package.json` and generated `manifest.json` versions match exactly before any release build or ZIP package is approved.

---

## 4. Database Schema Version Independence

The extension database schema version (`DB_VERSION = 9` in `src/storage/schema.ts`) is architecturally decoupled from product release versions:
- Schema increments occur only when IndexedDB stores, object store indexes, or data persistence models undergo structural migrations.
- Multiple application versions (`0.1.0`, `0.1.1`, etc.) may share the same database schema version.
- Database downgrades are strictly forbidden; migrations are forward-only and idempotent.
