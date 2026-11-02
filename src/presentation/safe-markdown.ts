/**
 * Safe, pure Markdown block parser and DOM renderer.
 *
 * Designed to be shared between Svelte Side Panel views and Content Script
 * closed Shadow DOM portals.
 *
 * Guarantees:
 * - Zero innerHTML / insertAdjacentHTML
 * - Zero eval / new Function
 * - Zero external dependencies
 * - Pure DOM node construction
 */

export interface SafeMarkdownParagraphBlock {
  type: 'paragraph';
  text: string;
}

export interface SafeMarkdownCodeBlock {
  type: 'code';
  text: string;
  lang?: string;
}

export type SafeMarkdownBlock = SafeMarkdownParagraphBlock | SafeMarkdownCodeBlock;

/**
 * Parses markdown text into structured semantic blocks (paragraphs and fenced code blocks).
 */
export function parseSafeMarkdown(raw: string): SafeMarkdownBlock[] {
  if (!raw) return [];

  const result: SafeMarkdownBlock[] = [];
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

export interface RenderSafeMarkdownOptions {
  codeCopyLabel?: string;
  codeCopiedLabel?: string;
  onCopyCode?: (code: string) => Promise<boolean> | boolean | void;
}

/**
 * Renders structured markdown blocks into a DocumentFragment using pure DOM construction.
 * Completely immune to XSS as zero text is passed through innerHTML or HTML parsers.
 */
export function renderSafeMarkdownToFragment(
  blocks: SafeMarkdownBlock[],
  options?: RenderSafeMarkdownOptions
): DocumentFragment {
  const fragment = document.createDocumentFragment();

  if (blocks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'safe-md-empty';
    empty.appendChild(document.createTextNode('—'));
    fragment.appendChild(empty);
    return fragment;
  }

  for (const block of blocks) {
    if (block.type === 'code') {
      const wrapper = document.createElement('div');
      wrapper.className = 'safe-md-code-wrapper';

      const header = document.createElement('div');
      header.className = 'safe-md-code-header';

      const langSpan = document.createElement('span');
      langSpan.className = 'safe-md-code-lang';
      langSpan.textContent = block.lang || 'code';
      header.appendChild(langSpan);

      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'safe-md-copy-btn';
      const initialCopyLabel = options?.codeCopyLabel || 'Copy code';
      const copiedLabel = options?.codeCopiedLabel || 'Copied!';
      copyBtn.textContent = initialCopyLabel;

      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          if (options?.onCopyCode) {
            await options.onCopyCode(block.text);
          } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(block.text);
          }
          copyBtn.textContent = copiedLabel;
          setTimeout(() => {
            copyBtn.textContent = initialCopyLabel;
          }, 2000);
        } catch {
          copyBtn.textContent = 'Error';
        }
      });
      header.appendChild(copyBtn);
      wrapper.appendChild(header);

      const pre = document.createElement('pre');
      pre.className = 'safe-md-pre';
      const code = document.createElement('code');
      code.className = 'safe-md-code';
      code.textContent = block.text;
      pre.appendChild(code);
      wrapper.appendChild(pre);

      fragment.appendChild(wrapper);
    } else {
      const p = document.createElement('p');
      p.className = 'safe-md-paragraph';
      p.textContent = block.text;
      fragment.appendChild(p);
    }
  }

  return fragment;
}
