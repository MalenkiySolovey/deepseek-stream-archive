/**
 * Safe, pure Markdown block & inline parser and DOM renderer.
 *
 * Designed to be shared between Svelte Side Panel views and Content Script
 * closed Shadow DOM portals.
 *
 * Guarantees:
 * - Zero innerHTML / insertAdjacentHTML / eval
 * - Pure DOM node construction via document.createElement and document.createTextNode
 * - Zero external dependencies
 * - Full XSS immunity: strictly validates link protocols (http, https, mailto);
 *   all text content is treated strictly as plain text.
 */

export type InlineNode =
  | { type: 'text'; value: string }
  | { type: 'bold'; children: InlineNode[] }
  | { type: 'italic'; children: InlineNode[] }
  | { type: 'bold_italic'; children: InlineNode[] }
  | { type: 'strikethrough'; children: InlineNode[] }
  | { type: 'code'; value: string }
  | { type: 'link'; text: string; url: string };

export interface SafeMarkdownParagraphBlock {
  type: 'paragraph';
  text: string;
  inlines?: InlineNode[];
}

export interface SafeMarkdownCodeBlock {
  type: 'code';
  text: string;
  lang?: string;
}

export interface SafeMarkdownHeadingBlock {
  type: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  inlines?: InlineNode[];
}

export interface SafeMarkdownBlockquoteBlock {
  type: 'blockquote';
  text: string;
  inlines?: InlineNode[];
}

export interface SafeMarkdownHrBlock {
  type: 'hr';
}

export interface SafeMarkdownListItem {
  ordered: boolean;
  text: string;
  inlines?: InlineNode[];
  subItems?: SafeMarkdownListItem[];
}

export interface SafeMarkdownListBlock {
  type: 'list';
  ordered: boolean;
  items: SafeMarkdownListItem[];
}

export interface SafeMarkdownTableBlock {
  type: 'table';
  headers: InlineNode[][];
  aligns: Array<'left' | 'center' | 'right' | 'default'>;
  rows: InlineNode[][][];
}

export type SafeMarkdownBlock =
  | SafeMarkdownParagraphBlock
  | SafeMarkdownCodeBlock
  | SafeMarkdownHeadingBlock
  | SafeMarkdownBlockquoteBlock
  | SafeMarkdownHrBlock
  | SafeMarkdownListBlock
  | SafeMarkdownTableBlock;

/**
 * Parses inline formatting (code, links, bold, italic, strikethrough, plain text)
 * without regex catastrophic backtracking.
 */
export function parseInlines(text: string): InlineNode[] {
  if (!text) return [];

  const nodes: InlineNode[] = [];
  let pos = 0;
  const len = text.length;

  while (pos < len) {
    // 1. Inline code: `code`
    if (text[pos] === '`') {
      const end = text.indexOf('`', pos + 1);
      if (end !== -1) {
        nodes.push({ type: 'code', value: text.slice(pos + 1, end) });
        pos = end + 1;
        continue;
      }
    }

    // 2. Links: [text](url)
    if (text[pos] === '[') {
      const closeBracket = text.indexOf(']', pos + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          const linkText = text.slice(pos + 1, closeBracket);
          const rawUrl = text.slice(closeBracket + 2, closeParen).trim();
          // Strict protocol validation: only http, https, mailto (reject javascript:, data:, etc.)
          if (/^(https?:\/\/|mailto:)/i.test(rawUrl)) {
            nodes.push({ type: 'link', text: linkText, url: rawUrl });
            pos = closeParen + 1;
            continue;
          }
        }
      }
    }

    // 3. Strikethrough: ~~text~~
    if (text.startsWith('~~', pos)) {
      const end = text.indexOf('~~', pos + 2);
      if (end !== -1) {
        const inner = text.slice(pos + 2, end);
        nodes.push({ type: 'strikethrough', children: parseInlines(inner) });
        pos = end + 2;
        continue;
      }
    }

    // 4. Bold + Italic: ***text*** or ___text___
    if (text.startsWith('***', pos)) {
      const end = text.indexOf('***', pos + 3);
      if (end !== -1) {
        const inner = text.slice(pos + 3, end);
        nodes.push({ type: 'bold_italic', children: parseInlines(inner) });
        pos = end + 3;
        continue;
      }
    }
    if (text.startsWith('___', pos)) {
      const end = text.indexOf('___', pos + 3);
      if (end !== -1) {
        const inner = text.slice(pos + 3, end);
        nodes.push({ type: 'bold_italic', children: parseInlines(inner) });
        pos = end + 3;
        continue;
      }
    }

    // 5. Bold: **text** or __text__
    if (text.startsWith('**', pos)) {
      const end = text.indexOf('**', pos + 2);
      if (end !== -1) {
        const inner = text.slice(pos + 2, end);
        nodes.push({ type: 'bold', children: parseInlines(inner) });
        pos = end + 2;
        continue;
      }
    }
    if (text.startsWith('__', pos)) {
      const end = text.indexOf('__', pos + 2);
      if (end !== -1) {
        const inner = text.slice(pos + 2, end);
        nodes.push({ type: 'bold', children: parseInlines(inner) });
        pos = end + 2;
        continue;
      }
    }

    // 6. Italic: *text* or _text_
    if (text[pos] === '*' && !text.startsWith('**', pos)) {
      const end = text.indexOf('*', pos + 1);
      if (end !== -1 && end > pos + 1) {
        const inner = text.slice(pos + 1, end);
        nodes.push({ type: 'italic', children: parseInlines(inner) });
        pos = end + 1;
        continue;
      }
    }
    if (text[pos] === '_' && !text.startsWith('__', pos)) {
      const end = text.indexOf('_', pos + 1);
      if (end !== -1 && end > pos + 1) {
        const inner = text.slice(pos + 1, end);
        nodes.push({ type: 'italic', children: parseInlines(inner) });
        pos = end + 1;
        continue;
      }
    }

    // 7. Regular text: advance to next special character
    let nextSpecial = len;
    for (const char of ['`', '[', '~', '*', '_']) {
      const idx = text.indexOf(char, pos);
      if (idx !== -1 && idx < nextSpecial) {
        nextSpecial = idx;
      }
    }

    if (nextSpecial > pos) {
      nodes.push({ type: 'text', value: text.slice(pos, nextSpecial) });
      pos = nextSpecial;
    } else {
      nodes.push({ type: 'text', value: text[pos]! });
      pos++;
    }
  }

  return nodes;
}

/**
 * Checks if line is a table row (contains pipes).
 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes('|') && (trimmed.startsWith('|') || trimmed.endsWith('|') || trimmed.split('|').length > 2);
}

/**
 * Checks if line is a table delimiter row (e.g. |---|:---:|---:|).
 */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;
  const parts = trimmed.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return false;
  return parts.every((p) => /^:?-+:?$/.test(p));
}

/**
 * Parses markdown text into structured semantic blocks (headings, code, lists, tables, blockquotes, hr, paragraphs).
 */
export function parseSafeMarkdown(raw: string): SafeMarkdownBlock[] {
  if (!raw) return [];

  const result: SafeMarkdownBlock[] = [];
  const lines = raw.split('\n');
  let i = 0;
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

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // 1. Fenced code block: ```lang
    if (trimmed.startsWith('```')) {
      flushText();
      const lang = trimmed.slice(3).trim();
      const codeBuffer: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeBuffer.push(lines[i]!);
        i++;
      }
      if (i < lines.length && lines[i]!.trim().startsWith('```')) {
        i++; // skip closing fence
      }
      result.push({
        type: 'code',
        lang: lang || undefined,
        text: codeBuffer.join('\n'),
      });
      continue;
    }

    // 2. Horizontal Rule: ---, ***, ___
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushText();
      result.push({ type: 'hr' });
      i++;
      continue;
    }

    // 3. Headings: # Header ... ###### Header
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      flushText();
      const level = headingMatch[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = headingMatch[2]!.trim();
      result.push({
        type: 'heading',
        level,
        text,
      });
      i++;
      continue;
    }

    // 4. Blockquote: > ...
    if (trimmed.startsWith('>')) {
      flushText();
      const bqLines: string[] = [];
      while (
        i < lines.length &&
        (lines[i]!.trim().startsWith('>') ||
          (bqLines.length > 0 && lines[i]!.trim().length > 0 && !lines[i]!.trim().startsWith('#')))
      ) {
        const l = lines[i]!.trim();
        if (l.startsWith('>')) {
          bqLines.push(l.replace(/^>\s?/, ''));
        } else {
          bqLines.push(l);
        }
        i++;
      }
      const bqText = bqLines.join(' ');
      result.push({
        type: 'blockquote',
        text: bqText,
      });
      continue;
    }

    // 5. Markdown Table: Row 1 + delimiter line
    if (isTableRow(line) && i + 1 < lines.length && isTableDelimiter(lines[i + 1]!)) {
      flushText();
      const parseCells = (rowStr: string): string[] => {
        let s = rowStr.trim();
        if (s.startsWith('|')) s = s.slice(1);
        if (s.endsWith('|')) s = s.slice(0, -1);
        return s.split('|').map((c) => c.trim());
      };

      const rawHeaders = parseCells(line);
      const delimiterCells = parseCells(lines[i + 1]!);
      const aligns: Array<'left' | 'center' | 'right' | 'default'> = delimiterCells.map((d) => {
        const left = d.startsWith(':');
        const right = d.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return 'default';
      });

      const headers = rawHeaders.map((h) => parseInlines(h));
      const rows: InlineNode[][][] = [];
      i += 2; // advance past header and delimiter

      while (i < lines.length && isTableRow(lines[i]!)) {
        const rawRow = parseCells(lines[i]!);
        rows.push(rawRow.map((c) => parseInlines(c)));
        i++;
      }

      result.push({
        type: 'table',
        headers,
        aligns,
        rows,
      });
      continue;
    }

    // 6. Lists: Ordered (1. ) and Unordered (- , * , + )
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      flushText();
      const isOrdered = /^\d+\./.test(listMatch[2]!);
      const items: SafeMarkdownListItem[] = [];

      while (i < lines.length) {
        const currentLine = lines[i]!;
        const m = currentLine.match(/^(\s*)([-*+]|\d+\.)\s+(.+)$/);
        if (!m) {
          if (items.length > 0 && /^\s{2,}\S/.test(currentLine)) {
            const lastItem = items[items.length - 1]!;
            lastItem.text += ' ' + currentLine.trim();
            i++;
            continue;
          }
          break;
        }

        const indent = m[1]!.length;
        const itemOrdered = /^\d+\./.test(m[2]!);
        const text = m[3]!.trim();

        if (indent >= 2 && items.length > 0) {
          const parentItem = items[items.length - 1]!;
          if (!parentItem.subItems) parentItem.subItems = [];
          parentItem.subItems.push({
            ordered: itemOrdered,
            text,
          });
        } else {
          items.push({
            ordered: itemOrdered,
            text,
          });
        }
        i++;
      }

      result.push({
        type: 'list',
        ordered: isOrdered,
        items,
      });
      continue;
    }

    // 7. Plain text lines: buffer until block boundary
    textBuffer.push(line);
    i++;
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
 * Renders an array of inline nodes into a parent DOM element.
 * Pure DOM construction with zero innerHTML.
 */
export function renderInlinesToElement(nodes: InlineNode[], parent: HTMLElement): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        parent.appendChild(document.createTextNode(node.value));
        break;
      case 'code': {
        const code = document.createElement('code');
        code.className = 'safe-md-inline-code';
        code.appendChild(document.createTextNode(node.value));
        parent.appendChild(code);
        break;
      }
      case 'bold': {
        const strong = document.createElement('strong');
        strong.className = 'safe-md-bold';
        renderInlinesToElement(node.children, strong);
        parent.appendChild(strong);
        break;
      }
      case 'italic': {
        const em = document.createElement('em');
        em.className = 'safe-md-italic';
        renderInlinesToElement(node.children, em);
        parent.appendChild(em);
        break;
      }
      case 'bold_italic': {
        const strong = document.createElement('strong');
        strong.className = 'safe-md-bold';
        const em = document.createElement('em');
        em.className = 'safe-md-italic';
        renderInlinesToElement(node.children, em);
        strong.appendChild(em);
        parent.appendChild(strong);
        break;
      }
      case 'strikethrough': {
        const del = document.createElement('del');
        del.className = 'safe-md-del';
        renderInlinesToElement(node.children, del);
        parent.appendChild(del);
        break;
      }
      case 'link': {
        const a = document.createElement('a');
        a.className = 'safe-md-link';
        a.href = node.url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.appendChild(document.createTextNode(node.text));
        parent.appendChild(a);
        break;
      }
    }
  }
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
    switch (block.type) {
      case 'code': {
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
        break;
      }

      case 'heading': {
        const h = document.createElement(`h${block.level}`);
        h.className = `safe-md-heading safe-md-h${block.level}`;
        const inlines = block.inlines || parseInlines(block.text);
        renderInlinesToElement(inlines, h);
        fragment.appendChild(h);
        break;
      }

      case 'blockquote': {
        const bq = document.createElement('blockquote');
        bq.className = 'safe-md-blockquote';
        const inlines = block.inlines || parseInlines(block.text);
        renderInlinesToElement(inlines, bq);
        fragment.appendChild(bq);
        break;
      }

      case 'hr': {
        const hr = document.createElement('hr');
        hr.className = 'safe-md-hr';
        fragment.appendChild(hr);
        break;
      }

      case 'list': {
        const listEl = document.createElement(block.ordered ? 'ol' : 'ul');
        listEl.className = block.ordered ? 'safe-md-ol' : 'safe-md-ul';

        for (const item of block.items) {
          const li = document.createElement('li');
          li.className = 'safe-md-li';
          const inlines = item.inlines || parseInlines(item.text);
          renderInlinesToElement(inlines, li);

          if (item.subItems && item.subItems.length > 0) {
            const subList = document.createElement(item.subItems[0]!.ordered ? 'ol' : 'ul');
            subList.className = item.subItems[0]!.ordered
              ? 'safe-md-ol safe-md-sublist'
              : 'safe-md-ul safe-md-sublist';

            for (const sub of item.subItems) {
              const subLi = document.createElement('li');
              subLi.className = 'safe-md-li';
              const subInlines = sub.inlines || parseInlines(sub.text);
              renderInlinesToElement(subInlines, subLi);
              subList.appendChild(subLi);
            }
            li.appendChild(subList);
          }

          listEl.appendChild(li);
        }
        fragment.appendChild(listEl);
        break;
      }

      case 'table': {
        const wrapper = document.createElement('div');
        wrapper.className = 'safe-md-table-wrapper';

        const table = document.createElement('table');
        table.className = 'safe-md-table';

        // Table Header
        const thead = document.createElement('thead');
        const trHead = document.createElement('tr');
        block.headers.forEach((cellInlines, colIdx) => {
          const th = document.createElement('th');
          th.className = 'safe-md-th';
          const align = block.aligns[colIdx] || 'default';
          if (align !== 'default') th.style.textAlign = align;
          renderInlinesToElement(cellInlines, th);
          trHead.appendChild(th);
        });
        thead.appendChild(trHead);
        table.appendChild(thead);

        // Table Body
        const tbody = document.createElement('tbody');
        block.rows.forEach((row) => {
          const tr = document.createElement('tr');
          tr.className = 'safe-md-tr';
          row.forEach((cellInlines, colIdx) => {
            const td = document.createElement('td');
            td.className = 'safe-md-td';
            const align = block.aligns[colIdx] || 'default';
            if (align !== 'default') td.style.textAlign = align;
            renderInlinesToElement(cellInlines, td);
            tr.appendChild(td);
          });
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);

        wrapper.appendChild(table);
        fragment.appendChild(wrapper);
        break;
      }

      case 'paragraph':
      default: {
        const paragraphs = block.text.split(/\n\n+/);
        for (const para of paragraphs) {
          const trimmedPara = para.trim();
          if (trimmedPara.length > 0) {
            const p = document.createElement('p');
            p.className = 'safe-md-paragraph';
            const inlines = block.inlines || parseInlines(trimmedPara);
            renderInlinesToElement(inlines, p);
            fragment.appendChild(p);
          }
        }
        break;
      }
    }
  }

  return fragment;
}
