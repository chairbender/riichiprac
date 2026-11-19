/**
 * Task 6A pass 3, second take: the crevice darkening is the tile's *own* bevel
 * sliver, not a band on its face.
 *
 * The first take mapped `ao_seam_*` onto the tile's `faceQuad`, so a 5.7 px
 * fade started at the plate's edge and ran *inward across the painted face*,
 * and both tiles of a joint drew one: an ~11 px smudge straddling every seam,
 * on surfaces that are not occluded at all. A contacting tile only shades the
 * narrow chamfer between the plate and the sprite's silhouette — for a flat
 * bucket that ring is 6.4 px wide (the 1.54 mm bevel), and it is lit on one
 * side only (measured 219 luma on the left vs 187 on the right for
 * `shell_flat_upright`).
 *
 * So a band here is:
 *
 *   - the ring between the sprite's opaque body edge and its face plate, at
 *     most {@link SEAM_BAND_MAX_PX} px wide (a 41 px side reveal is trimmed);
 *   - clipped to the sprite's own alpha, so nothing lands on the felt (the
 *     oblique wall and hand shells do not fill their body box);
 *   - drawn **once per joint**, on whichever of the two facing edges is
 *     brighter (an already-shaded edge has no highlight to remove), and not at
 *     all below {@link SEAM_MIN_RING_LUMA};
 *   - the `ao_seam_*` mask mapped across the band, so its authored fade lands
 *     on the band's width instead of the plate's.
 *
 * The result contains no pixels inside the plate: the scripted gate
 * (`boardShadows.test.ts`) asserts that every changed pixel sits within the
 * band, and none in the face interior.
 *
 * Bands and their overlays are static per (shell, side): the geometry comes
 * from `shells.json`, the luma from the committed sprite, and the mask from
 * `ao_seams.json`, so each pair is composed once and then blitted.
 */
import type { ShellStats } from './shellManifest';
import type { AoSeamRecord, AoSeamSide, AoSeamsManifest } from './shadowManifest';
import type { AtlasCanvas } from './TileAtlasBuilder';

/** An image source with known dimensions (browser image or Node canvas image). */
export interface SeamImage {
  readonly width: number;
  readonly height: number;
}

/** A drawing context, as much of Canvas 2D as this module uses. */
type SeamContext = CanvasRenderingContext2D;

/** Which edge of the *sprite* a neighbour sits against. */
export type SpriteSide = AoSeamSide;

/** The narrow ring a band occupies, in sprite @1x px. */
export interface SeamBand {
  readonly side: SpriteSide;
  /** Sprite-space rectangle: the ring's outer edge is the band's outer edge. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /**
   * Mean luma of the tile's pixels inside the band, alpha weighted. It decides
   * which tile of a joint takes the darkening, and whether it is lit enough to
   * bother.
   */
  readonly ringLuma: number;
  /** Share of the ring the tile actually covers (solid pixels). */
  readonly ringCoverage: number;
}

/** A composed band: the AO mask, clipped to the shell's own silhouette. */
export interface SeamOverlay {
  readonly canvas: AtlasCanvas;
  readonly band: SeamBand;
}

/**
 * Thinnest band drawn. Below this the sprite's anti-aliased silhouette eats the
 * gradient and the band is invisible.
 */
export const SEAM_BAND_MIN_PX = 2;
/**
 * Widest band drawn. The ring can be a 41 px side reveal (the near face of a
 * lying tile); a contact only shades the chamfer at the joint, so the band is
 * trimmed to this.
 */
export const SEAM_BAND_MAX_PX = 8;
/**
 * The outermost row of a sprite is the silhouette's own anti-aliasing, which
 * already blends into the felt. The band starts this far inside it so the
 * darkening lands on the chamfer itself instead of on that fringe.
 */
export const SEAM_AA_INSET_PX = 1;
/**
 * How much of the ring must be solid tile for the band to mean anything. An
 * oblique sprite (a side wall seen edge-on) has an axis-aligned ring that is
 * mostly transparent; darkening that would be darkening nothing on the tile, so
 * the side yields no band and its joint uses the other tile's edge.
 */
export const SEAM_MIN_RING_COVERAGE = 0.25;
/** A band darker than this has no highlight to remove; the joint draws nothing. */
export const SEAM_MIN_RING_LUMA = 45;
/** The AO masks are drawn at this share of their authored 35 % peak. */
export const SEAM_OPACITY = 0.6;

export interface SeamOverlayOptions {
  readonly createCanvas: (width: number, height: number) => AtlasCanvas;
  readonly seams: AoSeamsManifest;
  /** Resolve a manifest-relative path (a shell texture here) to an image. */
  readonly imageFor: (file: string) => SeamImage | null;
  /** Overlay resolution; 1 keeps the band on the @1x sprite grid. */
  readonly pixelRatio?: 1 | 2;
}

/**
 * The ring between a shell sprite's opaque body edge and its face plate, per
 * side, in sprite @1x px. The plate is the beveled plateau the glyph sits on;
 * the body box comes from the published padding, so the ring width is the
 * projected bevel (or a visible side reveal, which the band trims).
 */
export function seamBandRect(
  shell: ShellStats,
  side: SpriteSide,
): { x: number; y: number; width: number; height: number } {
  const left = shell.padding.left;
  const top = shell.padding.top;
  const right = shell.texWidth - shell.padding.right;
  const bottom = shell.texHeight - shell.padding.bottom;
  const xs = shell.faceQuad.map((corner) => corner[0]);
  const ys = shell.faceQuad.map((corner) => corner[1]);
  const plateLeft = Math.min(...xs);
  const plateRight = Math.max(...xs);
  const plateTop = Math.min(...ys);
  const plateBottom = Math.max(...ys);
  const clamp = (value: number): number =>
    Math.max(SEAM_BAND_MIN_PX, Math.min(SEAM_BAND_MAX_PX, value));
  const inset = SEAM_AA_INSET_PX;
  switch (side) {
    case 'left': {
      const width = clamp(plateLeft - left - inset);
      return { x: left + inset, y: top, width, height: bottom - top };
    }
    case 'right': {
      const width = clamp(right - plateRight - inset);
      return { x: right - inset - width, y: top, width, height: bottom - top };
    }
    case 'top': {
      const height = clamp(plateTop - top - inset);
      return { x: left, y: top + inset, width: right - left, height };
    }
    case 'bottom': {
      const height = clamp(bottom - plateBottom - inset);
      return { x: left, y: bottom - inset - height, width: right - left, height };
    }
  }
}

/**
 * The sub-rectangle of a mask that actually holds the fade, in mask pixels.
 *
 * The masks are full squares whose band fades over 9.6 % (u) / 7.2 % (v) of the
 * image and stays empty beyond it. Squeezing the whole square into a 6 px band
 * would compress that fade to half a pixel, so only the fade sub-rect is drawn
 * and it is stretched across the band: the band's *physical* width becomes the
 * fade distance, which is what puts the darkening on the chamfer and nowhere
 * else.
 */
export function maskFadeRect(
  record: AoSeamRecord,
  image: SeamImage,
): { x: number; y: number; width: number; height: number } {
  const fadeU = record.measured.fadeAxisFraction * image.width;
  const fadeV = record.measured.fadeAxisFraction * image.height;
  switch (record.edge) {
    case 'left':
      return { x: 0, y: 0, width: Math.max(1, fadeU), height: image.height };
    case 'right':
      return { x: image.width - Math.max(1, fadeU), y: 0, width: Math.max(1, fadeU), height: image.height };
    case 'top':
      return { x: 0, y: 0, width: image.width, height: Math.max(1, fadeV) };
    case 'bottom':
      return { x: 0, y: image.height - Math.max(1, fadeV), width: image.width, height: Math.max(1, fadeV) };
  }
}

/**
 * Map one crevice mask across a band rectangle: the mask's band sits on the
 * band's *outer* edge (the sprite silhouette) and its fade runs inward to the
 * face plate. The band's own width is therefore the fade distance.
 */
export function drawMaskInBand(
  ctx: SeamContext,
  record: AoSeamRecord,
  image: SeamImage,
  band: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  side: SpriteSide,
  opacity: number,
): void {
  const fade = maskFadeRect(record, image);
  const source = image as unknown as CanvasImageSource;
  // The fade sub-rect is already oriented correctly: every mask's darkest part
  // is on the edge that faces outward (`left` u=0, `right` u=1, `top` v=0,
  // `bottom` v=1), and those map onto the band's outer edge with a positive
  // scale in both axes, so no flip is needed.
  void side;
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.setTransform(
    band.width / fade.width,
    0,
    0,
    band.height / fade.height,
    band.x,
    band.y,
  );
  ctx.drawImage(source, fade.x, fade.y, fade.width, fade.height, 0, 0, fade.width, fade.height);
  ctx.restore();
}

/**
 * Builds and caches one overlay per (shell, side): the AO mask inside the bevel
 * ring, clipped to the sprite's silhouette. Nothing outside the sprite's own
 * pixels can darken, so a band can never touch the felt.
 */
export class SeamOverlayCache {
  private readonly options: SeamOverlayOptions;
  private readonly pixelRatio: 1 | 2;
  private readonly bands = new Map<string, SeamBand | null>();
  private readonly overlays = new Map<string, SeamOverlay | null>();

  constructor(options: SeamOverlayOptions) {
    this.options = options;
    this.pixelRatio = options.pixelRatio ?? 1;
  }

  /** The band geometry and its measured luma, or null when there is no ring. */
  bandFor(shell: ShellStats, side: SpriteSide): SeamBand | null {
    const key = `${shell.textureFile}:${side}`;
    if (this.bands.has(key)) return this.bands.get(key) ?? null;
    const rect = seamBandRect(shell, side);
    const measured = this.measure(shell, rect);
    const usable =
      measured !== null && measured.luma > 0 && measured.coverage >= SEAM_MIN_RING_COVERAGE;
    const band: SeamBand | null = usable
      ? { side, ...rect, ringLuma: measured!.luma, ringCoverage: measured!.coverage }
      : null;
    this.bands.set(key, band);
    return band;
  }

  /** The composed band overlay, ready to blit at the tile's draw position. */
  overlayFor(shell: ShellStats, side: SpriteSide): SeamOverlay | null {
    const key = `${shell.textureFile}:${side}`;
    if (this.overlays.has(key)) return this.overlays.get(key) ?? null;
    const band = this.bandFor(shell, side);
    const sprite = this.options.imageFor(shell.textureFile);
    if (!band || !sprite) {
      this.overlays.set(key, null);
      return null;
    }
    const ratio = this.pixelRatio;
    const width = Math.max(1, Math.round(shell.texWidth * ratio));
    const height = Math.max(1, Math.round(shell.texHeight * ratio));
    const canvas = this.options.createCanvas(width, height);
    const ctx = canvas.getContext('2d') as SeamContext | null;
    if (!ctx) throw new Error('seams: no 2D context for a band overlay');
    const record = this.options.seams.seams[side];
    const mask = this.options.imageFor(record.textureFile);
    if (!mask) {
      this.overlays.set(key, null);
      return null;
    }
    // 1. the mask's fade across the band …
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawMaskInBand(ctx, record, mask, band, side, SEAM_OPACITY);
    ctx.restore();
    // 2. … kept only where the tile's own pixels are, so the band follows the
    // real silhouette of an oblique shell and never spills onto the felt.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(sprite as unknown as CanvasImageSource, 0, 0, width, height);
    ctx.restore();
    const overlay: SeamOverlay = { canvas, band };
    this.overlays.set(key, overlay);
    return overlay;
  }

  /**
   * Mean luma of the ring's *solid* tile pixels, and what share of the ring they
   * are. Anti-aliased silhouette pixels are excluded: they are covered by the
   * felt, not by the chamfer, so they would flatter a ring that barely touches
   * the tile.
   */
  private measure(
    shell: ShellStats,
    rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  ): { luma: number; coverage: number } | null {
    const sprite = this.options.imageFor(shell.textureFile);
    if (!sprite) return null;
    const canvas = this.options.createCanvas(
      Math.max(1, shell.texWidth),
      Math.max(1, shell.texHeight),
    );
    const ctx = canvas.getContext('2d') as SeamContext | null;
    if (!ctx) return null;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(sprite as unknown as CanvasImageSource, 0, 0, shell.texWidth, shell.texHeight);
    const x0 = Math.max(0, Math.floor(rect.x));
    const y0 = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(shell.texWidth, Math.ceil(rect.x + rect.width));
    const y1 = Math.min(shell.texHeight, Math.ceil(rect.y + rect.height));
    if (x1 <= x0 || y1 <= y0) return null;
    const data = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let sum = 0;
    let solid = 0;
    let total = 0;
    for (let index = 0; index < data.length; index += 4) {
      total += 1;
      if (data[index + 3] < 230) continue;
      solid += 1;
      sum += data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    }
    if (total === 0 || solid === 0) return null;
    return { luma: sum / solid, coverage: solid / total };
  }
}
