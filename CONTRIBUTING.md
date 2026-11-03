# Contributing to DeepSeek StreamArchive

Thank you for your interest in contributing to **DeepSeek StreamArchive**!

This project is an open-source, local-first browser extension designed to preserve real-time streaming responses, capture revisions before filtering or connection failures, and provide contextual recovery on `chat.deepseek.com`.

DeepSeek StreamArchive is an independent community project and is not affiliated with, sponsored by, or endorsed by DeepSeek.

---

## 1. Code of Conduct and Core Principles

Every contribution must respect the core architectural and privacy principles of DeepSeek StreamArchive:

1. **Local-First & Offline-Capable**:
   - All conversation archives, chunks, and metadata live in the user's local browser storage (IndexedDB).
   - No remote tracking, no analytics, no external servers, no telemetry, and no accounts.

2. **Least-Privilege Security**:
   - Extension permissions are strictly confined to `storage` and `sidePanel`.
   - Host permissions are strictly restricted to `https://chat.deepseek.com/*`.
   - Never introduce permissions such as `<all_urls>`, `activeTab`, `tabs`, `cookies`, `webRequest`, `debugger`, or `history`.

3. **Safe DOM & Zero XSS**:
   - Never use `innerHTML`, `outerHTML`, or `insertAdjacentHTML` in content scripts or injected scripts.
   - All dynamic UI elements must use safe DOM APIs (`document.createElement`, `textContent`, `setAttribute`).
   - Markdown rendering in presentation components must use token-based safe parsing with HTML escaping.

4. **Zero Credential Scraping**:
   - Never access or harvest `document.cookie`, user session tokens, or Authorization headers.

5. **Fail-Open Strategy**:
   - DeepSeek StreamArchive intercepts streaming responses passively. If the extension encounters an error, the native DeepSeek web application must continue to function normally without disruption.

6. **Context Continuity Consent**:
   - Context Continuity is strictly **OFF by default**. Any feature sending prompt augmentations must remain fully transparent, user-controlled, and require explicit opt-in.

---

## 2. Development Setup

### Prerequisites

- **Node.js**: `v20.x` or later (LTS recommended)
- **pnpm**: `v9.x` (`pnpm@9.15.5` pinned via `packageManager`)
- **Google Chrome**: Version 114+ (supports `chrome.sidePanel` Manifest V3 API)

### Clone & Install

```bash
git clone https://github.com/MalenkiySolovey/deepseek-stream-archive.git
cd deepseek-stream-archive
pnpm install
```

> **Windows Note**: Use `pnpm.cmd` if your shell does not resolve PowerShell aliases automatically.

---

## 3. Available Scripts

| Command | Description |
| :--- | :--- |
| `pnpm run dev` | Starts the WXT development server with live reload in Chrome. |
| `pnpm run build` | Compiles the production extension to `.output/chrome-mv3`. |
| `pnpm run typecheck` | Runs the TypeScript compiler (`tsc --noEmit`) to verify types. |
| `pnpm run test` | Runs the unit and integration test suite via Vitest. |
| `pnpm run test:watch` | Runs Vitest in watch mode for test-driven development. |
| `pnpm run test:e2e` | Runs end-to-end integration tests using Playwright with real Chromium MV3 extension context. |
| `pnpm run zip` | Packages `.output/chrome-mv3` into a distribution ZIP ready for store upload. |
| `pnpm run release:audit` | Validates manifest constraints, bundle security invariants, forbidden APIs, and package structure. |

---

## 4. Testing & Verification Requirements

Before submitting a Pull Request, all of the following gates must pass locally:

```bash
# 1. Typecheck
pnpm run typecheck

# 2. Vitest unit tests
pnpm run test

# 3. Production build
pnpm run build

# 4. Playwright e2e test suite
pnpm run test:e2e

# 5. Extension zip packaging
pnpm run zip

# 6. Release audit verification
pnpm run release:audit
```

---

## 5. Branching and Commit Conventions

- Work on descriptive feature branches (e.g. `feature/topic-name` or `fix/issue-description`).
- Follow [Conventional Commits](https://www.conventionalcommits.org/):
  - `feat: ...` for user-facing features or capabilities
  - `fix: ...` for bug fixes
  - `test: ...` for tests
  - `docs: ...` for documentation changes
  - `chore: ...` for toolchain, dependencies, or maintenance

---

## 6. Reporting Security Vulnerabilities

Please do **NOT** report security vulnerabilities via public GitHub issues. See [SECURITY.md](SECURITY.md) for instructions on confidential disclosure.
