# ADR 0006: Framework & Toolchain Selection (WXT, TypeScript, Svelte 5, Vitest)

## Status
Accepted

## Context
Developing a modern Manifest V3 extension with isolated execution worlds (`MAIN`, `ISOLATED`), background service workers, side panels, and cross-browser support (Chromium now, Firefox later) requires a build toolchain.
Upstream projects explored different approaches:
- `fireflyhoo`: No build system (plain JS, unbundled). Unable to share code, no types, no tests.
- `CATIOR`: Single giant unbundled script with Tampermonkey headers.
- `deepseek-memory`: Custom `build.js` using esbuild and Svelte.
- `better-deepseek`: Custom 10,000-line `build.js` wrapping esbuild, Vite, and custom asset pipeline.
- `headroom` & `chat2note`: **WXT (Next-gen Web Extension Framework)** with TypeScript and Vitest.

We need a stack that provides:
1. Zero-boilerplate Manifest V3 configuration with native support for `world: 'MAIN'` and `world: 'ISOLATED'`.
2. Seamless TypeScript integration with strict type-checking.
3. Lightweight, reactive UI for the Side Panel and inline recovery widgets without bloating runtime bundle sizes.
4. Fast, modern testing harness for headless unit/integration tests and browser e2e.

## Decision

### 1. Framework: WXT (Web Extension Tools)
We adopt **WXT** as our build framework:
- **Why WXT:**
  - Automated entrypoint discovery (`entrypoints/background.ts`, `entrypoints/interceptor.main.ts`, `entrypoints/content.ts`, `entrypoints/sidepanel/`).
  - Native Manifest V3 generation with automated manifest permissions and content script world registration.
  - Native multi-browser compilation (compiles to Chrome MV3 and Firefox MV3 from a single source tree).
  - Fast Vite-powered HMR development server with persistent profile management.

### 2. Language: TypeScript (Strict Mode)
All codebase layers must be written in strict TypeScript (`strict: true`, `noImplicitAny: true`). Domain contracts, protocol signatures, and event schemas must be strictly typed.

### 3. UI Framework: Svelte 5 (Quarantined to UI Entrypoints)
We adopt **Svelte 5** (Runes) strictly for user interface entrypoints:
- **Why Svelte 5:**
  - Ultra-lightweight footprint (compiles down to minimal vanilla DOM code, no heavy virtual DOM runtime).
  - Excellent reactivity using `$state` and `$derived` runes, perfect for live revision count updates and search filtering.
  - Clean Shadow DOM styling encapsulation for inline recovery badges.
- **Strict Boundary:** Svelte code is **strictly forbidden** inside `src/core/`, `src/transport/`, `src/adapters/`, and `src/storage/`. Svelte lives exclusively inside `src/ui/` and `src/entrypoints/sidepanel/`.

### 4. Testing Harness: Vitest + Playwright
- **Vitest:** Fast in-memory unit and integration testing. Ideal for deterministic SSE chunk boundary fuzzing, protocol decoding tests, and IndexedDB mock tests (`fake-indexeddb`).
- **Playwright:** Headless end-to-end browser tests verifying extension injection, side panel mounting, and real DOM interactions.

## Decision Summary Table

| Tool | Decision | Rationale |
|---|---|---|
| **TypeScript** | **KEEP** | Absolute necessity for contract-driven architecture and preventing runtime type errors. |
| **WXT** | **KEEP** | Proven in `headroom` and `chat2note`. Eliminates custom error-prone bundler scripts. |
| **Manifest V3** | **KEEP** | Mandatory for modern Chromium extensions; service worker lifecycle supported via ACK pipeline. |
| **Svelte 5** | **KEEP** | Confined strictly to UI layer (`entrypoints/sidepanel/`, `ui/`). Zero overhead in capture engine. |
| **Vitest** | **KEEP** | Fast, modern, compatible with Vite/WXT; enables instant regression test feedback. |
| **Playwright** | **KEEP** | Standard for real browser extension e2e verification. |

## Consequences
- **Positive:**
  - High developer ergonomics, unified tooling, robust type safety.
  - Future-proof Firefox compatibility built into WXT without custom build scripts.
- **Negative:**
  - Dependency on WXT ecosystem updates (mitigated by WXT being Vite-based and widely adopted).
