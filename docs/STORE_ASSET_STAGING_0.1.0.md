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
| `workbench/public/icons/icon-128.png` | 128 × 128 | PNG | `a7e5ce3ac740cb46d0389dd001f91938a68f4ace8f0092f2346e58311654ae75` | **Chrome Web Store Listing Icon** (Mandatory) |
| `workbench/public/icons/icon-48.png` | 48 × 48 | PNG | `0c1ce08aca79946d3d4b6d96fbf1f8a567555cc1686d964b206cedef653aa886` | Chrome Extensions Management (`chrome://extensions`) |
| `workbench/public/icons/icon-32.png` | 32 × 32 | PNG | `69f9b21f57ea96a81aaba940a2034fe4398ff09ea9c598f8ff2f9d7706ef9323` | Windows High-DPI Browser Action |
| `workbench/public/icons/icon-16.png` | 16 × 16 | PNG | `86adc77e4ab9f0ffa0262e5d9bed70aadd991f544f859d53088d25aabfb8e3b2` | Chrome Toolbar Browser Action Icon |

---

## 3. Privacy & Cleanliness Invariant Verification

1. **Zero Personal Data**:
   All 5 staged screenshots utilize 100% synthetic scenarios ("Explain TCP vs UDP", "HTTP Caching Architecture"). Zero real-world chat titles, zero personal emails, zero Google account avatars, zero IP addresses, and zero API tokens appear in any visual asset.
2. **True-to-Code Presentation**:
   Every visual component—including the closed Shadow DOM inline recovery banner, Svelte 5 Side Panel runes UI, revision drawer, and privacy settings—reflects actual compiled code from release candidate package `0.1.0`.
3. **Exact Dimensions**:
   All 5 screenshots strictly measure `1280 × 800` pixels, matching the Chrome Web Store primary recommendation.
