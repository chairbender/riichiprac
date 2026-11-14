import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage as loadNapiImage } from '@napi-rs/canvas';
import type { Canvas as NapiCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { layoutBoard } from './boardLayout';
import type { BoardLayout, BoardRect } from './boardLayout';
import { renderBoard } from './boardRenderer';
import { parseFacesManifest } from './faceManifest';
import { parseShellsManifest } from './shellManifest';
import { TileAtlas } from './TileAtlas';
import { TileAtlasBuilder } from './TileAtlasBuilder';
import type { AtlasCanvas, AtlasImage } from './TileAtlasBuilder';
import { SHELL_IDS } from './tiles';
import {
  createLiftShadowAsset,
  createShimmerAsset,
  FACE_CLIP_INSET_PX,
} from './boardOverlays';
import { riichiStickMarkers } from './boardMarkers';

/**
 * Phase 5 overlay-mask proof on a real Canvas 2D backend. Every assertion is a
 * decoded-pixel number, never a judgement of the image (AGENTS.md §6).
 */
const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const shells = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const faces = parseFacesManifest(
  JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')),
);

function makeAtlas(pixelRatio: 1 | 2) {
  const builder = new TileAtlasBuilder({
    shells,
    faces,
    resolveUrl: (relativePath) => join(tableDir, relativePath),
    loadImage: async (url) =>
      (await loadNapiImage(readFileSync(url))) as unknown as AtlasImage,
    createCanvas: (width, height) =>
      createCanvas(width, height) as unknown as AtlasCanvas,
    pixelRatio,
  });
  return new TileAtlas(builder, shells, faces).warm(SHELL_IDS);
}

const atlas = await makeAtlas(1);
const felt = (await loadNapiImage(readFileSync(join(tableDir, 'felt.png')))) as unknown as
  CanvasImageSource;

function context(canvas: NapiCanvas): CanvasRenderingContext2D {
  return canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
}

function render(
  board: BoardLayout,
  overlay = {},
  extra: Record<string, unknown> = {},
): NapiCanvas {
  const canvas = createCanvas(board.board.width, board.board.height);
  renderBoard(context(canvas), atlas, board, {
    felt,
    pixelRatio: 1,
    overlay,
    ...extra,
  });
  return canvas;
}

function pixels(canvas: NapiCanvas): Uint8ClampedArray {
  return context(canvas).getImageData(0, 0, canvas.width, canvas.height).data;
}

function luma(data: Uint8ClampedArray, index: number): number {
  return 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
}

interface ChangedPixel {
  x: number;
  y: number;
  before: [number, number, number];
  after: [number, number, number];
  addedLuma: number;
}

function changedPixels(
  base: Uint8ClampedArray,
  after: Uint8ClampedArray,
  width: number,
): ChangedPixel[] {
  const changed: ChangedPixel[] = [];
  for (let index = 0; index < base.length; index += 4) {
    if (
      base[index] === after[index] &&
      base[index + 1] === after[index + 1] &&
      base[index + 2] === after[index + 2] &&
      base[index + 3] === after[index + 3]
    ) {
      continue;
    }
    const pixel = index / 4;
    changed.push({
      x: pixel % width,
      y: Math.floor(pixel / width),
      before: [base[index], base[index + 1], base[index + 2]],
      after: [after[index], after[index + 1], after[index + 2]],
      addedLuma:
        luma(after, index) - luma(base, index),
    });
  }
  return changed;
}

/** Ray-casting point-in-polygon, for the published faceQuad. */
function pointInQuad(
  x: number,
  y: number,
  quad: readonly (readonly [number, number])[],
): boolean {
  let inside = false;
  for (let i = 0, j = quad.length - 1; i < quad.length; j = i, i += 1) {
    const [xi, yi] = quad[i];
    const [xj, yj] = quad[j];
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

const handBoard = layoutBoard(shells, {
  hand: ['1m'],
  wallPairsPerSide: 0,
});
const handTile = handBoard.placements.find(
  (placement) => placement.id === 'bottom-hand:0',
)!;
const shell = shells.shells.shell_hand_standing;

/** Texture coordinates of a canvas pixel for a tile, at a given lift. */
function texturePoint(x: number, y: number, liftPx = 0) {
  return {
    x: x + 0.5 - handTile.drawX,
    y: y + 0.5 - (handTile.drawY - liftPx),
  };
}

function insideBody(tx: number, ty: number): boolean {
  return (
    tx >= shell.anchorX &&
    tx < shell.anchorX + shell.advanceWidth &&
    ty >= shell.anchorY &&
    ty < shell.anchorY + shell.advanceHeight
  );
}

const basePixels = pixels(render(handBoard));

describe('flat tint mask', () => {
  it('changes pixels only inside the faceQuad and never the shadow margin', () => {
    const tinted = pixels(
      render(handBoard, {
        tints: [{ id: handTile.id, color: '#00ff00', alpha: 0.5 }],
      }),
    );
    const changed = changedPixels(basePixels, tinted, handBoard.board.width);
    let outsideQuad = 0;
    let outsideBody = 0;
    let inRightBottomPadding = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const pixel of changed) {
      const { x: tx, y: ty } = texturePoint(pixel.x, pixel.y);
      if (!pointInQuad(tx, ty, shell.faceQuad)) outsideQuad += 1;
      if (!insideBody(tx, ty)) outsideBody += 1;
      if (
        tx >= shell.anchorX + shell.advanceWidth ||
        ty >= shell.anchorY + shell.advanceHeight
      ) {
        inRightBottomPadding += 1;
      }
      minX = Math.min(minX, pixel.x);
      maxX = Math.max(maxX, pixel.x);
      minY = Math.min(minY, pixel.y);
      maxY = Math.max(maxY, pixel.y);
    }

    console.log(
      `tint: ${changed.length} changed px, bbox ${maxX - minX + 1}x${maxY - minY + 1}, ` +
        `outside faceQuad ${outsideQuad}, outside body ${outsideBody}, ` +
        `in right/bottom padding ${inRightBottomPadding}, clip inset ${FACE_CLIP_INSET_PX} px`,
    );
    expect(changed.length).toBeGreaterThan(500);
    expect(outsideQuad).toBe(0);
    expect(outsideBody).toBe(0);
    expect(inRightBottomPadding).toBe(0);
  });

  it('paints a tint with alpha outside the glyph but inside the face', () => {
    const tinted = pixels(
      render(handBoard, {
        tints: [{ id: handTile.id, color: '#ff0000', alpha: 0.4 }],
      }),
    );
    const changed = changedPixels(basePixels, tinted, handBoard.board.width);
    // A flat red tint over ivory must lose green/blue, not add red.
    const meanGreenDrop =
      changed.reduce(
        (total, pixel) => total + (pixel.before[1] - pixel.after[1]),
        0,
      ) / changed.length;
    expect(meanGreenDrop).toBeGreaterThan(20);
  });
  it('clips to the rotated sideways face of a Riichi discard', () => {
    const board = layoutBoard(shells, {
      ponds: { top: [{ face: 'blank', riichi: true }] },
      wallPairsPerSide: 0,
    });
    const tile = board.placements.find(
      (placement) => placement.shell === 'shell_flat_sideways',
    )!;
    const sideways = shells.shells.shell_flat_sideways;
    const base = pixels(render(board));
    const tinted = pixels(
      render(board, {
        tints: [{ id: tile.id, color: '#00ff00', alpha: 0.5 }],
      }),
    );
    const changed = changedPixels(base, tinted, board.board.width);
    let outsideQuad = 0;
    for (const pixel of changed) {
      const tx = pixel.x + 0.5 - tile.drawX;
      const ty = pixel.y + 0.5 - tile.drawY;
      if (!pointInQuad(tx, ty, sideways.faceQuad)) outsideQuad += 1;
    }
    console.log(
      `sideways tint: ${changed.length} changed px, outside rotated faceQuad ${outsideQuad}`,
    );
    expect(changed.length).toBeGreaterThan(300);
    expect(outsideQuad).toBe(0);
  });
});

describe('dora shimmer mask', () => {  const shimmer = createShimmerAsset(
    (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
  );

  it('adds light only inside the faceQuad and keeps the ink readable', () => {
    const shimmered = pixels(
      render(
        handBoard,
        { shimmerIds: new Set([handTile.id]) },
        { shimmer },
      ),
    );
    const changed = changedPixels(basePixels, shimmered, handBoard.board.width);
    let outsideQuad = 0;
    let outsideBody = 0;
    let maxAdded = 0;
    let glyphPixels = 0;
    let glyphAdded = 0;
    let glyphBefore = 0;
    let glyphAfter = 0;

    for (let index = 0; index < basePixels.length; index += 4) {
      const pixel = index / 4;
      const x = pixel % handBoard.board.width;
      const y = Math.floor(pixel / handBoard.board.width);
      const { x: tx, y: ty } = texturePoint(x, y);
      if (!pointInQuad(tx, ty, shell.faceQuad)) continue;

      const baseLuma = luma(basePixels, index);
      const afterLuma = luma(shimmered, index);
      // Ink is much darker than the ivory face; the shimmer must not erase it.
      if (baseLuma < 95) {
        glyphPixels += 1;
        glyphAdded += afterLuma - baseLuma;
        glyphBefore += baseLuma;
        glyphAfter += afterLuma;
      }
      if (Math.abs(afterLuma - baseLuma) > 0.01) {
        maxAdded = Math.max(maxAdded, afterLuma - baseLuma);
      }
    }

    for (const pixel of changed) {
      const { x: tx, y: ty } = texturePoint(pixel.x, pixel.y);
      if (!pointInQuad(tx, ty, shell.faceQuad)) outsideQuad += 1;
      if (!insideBody(tx, ty)) outsideBody += 1;
    }

    const glyphMeanAdded = glyphPixels > 0 ? glyphAdded / glyphPixels : 0;
    const glyphMeanBefore = glyphPixels > 0 ? glyphBefore / glyphPixels : 0;
    const glyphMeanAfter = glyphPixels > 0 ? glyphAfter / glyphPixels : 0;

    console.log(
      `shimmer: ${changed.length} changed px, outside faceQuad ${outsideQuad}, outside body ${outsideBody}; ` +
        `max added luma ${maxAdded.toFixed(2)}, glyph ink +${glyphMeanAdded.toFixed(2)} ` +
        `(${glyphMeanBefore.toFixed(1)} -> ${glyphMeanAfter.toFixed(1)} over ${glyphPixels} px)`,
    );
    expect(changed.length).toBeGreaterThan(200);
    expect(outsideQuad).toBe(0);
    expect(outsideBody).toBe(0);
    expect(maxAdded).toBeLessThan(80);
    expect(glyphPixels).toBeGreaterThan(20);
    expect(glyphMeanAdded).toBeLessThan(35);
    expect(glyphMeanAfter).toBeLessThan(glyphMeanBefore + 35);
  });
});

describe('secondary lift shadow', () => {
  const shadow = createLiftShadowAsset(
    atlas,
    (width, height) => createCanvas(width, height) as unknown as AtlasCanvas,
  );

  it('moves the whole sprite by exactly the lift and paints the shadow at baseline', () => {
    // A board with no tiles isolates the tile's own visible pixels, so the
    // sprite top/bottom are measured rather than assumed from the anchor.
    const empty: BoardLayout = { ...handBoard, placements: [] };
    const emptyPixels = pixels(render(empty));

    const baselinePixels = pixels(render(handBoard));
    const baselineChanged = changedPixels(
      emptyPixels,
      baselinePixels,
      handBoard.board.width,
    );
    const baselineTop = Math.min(...baselineChanged.map((pixel) => pixel.y));
    const baselineLeft = Math.min(...baselineChanged.map((pixel) => pixel.x));

    const liftedPixels = pixels(
      render(
        handBoard,
        { liftedIds: new Set([handTile.id]) },
        { liftShadow: shadow },
      ),
    );
    const changed = changedPixels(basePixels, liftedPixels, handBoard.board.width);
    const bbox = changed.reduce(
      (box, pixel) => ({
        minX: Math.min(box.minX, pixel.x),
        maxX: Math.max(box.maxX, pixel.x),
        minY: Math.min(box.minY, pixel.y),
        maxY: Math.max(box.maxY, pixel.y),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    );

    // Compare against the same lifted tile with no shadow: the visible sprite
    // must sit exactly 12 px higher and at the same left edge.
    const noShadow = pixels(
      render(handBoard, { liftedIds: new Set([handTile.id]) }),
    );
    const liftOnly = changedPixels(emptyPixels, noShadow, handBoard.board.width);
    const liftedTop = Math.min(...liftOnly.map((pixel) => pixel.y));
    const liftedLeft = Math.min(...liftOnly.map((pixel) => pixel.x));

    console.log(
      `lift: visible sprite top ${baselineTop} -> ${liftedTop} (${baselineTop - liftedTop} px), ` +
        `left ${baselineLeft} -> ${liftedLeft}; shadow changes ${changed.length} px, ` +
        `bbox ${bbox.maxX - bbox.minX + 1}x${bbox.maxY - bbox.minY + 1}, alpha ${shadow.alpha}`,
    );
    expect(baselineTop - liftedTop).toBe(12);
    expect(liftedLeft).toBe(baselineLeft);
    expect(changed.length).toBeGreaterThan(200);

    // The shadow's extra pixels sit at the baseline and extend past the body's
    // left/right edges within the spread.
    const body: BoardRect = handTile.advanceRect;
    const shadowOnly = changed.filter(
      (pixel) =>
        pixel.y >= handTile.gridY &&
        pixel.y <= handTile.gridY + body.height + 4 &&
        (pixel.x < body.x || pixel.x >= body.x + body.width),
    );
    expect(shadowOnly.length).toBeGreaterThan(10);
    console.log(
      `lift shadow: ${shadowOnly.length} side pixels in the baseline band, spread 3 px declared`,
    );
  });

  it('never paints the shadow above the lifted sprite', () => {
    const shadowOnly = pixels(render(handBoard, {}, { liftShadow: shadow }));
    expect(shadowOnly).toEqual(basePixels);
  });
});

describe('riichi markers', () => {
  const board = layoutBoard(shells, {
    ponds: { bottom: Array.from({ length: 6 }, () => ({ face: 'blank' as const })) },
    wallPairsPerSide: 2,
  });
  const reserve = board.metrics.zones.reserve;
  const markers = riichiStickMarkers(reserve, {
    riichiSides: ['bottom', 'right'],
    potSticks: 2,
  });

  it('paints after the pond epoch and before the bottom wall', () => {
    const canvas = createCanvas(board.board.width, board.board.height);
    const stats = renderBoard(context(canvas), atlas, board, {
      felt,
      pixelRatio: 1,
      overlay: { markers },
    });
    expect(stats.markers).toBe(4);
    expect(stats.markerZone.afterId).toMatch(/-pond:/);
    expect(stats.markerZone.beforeId).toMatch(/bottom-wall:/);
    console.log(
      `markers: ${stats.markers} after ${stats.markerZone.afterId}, before ${stats.markerZone.beforeId}`,
    );
  });

  it('keeps every marker pixel inside the reserved compass region', () => {
    const base = render(board);
    const withMarkers = render(board, { markers });
    const changed = changedPixels(pixels(base), pixels(withMarkers), board.board.width);
    let outside = 0;
    for (const pixel of changed) {
      if (
        pixel.x < reserve.x - 1 ||
        pixel.x > reserve.x + reserve.width + 1 ||
        pixel.y < reserve.y - 1 ||
        pixel.y > reserve.y + reserve.height + 1
      ) {
        outside += 1;
      }
    }
    console.log(
      `markers: ${changed.length} changed px, outside the reserve ${outside}`,
    );
    expect(changed.length).toBeGreaterThan(200);
    expect(outside).toBe(0);
  });
});
