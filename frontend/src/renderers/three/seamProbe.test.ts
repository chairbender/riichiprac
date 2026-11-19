/**
 * The seam and aliasing probes (3D-20).
 *
 * The probes are the unit's only acceptance instrument, so their arithmetic is
 * tested without a GPU: a synthetic pixel source with a known profile must
 * produce the contrast, depth and pass/fail those numbers imply, and a hard
 * edge must read as a hard edge while a blended one reads as anti-aliased. The
 * geometry half is checked against the committed layout (four seam families,
 * a real 0.0107-unit groove, samples inside the drawing buffer).
 */

import { describe, expect, it } from 'vitest';

import { boardFixture } from './boardFixture';
import { frameForAspect, layoutBoard } from './boardLayout';
import { GAP, tileGaps } from './gaps';
import {
  EDGE_GATE,
  EDGE_SCAN_LINES,
  SEAM_GATE,
  classifySeamPixel,
  edgeScans,
  readEdge,
  readSeam,
  seamRaster,
  seamRasters,
  seamTargets,
} from './seamProbe';
import type { SeamPixelSource } from './seamProbe';

const layout = layoutBoard(boardFixture());
const frame = frameForAspect(16 / 9, layout);
const WIDTH = 1280;
const HEIGHT = 720;

/** A pixel source that paints one 8-bit sRGB value per screen-space x/y. */
function rgbSource(
  width: number,
  height: number,
  rgbAt: (x: number, y: number) => readonly [number, number, number],
): SeamPixelSource {
  return {
    width,
    height,
    read(x, y, readWidth, readHeight) {
      const pixels = new Uint8Array(readWidth * readHeight * 4);
      for (let row = 0; row < readHeight; row += 1) {
        for (let column = 0; column < readWidth; column += 1) {
          const [r, g, b] = rgbAt(x + column, y + row);
          const index = (row * readWidth + column) * 4;
          pixels[index] = r;
          pixels[index + 1] = g;
          pixels[index + 2] = b;
          pixels[index + 3] = 255;
        }
      }
      return pixels;
    },
  };
}

/** A pixel source that paints horizontal bands of luma in a screen-space x run. */
function bandSource(
  width: number,
  height: number,
  lumaAt: (x: number, y: number) => number,
): SeamPixelSource {
  return {
    width,
    height,
    read(x, y, readWidth, readHeight) {
      const pixels = new Uint8Array(readWidth * readHeight * 4);
      for (let row = 0; row < readHeight; row += 1) {
        for (let column = 0; column < readWidth; column += 1) {
          const value = Math.max(0, Math.min(255, Math.round(lumaAt(x + column, y + row))));
          const index = (row * readWidth + column) * 4;
          pixels[index] = value;
          pixels[index + 1] = value;
          pixels[index + 2] = value;
          pixels[index + 3] = 255;
        }
      }
      return pixels;
    },
  };
}

describe('3D seam probe (3D-20)', () => {
  it('picks one seam from each committed family, all of them real contacts', () => {
    const targets = seamTargets(layout, { frame, widthPx: WIDTH, heightPx: HEIGHT });
    const kinds = targets.map((target) => target.kind);
    expect(kinds.sort()).toEqual(['hand-row', 'pond-row', 'wall-stack', 'wall-tier']);
    const byId = new Map(layout.tiles.map((tile) => [tile.id, tile]));
    for (const target of targets) {
      const a = byId.get(target.aId);
      const b = byId.get(target.bId);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // The pair must be in contact, so a probe can never measure a gap that is
      // meant to be open (the drawn tile, an empty pond cell).
      expect(GAP.touchingUnits).toBeGreaterThan(0);
      const gap = tileGaps(layout.tiles, { withinUnits: 1 }).find(
        (entry) =>
          (entry.aId === target.aId && entry.bId === target.bId) ||
          (entry.aId === target.bId && entry.bId === target.aId),
      );
      expect(gap).toBeDefined();
      expect(Math.abs(gap!.gapUnits)).toBeLessThanOrEqual(GAP.touchingUnits);
    }
  });

  it('projects two touching tiles\u2019 bevel valley into a measurable window', () => {
    const targets = seamTargets(layout, { frame, widthPx: WIDTH, heightPx: HEIGHT });
    const rasters = seamRasters(layout, frame, WIDTH, HEIGHT, targets);
    expect(rasters.length).toBe(targets.length);
    for (const raster of rasters) {
      // Contact is exact: the window is the two bevels either side of it.
      expect(Math.abs(raster.gapUnits)).toBeLessThanOrEqual(GAP.touchingUnits);
      expect(raster.spanPx).toBeGreaterThan(1);
      // Samples stay inside the drawing buffer.
      expect(raster.block.x).toBeGreaterThanOrEqual(0);
      expect(raster.block.y).toBeGreaterThanOrEqual(0);
      expect(raster.block.x + raster.block.width).toBeLessThanOrEqual(WIDTH);
      expect(raster.block.y + raster.block.height).toBeLessThanOrEqual(HEIGHT);
      expect(raster.samples.length).toBeGreaterThan(10);
    }
  });

  it('is deterministic for the same layout, frame and size', () => {
    const target = seamTargets(layout, { frame, widthPx: WIDTH, heightPx: HEIGHT })[0];
    expect(seamRaster(layout, target, frame, WIDTH, HEIGHT)).toEqual(
      seamRaster(layout, target, frame, WIDTH, HEIGHT),
    );
  });

  it('passes a groove and fails one the felt shows through', () => {
    const target = seamTargets(layout, { frame, widthPx: WIDTH, heightPx: HEIGHT }).find(
      (entry) => entry.kind === 'hand-row',
    )!;
    const raster = seamRaster(layout, target, frame, WIDTH, HEIGHT);
    const { x, width } = raster.block;
    const centre = x + Math.round(width / 2);

    // A closed seam: two bevels meeting, no felt in the valley.
    const closed = bandSource(WIDTH, HEIGHT, (px) => {
      const distance = Math.abs(px - centre);
      return distance <= 1 ? 150 : 235;
    });
    const sealed = readSeam(closed, raster);
    expect(sealed.leakPixels).toBe(0);
    expect(sealed.pass).toBe(true);

    // The defect: a slot in the middle of the seam showing the cloth through it.
    // The felt's own green (`#1a5038`) is the signature, not a luma band.
    const slot = rgbSource(WIDTH, HEIGHT, (px) =>
      Math.abs(px - centre) <= 2 ? [26, 80, 56] : [235, 235, 235],
    );
    const leaking = readSeam(slot, raster);
    expect(leaking.leakPixels).toBeGreaterThan(SEAM_GATE.maxLeakPixels);
    expect(leaking.pass).toBe(false);
    expect(leaking.detail).toContain('felt or clear colour');
  });

  it('attributes a bright seam pixel to the body, the cloth or the clear colour', () => {
    expect(classifySeamPixel([245, 240, 236])).toBe('body');
    expect(classifySeamPixel([26, 80, 56])).toBe('felt');
    expect(classifySeamPixel([11, 17, 22])).toBe('background');
    expect(classifySeamPixel([200, 40, 30])).toBe('other');
  });
});

describe('3D aliasing probe (3D-20)', () => {
  it('scans the human hand\u2019s outer silhouette on several parallel lines', () => {
    const scans = edgeScans(layout, frame, WIDTH, HEIGHT);
    expect(scans.length).toBe(EDGE_SCAN_LINES);
    for (const scan of scans) {
      expect(scan.id).toBe('hand-end');
      expect(scan.spanPx).toBeGreaterThan(4);
      expect(scan.block.x + scan.block.width).toBeLessThanOrEqual(WIDTH);
      expect(scan.block.y + scan.block.height).toBeLessThanOrEqual(HEIGHT);
    }
  });

  it('reads a hard step as no transition and a partial-coverage pixel as one', () => {
    const scans = edgeScans(layout, frame, WIDTH, HEIGHT);
    const { x, width } = scans[0].block;
    const centre = x + Math.round(width / 2);

    const hard = readEdge(
      bandSource(WIDTH, HEIGHT, (px) => (px < centre ? 235 : 45)),
      scans,
    );
    const soft = readEdge(
      bandSource(WIDTH, HEIGHT, (px) => (px < centre ? 235 : px === centre ? 150 : 45)),
      scans,
    );
    expect(hard.intermediates).toBe(0);
    expect(soft.intermediates).toBeGreaterThanOrEqual(EDGE_GATE.minIntermediates);
    expect(soft.maxStep).toBeLessThan(hard.maxStep);
  });
});

