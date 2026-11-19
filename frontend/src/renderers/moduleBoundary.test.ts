import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Structural guards for the 3D chain's boundaries (3D-01 acceptance):
 *
 * - the chain owns its face vocabulary and never imports `frontend/src/table/*`
 *   (the 2.5D pipeline, removed 2026-11-19);
 * - three.js stays behind the lazy `import('./three')` (3D-02), so no 3D byte
 *   can reach the entry chunk before a user asks for the view; and
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
  'three/hitTest.ts',
  'handOverlay.ts',
] as const;

function source(file: (typeof FILES)[number]): string {
  return readFileSync(
    fileURLToPath(new URL(`./${file}`, import.meta.url)),
    'utf8',
  );
}

describe('3D renderer module boundaries', () => {
  it('never imports the retired 2.5D table pipeline or its face vocabulary', () => {
    for (const file of FILES) {
      const text = source(file);
      expect(text, file).not.toMatch(/from\s+['"][^'"]*\/table\//);
      expect(text, file).not.toMatch(/from\s+['"]\.\.\/table['"]/);
      expect(text, file).not.toMatch(/from\s+['"]\.\.\/table\//);
    }
  });

  it('keeps three.js out of the shared contract modules', () => {
    for (const file of FILES) {
      const text = source(file);
      expect(text, file).not.toMatch(/from\s+['"]three(\/|['"])/);
      expect(text, file).not.toMatch(/import\(\s*['"]three/);
      expect(text, file).not.toMatch(/require\(\s*['"]three/);
    }
  });

  it('reaches three.js only through the host’s dynamic import', () => {
    const host = readFileSync(
      fileURLToPath(new URL('./RendererHost.tsx', import.meta.url)),
      'utf8',
    );
    expect(host).not.toMatch(/from\s+['"]\.\/three['"]/);
    expect(host).toMatch(/import\(\s*['"]\.\/three['"]\s*\)/);

    // Everything three.js-dependent lives under renderers/three/, which is
    // reached only from that dynamic import.
    for (const file of FILES) {
      expect(source(file), file).not.toMatch(/from\s+['"]\.\/three['"]/);
    }
  });

  it('pins three.js to an exact version (decision D1)', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const three = manifest.dependencies?.three;
    expect(three).toBeDefined();
    expect(three, 'three must be pinned exactly, with no range').toMatch(/^\d+\.\d+\.\d+$/);
    const threeTypes = manifest.devDependencies?.['@types/three'];
    if (threeTypes !== undefined) {
      expect(threeTypes, '@types/three must match the pin exactly').toMatch(
        /^\d+\.\d+\.\d+$/,
      );
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
