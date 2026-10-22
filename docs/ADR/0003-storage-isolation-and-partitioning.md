# ADR 0003: Storage Isolation, Partitioning, and Service Worker Persistence

## Status
Accepted

## Context
During our audit of upstream projects, we discovered a severe architectural risk in `logicwahid/deepseek-memory`:
Its `indexeddb-storage.js` was initialized inside the extension's content script. In Chromium browsers, content scripts share the origin of the web page they run on (`https://chat.deepseek.com`). Consequently, the IndexedDB database was created inside the `chat.deepseek.com` origin sandbox. This means:
1. DeepSeek page scripts or malicious scripts on `chat.deepseek.com` could inspect, extract, overwrite, or delete the extension's database.
2. If the user clears site data for DeepSeek, all extension records are wiped without warning.
3. Other extensions running on `chat.deepseek.com` could collide with the database name.

Furthermore, Manifest V3 introduces the ephemeral Service Worker lifecycle: the background worker can terminate after 30 seconds of inactivity. Important state stored in memory global variables will be abruptly lost.

## Decision

### 1. Strict Origin Isolation
- **IndexedDB must NEVER be opened in the content script or page context.**
- The primary database (`StreamArchiveDB`) will exist strictly within the **extension origin** (`chrome-extension://<extension-id>`), managed by the Background Service Worker and accessed by Extension Pages / Side Panel.
- All write requests from content scripts must be transmitted via `chrome.runtime.sendMessage` to the background service worker.

### 2. Dual Storage Partitioning
We partition persistence into two distinct mechanisms based on data characteristics:

| Storage Engine | Execution Realm | Intended Data | Characteristics |
|---|---|---|---|
| **`IndexedDB`** | Extension Origin (Background / Side Panel) | `conversations`, `messages`, `revisions`, `recovery_events`, `raw_events` | ACID transactions, structured queries, large capacity (hundreds of MBs / GBs), indexed searches. |
| **`chrome.storage.local`** | Extension Context | User preferences, active compatibility profile, UI collapse states, retention policies | Fast synchronous-like reading on worker boot, small key-value size (<10MB), cross-context automatic sync via `onChanged`. |

### 3. Service Worker Resilience & Acknowledgement Pipeline
To prevent data loss caused by abrupt service worker termination:
- Streaming batches are buffered in the content script with an incremental sequence ID (`batchSeq`).
- The content script sends a batch to the service worker and awaits an explicit persistence acknowledgement (`ACK`):
  ```text
  Content Script                    Service Worker                   IndexedDB
        │                                 │                              │
        │─── [Batch #42] ────────────────►│                              │
        │    (keeps in memory buffer)     │─── transaction.put() ───────►│
        │                                 │◄── oncomplete ───────────────│
        │◄── [ACK #42] ───────────────────│                              │
        │    (purges from buffer)         │                              │
  ```
- If the service worker is terminated midway through a transaction or fails to respond, the content script's buffer retains the uncommitted batch and retries upon worker wake-up.

## Consequences
- **Positive:**
  - Absolute privacy: Saved chats cannot be read or tampered with by `chat.deepseek.com` JavaScript.
  - Resilience: Zero lost tokens when the browser suspends the MV3 background worker.
  - Performance: IndexedDB transactions run off the main browser thread, keeping page rendering silky smooth.
- **Negative:**
  - Requires asynchronous message passing for every persistence operation.
