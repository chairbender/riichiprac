/**
 * Runtime registry for the startup tile atlas.
 *
 * One offscreen 2D canvas per face-up shell is composed from the committed
 * shell PNGs and glyph PNGs (see {@link TileAtlasBuilder}). After that, frame
 * rendering is a `drawImage(page.canvas, sprite.uv…, …)` per tile: no shadow,
 * blur, glyph rasterisation or 3D context at draw time.
 *
 * The Phase 2 catalogue is the 18 face-up shells: 14 standing-hand slots plus
 * the upright and sideways pond/meld shells. There are 38 faces per shell, so
 * the atlas resolves 684 keys (648 glyph keys + 36 shared bare keys for
 * `blank`/`5z`). Face-down wall shells are drawn from their own PNGs and are
 * deliberately absent.
 *
 * A page is 37 slots (36 inked + one bare). At @1x that is 18 pages,
 * 7,929,168 px / 30.25 MiB RGBA. @2x is four times that (105.19 MiB), so the
 * loader only uses @2x when the estimated cost is inside `maxRgbaBytes`
 * (default 48 MiB); otherwise it composes at @1x and reports the decision.
 */
import { FACE_UP_SHELL_IDS, TILE_FACE_IDS } from './tiles';
import type { FaceUpShellId, TileRenderKey } from './tiles';
import { parseFacesManifest } from './faceManifest';
import type { FacesManifest } from './faceManifest';
import { parseDecalsManifest } from './decalManifest';
import type { DecalsManifest } from './decalManifest';
import { parseReliefManifest } from './reliefManifest';
import type { ReliefManifest } from './reliefManifest';
import { parseTableLayoutManifest } from './tableLayoutManifest';
import type { TableLayoutManifest } from './tableLayoutManifest';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest } from './shellManifest';
import { TileAtlasBuilder, estimateAtlasBytes } from './TileAtlasBuilder';
import type {
  AtlasCanvas,
  AtlasImage,
  AtlasPage,
  AtlasStats,
  BakedTileSprite,
  CreateAtlasCanvas,
  LoadAtlasImage,
} from './TileAtlasBuilder';

/** Default ceiling for the decoded atlas; above it, the loader stays at @1x. */
export const DEFAULT_MAX_ATLAS_RGBA_BYTES = 48 * 1024 * 1024;

export interface TileAtlasLoadOptions {
  /** Directory holding `shells.json`, `faces.json`, `decals.json`, assets. */
  readonly baseUrl?: string;
  readonly shellsUrl?: string;
  readonly facesUrl?: string;
  /** Carved decal manifest URL; null/undefined keeps the flat glyph path. */
  readonly decalsUrl?: string | null;
  /**
   * Task 5A relief manifest and slot layout. Both are needed for world-space
   * carved shading; when either is unavailable the atlas keeps the Task 5
   * path (carved decals, then flat glyphs) and logs a warning unless
   * `requireRelief` is set.
   */
  readonly reliefUrl?: string | null;
  readonly layoutUrl?: string | null;
  readonly relief?: ReliefManifest;
  readonly layout?: TableLayoutManifest;
  readonly requireRelief?: boolean;
  /** A pre-parsed decal manifest, for tests and the review scripts. */
  readonly decals?: DecalsManifest;
  readonly fetchJson?: (url: string) => Promise<unknown>;
  readonly loadImage?: LoadAtlasImage;
  readonly createCanvas?: CreateAtlasCanvas;
  /** Force the atlas pixel ratio; otherwise it follows DPR with a memory cap. */
  readonly pixelRatio?: 1 | 2;
  /** Shells to compose at startup. Defaults to the 16 Phase 2 face-up shells. */
  readonly warmShells?: readonly FaceUpShellId[];
  /** Maximum decoded RGBA the loader will choose for the atlas. */
  readonly maxRgbaBytes?: number;
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

/** Browser image loader; tests inject a Node Canvas-backed loader. */
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

/** Prefer @2x on retina screens; the memory cap may still demote it to @1x. */
function devicePixelRatioPreference(): 1 | 2 {
  const dpr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 2;
  return dpr >= 2 ? 2 : 1;
}

export class TileAtlas {
  readonly shells: ShellsManifest;
  readonly faces: FacesManifest;
  readonly decals: DecalsManifest | null;
  /** The ratio actually used. */
  readonly pixelRatio: 1 | 2;
  /** The ratio DPR asked for, before the memory cap. */
  readonly requestedPixelRatio: 1 | 2;
  private readonly builder: TileAtlasBuilder;
  private readonly summaries: AtlasPage[] = [];
  private readonly spriteMap = new Map<TileRenderKey, BakedTileSprite>();
  private readonly warmed = new Set<FaceUpShellId>();
  private buildMs = 0;

  constructor(
    builder: TileAtlasBuilder,
    shells: ShellsManifest,
    faces: FacesManifest,
    requestedPixelRatio: 1 | 2 = builder.pixelRatio,
    decals: DecalsManifest | null = null,
  ) {
    this.builder = builder;
    this.shells = shells;
    this.faces = faces;
    this.decals = decals;
    this.pixelRatio = builder.pixelRatio;
    this.requestedPixelRatio = requestedPixelRatio;
  }

  /**
   * Compose the given shell pages if they are not already in the atlas.
   * Sequential, so the page order and total cost are deterministic.
   */
  async warm(shellIds: readonly FaceUpShellId[] = FACE_UP_SHELL_IDS): Promise<this> {
    const started = Date.now();
    for (const shellId of FACE_UP_SHELL_IDS) {
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
  hasShell(shellId: FaceUpShellId): boolean {
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
    let decalSprites = 0;
    let flatGlyphSprites = 0;
    let reliefSprites = 0;
    for (const sprite of this.spriteMap.values()) {
      if (sprite.hasGlyph) {
        glyphSprites += 1;
        if (sprite.shading === 'relief') reliefSprites += 1;
        else if (sprite.decalFile) decalSprites += 1;
        else flatGlyphSprites += 1;
      } else {
        bareSprites += 1;
      }
    }
    return {
      shells: this.summaries.length,
      pages: this.summaries.length,
      sprites: this.spriteMap.size,
      glyphSprites,
      bareSprites,
      decalSprites,
      flatGlyphSprites,
      reliefSprites,
      reliefGroups: this.builder.orientationGroupCount,
      reliefDecals: this.builder.reliefBakeCount,
      reliefBakeMs: this.builder.reliefBakeMs,
      reliefCacheHits: this.builder.reliefCacheHits,
      reliefAtlasLoadMs: this.builder.reliefAtlasLoadMs,
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
    const decalsUrl =
      options.decalsUrl === undefined ? joinUrl(baseUrl, 'decals.json') : options.decalsUrl;
    let decals: DecalsManifest | null = options.decals ?? null;
    if (!decals && decalsUrl) {
      try {
        decals = parseDecalsManifest(await fetchJson(decalsUrl));
      } catch (error) {
        // The flat glyph path is the fallback if the carved set is unavailable.
        console.warn(`carved decals unavailable: ${String(error)}`);
      }
    }

    const requestedPixelRatio = options.pixelRatio ?? devicePixelRatioPreference();
    const maxRgbaBytes = options.maxRgbaBytes ?? DEFAULT_MAX_ATLAS_RGBA_BYTES;
    const requestedBytes = estimateAtlasBytes(shells, faces, requestedPixelRatio);
    const pixelRatio: 1 | 2 =
      requestedPixelRatio === 2 && requestedBytes > maxRgbaBytes ? 1 : requestedPixelRatio;

    // Task 5A inputs. Both are optional: a deployment that ships only the
    // Task 5 decals must still boot, and a partial asset load must leave every
    // face on its fallback path rather than failing the board.
    const reliefUrl =
      options.reliefUrl === undefined ? joinUrl(baseUrl, 'relief.json') : options.reliefUrl;
    const layoutUrl =
      options.layoutUrl === undefined ? joinUrl(baseUrl, 'table_layout.json') : options.layoutUrl;
    let relief: ReliefManifest | null = options.relief ?? null;
    let layout: TableLayoutManifest | null = options.layout ?? null;
    try {
      const [reliefRaw, layoutRaw] = await Promise.all([
        relief || !reliefUrl ? Promise.resolve(null) : fetchJson(reliefUrl),
        layout || !layoutUrl ? Promise.resolve(null) : fetchJson(layoutUrl),
      ]);
      if (reliefRaw !== null) relief = parseReliefManifest(reliefRaw);
      if (layoutRaw !== null) layout = parseTableLayoutManifest(layoutRaw);
    } catch (error) {
      if (options.requireRelief) throw error;
      // Keep whichever manifest parsed; without both, every face uses the
      // Task 5 carved decal / flat glyph fallback.
      console.warn(`carved relief unavailable: ${String(error)}`);
    }
    if (!relief || !layout) {
      if (options.requireRelief) {
        throw new Error('carved relief requires both relief.json and table_layout.json');
      }
      relief = null;
      layout = null;
    }

    const builder = new TileAtlasBuilder({
      shells,
      faces,
      decals: decals ?? undefined,
      ...(relief && layout ? { relief: { manifest: relief, layout } } : {}),
      resolveUrl: (relativePath) => joinUrl(baseUrl, relativePath),
      loadImage: options.loadImage ?? defaultLoadImage,
      createCanvas: options.createCanvas,
      pixelRatio,
    });
    const atlas = new TileAtlas(builder, shells, faces, requestedPixelRatio, decals);
    await atlas.warm(options.warmShells ?? FACE_UP_SHELL_IDS);
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
 * destination size is the @1x logical size, so an @2x page is downsampled by
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

/** Re-exported for callers that only import the registry. */
export { TILE_FACE_IDS };
