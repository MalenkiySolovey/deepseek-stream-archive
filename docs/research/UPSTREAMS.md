# Upstream Repositories & References

This document records the external open-source projects evaluated, referenced, or adapted during the architectural design and development of **DeepSeek StreamArchive**.

---

## 1. Primary Upstream References & Adapted Components

### 1. EdgeTypE / better-deepseek
- **Repository:** `https://github.com/EdgeTypE/better-deepseek`
- **Recorded Git Commit:** `a09d845b3b62f4078c41a8d9b44f85174fbefcbf`
- **Commit Timestamp:** `2026-10-06T21:07:18+03:00`
- **License:** MIT License
- **Adapted Component:** Heuristic recursive message ID extraction in streaming Server-Sent Event (SSE) JSON payloads (`src/adapters/deepseek/protocol/message-id.ts`).
- **Architectural Distinction:** While `better-deepseek` relies on extensive user-script monkey-patching and direct DOM injections, StreamArchive uses an isolated Main World transport tap, strictly immutable canonical checkpoints, closed Shadow DOM overlays, and durable IndexedDB storage in the extension origin.

### 2. headroom-app / headroom
- **Repository:** `https://github.com/headroom-app/headroom`
- **Recorded Git Commit:** `ae59a768f643592ac9732b304918f2ab2963282f`
- **Commit Timestamp:** `2026-10-06T12:45:00+08:00`
- **License:** Apache-2.0
- **Referenced Concept:** Streaming context buffer management, multi-byte UTF-8 boundary chunking, and memory bounded replay buffers.
- **Architectural Distinction:** Headroom operates as an active API proxy, whereas StreamArchive operates strictly as a passive in-browser observer with zero external networking and zero credential inspection.

### 3. liuxd / deepseek-archive
- **Repository:** `https://github.com/liuxd/deepseek-archive`
- **Recorded Git Commit:** `ab202db540f8e2070b6056d324931962e294af5f`
- **Commit Timestamp:** `2026-09-24T12:36:23+08:00`
- **License:** MIT License
- **Referenced Concept:** DeepSeek web client DOM structure analysis, export schema structures, and Chrome Side Panel UI paradigms.
- **Architectural Distinction:** `deepseek-archive` performs batch exports post-hoc from the web page origin. StreamArchive captures tokens in real-time as they stream, preserving pre-filter revisions before censorship occurs.

---

## 2. Additional Evaluated Upstreams

| Project Name | Evaluated Version / Commit | License | Focus Area & Analysis Summary |
|---|---|---|---|
| **deepseek-memory** | `06.10.2026 21:32` | MIT | Analyzed client-side session management. Did not meet streaming durability and anti-recall requirements. |
| **ds-note** | `06.10.2026 21:34` | MIT | Examined Markdown note export mechanics. Lacked streaming checkpointing and closed Shadow DOM isolation. |
| **deepseek-anti-recall-catior** | `06.10.2026 21:32` | GPL-3.0 | Evaluated anti-recall heuristics. Incompatible license; suffered from host-DOM pollution and prototype mutation. |
| **deepseek-anti-recall-g124** | `06.10.2026 21:32` | MIT | Studied response cancellation detection. Exhibited high selector fragility across DeepSeek web updates. |
| **deepseek-anti-retract** | `06.10.2026 21:32` | MIT | Assessed content filter interception. Used direct DOM rewriting which breaks React virtualized lists. |
| **deepseek-backup-web** | `06.10.2026 21:39` | MIT | Evaluated API scraping and backup strategies. Proactive polling violated our zero-polling invariant. |
| **ai-chat-exporter** | `06.10.2026 21:39` | MIT | Reviewed cross-platform chat export schemas. |
| **chat2note** | `06.10.2026 21:39` | MIT | Evaluated client-side note synchronization paradigms. |
| **ace** | `06.10.2026 21:36` | MIT | Studied browser extension content script bridge architectures. |

---

## 3. License Compliance & Copyright Attribution

All adapted code is attributed in `README.md` under **Acknowledgements & Third-Party Code** with corresponding original license notices preserved.
StreamArchive does not incorporate copyleft code (e.g., GPL-3.0) and maintains a clean MIT license.
