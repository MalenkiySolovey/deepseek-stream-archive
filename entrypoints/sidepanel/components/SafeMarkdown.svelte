<script lang="ts">
  interface Props {
    content?: string;
  }

  let { content = '' } = $props<Props>();

  interface Block {
    type: 'code' | 'paragraph';
    lang?: string;
    text: string;
  }

  let blocks = $derived<Block[]>(parseMarkdown(content));
  let copiedBlockIndex = $state<number | null>(null);

  function parseMarkdown(raw: string): Block[] {
    if (!raw) return [];

    const result: Block[] = [];
    const lines = raw.split('\n');
    let inCode = false;
    let codeLang = '';
    let codeBuffer: string[] = [];
    let textBuffer: string[] = [];

    const flushText = () => {
      if (textBuffer.length > 0) {
        const text = textBuffer.join('\n').trim();
        if (text.length > 0) {
          result.push({ type: 'paragraph', text });
        }
        textBuffer = [];
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim().startsWith('```')) {
        if (inCode) {
          // Closing code fence
          result.push({
            type: 'code',
            lang: codeLang || undefined,
            text: codeBuffer.join('\n'),
          });
          codeBuffer = [];
          codeLang = '';
          inCode = false;
        } else {
          // Opening code fence
          flushText();
          inCode = true;
          codeLang = line.trim().slice(3).trim();
        }
      } else {
        if (inCode) {
          codeBuffer.push(line);
        } else {
          textBuffer.push(line);
        }
      }
    }

    if (inCode && codeBuffer.length > 0) {
      result.push({
        type: 'code',
        lang: codeLang || undefined,
        text: codeBuffer.join('\n'),
      });
    }

    flushText();
    return result;
  }

  async function copyCode(index: number, code: string) {
    try {
      await navigator.clipboard.writeText(code);
      copiedBlockIndex = index;
      setTimeout(() => {
        if (copiedBlockIndex === index) {
          copiedBlockIndex = null;
        }
      }, 2000);
    } catch {
      // fallback ignore
    }
  }
</script>

<div class="safe-markdown-container">
  {#if blocks.length === 0}
    <div class="empty-text">—</div>
  {:else}
    {#each blocks as block, idx}
      {#if block.type === 'code'}
        <div class="code-wrapper">
          <div class="code-header">
            <span class="code-lang">{block.lang || 'code'}</span>
            <button
              class="code-copy-btn"
              type="button"
              onclick={() => copyCode(idx, block.text)}
            >
              {copiedBlockIndex === idx ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <pre class="code-content"><code>{block.text}</code></pre>
        </div>
      {:else}
        <div class="paragraph-block">
          {#each block.text.split('\n\n') as para}
            <p class="prose-paragraph">{para}</p>
          {/each}
        </div>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .safe-markdown-container {
    font-size: 0.875rem;
    line-height: 1.6;
    color: #e2e8f0;
    word-break: break-word;
  }

  .empty-text {
    color: #64748b;
    font-style: italic;
  }

  .paragraph-block {
    margin: 0.5rem 0;
  }

  .prose-paragraph {
    margin: 0 0 0.75rem 0;
    white-space: pre-wrap;
  }

  .prose-paragraph:last-child {
    margin-bottom: 0;
  }

  .code-wrapper {
    margin: 0.75rem 0;
    background: #090d16;
    border: 1px solid #1e293b;
    border-radius: 0.375rem;
    overflow: hidden;
  }

  .code-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.25rem 0.75rem;
    background: #0f172a;
    border-bottom: 1px solid #1e293b;
    font-size: 0.75rem;
  }

  .code-lang {
    color: #94a3b8;
    text-transform: lowercase;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .code-copy-btn {
    background: transparent;
    border: 1px solid #334155;
    border-radius: 0.25rem;
    color: #cbd5e1;
    font-size: 0.7rem;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
    transition: background 0.15s;
  }

  .code-copy-btn:hover {
    background: #1e293b;
    color: #f8fafc;
  }

  .code-content {
    margin: 0;
    padding: 0.75rem;
    overflow-x: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.8125rem;
    line-height: 1.45;
    color: #cbd5e1;
  }
</style>
