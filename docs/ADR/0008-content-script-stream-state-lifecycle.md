# ADR 0008: Content Script Stream State Lifecycle (MV3 Service Worker Ephemerality)

## Status
Accepted

## Context
Under Manifest V3 (MV3), Chrome extension Background scripts run as Service Workers. Chrome aggressively terminates idle Service Workers (typically within 30 seconds of inactivity).

In the streaming architecture, the Background Service Worker maintained an in-memory `Map<string, GenericSseDecoder>` to parse incoming text chunks forwarded from the content script. This introduced architectural fragility:
1. Long DeepSeek reasoning generations often experience pauses between tokens (or network stalls) that can cause the Service Worker to be stopped mid-stream.
2. If the Service Worker restarts, any buffered partial lines, active SSE state, or patch accumulator state in memory is wiped out, resulting in broken streams or lost tokens.
3. Sending every raw text chunk across `chrome.runtime.sendMessage` creates IPC chatter and potential race conditions during Service Worker wake-up.

## Decision
We moved all stateful stream decoding (`GenericSseDecoder`, `DeepSeekProtocolDecoder`, and partial chunk buffers) out of the Background Service Worker and into the **ISOLATED content script**:

1. **Page-Aligned Lifetime:** The ISOLATED content script exists for the exact duration of the page tab session. Its lifecycle naturally mirrors the native fetch and XMLHttpRequest connections created by the page.
2. **Stateless Background:** The Background Service Worker does not maintain any stream decoding state. It only receives higher-level semantic batches (`ForwardSemanticBatchRequest`) containing parsed domain events for transient diagnostic tracking.
3. **Fail-Open Resilience:** Even if the Background Service Worker is asleep when a chunk arrives, the content script's buffer continues to parse uninterrupted. When the Service Worker wakes, it receives aggregated semantic events without missing a byte.

## Consequences

### Positive
- **Zero Token Loss from SW Sleep:** Service Worker restarts can no longer corrupt or sever in-flight stream parsing.
- **Reduced IPC Overhead:** Instead of forwarding arbitrary raw chunks across `chrome.runtime.sendMessage`, the content script batches semantic events and forwards structured summaries.
- **Natural Resource Reclamation:** When the user closes or navigates the tab, all associated stream decoders and buffers in the content script are automatically garbage collected by the browser engine.

### Negative / Trade-offs
- Multiple tabs running concurrent DeepSeek streams maintain separate decoder instances in their respective content scripts (which is actually desirable for memory isolation).
- Background Service Worker diagnostics only reflect data received from currently active content scripts.
