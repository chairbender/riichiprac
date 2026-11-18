import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage as loadNapiImage } from '@napi-rs/canvas';
import { describe, expect, it, vi } from 'vitest';
import { TILE } from '../layoutConstants';
import { TILE_FACE_IDS } from '../contract';
import {
  NEUTRAL_CELL_SIZE,
  PINNED_RELIEF3D_ATLASES,
  PINNED_RELIEF_ATLASES,
  RELIEF_FACE_IDS,
  RELIEF_PLATE_UNITS,
  RELIEF_RASTER,
  RELIEF_TIER_SETTINGS,
  ReliefAssetError,
  buildNeutralCell,
  loadReliefAssets,
  parseReliefManifest,
  reliefGpuBytes,
  reliefTextureBytes,
  reliefTextureSize,
} from './reliefAssets';
import type {
  ReliefFetch,
  ReliefFetchResponse,
  ReliefTextureHandle,
  ReliefTextureRequest,
} from './reliefAssets';

/**
 * 3D-03 acceptance, as numbers.
 *
 * The committed Task 4B bake is decoded with a real Canvas 2D implementation
 * (`@napi-rs/canvas`), so the rect mapping, the y-down cell origin and the
 * measured statistics are checked against decoded pixels rather than trusted
 * from the manifest. Texture creation is a fake seam (3D-02 owns `three`), so
 * the tests also pin the settings the real factory must apply.
 *
 * No test inspects a rendered frame (AGENTS.md §6).
 */

const tableDir = fileURLToPath(new URL('../../../public/table/', import.meta.url));

const manifestBytes = readFileSync(join(tableDir, 'relief.json'));
const rawManifest = JSON.parse(manifestBytes.toString('utf8')) as Record<
  string,
  unknown
>;
const manifest = parseReliefManifest(rawManifest);

const MANIFEST_URL = '/table/relief.json';
const ATLAS_URLS = {
  face_albedo: '/table/relief/face_albedo.png',
  face_normal_depth: '/table/relief/face_normal_depth.png',
  face_ao_roughness: '/table/relief/face_ao_roughness.png',
} as const;

function readAtlas(key: keyof typeof ATLAS_URLS): Uint8Array {
  return readFileSync(join(tableDir, PINNED_RELIEF_ATLASES[key].file));
}

function fileResponse(bytes: Uint8Array): ReliefFetchResponse {
  return {
    ok: true,
    status: 200,
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
    },
  };
}

/** A fetch over committed files; any URL not in the map is a 404. */
function committedFetch(
  overrides: Partial<Record<keyof typeof ATLAS_URLS, Uint8Array>> = {},
  includeManifest = true,
): ReliefFetch {
  const files = new Map<string, Uint8Array>();
  if (includeManifest) files.set(MANIFEST_URL, new Uint8Array(manifestBytes));
  for (const key of Object.keys(ATLAS_URLS) as (keyof typeof ATLAS_URLS)[]) {
    files.set(ATLAS_URLS[key], overrides[key] ?? new Uint8Array(readAtlas(key)));
  }
  return async (url: string) => {
    const bytes = files.get(url);
    if (!bytes) {
      return {
        ok: false,
        status: 404,
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      };
    }
    return fileResponse(bytes);
  };
}

interface FakeTexture extends ReliefTextureHandle {
  readonly request: ReliefTextureRequest;
  disposed: number;
}

function fakeFactory(options: {
  throwOnCall?: number;
} = {}): {
  requests: ReliefTextureRequest[];
  textures: FakeTexture[];
  createTexture: { create(request: ReliefTextureRequest): FakeTexture };
} {
  const requests: ReliefTextureRequest[] = [];
  const textures: FakeTexture[] = [];
  return {
    requests,
    textures,
    createTexture: {
      create(request) {
        requests.push(request);
        if (options.throwOnCall === requests.length) {
          throw new Error('GPU is full');
        }
        const texture: FakeTexture = {
          request,
          disposed: 0,
          dispose() {
            this.disposed += 1;
          },
        };
        textures.push(texture);
        return texture;
      },
    },
  };
}

describe('relief manifest: the committed bake and the contract vocabulary', () => {
  it('pins the 37 baked face ids, in atlas order, without blank', () => {
    expect(RELIEF_FACE_IDS).toHaveLength(37);
    expect(TILE_FACE_IDS).toHaveLength(38);
    expect(RELIEF_FACE_IDS).not.toContain('blank');
    expect(Object.keys(rawManifest.faces as object)).toEqual([
      ...RELIEF_FACE_IDS,
    ]);
  });

  it('resolves all 37 baked faces and addresses exactly 37 of the 42 cells', () => {
    expect(manifest.cells.size).toBe(37);
    expect([...manifest.cells.keys()]).toEqual([...RELIEF_FACE_IDS]);
    const used = new Set(
      [...manifest.cells.values()].map((cell) => cell.index),
    );
    expect(used.size).toBe(37);
    const unused = [...Array(RELIEF_RASTER.columns * RELIEF_RASTER.rows).keys()]
      .filter((index) => !used.has(index));
    expect(unused).toEqual([37, 38, 39, 40, 41]);
    // `blank` is deliberately not addressable: a face-down tile samples nothing.
    expect(manifest.cells.has('blank')).toBe(false);
  });

  it('maps face ids to the committed normalized rects (top-left origin, V down)', () => {
    const first = manifest.cells.get('1m');
    expect(first).toMatchObject({
      face: '1m',
      index: 0,
      column: 0,
      row: 0,
      x: 0,
      y: 0,
    });
    expect(first?.rect[0]).toBe(0);
    expect(first?.rect[1]).toBe(0);
    expect(first?.rect[2]).toBeCloseTo(1 / 6, 8);
    expect(first?.rect[3]).toBeCloseTo(1 / 7, 8);
    const haku = manifest.cells.get('5z');
    expect(haku).toMatchObject({ index: 34, column: 4, row: 5, x: 1024, y: 1700 });
    // Bottom row: 2040 px down, i.e. V near 1. A flipped V would land here.
    const redDragon = manifest.cells.get('7z');
    expect(redDragon).toMatchObject({
      index: 36,
      column: 0,
      row: 6,
      x: 0,
      y: 2040,
    });
    expect(redDragon?.rect[1]).toBeCloseTo(2040 / 2380, 8);
    expect(redDragon?.rect[3]).toBeCloseTo(1, 8);

    for (const cell of manifest.cells.values()) {
      const [u0, v0, u1, v1] = cell.rect;
      expect(u0).toBeGreaterThanOrEqual(0);
      expect(v0).toBeGreaterThanOrEqual(0);
      expect(u1).toBeLessThanOrEqual(1);
      expect(v1).toBeLessThanOrEqual(1);
      expect(u1 - u0).toBeCloseTo(256 / 1536, 6);
      expect(v1 - v0).toBeCloseTo(340 / 2380, 6);
    }
  });

  it('pins each atlas by byte length and PNG SHA-256, matching the committed files', () => {
    for (const key of Object.keys(PINNED_RELIEF_ATLASES) as (keyof typeof PINNED_RELIEF_ATLASES)[]) {
      const pin = PINNED_RELIEF_ATLASES[key];
      const bytes = readAtlas(key);
      expect(bytes.byteLength).toBe(pin.bytes);
      const digest = createHash('sha256').update(bytes).digest('hex');
      expect(digest).toBe(pin.sha256);
    }
  });

  it('maps the committed plate to 0.64 x 0.89 units, not the 21 x 28 mm body', () => {
    expect(RELIEF_PLATE_UNITS).toEqual([0.64, 0.89]);
    expect(manifest.plateUnits).toEqual([0.64, 0.89]);
    expect(manifest.plateUnits[0]).toBeCloseTo(TILE.facePlateWidthUnits, 9);
    expect(manifest.plateUnits[1]).toBeCloseTo(TILE.facePlateHeightUnits, 9);
    // 17.92 x 24.92 mm at 1 unit = 28 mm.
    expect(manifest.plateUnits[0] * 28).toBeCloseTo(17.92, 9);
    expect(manifest.plateUnits[1] * 28).toBeCloseTo(24.92, 9);
    // Strictly inset from the body, so it is not the full face.
    expect(TILE.facePlateWidthUnits).toBeLessThan(TILE.widthUnits);
    expect(TILE.facePlateHeightUnits).toBeLessThan(TILE.heightUnits);
    expect(TILE.facePlateWidthUnits * 28).not.toBeCloseTo(20.89, 1);
    // The cell rect covers the plate in pixel space, not the whole tile.
    expect(RELIEF_RASTER.cellWidth / RELIEF_RASTER.atlasWidth).toBeCloseTo(
      1 / 6,
      9,
    );
    expect(RELIEF_RASTER.cellHeight / RELIEF_RASTER.atlasHeight).toBeCloseTo(
      1 / 7,
      9,
    );
  });
});

interface DecodedAtlas {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

async function decodeAtlas(file: string): Promise<DecodedAtlas> {
  const image = await loadNapiImage(readFileSync(join(tableDir, file)));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, image.width, image.height);
  return {
    width: imageData.width,
    height: imageData.height,
    data: imageData.data,
  };
}

/** Mirror of `tools/render/bake_relief.py`'s `measure_cell`, in decoded pixels. */
function measureCell(
  face: string,
  albedo: DecodedAtlas,
  normalDepth: DecodedAtlas,
  aoRoughness: DecodedAtlas,
): Record<string, number> {
  const cell = rawManifest.faces as Record<
    string,
    { cell: { x: number; y: number; rect: [number, number, number, number] } }
  >;
  const { x, y } = cell[face].cell;
  const width = RELIEF_RASTER.cellWidth;
  const height = RELIEF_RASTER.cellHeight;
  const pixels = width * height;
  let paintPixels = 0;
  let redPaintPixels = 0;
  let openPixels = 0;
  let aoSum = 0;
  let aoMin = 1;
  let roughnessPaintSum = 0;
  let roughnessOpenSum = 0;
  let roughnessOpenCount = 0;

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const offset = ((y + row) * albedo.width + (x + column)) * 4;
      const paint = albedo.data[offset + 3] > 127;
      if (paint) paintPixels++;
      if (
        paint &&
        albedo.data[offset] > albedo.data[offset + 1] + 40 &&
        albedo.data[offset] > albedo.data[offset + 2] + 40
      ) {
        redPaintPixels++;
      }
      const open = normalDepth.data[offset + 3] === 255;
      if (open) openPixels++;
      const ao = aoRoughness.data[offset] / 255;
      aoSum += ao;
      if (ao < aoMin) aoMin = ao;
      if (paint) roughnessPaintSum += aoRoughness.data[offset + 1] / 255;
      if (open && !paint) {
        roughnessOpenSum += aoRoughness.data[offset + 1] / 255;
        roughnessOpenCount++;
      }
    }
  }

  return {
    paintPixels,
    paintFraction: paintPixels / pixels,
    redPaintPixels,
    openFaceFraction: openPixels / pixels,
    aoMin,
    aoMean: aoSum / pixels,
    roughnessPaintMean: paintPixels === 0 ? 0 : roughnessPaintSum / paintPixels,
    roughnessOpenMean:
      roughnessOpenCount === 0 ? 0 : roughnessOpenSum / roughnessOpenCount,
  };
}

describe('relief manifest: decoded-pixel evidence for the rect mapping', () => {
  it('reproduces the manifest measured values for four faces, including Haku', async () => {
    const albedo = await decodeAtlas(PINNED_RELIEF_ATLASES.face_albedo.file);
    const normalDepth = await decodeAtlas(
      PINNED_RELIEF_ATLASES.face_normal_depth.file,
    );
    const aoRoughness = await decodeAtlas(
      PINNED_RELIEF_ATLASES.face_ao_roughness.file,
    );
    expect(albedo.width).toBe(1536);
    expect(albedo.height).toBe(2380);

    const measured = rawManifest.faces as Record<
      string,
      { measured: Record<string, number> }
    >;
    const decimals = [
      'paintFraction',
      'openFaceFraction',
      'aoMin',
      'aoMean',
      'roughnessPaintMean',
      'roughnessOpenMean',
    ] as const;
    const counts = ['paintPixels', 'redPaintPixels'] as const;

    for (const face of ['1m', '1p', '7z', '5z'] as const) {
      const got = measureCell(face, albedo, normalDepth, aoRoughness);
      const want = measured[face].measured;
      for (const key of counts) {
        // Lossless PNG decode: the committed counts must match exactly.
        expect(got[key], `${face}.${key}`).toBe(want[key]);
      }
      for (const key of decimals) {
        // The manifest rounds these to 4-5 decimals.
        expect(Math.abs(got[key] - want[key]), `${face}.${key}`).toBeLessThanOrEqual(
          1e-4,
        );
      }
    }
    // Haku has no printed symbol: zero ink, fully open, fully unoccluded.
    const haku = measureCell('5z', albedo, normalDepth, aoRoughness);
    expect(haku.paintPixels).toBe(0);
    expect(haku.openFaceFraction).toBe(1);
    expect(haku.aoMean).toBe(1);
  });

  it('is not sampling a transposed or flipped rect', async () => {
    const albedo = await decodeAtlas(PINNED_RELIEF_ATLASES.face_albedo.file);
    const normalDepth = await decodeAtlas(
      PINNED_RELIEF_ATLASES.face_normal_depth.file,
    );
    const aoRoughness = await decodeAtlas(
      PINNED_RELIEF_ATLASES.face_ao_roughness.file,
    );
    const first = measureCell('1m', albedo, normalDepth, aoRoughness);
    // The same 256 x 340 window read from the bottom-left cell belongs to 7z.
    const bottomLeft = measureCell('7z', albedo, normalDepth, aoRoughness);
    expect(first.paintPixels).toBe(19617);
    expect(bottomLeft.paintPixels).toBe(16863);
    expect(first.paintPixels).not.toBe(bottomLeft.paintPixels);
  });
});

describe('relief assets: committed load', () => {
  it('creates the three textures with the committed settings and reports GPU bytes', async () => {
    const factory = fakeFactory();
    const warn = vi.fn();
    const assets = await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      fetchImpl: committedFetch(),
      createTexture: factory.createTexture,
      maxAnisotropy: 16,
      warn,
    });

    expect(assets.status).toBe('committed');
    expect(warn).not.toHaveBeenCalled();
    expect(factory.requests.map((request) => request.role)).toEqual([
      'albedo',
      'normalDepth',
      'aoRoughness',
    ]);
    expect(factory.requests.map((request) => request.colorSpace)).toEqual([
      'srgb',
      'linear',
      'linear',
    ]);
    for (const request of factory.requests) {
      expect(request.flipY).toBe(false);
      expect(request.generateMipmaps).toBe(true);
      expect(request.width).toBe(1536);
      expect(request.height).toBe(2380);
      expect(request.anisotropy).toBe(RELIEF_TIER_SETTINGS.high.anisotropy);
      expect(request.pixels).toBeNull();
    }
    expect(factory.requests[0].bytes?.byteLength).toBe(
      PINNED_RELIEF_ATLASES.face_albedo.bytes,
    );
    expect(factory.requests[1].bytes?.byteLength).toBe(
      PINNED_RELIEF_ATLASES.face_normal_depth.bytes,
    );
    expect(factory.requests[2].bytes?.byteLength).toBe(
      PINNED_RELIEF_ATLASES.face_ao_roughness.bytes,
    );

    // §2.5: 43.9 MB raw, 58.5 MB with mips.
    expect(assets.atlasBytes).toBe(58_490_880);
    expect(assets.bytesByRole.albedo).toBe(19_496_960);
    expect(reliefTextureBytes(1536, 2380, false) * 3).toBe(43_868_160);

    expect(assets.plateUnits.width).toBe(0.64);
    expect(assets.plateUnits.height).toBe(0.89);
    expect(assets.cellForFace('1m')?.index).toBe(0);
    expect(assets.cellForFace('7z')?.index).toBe(36);
    // No baked art: blank and any unknown id resolve to blank (no cell).
    expect(assets.cellForFace('blank')).toBeNull();
    expect(assets.resolveCell('not-a-face')).toEqual(
      assets.cellForFace('blank'),
    );
    expect(assets.resolveCell('5z')).toEqual(assets.cellForFace('5z'));

    assets.dispose();
    expect(factory.textures.map((texture) => texture.disposed)).toEqual([1, 1, 1]);
    // Idempotent.
    assets.dispose();
    expect(factory.textures.map((texture) => texture.disposed)).toEqual([1, 1, 1]);
  });

  it('clamps anisotropy to the renderer maximum and never below 1', async () => {
    const clamped = fakeFactory();
    await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      fetchImpl: committedFetch(),
      createTexture: clamped.createTexture,
      maxAnisotropy: 3,
    });
    expect(clamped.requests.map((request) => request.anisotropy)).toEqual([
      3, 3, 3,
    ]);

    const floored = fakeFactory();
    await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      fetchImpl: committedFetch(),
      createTexture: floored.createTexture,
      maxAnisotropy: 0,
    });
    expect(floored.requests.map((request) => request.anisotropy)).toEqual([
      1, 1, 1,
    ]);
  });
});

describe('relief assets: quality tiers and the compat downsample', () => {
  it('halves each axis and the GPU bytes at the compat tier', async () => {
    const factory = fakeFactory();
    const assets = await loadReliefAssets({
      tier: 'compat',
      baseUrl: '/',
      fetchImpl: committedFetch(),
      createTexture: factory.createTexture,
      maxAnisotropy: 16,
    });
    expect(reliefTextureSize('compat')).toEqual({ width: 768, height: 1190 });
    expect(reliefTextureSize('high')).toEqual({ width: 1536, height: 2380 });
    for (const request of factory.requests) {
      expect(request.width).toBe(768);
      expect(request.height).toBe(1190);
      expect(request.anisotropy).toBe(RELIEF_TIER_SETTINGS.compat.anisotropy);
    }
    // §2.5: ≈14.6 MB with mips, the same as one full-resolution atlas.
    expect(assets.atlasBytes).toBe(14_622_720);
    expect(reliefGpuBytes('high').total).toBe(58_490_880);
    expect(reliefGpuBytes('balanced').total).toBe(58_490_880);
    expect(reliefGpuBytes('compat').total).toBe(14_622_720);
    assets.dispose();
  });
});

describe('relief assets: the truthful fallback path', () => {
  const FALLBACK_WARNING = /relief assets unavailable/;

  it('uses the neutral cell when the manifest is missing, with one warning', async () => {
    const factory = fakeFactory();
    const warn = vi.fn();
    const assets = await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      fetchImpl: committedFetch({}, false),
      createTexture: factory.createTexture,
      warn,
    });

    expect(assets.status).toBe('fallback');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(FALLBACK_WARNING);
    expect(warn.mock.calls[0][0]).toMatch(/manifest-fetch/);
    expect(factory.requests).toHaveLength(3);
    for (const request of factory.requests) {
      expect(request.bytes).toBeNull();
      expect(request.pixels?.width).toBe(NEUTRAL_CELL_SIZE);
      expect(request.pixels?.height).toBe(NEUTRAL_CELL_SIZE);
      expect(request.flipY).toBe(false);
      expect(request.width).toBe(NEUTRAL_CELL_SIZE);
    }
    // Every face, including blank, resolves to the single neutral cell.
    expect(assets.faces.size).toBe(38);
    expect(assets.cellForFace('1m')?.rect).toEqual([0, 0, 1, 1]);
    expect(assets.cellForFace('blank')?.rect).toEqual([0, 0, 1, 1]);
    expect(assets.resolveCell('not-a-face')?.rect).toEqual([0, 0, 1, 1]);
    expect(assets.plateUnits.width).toBe(TILE.facePlateWidthUnits);
    // A 64 x 64 neutral cell is 16,384 B raw / 21,845 B with mips.
    expect(assets.atlasBytes).toBe(reliefTextureBytes(64, 64, true) * 3);
    assets.dispose();
    expect(factory.textures.map((texture) => texture.disposed)).toEqual([1, 1, 1]);
  });

  it('warns exactly once through the default console path', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const assets = await loadReliefAssets({
        tier: 'high',
        baseUrl: '/',
        fetchImpl: committedFetch({}, false),
        createTexture: fakeFactory().createTexture,
      });
      expect(assets.status).toBe('fallback');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][0]).toMatch(FALLBACK_WARNING);
    } finally {
      spy.mockRestore();
    }
  });

  it('builds the neutral channels with the committed neutral values', () => {
    const albedo = buildNeutralCell('albedo');
    expect(albedo.data.length).toBe(64 * 64 * 4);
    expect([...albedo.data.slice(0, 4)]).toEqual([255, 255, 255, 0]);
    expect([...albedo.data.slice(-4)]).toEqual([255, 255, 255, 0]);

    const normalDepth = buildNeutralCell('normalDepth');
    expect([...normalDepth.data.slice(0, 4)]).toEqual([128, 128, 255, 255]);

    const aoRoughness = buildNeutralCell('aoRoughness');
    expect([...aoRoughness.data.slice(0, 4)]).toEqual([255, 115, 0, 255]);
    // Roughness 0.45 in 8 bits, the committed resin value.
    expect(aoRoughness.data[1] / 255).toBeCloseTo(0.451, 2);
  });

  it('falls back on an atlas hash mismatch without creating committed textures', async () => {
    const corrupted = new Uint8Array(readAtlas('face_albedo'));
    corrupted[corrupted.length - 1] ^= 0xff;
    const factory = fakeFactory();
    const warn = vi.fn();
    const assets = await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      fetchImpl: committedFetch({ face_albedo: corrupted }),
      createTexture: factory.createTexture,
      warn,
    });
    expect(assets.status).toBe('fallback');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/atlas-hash/);
    // All three fetches and checks precede any texture creation, so no
    // half-installed committed set exists to leak.
    expect(factory.requests.every((request) => request.pixels !== null)).toBe(
      true,
    );
    expect(assets.atlasBytes).toBe(reliefTextureBytes(64, 64, true) * 3);
  });

  it('falls back when an atlas is missing', async () => {
    const files = committedFetch();
    const factory = fakeFactory();
    const warn = vi.fn();
    const assets = await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      fetchImpl: async (url) =>
        url === ATLAS_URLS.face_normal_depth
          ? {
              ok: false,
              status: 404,
              async arrayBuffer() {
                return new ArrayBuffer(0);
              },
            }
          : files(url),
      createTexture: factory.createTexture,
      warn,
    });
    expect(assets.status).toBe('fallback');
    expect(warn.mock.calls[0][0]).toMatch(/atlas-fetch/);
  });

  it('falls back on a manifest/contract face mismatch', async () => {
    const mutated = JSON.parse(manifestBytes.toString('utf8')) as {
      faces: Record<string, unknown>;
    };
    delete mutated.faces['7z'];
    const factory = fakeFactory();
    const warn = vi.fn();
    const assets = await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      fetchImpl: async (url) =>
        url === MANIFEST_URL
          ? fileResponse(new TextEncoder().encode(JSON.stringify(mutated)))
          : committedFetch()(url),
      createTexture: factory.createTexture,
      warn,
    });
    expect(assets.status).toBe('fallback');
    expect(warn.mock.calls[0][0]).toMatch(/manifest-faces/);
  });

  it('falls back on a manifest version bump', async () => {
    const mutated = JSON.parse(manifestBytes.toString('utf8')) as {
      version: number;
    };
    mutated.version = 2;
    const warn = vi.fn();
    const assets = await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      fetchImpl: async (url) =>
        url === MANIFEST_URL
          ? fileResponse(new TextEncoder().encode(JSON.stringify(mutated)))
          : committedFetch()(url),
      createTexture: fakeFactory().createTexture,
      warn,
    });
    expect(assets.status).toBe('fallback');
    expect(warn.mock.calls[0][0]).toMatch(/manifest-version/);
  });

  it('reports a texture failure once and still installs the fallback', async () => {
    const factory = fakeFactory({ throwOnCall: 1 });
    const warn = vi.fn();
    const assets = await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      fetchImpl: committedFetch(),
      createTexture: factory.createTexture,
      warn,
    });
    expect(assets.status).toBe('fallback');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/texture/);
    // The failed committed attempt created nothing before throwing.
    expect(factory.requests).toHaveLength(4);
    expect(factory.textures).toHaveLength(3);
    expect(factory.textures.every((texture) => texture.request.pixels)).toBe(true);
  });

  it('rejects a non-normalized or off-cell rect', () => {
    const mutated = JSON.parse(manifestBytes.toString('utf8')) as {
      faces: Record<string, { cell: { rect: number[] } }>;
    };
    mutated.faces['1m'].cell.rect = [0.5, 0.5, 0.75, 0.75];
    let thrown: unknown;
    try {
      parseReliefManifest(mutated);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ReliefAssetError);
    expect((thrown as ReliefAssetError).code).toBe('manifest-cell');
  });
});

describe('relief assets: module boundaries', () => {
  it('imports no three.js and nothing from the 2.5D table pipeline', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./reliefAssets.ts', import.meta.url)),
      'utf8',
    );
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
      (match) => match[1],
    );
    expect(specifiers).toEqual(['../contract', '../contract', '../layoutConstants']);
    expect(source).not.toMatch(/from\s+['"]three(\/|['"])/);
    expect(source).not.toMatch(/import\(\s*['"]/);
    expect(source).not.toMatch(/from\s+['"][^'"]*\/table\//);
    expect(source).not.toMatch(/Math\.random/);
  });
});

describe('the 3D-owned carve set (3D-17)', () => {
  const relief3dBytes = readFileSync(join(tableDir, 'relief3d.json'));
  const relief3dManifest = JSON.parse(relief3dBytes.toString('utf8')) as Record<
    string,
    unknown
  >;

  it('pins the committed relief3d atlases by bytes and hash', () => {
    for (const [key, pin] of Object.entries(PINNED_RELIEF3D_ATLASES)) {
      const bytes = readFileSync(join(tableDir, pin.file));
      expect(bytes.byteLength, key).toBe(pin.bytes);
      expect(createHash('sha256').update(bytes).digest('hex'), key).toBe(pin.sha256);
    }
  });

  it('parses with its own pin table and resolves all 37 faces', () => {
    const manifest = parseReliefManifest(relief3dManifest, PINNED_RELIEF3D_ATLASES);
    expect(manifest.cells.size).toBe(RELIEF_RASTER.faceCount);
    expect(manifest.plateUnits).toEqual(RELIEF_PLATE_UNITS);
    expect(manifest.atlases.face_albedo.file).toBe('relief/face_albedo.png');
    expect(manifest.atlases.face_normal_depth.file).toBe('relief3d/face_normal_depth.png');
  });

  it('rejects the committed manifest against the relief3d pins', () => {
    expect(() => parseReliefManifest(rawManifest, PINNED_RELIEF3D_ATLASES)).toThrow(
      ReliefAssetError,
    );
  });

  it('loads through the committed file bytes and reports relief3d', async () => {
    const requests: ReliefTextureRequest[] = [];
    const fetchImpl: ReliefFetch = async (url) => {
      if (url.endsWith('/table/relief3d.json')) return fileResponse(relief3dBytes);
      if (url.endsWith('/table/relief/face_albedo.png')) {
        return fileResponse(readFileSync(join(tableDir, 'relief/face_albedo.png')));
      }
      if (url.endsWith('/table/relief3d/face_normal_depth.png')) {
        return fileResponse(readFileSync(join(tableDir, 'relief3d/face_normal_depth.png')));
      }
      if (url.endsWith('/table/relief3d/face_ao_roughness.png')) {
        return fileResponse(readFileSync(join(tableDir, 'relief3d/face_ao_roughness.png')));
      }
      return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); } };
    };
    const assets = await loadReliefAssets({
      tier: 'high',
      baseUrl: '/',
      source: 'relief3d',
      fetchImpl,
      createTexture: {
        create: (request) => {
          requests.push(request);
          return { dispose: () => undefined };
        },
      },
    });
    expect(assets.status).toBe('relief3d');
    expect(requests).toHaveLength(3);
    expect(requests.map((request) => request.name)).toContain('relief-normalDepth');
    expect(assets.cellForFace('1m')).not.toBeNull();
  });
});
