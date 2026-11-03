# Security Policy

> **Project:** DeepSeek StreamArchive  
> **Last Updated:** November 3, 2026  

We take the security and privacy of DeepSeek StreamArchive and our users very seriously. This document outlines our security architecture, supported versions, and the process for responsibly reporting security vulnerabilities.

---

## 1. Supported Versions

Security updates and patches are actively maintained for the current release series:

| Version | Supported | Security Maintenance Status |
|:---:|:---:|---|
| **0.1.x** | **Yes** | Current Release Candidate series |
| < 0.1.0 | No | Pre-release development builds |

---

## 2. Reporting a Vulnerability

If you discover a security vulnerability, privacy leak, or potential exploit in DeepSeek StreamArchive, please report it responsibly:

### 2.1 Preferred Reporting Method
Please use **GitHub Private Vulnerability Reporting**:
1. Navigate to the repository's **Security** tab:  
   `https://github.com/MalenkiySolovey/deepseek-stream-archive/security`
2. Click **Report a vulnerability** to open an encrypted private advisory draft.
3. Provide a clear description of the vulnerability, reproduction steps, and potential impact.

### 2.2 Public Issues Alternative (For Non-Sensitive Inquiries)
If private vulnerability reporting is unavailable, you may open an issue on our [GitHub Issue Tracker](https://github.com/MalenkiySolovey/deepseek-stream-archive/issues) with a general inquiry requesting a private security contact channel.

### 2.3 Strict Reporting Invariants
When submitting vulnerability reports or bug inquiries:
- ❌ **DO NOT attach private conversations, sensitive prompts, or personal chat exports.**
- ❌ **DO NOT include authentication tokens, session cookies, Bearer credentials, or Authorization headers.**
- ✅ **DO provide synthetic, sanitized reproduction steps using neutral technical text.**

We will acknowledge receipt of your report within 48 hours and work with you to validate and address the issue promptly.

---

## 3. Core Security & Privacy Invariants

DeepSeek StreamArchive is built on a defensive, local-first security architecture:

1. **Origin Isolation:**  
   All archived data, raw journal records, and canonical DAG structures are stored in IndexedDB (`StreamArchiveDB`) hosted strictly inside the extension origin (`chrome-extension://<id>`). Web pages and third-party scripts have zero access to this database.
2. **Strict Principle of Least Privilege:**  
   The extension requests only `storage` and `sidePanel` permissions, scoped to host `https://chat.deepseek.com/*`. We strictly avoid broad permissions such as `<all_urls>`, `tabs`, `cookies`, `webRequest`, `downloads`, `history`, or `scripting`.
3. **Zero Remotely Hosted Code:**  
   In compliance with Chromium Manifest V3 policies, all executable code is statically packaged in the extension bundle. Dynamic script loading, remote CDNs, and dynamic code evaluation (`eval`, `new Function`) are strictly prohibited and enforced via automated release audits.
4. **DOM Sanitization & Closed Shadow DOM:**  
   In-page UI components (inline recovery badges, recovered response presentations, and de-augmented user turns) are mounted inside closed Shadow DOM roots (`#shadow-root (closed)`). Markdown rendering utilizes token-based safe DOM assembly with **zero `innerHTML`** and **zero `outerHTML`**.
5. **No Credential Harvesting:**  
   StreamArchive's network interceptors specifically ignore and discard all authentication headers, cookies, and tokens.
6. **Fail-Open Invariant:**  
   If an unexpected error, schema mismatch, or protocol divergence occurs, StreamArchive fails open safely without corrupting, delaying, or blocking the user's conversation with DeepSeek.
