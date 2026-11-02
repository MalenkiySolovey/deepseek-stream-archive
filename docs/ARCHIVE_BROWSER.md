# Archive Browser & Side Panel UX Guide

## Overview
The **DeepSeek StreamArchive Browser** provides a local-first, read-only interface inside the Chrome Extension Side Panel. It allows users to view, search, and recover DeepSeek chat sessions without modifying or injecting elements into the DeepSeek web page.

---

## 1. Architecture & Component Hierarchy

```
entrypoints/sidepanel/
├── index.html                  # Side Panel HTML entrypoint
├── main.ts                     # Svelte 5 mount root
├── App.svelte                  # Main tabbed container (Archive, Diagnostics, Settings)
└── components/
    ├── ArchiveBrowser.svelte   # Paginated conversation list with search
    ├── ConversationView.svelte # Thread view, branch switcher, preferred revision, thinking
    ├── DiagnosticsView.svelte  # Foundation, transport, and raw journal diagnostic dashboard
    ├── SafeMarkdown.svelte     # Safe code block & text formatter (zero innerHTML / eval)
    └── i18n.ts                 # Localization dictionary (English & Russian)
```

---

## 2. Key Capabilities

### 2.1 Saved Conversations Navigation
- **Metadata-first Pagination:** Queries `conversations` indexed by `updatedAt` descending with cursor support, retrieving conversation titles and message counts without loading message bodies into memory.
- **Search:** Instant client-side search across titles, local IDs, and server remote IDs.
- **Recovery Badges:** Highlights conversations containing pre-filter preserved responses (`🛡️ Shield badge`).

### 2.2 Thread & Branch Awareness
- **Topological Message Ordering:** Logical conversation turns (`isLogicalMessage()`) are displayed in chronological parent-child order.
- **Branch Switcher:** When genuine logical sibling messages share the same parent (e.g. true regenerate turns), a branch switcher (`Branch X of Y` with `‹` and `›` controls) enables switching between divergent response variations. Empty retry attempts never pollute the branch selector.
- **Unresolved Link Indicators:** Displays warnings if a message references a server remote parent ID that has not yet been resolved locally.

### 2.3 Assistant Message Inspection
- **Separated Thinking Box:** Long reasoning tokens (`thinking_content` / `THINK` fragments) are isolated in a collapsible `<details>` container with character counts.
- **Preferred Revision Selection:** Automatically renders the most authoritative revision (pre-filter last-good for filtered messages, or history/network for finished messages).
- **Revision Timeline Drawer:** Shows every captured revision (`network`, `history`, `replay`, `synthetic`) with timestamps, flags (`Last Good`, `Final`), and size metrics. Users can click any revision to inspect its specific content.
- **Clipboard Integration:** One-click copying of assistant answers and code blocks with visual feedback.

### 2.4 Recovery Preview Card
- For messages terminated by DeepSeek's safety filters (`CONTENT_FILTER` / `status === 'filtered'`), an emerald alert card displays:
  - Preserved pre-filter answer captured before deletion.
  - Character length of the recovered answer.
  - Dedicated "Copy Uncensored Answer" button.

### 2.5 Unmatched Stream Captures View
- Partial streams captured during network interruptions that were superseded by subsequent retry attempts are classified as `unmatched_capture`.
- These are cleanly isolated from the main conversation thread and rendered in a dedicated collapsible "Unmatched Stream Captures" container with stream provenance, captured character count, and copy button. Empty failed attempts (`attempt_only`) are omitted from view.

---

## 3. Security & Safety Invariants

1. **Zero DOM Injection:** The Archive Browser renders entirely within the extension's side panel. It does not inject HTML, styles, or scripts into `https://chat.deepseek.com/*`.
2. **Zero `innerHTML` / Zero `eval`:** Text and code formatting use safe text interpolation in Svelte 5. Code fences and paragraphs are parsed into structured tokens and bound through text nodes.
3. **Local-First Storage:** All queries run against local IndexedDB (`StreamArchiveDB` v8). No external network requests are made.
4. **Strict MV3 Permissions:** Operates strictly within `"storage"` and `"sidePanel"` permissions.
