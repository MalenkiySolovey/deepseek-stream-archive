# ADR 0007: Raw Protocol Event Journaling, Privacy Controls, and Offline Replay

## Status
Accepted

## Context
When web applications alter their internal streaming formats (such as DeepSeek introducing new status codes, nesting fragment paths differently, or changing thinking tags), older extension parsers may fail to extract tokens or may misclassify content.

If an extension only stores the final parsed output (`text: string`), any flaw or limitation in the parser version that captured the stream becomes permanent. The underlying stream cannot be re-parsed or recovered.

Conversely, unconditionally recording every raw byte of every network request indefinitely creates severe risks:
1. **Storage Bloat:** Raw HTTP streams and SSE overhead can quickly consume hundreds of megabytes of local IndexedDB storage.
2. **Privacy Exposure:** Raw streams may inadvertently contain sensitive user prompt data, session cookies, Bearer tokens, or API secrets if not strictly scrubbed.
3. **Performance Penalty:** Writing voluminous raw event logs on every turn increases I/O overhead.

## Decision

### 1. Dual-Representation Architecture
StreamArchive separates stored conversation state into:
1. **Canonical State (Always On):** Normal structured tables (`conversations`, `messages`, `revisions`, `recovery_events`). This is the primary store for UI rendering, full-text search, and markdown export.
2. **Raw Event Journal (Configurable / Opt-in):** An append-only log of raw SSE data frames (`RawProtocolEvent`) captured during the generation stream:
   ```ts
   interface RawProtocolEvent {
     id: string;
     streamSessionId: string;
     capturedAt: number;
     endpoint: string;
     rawEventText: string; // Sanitized SSE line (e.g. data: {...})
   }
   ```

### 2. Strict Privacy Sanitization Prior to Storage
Before a raw event is written to the raw event journal:
- **Zero Credentials:** HTTP request headers (`Authorization: Bearer ...`, `Cookie`, `x-client-token`) are strictly stripped and NEVER saved to the raw event journal.
- **Redaction of User Identifiers:** Internal user account IDs or billing details returned in session metadata are redacted.

### 3. Strict Retention & Capacity Controls
Raw journaling is governed by configurable user settings in `chrome.storage.local`:
- **Default State:**
  - In normal production release: Raw journaling is **DISABLED by default** or restricted to a rolling circular buffer of the **last 50 generation turns** (or 25 MB max).
  - In development / debug mode: Full raw capture is enabled to facilitate fixture recording and bug reports.
- **Auto-Pruning Policy:**
  When a turn concludes normally (`status: FINISHED`) and is verified against history without any recovery event, raw events for that turn can be pruned after 7 days, retaining only canonical text revisions.
- **Diagnostic Trace Export with Redaction:**
  When a user exports a diagnostic trace to file a bug report for an unhandled DeepSeek protocol change, the extension sanitizes user prompt text and token strings, exporting only the structural JSON keys and error frames.

### 4. Offline Replay Engine
StreamArchive implements an offline re-decoder utility (`replayStream(rawEvents, decoderVersion)`). If a newer version of the DeepSeek adapter is installed that fixes a fragment decoding bug, the user can click "Re-index / Reconstruct from Raw Journal", allowing historical captured sessions to be rebuilt with improved fidelity.

## Consequences
- **Positive:**
  - True future-proofing: Historical streams can be re-parsed when bugs are fixed in protocol decoders.
  - Reproducibility: Creates authentic, anonymized test fixtures for regression testing directly from real-world failure events.
- **Negative:**
  - Modest additional storage footprint when raw journaling is enabled by the user.
