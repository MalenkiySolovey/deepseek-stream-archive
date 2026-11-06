// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { parseSafeMarkdown, renderSafeMarkdownToFragment, parseInlines } from '../src/presentation/safe-markdown';

describe('Safe Markdown Parser and Pure DOM Renderer', () => {
  it('parses empty and whitespace strings into empty array', () => {
    expect(parseSafeMarkdown('')).toEqual([]);
    expect(parseSafeMarkdown('   \n  \n')).toEqual([]);
  });

  it('parses simple paragraphs', () => {
    const raw = 'First paragraph text.\nStill in first paragraph.\n\nSecond paragraph text.';
    const blocks = parseSafeMarkdown(raw);
    expect(blocks).toEqual([
      { type: 'paragraph', text: 'First paragraph text.\nStill in first paragraph.\n\nSecond paragraph text.' },
    ]);
  });

  it('parses fenced code blocks with language tag', () => {
    const raw = 'Introduction text\n```typescript\nconst x: number = 42;\nconsole.log(x);\n```\nFollow up text.';
    const blocks = parseSafeMarkdown(raw);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ type: 'paragraph', text: 'Introduction text' });
    expect(blocks[1]).toEqual({
      type: 'code',
      lang: 'typescript',
      text: 'const x: number = 42;\nconsole.log(x);',
    });
    expect(blocks[2]).toEqual({ type: 'paragraph', text: 'Follow up text.' });
  });

  it('handles unclosed code blocks safely', () => {
    const raw = '```python\ndef hello():\n    return "world"';
    const blocks = parseSafeMarkdown(raw);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: 'code',
      lang: 'python',
      text: 'def hello():\n    return "world"',
    });
  });

  it('renders paragraph and code blocks to DOM fragment with zero innerHTML', () => {
    const blocks = parseSafeMarkdown('Hello world\n```json\n{"status": "ok"}\n```');
    const onCopy = vi.fn();
    const fragment = renderSafeMarkdownToFragment(blocks, {
      codeCopyLabel: 'Copy',
      codeCopiedLabel: 'Done',
      onCopyCode: onCopy,
    });

    const p = fragment.querySelector('p.safe-md-paragraph');
    expect(p).not.toBeNull();
    expect(p?.textContent).toBe('Hello world');

    const wrapper = fragment.querySelector('.safe-md-code-wrapper');
    expect(wrapper).not.toBeNull();
    const lang = wrapper?.querySelector('.safe-md-code-lang');
    expect(lang?.textContent).toBe('json');
    const code = wrapper?.querySelector('code.safe-md-code');
    expect(code?.textContent).toBe('{"status": "ok"}');

    // Test copy button interaction
    const copyBtn = wrapper?.querySelector('button.safe-md-copy-btn') as HTMLButtonElement;
    expect(copyBtn).not.toBeNull();
    copyBtn.click();
    expect(onCopy).toHaveBeenCalledWith('{"status": "ok"}');
  });

  it('renders placeholder for empty blocks without error', () => {
    const fragment = renderSafeMarkdownToFragment([]);
    const empty = fragment.querySelector('.safe-md-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toBe('—');
  });

  // ── Rich Text Extension Tests ──

  it('parses headings level 1 through 6', () => {
    const raw = '# Heading 1\n## Heading 2\n### Heading 3\n#### Heading 4\n##### Heading 5\n###### Heading 6';
    const blocks = parseSafeMarkdown(raw);
    expect(blocks).toHaveLength(6);
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1, text: 'Heading 1' });
    expect(blocks[5]).toMatchObject({ type: 'heading', level: 6, text: 'Heading 6' });

    const frag = renderSafeMarkdownToFragment(blocks);
    expect(frag.querySelector('h1.safe-md-h1')?.textContent).toBe('Heading 1');
    expect(frag.querySelector('h6.safe-md-h6')?.textContent).toBe('Heading 6');
  });

  it('parses blockquotes and horizontal rules', () => {
    const raw = '> This is a wisdom quote from DeepSeek\n\n---\n\n> Another quote';
    const blocks = parseSafeMarkdown(raw);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: 'blockquote', text: 'This is a wisdom quote from DeepSeek' });
    expect(blocks[1]).toMatchObject({ type: 'hr' });
    expect(blocks[2]).toMatchObject({ type: 'blockquote', text: 'Another quote' });

    const frag = renderSafeMarkdownToFragment(blocks);
    expect(frag.querySelectorAll('blockquote.safe-md-blockquote')).toHaveLength(2);
    expect(frag.querySelector('hr.safe-md-hr')).not.toBeNull();
  });

  it('parses ordered and unordered lists with nested items', () => {
    const raw = '- Item 1\n- Item 2\n  - Subitem 2.1\n  - Subitem 2.2\n- Item 3\n\n1. First\n2. Second';
    const blocks = parseSafeMarkdown(raw);
    expect(blocks).toHaveLength(2);

    const ulBlock = blocks[0] as any;
    expect(ulBlock.type).toBe('list');
    expect(ulBlock.ordered).toBe(false);
    expect(ulBlock.items).toHaveLength(3);
    expect(ulBlock.items[1].subItems).toHaveLength(2);

    const olBlock = blocks[1] as any;
    expect(olBlock.type).toBe('list');
    expect(olBlock.ordered).toBe(true);
    expect(olBlock.items).toHaveLength(2);

    const frag = renderSafeMarkdownToFragment(blocks);
    const ul = frag.querySelector('ul.safe-md-ul');
    expect(ul).not.toBeNull();
    expect(ul?.querySelectorAll('li.safe-md-li').length).toBe(5); // 3 parent + 2 sub
    const ol = frag.querySelector('ol.safe-md-ol');
    expect(ol).not.toBeNull();
    expect(ol?.querySelectorAll('li.safe-md-li').length).toBe(2);
  });

  it('parses markdown tables with header alignments and data rows', () => {
    const raw = `
| Feature | Supported | Notes |
|:---|:---:|---:|
| Inline Recovery | Yes | Closed Shadow DOM |
| DAG Branching | Yes | Independent selection |
| Zero innerHTML | Yes | Immune to XSS |
`.trim();

    const blocks = parseSafeMarkdown(raw);
    expect(blocks).toHaveLength(1);
    const tableBlock = blocks[0] as any;
    expect(tableBlock.type).toBe('table');
    expect(tableBlock.headers).toHaveLength(3);
    expect(tableBlock.aligns).toEqual(['left', 'center', 'right']);
    expect(tableBlock.rows).toHaveLength(3);

    const frag = renderSafeMarkdownToFragment(blocks);
    const wrapper = frag.querySelector('.safe-md-table-wrapper');
    expect(wrapper).not.toBeNull();
    const table = wrapper?.querySelector('table.safe-md-table');
    expect(table).not.toBeNull();

    const ths = table?.querySelectorAll<HTMLElement>('th.safe-md-th')!;
    expect(ths).toHaveLength(3);
    expect(ths[0]?.textContent).toBe('Feature');
    expect(ths[0]?.style.textAlign).toBe('left');
    expect(ths[1]?.style.textAlign).toBe('center');
    expect(ths[2]?.style.textAlign).toBe('right');

    const rows = table?.querySelectorAll('tbody tr.safe-md-tr')!;
    expect(rows).toHaveLength(3);
  });

  it('parses inline bold, italic, bold+italic, strikethrough, and inline code', () => {
    const inlines = parseInlines('Here is **bold**, *italic*, ***both***, ~~strike~~, and `const code = 1;`');
    expect(inlines.some((n) => n.type === 'bold')).toBe(true);
    expect(inlines.some((n) => n.type === 'italic')).toBe(true);
    expect(inlines.some((n) => n.type === 'bold_italic')).toBe(true);
    expect(inlines.some((n) => n.type === 'strikethrough')).toBe(true);
    expect(inlines.some((n) => n.type === 'code')).toBe(true);

    const raw = 'Paragraph with **жирный текст** и *курсив*.';
    const frag = renderSafeMarkdownToFragment(parseSafeMarkdown(raw));
    const strong = frag.querySelector('strong.safe-md-bold');
    expect(strong?.textContent).toBe('жирный текст');
    const em = frag.querySelector('em.safe-md-italic');
    expect(em?.textContent).toBe('курсив');
  });

  it('renders safe links with target=_blank and rel=noopener, while strictly rejecting javascript: and data: links', () => {
    const raw = 'Visit [DeepSeek](https://chat.deepseek.com) or [Email](mailto:user@test.com) or [Evil](javascript:alert(1)) or [Payload](data:text/html,<script>alert(1)</script>)';
    const frag = renderSafeMarkdownToFragment(parseSafeMarkdown(raw));

    const links = frag.querySelectorAll('a.safe-md-link');
    expect(links).toHaveLength(2); // Only https and mailto should be parsed as links!

    expect(links[0]?.getAttribute('href')).toBe('https://chat.deepseek.com');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');

    expect(links[1]?.getAttribute('href')).toBe('mailto:user@test.com');

    // javascript: and data: must NOT be anchor tags
    expect(frag.querySelector('a[href*="javascript"]')).toBeNull();
    expect(frag.querySelector('a[href*="data:"]')).toBeNull();

    // They must be rendered safely as plain text
    expect(frag.textContent).toContain('[Evil](javascript:alert(1))');
  });

  it('maintains strict XSS immunity against raw script and HTML tags in markdown', () => {
    const malicious = '<script>window.pwned=true;</script>\n<img src="x" onerror="alert(1)">\n**Safe bold text**';
    const frag = renderSafeMarkdownToFragment(parseSafeMarkdown(malicious));

    // Zero script elements
    expect(frag.querySelector('script')).toBeNull();
    // Zero img elements
    expect(frag.querySelector('img')).toBeNull();
    // Raw tags are escaped into text nodes
    expect(frag.textContent).toContain('<script>window.pwned=true;</script>');
    // Bold element is rendered
    expect(frag.querySelector('strong.safe-md-bold')?.textContent).toBe('Safe bold text');
  });

  it('supports Russian and English mixed text, Unicode, emojis and math symbols', () => {
    const raw = '### 🧠 Анализ квантовых вычислений\nКвантовая суперпозиция: |ψ⟩ = α|0⟩ + β|1⟩, где α² + β² = 1. 🚀\n- Проверка: **успешно** (100% точность)\n- Статус: `DONE`';
    const frag = renderSafeMarkdownToFragment(parseSafeMarkdown(raw));

    expect(frag.querySelector('h3.safe-md-h3')?.textContent).toContain('🧠 Анализ квантовых вычислений');
    expect(frag.textContent).toContain('|ψ⟩ = α|0⟩ + β|1⟩');
    expect(frag.textContent).toContain('🚀');
    expect(frag.querySelector('strong.safe-md-bold')?.textContent).toBe('успешно');
    expect(frag.querySelector('code.safe-md-inline-code')?.textContent).toBe('DONE');
  });
});
