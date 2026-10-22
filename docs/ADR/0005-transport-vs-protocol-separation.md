# ADR 0005: Strict Boundary Between Transport and Protocol Adapters

## Status
Accepted

## Context
Upstream projects like `CATIOR` and `G-124` intertwine raw HTTP handling, SSE text splitting, DeepSeek-specific JSON parsing, filter detection, and DOM mutation in a single monolithic script.

If DeepSeek changes its SSE JSON structure from `{"p": "response/fragments/-1/content"}` to a flat array or top-level string, the entire interception and storage code in those scripts fails simultaneously. Conversely, if DeepSeek moves from `fetch` to `WebSocket`, their transport hooks are completely broken.

StreamArchive requires an architecture where:
- Changing the network transport does not touch protocol decoding.
- Changing DeepSeek's JSON schema does not break the generic SSE stream parser.
- Changing DeepSeek's internal statuses does not break persistence or the UI.

## Decision
We enforce a strict four-layer separation of concerns:

```text
Layer 1: Generic Transport (transport/)
           - Observes HTTP fetch, XHR, and SSE line framing.
           - Emits raw text lines / generic event records.
           - Has ZERO knowledge of DeepSeek, "CONTENT_FILTER", or "message_id".
           ▼
Layer 2: Protocol Decoder (adapters/deepseek/protocol/)
           - Consumes generic SSE events.
           - Understands DeepSeek patch semantics: "p", "o", "v", "BATCH", "-1".
           - Translates patches into intermediate protocol observations.
           ▼
Layer 3: Platform Adapter (adapters/deepseek/)
           - Reconciles streaming observations, history API payloads, and DOM fallbacks.
           - Translates vendor-specific shapes into canonical domain events.
           ▼
Layer 4: Canonical Core (core/)
           - Receives canonical domain events (MessageUpdated, StreamAborted, RevisionSaved).
           - Manages revision lifecycle, IndexedDB persistence, recovery detection, and UI.
```

### Future Transport Readiness (WebSocket)
We explicitly decouple the transport layer to allow a future `WebSocketTransport` module without redesigning the core. However, **we strictly refrain from writing premature WebSocket implementation code** until DeepSeek actually deploys WebSockets.

## Invariant Rules
1. `src/transport/` MUST NOT contain the strings `CONTENT_FILTER`, `TEMPLATE_RESPONSE`, `deepseek`, or `chat_session_id`.
2. `src/core/` and `src/ui/` MUST NOT parse raw SSE text, inspect DeepSeek JSON structures, or reference DeepSeek CSS class names.
3. Volatile DeepSeek knowledge is quarantined inside `src/adapters/deepseek/`.

## Consequences
- **Positive:**
  - Extreme resilience: When DeepSeek alters their SSE formatting, only a tiny protocol decoder module needs updating.
  - High testability: Generic SSE parsers and DeepSeek protocol decoders can be unit-tested in complete isolation with deterministic static fixtures.
- **Negative:**
  - Modest code indirection compared to writing a single quick-and-dirty monkey-patch script.
