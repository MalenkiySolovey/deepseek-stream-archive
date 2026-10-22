# Development Principles & Engineering Rules

> **DeepSeek StreamArchive**  
> Status: Non-Negotiable Engineering Rules  
> Target: Maintainers, Contributors, and AI Coding Assistants  

This document codifies the non-negotiable architectural invariants and development rules for DeepSeek StreamArchive. These rules prevent gradual degradation into a brittle collection of ad-hoc hacks.

---

## 1. Boundary & Layering Invariants

1. **DeepSeek details stay in the DeepSeek adapter:**
   No vendor-specific endpoint, CSS class, JSON structure, or status code may ever be referenced outside `src/adapters/deepseek/`.
2. **Core never queries DOM:**
   `src/core/` operates exclusively on canonical TypeScript models and domain events. It must never call `document.querySelector`, inspect `.ds-markdown`, or touch the DOM.
3. **Transport never understands DeepSeek semantics:**
   `src/transport/` handles generic byte streams, chunk boundaries, and SSE line framing. It must NEVER contain logic for `CONTENT_FILTER`, `TEMPLATE_RESPONSE`, `thinking`, or `chat_session_id`.
4. **UI never parses raw network traffic:**
   `src/ui/` consumes structured records from IndexedDB and emits user intent events. It never inspects SSE chunks or page requests directly.
5. **Storage never depends on DOM objects:**
   `src/storage/` accepts only serializable plain TypeScript objects. It must never store DOM nodes, HTML strings, or live event references.
6. **No privileged state in the MAIN world:**
   `interceptor.main.ts` is strictly passive and unprivileged. It contains zero extension secrets, zero business logic, zero storage access, and zero UI code.
7. **No UI frameworks outside UI entrypoints:**
   Svelte 5 code is strictly quarantined to `src/ui/` and `src/entrypoints/sidepanel/`. No framework dependencies exist in `core`, `transport`, or `storage`.

---

## 2. Identity & Association Rules

8. **Never associate responses by length alone:**
   It is strictly forbidden to use "longest backup" or length proximity as an identity heuristic. A 5,000-character code block from Turn 1 must never be restored into Turn 10 simply because Turn 10's ID is missing.
9. **DOM position is never high-confidence identity:**
   Because DeepSeek uses virtualized scrolling, an element's index in `querySelectorAll('.ds-markdown')` represents only its current viewport position, not its conversation turn. Positional matching may only be used as a lowest-confidence tie-breaker on tail windows.
10. **Server IDs are authoritative for session history:**
    `chat_session_id`, `message_id`, and `parent_message_id` are canonical keys for cross-turn association. When server IDs are available, they override DOM-derived hypotheses.
11. **Content-hash fallback for missing IDs:**
    If server IDs are absent during a live stream, generate a deterministic hash of the user's prompt text plus timestamp bucket.

---

## 3. Capture & Recovery Rules

12. **Passive capture first:**
    StreamArchive defaults to non-invasive, read-only observation. It never rewrites live SSE streams or tampers with server responses in-flight as its baseline recovery mechanism.
13. **Non-destructive recovery UI:**
    Never overwrite a living React/Vue virtual list node with `el.innerHTML = backup`. Display recovered content via isolated overlay cards, Shadow DOM badges, and the Extension Side Panel.
14. **Maintain a revision journal, not a single latest string:**
    A message is a timeline of revisions. Never overwrite previous useful content with a subsequent refusal token.
15. **Preserve thinking separately from answers:**
    DeepThink reasoning fragments (`type: 'THINK'`) must be modeled, stored, and toggled distinctly from the final response text.

---

## 4. Resilience & Error Handling

16. **Prefer degraded mode over incorrect recovery:**
    If a protocol shift reduces capture confidence, switch visibly to "Degraded Mode" (e.g. History+DOM backup) rather than guessing identities and corrupting user archives.
17. **Never silently swallow compatibility failures:**
    When unexpected SSE keys or DOM changes are detected, log an internal diagnostic observation and update the capability probe status.
18. **Every compatibility fix requires a fixture and a regression test:**
    No bug fix for a DeepSeek protocol change will be merged without an accompanying sanitized `.jsonl` fixture and automated Vitest test.
19. **Fail soft and visibly:**
    Extension failures must not crash the host DeepSeek page or prevent the user from chatting normally.

---

## 5. Security & Privacy Rules

20. **Local-first by default:**
    All conversations remain on the user's machine. Zero external servers, zero cloud syncing, zero telemetry, zero analytics.
21. **Isolated IndexedDB origin:**
    IndexedDB must strictly be initialized under `chrome-extension://<id>`, never within the page or content script context.
22. **Zero token logging:**
    Never persist or log DeepSeek authorization tokens (`Authorization: Bearer ...`, `userToken`) in archive metadata or debug dumps.
23. **Redact production console:**
    Never print full conversation contents or sensitive user prompts to the browser developer console in release builds.
24. **Validate all world-crossing messages:**
    Messages received from the `MAIN` world must be validated with runtime schema checks before processing in privileged extension contexts.

---

## 6. Codebase Hygiene & Licensing Rules

25. **License-aware upstream reuse ("Adapt, don't transplant"):**
    StreamArchive permits license-compliant reuse and adaptation of upstream code. Reused code must be understood, architecturally adapted, tested, attributed where required, and must not bypass StreamArchive's layer boundaries.

    - **MIT / Apache-2.0 upstream** (e.g. `deepseek-memory`, `better-deepseek`, `ds-note`, `headroom`): Code may be adapted with required copyright/license notices preserved. Record each adaptation in `THIRD_PARTY_NOTICES.md`.
    - **MPL-2.0 upstream** (e.g. `ace`): Use only architectural ideas. If file-level code is copied, that file must remain MPL-2.0. Prefer independent reimplementation to avoid file-level copyleft obligations.
    - **AGPL / CC BY-NC-SA upstream** (e.g. `CATIOR`, `chat2note`): Use as reference, behavioral observation, and fixture inspiration ONLY. Do not copy code into the MIT-licensed StreamArchive source.
    - **Unlicensed upstream** (e.g. `deepseek-anti-retract`, `G-124`, `DeepSeek-backup-web`): Read and analyze only. Do not copy any code — absence of license means All Rights Reserved under Berne Convention.

    **Forbidden regardless of license:**
    - Copying a monolithic upstream script as the architectural foundation.
    - Leaving upstream architecture in place instead of integrating via StreamArchive's own layer contracts.
    - Mixing DeepSeek-specific upstream code into `src/core/` or `src/transport/`.
    - Copying code without understanding it.
    - Ignoring license/NOTICE attribution requirements.

    Record every non-trivial adaptation in `workbench/THIRD_PARTY_NOTICES.md`.

26. **No premature multi-platform abstraction:**
    Do not implement fake ChatGPT or Claude adapters in v0.x. Keep interfaces clean, but focus implementation entirely on DeepSeek.
27. **No premature WebSocket code:**
    Do not write speculative WebSocket decoders until DeepSeek actually uses WebSockets in production.
28. **Do not create "god" files:**
    No source file may exceed 500 lines of code. Split monolithic scripts into cohesive, single-responsibility modules.
