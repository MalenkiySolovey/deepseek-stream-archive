# Chrome Web Store Privacy Disclosure Worksheet

> **Extension:** DeepSeek StreamArchive  
> **Target Dashboard:** Chrome Web Store Developer Dashboard &rarr; Privacy Tab  
> **Prepared Date:** 2026-11-03  
> **Policy Grounding:** [`PRIVACY.md`](../PRIVACY.md) and [`docs/CHROME_WEB_STORE_COMPLIANCE.md`](./CHROME_WEB_STORE_COMPLIANCE.md)  

This worksheet maps the actual technical behavior of DeepSeek StreamArchive to each required field and declaration within the Chrome Web Store Developer Dashboard.

---

## 1. Single-Purpose Declaration

### Field: "Single Purpose Description"
- **Character Limit:** Recommended concise statement (~1-3 sentences)
- **Recommended Text:**
  > DeepSeek StreamArchive preserves DeepSeek conversations and responses that reach the user's browser, providing local archiving, revision recovery and user-controlled continuity of recovered context.
- **Confidence:** High
- **Supporting Code/Docs:** [`docs/PROJECT_SCOPE.md`](./PROJECT_SCOPE.md), [`docs/CHROME_WEB_STORE_COMPLIANCE.md`](./CHROME_WEB_STORE_COMPLIANCE.md)

---

## 2. Permission Justifications

The Chrome Web Store requires a plain-language explanation for each declared permission:

### 2.1 Permission: `storage`
- **Recommended Justification:**
  > Used exclusively to store user configuration settings (such as UI language, presentation mode, retention policy, and Context Continuity delivery preferences) and active compatibility profiles locally in `chrome.storage.local`.
- **Confidence:** High
- **Supporting Code:** `src/presentation/settings.ts`, `src/context-continuity/settings.ts`, `src/storage/retention/settings.ts`

### 2.2 Permission: `sidePanel`
- **Recommended Justification:**
  > Provides the user-facing Side Panel archive browser interface (`sidepanel.html`), allowing users to search, inspect revision histories, view reasoning traces, and export locally preserved conversations alongside their DeepSeek chat.
- **Confidence:** High
- **Supporting Code:** `entrypoints/sidepanel/`, `wxt.config.ts`

### 2.3 Host Permission: `https://chat.deepseek.com/*`
- **Recommended Justification:**
  > DeepSeek StreamArchive operates exclusively on the official DeepSeek chat web application. This permission is necessary to observe streaming completion responses (`/api/v0/chat/completion`) in real time, reconcile conversation history, and render non-destructive in-page recovery markers via closed Shadow DOM.
- **Confidence:** High
- **Supporting Code:** `wxt.config.ts`, `entrypoints/content.ts`, `entrypoints/interceptor.content.ts`

---

## 3. Data Usage Questionnaire (Category-by-Category)

The Developer Dashboard requires developers to declare whether their extension collects specific categories of user data.

| Data Category | Dashboard Question | Recommended Declaration | Explanation & Code Grounding | Manual Review Confirmation? |
|---|---|:---:|---|:---:|
| **Personally Identifiable Information (PII)** | Does your extension collect name, address, email, phone, etc.? | **NO** | StreamArchive does not collect, extract, or store user identity, email addresses, or personal profiles. | Verified |
| **Health Information** | Does your extension collect health, medical, or genetic data? | **NO** | StreamArchive does not collect health or medical data. | Verified |
| **Financial & Payment Information** | Does your extension collect credit cards, bank accounts, or financial transactions? | **NO** | StreamArchive has no payment processing, subscription tracking, or financial data handling. | Verified |
| **Authentication Information** | Does your extension collect passwords, credentials, tokens, or security keys? | **NO** | Code-level invariant strictly enforces that `Authorization` headers, Bearer tokens, cookies, and login credentials are never extracted or saved. | Verified |
| **Personal Communications** | Does your extension collect emails, text messages, chat logs, or social media posts? | **YES** *(User-generated conversation content)* | **Data Type:** Chat messages and user prompts submitted on `chat.deepseek.com`.<br>**Usage Purpose:** `Functionality` (archiving conversations locally).<br>**Transfer off device?** Stored locally inside extension-origin IndexedDB. Transferred to DeepSeek only if the user explicitly turns ON Context Continuity to restore context in a subsequent prompt.<br>**Sold to third parties?** **NO**.<br>**Used for credit/lending?** **NO**. | Confirmed in `PRIVACY.md` |
| **Location** | Does your extension collect geographic location, GPS, or IP-based location? | **NO** | StreamArchive does not use geolocation APIs or determine user location. | Verified |
| **Web History** | Does your extension collect a list of web pages or URLs visited by the user? | **NO** | StreamArchive runs strictly on `chat.deepseek.com` and never tracks browsing history across the web. | Verified |
| **User Activity** | Does your extension collect clicks, scrolls, mouse positions, or page interactions? | **NO** | StreamArchive does not track user behavior, analytics events, or click heatmaps. In-page observers listen only for message rendering anchors. | Verified |
| **Website Content** | Does your extension collect text, images, sounds, or media from web pages? | **YES** *(AI Assistant Responses & Reasoning)* | **Data Type:** Assistant responses, streaming SSE text fragments, and DeepThink reasoning traces generated by DeepSeek.<br>**Usage Purpose:** `Functionality` (preserving responses before potential filtering or network failure).<br>**Transfer off device?** Stored locally in IndexedDB. Selected context may be delivered back to DeepSeek if Context Continuity is explicitly enabled.<br>**Sold to third parties?** **NO**. | Confirmed in `PRIVACY.md` |

---

## 4. Developer Certifications & Compliance Checkboxes

The Chrome Web Store requires affirmative agreement to three core data handling rules. StreamArchive complies fully with all three:

1. [x] **"I certify that my extension does not sell user data to third parties."**  
   *Justification:* StreamArchive is 100% free, open-source software with zero monetization, commercial partnerships, or data-broker relationships.
2. [x] **"I certify that my extension does not use or transfer user data for purposes unrelated to the extension's core single purpose."**  
   *Justification:* All observed text and metadata are used exclusively for local conversation preservation, recovery, and user-initiated context continuity.
3. [x] **"I certify that my extension does not use or transfer user data to determine creditworthiness or for lending purposes."**  
   *Justification:* StreamArchive has zero involvement with financial, credit, or lending operations.

---

## 5. Public Privacy Policy URL Declaration

- **Required Dashboard Field:** Privacy Policy URL
- **Proposed URL:** `https://github.com/MalenkiySolovey/deepseek-stream-archive/blob/main/PRIVACY.md`
- **Validation:** File is stored directly in the repository root on GitHub's public web domain.
