/**
 * Runtime registry for the startup tile atlas.
 *
 * One offscreen 2D canvas per shell is composed from the committed shell PNGs
 * and glyph PNGs (see {@link TileAtlasBuilder}). After that, frame rendering is
 * a `drawImage(page.canvas, sprite.uv…, …)` per tile: no shadow, blur, glyph
 * rasterisation or 3D context at draw time.
 *
 * The builder is lazy per shell because a shell page is the unit of cost. The
 * first board warms all six shells — its walls, pond and hand use all six — but
 * only composites 114 inked glyph slots; the three face-down shells share one
 * bare-back slot each, so the other 114 atlas keys cost no extra pixels.
 */
import { FACE_UP_SHELL_IDS, SHELL_IDS } from './tiles';
import type { ShellId, TileRenderKey } from './tiles';
import { parseFacesManifest } from './faceManifest';
import type { FacesManifest } from './faceManifest';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest } from './shellManifest';
import { TileAtlasBuilder } from './TileAtlasBuilder';
import type {
  AtlasCanvas,
  AtlasImage,
  AtlasPage,
  AtlasStats,
  BakedTileSprite,
  CreateAtlasCanvas,
  LoadAtlasImage,
} from './TileAtlasBuilder';

export interface TileAtlasLoadOptions {
  /** Directory holding `shells.json`, `faces.json`, `shells/` and `faces/`. */
  readonly baseUrl?: string;
  readonly shellsUrl?: string;
  readonly facesUrl?: string;
  readonly fetchJson?: (url: string) => Promise<unknown>;
  readonly loadImage?: LoadAtlasImage;
  readonly createCanvas?: CreateAtlasCanvas;
  readonly pixelRatio?: 1 | 2;
  /** Shells to compose at startup. Defaults to all six: a board uses all six. */
  readonly warmShells?: readonly ShellId[];
}

function joinUrl(base: string, relativePath: string): string {
  if (/^[a-z]+:/i.test(relativePath)) return relativePath;
  const left = base.endsWith('/') ? base : `${base}/`;
  const right = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
  return `${left}${right}`;
}

function defaultBaseUrl(): string {
  // Vite replaces `import.meta.env.BASE_URL` with the deployed base path
  // (`/` locally, `/riichiprac/` on Pages). Keep the join here, not in callers.
  const base =
    typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL
      ? String(import.meta.env.BASE_URL)
      : '/';
  return joinUrl(base, 'table');
}

function defaultFetchJson(): (url: string) => Promise<unknown> {
  return async (url) => {
    if (typeof fetch !== 'function') throw new Error(`cannot fetch ${url}: no fetch available`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`cannot fetch ${url}: HTTP ${response.status}`);
    return response.json();
  };
}

/** Browser image loader; tests inject `@napi-rs/canvas`-backed loading. */
async function defaultLoadImage(url: string): Promise<AtlasImage> {
  if (typeof Image === 'undefined') {
    throw new Error(`cannot load ${url}: no Image constructor; pass loadImage`);
  }
  const image = new Image();
  image.decoding = 'async';
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cannot decode image ${url}`));
  });
  image.src = url;
  return loaded;
}

/** Prefer @1x on non-retina screens; @2x otherwise. */
function preferredPixelRatio(): 1 | 2 {
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 2;
  return dpr >= 2 ? 2 : 1;
}

export class TileAtlas {
  readonly shells: ShellsManifest;
  readonly faces: FacesManifest;
  readonly pixelRatio: 1 | 2;
  private readonly builder: TileAtlasBuilder;
  private readonly summaries: AtlasPage[] = [];
  private readonly spriteMap = new Map<TileRenderKey, BakedTileSprite>();
  private readonly warmed = new Set<ShellId>();
  private buildMs = 0;

  constructor(builder: TileAtlasBuilder, shells: ShellsManifest, faces: FacesManifest) {
    this.builder = builder;
    this.shells = shells;
    this.faces = faces;
    this.pixelRatio = builder.pixelRatio;
  }

  /**
   * Compose the given shell pages if they are not already in the atlas.
   * Sequential, so the page order and total cost are deterministic.
   */
  async warm(shellIds: readonly ShellId[] = SHELL_IDS): Promise<this> {
    const started = Date.now();
    for (const shellId of SHELL_IDS) {
      if (!shellIds.includes(shellId) || this.warmed.has(shellId)) continue;
      const { page, sprites } = await this.builder.buildShell(shellId, this.summaries.length);
      this.summaries.push(page);
      for (const sprite of sprites) this.spriteMap.set(sprite.key, sprite);
      this.warmed.add(shellId);
    }
    if (FACE_UP_SHELL_IDS.every((shellId) => this.warmed.has(shellId))) {
      this.builder.releaseGlyphCache();
    }
    this.buildMs += Date.now() - started;
    return this;
  }

  /** True once the shell's page is composed and its keys resolve. */
  hasShell(shellId: ShellId): boolean {
    return this.warmed.has(shellId);
  }

  /**
   * The composited sprite for a key. Throws on an unwarmed shell or an unknown
   * key: silently drawing a blank tile would hide a generator bug.
   */
  getSprite(key: TileRenderKey): BakedTileSprite {
    const sprite = this.spriteMap.get(key);
    if (!sprite) {
      const [shell] = key.split(':');
      throw new Error(
        `tile sprite ${key} is not baked; call warm(['${shell}']) before drawing it`,
      );
    }
    return sprite;
  }

  /** True when the key is currently resolvable; tests use the strict getter. */
  hasSprite(key: TileRenderKey): boolean {
    return this.spriteMap.has(key);
  }

  /** The atlas page a sprite blits from. */
  getPage(sprite: BakedTileSprite): AtlasPage {
    return this.page(sprite.pageIndex);
  }

  page(pageIndex: number): AtlasPage {
    const page = this.summaries[pageIndex];
    if (!page) throw new Error(`atlas page ${pageIndex} is not baked`);
    return page;
  }

  get pages(): readonly AtlasPage[] {
    return this.summaries;
  }

  get sprites(): ReadonlyMap<TileRenderKey, BakedTileSprite> {
    return this.spriteMap;
  }

  get stats(): AtlasStats {
    const atlasPixels = this.summaries.reduce(
      (total, page) => total + page.width * page.height,
      0,
    );
    let glyphSprites = 0;
    let bareSprites = 0;
    for (const sprite of this.spriteMap.values()) {
      if (sprite.hasGlyph) glyphSprites += 1;
      else bareSprites += 1;
    }
    return {
      shells: this.summaries.length,
      pages: this.summaries.length,
      sprites: this.spriteMap.size,
      glyphSprites,
      bareSprites,
      atlasPixels,
      rgbaBytes: atlasPixels * 4,
      pixelRatio: this.pixelRatio,
      buildMs: this.buildMs,
    };
  }

  /** Load the manifests, then compose the requested shell pages. */
  static async load(options: TileAtlasLoadOptions = {}): Promise<TileAtlas> {
    const baseUrl = options.baseUrl ?? defaultBaseUrl();
    const fetchJson = options.fetchJson ?? defaultFetchJson();
    const [shellsRaw, facesRaw] = await Promise.all([
      fetchJson(options.shellsUrl ?? joinUrl(baseUrl, 'shells.json')),
      fetchJson(options.facesUrl ?? joinUrl(baseUrl, 'faces.json')),
    ]);
    const shells = parseShellsManifest(shellsRaw);
    const faces = parseFacesManifest(facesRaw);

    const builder = new TileAtlasBuilder({
      shells,
      faces,
      resolveUrl: (relativePath) => joinUrl(baseUrl, relativePath),
      loadImage: options.loadImage ?? defaultLoadImage,
      createCanvas: options.createCanvas,
      pixelRatio: options.pixelRatio ?? preferredPixelRatio(),
    });
    const atlas = new TileAtlas(builder, shells, faces);
    await atlas.warm(options.warmShells ?? SHELL_IDS);
    return atlas;
  }
}

let sharedAtlas: Promise<TileAtlas> | null = null;

/**
 * The app-wide atlas, composed once on first use. A failed load clears the
 * memo so a later view switch can retry.
 */
export function loadFirstBoardAtlas(options: TileAtlasLoadOptions = {}): Promise<TileAtlas> {
  if (!sharedAtlas) {
    sharedAtlas = TileAtlas.load(options).catch((error: unknown) => {
      sharedAtlas = null;
      throw error;
    });
  }
  return sharedAtlas;
}

/** Drop the shared atlas. Tests use this; production has one lifetime. */
export function resetSharedTileAtlas(): void {
  sharedAtlas = null;
}

export type { AtlasCanvas, AtlasStats, BakedTileSprite };

/**
 * The only draw call frame code needs for one tile.
 *
 * `gridX/gridY` is the logical top-left of the opaque body; the sprite's baked
 * transparent margin means the texture is drawn at `grid - anchor`. The
 * destination size is the @1x logical size, so the @2x page is downsampled by
 * the canvas. Never pass `uv.width` as the destination width.
 */
export function blitTileSprite(
  context: CanvasRenderingContext2D,
  page: AtlasPage,
  sprite: BakedTileSprite,
  gridX: number,
  gridY: number,
): void {
  context.drawImage(
    page.canvas as CanvasImageSource,
    sprite.uv.x,
    sprite.uv.y,
    sprite.uv.width,
    sprite.uv.height,
    gridX - sprite.anchorX,
    gridY - sprite.anchorY,
    sprite.texWidth,
    sprite.texHeight,
  );
}
