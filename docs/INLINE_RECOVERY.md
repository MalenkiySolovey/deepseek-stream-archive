# Inline Recovery Presentation Architecture

## 1. Overview

StreamArchive provides **Inline Recovered Responses** in DeepSeek Chat as an optional user-facing mode (`RecoveryDisplayMode: 'overlay' | 'inline'`).

When enabled in Side Panel Settings, locally preserved answers (rescued prior to DeepSeek content filtering or network interruptions) are rendered directly inside the assistant message block in the chat interface, eliminating the need to read recovered text in floating modals.

```text
┌────────────────────────────────────────────────────────────────────────┐
│ DeepSeek Conversation Container                                        │
│                                                                        │
│ ┌────────────────────────────────────────────────────────────────────┐ │
│ │ <div data-message-id="msg_001"> (Host Message Node)                │ │
│ │                                                                    │ │
│ │   [Native Placeholder: style="display: none"]                      │ │
│ │   "I'm sorry, I cannot continue this conversation."                │ │
│ │                                                                    │ │
│ │   <div data-streamarchive-inline-recovery-host="msg_001">          │ │
│ │   ┌─ #shadow-root (closed) ──────────────────────────────────────┐ │ │
│ │   │ 🛡️ Recovered locally before DeepSeek filter                  │ │
│ │   │ ▶ 🧠 DeepThink — recovered locally (1,420 chars)             │ │
│ │   │                                                              │ │
│ │   │ Response body rendered via SafeMarkdown (pure DOM fragment)  │ │
│ │   │                                                              │ │
│ │   │ [Copy recovered response] (Extension-owned button)           │ │
│ │   └──────────────────────────────────────────────────────────────┘ │ │
│ │                                                                    │ │
│ │   <div class="ds-actions-toolbar"> (Native Host Toolbar)           │ │
│ │     [Copy] [Regenerate] [Like] [Dislike] [Read aloud] [Share]      │ │
│ │   </div>                                                           │ │
│ └────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Native Action Toolbar Compatibility Matrix

A critical design requirement is **Zero Host Toolbar Tampering**. DeepSeek's native action toolbar is never cloned, simulated, or covered.

| DeepSeek Action | Location | Behavior in Inline Mode | Compatibility Guarantee |
|:---|:---|:---|:---|
| **Copy** | DeepSeek Host DOM | Copies whatever DeepSeek server sent (e.g. refusal placeholder or error). | **Preserved:** Native event listeners and clipboard access operate unmodified. |
| **Regenerate** | DeepSeek Host DOM | Triggers a new generation request from DeepSeek's frontend. | **Preserved:** Full React onClick and dispatch handlers fire normally. |
| **Like / Dislike** | DeepSeek Host DOM | Submits user feedback rating to DeepSeek servers. | **Preserved:** Unchanged. |
| **Read aloud** | DeepSeek Host DOM | Activates DeepSeek's text-to-speech engine. | **Preserved:** Reads native text without error. |
| **Share** | DeepSeek Host DOM | Opens DeepSeek share link / export modal. | **Preserved:** Functions identically to standard chats. |
| **Copy Recovered Response** | Extension Closed Shadow DOM | Copies the **uncensored locally preserved response** directly to clipboard. | **Extension-Owned:** Clear visual separation prevents user confusion between server response and recovered archive. |

---

## 3. Four-Tier Placement & Fallback Hierarchy

To ensure 100% fail-open reliability across web app updates, StreamArchive employs a 4-tier structural locator:

```text
Level 1: Body Replacement (Highest Confidence)
  └─ Verified message anchor + recognized content placeholder (.ds-markdown)
  └─ Reversibly sets placeholder style.display = 'none'
  └─ Inserts inline recovery host before placeholder.nextSibling

Level 2: Adjacent Insertion (Medium Confidence)
  └─ Verified message anchor + recognized action toolbar (.ds-actions-toolbar)
  └─ Inserts inline recovery host directly before the toolbar

Level 3: Anchored Badge (Fallback)
  └─ Anchor found, but neither placeholder nor toolbar identifiable, or closed ShadowRoot attachment fails
  └─ Renders non-invasive floating badge above node coordinates

Level 4: Floating Recovery Tray (Universal Fallback)
  └─ Message node virtualized out of DOM, scrolled away, or obscured
  └─ Accessible in floating session tray at bottom-right of viewport
```

---

## 4. Reversible Lifecycle & SPA Isolation

1. **Setting Changes (`overlay` ↔ `inline`):**
   Switching modes immediately calls `inlineLedger.unmountAll()`. All extension hosts are removed via `removeChild()`, and the original `style.display` of suppressed placeholders is cleanly restored.
2. **SPA Navigation (`pushState` / `popstate`):**
   Pre-navigation revocation (`preRevokeRouteState`) executes synchronously before the new route summary is fetched. Inline recovery hosts from the previous conversation are stripped immediately, preventing sensitive cross-chat leakage.
3. **Virtualized DOM Reconnection:**
   When scrolling long conversations, DeepSeek unmounts and remounts message nodes. The `MutationObserver` detects reconnected nodes and idempotently remounts the inline recovery host without duplicates.

---

## 5. Security & Trust Boundaries

- **Closed Shadow DOM:**
  The inline host uses `{ mode: 'closed' }`. Host page scripts cannot inspect or access shadow elements via `document.querySelector` or `.shadowRoot`.
- **Zero `innerHTML`:**
  All markdown headers, paragraphs, lists, and code blocks are tokenized into an AST and instantiated via `document.createElement()` and `document.createTextNode()`.
- **Identity Gating:**
  Inline recovery is strictly gated on strong `data-message-id` attributes matching verified `RecoveryEvent` records in IndexedDB. Generic refusal text on the page is never used as an authority for injection.

---

## 6. Live Compatibility Verification

The inline recovery architecture was verified against live production DeepSeek chat:
- Real-browser live acceptance report: [`docs/LIVE_INLINE_RECOVERY_RESULTS_2026-11-03.md`](./LIVE_INLINE_RECOVERY_RESULTS_2026-11-03.md).
- Status: **`PASS`** across Level 1 DOM insertion, React virtualization scrolling, client-side SPA route isolation, native toolbar non-tampering, and native `Regenerate` branching.

---

## 7. Interaction with Context Continuity

When Context Continuity is enabled in Settings:
- An optional subtle status indicator (`.streamarchive-inline-continuity-pill`) can be displayed inside the inline recovery host header to inform the user that the recovered response is active in the continuity plan.
- **Zero Request Mutation Invariant:** Even with both Inline Recovery and Context Continuity enabled, StreamArchive modifies **zero** outgoing requests, keeping passive capture and browser safety 100% intact.
- For full continuity details, see [CONTEXT_CONTINUITY.md](./CONTEXT_CONTINUITY.md).
