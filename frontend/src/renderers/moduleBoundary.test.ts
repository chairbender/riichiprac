import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guards for the 3D chain's boundaries (3D-01 acceptance):
 *
 * - the chain owns its face vocabulary and never imports `frontend/src/table/*`
 *   (the parallel 2.5D pipeline);
 * - `three` is not imported anywhere yet, so no 3D byte can reach the entry
 *   chunk before the lazy host lands in 3D-02; and
 * - the snapshot adapter and the shared contracts carry no DOM and no renderer
 *   types.
 *
 * These are text assertions on the committed sources, so a future unit cannot
 * quietly break the boundary by adding one import line.
 */

const FILES = [
  'contract.ts',
  'snapshot.ts',
  'capabilities.ts',
  'layoutConstants.ts',
  'three/boardLayout.ts',
] as const;

function source(file: (typeof FILES)[number]): string {
  return readFileSync(
    fileURLToPath(new URL(`./${file}`, import.meta.url)),
    'utf8',
  );
}

describe('3D renderer module boundaries', () => {
  it('never imports the 2.5D table pipeline or its face vocabulary', () => {
    for (const file of FILES) {
      const text = source(file);
      expect(text, file).not.toMatch(/from\s+['"][^'"]*\/table\//);
      expect(text, file).not.toMatch(/from\s+['"]\.\.\/table['"]/);
      expect(text, file).not.toMatch(/from\s+['"]\.\.\/table\//);
    }
  });

  it('does not import three.js anywhere yet', () => {
    for (const file of FILES) {
      const text = source(file);
      expect(text, file).not.toMatch(/from\s+['"]three(\/|['"])/);
      expect(text, file).not.toMatch(/import\(\s*['"]three/);
      expect(text, file).not.toMatch(/require\(\s*['"]three/);
    }
  });

  it('keeps the snapshot and the contracts free of DOM and renderer types', () => {
    for (const file of [
      'contract.ts',
      'snapshot.ts',
      'layoutConstants.ts',
      'three/boardLayout.ts',
    ] as const) {
      const text = source(file);
      expect(text, file).not.toMatch(/\bdocument\b/);
      expect(text, file).not.toMatch(/\bwindow\b/);
      expect(text, file).not.toMatch(/\bHTMLCanvasElement\b/);
      expect(text, file).not.toMatch(/\bWebGL2?RenderingContext\b/);
    }
  });

  it('defines the snapshot producer only in the adapter', () => {
    expect(source('snapshot.ts')).toMatch(
      /export function snapshotFromGameState\(/,
    );
    for (const file of [
      'contract.ts',
      'capabilities.ts',
      'layoutConstants.ts',
      'three/boardLayout.ts',
    ] as const) {
      expect(source(file), file).not.toMatch(/snapshotFromGameState/);
    }
  });
});
