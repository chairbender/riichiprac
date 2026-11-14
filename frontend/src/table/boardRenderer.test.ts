import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage as loadNapiImage } from '@napi-rs/canvas';
import type { Canvas as NapiCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { paintOrder, paintOrderSnapshot, renderBoard } from './boardRenderer';
import type { PaintOrderEntry } from './boardRenderer';
import { TileAtlas } from './TileAtlas';
import { parseFacesManifest } from './faceManifest';
import { parseShellsManifest } from './shellManifest';
import { TileAtlasBuilder } from './TileAtlasBuilder';
import type { AtlasCanvas, AtlasImage, BakedTileSprite } from './TileAtlasBuilder';
import { SHELL_IDS } from './tiles';
import { fullBoardLayout } from './fixtures/fullBoard';

/**
 * The renderer is exercised on a real Canvas 2D implementation
 * (`@napi-rs/canvas`), so the draw-order and felt assertions are about decoded
 * pixels and recorded calls, not a mock's opinion. AGENTS.md §6: the review
 * PNGs this produces are for the user; these tests only assert numbers.
 */
const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const shells = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));

function builder(pixelRatio: 1 | 2): TileAtlasBuilder {
  return new TileAtlasBuilder({
    shells,
    faces,
    resolveUrl: (relativePath) => join(tableDir, relativePath),
    loadImage: async (url) =>
      (await loadNapiImage(readFileSync(url))) as unknown as AtlasImage,
    createCanvas: (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
    pixelRatio,
  });
}

const atlas1x = await new TileAtlas(builder(1), shells, faces).warm(SHELL_IDS);
const felt = (await loadNapiImage(readFileSync(join(tableDir, 'felt.png')))) as unknown as
  CanvasImageSource;

const layout = fullBoardLayout(shells);
const board = layout.board;

function context(canvas: NapiCanvas): CanvasRenderingContext2D {
  return canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
}

function pixels(
  canvas: NapiCanvas,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  return context(canvas).getImageData(
    Math.max(0, Math.round(x)),
    Math.max(0, Math.round(y)),
    Math.max(1, Math.round(width)),
    Math.max(1, Math.round(height)),
  ).data;
}

function luma(data: Uint8ClampedArray): number {
  let total = 0;
  const count = data.length / 4;
  for (let index = 0; index < data.length; index += 4) {
    total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
  }
  return total / count;
}

function meanLuma(
  canvas: NapiCanvas,
  x: number,
  y: number,
  width: number,
  height: number,
): number {
  return luma(pixels(canvas, x, y, width, height));
}

/** A 2D context stub that records the transform and every blit. */
function recordingContext(width: number, height: number) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const record = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
  };
  const context = {
    canvas: { width, height },
    save: record('save'),
    restore: record('restore'),
    setTransform: record('setTransform'),
    translate: record('translate'),
    scale: record('scale'),
    clearRect: record('clearRect'),
    fillRect: record('fillRect'),
    drawImage: record('drawImage'),
    imageSmoothingEnabled: true,
    imageSmoothingQuality: 'low',
    fillStyle: '#000000',
  };
  return { context: context as unknown as CanvasRenderingContext2D, calls };
}

/** An atlas stub: every lookup resolves to the same logical sprite metrics. */
function stubAtlas(sizes: Readonly<Record<string, { width: number; height: number }>>) {
  return {
    getSprite: (key: string): BakedTileSprite => {
      const [shell] = key.split(':');
      const size = sizes[shell] ?? { width: 44, height: 59 };
      return {
        key: key as BakedTileSprite['key'],
        shell: shell as BakedTileSprite['shell'],
        face: 'blank',
        pageIndex: 0,
        uv: { x: 0, y: 0, width: size.width, height: size.height },
        pixelRatio: 1,
        hasGlyph: false,
        texWidth: size.width,
        texHeight: size.height,
        anchorX: 2,
        anchorY: 2,
        advanceWidth: size.width - 6,
        advanceHeight: size.height - 6,
        gridStepPx: { x: [0, 0], y: [0, 0] },
        faceQuad: [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ],
        faceRotationDeg: 0,
      };
    },
    getPage: () => ({ canvas: {} }),
    shells,
  } as unknown as TileAtlas;
}

describe('paint order', () => {
  it('returns every placement once, sorted by its contiguous drawOrder', () => {
    const ordered = paintOrder(layout);
    expect(ordered).toHaveLength(layout.placements.length);
    expect(new Set(ordered.map((placement) => placement.id)).size).toBe(ordered.length);
    expect(ordered.map((placement) => placement.drawOrder)).toEqual(
      ordered.map((_placement, index) => index),
    );
  });

  it('rejects a duplicate or a gap in the draw order', () => {
    const duplicated = {
      board,
      placements: layout.placements.map((placement, index) => ({
        ...placement,
        drawOrder: index === 1 ? 0 : index,
      })),
    };
    expect(() => paintOrder(duplicated)).toThrow(/not a permutation/);

    // Drop the last slot but keep n entries: the final index is out of range.
    const gap = {
      board,
      placements: layout.placements.map((placement, index) =>
        index === layout.placements.length - 1
          ? { ...placement, drawOrder: layout.placements.length }
          : placement,
      ),
    };
    expect(() => paintOrder(gap)).toThrow(/not a permutation/);
  });

  it('matches the committed paint-order fixture', () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/paint-order.json', import.meta.url));
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      board: { width: number; height: number };
      placementCount: number;
      order: PaintOrderEntry[];
    };
    expect(fixture.board).toEqual(board);
    expect(fixture.placementCount).toBe(layout.placements.length);
    expect(paintOrderSnapshot(layout)).toEqual(fixture.order);

    // The zones appear in the architecture §4.1 sequence, and the human's hand
    // is the very last tile on the board.
    const ids = fixture.order.map((entry) => entry.id);
    expect(ids[0]).toBe('top-hand:9');
    expect(ids[ids.length - 1]).toBe('bottom-hand:0');
    expect(ids.filter((id) => id.startsWith('top-hand:')).length).toBe(10);
    expect(ids.indexOf('top-wall:lower:9')).toBeGreaterThan(ids.indexOf('top-hand:0'));
    expect(ids.indexOf('left-wall:lower:0')).toBeGreaterThan(ids.indexOf('top-wall:upper:0'));
    expect(ids.indexOf('right-wall:lower:0')).toBeGreaterThan(
      ids.indexOf('left-wall:upper:9'),
    );
    expect(ids.indexOf('top-pond:0')).toBeGreaterThan(ids.indexOf('right-wall:upper:9'));
    expect(ids.indexOf('bottom-wall:lower:9')).toBeGreaterThan(ids.lastIndexOf('bottom-pond:'));
    expect(ids.indexOf('left-hand:0')).toBeGreaterThan(ids.indexOf('bottom-wall:upper:0'));
    expect(ids.indexOf('right-hand:0')).toBeGreaterThan(ids.lastIndexOf('left-meld:'));
    expect(ids.indexOf('bottom-hand:9')).toBeGreaterThan(ids.lastIndexOf('right-meld:'));
  });
});

describe('renderer draw sequence', () => {
  it('paints the felt first, then every tile at grid minus anchor in paint order', () => {
    const { context: fakeContext, calls } = recordingContext(board.width, board.height);
    const atlas = stubAtlas({
      shell_hand_standing: { width: 44, height: 60 },
      shell_flat_upright: { width: 44, height: 59 },
      shell_flat_sideways: { width: 60, height: 50 },
      shell_wall_horizontal: { width: 44, height: 60 },
      shell_wall_side_left: { width: 48, height: 58 },
      shell_wall_side_right: { width: 48, height: 58 },
    });

    const stats = renderBoard(fakeContext, atlas, layout, { felt, pixelRatio: 1 });
    expect(stats.tiles).toBe(layout.placements.length);
    expect(stats.feltPainted).toBe(true);
    expect(stats.firstTileId).toBe('top-hand:9');
    expect(stats.lastTileId).toBe('bottom-hand:0');

    const ops = calls.map((call) => call.op);
    expect(ops.slice(0, 5)).toEqual(['save', 'setTransform', 'clearRect', 'drawImage', 'setTransform']);
    expect(calls[1].args).toEqual([1, 0, 0, 1, 0, 0]);
    expect(calls[2].args).toEqual([0, 0, board.width, board.height]);
    expect(calls[3].args[0]).toBe(felt);
    expect(calls[3].args.slice(1)).toEqual([0, 0, board.width, board.height]);

    const fit = stats.fit;
    expect(fit.scale).toBeCloseTo(1, 10);
    expect(calls[4].args).toEqual([1, 0, 0, 1, 0, 0]);
    expect(calls[5]).toEqual({ op: 'translate', args: [fit.offsetX, fit.offsetY] });
    expect(calls[6]).toEqual({ op: 'scale', args: [fit.scale, fit.scale] });

    const blits = calls.filter((call) => call.op === 'drawImage').slice(1);
    const ordered = paintOrder(layout);
    expect(blits).toHaveLength(ordered.length);
    for (let index = 0; index < ordered.length; index += 1) {
      const placement = ordered[index];
      const shell = shells.shells[placement.shell];
      const args = blits[index].args;
      expect(args.slice(5)).toEqual([
        placement.gridX - shell.anchorX,
        placement.gridY - shell.anchorY,
        shell.texWidth,
        shell.texHeight,
      ]);
      expect(args.slice(1, 5)).toEqual([0, 0, args[3], args[4]]);
    }
    expect(ops[ops.length - 1]).toBe('restore');
  });

  it('maps the board into CSS px and scales by the pixel ratio', () => {
    const { context: fakeContext, calls } = recordingContext(1440, 1800);
    renderBoard(fakeContext, stubAtlas({}), layout, { felt, pixelRatio: 2 });
    const fit = { scale: Math.min(720 / board.width, 900 / board.height) };
    const translate = calls.find((call) => call.op === 'translate')!;
    const scale = calls.find((call) => call.op === 'scale')!;
    expect(translate.args[0]).toBeCloseTo((720 - board.width * fit.scale) / 2, 10);
    expect(translate.args[1]).toBeCloseTo((900 - board.height * fit.scale) / 2, 10);
    expect(scale.args).toEqual([fit.scale, fit.scale]);
  });
});

describe('full-board pixels', () => {
  it('covers the whole canvas with the felt and paints the hands and ponds on top', () => {
    const canvas = createCanvas(board.width, board.height);
    const stats = renderBoard(context(canvas), atlas1x, layout, { felt, pixelRatio: 1 });
    expect(stats.viewport).toEqual(board);

    // Every pixel is opaque: the felt is a full-screen raster, not a table edge.
    const all = pixels(canvas, 0, 0, board.width, board.height);
    let transparent = 0;
    for (let index = 3; index < all.length; index += 4) {
      if (all[index] !== 255) transparent += 1;
    }
    expect(transparent).toBe(0);

    // The corners are the baked vignette, the empty compass centre is felt, and
    // a hand tile is ivory: the board really is composited over the felt.
    const corner = meanLuma(canvas, 0, 0, 4, 4);
    const centre = meanLuma(canvas, board.width / 2 - 2, board.height / 2 - 2, 4, 4);
    const handTile = layout.placements.find(
      (placement) => placement.seat === 'bottom' && placement.kind === 'hand',
    )!;
    const face = meanLuma(
      canvas,
      handTile.gridX + 10,
      handTile.gridY + 12,
      18,
      26,
    );
    console.log(
      `render 1x ${board.width}x${board.height}: corner luma ${corner.toFixed(2)}, ` +
        `centre felt luma ${centre.toFixed(2)}, hand face luma ${face.toFixed(2)}, ` +
        `${stats.tiles} tiles`,
    );
    expect(corner).toBeLessThan(55);
    expect(centre).toBeGreaterThan(45);
    expect(face).toBeGreaterThan(110);
    expect(face).toBeGreaterThan(corner + 60);
  });

  it('renders over the full-screen felt at every viewport size', () => {
    const viewports = [
      { width: 390, height: 844 },
      { width: 844, height: 390 },
      { width: 1440, height: 900 },
      { width: 320, height: 480 },
      { width: 1024, height: 768 },
    ];
    for (const viewport of viewports) {
      const canvas = createCanvas(viewport.width, viewport.height);
      const stats = renderBoard(context(canvas), atlas1x, layout, { felt, pixelRatio: 1 });
      expect(stats.tiles).toBe(layout.placements.length);
      const fit = stats.fit;
      expect(fit.boardWidth * fit.scale).toBeLessThanOrEqual(viewport.width + 1e-9);
      expect(fit.boardHeight * fit.scale).toBeLessThanOrEqual(viewport.height + 1e-9);
      expect(fit.offsetX).toBeGreaterThanOrEqual(-1e-9);
      expect(fit.offsetY).toBeGreaterThanOrEqual(-1e-9);

      const all = pixels(canvas, 0, 0, viewport.width, viewport.height);
      let transparent = 0;
      for (let index = 3; index < all.length; index += 4) {
        if (all[index] !== 255) transparent += 1;
      }
      expect(transparent, `${viewport.width}x${viewport.height}`).toBe(0);

      const handTile = layout.placements.find(
        (placement) => placement.seat === 'bottom' && placement.kind === 'hand',
      )!;
      const screenX = fit.offsetX + (handTile.gridX + handTile.advanceRect.width / 2) * fit.scale;
      const screenY = fit.offsetY + (handTile.gridY + handTile.advanceRect.height / 2) * fit.scale;
      const face = meanLuma(canvas, screenX - 3, screenY - 3, 6, 6);
      const corner = meanLuma(canvas, 0, 0, 4, 4);
      console.log(
        `render ${viewport.width}x${viewport.height}: scale ${fit.scale.toFixed(4)}, ` +
          `tile ${(handTile.advanceRect.width * fit.scale).toFixed(2)}x` +
          `${(handTile.advanceRect.height * fit.scale).toFixed(2)} css px, ` +
          `corner luma ${corner.toFixed(2)}, hand luma ${face.toFixed(2)}`,
      );
      expect(face).toBeGreaterThan(90);
      expect(face).toBeGreaterThan(corner + 30);
    }
  });

  it('uses no WebGL, 3D or per-frame shadow code', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./boardRenderer.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(
      /getContext\(['"]webgl|WebGLRenderingContext|WebGLRenderer|from ['"]three|from ['"]babylon|createRadialGradient|shadowBlur/,
    );
    // Tiles are only ever blitted through the atlas helper.
    expect(source).toMatch(/blitTileSprite/);
    expect(source.match(/\.drawImage\(/g)).toHaveLength(1); // the felt stretch
  });
});
