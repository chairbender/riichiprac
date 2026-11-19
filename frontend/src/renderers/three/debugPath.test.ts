/**
 * The debug path's contracts (3D-10).
 *
 * The acceptance criterion is that a debug mode "changes only shading and never
 * the layout, the hit rects or the snapshot", and that "each mode's readout
 * prints its numeric legend". Both are text facts about the committed sources,
 * so this file checks them directly rather than trusting a render:
 *
 * 1. every `DebugMode` has exactly one legend, and its code equals the shader
 *    code the material writes (`debugCodeFor`);
 * 2. the shader's debug chain assigns only `colour` — the "flood" property: no
 *    branch may touch the UV, the normal, the geometry or any uniform;
 * 3. the layout and hit-test modules have no notion of debug at all, and the
 *    scene's `syncState`/`hitRects` never read `debugMode`, so a mode cannot
 *    move a tile or a button.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DEBUG_MODES } from '../capabilities';
import type { DebugMode } from '../contract';
import { DEBUG_LEGENDS, DEBUG_MODE_CODE, debugCodeFor } from '../debugLegend';
import { TILE_FRAGMENT_SHADER } from './materials/tile.frag';

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('debug legends', () => {
  it('has one legend per mode, and every query-selectable mode is known', () => {
    const documented = Object.keys(DEBUG_LEGENDS).sort();
    const selectable = [...DEBUG_MODES].sort();
    expect(documented).toEqual(selectable);
    for (const mode of DEBUG_MODES) {
      const legend = DEBUG_LEGENDS[mode];
      expect(legend.label, mode).toBe(mode);
      expect(legend.code, mode).toBe(debugCodeFor(mode));
      // A legend must state at least one channel or count, not a mood.
      expect(legend.legend.length, mode).toBeGreaterThan(30);
    }
  });

  it('maps every false-colour mode to a shader code and every view to none', () => {
    expect(DEBUG_MODE_CODE).toEqual({
      none: 0,
      albedo: 1,
      height: 2,
      normal: 3,
      steps: 4,
      flags: 5,
      shadow: 6,
    });
    const falseColour: readonly DebugMode[] = ['albedo', 'height', 'normal', 'steps', 'flags', 'shadow'];
    for (const mode of falseColour) {
      expect(debugCodeFor(mode), mode).toBeGreaterThan(0);
    }
    for (const mode of ['pom-off', 'shadow-off', 'wireframe', 'hero'] as const) {
      expect(debugCodeFor(mode), mode).toBe(0);
    }
  });

  it('matches the shader chain’s case order and bounds', () => {
    for (const [mode, code] of Object.entries(DEBUG_MODE_CODE)) {
      if (code === 0) continue;
      // The chain is `if (uDebug > 0.5) { if (uDebug < 1.5) … }`: code n is
      // `< n + 0.5`, so the derived code and the shader agree by construction.
      expect(TILE_FRAGMENT_SHADER, mode).toContain(`uDebug < ${code + 0.5}`);
    }
  });
});

describe('the debug path is shading-only', () => {
  it('assigns nothing but colour in the debug chain', () => {
    const start = TILE_FRAGMENT_SHADER.indexOf('if (uDebug > 0.5)');
    expect(start).toBeGreaterThan(-1);
    const end = TILE_FRAGMENT_SHADER.indexOf('gl_FragColor', start);
    expect(end).toBeGreaterThan(start);
    const block = TILE_FRAGMENT_SHADER.slice(start, end);

    // Every statement inside the block (outside its own if/else scaffolding)
    // must be a colour assignment or a local derived from an already-computed
    // value.
    const statements = block
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter(
        (line) =>
          !line.startsWith('if') &&
          !line.startsWith('}') &&
          !line.startsWith('//') &&
          line !== '{',
      );
    expect(statements.length).toBeGreaterThanOrEqual(6);
    for (const statement of statements) {
      expect(statement, statement).toMatch(/^(colour =|float ratio =|\/\/)/);
    }
    // The flood: the loop covers every fragment of a tile, including the body
    // and the back, because `colour` is unconditional once a code is set.
    expect(block).toContain('colour = vec3(shadowVisibility');
  });

  it('keeps the layout and the hit rects unaware of debug', () => {
    for (const file of ['./boardLayout.ts', './hitTest.ts']) {
      const text = source(file);
      expect(text, file).not.toMatch(/debug/i);
    }
  });

  it('never reads debugMode from syncState or hitRects', () => {
    const scene = source('./Scene.ts');
    const syncState = /syncState\(snapshot: TableSnapshot\): void \{([\s\S]*?)\n {2}\}/.exec(scene);
    const hitRects = /hitRects\(\): readonly HitRect\[\] \{([\s\S]*?)\n {2}\}/.exec(scene);
    expect(syncState).not.toBeNull();
    expect(hitRects).not.toBeNull();
    expect(syncState?.[1]).not.toContain('debugMode');
    expect(hitRects?.[1]).not.toContain('debugMode');
    // And the layout function takes the snapshot alone.
    const layout = /export function layoutBoard\(([\s\S]*?)\): BoardLayout/.exec(
      source('./boardLayout.ts'),
    );
    expect(layout).not.toBeNull();
    expect(layout?.[1]).toContain('snapshot: TableSnapshot');
    expect(layout?.[1]).not.toContain('debug');
  });
});
