import { describe, it, expect } from 'vitest';
import { sanitizeExportFilename, formatDateUtc } from '../src/export/filename';

describe('Export Filename Sanitizer (sanitizeExportFilename)', () => {
  it('formats dates consistently in UTC', () => {
    const fixed = new Date(Date.UTC(2026, 10, 2, 14, 30, 0)); // Month is 0-indexed: 10 = Nov
    expect(formatDateUtc(fixed)).toBe('2026-11-02');
  });

  it('preserves clean alphanumeric titles with hyphens', () => {
    const filename = sanitizeExportFilename('REST-GraphQL-gRPC', '2026-11-02', 'md');
    expect(filename).toBe('REST-GraphQL-gRPC_2026-11-02.md');
  });

  it('replaces illegal path and filesystem characters', () => {
    const raw = 'What is "AI"? / Guide: <Beginner> | Part*1';
    const filename = sanitizeExportFilename(raw, '2026-11-02', 'md');
    expect(filename).toBe('What is AI-Guide-Beginner-Part-1_2026-11-02.md');
    expect(filename).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('strips control characters and collapses whitespace and hyphens', () => {
    const raw = "Title with\x00 null and\x1f control\x7f chars\t\t\nand   spaces";
    const filename = sanitizeExportFilename(raw, '2026-11-02', 'json');
    expect(filename).toBe('Title with null and control chars and spaces_2026-11-02.json');
  });

  it('strips leading and trailing dots, hyphens, and spaces', () => {
    const raw = '...---   My Cool Article   ---...';
    const filename = sanitizeExportFilename(raw, '2026-11-02', 'md');
    expect(filename).toBe('My Cool Article_2026-11-02.md');
  });

  it('handles Windows reserved device names (case-insensitive)', () => {
    const reservedNames = ['CON', 'con', 'PRN', 'prn', 'AUX', 'aux', 'NUL', 'COM1', 'com5', 'LPT1'];
    for (const name of reservedNames) {
      const filename = sanitizeExportFilename(name, '2026-11-02', 'md');
      expect(filename).toBe(`_${name.toUpperCase()}_2026-11-02.md`);
    }
  });

  it('safely handles empty or whitespace-only titles with fallback conversation ID', () => {
    expect(sanitizeExportFilename('', '2026-11-02', 'md', 'conv_12345')).toBe(
      'deepseek-conversation_conv_12345_2026-11-02.md'
    );
    expect(sanitizeExportFilename('   ///   ', '2026-11-02', 'json', 'conv_abc')).toBe(
      'deepseek-conversation_conv_abc_2026-11-02.json'
    );
    expect(sanitizeExportFilename(null, '2026-11-02', 'md')).toBe(
      'deepseek-conversation_export_2026-11-02.md'
    );
  });

  it('truncates oversized titles safely without breaking Unicode surrogate pairs', () => {
    const longTitle = 'A'.repeat(100);
    const filename = sanitizeExportFilename(longTitle, '2026-11-02', 'md');
    const baseTitle = filename.replace('_2026-11-02.md', '');
    expect(baseTitle.length).toBeLessThanOrEqual(60);
    expect(baseTitle).toBe('A'.repeat(60));
  });

  it('preserves multi-lingual Unicode titles (Russian, Chinese, Emoji)', () => {
    const ruTitle = 'Квантовые вычисления и архитектура систем';
    const ruFilename = sanitizeExportFilename(ruTitle, '2026-11-02', 'md');
    expect(ruFilename).toBe('Квантовые вычисления и архитектура систем_2026-11-02.md');

    const zhTitle = '深度学习模型推理优化指南';
    const zhFilename = sanitizeExportFilename(zhTitle, '2026-11-02', 'json');
    expect(zhFilename).toBe('深度学习模型推理优化指南_2026-11-02.json');

    const emojiTitle = 'Архитектура микросервисов 🚀📦';
    const emojiFilename = sanitizeExportFilename(emojiTitle, '2026-11-02', 'md');
    expect(emojiFilename).toBe('Архитектура микросервисов 🚀📦_2026-11-02.md');
  });
});
