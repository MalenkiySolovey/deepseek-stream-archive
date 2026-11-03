# Chrome Web Store Graphic Assets & Screenshot Specification

> **Project:** DeepSeek StreamArchive  
> **Target:** Chrome Web Store Developer Dashboard & Store Listing  
> **Compliance Standards:** [Chrome Web Store Store Listing Guidelines](https://developer.chrome.com/docs/webstore/program-policies/#listing-quality)  
> **Audited Date:** 2026-11-03  

This document specifies the exact dimensional, visual, and content requirements for all Chrome Web Store visual assets.

---

## 1. Asset Dimensional Summary

| Asset Type | Required Dimensions | Format | Requirement Status | Purpose |
|---|---|---|---|---|
| **Extension Store Icon** | **128 x 128 px** | PNG | **Verified on Disk** (`public/icons/icon-128.png`) | Displayed in search results, extension card, and management page. |
| **Store Screenshots** | **1280 x 800 px** (or 640 x 400 px) | PNG or JPEG | **Specification Defined** (1-5 screenshots required) | Real screenshots illustrating core features and interfaces. |
| **Small Promo Tile** | **440 x 280 px** | PNG or JPEG | `MANUAL ASSET REQUIRED` | Promotional banner displayed in Web Store category and search pages. |
| **Marquee Promo Tile** | **1400 x 560 px** | PNG or JPEG | `MANUAL ASSET REQUIRED` (Optional) | High-resolution hero graphic for featured placements in Chrome Web Store. |

---

## 2. Extension Store Icon (128 x 128 px)

- **Source File:** [`workbench/public/icons/icon-128.png`](../public/icons/icon-128.png)
- **Dimensions:** 128 x 128 pixels (exact)
- **Format:** 32-bit RGBA PNG with transparency
- **Visual Design:** Distinctive stream-archive icon featuring deep blue/cyan stream waves with the forensic archive crest.
- **Verification Status:** Passed automated PNG header and dimensional validation (`128 x 128`, 27.35 kB).

---

## 3. Store Screenshot Plan (5 Core Scenarios)

The Chrome Web Store requires at least one screenshot and permits up to five. To provide comprehensive, trustworthy coverage of StreamArchive's single purpose without clutter, five standardized screenshots are planned at **1280 x 800 pixels**:

### Screenshot 1: Side Panel Archive Browser & Conversation History
- **Interface:** Native Chrome Side Panel (`sidepanel.html`) opened alongside DeepSeek chat.
- **Content:**
  - Conversations list showing recent archived threads.
  - Search bar with a sample query ("Quicksort algorithm").
  - Thread timeline with USER and ASSISTANT messages.
  - Branch navigation widget (`Branch 1 of 2`).
- **Data Guard:** Pure synthetic technical discussion (computer science algorithms). Zero real personal messages or user profile data.

### Screenshot 2: In-Page Inline Recovery & Native Toolbar Preservation
- **Interface:** DeepSeek web app (`https://chat.deepseek.com/`) showing an in-page recovered response.
- **Content:**
  - Assistant message block containing the closed Shadow DOM recovery host.
  - Visible trust badge: `🛡️ Recovered locally before DeepSeek filter`.
  - Intact native DeepSeek toolbar below the body (`Copy`, `Regenerate`, `Like`, `Dislike`, `Read aloud`, `Share`).
  - StreamArchive's extension-owned `Copy recovered response` button.
- **Data Guard:** Harmless synthetic technical explanation of networking protocols (TCP vs UDP).

### Screenshot 3: Revision History & Collapsible DeepThink Reasoning
- **Interface:** Side Panel conversation view with expanded reasoning trace.
- **Content:**
  - Collapsible DeepThink block (`🧠 DeepThink — recovered locally (1,420 chars)`).
  - Revision timeline drawer displaying chronological revisions with origin badges (`network` vs `history`).
  - Word and character counts proving archival fidelity.
- **Data Guard:** Harmless mathematical or scientific problem derivation.

### Screenshot 4: Context Continuity Planning & Transparent Preview
- **Interface:** Side Panel with the Context Continuity Preview modal open (`⚡ Preview Continuity`).
- **Content:**
  - Metrics grid: Eligible responses (1), Excluded responses (0), Character count (640 chars).
  - Cause tag: `network_interruption` / `content_filter`.
  - Delimiter preview showing boundary markers (`[StreamArchive Context Continuity v1]`).
  - Explicit user disclaimers and single-click copy action.
- **Data Guard:** Strictly synthetic text demonstrating transparent boundary disclosures.

### Screenshot 5: Local-First Privacy Controls & Storage Retention
- **Interface:** Side Panel Settings view (`⚙️ Settings`).
- **Content:**
  - Storage Observability badge showing estimated IndexedDB footprint (`~1.2 MB`).
  - Raw evidence retention policy dropdown (`Forever`, `30 days`, `90 days`, `180 days`).
  - Recovery presentation mode selector (`Overlay` vs `Inline`).
  - Two-step confirmed Clear Archive maintenance button.
- **Data Guard:** Zero account IDs, tokens, or personal identifiers visible.

---

## 4. Privacy & Zero-Personal-Data Invariant for Screenshots

Chrome Web Store reviewers reject screenshots containing real user data, third-party trademarks, or deceptive claims. All screenshots must strictly abide by the following rules:

1. **Synthetic Data Only:** Generate conversations using neutral synthetic topics (physics concepts, programming algorithms, mathematical definitions).
2. **Zero Personal Credentials:** No account names, user avatars, email addresses, phone numbers, or profile links.
3. **Zero Authentication Artifacts:** Ensure browser address bars, devtools, and headers show no tokens or cookies.
4. **No Sensationalist Prompts:** Do not use political, adult, or controversial queries to illustrate recovery. Use benign technical interruption or filter simulations.
5. **Accurate Interface Depiction:** Screenshots must reflect the actual production build (`.output/chrome-mv3`) without post-processing embellishments, fake mockups, or inaccurate UI elements.

---

## 5. Promotional Graphics Specification

The Chrome Web Store allows optional promotional images for featured merchandising. These require custom graphical design and are classified as **`MANUAL ASSET REQUIRED`** prior to submitting for featured placement consideration:

### 5.1 Small Promo Tile (`440 x 280 px`)
- **Dimensions:** 440 x 280 pixels
- **Format:** PNG or high-quality JPEG (max 1 MB)
- **Content:** Central StreamArchive logo and concise tagline (`"Never lose a response after it reaches your browser"`). Dark, high-contrast background matching StreamArchive branding (`#0f172a`).
- **Status:** `MANUAL ASSET REQUIRED`

### 5.2 Marquee Promo Tile (`1400 x 560 px`)
- **Dimensions:** 1400 x 560 pixels
- **Format:** PNG or high-quality JPEG
- **Content:** Wide cinematic hero banner showcasing the Side Panel archive alongside the DeepSeek interface with key value badges (Local-First, Revision Recovery, Context Continuity).
- **Status:** `MANUAL ASSET REQUIRED`
