# ADR 0026: Optional Inline Recovered Responses in DeepSeek Chat

## Status

Accepted

## Context

In ADR 0018, StreamArchive established a **Non-Destructive In-Page Recovery Overlay** architecture governed by "Zero DOM Mutation Inside Host Nodes". That model safely bypassed React fiber reconciliation hazards by rendering a floating portal on `document.documentElement` with anchored badges and modal cards.

While the overlay portal provides complete DOM isolation and resilience, reading recovered text inside a floating modal card introduces friction when reading conversations linearly. Users requested an optional mode where recovered responses are displayed directly inside the conversation flow in the DeepSeek web interface.

However, naive in-page replacement (e.g., modifying React fiber state, overwriting `innerText`, or injecting Light DOM elements into React components) introduces fatal risks:
1. React fiber crashes on subsequent re-renders or hydration.
2. Desynchronization of virtual DOM trees.
3. Breaking DeepSeek's native action buttons (`Copy`, `Regenerate`, `Like`, `Dislike`, `Read aloud`, `Share`).
4. Potential XSS vulnerabilities if host DOM is manipulated via `innerHTML`.
5. Cross-chat sensitive content leakage during SPA navigation.

## Decision

We introduce an **Optional Inline Recovery Presentation Mode** while preserving ADR 0018's architectural guarantees.

### 1. Dual-Mode User Control
The display mode is user-configurable in Side Panel Settings (`chrome.storage.local`):
- `overlay` (Default): Retains strict ADR 0018 zero host-DOM mutation with anchored badges and modal cards.
- `inline`: Mounts extension-owned closed Shadow DOM hosts directly inside verified message containers.
- `showThinkingInline` (Default: `true`): Renders recovered DeepThink reasoning in a collapsible container.

### 2. Reconciliation with ADR 0018
In `overlay` mode, host DOM mutation remains strictly **zero**.
In `inline` mode, StreamArchive permits inserting exactly **ONE** extension-owned container per message:
```html
<div data-message-id="msg_123">
  <!-- Native placeholder: reversibly hidden with display: none -->
  <div class="ds-markdown" style="display: none;">
    Sorry, that's beyond my current scope.
  </div>

  <!-- Extension-owned closed Shadow DOM host -->
  <div data-streamarchive-inline-recovery-host="msg_123">
    #shadow-root (closed)
      <div class="streamarchive-inline-host-root">
        <div class="streamarchive-inline-header">...</div>
        <details class="streamarchive-inline-thinking">...</details>
        <div class="streamarchive-inline-body">...</div>
        <div class="streamarchive-inline-footer">
          <button class="streamarchive-inline-copy-btn">Copy recovered response</button>
        </div>
      </div>
  </div>

  <!-- DeepSeek native toolbar: 100% untouched in host DOM -->
  <div class="ds-actions-toolbar">
    <button>Copy</button>
    <button>Regenerate</button>
    <button>Like</button>
    <button>Dislike</button>
    <button>Read aloud</button>
    <button>Share</button>
  </div>
</div>
```

### 3. Native Toolbar Preservation
DeepSeek's native action toolbar (`Copy`, `Regenerate`, `Like`, `Dislike`, `Read aloud`, `Share`) is **never** cloned, moved into Shadow DOM, or masked. The inline recovery host is inserted before the native toolbar. All native pointer events, tooltips, and React handlers remain fully functional.

### 4. Pure Safe Markdown DOM Renderer
Zero `innerHTML`, `outerHTML`, or `insertAdjacentHTML`.
Content is parsed into a structured AST via `parseSafeMarkdown()` and rendered into a `DocumentFragment` using direct DOM node creation (`document.createElement`, `document.createTextNode`).

### 5. Idempotent Lifecycle & Reversible Style Restoration
The `InlineRecoveryLedger` maintains singleton handles for each mounted inline host.
When switching back to `overlay` mode, navigating to another chat route (`history.pushState`), or dismissing a message:
1. The extension host element is removed via `removeChild()`.
2. The original `style.display` property of the placeholder is restored immediately.

### 6. Four-Tier Fallback Hierarchy
1. **Level 1 (Body insertion):** Verified message anchor and content placeholder found. Inserts host and hides placeholder.
2. **Level 2 (Adjacent insertion):** Native toolbar found, but placeholder selector unrecognized. Inserts host directly before native toolbar.
3. **Level 3 (Anchored badge):** Unrecognized host structure or closed Shadow DOM attachment failure. Falls back to floating badge.
4. **Level 4 (Floating tray):** Message node virtualized or scrolled out of DOM. Falls back to bottom-right session tray.

## Consequences

- **User Experience:** Recovered responses can be read naturally in place without opening modals or side panels.
- **Security:** Closed Shadow DOM prevents host page stylesheets and scripts from tampering with recovered answers; zero `innerHTML` eliminates XSS vectors.
- **Fail-Closed Stability:** Any unexpected DOM mutation or selector breakdown drops down to non-invasive overlay badges with zero site disruption.
- **Data Integrity:** `DB_VERSION` remains 8; permissions remain `storage` and `sidePanel`.
