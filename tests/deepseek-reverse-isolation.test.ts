import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Architectural Reverse Isolation (DeepSeek Adapter Invariant)', () => {
  const FORBIDDEN_IMPORT_PATTERNS = [
    'indexeddb',
    'idb',
    'storage-repository',
    'storage/repositories',
    'svelte',
    'sidepanel',
    'document.',
    'window.dispatchEvent',
  ];

  const adapterDir = path.resolve(__dirname, '../src/adapters/deepseek');

  function getFilesRecursively(dir: string): string[] {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...getFilesRecursively(fullPath));
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        files.push(fullPath);
      }
    }
    return files;
  }

  it('guarantees that DeepSeek adapter layer contains zero imports from storage, svelte, or DOM UI', () => {
    const files = getFilesRecursively(adapterDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<{ file: string; forbidden: string }> = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const forbidden of FORBIDDEN_IMPORT_PATTERNS) {
        if (content.toLowerCase().includes(forbidden.toLowerCase())) {
          violations.push({ file: path.relative(adapterDir, filePath), forbidden });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
