/**
 * Structural checks on the HUD's stylesheets (3D-H2).
 *
 * These are text assertions on committed CSS, the same technique the 3D chain
 * uses for its module boundaries: they turn four composition rules that would
 * otherwise need an eyeball (AGENTS.md §6) into pass/fail facts.
 *
 * 1. The layer is out of flow and click-through: `position: fixed; inset: 0;
 *    pointer-events: none`. That is what keeps the canvas full-window and keeps
 *    the felt reachable.
 * 2. Only panels and controls take pointer events — never the full-window root.
 * 3. No HUD rule writes a bare `z-index`; the rungs come from the token block,
 *    in the committed ladder order.
 * 4. The panel surface's alpha floor, the scrim's 45 % and the fixed `rem` type
 *    scale are the committed values (3d_hud.md §8).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HUD_SETUP_TRIGGER_WIDTH } from './hudLayout';

const TOKENS = readFileSync(
  fileURLToPath(new URL('./tokens.css', import.meta.url)),
  'utf8',
);
const HUD = readFileSync(
  fileURLToPath(new URL('./Hud.css', import.meta.url)),
  'utf8',
);

interface Block {
  readonly selector: string;
  readonly body: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every `selector { declarations }` pair, flattened to one selector string. */
function blocks(css: string): Block[] {
  const source = stripComments(css);
  const found: Block[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    found.push({ selector: match[1].trim(), body: match[2] });
  }
  return found;
}

function blocksFor(css: string, selector: string): Block[] {
  return blocks(css).filter((block) =>
    block.selector
      .split(',')
      .map((part) => part.trim())
      .includes(selector),
  );
}

function declarations(body: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of body.split(';')) {
    const index = part.indexOf(':');
    if (index < 0) continue;
    map.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return map;
}

const HUD_BLOCKS = blocks(HUD);
const TOKEN_BLOCKS = blocks(TOKENS);
const TOKEN_DECLARATIONS = new Map(
  TOKEN_BLOCKS.flatMap((block) => [...declarations(block.body).entries()]),
);

describe('HUD stylesheet: the fixed, click-through layer', () => {
  it('takes the layer out of the document flow and leaves the canvas its window', () => {
    const [root] = blocksFor(HUD, '.hud-root');
    expect(root, '.hud-root must exist').toBeDefined();
    const decls = declarations(root.body);
    expect(decls.get('position')).toBe('fixed');
    expect(decls.get('inset')).toBe('0');
    expect(decls.get('height')).toBe('100dvh');
    expect(decls.get('z-index')).toBe('var(--hud-z-hud)');
  });

  it('never captures a tap outside its own controls', () => {
    const [root] = blocksFor(HUD, '.hud-root');
    expect(declarations(root.body).get('pointer-events')).toBe('none');

    // Every surface that must accept a tap is an explicit, bounded node.
    const autoSelectors = [
      '.hud-top-bar button',
      '.hud-panel',
      '.hud-toast-root > *',
      '.hud-sheet',
      '.hud-sheet-scrim',
    ];
    for (const selector of autoSelectors) {
      const found = blocksFor(HUD, selector);
      expect(found.length, `${selector} must be declared`).toBeGreaterThan(0);
      expect(
        found.map((block) => declarations(block.body).get('pointer-events')),
        `${selector} must re-enable pointer events`,
      ).toContain('auto');
    }
  });

  it('does not set pointer-events: auto on any full-window node', () => {
    for (const block of HUD_BLOCKS) {
      const decls = declarations(block.body);
      if (decls.get('pointer-events') !== 'auto') continue;
      // The open sheet's scrim is the one deliberate exception (§6.2): a tap
      // on it closes the sheet, and it only exists while the modal is open.
      if (block.selector === '.hud-sheet-scrim') continue;
      // A full-window node is `inset: 0` (or all four edges) *and* fixed or
      // absolute. Panels are sized inline and never span the window.
      const spansWindow =
        decls.get('inset') === '0' ||
        (decls.get('top') === '0' &&
          decls.get('right') === '0' &&
          decls.get('bottom') === '0' &&
          decls.get('left') === '0');
      expect(spansWindow, `${block.selector} takes taps across the window`).toBe(
        false,
      );
    }
  });
});

describe('HUD stylesheet: the z ladder comes from tokens only', () => {
  it('writes no bare z-index in the HUD rules', () => {
    for (const block of HUD_BLOCKS) {
      const value = declarations(block.body).get('z-index');
      if (value === undefined) continue;
      expect(value, `${block.selector} writes a bare z-index`).toMatch(
        /^var\(--hud-z-[a-z-]+\)$/,
      );
    }
  });

  it('defines the committed ladder in one token block, in order', () => {
    const ladder = [
      '--hud-z-canvas',
      '--hud-z-scene',
      '--hud-z-hud',
      '--hud-z-sheet-scrim',
      '--hud-z-sheet',
      '--hud-z-toast',
    ];
    const values = ladder.map((token) => {
      const value = TOKEN_DECLARATIONS.get(token);
      expect(value, `${token} must be defined`).toBeDefined();
      return Number(value);
    });
    expect(values).toEqual([0, 10, 20, 30, 40, 50]);
  });
});

describe('HUD stylesheet: the committed visual tokens (3d_hud.md §8)', () => {
  it('keeps the panel alpha at or above the AA floor and the scrim at 45 %', () => {
    const surface = TOKEN_DECLARATIONS.get('--hud-surface') ?? '';
    const alpha = Number(/rgba\([^)]*,\s*([0-9.]+)\s*\)/.exec(surface)?.[1]);
    expect(Number.isFinite(alpha)).toBe(true);
    expect(alpha).toBeGreaterThanOrEqual(0.84);

    const scrim = TOKEN_DECLARATIONS.get('--hud-scrim') ?? '';
    const scrimAlpha = Number(/rgba\([^)]*,\s*([0-9.]+)\s*\)/.exec(scrim)?.[1]);
    expect(scrimAlpha).toBeCloseTo(0.45, 2);
  });

  it('fixes the type scale in rem, never in viewport units', () => {
    for (const block of HUD_BLOCKS) {
      const decls = declarations(block.body);
      for (const property of ['font-size', 'line-height']) {
        const value = decls.get(property);
        if (value === undefined) continue;
        expect(value, `${block.selector} ${property} uses vw/vh`).not.toMatch(
          /\d(vw|vh|vmin|vmax|dvh|dvw)\b/,
        );
      }
    }
    for (const token of ['--hud-text-xs', '--hud-text-sm', '--hud-text-md']) {
      expect(TOKEN_DECLARATIONS.get(token)).toMatch(/^[\d.]+rem$/);
    }
    expect(TOKEN_DECLARATIONS.get('--hud-tap')).toBe('44px');
  });

  it('gives the result card only a bounded fade, suppressed by reduced motion', () => {
    // The 2D summary's own entrance animation is neutralised; the card fades
    // for at most 120 ms when motion is allowed, and not at all when it is not.
    const summary = blocksFor(HUD, '.hud-result-card .answer-summary')[0];
    expect(summary).toBeDefined();
    expect(declarations(summary.body).get('animation')).toBe('none');
    expect(HUD).toMatch(
      /\.hud-root\[data-reduced-motion='false'\] \.hud-result-card-content \{[^}]*animation: hud-fade-in 120ms/,
    );
    expect(HUD).toMatch(
      /@media \(prefers-reduced-motion: reduce\) \{[^}]*\.hud-result-card-content \{[^}]*animation: none/,
    );
  });

  it('paints the result tone on the whole panel edge, not an inner box', () => {
    // The outline is the card's outer edge (the panel), so the panel's own
    // padding is the gap to the card's controls (user request 2026-11-20).
    const tones = [
      ['correct', '--hud-tone-ok', '--hud-ok'],
      ['contested', '--hud-tone-warn', '--hud-warn'],
      ['incorrect', '--hud-tone-bad', '--hud-bad'],
    ] as const;
    for (const [tone, surface, border] of tones) {
      const [block] = blocksFor(
        HUD,
        `.hud-panel[data-slot='result'][data-tone='${tone}']`,
      );
      expect(block, tone).toBeDefined();
      const decls = declarations(block.body);
      expect(decls.get('background-color')).toBe(`var(${surface})`);
      expect(decls.get('border-color')).toBe(`var(${border})`);
    }
    // No inner result box may paint its own tone surface.
    expect(HUD).not.toMatch(/\.hud-result-card-content\[data-tone/);
  });

  it('pins the setup trigger to the layout’s reserved box (3D-H4)', () => {
    const [setup] = blocksFor(HUD, '.hud-top-bar__setup');
    expect(setup).toBeDefined();
    const decls = declarations(setup.body);
    // The collision gate checks `HUD_SETUP_TRIGGER_WIDTH`; the button must be
    // exactly that box, or the gate would be checking a rect nobody paints.
    expect(decls.get('min-width')).toBe(`${HUD_SETUP_TRIGGER_WIDTH}px`);
    expect(decls.get('min-height')).toBe('var(--hud-tap)');
    expect(decls.get('box-sizing')).toBe('border-box');
  });

  it('reads the safe-area insets in exactly one probe, with no layout impact', () => {    const [probe] = blocksFor(HUD, '.hud-inset-probe');
    expect(probe).toBeDefined();
    const decls = declarations(probe.body);
    expect(decls.get('padding')).toMatch(/env\(safe-area-inset-top\)/);
    expect(decls.get('padding')).toMatch(/env\(safe-area-inset-left\)/);
    expect(decls.get('width')).toBe('0');
    expect(decls.get('height')).toBe('0');

    // No other HUD rule pads or margins for the notch: insets are inputs to
    // `hudLayout()`, applied to the top bar's padding only (§6.3).
    const envUsers = HUD_BLOCKS.filter((block) =>
      /safe-area-inset/.test(block.body),
    ).map((block) => block.selector);
    expect(envUsers).toEqual(['.hud-inset-probe']);
  });
});
