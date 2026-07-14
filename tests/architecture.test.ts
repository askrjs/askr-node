import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('Node adapter architecture', () => {
  it('should keep the public index as a re-export-only barrel', () => {
    const lines = readFileSync(resolve(root, 'src/index.ts'), 'utf8').split('\n').filter(Boolean);
    expect(lines.every((line) => line.startsWith('export '))).toBe(true);
  });

  it('should export no Vite-specific behavior', () => {
    for (const file of readdirSync(resolve(root, 'src')).filter((name) => name.endsWith('.ts'))) {
      expect(readFileSync(resolve(root, 'src', file), 'utf8'), file).not.toMatch(/(?:from|import\()\s*['"]vite/);
    }
  });

  it('should keep production modules within 300 lines', () => {
    for (const file of readdirSync(resolve(root, 'src')).filter((name) => name.endsWith('.ts'))) {
      expect(readFileSync(resolve(root, 'src', file), 'utf8').split('\n').length, file).toBeLessThanOrEqual(300);
    }
  });
});
