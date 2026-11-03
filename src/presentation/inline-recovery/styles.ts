/**
 * Scoped styles for the extension-owned closed Shadow DOM inline recovery container.
 */

export const INLINE_RECOVERY_STYLES = `
:host {
  display: block;
  width: 100%;
  margin: 0.75rem 0;
  box-sizing: border-box;
}

.streamarchive-inline-host-root {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(56, 189, 248, 0.35);
  border-left: 3px solid #38bdf8;
  border-radius: 8px;
  padding: 0.875rem 1rem;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 0.9375rem;
  line-height: 1.6;
  color: #f1f5f9;
  box-sizing: border-box;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.streamarchive-inline-host-root.filtered {
  border-color: rgba(16, 185, 129, 0.4);
  border-left-color: #10b981;
}

.streamarchive-inline-host-root.interrupted {
  border-color: rgba(245, 158, 11, 0.4);
  border-left-color: #f59e0b;
}

.streamarchive-inline-host-root.degraded {
  border-color: rgba(239, 68, 68, 0.4);
  border-left-color: #ef4444;
}

/* Header badge */
.streamarchive-inline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.streamarchive-inline-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  background: rgba(56, 189, 248, 0.15);
  color: #38bdf8;
}

.streamarchive-inline-badge.filtered {
  background: rgba(16, 185, 129, 0.15);
  color: #34d399;
}

.streamarchive-inline-badge.interrupted {
  background: rgba(245, 158, 11, 0.15);
  color: #fbbf24;
}

.streamarchive-inline-badge.degraded {
  background: rgba(239, 68, 68, 0.15);
  color: #f87171;
}

.streamarchive-inline-continuity-pill {
  display: inline-flex;
  align-items: center;
  font-size: 0.6875rem;
  font-weight: 500;
  color: #c084fc;
  background: rgba(168, 85, 247, 0.12);
  border: 1px solid rgba(168, 85, 247, 0.3);
  padding: 0.15rem 0.45rem;
  border-radius: 4px;
}


/* DeepThink collapsible section */
.streamarchive-inline-thinking {
  background: rgba(30, 41, 59, 0.6);
  border: 1px solid rgba(51, 65, 85, 0.7);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  color: #94a3b8;
  margin-bottom: 0.25rem;
}

.streamarchive-inline-thinking[open] {
  padding-bottom: 0.75rem;
}

.streamarchive-inline-thinking-summary {
  cursor: pointer;
  user-select: none;
  font-weight: 500;
  color: #cbd5e1;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  outline: none;
}

.streamarchive-inline-thinking-summary:focus-visible {
  outline: 2px solid #38bdf8;
  border-radius: 4px;
}

.streamarchive-inline-thinking-body {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(51, 65, 85, 0.5);
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.75rem;
  line-height: 1.5;
  color: #cbd5e1;
}

/* Body text */
.streamarchive-inline-body {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  word-break: break-word;
}

.safe-md-paragraph {
  margin: 0;
  line-height: 1.6;
}

/* Code Blocks */
.safe-md-code-wrapper {
  background: #090d16;
  border: 1px solid #1e293b;
  border-radius: 6px;
  overflow: hidden;
  margin: 0.5rem 0;
}

.safe-md-code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.35rem 0.75rem;
  background: #0f172a;
  border-bottom: 1px solid #1e293b;
  font-size: 0.75rem;
}

.safe-md-code-lang {
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, monospace;
  text-transform: lowercase;
}

.safe-md-copy-btn {
  background: transparent;
  border: 1px solid #334155;
  border-radius: 4px;
  color: #94a3b8;
  font-size: 0.7rem;
  padding: 0.15rem 0.4rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.safe-md-copy-btn:hover {
  background: #1e293b;
  color: #f1f5f9;
}

.safe-md-pre {
  margin: 0;
  padding: 0.75rem;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.8125rem;
  line-height: 1.5;
  color: #e2e8f0;
}

.safe-md-code {
  font-family: inherit;
}

/* Actions footer */
.streamarchive-inline-footer {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(51, 65, 85, 0.4);
}

.streamarchive-inline-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.35rem 0.75rem;
  background: #1e293b;
  border: 1px solid #334155;
  border-radius: 6px;
  color: #e2e8f0;
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.streamarchive-inline-copy-btn:hover {
  background: #334155;
  border-color: #475569;
  color: #ffffff;
}

.streamarchive-inline-copy-btn:focus-visible {
  outline: 2px solid #38bdf8;
}

/* User turn clean continuity presentation */
.streamarchive-user-continuity-root {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
  color: inherit;
}

.streamarchive-user-prompt-text {
  white-space: pre-wrap;
  word-break: break-word;
}

.streamarchive-user-continuity-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
  color: #c084fc;
  background: rgba(168, 85, 247, 0.12);
  border: 1px solid rgba(168, 85, 247, 0.3);
  margin-top: 0.25rem;
  width: fit-content;
}

.streamarchive-user-included-context {
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(168, 85, 247, 0.25);
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font-size: 0.8125rem;
  margin-top: 0.35rem;
}

.streamarchive-user-included-summary {
  cursor: pointer;
  color: #a78bfa;
  font-weight: 500;
  user-select: none;
}

.streamarchive-user-included-body {
  margin-top: 0.5rem;
  max-height: 250px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-word;
  color: #94a3b8;
  font-size: 0.8rem;
  line-height: 1.5;
  border-top: 1px solid rgba(168, 85, 247, 0.15);
  padding-top: 0.5rem;
}

.streamarchive-inline-notice {
  padding: 0.5rem 0.75rem;
  background: rgba(245, 158, 11, 0.15);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: 6px;
  color: #fbbf24;
  font-size: 0.8125rem;
  line-height: 1.5;
}

.streamarchive-inline-subtitle {
  font-size: 0.75rem;
  color: #94a3b8;
  margin-top: 0.2rem;
}

.streamarchive-inline-toggle-orig-btn {
  background: transparent;
  border: 1px solid rgba(148, 163, 184, 0.4);
  color: #94a3b8;
  padding: 0.3rem 0.6rem;
  border-radius: 4px;
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.streamarchive-inline-toggle-orig-btn:hover {
  background: rgba(148, 163, 184, 0.15);
  color: #f1f5f9;
}
`;
