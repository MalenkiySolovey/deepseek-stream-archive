// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { parseSafeMarkdown, renderSafeMarkdownToFragment } from '../src/presentation/safe-markdown';

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
});
