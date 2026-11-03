# Store Asset Staging Report (v0.1.0)

**Date**: 2026-11-03  
**Target Release**: `0.1.0`  
**Staging Location**: `release-test\screenshots\`  
**Image Format**: 24-bit PNG (Zero alpha channel on background, compliant with Chrome Web Store specifications)  
**Target Dimension**: `1280 × 800 px`  

---

## 1. Staged Store Screenshots Audit

| File | Resolution | Size (bytes) | Size (KB) | SHA-256 Checksum | Scenario & Content |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **`01-archive-browser-1280x800.png`** | 1280 × 800 | 63,407 | 61.92 KB | `89468350f4d9d5d0c41400a0975c8dd4cdec75dec759e3a5946671c4f0f5048c` | **Archive Browser**: DeepSeek chat on left with TCP vs UDP comparison; docked StreamArchive Side Panel on right showing conversation list and message details. |
| **`02-inline-recovery-1280x800.png`** | 1280 × 800 | 87,669 | 85.61 KB | `4179589550bafa159b6fbaa0417513e5476de093c2939449ca7430ac9d6b3a48` | **In-Page Inline Recovery**: DeepSeek chat window showing assistant message with StreamArchive closed Shadow DOM recovery banner, DeepThink toggle, and native action buttons. |
| **`03-revision-history-1280x800.png`** | 1280 × 800 | 68,285 | 66.68 KB | `f8925a3c9e113318a71642a24dc6410fa25470303b939d5b694ab5fc04c0ff00` | **Revision Timeline**: Side Panel showing detailed chronological revisions (`#0 network [last-good]` vs `#1 network [interrupted]`), timestamps, and length metrics. |
| **`04-context-continuity-preview-1280x800.png`** | 1280 × 800 | 136,607 | 133.41 KB | `024837401db9b7d973007d501d8cef40155a3180b708c33107c150f5bd15ddc1` | **Context Continuity Planner**: Side Panel with Context Continuity planner preview modal, token estimates, structured prompt markers, and Arm Next Message control. |
| **`05-privacy-settings-1280x800.png`** | 1280 × 800 | 106,908 | 104.40 KB | `998ca326b0c6cf8dfdfe03a2d7b1323edb8a6cb3e947f9ad9fdcb36dc86f5c19` | **Privacy & Storage Settings**: Settings view showing Context Continuity OFF by default, consent disclosure callout, on-device IndexedDB stats, and retention controls. |

---

## 2. Production Icons Audit

| File | Resolution | Type | SHA-256 Checksum | Store Usage |
| :--- | :--- | :--- | :--- | :--- |
| `workbench/public/icons/icon-128.png` | 128 × 128 | PNG | `2ba7b8cfd6f83ec542845ff296e8d2e8e3aeb5c7eb391a27e7fa69bfe9d2bfda` | **Chrome Web Store Listing Icon** (Mandatory) |
| `workbench/public/icons/icon-48.png` | 48 × 48 | PNG | `553e1a14ebcbdb22ff6116ca8a05c31278ffbc401b171f19df2d63428d0eb4b7` | Chrome Extensions Management (`chrome://extensions`) |
| `workbench/public/icons/icon-32.png` | 32 × 32 | PNG | `ffb8733b8fb3c25ba4809bc3932fa5a7e106990ae0eb8f37803a646c0caae048` | Windows High-DPI Browser Action |
| `workbench/public/icons/icon-16.png` | 16 × 16 | PNG | `9ca0529e3a6c9d81d279b94ee09dbfe59a2df9787e2f5b619e99a4e8d3876e93` | Chrome Toolbar Browser Action Icon |

---

## 3. Privacy & Cleanliness Invariant Verification

1. **Zero Personal Data**:
   All 5 staged screenshots utilize 100% synthetic scenarios ("Explain TCP vs UDP", "HTTP Caching Architecture"). Zero real-world chat titles, zero personal emails, zero Google account avatars, zero IP addresses, and zero API tokens appear in any visual asset.
2. **True-to-Code Presentation**:
   Every visual component—including the closed Shadow DOM inline recovery banner, Svelte 5 Side Panel runes UI, revision drawer, and privacy settings—reflects actual compiled code from release candidate package `0.1.0`.
3. **Exact Dimensions**:
   All 5 screenshots strictly measure `1280 × 800` pixels, matching the Chrome Web Store primary recommendation.
