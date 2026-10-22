/**
 * Isolated CSS styles for the StreamArchive Shadow DOM Recovery Overlay.
 * Designed with CSS reset and high specificity inside the closed ShadowRoot.
 */

export const OVERLAY_STYLES = `
:host {
  all: initial;
}

*, *::before, *::after {
  box-sizing: border-box;
}

#streamarchive-overlay-container {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 2147483647;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 13px;
  line-height: 1.5;
  color: #e6edf3;
}

/* ── Anchored Badge ── */
.streamarchive-anchored-badge {
  position: fixed;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: rgba(22, 27, 34, 0.92);
  border: 1px solid rgba(240, 136, 62, 0.4);
  border-radius: 20px;
  color: #f0883e;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(8px);
  transition: all 0.15s ease;
  user-select: none;
  z-index: 10;
}

.streamarchive-anchored-badge:hover {
  background: rgba(33, 38, 45, 0.98);
  border-color: #f0883e;
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.4);
}

.streamarchive-anchored-badge.degraded {
  border-color: rgba(210, 153, 34, 0.4);
  color: #d29922;
}

/* ── Floating Recovery Tray ── */
.streamarchive-floating-tray {
  position: fixed;
  bottom: 24px;
  right: 24px;
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(22, 27, 34, 0.94);
  border: 1px solid rgba(56, 139, 253, 0.4);
  border-radius: 12px;
  padding: 12px 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(10px);
  max-width: 320px;
  z-index: 20;
}

.streamarchive-tray-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.streamarchive-tray-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: #58a6ff;
  font-size: 13px;
}

.streamarchive-tray-close {
  background: none;
  border: none;
  color: #8b949e;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 14px;
}

.streamarchive-tray-close:hover {
  color: #c9d1d9;
  background: rgba(255, 255, 255, 0.1);
}

.streamarchive-tray-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  background: rgba(13, 17, 23, 0.7);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.streamarchive-tray-item:hover {
  background: rgba(30, 36, 46, 0.9);
  border-color: rgba(56, 139, 253, 0.5);
}

.streamarchive-item-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: #c9d1d9;
}

/* ── Recovery Modal / Card ── */
.streamarchive-recovery-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  z-index: 50;
}

.streamarchive-recovery-card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 12px;
  width: 100%;
  max-width: 680px;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
  overflow: hidden;
}

.streamarchive-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: #0d1117;
  border-bottom: 1px solid #30363d;
}

.streamarchive-card-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 600;
}

.streamarchive-card-status-badge.filtered {
  background: rgba(240, 136, 62, 0.15);
  color: #f0883e;
  border: 1px solid rgba(240, 136, 62, 0.3);
}

.streamarchive-card-status-badge.degraded {
  background: rgba(210, 153, 34, 0.15);
  color: #d29922;
  border: 1px solid rgba(210, 153, 34, 0.3);
}

.streamarchive-card-body {
  padding: 16px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.streamarchive-thinking-details {
  border: 1px solid rgba(56, 139, 253, 0.3);
  border-radius: 6px;
  background: rgba(13, 17, 23, 0.5);
  padding: 8px 12px;
}

.streamarchive-thinking-summary {
  font-weight: 500;
  color: #58a6ff;
  cursor: pointer;
  user-select: none;
}

.streamarchive-thinking-content {
  margin-top: 8px;
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 12px;
  color: #8b949e;
  max-height: 200px;
  overflow-y: auto;
}

.streamarchive-text-content {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  color: #e6edf3;
  font-size: 13.5px;
}

.streamarchive-card-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 10px 16px;
  background: #0d1117;
  border-top: 1px solid #30363d;
}

.streamarchive-btn {
  padding: 6px 14px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid transparent;
  transition: all 0.15s ease;
}

.streamarchive-btn-copy {
  background: #238636;
  color: #ffffff;
  border-color: rgba(240, 246, 252, 0.1);
}

.streamarchive-btn-copy:hover {
  background: #2ea043;
}

.streamarchive-btn-copy.copied {
  background: #1f6feb;
}

.streamarchive-btn-dismiss {
  background: #21262d;
  color: #c9d1d9;
  border-color: #30363d;
}

.streamarchive-btn-dismiss:hover {
  background: #30363d;
  color: #ffffff;
}
`;
