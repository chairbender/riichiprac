import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage as loadNapiImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { TileAtlas, blitTileSprite } from './TileAtlas';
import { parseFacesManifest } from './faceManifest';
import { parseShellsManifest } from './shellManifest';
import { TileAtlasBuilder } from './TileAtlasBuilder';
import type { AtlasCanvas, AtlasImage, CreateAtlasCanvas, LoadAtlasImage } from './TileAtlasBuilder';
import {
  ALL_TILE_RENDER_KEYS,
  FACE_DOWN_SHELL_IDS,
  SHELL_IDS,
  TILE_FACE_IDS,
  faceIdForTile,
  tileRenderKey,
} from './tiles';
import type { ShellId } from './tiles';

/**
 * These tests use a real Canvas 2D implementation (`@napi-rs/canvas`) in Node,
 * so they assert decoded pixels, not a mock's opinion of them. It is a
 * devDependency only; the browser uses its own Canvas 2D.
 */
const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));

const shells = parseShellsManifest(JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')));
const faces = parseFacesManifest(JSON.parse(readFileSync(join(tableDir, 'faces.json'), 'utf8')));

const createNapiCanvas: CreateAtlasCanvas = (width, height) =>
  createCanvas(width, height) as unknown as AtlasCanvas;

const loadFileImage: LoadAtlasImage = async (url) => {
  const image = await loadNapiImage(readFileSync(url));
  return image as unknown as AtlasImage;
};

const resolveFileUrl = (relativePath: string): string => join(tableDir, relativePath);

function makeBuilder(overrides: Partial<ConstructorParameters<typeof TileAtlasBuilder>[0]> = {}) {
  return new TileAtlasBuilder({
    shells,
    faces,
    resolveUrl: resolveFileUrl,
    loadImage: loadFileImage,
    createCanvas: createNapiCanvas,
    ...overrides,
  });
}

function context(canvas: AtlasCanvas): CanvasRenderingContext2D {
  return canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
}

function pixels(
  canvas: AtlasCanvas,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  return context(canvas).getImageData(x, y, width, height).data;
}

function pageHash(canvas: AtlasCanvas): string {
  const { width, height } = canvas;
  const data = context(canvas).getImageData(0, 0, width, height).data;
  return createHash('sha256').update(Buffer.from(data)).digest('hex');
}

function rgbaAt(canvas: AtlasCanvas, x: number, y: number): [number, number, number, number] {
  const data = pixels(canvas, x, y, 1, 1);
  return [data[0], data[1], data[2], data[3]];
}

/** Bilinear point inside a quad: 0,0 is quad[0], 1,1 is quad[2]. */
function quadPoint(
  quad: readonly [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]],
  u: number,
  v: number,
): [number, number] {
  const [topLeft, topRight, , bottomLeft] = quad;
  return [
    topLeft[0] + u * (topRight[0] - topLeft[0]) + v * (bottomLeft[0] - topLeft[0]),
    topLeft[1] + u * (topRight[1] - topLeft[1]) + v * (bottomLeft[1] - topLeft[1]),
  ];
}

const atlas = await makeBuilder().buildAll();

describe('tile face ids', () => {
  it('maps game tiles and red fives to the 38 face ids', () => {
    expect(TILE_FACE_IDS).toHaveLength(38);
    expect(new Set(TILE_FACE_IDS).size).toBe(38);
    expect(faceIdForTile('5m', true)).toBe('5mr');
    expect(faceIdForTile('5p', true)).toBe('5pr');
    expect(faceIdForTile('5s', true)).toBe('5sr');
    expect(faceIdForTile('5m')).toBe('5m');
    expect(faceIdForTile('7z')).toBe('7z');
    expect(faceIdForTile('blank')).toBe('blank');
    expect(() => faceIdForTile('1z', true)).toThrow(/cannot be a red five/);
    expect(() => faceIdForTile('nope')).toThrow(/unknown tile code/);
  });
});

describe('startup tile atlas', () => {
  it('resolves all 6 x 38 keys', () => {
    expect(ALL_TILE_RENDER_KEYS).toHaveLength(228);
    expect(atlas.sprites.size).toBe(228);
    for (const key of ALL_TILE_RENDER_KEYS) {
      expect(atlas.sprites.has(key), key).toBe(true);
    }
  });

  it('fails loudly on an unwarmed or unknown key', async () => {
    const registry = new TileAtlas(makeBuilder(), shells, faces);
    await registry.warm(['shell_flat_upright']);
    expect(registry.hasShell('shell_flat_upright')).toBe(true);
    expect(registry.hasShell('shell_hand_standing')).toBe(false);
    expect(registry.getSprite(tileRenderKey('shell_flat_upright', '1m')).hasGlyph).toBe(true);
    expect(() => registry.getSprite(tileRenderKey('shell_hand_standing', '1m'))).toThrow(
      /not baked/,
    );
    expect(() => registry.page(99)).toThrow(/not baked/);
  });

  it('loads manifests through the injected fetcher and warms only the requested shell', async () => {
    const fetched: string[] = [];
    const registry = await TileAtlas.load({
      baseUrl: tableDir,
      fetchJson: async (url) => {
        fetched.push(url);
        return JSON.parse(readFileSync(url, 'utf8'));
      },
      loadImage: loadFileImage,
      createCanvas: createNapiCanvas,
      pixelRatio: 2,
      warmShells: ['shell_flat_upright'],
    });
    expect(fetched).toEqual([join(tableDir, 'shells.json'), join(tableDir, 'faces.json')]);
    expect(registry.pages.map((page) => page.shell)).toEqual(['shell_flat_upright']);
    expect(registry.getSprite(tileRenderKey('shell_flat_upright', '1m')).hasGlyph).toBe(true);
    expect(() => registry.getSprite(tileRenderKey('shell_flat_sideways', '1m'))).toThrow(
      /not baked/,
    );
  });

  it('gives every sprite a UV rect inside its page and the logical metrics', () => {
    for (const sprite of atlas.sprites.values()) {
      const page = atlas.pages[sprite.pageIndex];
      expect(page, sprite.key).toBeDefined();
      expect(sprite.uv.x).toBeGreaterThanOrEqual(0);
      expect(sprite.uv.y).toBeGreaterThanOrEqual(0);
      expect(sprite.uv.x + sprite.uv.width).toBeLessThanOrEqual(page.width);
      expect(sprite.uv.y + sprite.uv.height).toBeLessThanOrEqual(page.height);
      expect(sprite.uv.width).toBe(shells.shells[sprite.shell].texWidth * atlas.stats.pixelRatio);
      expect(sprite.uv.height).toBe(shells.shells[sprite.shell].texHeight * atlas.stats.pixelRatio);
      expect(sprite.advanceWidth).toBe(shells.shells[sprite.shell].advanceWidth);
      expect(sprite.anchorX).toBe(shells.shells[sprite.shell].anchorX);
      expect(sprite.faceQuad).toEqual(shells.shells[sprite.shell].faceQuad);
      expect(sprite.faceRotationDeg).toBe(shells.shells[sprite.shell].faceRotationDeg);
      expect(sprite.gridStepPx).toEqual(shells.shells[sprite.shell].gridStepPx);
    }
  });

  it('rotates the sideways glyph 90 degrees counter-clockwise and leaves the others upright', async () => {
    expect(shells.shells.shell_flat_sideways.faceRotationDeg).toBe(90);
    const quad = shells.shells.shell_flat_sideways.faceQuad;
    // Face-local top edge points up the screen: that is a 90° CCW rotation of
    // the glyph, while every upright shell's top edge points right.
    expect(quad[1][1]).toBeLessThan(quad[0][1]);
    expect(quad[1][0]).toBeCloseTo(quad[0][0], 5);
    for (const shell of SHELL_IDS) {
      if (shell === 'shell_flat_sideways') continue;
      const upright = shells.shells[shell].faceQuad;
      expect(shells.shells[shell].faceRotationDeg, shell).toBe(0);
      expect(Math.abs(upright[1][1] - upright[0][1]), shell).toBeLessThan(
        Math.abs(upright[1][0] - upright[0][0]),
      );
    }

    // Pixel proof with a synthetic glyph: source top-left red, top-right
    // green, bottom-left blue. On the sideways shell red must land at quad[0]
    // (screen bottom-left) and green at quad[1] (screen top-left).
    const synthetic = createCanvas(2, 2);
    const syntheticContext = synthetic.getContext('2d');
    syntheticContext.fillStyle = '#ff0000';
    syntheticContext.fillRect(0, 0, 1, 1);
    syntheticContext.fillStyle = '#00ff00';
    syntheticContext.fillRect(1, 0, 1, 1);
    syntheticContext.fillStyle = '#0000ff';
    syntheticContext.fillRect(0, 1, 1, 1);
    syntheticContext.fillStyle = '#ffffff';
    syntheticContext.fillRect(1, 1, 1, 1);

    const syntheticFaces = {
      ...faces,
      faces: {
        ...faces.faces,
        blank: {
          ...faces.faces.blank,
          textureFile: 'synthetic.png',
          measured: {
            width: 2,
            height: 2,
            inkPixels: 4,
            inkFraction: 1,
            opaquePixels: 4,
            redPixels: 1,
            inkBBox: { left: 0, top: 0, right: 1, bottom: 1 },
          },
        },
      },
    };
    const shellCanvas = createCanvas(60, 50);
    const shellContext = shellCanvas.getContext('2d');
    shellContext.fillStyle = '#101010';
    shellContext.fillRect(0, 0, 60, 50);

    const { page, sprites } = await makeBuilder({
      faces: syntheticFaces,
      loadImage: async (url) =>
        url.endsWith('synthetic.png')
          ? (synthetic as unknown as AtlasImage)
          : (shellCanvas as unknown as AtlasImage),
      pixelRatio: 1,
    }).buildShell('shell_flat_sideways');

    const sprite = sprites.find((entry) => entry.face === 'blank')!;
    expect(sprite.hasGlyph).toBe(true);
    const at = (u: number, v: number) => {
      const [x, y] = quadPoint(quad, u, v);
      return rgbaAt(
        page.canvas,
        Math.round(sprite.uv.x + x),
        Math.round(sprite.uv.y + y),
      );
    };
    const topLeft = at(0.08, 0.08);
    const topRight = at(0.92, 0.08);
    const bottomLeft = at(0.08, 0.92);
    expect(topLeft[0], 'glyph TL is red').toBeGreaterThan(200);
    expect(topLeft[1], 'glyph TL is red').toBeLessThan(60);
    expect(topRight[1], 'glyph TR is green').toBeGreaterThan(200);
    expect(topRight[0], 'glyph TR is green').toBeLessThan(60);
    expect(bottomLeft[2], 'glyph BL is blue').toBeGreaterThan(200);
    expect(bottomLeft[0], 'glyph BL is blue').toBeLessThan(60);
  });

  it('places every face, with blank and haku on the shared bare slot', () => {
    for (const shell of ['shell_hand_standing', 'shell_flat_upright', 'shell_flat_sideways'] as const) {
      const page = atlas.pages.find((entry) => entry.shell === shell)!;
      const bare = atlas.sprites.get(tileRenderKey(shell, 'blank'))!;
      const haku = atlas.sprites.get(tileRenderKey(shell, '5z'))!;
      expect(bare.hasGlyph).toBe(false);
      expect(haku.hasGlyph).toBe(false);
      expect(haku.uv).toEqual(bare.uv);

      const scale = atlas.stats.pixelRatio;
      for (const face of TILE_FACE_IDS) {
        const sprite = atlas.sprites.get(tileRenderKey(shell, face))!;
        const glyphless = face === 'blank' || face === '5z';
        expect(sprite.hasGlyph, `${shell}:${face}`).toBe(!glyphless);
        if (glyphless) {
          expect(sprite.uv, `${shell}:${face}`).toEqual(bare.uv);
          continue;
        }
        const xs = sprite.faceQuad.map(([x]) => x * scale);
        const ys = sprite.faceQuad.map(([, y]) => y * scale);
        const left = Math.floor(Math.min(...xs));
        const top = Math.floor(Math.min(...ys));
        const width = Math.ceil(Math.max(...xs)) - left;
        const height = Math.ceil(Math.max(...ys)) - top;
        const glyphPixels = pixels(
          page.canvas,
          sprite.uv.x + left,
          sprite.uv.y + top,
          width,
          height,
        );
        const barePixels = pixels(page.canvas, bare.uv.x + left, bare.uv.y + top, width, height);
        let differences = 0;
        for (let i = 0; i < glyphPixels.length; i += 1) {
          if (glyphPixels[i] !== barePixels[i]) differences += 1;
        }
        expect(differences, `${shell}:${face} differs from bare`).toBeGreaterThan(50);
      }
    }
    const red = atlas.sprites.get(tileRenderKey('shell_flat_upright', '5mr'))!;
    const page = atlas.pages[red.pageIndex];
    const data = pixels(page.canvas, red.uv.x, red.uv.y, red.uv.width, red.uv.height);
    let redPixels = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > data[i + 1] + 60 && data[i] > data[i + 2] + 60 && data[i + 3] > 8) {
        redPixels += 1;
      }
    }
    expect(redPixels, 'red pixels in composited 5mr').toBeGreaterThan(0);
  });

  it('keeps every glyph inside faceQuad and leaves the shell margins untouched', () => {
    for (const shell of ['shell_hand_standing', 'shell_flat_upright', 'shell_flat_sideways'] as const) {
      const page = atlas.pages.find((entry) => entry.shell === shell)!;
      const bare = atlas.sprites.get(tileRenderKey(shell, 'blank'))!;
      const sprite = atlas.sprites.get(tileRenderKey(shell, '1m'))!;
      const scale = atlas.stats.pixelRatio;
      const xs = sprite.faceQuad.map(([x]) => x * scale);
      const ys = sprite.faceQuad.map(([, y]) => y * scale);
      const left = Math.ceil(Math.min(...xs));
      const right = Math.floor(Math.max(...xs));
      const top = Math.ceil(Math.min(...ys));
      const bottom = Math.floor(Math.max(...ys));

      const compare = (
        x: number,
        y: number,
        width: number,
        height: number,
        label: string,
      ) => {
        if (width <= 0 || height <= 0) return;
        const glyph = pixels(page.canvas, sprite.uv.x + x, sprite.uv.y + y, width, height);
        const shellPixels = pixels(page.canvas, bare.uv.x + x, bare.uv.y + y, width, height);
        expect(Array.from(glyph), `${shell} ${label}`).toEqual(Array.from(shellPixels));
      };

      compare(0, 0, left - 1, sprite.uv.height, 'left margin');
      compare(right + 1, 0, sprite.uv.width - right - 1, sprite.uv.height, 'right margin');
      compare(left, 0, right - left + 1, top - 1, 'top margin');
      compare(left, bottom + 1, right - left + 1, sprite.uv.height - bottom - 1, 'bottom margin');
    }
  });

  it('builds a 1x atlas at the shell textures\u2019 native size', async () => {
    const small = await makeBuilder({ pixelRatio: 1 }).build(['shell_flat_upright']);
    const page = small.pages[0];
    const sprite = small.sprites.get(tileRenderKey('shell_flat_upright', '1m'))!;
    expect(page.pixelRatio).toBe(1);
    expect(sprite.uv.width).toBe(shells.shells.shell_flat_upright.texWidth);
    expect(sprite.uv.height).toBe(shells.shells.shell_flat_upright.texHeight);
    expect(page.bytes).toBe(page.width * page.height * 4);
    expect(small.stats.rgbaBytes).toBe(page.width * page.height * 4);
    expect(sprite.uv.x + sprite.uv.width).toBeLessThanOrEqual(page.width);
  });

  it('blits one sprite at grid minus anchor with the @1x destination size', () => {
    const calls: number[][] = [];
    const context = {
      drawImage: (...args: number[]) => calls.push(args),
    } as unknown as CanvasRenderingContext2D;
    const sprite = atlas.sprites.get(tileRenderKey('shell_flat_upright', '1m'))!;
    const page = atlas.pages[sprite.pageIndex];
    blitTileSprite(context, page, sprite, 100, 200);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(page.canvas);
    expect(calls[0].slice(1)).toEqual([
      sprite.uv.x,
      sprite.uv.y,
      sprite.uv.width,
      sprite.uv.height,
      100 - sprite.anchorX,
      200 - sprite.anchorY,
      sprite.texWidth,
      sprite.texHeight,
    ]);
  });

  it('is deterministic across builds', async () => {
    const second = await makeBuilder().buildAll();
    expect(second.sprites.size).toBe(atlas.sprites.size);
    expect(second.pages.map((page) => pageHash(page.canvas))).toEqual(
      atlas.pages.map((page) => pageHash(page.canvas)),
    );
  });

  it('draws every shell before any glyph, and clips before each glyph', async () => {
    const calls: string[] = [];
    let drawImages = 0;
    const fakeContext = {
      imageSmoothingEnabled: true,
      imageSmoothingQuality: 'high',
      clearRect: () => calls.push('clearRect'),
      drawImage: () => calls.push(`drawImage:${drawImages++}`),
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      beginPath: () => calls.push('beginPath'),
      moveTo: () => calls.push('moveTo'),
      lineTo: () => calls.push('lineTo'),
      closePath: () => calls.push('closePath'),
      clip: () => calls.push('clip'),
      setTransform: () => calls.push('setTransform'),
    };
    const { page } = await makeBuilder({
      createCanvas: (width, height) =>
        ({ width, height, getContext: () => fakeContext }) as unknown as AtlasCanvas,
    }).buildShell('shell_flat_upright');

    expect(page.slots).toBe(37); // 36 inked faces + one shared bare slot
    const firstGlyph = calls.indexOf('save');
    expect(calls[0]).toBe('clearRect');
    expect(calls.slice(1, firstGlyph)).toHaveLength(37);
    expect(calls.slice(1, firstGlyph).every((call) => call.startsWith('drawImage:'))).toBe(true);
    expect(calls.slice(firstGlyph, firstGlyph + 11)).toEqual([
      'save',
      'beginPath',
      'moveTo',
      'lineTo',
      'lineTo',
      'lineTo',
      'closePath',
      'clip',
      'setTransform',
      'drawImage:37',
      'restore',
    ]);
  });

  it('reports the atlas budget and never uses WebGL or 3D', () => {
    console.log(
      `atlas: ${atlas.stats.pages} pages, ${atlas.stats.sprites} keys, ` +
        `${atlas.stats.atlasPixels} px (${atlas.stats.rgbaBytes} B RGBA), ` +
        `${atlas.stats.glyphSprites} glyph keys, ${atlas.stats.bareSprites} bare keys, ` +
        `build ${Math.round(atlas.stats.buildMs)} ms`,
    );
    expect(atlas.stats.atlasPixels).toBeLessThan(8 * 1024 * 1024);
    expect(atlas.stats.rgbaBytes).toBeLessThan(32 * 1024 * 1024);

    const builderSource = readFileSync(
      fileURLToPath(new URL('./TileAtlasBuilder.ts', import.meta.url)),
      'utf8',
    );
    const atlasSource = readFileSync(
      fileURLToPath(new URL('./TileAtlas.ts', import.meta.url)),
      'utf8',
    );
    for (const source of [builderSource, atlasSource]) {
      expect(source).not.toMatch(/getContext\(['"]webgl|WebGLRenderer|from ['"]three|from ['"]babylon|new WebGLRenderingContext/);
    }
  });

  it('covers provenance and every committed glyph asset', () => {
    expect(faces.source.license).toMatch(/CC0|public domain/i);
    expect(faces.faces.blank.textureFile).toBeNull();
    expect(faces.faces['5z'].textureFile).not.toBeNull();
    expect(faces.faces['5z'].measured?.inkPixels).toBe(0);
    for (const face of TILE_FACE_IDS) {
      const stats = faces.faces[face];
      if (face === 'blank') continue;
      expect(stats.textureFile, face).toMatch(/^faces\/[0-9a-z]+\.png$/);
      const size = readFileSync(join(tableDir, stats.textureFile!)).length;
      expect(size, face).toBeGreaterThan(0);
    }
    for (const shell of FACE_DOWN_SHELL_IDS) {
      const page = atlas.pages.find((entry) => entry.shell === shell)!;
      expect(page.slots, shell).toBe(1);
      for (const face of TILE_FACE_IDS) {
        expect(atlas.sprites.get(tileRenderKey(shell, face))!.hasGlyph).toBe(false);
      }
    }
    expect(atlas.pages.map((page) => page.shell)).toEqual([...SHELL_IDS] as ShellId[]);
  });
});
