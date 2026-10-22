import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Architectural Layer Isolation (Generic Transport Invariant)', () => {
  const FORBIDDEN_STRINGS = [
    'CONTENT_FILTER',
    'TEMPLATE_RESPONSE',
    'response/fragments',
    'thinking_content',
    'message_id',
    'chat_session_id',
    'parent_message_id',
  ];

  const transportDir = path.resolve(__dirname, '../src/transport');

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

  it('guarantees that no generic transport file contains platform-specific DeepSeek strings', () => {
    const files = getFilesRecursively(transportDir);
    expect(files.length).toBeGreaterThan(0);

    const violations: Array<{ file: string; forbidden: string }> = [];

    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf-8');
      for (const forbidden of FORBIDDEN_STRINGS) {
        if (content.includes(forbidden)) {
          violations.push({ file: path.relative(transportDir, filePath), forbidden });
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
