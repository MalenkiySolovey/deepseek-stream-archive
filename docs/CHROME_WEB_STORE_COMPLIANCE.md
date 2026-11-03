# Chrome Web Store Policy Compliance & Regulatory Audit

> **Target:** Chrome Web Store Developer Program Policies & Best Practices  
> **Extension:** DeepSeek StreamArchive (`0.1.0`)  
> **Manifest Version:** Manifest V3 (`chrome-mv3`)  
> **Audited Date:** 2026-11-03  

---

## 1. Official Documentation & Regulatory Authority

This compliance document is grounded in current official guidelines from Google Chrome Web Store and WXT extension engineering standards:

1. **Chrome Web Store Program Policies:**  
   [https://developer.chrome.com/docs/webstore/program-policies/](https://developer.chrome.com/docs/webstore/program-policies/)
2. **Single-Purpose Policy:**  
   [https://developer.chrome.com/docs/webstore/single-purpose/](https://developer.chrome.com/docs/webstore/single-purpose/)
3. **User Data FAQ & Privacy Disclosures:**  
   [https://developer.chrome.com/docs/webstore/user-data/](https://developer.chrome.com/docs/webstore/user-data/)
4. **Chrome Web Store Review Process & Requirements:**  
   [https://developer.chrome.com/docs/webstore/review-process/](https://developer.chrome.com/docs/webstore/review-process/)
5. **Manifest V3 Remote Code Execution Restrictions:**  
   [https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code](https://developer.chrome.com/docs/extensions/develop/migrate/remote-hosted-code)
6. **Chrome Web Store API v2 (Publishing Automation):**  
   [https://developer.chrome.com/docs/webstore/using-webstore-api/](https://developer.chrome.com/docs/webstore/using-webstore-api/)
7. **WXT Publishing & Packaging Standards:**  
   [https://wxt.dev/guide/essentials/publishing.html](https://wxt.dev/guide/essentials/publishing.html)

---

## 2. Single-Purpose Definition & Scope Alignment

### 2.1 Authoritative Purpose Statement
> **"DeepSeek StreamArchive preserves DeepSeek conversations and responses that reach the user's browser, providing local archiving, revision recovery and user-controlled continuity of recovered context."**

### 2.2 Feature Mapping to Single Purpose
Under the Chrome Web Store Single-Purpose Policy, an extension must have a single clear purpose with all components contributing directly to that purpose. StreamArchive satisfies this strictly:

| Component | Role in Fulfilling Single Purpose | Single-Purpose Justification |
|---|---|---|
| **Stream Interception (`fetch`/`XHR`)** | Captures response tokens in real-time as they reach the browser | Primary capture mechanism for responses that would otherwise be lost on network drops or post-stream redactions. |
| **Protocol Decoders & Anti-Recall** | Distinguishes normal streaming from interruptions and content filters | Prevents loss of generated drafts and preserves "last-good" response revisions before UI replacements. |
| **Extension-Origin IndexedDB (`StreamArchiveDB`)** | Durably stores conversations, revisions, and raw streams locally | Provides long-term persistence without relying on ephemeral page memory or external servers. |
| **History Reconciliation** | Resolves stable server IDs with provisional streaming records | Ensures local archive matches canonical conversation topology and prevents duplicate records. |
| **Side Panel Archive Browser** | Enables browsing, searching, and inspecting locally preserved chats | Native Chrome user interface to access the locally archived conversations and response revisions. |
| **In-Page Presentation (Overlay & Inline)** | Renders locally preserved revisions in the chat interface | Allows the user to read rescued responses directly within the context of their active discussion. |
| **Human Export & Portable Backup** | Exports to Markdown/JSON and creates compressed backup archives | Guarantees user data portability and disaster recovery for their local archive. |
| **Storage Observability & Retention** | Monitors local quota and manages raw transport stream lifecycle | Protects browser storage from exhaustion while indefinitely shielding preserved conversation evidence. |
| **Context Continuity (Planner & Delivery)** | Augments subsequent prompts with locally preserved context | Restores conversational continuity when earlier assistant answers were lost or omitted from server history. |
| **Runtime Diagnostics** | Verifies decoder health and protocol frame integrity | Ensures the archival capture engine functions accurately against live page structures. |

StreamArchive is **not** a generic "DeepSeek enhancement suite" or "customization tool". Every feature serves the singular purpose of local response preservation, recovery, and continuity.

---

## 3. Store-Facing Terminology & Neutral Branding

To comply with store quality guidelines, intellectual property policies, and avoid deceptive or sensationalist marketing:

### 3.1 Prohibited Marketing Terms
The following terms are strictly forbidden in all store listings, documentation, and user interfaces:
- ❌ `bypass censorship`
- ❌ `uncensor DeepSeek`
- ❌ `disable safeguards`
- ❌ `hack DeepSeek`
- ❌ `evade filters`
- ❌ `jailbreak`

### 3.2 Approved Neutral Terminology
All public-facing communications strictly use objective technical descriptions:
- ✅ `response preservation`
- ✅ `revision recovery`
- ✅ `local archive`
- ✅ `recovered response`
- ✅ `context continuity`
- ✅ `locally preserved content`
- ✅ `pre-filter recovery` (factual technical description of event timing)

*Note:* In accordance with the cause-equivalence architectural invariant, `content_filter` remains a valid forensic recovery cause internally, treated identically to `network_interruption` and `user_stop`.

---

## 4. Independent Project & Trademark Disclosures

To prevent user confusion and comply with trademark policies, the following disclosure is prominently displayed in the store listing, `README.md`, and `README_RU.md`:

> **English:**  
> *"DeepSeek StreamArchive is an independent community project and is not affiliated with or endorsed by DeepSeek."*

> **Russian:**  
> *"DeepSeek StreamArchive — независимый проект сообщества, не связанный с компанией DeepSeek и не одобренный ею."*

---

## 5. Permissions Policy & Principle of Least Privilege

StreamArchive adheres to the Chrome Web Store Principle of Least Privilege, requesting only the absolute minimum permissions necessary for its stated single purpose:

### 5.1 Declared Manifest Permissions
1. **`storage`:**
   - *Justification:* Used exclusively to store local user settings (`enabled`, `deliveryMode`, `includeThinking`, `displayMode`), compatibility profile metadata, and UI preferences via `chrome.storage.local`.
2. **`sidePanel`:**
   - *Justification:* Used to host the native Side Panel interface (`sidepanel.html`), providing users a dedicated workspace to search, inspect, and export their local conversation archive without obstructing the main page.

### 5.2 Declared Host Permissions
- **`https://chat.deepseek.com/*`:**
  - *Justification:* Strictly scoped to the official DeepSeek chat web application. StreamArchive only executes content scripts on this origin to observe stream responses and render recovery markers.

### 5.3 Forbidden Permissions (Strictly Absent)
StreamArchive explicitly avoids broad, intrusive, or high-risk permissions:
- ❌ `<all_urls>` / broad wildcards
- ❌ `tabs` / `activeTab`
- ❌ `cookies`
- ❌ `webRequest` / `webRequestBlocking`
- ❌ `declarativeNetRequest`
- ❌ `downloads` (native DOM Blob downloads used instead)
- ❌ `scripting`
- ❌ `history`
- ❌ `debugger`

---

## 6. Remote-Hosted Code Compliance (Manifest V3 Strictness)

Chrome Web Store policy strictly prohibits extensions from executing remotely hosted code (scripts, WebAssembly, or stylesheets):

1. **Self-Contained Bundle:** All JavaScript (`background.js`, `content.js`, `interceptor.js`, `sidepanel.js`), CSS, and HTML assets are compiled statically by WXT/Vite and contained entirely within the extension package (`.output/chrome-mv3`).
2. **Zero Remote Scripts:** No `<script src="https://...">` or dynamic `import("https://...")` statements exist in the codebase.
3. **Zero Dynamic Code Evaluation:** Codebase contains zero instances of `eval()`, `new Function()`, or dynamic code generation.
4. **Zero Remote WebAssembly:** No remote WASM modules are fetched or instantiated.
5. **DOM Sanitization:** In-page rendering utilizes token-based safe DOM construction (`document.createElement`, `textContent`) with **zero `innerHTML`**, **zero `outerHTML`**, and **zero `insertAdjacentHTML`**.

---

## 7. Privacy Disclosures & User Data Protection

1. **Local-First Storage:** All conversation text, thinking traces, and revisions are stored inside extension-origin IndexedDB (`chrome-extension://<id>`). The web page origin (`chat.deepseek.com`) cannot access or query this database.
2. **Zero Telemetry & Analytics:** StreamArchive operates zero analytics, tracking scripts, or error logging servers. No network requests are made to StreamArchive-owned servers.
3. **No Credential Harvesting:** StreamArchive never accesses, stores, or logs passwords, session cookies, Bearer tokens, or Authorization headers.
4. **Context Continuity Explicit Disclosure:**
   - Feature defaults to `OFF` (`enabled: false`).
   - Default delivery mode is `manual_next` (requires explicit single-use user click).
   - Clear disclosure in Settings UI and Privacy Policy that enabling Context Continuity transmits selected recovered context to DeepSeek as part of subsequent model prompts.
5. **User-Controlled Data Deletion:** Complete support for deleting individual conversations, clearing raw transport evidence, or wiping the entire local archive in a single atomic transaction.

---

## 8. Chrome Web Store Asset & Listing Requirements

| Asset Type | Requirement / Specification | Status in StreamArchive |
|---|---|---|
| **Extension Icon** | 128x128 PNG (transparent background or rounded tile) | Verified (`public/icons/icon-128.png`) |
| **Toolbar Icons** | 16x16, 32x32, 48x48 PNG | Verified (`public/icons/`) |
| **Store Screenshots** | 1280x800 PNG/JPEG (1 to 5 screenshots, neutral data) | Documented in `docs/STORE_ASSETS.md` |
| **Small Promo Tile** | 440x280 PNG (optional/recommended) | Documented in `docs/STORE_ASSETS.md` |
| **Marquee Promo Tile** | 1400x560 PNG (optional) | Documented in `docs/STORE_ASSETS.md` |
| **Short Description** | Up to 132 characters plainly describing purpose | Formulated in `docs/CHROME_WEB_STORE_LISTING.md` |
| **Detailed Description** | Clear overview, features, limitations, and disclosures | Formulated in `docs/CHROME_WEB_STORE_LISTING.md` |
| **Privacy Policy URL** | Publicly accessible URL on stable domain | Proposed: GitHub repository `PRIVACY.md` |
| **Single-Purpose Justification** | Plain text justification for reviewer | Documented in Section 2.1 |

---

## 9. Automated Submission Readiness (Chrome Web Store API v2)

Future CI/CD automation can utilize `wxt submit` with Chrome Web Store API v2:
- **API Version:** Chrome Web Store API v2 (API v1.1 is deprecated).
- **Tooling:** Native WXT submission CLI (`wxt submit --dry-run`).
- **Initial Submission Constraint:** The first public release must be created manually in the Chrome Web Store Developer Dashboard. Automated API updates apply to subsequent versions once the item ID is established.
