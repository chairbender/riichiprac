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
import {
  EDGE_GATE,
  SEAM_GATE,
  classifySeamPixel,
  edgeScan,
  readEdge,
  readSeam,
  seamRaster,
  seamRasters,
  seamTargets,
} from './seamProbe';
import type { SeamPixelSource } from './seamProbe';
import { CREVICE, creviceGainAt } from './tileMaterial';
import { TILE } from '../layoutConstants';

const layout = layoutBoard(boardFixture());
const frame = frameForAspect(16 / 9, layout);
const WIDTH = 1280;
const HEIGHT = 720;

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
      const bits = [1, 2, 4, 8, 16, 32];
      expect(a!.contact & bits[target.axis * 2 + (target.sign > 0 ? 1 : 0)]).not.toBe(0);
    }
  });

  it('projects the committed 0.3 mm groove into a measurable window', () => {
    const targets = seamTargets(layout, { frame, widthPx: WIDTH, heightPx: HEIGHT });
    const rasters = seamRasters(layout, frame, WIDTH, HEIGHT, targets);
    expect(rasters.length).toBe(targets.length);
    for (const raster of rasters) {
      // Every pair is a row groove (0.0107) or the pond's 0.0071-unit groove.
      expect(Math.abs(raster.gapUnits)).toBeGreaterThan(0);
      expect(Math.abs(raster.gapUnits)).toBeLessThan(0.02);
      expect(raster.spanPx).toBeGreaterThan(1);
      // The window is the two bevels plus the groove, in pixels.
      expect(raster.spanPx / raster.gapUnits).toBeGreaterThan(20);
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

  it('reads a dark groove as a pass and a bright one as the defect', () => {
    const target = seamTargets(layout, { frame, widthPx: WIDTH, heightPx: HEIGHT }).find(
      (entry) => entry.kind === 'hand-row',
    )!;
    const raster = seamRaster(layout, target, frame, WIDTH, HEIGHT);
    const { x, width } = raster.block;
    const span = raster.spanPx;
    const centre = x + Math.round(width / 2);

    // A groove: bright faces, a dark band at the middle, and nothing brighter
    // than the faces.
    const groove = bandSource(WIDTH, HEIGHT, (px) => {
      const distance = Math.abs(px - centre);
      return distance <= span / 2 ? 40 : 235;
    });
    const dark = readSeam(groove, raster);
    expect(dark.pass).toBe(true);
    expect(dark.contrast).toBeGreaterThan(SEAM_GATE.minContrast);
    expect(dark.depth).toBeGreaterThan(SEAM_GATE.minDepth);

    // The defect: the same seam with a bright line down its middle.
    const brightLine = bandSource(WIDTH, HEIGHT, (px) => {
      const distance = Math.abs(px - centre);
      return distance <= 1 ? 250 : distance <= span / 2 ? 200 : 235;
    });
    const bright = readSeam(brightLine, raster);
    expect(bright.pass).toBe(false);
    expect(bright.contrast).toBeLessThan(SEAM_GATE.minContrast);
    expect(bright.detail).toContain('core');
  });

  it('attributes a bright seam pixel to the body, the cloth or the clear colour', () => {
    expect(classifySeamPixel([245, 240, 236])).toBe('body');
    expect(classifySeamPixel([26, 80, 56])).toBe('felt');
    expect(classifySeamPixel([11, 17, 22])).toBe('background');
    expect(classifySeamPixel([200, 40, 30])).toBe('other');
  });
});

describe('3D aliasing probe (3D-20)', () => {
  it('scans the human hand\u2019s outer silhouette from its face to the felt', () => {
    const scan = edgeScan(layout, frame, WIDTH, HEIGHT);
    expect(scan).not.toBeNull();
    expect(scan!.id).toBe('hand-end');
    expect(scan!.spanPx).toBeGreaterThan(4);
    expect(scan!.block.x + scan!.block.width).toBeLessThanOrEqual(WIDTH);
    expect(scan!.block.y + scan!.block.height).toBeLessThanOrEqual(HEIGHT);
  });

  it('reads a hard step as no transition and a partial-coverage pixel as one', () => {
    const scan = edgeScan(layout, frame, WIDTH, HEIGHT)!;
    const { x, width } = scan.block;
    const centre = x + Math.round(width / 2);

    const hard = readEdge(
      bandSource(WIDTH, HEIGHT, (px) => (px < centre ? 235 : 45)),
      scan,
    );
    const soft = readEdge(
      bandSource(WIDTH, HEIGHT, (px) => (px < centre ? 235 : px === centre ? 150 : 45)),
      scan,
    );
    expect(hard.intermediates).toBe(0);
    expect(soft.intermediates).toBeGreaterThanOrEqual(EDGE_GATE.minIntermediates);
    expect(soft.maxStep).toBeLessThan(hard.maxStep);
  });
});

describe('the crevice profile (3D-20)', () => {
  it('converts the apparent alphas to linear light', () => {
    expect(creviceGainAt(0)).toBe(1);
    expect(creviceGainAt(CREVICE.creaseAlpha)).toBeLessThan(0.05);
    expect(creviceGainAt(CREVICE.plateauAlpha)).toBeGreaterThan(
      creviceGainAt(CREVICE.creaseAlpha),
    );
    // The plateau edge sits one bevel in from the silhouette and the fade ends
    // 2.0 mm inside it, which is the 2.5D mask's own band.
    expect(CREVICE.fadeUnits).toBeGreaterThan(TILE.bevelUnits);
    expect(CREVICE.fadeUnits).toBeLessThan(TILE.widthUnits);
  });
});
