import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage as loadNapiImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type { DecalRecord, DecalRotation, DecalsManifest } from './decalManifest';
import { decalKey, parseDecalsManifest } from './decalManifest';
import { parseFacesManifest } from './faceManifest';
import { decalLightRotationDegFor } from './shellManifest';
import { parseShellsManifest } from './shellManifest';
import { TileAtlasBuilder } from './TileAtlasBuilder';
import type { AtlasCanvas, AtlasImage } from './TileAtlasBuilder';
import { tileRenderKey } from './tiles';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const shells = parseShellsManifest(JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')));
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));

function record(
  light: DecalRotation,
  textureFile: string,
  symbol: DecalRotation = 0,
): DecalRecord {
  return {
    face: '1m',
    lightRotationDeg: light,
    symbolRotationDeg: symbol,
    textureFile,
    width: 2,
    height: 2,
    facePlateRect: [0, 0, 1, 1],
    bytes: 1,
    sha256: { decodedRgba: '0'.repeat(64) },
    measured: {
      width: 2,
      height: 2,
      alphaBBox: { left: 0, top: 0, right: 1, bottom: 1 },
      alphaPixels: 4,
      transparentFraction: 0,
      inkPixels: 4,
      redPixels: 0,
      cornerAlpha: [0, 0, 0, 0],
    },
  };
}

function manifest(records: DecalRecord[]): DecalsManifest {
  const decals: Record<string, DecalRecord> = {};
  for (const item of records) {
    decals[decalKey(item.face, item.lightRotationDeg, item.symbolRotationDeg)] = item;
  }
  return {
    version: 1,
    generatedBy: 'test',
    raster: { width: 2, height: 2, scale: 2, format: 'test' },
    rotations: [0, 90, 180, 270],
    symbolRotations: [0],
    budgetBytes: 1024,
    decals,
  };
}

const createNapiCanvas = (width: number, height: number) =>
  createCanvas(width, height) as unknown as AtlasCanvas;

const loadFileImage = async (url: string): Promise<AtlasImage> => {
  const image = await loadNapiImage(readFileSync(url));
  return image as unknown as AtlasImage;
};

function context(canvas: AtlasCanvas): CanvasRenderingContext2D {
  return canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
}

function rgbaAt(canvas: AtlasCanvas, x: number, y: number) {
  return Array.from(context(canvas).getImageData(Math.round(x), Math.round(y), 1, 1).data);
}

/** A 2x2 decal: left transparent, right solid, top/bottom distinguishable. */
function syntheticDecal(topRight: string, bottomRight: string, solidLeft = false) {
  const canvas = createCanvas(2, 2);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 2, 2);
  if (solidLeft) {
    ctx.fillStyle = topRight;
    ctx.fillRect(0, 0, 2, 1);
    ctx.fillStyle = bottomRight;
    ctx.fillRect(0, 1, 2, 1);
  } else {
    ctx.fillStyle = topRight;
    ctx.fillRect(1, 0, 1, 1);
    ctx.fillStyle = bottomRight;
    ctx.fillRect(1, 1, 1, 1);
  }
  return canvas as unknown as AtlasCanvas;
}

function builder(
  decalSet: DecalsManifest,
  options: { requireDecals?: boolean; images?: Map<string, AtlasCanvas> } = {},
) {
  return new TileAtlasBuilder({
    shells,
    faces,
    decals: decalSet,
    requireDecals: options.requireDecals,
    resolveUrl: (relativePath) => join(tableDir, relativePath),
    loadImage: async (url) => {
      const override = options.images?.get(url);
      if (override) return override as unknown as AtlasImage;
      if (url.includes('/decals/')) {
        throw new Error(`unexpected decal load ${url}`);
      }
      return loadFileImage(url);
    },
    createCanvas: createNapiCanvas,
    pixelRatio: 1,
  });
}

describe('carved decals in the startup atlas', () => {
  it('selects the decal by shell light rotation', async () => {
    expect(decalLightRotationDegFor(shells.shells.shell_hand_slot_06)).toBe(0);
    expect(decalLightRotationDegFor(shells.shells.shell_flat_upright)).toBe(0);
    expect(decalLightRotationDegFor(shells.shells.shell_flat_sideways)).toBe(270);

    const upright = syntheticDecal('#00ff00', '#00ff00', true);
    const sideways = syntheticDecal('#0000ff', '#0000ff', true);
    const decalSet = manifest([
      record(0, 'decals/1m-l0.png'),
      record(270, 'decals/1m-l270.png'),
    ]);
    const atlas = await builder(decalSet, {
      images: new Map<string, AtlasCanvas>([
        [join(tableDir, 'decals/1m-l0.png'), upright],
        [join(tableDir, 'decals/1m-l270.png'), sideways],
      ]),
    }).build(['shell_flat_upright', 'shell_flat_sideways']);

    const upSprite = atlas.sprites.get(tileRenderKey('shell_flat_upright', '1m'))!;
    const sideSprite = atlas.sprites.get(tileRenderKey('shell_flat_sideways', '1m'))!;
    expect(upSprite.decalFile).toBe('decals/1m-l0.png');
    expect(upSprite.decalLightRotationDeg).toBe(0);
    expect(sideSprite.decalFile).toBe('decals/1m-l270.png');
    expect(sideSprite.decalLightRotationDeg).toBe(270);
    expect(atlas.stats.decalSprites).toBe(2);
    expect(atlas.stats.flatGlyphSprites).toBe(70);
  });

  it('composites the decal over the shell and keeps transparent pixels', async () => {
    // A fully solid green decal proves the decal is drawn over the shell.
    const green = syntheticDecal('#00ff00', '#00ff00', true);
    const decalSet = manifest([record(0, 'decals/1m-l0.png')]);
    const atlas = await builder(decalSet, {
      images: new Map<string, AtlasCanvas>([[join(tableDir, 'decals/1m-l0.png'), green]]),
    }).build(['shell_flat_upright']);
    const page = atlas.pages[0];
    const sprite = atlas.sprites.get(tileRenderKey('shell_flat_upright', '1m'))!;
    const quad = shells.shells.shell_flat_upright.faceQuad;
    const centerX = quad.reduce((sum, [x]) => sum + x, 0) / 4;
    const centerY = quad.reduce((sum, [, y]) => sum + y, 0) / 4;
    const pixel = rgbaAt(page.canvas, sprite.uv.x + centerX, sprite.uv.y + centerY);
    expect(pixel[1], 'green decal covers the face centre').toBeGreaterThan(200);
    expect(pixel[0], 'green decal covers the face centre').toBeLessThan(60);

    // Transparent left half: the ivory shell must show through.
    const half = syntheticDecal('#ff0000', '#ff0000', false);
    const halfSet = manifest([record(0, 'decals/1m-l0.png')]);
    const halfAtlas = await builder(halfSet, {
      images: new Map<string, AtlasCanvas>([[join(tableDir, 'decals/1m-l0.png'), half]]),
    }).build(['shell_flat_upright']);
    const halfSprite = halfAtlas.sprites.get(tileRenderKey('shell_flat_upright', '1m'))!;
    const leftX = quad[0][0] + 0.25 * (quad[1][0] - quad[0][0]);
    const rightX = quad[0][0] + 0.75 * (quad[1][0] - quad[0][0]);
    const yMid = quad[0][1] + 0.5 * (quad[3][1] - quad[0][1]);
    const left = rgbaAt(halfAtlas.pages[0].canvas, halfSprite.uv.x + leftX, halfSprite.uv.y + yMid);
    const right = rgbaAt(halfAtlas.pages[0].canvas, halfSprite.uv.x + rightX, halfSprite.uv.y + yMid);
    expect(left[0]).toBeGreaterThan(150);
    expect(right[0]).toBeGreaterThan(200);
    expect(right[1]).toBeLessThan(60);
  });

  it('falls back to the flat glyph, or throws when decals are required', async () => {
    const decalSet = manifest([record(0, 'decals/1m-l0.png')]);
    const green = syntheticDecal('#00ff00', '#00ff00', true);
    const images = new Map<string, AtlasCanvas>([[join(tableDir, 'decals/1m-l0.png'), green]]);
    const fallback = await builder(decalSet, { images }).build(['shell_flat_upright']);
    const twoMan = fallback.sprites.get(tileRenderKey('shell_flat_upright', '2m'))!;
    expect(twoMan.decalFile).toBeNull();
    expect(twoMan.hasGlyph).toBe(true);

    await expect(
      builder(decalSet, { images, requireDecals: true }).build(['shell_flat_upright']),
    ).rejects.toThrow(/no carved decal/);
  });

  it('parses and keys a decal manifest', () => {
    const raw = {
      version: 1,
      generatedBy: 'test',
      raster: { width: 2, height: 2, scale: 2, format: 'png' },
      rotations: [0, 90, 180, 270],
      symbolRotations: [0],
      budget: { bytes: 1024 },
      decals: {
        '1m:l0:s0': record(0, 'decals/1m-l0.png'),
      },
    };
    const parsed = parseDecalsManifest(raw);
    expect(parsed.decals['1m:l0:s0'].lightRotationDeg).toBe(0);
    expect(decalKey('1m', 270, 0)).toBe('1m:l270:s0');
    expect(() =>
      parseDecalsManifest({
        ...raw,
        decals: { '1m:l90:s0': record(0, 'decals/1m-l0.png') },
      }),
    ).toThrow(/does not match/);
  });
});
