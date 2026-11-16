/**
 * `TileAtlasBuilder`: composite every `(shellType, faceVariant, tileFace)`
 * triple once, at startup.
 *
 * Contract (see `2_5d_mahjong_tile_rendering_architecture.md` Phase 2 and
 * `tools/render/README.md` "Phase 2"):
 *
 *  - draw the pre-baked Blender shell PNG for the requested shell, untouched;
 *  - map the glyph's own top-left/top-right/bottom-right/bottom-left corners
 *    onto the shell's published `faceQuad`, which is in face-local order. For
 *    `shell_flat_sideways` the quad's first edge points up the screen, which is
 *    the 90° counter-clockwise glyph rotation; rotating the glyph again here
 *    would cancel it. `glyphRotationDegFor` covers the shells whose published
 *    `faceRotationDeg` differs from the quad's own rotation (the back-wall dora
 *    shells); it is 0 for every Phase 2 shell;
 *  - clip to the quad, so the glyph can never touch the bevel, the resin seam
 *    or the transparent shadow/AO margin;
 *  - store a `Map<TileRenderKey, BakedTileSprite>` with the atlas UV rect and
 *    the logical layout metrics. Frame code only blits.
 *
 * A page is one offscreen 2D canvas per shell, built lazily. The atlas is
 * composed in the browser at startup; no glyph is rasterised per frame and no
 * WebGL/3D context is involved.
 *
 * Face-down wall shells are bare: no glyph, no face variant, no atlas entry.
 * The board draws them directly from their own PNGs.
 */
import {
  FACE_UP_SHELL_IDS,
  TILE_FACE_IDS,
  faceVariantForShell,
  tileRenderKey,
} from './tiles';
import type { FaceUpShellId, TileFaceId, TileRenderKey } from './tiles';
import { faceHasInk } from './faceManifest';
import type { FacesManifest } from './faceManifest';
import { decalFor } from './decalManifest';
import type { DecalRecord, DecalRotation, DecalsManifest } from './decalManifest';
import {
  decalLightRotationDegFor,
  decalSymbolRotationDegFor,
  glyphRotationDegFor,
} from './shellManifest';
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
  readonly shell: FaceUpShellId;
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
  readonly shell: FaceUpShellId;
  readonly variant: string;
  readonly face: TileFaceId;
  /** Index into {@link BakedTileAtlas.pages}. */
  readonly pageIndex: number;
  /** Atlas rect in page pixels. Blit source rect for `drawImage`. */
  readonly uv: Rect;
  /** Atlas pixels per CSS pixel (1 or 2). */
  readonly pixelRatio: number;
  /** True when a glyph was composited; false for blank and haku. */
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
  /** Desired on-screen glyph rotation. */
  readonly faceRotationDeg: 0 | 90 | 180 | 270;
  /** Extra rotation applied inside the face plate (0 for every Phase 2 shell). */
  readonly glyphRotationDeg: 0 | 90 | 180 | 270;
  /** The carved decal used, or null when the flat glyph was composited. */
  readonly decalFile: string | null;
  readonly decalLightRotationDeg: DecalRotation | null;
  readonly decalSymbolRotationDeg: DecalRotation | null;
}

export interface AtlasStats {
  readonly shells: number;
  readonly pages: number;
  readonly sprites: number;
  readonly glyphSprites: number;
  readonly bareSprites: number;
  /** Sprites composited from a carved decal (subset of glyphSprites). */
  readonly decalSprites: number;
  /** Sprites composited from a flat glyph (subset of glyphSprites). */
  readonly flatGlyphSprites: number;
  readonly atlasPixels: number;
  readonly rgbaBytes: number;
  readonly pixelRatio: number;
  readonly buildMs: number;
}

export interface BakedTileAtlas {
  readonly shells: ShellsManifest;
  readonly faces: FacesManifest;
  readonly decals: DecalsManifest | null;
  readonly pages: readonly AtlasPage[];
  readonly sprites: ReadonlyMap<TileRenderKey, BakedTileSprite>;
  readonly stats: AtlasStats;
}

export interface TileAtlasBuilderOptions {
  readonly shells: ShellsManifest;
  readonly faces: FacesManifest;
  /** Optional carved decal set; missing faces fall back to the flat glyph. */
  readonly decals?: DecalsManifest;
  /** Throw when a face has no carved decal instead of falling back. */
  readonly requireDecals?: boolean;
  readonly resolveUrl: ResolveAssetUrl;
  readonly loadImage: LoadAtlasImage;
  readonly createCanvas?: CreateAtlasCanvas;
  /** Atlas pixels per CSS px. Defaults to 1; @2x is opt-in (4x the memory). */
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

export function defaultCreateCanvas(width: number, height: number): AtlasCanvas {
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
      `${scale === 2 ? shell.textureFile2x : shell.textureFile} is ${image.width}x${image.height}, expected ${width}x${height} at ${scale}x`,
    );
  }
}

/** Sprite slots in a face-up shell page: one per inked face plus one bare. */
export function atlasSlotCount(faces: FacesManifest): number {
  const inked = TILE_FACE_IDS.filter((face) => faceHasInk(faces.faces[face])).length;
  return inked + (inked < TILE_FACE_IDS.length ? 1 : 0);
}

/** Page geometry for one shell, mirroring the builder exactly. */
export function planAtlasPage(
  texWidth: number,
  texHeight: number,
  slots: number,
  pixelRatio: 1 | 2,
  maxPageWidthPx = 2048,
): { width: number; height: number; slots: number; columns: number; rows: number } {
  const spriteWidth = texWidth * pixelRatio;
  const spriteHeight = texHeight * pixelRatio;
  const columns = Math.max(1, Math.min(slots, Math.floor(maxPageWidthPx / spriteWidth)));
  const rows = Math.ceil(slots / columns);
  return { width: columns * spriteWidth, height: rows * spriteHeight, slots, columns, rows };
}

/**
 * The decoded RGBA cost of a whole Phase 2 atlas at a pixel ratio. `TileAtlas`
 * uses it to refuse an @2x atlas that would exceed the device memory budget.
 */
export function estimateAtlasBytes(
  shells: ShellsManifest,
  faces: FacesManifest,
  pixelRatio: 1 | 2,
  maxPageWidthPx = 2048,
): number {
  const slots = atlasSlotCount(faces);
  let pixels = 0;
  for (const id of FACE_UP_SHELL_IDS) {
    const shell = shells.shells[id];
    if (!shell) throw new Error(`shells.json has no ${id}`);
    const page = planAtlasPage(shell.texWidth, shell.texHeight, slots, pixelRatio, maxPageWidthPx);
    pixels += page.width * page.height;
  }
  return pixels * 4;
}

/**
 * Destination corners for the glyph's top-left, top-right and bottom-left
 * under an extra rotation inside the face plate. The fourth corner follows
 * from the affine, and the clip to `faceQuad` keeps any trapezoid mismatch
 * inside the plate.
 */
function glyphDestCorners(
  quad: FaceQuad,
  extraRotation: 0 | 90 | 180 | 270,
): readonly [readonly [number, number], readonly [number, number], readonly [number, number]] {
  const [topLeft, topRight, bottomRight, bottomLeft] = quad;
  switch (extraRotation) {
    case 0:
      return [topLeft, topRight, bottomLeft];
    case 90:
      return [bottomLeft, topLeft, bottomRight];
    case 180:
      return [bottomRight, bottomLeft, topRight];
    case 270:
      return [topRight, bottomRight, topLeft];
  }
}

export class TileAtlasBuilder {
  private readonly options: TileAtlasBuilderOptions;
  readonly pixelRatio: 1 | 2;
  private readonly maxPageWidthPx: number;
  private readonly createCanvas: CreateAtlasCanvas;
  private readonly glyphCache = new Map<TileFaceId, Promise<AtlasImage>>();
  private readonly decalCache = new Map<string, Promise<AtlasImage>>();

  constructor(options: TileAtlasBuilderOptions) {
    this.options = options;
    this.pixelRatio = options.pixelRatio ?? 1;
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

  /** Load and cache one carved decal; shared by every slot with that rotation. */
  private decal(record: DecalRecord): Promise<AtlasImage> {
    let pending = this.decalCache.get(`${record.textureFile}`);
    if (!pending) {
      pending = this.options.loadImage(this.options.resolveUrl(record.textureFile));
      this.decalCache.set(`${record.textureFile}`, pending);
    }
    return pending;
  }

  /**
   * Drop decoded source images once every face-up page has been composed. The
   * atlas pixels are already copied into the pages, so keeping 37 decoded
   * glyphs or decals would cost megabytes for nothing.
   */
  releaseGlyphCache(): void {
    this.glyphCache.clear();
    this.decalCache.clear();
  }

  /** Prefer a carved decal for this shell/face, else the flat glyph. */
  private async sourceFor(
    face: TileFaceId,
    lightRotationDeg: DecalRotation,
    symbolRotationDeg: DecalRotation,
  ): Promise<{ image: AtlasImage; decal: DecalRecord | null }> {
    const record = decalFor(this.options.decals, face, lightRotationDeg, symbolRotationDeg);
    if (record) {
      return { image: await this.decal(record), decal: record };
    }
    if (this.options.requireDecals) {
      throw new Error(
        `face ${face} has no carved decal for light ${lightRotationDeg} / symbol ${symbolRotationDeg}`,
      );
    }
    return { image: await this.glyph(face), decal: null };
  }

  /**
   * Compose one shell page. One slot per inked face plus a shared bare slot for
   * `blank`/`5z`. Face-down shells are rejected: they are bare and are drawn
   * from their own PNG, not from the atlas.
   */
  async buildShell(
    shellId: FaceUpShellId,
    pageIndex = FACE_UP_SHELL_IDS.indexOf(shellId),
  ): Promise<ShellPageResult> {
    if (!FACE_UP_SHELL_IDS.includes(shellId)) {
      throw new Error(`${shellId} is not a Phase 2 face-up shell; it has no atlas entry`);
    }
    const shell = this.options.shells.shells[shellId];
    if (!shell) throw new Error(`shells.json has no ${shellId}`);
    if (!shell.faceUp) {
      throw new Error(`${shellId} is face-down and bare; it has no atlas entry`);
    }
    const scale = this.pixelRatio;
    const variant = faceVariantForShell(shellId);
    const glyphRotationDeg = glyphRotationDegFor(shell);
    const lightRotationDeg = decalLightRotationDegFor(shell);
    const symbolRotationDeg = decalSymbolRotationDegFor(shell);
    const inkedFaces = TILE_FACE_IDS.filter((face) => faceHasInk(this.options.faces.faces[face]));
    const slots = atlasSlotCount(this.options.faces);
    const { width: pageWidth, height: pageHeight, columns } = planAtlasPage(
      shell.texWidth,
      shell.texHeight,
      slots,
      scale,
      this.maxPageWidthPx,
    );
    const spriteWidth = shell.texWidth * scale;
    const spriteHeight = shell.texHeight * scale;

    const shellUrl = this.options.resolveUrl(
      scale === 2 ? shell.textureFile2x : shell.textureFile,
    );
    const [shellImage, ...sources] = await Promise.all([
      this.options.loadImage(shellUrl),
      ...inkedFaces.map((face) => this.sourceFor(face, lightRotationDeg, symbolRotationDeg)),
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

    // Pass 1: every shell body, in slot order. The face pass is strictly
    // afterwards, so no glyph or decal can ever be under a later shell blit.
    for (let slot = 0; slot < slots; slot += 1) {
      const { x, y } = slotOffset(slot);
      ctx.drawImage(shellImage as CanvasImageSource, x, y, spriteWidth, spriteHeight);
    }

    // Pass 2: the carved decal or flat glyph into its own slot, clipped to the
    // face plate. A decal already carries its baked light rotation; only the
    // symbol's in-plate rotation is applied here.
    inkedFaces.forEach((_face, index) => {
      const slot = index + 1;
      const { x, y } = slotOffset(slot);
      const source = sources[index];
      if (source.decal) {
        this.drawDecal(ctx, shell, source.decal, source.image, x, y, scale, symbolRotationDeg);
      } else {
        this.drawGlyph(ctx, shell, source.image, x, y, scale, glyphRotationDeg);
      }
    });

    const page: AtlasPage = {
      shell: shellId,
      canvas,
      width: pageWidth,
      height: pageHeight,
      pixelRatio: scale,
      slots,
      bytes: pageWidth * pageHeight * 4,
    };

    const sourceByFace = new Map<TileFaceId, { slot: number; decal: DecalRecord | null }>();
    inkedFaces.forEach((face, index) => sourceByFace.set(face, { slot: index + 1, decal: sources[index].decal }));

    const sprites = TILE_FACE_IDS.map((face): BakedTileSprite => {
      const entry = sourceByFace.get(face);
      const offset = slotOffset(entry?.slot ?? 0);
      return {
        key: tileRenderKey(shellId, face),
        shell: shellId,
        variant,
        face,
        pageIndex,
        uv: { x: offset.x, y: offset.y, width: spriteWidth, height: spriteHeight },
        pixelRatio: scale,
        hasGlyph: Boolean(entry),
        texWidth: shell.texWidth,
        texHeight: shell.texHeight,
        anchorX: shell.anchorX,
        anchorY: shell.anchorY,
        advanceWidth: shell.advanceWidth,
        advanceHeight: shell.advanceHeight,
        gridStepPx: shell.gridStepPx,
        faceQuad: shell.faceQuad,
        faceRotationDeg: shell.faceRotationDeg,
        glyphRotationDeg,
        decalFile: entry?.decal?.textureFile ?? null,
        decalLightRotationDeg: entry?.decal ? lightRotationDeg : null,
        decalSymbolRotationDeg: entry?.decal ? symbolRotationDeg : null,
      };
    });

    return { page, sprites };
  }

  /**
   * Draw one carved decal into the shell's face plate.
   *
   * A decal carries a transparent safety ring around the face plate, so the
   * manifest's `facePlateRect` selects the inner image sub-rect. That sub-rect
   * maps to the same face-local sub-quad of `faceQuad`; the rest of the image
   * (the ring) is never drawn. Phase 2 decals have symbol rotation 0; a dora
   * decal with 180/270 will extend this method with rotated source corners.
   */
  private drawDecal(
    ctx: CanvasRenderingContext2D,
    shell: ShellStats,
    record: DecalRecord,
    image: AtlasImage,
    offsetX: number,
    offsetY: number,
    scale: number,
    symbolRotationDeg: DecalRotation,
  ): void {
    if (symbolRotationDeg !== 0) {
      throw new Error(
        `${record.face} needs symbol rotation ${symbolRotationDeg}; only 0 is baked in Phase 2`,
      );
    }
    const quad = shell.faceQuad.map(
      ([x, y]) => [x * scale + offsetX, y * scale + offsetY] as const,
    ) as unknown as FaceQuad;
    const [u0, v0, u1, v1] = record.facePlateRect;
    const point = (u: number, v: number): readonly [number, number] => [
      quad[0][0] + u * (quad[1][0] - quad[0][0]) + v * (quad[3][0] - quad[0][0]),
      quad[0][1] + u * (quad[1][1] - quad[0][1]) + v * (quad[3][1] - quad[0][1]),
    ];
    const origin = point(u0, v0);
    const right = point(u1, v0);
    const down = point(u0, v1);
    const sourceX = u0 * image.width;
    const sourceY = v0 * image.height;
    const sourceWidth = (u1 - u0) * image.width;
    const sourceHeight = (v1 - v0) * image.height;
    const glyph = image as CanvasImageSource;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(quad[0][0], quad[0][1]);
    ctx.lineTo(quad[1][0], quad[1][1]);
    ctx.lineTo(quad[2][0], quad[2][1]);
    ctx.lineTo(quad[3][0], quad[3][1]);
    ctx.closePath();
    ctx.clip();

    const a = (right[0] - origin[0]) / sourceWidth;
    const b = (right[1] - origin[1]) / sourceWidth;
    const c = (down[0] - origin[0]) / sourceHeight;
    const d = (down[1] - origin[1]) / sourceHeight;
    ctx.setTransform(a, b, c, d, origin[0], origin[1]);
    ctx.drawImage(glyph, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    ctx.restore();
  }

  /**
   * Draw one flat glyph into the shell's face plate.
   *
   * `faceQuad` is published in face-local order (top-left, top-right,
   * bottom-right, bottom-left) of the *rotated* face, so mapping the glyph's
   * own corners onto it is the rotation: for `shell_flat_sideways` the quad's
   * first edge points up the screen, which is a 90° counter-clockwise glyph
   * rotation. `glyphRotationDeg` is the additional in-plate rotation for the
   * dora shells (0 for Phase 2).
   */
  private drawGlyph(
    ctx: CanvasRenderingContext2D,
    shell: ShellStats,
    image: AtlasImage,
    offsetX: number,
    offsetY: number,
    scale: number,
    glyphRotationDeg: 0 | 90 | 180 | 270,
  ): void {
    const quad = shell.faceQuad.map(
      ([x, y]) => [x * scale + offsetX, y * scale + offsetY] as const,
    ) as unknown as FaceQuad;
    const [destTopLeft, destTopRight, destBottomLeft] = glyphDestCorners(
      quad,
      glyphRotationDeg,
    );
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
    // face-local corner chosen by the extra rotation; source width follows the
    // destination top edge and source height its left edge.
    const widthPx = image.width;
    const heightPx = image.height;
    const a = (destTopRight[0] - destTopLeft[0]) / widthPx;
    const b = (destTopRight[1] - destTopLeft[1]) / widthPx;
    const c = (destBottomLeft[0] - destTopLeft[0]) / heightPx;
    const d = (destBottomLeft[1] - destTopLeft[1]) / heightPx;
    ctx.setTransform(a, b, c, d, destTopLeft[0], destTopLeft[1]);
    ctx.drawImage(glyph, 0, 0, widthPx, heightPx);
    ctx.restore();
  }

  /** Build the given shells in catalogue order; missing shells are not built. */
  async build(
    shellIds: readonly FaceUpShellId[] = FACE_UP_SHELL_IDS,
  ): Promise<BakedTileAtlas> {
    const started = now();
    const requested = new Set(shellIds);
    const pages: AtlasPage[] = [];
    const sprites = new Map<TileRenderKey, BakedTileSprite>();
    let glyphSprites = 0;
    let bareSprites = 0;
    let decalSprites = 0;
    let flatGlyphSprites = 0;

    for (const shellId of FACE_UP_SHELL_IDS) {
      if (!requested.has(shellId)) continue;
      const { page, sprites: shellSprites } = await this.buildShell(shellId, pages.length);
      pages.push(page);
      for (const sprite of shellSprites) {
        sprites.set(sprite.key, sprite);
        if (sprite.hasGlyph) {
          glyphSprites += 1;
          if (sprite.decalFile) decalSprites += 1;
          else flatGlyphSprites += 1;
        } else {
          bareSprites += 1;
        }
      }
    }

    const atlasPixels = pages.reduce((total, page) => total + page.width * page.height, 0);
    return {
      shells: this.options.shells,
      faces: this.options.faces,
      decals: this.options.decals ?? null,
      pages,
      sprites,
      stats: {
        shells: pages.length,
        pages: pages.length,
        sprites: sprites.size,
        glyphSprites,
        bareSprites,
        decalSprites,
        flatGlyphSprites,
        atlasPixels,
        rgbaBytes: atlasPixels * 4,
        pixelRatio: this.pixelRatio,
        buildMs: now() - started,
      },
    };
  }

  /** Compose every Phase 2 face-up shell. */
  buildAll(): Promise<BakedTileAtlas> {
    return this.build(FACE_UP_SHELL_IDS);
  }
}
