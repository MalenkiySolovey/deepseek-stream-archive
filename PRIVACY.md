# Privacy Policy for DeepSeek StreamArchive

> **Effective Date:** November 3, 2026  
> **Public URL:** `https://github.com/MalenkiySolovey/deepseek-stream-archive/blob/main/PRIVACY.md`  
> **Version:** 1.0  

DeepSeek StreamArchive ("StreamArchive", "we", "our") is an independent open-source browser extension designed to preserve, recover, and locally archive DeepSeek conversations and responses.

We believe that your conversations, thoughts, and data belong strictly to you. This Privacy Policy transparently explains what data StreamArchive observes, how it is stored, when (and only when) it leaves your device, and the complete controls you have over your data.

---

## 1. Summary of Core Privacy Commitments

- **100% Local-First Storage:** All conversation text, thinking traces, revisions, and raw stream data are stored exclusively on your device inside extension-origin IndexedDB storage.
- **Zero Cloud Servers:** We do not operate any external cloud backend, user accounts, databases, or synchronization servers.
- **Zero Telemetry & Analytics:** We do not track you, collect metrics, inject tracking pixels, or use third-party analytics services.
- **Zero Credential Collection:** We do not collect, read, or persist passwords, authentication tokens, Authorization headers, or cookies.
- **Zero Data Selling:** We never sell, rent, monetize, or disclose your conversation data to advertisers or third parties.
- **User-Controlled Context Continuity:** Selected local context leaves your machine **only** if you explicitly choose to turn on the optional Context Continuity feature to restore context in a subsequent message sent to DeepSeek.

---

## 2. What Data StreamArchive Observes

To perform its archival and recovery function, StreamArchive observes network streaming communication between your browser and the DeepSeek web application (`https://chat.deepseek.com/*`):

1. **Conversation Content:** User prompts and assistant responses generated during your chat sessions.
2. **Stream Fragments & Revisions:** Incremental Server-Sent Events (SSE) data chunks, including chain-of-thought (`thinking`) blocks when DeepThink is enabled.
3. **Identifiers & Topology:** Conversation session IDs (`chat_session_id`), message IDs (`message_id`), and parent links (`parent_id`) necessary to accurately reconstruct conversation branches and message ancestry.
4. **History Payloads:** Passively observed responses from `/api/v0/chat/history_messages` to reconcile streaming drafts with authoritative server history.

*Boundary statement:* StreamArchive can only observe data that reaches your browser client. Content filtered, truncated, or terminated by DeepSeek's servers prior to transmission cannot be observed or captured.

---

## 3. What Data Is NOT Collected

StreamArchive strictly enforces code-level guards ensuring that sensitive authentication and personal data are never inspected or stored:
- ❌ **Authentication Credentials:** Passwords, login tokens, Bearer tokens, and `Authorization` headers.
- ❌ **Browser Cookies:** Session cookies, tracking cookies, or local authentication cookies.
- ❌ **Personal Identity:** Account email addresses, phone numbers, payment details, or subscription tiers.
- ❌ **Browsing History Outside DeepSeek:** StreamArchive has zero permissions to observe or interact with any web page other than `https://chat.deepseek.com/*`.

---

## 4. Where Your Data Is Stored

All captured data is stored locally within your browser in an isolated extension sandbox:
- **IndexedDB (`StreamArchiveDB`):** Located at the extension's unique origin (`chrome-extension://<id>`). Web pages (including `chat.deepseek.com`) and third-party scripts have zero access to this storage.
- **`chrome.storage.local`:** Used exclusively for user configuration preferences (such as language, presentation mode, retention duration, and Context Continuity settings).

No data stored by StreamArchive is ever transmitted to any server operated by StreamArchive.

---

## 5. When Data Leaves Your Device (Context Continuity)

By default, data stored in StreamArchive **never** leaves your local device. 

The only exception occurs when you explicitly enable the optional **Context Continuity** feature:

### 5.1 What Context Continuity Does
When a DeepSeek assistant response is interrupted or filtered, it may be absent from DeepSeek's server-side memory for subsequent turns. Context Continuity allows you to inject locally preserved text into your next prompt so DeepSeek can continue the conversation with full context.

### 5.2 Privacy Safeguards for Context Continuity
- **Strictly OFF by Default:** Context Continuity is disabled by default (`enabled: false`).
- **Safe Delivery Default (`manual_next`):** In the default manual mode, context is armed only for a single message upon your explicit click (`⚡ Use continuity for next message`). It automatically disarms immediately after the message is sent.
- **Transparent Preview:** You can inspect the exact text, character count, and exclusion details before any context is delivered.
- **Direct Transmission to DeepSeek:** When augmented, the selected text is sent directly to DeepSeek's servers (`https://chat.deepseek.com/api/v0/chat/completion`) as part of the prompt you submit. StreamArchive does not route this request through any intermediary or proxy.
- **Governed by DeepSeek's Terms:** Any data transmitted to DeepSeek via Context Continuity is subject to DeepSeek's own Privacy Policy and Terms of Service.

---

## 6. Data Portability, Backups & Export

You have full ownership of your data:
- **Human Export:** You can export individual conversation threads to clean Markdown (`.md`) or structured JSON (`.json`) files saved directly to your local file system.
- **Portable Backups:** You can generate compressed full-archive backups (`.streamarchive.jsonl.gz`) to back up or migrate your entire archive.
- **Atomic Restore:** Imported backups are validated locally and committed in a single atomic database transaction.

Exports and backups are processed entirely inside your browser using client-side JavaScript and native compression streams without third-party libraries.

---

## 7. Data Retention & Deletion Controls

StreamArchive provides multiple user-controlled mechanisms to manage and delete your data:

1. **Single Conversation Deletion:** In the Side Panel, you can preview and permanently delete any individual conversation thread. This cascades across all messages, revisions, and raw stream records in that thread.
2. **Raw Evidence Retention Policy:** You can configure automatic age-based cleanup of raw HTTP transport chunks (options: Forever, 30 days, 90 days, 180 days). Cleaned raw chunks are pruned while your readable conversation history is preserved.
3. **Delete All Local Archive Data ("Clear Archive"):** A two-step confirmed action in Settings that completely wipes all records across all nine IndexedDB stores, resetting your local database to an empty state.
4. **Browser Extension Removal:** Uninstalling the StreamArchive extension from `chrome://extensions/` prompts the Chromium browser to permanently purge all extension-origin storage (including `StreamArchiveDB` and `chrome.storage.local`).

*Note on Server-Side Data:* Deleting data within StreamArchive affects only your local browser archive. It does not alter, delete, or affect conversation records stored on DeepSeek's own servers.

---

## 8. Permissions & Justification

StreamArchive requests only the minimal permissions necessary under Chromium Manifest V3:

| Permission | Technical Purpose |
|---|---|
| `storage` | Storing local user settings and UI preferences in `chrome.storage.local`. |
| `sidePanel` | Displaying the native Side Panel archive browser alongside your chats. |
| `https://chat.deepseek.com/*` | Observing generation streams and rendering non-destructive recovery markers on the DeepSeek web app. |

StreamArchive does **not** request `<all_urls>`, `tabs`, `cookies`, `webRequest`, `downloads`, `history`, or `scripting`.

---

## 9. Security Architecture

- **Closed Shadow DOM:** In-page recovery elements and user turn presentations render inside closed Shadow DOM roots (`#shadow-root (closed)`), preventing page scripts from inspecting or accessing recovered text.
- **No Remote-Hosted Code:** 100% of the extension's JavaScript and CSS is contained within the signed extension package. Zero remote scripts or dynamic code evaluations (`eval`, `new Function`) are used.
- **Fail-Open Design:** If any unexpected error or schema mismatch occurs, StreamArchive fails open safely, ensuring normal page interaction and user requests proceed completely unaffected.

---

## 10. Contact & Vulnerability Reporting

StreamArchive is maintained as an open-source community project. If you have questions regarding this Privacy Policy, or if you wish to report a security or privacy concern, please consult our [Security Policy](./SECURITY.md) or open an issue on GitHub:

- **Repository:** `https://github.com/MalenkiySolovey/deepseek-stream-archive`
- **Issue Tracker:** `https://github.com/MalenkiySolovey/deepseek-stream-archive/issues`

---

## 11. Changes to This Policy

If we update this Privacy Policy to reflect changes in our practices or extension capabilities, the updated policy will be committed directly to this repository with a revised effective date. Material changes will be highlighted in the project's [CHANGELOG.md](./CHANGELOG.md).
