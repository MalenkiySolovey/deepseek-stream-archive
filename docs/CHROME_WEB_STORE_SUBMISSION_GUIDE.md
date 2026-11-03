# Chrome Web Store Manual Submission Guide (v0.1.0)

This guide provides the exact step-by-step procedure for manually creating the initial item and submitting **DeepSeek StreamArchive** via the Chrome Web Store Developer Dashboard.

> [!IMPORTANT]
> The initial submission of a new extension must be performed manually through Google's web interface. Chrome Web Store API automation (API v2) can only be configured for subsequent version updates after the item ID has been established.

---

## 1. Developer Account Prerequisites (One-Time)

Before creating the listing, ensure your Google account fulfills Google's publisher criteria:

1. **Google Account 2-Step Verification**:
   - 2-Step Verification is mandatory for all Chrome Web Store developers.
   - Verify it is enabled in your [Google Account Security Settings](https://myaccount.google.com/security).
2. **Developer Account Registration**:
   - Navigate to the [Chrome Web Store Developer Console](https://chrome.google.com/webstore/devconsole).
   - Accept the Developer Agreement and pay the one-time $5 USD registration fee if not previously registered.
3. **Developer Contact Email**:
   - Provide a verified developer contact email in the Account settings.

---

## 2. Uploading the Release Package

1. In the [Developer Dashboard](https://chrome.google.com/webstore/devconsole), click **Add new item** (top-right).
2. Drag and drop or browse to select the verified release candidate package:
   ```text
   C:\Users\Malenkiy_Solovey\Desktop\Codex\DeepSeek StreamArchive\workbench\.output\deepseek-stream-archive-0.1.0-chrome.zip
   ```
   *(Or the identical copy in `release-test\chrome-extension\`)*.
3. Verify the upload completes with zero package errors.
4. Confirm the dashboard displays:
   - **Extension Name**: `DeepSeek StreamArchive`
   - **Version**: `0.1.0`
   - **Manifest Version**: `3`
   - **Permissions**: `storage`, `sidePanel`
   - **Host Permissions**: `https://chat.deepseek.com/*`

---

## 3. Completing the Store Listing Tab

Reference document: [`docs/CHROME_WEB_STORE_LISTING.md`](./CHROME_WEB_STORE_LISTING.md)

### 3.1 Metadata & Descriptions
- **Product Name**: `DeepSeek StreamArchive`
- **Summary (Short Description)** (English):
  ```text
  Local-first response archiver, revision recorder, and recovery layer for DeepSeek.
  ```
  *(74 characters / 132 character limit)*
- **Detailed Description** (English):
  - Copy and paste the complete Markdown/plain-text description from Section 1.2 of [`docs/CHROME_WEB_STORE_LISTING.md`](./CHROME_WEB_STORE_LISTING.md).
- **Category**: Select **Productivity**.
- **Language**: Select **English** (Default). Add **Russian** localization in the *Add translation* section using the Russian copy from Section 2 of `docs/CHROME_WEB_STORE_LISTING.md`.

### 3.2 Visual Store Assets
Reference document: [`docs/STORE_ASSET_STAGING_0.1.0.md`](./STORE_ASSET_STAGING_0.1.0.md)

- **Store Icon**:
  - Upload `workbench/public/icons/icon-128.png` (128×128 PNG).
- **Screenshots (1280×800 PNG)**:
  Upload the 5 staged screenshots located in `release-test\screenshots\`:
  1. `01-archive-browser-1280x800.png` — *Archive Browser & Local Conversation Tree*
  2. `02-inline-recovery-1280x800.png` — *In-Page Inline Recovered Response*
  3. `03-revision-history-1280x800.png` — *Revision Timeline & Multi-Version Preservation*
  4. `04-context-continuity-preview-1280x800.png` — *Context Continuity Planner & Transparent Preview*
  5. `05-privacy-settings-1280x800.png` — *Privacy & Local Storage Retention Controls*
- **Promotional Tiles**:
  - Small tile (440×280) and Marquee (1400×560) are **optional** for initial publication. Leave blank if not preparing custom marketing artwork.

### 3.3 Links & Contact
- **Homepage URL**: `https://github.com/MalenkiySolovey/deepseek-stream-archive`
- **Support URL**: `https://github.com/MalenkiySolovey/deepseek-stream-archive/issues`

---

## 4. Completing the Privacy Tab

Reference document: [`docs/CHROME_WEB_STORE_PRIVACY_DISCLOSURES.md`](./CHROME_WEB_STORE_PRIVACY_DISCLOSURES.md)

1. **Single Purpose Description**:
   ```text
   Preserve and recover DeepSeek conversations and responses locally as they reach the browser, providing a private on-device archive, revision history, and optional user-controlled context continuity.
   ```
2. **Permission Justifications**:
   - **`storage`**:
     ```text
     Used to store extension user preferences, UI settings, retention policies, and context continuity configurations locally in chrome.storage.local. The primary conversation archive uses on-device IndexedDB.
     ```
   - **`sidePanel`**:
     ```text
     Used to display the local conversation archive browser, search interface, revision history timeline, and recovery inspector alongside DeepSeek in Chrome's native side panel.
     ```
   - **Host Permission (`https://chat.deepseek.com/*`)**:
     ```text
     Used to observe incoming Server-Sent Events (SSE) streaming responses from chat.deepseek.com in real time, preserve pre-filter response revisions, and render non-destructive in-page recovery UI via closed Shadow DOM.
     ```
3. **Data Usage Questionnaire**:
   - **User Data Collection**: Check **NO** for all categories (Zero personal data, Zero authentication credentials, Zero health data, Zero financial data, Zero web history).
   - **User Content**: If asked about website content or user communications, disclose that response text from `chat.deepseek.com` is processed and stored **100% locally in the user's browser (IndexedDB)**.
   - **Context Continuity Disclosure**: Clarify that when the user explicitly enables the optional Context Continuity feature, selected locally stored text is prepended to the user's next prompt sent to DeepSeek.
4. **Limited Use Compliance**:
   - Check the certification confirming compliance with the Chrome Web Store Developer Program Policies regarding Limited Use (no selling data, no advertising, no credit scoring).
5. **Privacy Policy Link**:
   ```text
   https://github.com/MalenkiySolovey/deepseek-stream-archive/blob/main/PRIVACY.md
   ```

---

## 5. Reviewer Notes & Test Instructions

Paste the following verbatim into the **Notes for Reviewer** field:

```text
DeepSeek StreamArchive is an open-source, local-first browser extension for chat.deepseek.com.
Source code: https://github.com/MalenkiySolovey/deepseek-stream-archive

How to test:
1. Navigate to https://chat.deepseek.com (user sign-in on DeepSeek is required to use the chat service).
2. Submit any standard prompt (e.g. "Explain the difference between TCP and UDP").
3. Click the extension icon in the Chrome toolbar to open the StreamArchive Side Panel.
4. Observe that the prompt and streamed response are preserved locally in the Side Panel archive with turn details.
5. Search, export (Markdown / JSON), and backup (.streamarchive.jsonl.gz) functions operate completely offline.
6. Context Continuity is OFF by default. It can be reviewed in the Settings tab.

Technical architecture:
- Zero remote code: 100% of extension logic is packaged statically in the ZIP.
- Zero innerHTML / eval: In-page recovery elements and markdown rendering use safe DOM APIs.
- Zero credentials: The extension does not read document.cookie, authorization tokens, or user accounts.
- Fail-open model: Native DeepSeek functionality remains completely unimpeded.
```

---

## 6. Saving Draft and Quality Gate Stop

1. Click **Save draft**.
2. Review the dashboard's automated validation checks:
   - Ensure there are **0 errors** (red banners).
   - Note any advisory warnings.
3. Use the **Store Preview** link to review how the listing appears to end users.
4. **STOP**: Do NOT click *Submit for review* until you have reviewed all fields and made the deliberate decision to submit for Google review.
