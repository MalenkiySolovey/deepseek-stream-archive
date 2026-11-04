<script lang="ts">
  import { parseSafeMarkdown, renderSafeMarkdownToFragment } from '../../../src/presentation/safe-markdown';

  interface Props {
    content?: string;
  }

  let { content = '' } = $props<Props>();

  let containerEl = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!containerEl) return;
    containerEl.replaceChildren();
    const blocks = parseSafeMarkdown(content);
    const fragment = renderSafeMarkdownToFragment(blocks, {
      codeCopyLabel: 'Copy',
      codeCopiedLabel: 'Copied!',
    });
    containerEl.appendChild(fragment);
  });
</script>

<div class="safe-markdown-container" bind:this={containerEl}></div>

<style>
  .safe-markdown-container {
    font-size: 0.875rem;
    line-height: 1.6;
    color: #e2e8f0;
    word-break: break-word;
  }

  :global(.safe-md-empty) {
    color: #64748b;
    font-style: italic;
  }

  :global(.safe-md-paragraph) {
    margin: 0 0 0.75rem 0;
    line-height: 1.6;
    white-space: pre-wrap;
  }

  :global(.safe-md-paragraph:last-child) {
    margin-bottom: 0;
  }

  :global(.safe-md-heading) {
    margin: 0.85rem 0 0.35rem 0;
    font-weight: 600;
    line-height: 1.3;
    color: #f8fafc;
  }

  :global(.safe-md-h1) { font-size: 1.25rem; border-bottom: 1px solid rgba(51, 65, 85, 0.4); padding-bottom: 0.3rem; }
  :global(.safe-md-h2) { font-size: 1.125rem; border-bottom: 1px solid rgba(51, 65, 85, 0.3); padding-bottom: 0.2rem; }
  :global(.safe-md-h3) { font-size: 1rem; }
  :global(.safe-md-h4) { font-size: 0.9375rem; }
  :global(.safe-md-h5) { font-size: 0.875rem; }
  :global(.safe-md-h6) { font-size: 0.8125rem; color: #94a3b8; }

  :global(.safe-md-bold) { font-weight: 600; color: #f8fafc; }
  :global(.safe-md-italic) { font-style: italic; }
  :global(.safe-md-del) { text-decoration: line-through; color: #94a3b8; }

  :global(.safe-md-inline-code) {
    background: rgba(15, 23, 42, 0.8);
    border: 1px solid rgba(51, 65, 85, 0.6);
    border-radius: 4px;
    padding: 0.15rem 0.35rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.85em;
    color: #38bdf8;
  }

  :global(.safe-md-link) {
    color: #38bdf8;
    text-decoration: underline;
    text-underline-offset: 2px;
    transition: color 0.15s ease;
  }
  :global(.safe-md-link:hover) {
    color: #7dd3fc;
  }

  :global(.safe-md-blockquote) {
    margin: 0.5rem 0;
    padding: 0.35rem 0.75rem;
    border-left: 3px solid #38bdf8;
    background: rgba(30, 41, 59, 0.4);
    border-radius: 0 4px 4px 0;
    color: #cbd5e1;
    font-style: italic;
  }

  :global(.safe-md-hr) {
    border: none;
    border-top: 1px solid rgba(51, 65, 85, 0.6);
    margin: 0.75rem 0;
  }

  :global(.safe-md-ul), :global(.safe-md-ol) {
    margin: 0.35rem 0 0.5rem 1.25rem;
    padding: 0;
    line-height: 1.6;
  }
  :global(.safe-md-li) {
    margin: 0.2rem 0;
  }
  :global(.safe-md-sublist) {
    margin: 0.2rem 0 0.2rem 1rem;
  }

  :global(.safe-md-table-wrapper) {
    overflow-x: auto;
    margin: 0.75rem 0;
    max-width: 100%;
    -webkit-overflow-scrolling: touch;
  }

  :global(.safe-md-table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.8125rem;
    line-height: 1.5;
    background: rgba(15, 23, 42, 0.6);
    border: 1px solid #1e293b;
    border-radius: 4px;
  }

  :global(.safe-md-th) {
    background: #0f172a;
    border: 1px solid #1e293b;
    padding: 0.4rem 0.6rem;
    font-weight: 600;
    color: #f1f5f9;
  }

  :global(.safe-md-td) {
    border: 1px solid #1e293b;
    padding: 0.35rem 0.6rem;
    color: #cbd5e1;
  }

  :global(.safe-md-tr:nth-child(even)) {
    background: rgba(30, 41, 59, 0.3);
  }

  :global(.safe-md-code-wrapper) {
    margin: 0.75rem 0;
    background: #090d16;
    border: 1px solid #1e293b;
    border-radius: 0.375rem;
    overflow: hidden;
  }

  :global(.safe-md-code-header) {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.25rem 0.75rem;
    background: #0f172a;
    border-bottom: 1px solid #1e293b;
    font-size: 0.75rem;
  }

  :global(.safe-md-code-lang) {
    color: #94a3b8;
    text-transform: lowercase;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  :global(.safe-md-copy-btn) {
    background: transparent;
    border: 1px solid #334155;
    border-radius: 0.25rem;
    color: #cbd5e1;
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  :global(.safe-md-copy-btn:hover) {
    background: #1e293b;
    color: #f8fafc;
  }

  :global(.safe-md-pre) {
    margin: 0;
    padding: 0.75rem;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: #cbd5e1;
  }
</style>
