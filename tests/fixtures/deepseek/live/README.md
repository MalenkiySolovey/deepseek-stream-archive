# Live DeepSeek Acceptance Gate & Fixture Capture Guide

This directory is the designated staging and archive location for **sanitized live stream fixtures** recorded from real user sessions on `https://chat.deepseek.com/`.

---

## 1. Acceptance Gate Purpose & States

DeepSeek StreamArchive employs an explicit **Acceptance Gate** to verify protocol compatibility before deploying or declaring full support for live web application changes.

The extension and test framework distinguish between the following compatibility states:

| Compatibility State | Meaning |
|---|---|
| `not_observed` | No stream traffic has been processed yet in the current session. |
| `automated_verified` | Verified against synthetic test suites and vetted static reference fixtures. |
| `live_observed` | Verified against actual real-time streaming traffic captured on `chat.deepseek.com`. |
| `degraded` | Stream sequencing anomalies, sequence gaps, or unknown patch operations encountered. |
| `incompatible` | Breaking changes detected in the upstream DeepSeek streaming format. |

---

## 2. Privacy & Sanitization Mandate

> [!CAUTION]
> **NEVER COMMIT RAW NETWORK DUMPS CONTAINING SENSITIVE DATA.**
> All fixtures contributed to this directory must strictly comply with `workbench/docs/PRIVACY_SECURITY.md`.

Before saving or submitting any live fixture:
1. **Strip Authentication Tokens**:
   - Remove any `Authorization: Bearer ...` headers.
   - Remove `userToken`, session cookies, or refresh tokens.
2. **Strip Sensitive Queries & User PII**:
   - Strip all URL query parameters (`?query=...`, `?token=...`).
   - Replace any personal identifiable information (names, emails, proprietary source code) in prompt and response text with synthetic placeholder text.
3. **Preserve Protocol Structure Intact**:
   - Preserve exact SSE framing (`data: ...`, empty line boundaries).
   - Preserve JSON patch paths (`p`), operations (`o`), and object hierarchy (`v`).
   - Preserve terminal sentinels (`data: [DONE]`, `status: "FINISHED"`).

---

## 3. Fixture Naming Convention

| File Pattern | Description |
|---|---|
| `live-normal-*.sse.txt` | Standard streaming chat completion (non-reasoning model). |
| `live-reasoning-*.sse.txt` | Thinking / reasoning model stream (contains `THINK`/`THINKING` fragments or `thinking_content`). |
| `live-filtered-*.sse.txt` | Moderated or refusal stream (contains `CONTENT_FILTER` or `TEMPLATE_RESPONSE`). |
| `live-aborted-*.sse.txt` | Stream where user manually pressed the Stop button mid-generation. |

---

## 4. Replay Verification

Once a new live fixture is added to this directory, add or run a replay test in `tests/deepseek-reference-fixtures.test.ts`:

```bash
pnpm run test
```

Verification passes when:
- SSE framing is decoded with 0 framing errors.
- Monotonic stream sequence is preserved (`0 -> 1 -> 2 -> ...`).
- Correct content projection source is tagged (`fragments` or `top_level`).
- Expected terminal event is emitted (`stream_finished` or `stream_interrupted`).
