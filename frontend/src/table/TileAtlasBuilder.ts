/**
 * `TileAtlasBuilder`: composite every `(shell, face)` pair once, at startup.
 *
 * Contract (see `2_5d_mahjong_tile_rendering_architecture.md` §4 Phase 2 and
 * `tools/render/README.md`):
 *
 *  - draw the pre-baked shell PNG for the requested shell, untouched;
 *  - map the glyph's own top-left/top-right/bottom-right/bottom-left corners
 *    onto the shell's published `faceQuad`, which already carries
 *    `faceRotationDeg` (0° upright, 90° counter-clockwise for
 *    `shell_flat_sideways`). Never rotate a shell sprite and never re-order the
 *    quad;
 *  - clip to the quad, so the glyph can never touch the bevel, the resin seam
 *    or the transparent shadow/AO margin;
 *  - store a `Map<TileRenderKey, BakedTileSprite>` with the atlas UV rect and
 *    the logical layout metrics. Frame code only blits.
 *
 * Face-down shells (`shell_wall_*`) show the blue resin back. They still
 * resolve every face key, to one shared bare-back slot: compositing a glyph on
 * a back would be wrong and would cost five megabytes of duplicated atlas.
 *
 * A page is one offscreen 2D canvas per shell, built lazily. The atlas is
 * composed in the browser at startup; no glyph is rasterised per frame and no
 * WebGL/3D context is involved.
 */
import { FACE_DOWN_SHELL_IDS, SHELL_IDS, TILE_FACE_IDS, tileRenderKey } from './tiles';
import type { ShellId, TileFaceId, TileRenderKey } from './tiles';
import { faceHasInk } from './faceManifest';
import type { FacesManifest } from './faceManifest';
import { isFaceDownShell, screenRotationOfQuad } from './shellManifest';
import type { FaceQuad, ShellsManifest, ShellStats } from './shellManifest';

/** An image source with known dimensions: HTMLImageElement, ImageBitmap, ... */
export interface AtlasImage {
  readonly width: number;
  readonly height: number;
}

export type AtlasCanvas = HTMLCanvasElement | OffscreenCanvas;
export type CreateAtlasCanvas = (width: number, height: number) => AtlasCanvas;
export type LoadAtlasImage = (url: string) => Promise<AtlasImage>;
/** Turn a manifest-relative path (`faces/1m.png`) into a fetchable URL. */
export type ResolveAssetUrl = (relativePath: string) => string;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One shell's atlas page. `canvas` is the 2D blit source. */
export interface AtlasPage {
  readonly shell: ShellId;
  readonly canvas: AtlasCanvas;
  /** Page size in atlas px (not CSS px). */
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  /** Number of composited sprite slots (glyphless faces share the bare slot). */
  readonly slots: number;
  /** `width * height * 4`, the RGBA cost of this page. */
  readonly bytes: number;
}

/** What frame code looks up: UV rect plus the shell's logical layout metrics. */
export interface BakedTileSprite {
  readonly key: TileRenderKey;
  readonly shell: ShellId;
  readonly face: TileFaceId;
  /** Index into {@link BakedTileAtlas.pages}. */
  readonly pageIndex: number;
  /** Atlas rect in page pixels. Blit source rect for `drawImage`. */
  readonly uv: Rect;
  /** Atlas pixels per CSS pixel (1 or 2). */
  readonly pixelRatio: number;
  /** True when a glyph was composited; false for backs, blank and haku. */
  readonly hasGlyph: boolean;
  /** Logical sprite size/anchor/advance in @1x CSS px. */
  readonly texWidth: number;
  readonly texHeight: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly advanceWidth: number;
  readonly advanceHeight: number;
  /** Tight-grid step in @1x CSS px; use this, not the advance box. */
  readonly gridStepPx: { readonly x: readonly [number, number]; readonly y: readonly [number, number] };
  /** Face-local plate in @1x CSS px, top-left origin of the sprite. */
  readonly faceQuad: FaceQuad;
  readonly faceRotationDeg: 0 | 90;
}

export interface AtlasStats {
  readonly shells: number;
  readonly pages: number;
  readonly sprites: number;
  readonly glyphSprites: number;
  readonly bareSprites: number;
  readonly atlasPixels: number;
  readonly rgbaBytes: number;
  readonly pixelRatio: number;
  readonly buildMs: number;
}

export interface BakedTileAtlas {
  readonly shells: ShellsManifest;
  readonly faces: FacesManifest;
  readonly pages: readonly AtlasPage[];
  readonly sprites: ReadonlyMap<TileRenderKey, BakedTileSprite>;
  readonly stats: AtlasStats;
}

export interface TileAtlasBuilderOptions {
  readonly shells: ShellsManifest;
  readonly faces: FacesManifest;
  readonly resolveUrl: ResolveAssetUrl;
  readonly loadImage: LoadAtlasImage;
  readonly createCanvas?: CreateAtlasCanvas;
  /** Atlas pixels per CSS px. Defaults to the manifest's `pixelRatio` (2). */
  readonly pixelRatio?: 1 | 2;
  /** Maximum page width in atlas px. Default 2048. */
  readonly maxPageWidthPx?: number;
}

export interface ShellPageResult {
  readonly page: AtlasPage;
  readonly sprites: readonly BakedTileSprite[];
}

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function defaultCreateCanvas(width: number, height: number): AtlasCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('no 2D canvas available; pass createCanvas to TileAtlasBuilder');
}

function context2d(canvas: AtlasCanvas): CanvasRenderingContext2D {
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!context) throw new Error('atlas canvas has no 2D context');
  return context;
}

function assertSpriteSize(shell: ShellStats, image: AtlasImage, scale: number): void {
  const width = Math.round(shell.texWidth * scale);
  const height = Math.round(shell.texHeight * scale);
  if (image.width !== width || image.height !== height) {
    throw new Error(
      `${shell.textureFile2x} is ${image.width}x${image.height}, expected ${width}x${height} at ${scale}x`,
    );
  }
}

export class TileAtlasBuilder {
  private readonly options: TileAtlasBuilderOptions;
  readonly pixelRatio: 1 | 2;
  private readonly maxPageWidthPx: number;
  private readonly createCanvas: CreateAtlasCanvas;
  private readonly glyphCache = new Map<TileFaceId, Promise<AtlasImage>>();

  constructor(options: TileAtlasBuilderOptions) {
    this.options = options;
    this.pixelRatio = options.pixelRatio ?? (options.shells.pixelRatio === 1 ? 1 : 2);
    this.maxPageWidthPx = options.maxPageWidthPx ?? 2048;
    this.createCanvas = options.createCanvas ?? defaultCreateCanvas;
  }

  /** Load and cache a glyph image; one fetch per face for the whole atlas. */
  private glyph(face: TileFaceId): Promise<AtlasImage> {
    let pending = this.glyphCache.get(face);
    if (!pending) {
      const stats = this.options.faces.faces[face];
      if (!stats.textureFile) {
        return Promise.reject(new Error(`face ${face} has no glyph asset`));
      }
      pending = this.options.loadImage(this.options.resolveUrl(stats.textureFile));
      this.glyphCache.set(face, pending);
    }
    return pending;
  }

  /**
   * Drop decoded glyph sources once every face-up page has been composed. The
   * atlas pixels are already copied into the pages, so keeping 37 decoded
   * 192 × 256 images would cost ~7 MB for nothing.
   */
  releaseGlyphCache(): void {
    this.glyphCache.clear();
  }

  /**
   * Compose one shell page. Face-up shells get one slot per inked face plus a
   * shared bare slot for `blank`/`5z`; face-down shells get only the bare slot.
   */
  async buildShell(shellId: ShellId, pageIndex = SHELL_IDS.indexOf(shellId)): Promise<ShellPageResult> {
    const shell = this.options.shells.shells[shellId];
    const scale = this.pixelRatio;
    const spriteWidth = shell.texWidth * scale;
    const spriteHeight = shell.texHeight * scale;
    const faceDown = isFaceDownShell(shell);

    // The glyph's screen rotation is a property of the published quad; fail
    // before drawing if the manifest ever drifts from faceRotationDeg.
    if (screenRotationOfQuad(shell.faceQuad) !== shell.faceRotationDeg) {
      throw new Error(
        `${shellId} faceQuad rotation does not match faceRotationDeg ${shell.faceRotationDeg}`,
      );
    }
    if (faceDown && !FACE_DOWN_SHELL_IDS.some((id) => id === shellId)) {
      throw new Error(`${shellId} is face-down but not in the face-down catalogue`);
    }

    const inkedFaces = faceDown
      ? []
      : TILE_FACE_IDS.filter((face) => faceHasInk(this.options.faces.faces[face]));
    const slotCount = 1 + inkedFaces.length;
    const columns = Math.max(1, Math.min(slotCount, Math.floor(this.maxPageWidthPx / spriteWidth)));
    const rows = Math.ceil(slotCount / columns);
    const pageWidth = columns * spriteWidth;
    const pageHeight = rows * spriteHeight;

    const shellUrl = this.options.resolveUrl(
      scale === 2 ? shell.textureFile2x : shell.textureFile,
    );
    const [shellImage, ...glyphImages] = await Promise.all([
      this.options.loadImage(shellUrl),
      ...inkedFaces.map((face) => this.glyph(face)),
    ]);
    assertSpriteSize(shell, shellImage, scale);

    const canvas = this.createCanvas(pageWidth, pageHeight);
    const ctx = context2d(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, pageWidth, pageHeight);

    const slotOffset = (slot: number): { x: number; y: number } => ({
      x: (slot % columns) * spriteWidth,
      y: Math.floor(slot / columns) * spriteHeight,
    });

    // Pass 1: every shell body, in slot order. The glyph pass is strictly
    // afterwards, so no glyph can ever be under a later shell blit.
    for (let slot = 0; slot < slotCount; slot += 1) {
      const { x, y } = slotOffset(slot);
      ctx.drawImage(shellImage as CanvasImageSource, x, y, spriteWidth, spriteHeight);
    }

    // Pass 2: glyph into its own slot, clipped to the face plate.
    inkedFaces.forEach((_face, index) => {
      const slot = index + 1;
      const { x, y } = slotOffset(slot);
      const image = glyphImages[index];
      this.drawGlyph(ctx, shell, image, x, y, scale);
    });

    const page: AtlasPage = {
      shell: shellId,
      canvas,
      width: pageWidth,
      height: pageHeight,
      pixelRatio: scale,
      slots: slotCount,
      bytes: pageWidth * pageHeight * 4,
    };

    const indexByFace = new Map<TileFaceId, number>();
    inkedFaces.forEach((face, index) => indexByFace.set(face, index + 1));

    const sprites = TILE_FACE_IDS.map((face): BakedTileSprite => {
      const slot = indexByFace.get(face) ?? 0;
      const offset = slotOffset(slot);
      return {
        key: tileRenderKey(shellId, face),
        shell: shellId,
        face,
        pageIndex,
        uv: { x: offset.x, y: offset.y, width: spriteWidth, height: spriteHeight },
        pixelRatio: scale,
        hasGlyph: indexByFace.has(face),
        texWidth: shell.texWidth,
        texHeight: shell.texHeight,
        anchorX: shell.anchorX,
        anchorY: shell.anchorY,
        advanceWidth: shell.advanceWidth,
        advanceHeight: shell.advanceHeight,
        gridStepPx: shell.gridStepPx,
        faceQuad: shell.faceQuad,
        faceRotationDeg: shell.faceRotationDeg,
      };
    });

    return { page, sprites };
  }

  /**
   * Draw one glyph into the shell's face plate.
   *
   * `faceQuad` is published in face-local order (top-left, top-right,
   * bottom-right, bottom-left) of the *rotated* face, so mapping the glyph's
   * own corners onto it is the rotation: for `shell_flat_sideways` the quad's
   * first edge points up the screen, which is a 90° counter-clockwise glyph
   * rotation. Rotating the glyph again here would cancel that and spill it.
   */
  private drawGlyph(
    ctx: CanvasRenderingContext2D,
    shell: ShellStats,
    image: AtlasImage,
    offsetX: number,
    offsetY: number,
    scale: number,
  ): void {
    const quad = shell.faceQuad.map(([x, y]) => [x * scale + offsetX, y * scale + offsetY] as const);
    const [topLeft, topRight, , bottomLeft] = quad;
    const glyph = image as CanvasImageSource;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(quad[0][0], quad[0][1]);
    ctx.lineTo(quad[1][0], quad[1][1]);
    ctx.lineTo(quad[2][0], quad[2][1]);
    ctx.lineTo(quad[3][0], quad[3][1]);
    ctx.closePath();
    ctx.clip();

    // Map source px to the quad's face-local axes. Source (0,0) lands on the
    // face-local top-left; source width follows top-left -> top-right and
    // source height follows top-left -> bottom-left.
    const widthPx = image.width;
    const heightPx = image.height;
    const a = (topRight[0] - topLeft[0]) / widthPx;
    const b = (topRight[1] - topLeft[1]) / widthPx;
    const c = (bottomLeft[0] - topLeft[0]) / heightPx;
    const d = (bottomLeft[1] - topLeft[1]) / heightPx;
    ctx.setTransform(a, b, c, d, topLeft[0], topLeft[1]);
    ctx.drawImage(glyph, 0, 0, widthPx, heightPx);
    ctx.restore();
  }

  /** Build the given shells in catalogue order; missing shells are not built. */
  async build(shellIds: readonly ShellId[] = SHELL_IDS): Promise<BakedTileAtlas> {
    const started = now();
    const requested = new Set(shellIds);
    const pages: AtlasPage[] = [];
    const sprites = new Map<TileRenderKey, BakedTileSprite>();
    let glyphSprites = 0;
    let bareSprites = 0;

    for (const shellId of SHELL_IDS) {
      if (!requested.has(shellId)) continue;
      const { page, sprites: shellSprites } = await this.buildShell(shellId, pages.length);
      pages.push(page);
      for (const sprite of shellSprites) {
        sprites.set(sprite.key, sprite);
        if (sprite.hasGlyph) glyphSprites += 1;
        else bareSprites += 1;
      }
    }

    const atlasPixels = pages.reduce((total, page) => total + page.width * page.height, 0);
    return {
      shells: this.options.shells,
      faces: this.options.faces,
      pages,
      sprites,
      stats: {
        shells: pages.length,
        pages: pages.length,
        sprites: sprites.size,
        glyphSprites,
        bareSprites,
        atlasPixels,
        rgbaBytes: atlasPixels * 4,
        pixelRatio: this.pixelRatio,
        buildMs: now() - started,
      },
    };
  }

  /** Compose all 6 x 38 keys. */
  buildAll(): Promise<BakedTileAtlas> {
    return this.build(SHELL_IDS);
  }
}

export { defaultCreateCanvas };
