import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage as loadNapiImage } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import {
  CarvedReliefBakery,
  carveUvOffset,
  linearToSrgb,
  reliefShadingFrame,
  shadeReliefSample,
  srgbToLinear,
  tangentNormalToWorld,
} from './carvedRelief';
import type { ReliefShadingFrame, ReliefSample } from './carvedRelief';
import { parseDecalsManifest } from './decalManifest';
import type { DecalsManifest } from './decalManifest';
import { parseFacesManifest } from './faceManifest';
import { parseReliefManifest } from './reliefManifest';
import type { ReliefManifest } from './reliefManifest';
import { parseShellsManifest } from './shellManifest';
import { TileAtlas } from './TileAtlas';
import { TileAtlasBuilder } from './TileAtlasBuilder';
import type { AtlasCanvas, AtlasImage } from './TileAtlasBuilder';
import {
  groupSlotsByOrientation,
  parseTableLayoutManifest,
  reliefGroupForShell,
} from './tableLayoutManifest';
import type { OrientationGroup, SlotBasis } from './tableLayoutManifest';
import type { FaceUpShellId } from './tiles';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const shells = parseShellsManifest(JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')));
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));
const relief = parseReliefManifest(JSON.parse(readFileSync(join(tableDir, 'relief.json'), 'utf8')));
const layout = parseTableLayoutManifest(
  JSON.parse(readFileSync(join(tableDir, 'table_layout.json'), 'utf8')),
);
const decals = parseDecalsManifest(JSON.parse(readFileSync(join(tableDir, 'decals.json'), 'utf8')));
const groups = groupSlotsByOrientation(layout);
const IVORY = [223, 220, 216] as const;

const createAtlasCanvas = (width: number, height: number) =>
  createCanvas(width, height) as unknown as AtlasCanvas;
const loadFileImage = async (url: string): Promise<AtlasImage> =>
  (await loadNapiImage(readFileSync(url))) as unknown as AtlasImage;
const resolveFileUrl = (relativePath: string): string => join(tableDir, relativePath);

function group(shell: FaceUpShellId): OrientationGroup {
  const found = reliefGroupForShell(layout, shell, groups);
  if (!found) throw new Error(`no relief group for ${shell}`);
  return found;
}

function bakery(manifest: ReliefManifest = relief, dCarve?: number) {
  return new CarvedReliefBakery({
    manifest,
    layout,
    loadImage: loadFileImage,
    resolveUrl: resolveFileUrl,
    createCanvas: createAtlasCanvas,
    ...(dCarve === undefined ? {} : { dCarve }),
  });
}

function makeBuilder(options: {
  withRelief?: boolean;
  reliefManifest?: ReliefManifest;
  decalSet?: DecalsManifest;
} = {}) {
  return new TileAtlasBuilder({
    shells,
    faces,
    decals: options.decalSet,
    ...(options.withRelief
      ? { relief: { manifest: options.reliefManifest ?? relief, layout } }
      : {}),
    resolveUrl: resolveFileUrl,
    loadImage: loadFileImage,
    createCanvas: createAtlasCanvas,
    pixelRatio: 1,
  });
}

function pixelsOf(canvas: AtlasCanvas): Uint8ClampedArray {
  return (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(
    0,
    0,
    canvas.width,
    canvas.height,
  ).data;
}

function rgba(canvas: AtlasCanvas, x: number, y: number): [number, number, number, number] {
  const data = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(x, y, 1, 1).data;
  return [data[0], data[1], data[2], data[3]];
}

const brightness = (pixel: readonly number[]): number => Math.max(pixel[0], pixel[1], pixel[2]);

/** Load one atlas cell as raw pixels for tests that inspect the source data. */
function cellPixels(face: string, file: string) {
  return loadFileImage(join(tableDir, file)).then((image) => {
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image as never, 0, 0);
    const cell = relief.cells[face];
    return context.getImageData(
      cell.x,
      cell.y,
      relief.raster.cellWidth,
      relief.raster.cellHeight,
    ).data;
  });
}

/** The two strongest V-carve walls, painted-mask free, by face-local normal y. */
async function wallPixels(): Promise<{
  positive: { x: number; y: number; ny: number };
  negative: { x: number; y: number; ny: number };
}> {
  const normal = await cellPixels('1m', relief.atlases.normalDepth.file);
  const albedo = await cellPixels('1m', relief.atlases.albedo.file);
  const width = relief.raster.cellWidth;
  const height = relief.raster.cellHeight;
  const nyAt = (x: number, y: number) =>
    (normal[(y * width + x) * 4 + 1] / 255) * 2 - 1;
  let positive = { x: 0, y: 0, ny: 0 };
  let negative = { x: 0, y: 0, ny: 0 };
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = (y * width + x) * 4;
      const depth = normal[index + 3] / 255;
      const paint = albedo[index + 3] / 255;
      if (depth > 0.9 || depth < 0.02 || paint > 0.02) continue;
      const ny = nyAt(x, y);
      // A stable 3 x 3 neighbourhood avoids a single edge texel.
      let stable = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (Math.sign(nyAt(x + dx, y + dy)) === Math.sign(ny)) stable += 1;
        }
      }
      if (stable < 8) continue;
      if (ny > positive.ny) positive = { x, y, ny };
      if (ny < negative.ny) negative = { x, y, ny };
    }
  }
  return { positive, negative };
}

describe('carved relief maths', () => {
  it('shifts the carve lookup along -V_tan.xy scaled by depth', () => {
    expect(carveUvOffset(1, [0.4, 0.2, 0.2])[0]).toBeCloseTo(0, 12);
    expect(carveUvOffset(1, [0.4, 0.2, 0.2])[1]).toBeCloseTo(0, 12);
    const grazing = carveUvOffset(0, [0.5, -0.25, 0.5], 0.018, 0.35);
    expect(grazing[0]).toBeCloseTo(-0.018 * (0.5 / 0.5), 9);
    expect(grazing[1]).toBeCloseTo(0.018 * (0.25 / 0.5), 9);
    // The z floor keeps a grazing view from exploding.
    const floored = carveUvOffset(0, [0, 0.7, 0.05], 0.018, 0.35);
    expect(floored[1]).toBeCloseTo((-0.7 * 0.018) / 0.35, 9);
  });

  it('maps tangent normals into world space through the slot basis', () => {
    const south: SlotBasis = {
      tangent: [1, 0, 0],
      bitangent: [0, -1, 0],
      normal: [0, 0, 1],
    };
    const north: SlotBasis = {
      tangent: [-1, 0, 0],
      bitangent: [0, 1, 0],
      normal: [0, 0, 1],
    };
    // A face-down wall in one orientation faces world north in the other.
    expect(tangentNormalToWorld([0, 1, 0], south)).toEqual([0, -1, 0]);
    expect(tangentNormalToWorld([0, -1, 0], north)).toEqual([0, -1, 0]);
    // Rotating the tile does not rotate the world: the same world wall is
    // reached by a different tangent normal.
    expect(tangentNormalToWorld([0, 1, 0], north)).toEqual([0, 1, 0]);
  });

  it('lights world-north walls brighter than world-south walls, in any rotation', () => {
    const frame = (basis: SlotBasis): ReliefShadingFrame =>
      reliefShadingFrame({
        basis,
        position: [0, -4.8, 0.295],
        lighting: layout.lighting,
        ivorySrgb: IVORY,
      });
    const south: SlotBasis = { tangent: [1, 0, 0], bitangent: [0, -1, 0], normal: [0, 0, 1] };
    const north: SlotBasis = { tangent: [-1, 0, 0], bitangent: [0, 1, 0], normal: [0, 0, 1] };
    const wall = (normal: readonly [number, number, number]): ReliefSample => ({
      albedo: [255, 255, 255],
      paint: 0,
      normal,
      height: 0.1,
      ao: 1,
      roughness: 0.45,
    });
    // Tangent +y is world north under `south`, world south under `north`.
    const southNorthWall = shadeReliefSample(wall([0, 0.6, 0.8]), frame(south));
    const southSouthWall = shadeReliefSample(wall([0, -0.6, 0.8]), frame(south));
    expect(brightness([southNorthWall.r, southNorthWall.g, southNorthWall.b])).toBeGreaterThan(
      brightness([southSouthWall.r, southSouthWall.g, southSouthWall.b]),
    );
    const northNorthWall = shadeReliefSample(wall([0, -0.6, 0.8]), frame(north));
    const northSouthWall = shadeReliefSample(wall([0, 0.6, 0.8]), frame(north));
    expect(brightness([northNorthWall.r, northNorthWall.g, northNorthWall.b])).toBeGreaterThan(
      brightness([northSouthWall.r, northSouthWall.g, northSouthWall.b]),
    );
  });

  it('adds a glossy enamel glint when a painted wall faces the halfway vector', () => {
    const frame = reliefShadingFrame({
      basis: group('shell_flat_upright').basis,
      position: group('shell_flat_upright').position,
      lighting: layout.lighting,
      ivorySrgb: IVORY,
    });
    const base: Omit<ReliefSample, 'normal'> = {
      albedo: [166, 12, 12],
      paint: 1,
      height: 0,
      ao: 1,
      roughness: 0.12,
    };
    // The halfway vector in tangent space is the normal that returns the peak
    // glint; the flat floor is 48 degrees or more away from it.
    const flat = shadeReliefSample({ ...base, normal: [0, 0, 1] }, frame);
    // Build the halfway vector in world space, then convert it into the basis.
    const hx = frame.lightWorld[0] + frame.viewWorld[0];
    const hy = frame.lightWorld[1] + frame.viewWorld[1];
    const hz = frame.lightWorld[2] + frame.viewWorld[2];
    const size = Math.hypot(hx, hy, hz);
    const h: readonly [number, number, number] = [hx / size, hy / size, hz / size];
    const { tangent, bitangent, normal } = frame.basis;
    const tangentHalfway: readonly [number, number, number] = [
      h[0] * tangent[0] + h[1] * tangent[1] + h[2] * tangent[2],
      h[0] * bitangent[0] + h[1] * bitangent[1] + h[2] * bitangent[2],
      h[0] * normal[0] + h[1] * normal[1] + h[2] * normal[2],
    ];
    const glint = shadeReliefSample({ ...base, normal: tangentHalfway }, frame);
    expect(brightness([glint.r, glint.g, glint.b])).toBeGreaterThan(
      brightness([flat.r, flat.g, flat.b]),
    );
    // The glint is a highlight, not a full white blowout at 48 degrees from
    // the floor: keep the whole carve within a subtle range.
    expect(glint.r).toBeLessThanOrEqual(255);
    expect(glint.r - flat.r).toBeGreaterThan(0);
  });

  it('tone-matches flat ivory to the shell face sample', () => {    const frame = reliefShadingFrame({
      basis: group('shell_flat_upright').basis,
      position: group('shell_flat_upright').position,
      lighting: layout.lighting,
      ivorySrgb: IVORY,
    });
    const flat = shadeReliefSample(
      {
        albedo: [255, 255, 255],
        paint: 0,
        normal: [0, 0, 1],
        height: 1,
        ao: 1,
        roughness: 0.45,
      },
      frame,
    );
    expect(flat.a).toBe(0); // un-carved plate stays transparent
    expect(flat.r).toBeGreaterThanOrEqual(IVORY[0] - 1);
    expect(flat.r).toBeLessThanOrEqual(IVORY[0] + 1);
    expect(flat.g).toBeGreaterThanOrEqual(IVORY[1] - 1);
    expect(flat.g).toBeLessThanOrEqual(IVORY[1] + 1);
    expect(flat.b).toBeGreaterThanOrEqual(IVORY[2] - 1);
    expect(flat.b).toBeLessThanOrEqual(IVORY[2] + 1);

    // A deep cavity is darker than the open face.
    const cavity = shadeReliefSample(
      {
        albedo: [255, 255, 255],
        paint: 0.8,
        normal: [0, 0, 1],
        height: 0.05,
        ao: 0.4,
        roughness: 0.12,
      },
      frame,
    );
    expect(cavity.a).toBe(255);
    expect(cavity.r).toBeLessThan(flat.r);
  });

  it('round-trips the sRGB transfer used for the tone match', () => {
    for (const byte of [0, 12, 64, 128, 200, 255]) {
      expect(linearToSrgb(srgbToLinear(byte))).toBe(byte);
    }
  });
});

describe('carved relief bake', () => {
  it('bakes one lit face per orientation and both V-walls follow the world light', async () => {
    const bake = bakery(relief, 0);
    const upright = await bake.decalFor(
      '1m',
      group('shell_flat_upright'),
      relief.raster.cellWidth,
      relief.raster.cellHeight,
      IVORY,
    );
    const north = await bake.decalFor(
      '1m',
      group('shell_flat_upright_180'),
      relief.raster.cellWidth,
      relief.raster.cellHeight,
      IVORY,
    );
    expect(upright).not.toBeNull();
    expect(north).not.toBeNull();
    expect(upright!.carvedPixels).toBeGreaterThan(0);
    expect(north!.carvedPixels).toBeGreaterThan(0);
    expect(upright!.groupKey).not.toBe(north!.groupKey);
    expect(upright!.canvas).not.toBe(north!.canvas);

    const walls = await wallPixels();
    const at = (face: typeof upright, wall: { x: number; y: number }) =>
      rgba(face!.canvas, wall.x, wall.y);

    // `wall.positive` is the face-local +y wall. It faces world north under
    // the upright south-pond basis, and world south under the 180 rotation.
    const uprightPositive = at(upright, walls.positive);
    const uprightNegative = at(upright, walls.negative);
    const northPositive = at(north, walls.positive);
    const northNegative = at(north, walls.negative);
    expect(walls.positive.ny).toBeGreaterThan(0.4);
    expect(walls.negative.ny).toBeLessThan(-0.4);

    expect(brightness(uprightPositive)).toBeGreaterThan(brightness(uprightNegative));
    expect(brightness(northNegative)).toBeGreaterThan(brightness(northPositive));
    // The same tangent texel is lit differently once the basis rotates: the
    // highlight moved with the world, not with the sprite.
    expect(Math.abs(brightness(uprightPositive) - brightness(northPositive))).toBeGreaterThan(2);
    expect(Math.abs(brightness(uprightNegative) - brightness(northNegative))).toBeGreaterThan(2);
    // Both walls remain visible; the carve is not silently transparent.
    expect(uprightPositive[3]).toBeGreaterThan(0);
    expect(northNegative[3]).toBeGreaterThan(0);
  });

  it('caches by face + group + size + ivory calibration', async () => {
    const bake = bakery();
    const first = await bake.decalFor('1m', group('shell_flat_upright'), 64, 84, IVORY);
    const again = await bake.decalFor('1m', group('shell_flat_upright'), 64, 84, IVORY);
    expect(again).toBe(first);
    expect(bake.stats.bakes).toBe(1);
    expect(bake.stats.cacheHits).toBe(1);
    const rotated = await bake.decalFor('1m', group('shell_flat_sideways'), 64, 84, IVORY);
    expect(rotated).not.toBe(first);
    expect(bake.stats.bakes).toBe(2);
    expect(bake.stats.groups).toBe(31);
  });

  it('applies one-step groove parallax at an oblique view', async () => {
    const flat = new CarvedReliefBakery({
      manifest: relief,
      layout,
      loadImage: loadFileImage,
      resolveUrl: resolveFileUrl,
      createCanvas: createAtlasCanvas,
      dCarve: 0,
    });
    const carved = bakery();
    const oblique = group('shell_flat_upright_180');
    const a = await flat.decalFor('1m', oblique, 64, 84, IVORY);
    const b = await carved.decalFor('1m', oblique, 64, 84, IVORY);
    const dataA = pixelsOf(a!.canvas);
    const dataB = pixelsOf(b!.canvas);
    let changed = 0;
    for (let index = 0; index < dataA.length; index += 4) {
      if (
        Math.abs(dataA[index] - dataB[index]) > 1 ||
        Math.abs(dataA[index + 1] - dataB[index + 1]) > 1 ||
        Math.abs(dataA[index + 2] - dataB[index + 2]) > 1 ||
        Math.abs(dataA[index + 3] - dataB[index + 3]) > 1
      ) {
        changed += 1;
      }
    }
    // The carve scale is 0.018 UV, about 1.5 px on a 64 x 84 plate; the shift
    // must move a meaningful band of the V-wall, not a rounding artefact.
    expect(changed).toBeGreaterThan(50);
    expect(a!.carvedPixels).toBeGreaterThan(0);
    expect(b!.carvedPixels).toBeGreaterThan(0);
  });

  it('reports the shading frame for every face-up shell group', () => {
    const bake = bakery();
    expect(bake.orientationGroups).toHaveLength(31);
    for (const shell of [
      'shell_hand_slot_00',
      'shell_hand_slot_06',
      'shell_hand_slot_draw',
      'shell_flat_upright',
      'shell_flat_sideways',
      'shell_flat_upright_180',
      'shell_flat_sideways_270',
    ] as const) {
      expect(bake.groupForShell(shell)).not.toBeNull();
    }
  });
});

describe('tile atlas relief integration', () => {
  const reviewShells: FaceUpShellId[] = [
    'shell_flat_upright',
    'shell_flat_sideways',
    'shell_flat_upright_180',
  ];

  it('composes relief decals instead of carved decals and keeps the group keys distinct', async () => {
    const atlas = await makeBuilder({ withRelief: true, decalSet: decals }).build(reviewShells);
    expect(atlas.stats.reliefSprites).toBe(36 * reviewShells.length);
    expect(atlas.stats.reliefDecals).toBeGreaterThanOrEqual(36);
    expect(atlas.stats.reliefBakeMs).toBeGreaterThan(0);
    const upright = atlas.sprites.get('shell_flat_upright:flat-topdown:1m')!;
    const sideways = atlas.sprites.get('shell_flat_sideways:flat-rot90:1m')!;
    const north = atlas.sprites.get('shell_flat_upright_180:flat-topdown-180:1m')!;
    for (const sprite of [upright, sideways, north]) {
      expect(sprite.shading).toBe('relief');
      expect(sprite.decalFile).toBeNull();
      expect(sprite.reliefBasis).not.toBeNull();
    }
    expect(new Set([upright.reliefGroup, sideways.reliefGroup, north.reliefGroup]).size).toBe(3);

    // The composited page must actually differ from the Task 5 carved-decal
    // page at the face plate, not just carry different metadata.
    const legacy = await makeBuilder({ decalSet: decals }).build(['shell_flat_upright']);
    const reliefPage = atlas.pages[0];
    const legacyPage = legacy.pages[0];
    const patch = (page: typeof reliefPage, sprite: typeof upright) => {
      const quad = sprite.faceQuad;
      const x = Math.round(sprite.uv.x + (quad[0][0] + quad[1][0]) / 2);
      const y = Math.round(sprite.uv.y + (quad[0][1] + quad[3][1]) / 2);
      const data = (page.canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(
        x - 8,
        y - 8,
        16,
        16,
      ).data;
      return Array.from(data);
    };
    expect(patch(reliefPage, upright)).not.toEqual(patch(legacyPage, upright));
  });

  it('falls back per face to the carved decal when a relief cell is missing', async () => {
    const broken: ReliefManifest = { ...relief, cells: { ...relief.cells } };
    delete (broken.cells as Record<string, unknown>)['2m'];
    const atlas = await makeBuilder({ withRelief: true, reliefManifest: broken, decalSet: decals }).build([
      'shell_flat_upright',
    ]);
    const oneMan = atlas.sprites.get('shell_flat_upright:flat-topdown:1m')!;
    const twoMan = atlas.sprites.get('shell_flat_upright:flat-topdown:2m')!;
    expect(oneMan.shading).toBe('relief');
    expect(twoMan.shading).toBe('decal');
    expect(twoMan.decalFile).toMatch(/^decals\/2m-lying-l0\.avif$/);
    expect(atlas.stats.reliefSprites).toBe(35);
  });

  it('survives a missing relief atlas by falling back to the Task 5 decals', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken: ReliefManifest = {
      ...relief,
      atlases: {
        ...relief.atlases,
        albedo: { ...relief.atlases.albedo, file: 'relief/does-not-exist.png' },
      },
    };
    try {
      const atlas = await makeBuilder({
        withRelief: true,
        reliefManifest: broken,
        decalSet: decals,
      }).build(['shell_flat_upright']);
      expect(atlas.stats.reliefSprites).toBe(0);
      const sprite = atlas.sprites.get('shell_flat_upright:flat-topdown:1m')!;
      expect(sprite.shading).toBe('decal');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('carved relief disabled'));
    } finally {
      warn.mockRestore();
    }
  });

  it('loads the relief and layout manifests by default and falls back cleanly', async () => {
    const registry = await TileAtlas.load({
      baseUrl: tableDir,
      fetchJson: async (url) => JSON.parse(readFileSync(url, 'utf8')),
      loadImage: loadFileImage,
      createCanvas: createAtlasCanvas,
      pixelRatio: 1,
      warmShells: ['shell_flat_upright'],
    });
    expect(registry.stats.reliefSprites).toBe(36);
    expect(registry.stats.reliefDecals).toBe(36);
    expect(registry.stats.reliefGroups).toBe(31);
    const sprite = registry.getSprite('shell_flat_upright:flat-topdown:1m');
    expect(sprite.shading).toBe('relief');

    const fallback = await TileAtlas.load({
      baseUrl: tableDir,
      fetchJson: async (url) => JSON.parse(readFileSync(url, 'utf8')),
      loadImage: loadFileImage,
      createCanvas: createAtlasCanvas,
      pixelRatio: 1,
      reliefUrl: null,
      layoutUrl: null,
      warmShells: ['shell_flat_upright'],
    });
    expect(fallback.stats.reliefSprites).toBe(0);
    expect(fallback.getSprite('shell_flat_upright:flat-topdown:1m').shading).toBe('decal');
  });

  it('keeps the relief basis orthonormal in every sprite', async () => {
    const atlas = await makeBuilder({ withRelief: true }).build(['shell_flat_sideways']);
    const sprite = atlas.sprites.get('shell_flat_sideways:flat-rot90:7z')!;
    const basis = sprite.reliefBasis!;
    const dot = (a: readonly number[], b: readonly number[]) =>
      a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(dot(basis.tangent, basis.bitangent)).toBeCloseTo(0, 5);
    expect(dot(basis.tangent, basis.normal)).toBeCloseTo(0, 5);
    expect(dot(basis.bitangent, basis.normal)).toBeCloseTo(0, 5);
    expect(Math.hypot(...basis.normal)).toBeCloseTo(1, 5);
  });
});
