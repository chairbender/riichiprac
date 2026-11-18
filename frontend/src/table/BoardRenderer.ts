/**
 * The runtime compositor for the rendered 2.5D board.
 *
 * `zoneLayout.ts` positions tiles inside a zone; `contactOverlays.ts` resolves
 * the contact decals; `boardPlan.ts` places the zones round the table. This is
 * the only module that touches a canvas: it draws the felt-space board with the
 * deterministic painter order (architecture Task 4.1/4.2) and nothing else.
 *
 * Per zone, in order:
 *   1. its shadow group, once: every footprint drawn at alpha 1, one Gaussian
 *      blur over the union, composited at the group's `coreAlpha` (§10.12);
 *   2. its bodies in `LayoutZone.bodies` order;
 *   3. each body's resolved contact decals, clipped to the neighbour body.
 *
 * No lighting, no relief shading and no 3D/WebGL: the shells already carry the
 * baked light and the faces are the committed carved decals.
 *
 * There is deliberately no per-frame loop. `prepare()` loads the images and
 * resolves the decals for a plan; `draw()` is then synchronous, and the React
 * host calls it only when the hand, the plan or the viewport changes.
 */
import { resolveContactOverlays } from './contactOverlays';
import type { ContactOverlay } from './contactOverlays';
import type { BoardAssets } from './boardAssets';
import type { BoardPlan, BoardZone } from './boardPlan';
import type { TileAtlas } from './TileAtlas';
import { blitTileSprite, tableAssetUrl } from './TileAtlas';
import { isFaceUpShellId, tileRenderKey } from './tiles';
import type { TileFaceId } from './tiles';

/** The viewport the board is fitted into, in CSS px. */
export interface BoardViewport {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
  /**
   * CSS px at the bottom reserved for the floating HUD (action strip + hand
   * dock). The felt still reaches the window edge; the board is fitted above
   * the HUD so the drawn human hand is not hidden behind the dock.
   */
  readonly bottomInset?: number;
}

/** Where the board sits inside the viewport, at CSS scale. */
export interface BoardFit {
  /** @1x board px to CSS px. */
  readonly scale: number;
  readonly originX: number;
  readonly originY: number;
}

export interface BoardRendererDeps {
  /** Offscreen canvas factory; tests and the review script inject one. */
  readonly createCanvas?: (width: number, height: number) => HTMLCanvasElement;
  /** Load one image URL. Tests and the review script read from disk. */
  readonly loadImage?: (url: string) => Promise<HTMLImageElement>;
  /** Map a manifest-relative asset path to a load URL. */
  readonly resolveUrl?: (file: string) => string;
}

/** The board fits the square felt: the smaller viewport side, less a margin. */
export const BOARD_MARGIN_FRACTION = 0.015;

/** The square felt's side at a viewport: it touches the top and bottom edge. */
export function feltSidePx(cssWidth: number, cssHeight: number): number {
  // A square whose height is the full window: on a wide screen its sides are
  // inside the frame (the scene background shows beside it); on a tall one it
  // is wider than the window and the sides are cropped. The width is only read
  // to keep the function total for a caller with no height yet.
  void cssWidth;
  return cssHeight;
}

/** Fit the whole board inside the visible square of felt. */
export function fitBoardPlan(
  plan: BoardPlan,
  cssWidth: number,
  cssHeight: number,
  bottomInset = 0,
): BoardFit {
  const side = Math.min(cssWidth, cssHeight);
  const margin = Math.max(6, side * BOARD_MARGIN_FRACTION);
  const availableWidth = Math.max(1, side - margin * 2);
  const availableHeight = Math.max(
    1,
    cssHeight - margin * 2 - Math.max(0, bottomInset),
  );
  if (plan.width <= 0 || plan.height <= 0) {
    return { scale: 1, originX: 0, originY: 0 };
  }
  const scale = Math.min(
    availableWidth / plan.width,
    availableHeight / plan.height,
  );
  return {
    scale,
    originX: (cssWidth - plan.width * scale) / 2,
    originY: margin + (availableHeight - plan.height * scale) / 2,
  };
}

interface ShadowRect {
  readonly cx: number;
  readonly cy: number;
  readonly halfX: number;
  readonly halfY: number;
  readonly radius: number;
  readonly angleDeg: number;
}

function rotatePoint(
  x: number,
  y: number,
  pivotX: number,
  pivotY: number,
  degrees: number,
): [number, number] {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - pivotX;
  const dy = y - pivotY;
  return [pivotX + dx * cos - dy * sin, pivotY + dx * sin + dy * cos];
}

function shapeBounds(rect: ShadowRect): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const radians = (rect.angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const halfX = rect.halfX * cos + rect.halfY * sin;
  const halfY = rect.halfX * sin + rect.halfY * cos;
  return {
    left: rect.cx - halfX,
    top: rect.cy - halfY,
    right: rect.cx + halfX,
    bottom: rect.cy + halfY,
  };
}

function roundedRectPath(
  context: CanvasRenderingContext2D,
  halfX: number,
  halfY: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, halfX, halfY));
  context.beginPath();
  context.moveTo(-halfX + r, -halfY);
  context.lineTo(halfX - r, -halfY);
  context.arcTo(halfX, -halfY, halfX, -halfY + r, r);
  context.lineTo(halfX, halfY - r);
  context.arcTo(halfX, halfY, halfX - r, halfY, r);
  context.lineTo(-halfX + r, halfY);
  context.arcTo(-halfX, halfY, -halfX, halfY - r, r);
  context.lineTo(-halfX, -halfY + r);
  context.arcTo(-halfX, -halfY, -halfX + r, -halfY, r);
  context.closePath();
}

function defaultCreateCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function defaultLoadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = 'async';
  const loaded = new Promise<HTMLImageElement>((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`cannot decode image ${url}`));
  });
  image.src = url;
  return loaded;
}

/** The drawn board's fitted position, for the host's DOM overlays. */
export interface BoardRenderResult {
  readonly fit: BoardFit;
}

export class BoardRenderer {
  private readonly atlas: TileAtlas;
  private readonly assets: BoardAssets;
  private readonly createCanvas: (width: number, height: number) => HTMLCanvasElement;
  private readonly loadImage: (url: string) => Promise<HTMLImageElement>;
  private readonly resolveUrl: (file: string) => string;
  private readonly images = new Map<string, HTMLImageElement>();
  private overlaysByZone: ContactOverlay[][] = [];
  private preparedSignature: string | null = null;
  private mask: HTMLCanvasElement | null = null;

  constructor(
    atlas: TileAtlas,
    assets: BoardAssets,
    deps: BoardRendererDeps = {},
  ) {
    this.atlas = atlas;
    this.assets = assets;
    this.createCanvas = deps.createCanvas ?? defaultCreateCanvas;
    this.loadImage = deps.loadImage ?? defaultLoadImage;
    this.resolveUrl = deps.resolveUrl ?? tableAssetUrl;
  }

  /** How many images the last `prepare()` loaded (the review script prints it). */
  get loadedImages(): number {
    return this.images.size;
  }

  /** How many contact decals the last `prepare()` resolved. */
  get resolvedOverlays(): number {
    return this.overlaysByZone.reduce((total, zone) => total + zone.length, 0);
  }

  /** Resolve every zone's decals and load every texture the plan can draw. */
  async prepare(plan: BoardPlan): Promise<void> {
    const signature = plan.zones
      .map(
        (entry) =>
          `${entry.zone.id}:${entry.zone.bodies.map((body) => body.shell).join(',')}`,
      )
      .join('|');
    if (signature === this.preparedSignature) return;

    const overlays = this.assets.overlays;
    this.overlaysByZone = plan.zones.map((entry) =>
      overlays
        ? resolveContactOverlays(
            this.atlas.shells,
            overlays,
            entry.zone,
            this.assets.catches,
            this.assets.lyingCatches,
          )
        : [],
    );

    const files = new Set<string>();
    for (const entry of plan.zones) {
      for (const body of entry.zone.bodies) {
        const shell = this.atlas.shells.shells[body.shell];
        if (!shell) continue;
        const face = body.face;
        const fromAtlas =
          face !== null &&
          isFaceUpShellId(body.shell) &&
          this.atlas.hasSprite(tileRenderKey(body.shell, face));
        if (!fromAtlas) files.add(shell.textureFile);
      }
    }
    for (const zoneOverlays of this.overlaysByZone) {
      for (const overlay of zoneOverlays) files.add(overlay.textureFile);
    }

    const missing = [...files].filter((file) => !this.images.has(file));
    const settled = await Promise.allSettled(
      missing.map(async (file) => {
        const image = await this.loadImage(this.resolveUrl(file));
        return [file, image] as const;
      }),
    );
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        this.images.set(entry.value[0], entry.value[1]);
      } else {
        // A single missing decal must not blank the table; the body it shades
        // is still drawn, just without the contact band.
        console.warn(`rendered table: ${String(entry.reason)}`);
      }
    }
    this.preparedSignature = signature;
  }

  /**
   * Draw the plan into the canvas. Returns the fit the host needs for its DOM
   * overlays; null when the canvas has no 2D context (jsdom, or a browser that
   * refused one).
   */
  draw(
    plan: BoardPlan,
    canvas: HTMLCanvasElement,
    viewport: BoardViewport,
  ): BoardRenderResult | null {
    if (
      !Number.isFinite(viewport.cssWidth) ||
      !Number.isFinite(viewport.cssHeight) ||
      viewport.cssWidth <= 0 ||
      viewport.cssHeight <= 0
    ) {
      return null;
    }
    const context = canvas.getContext('2d');
    if (!context) return null;

    const dpr = Math.max(0.5, Math.min(4, viewport.dpr || 1));
    const width = Math.max(1, Math.round(viewport.cssWidth * dpr));
    const height = Math.max(1, Math.round(viewport.cssHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const fit = fitBoardPlan(
      plan,
      viewport.cssWidth,
      viewport.cssHeight,
      viewport.bottomInset ?? 0,
    );
    if (plan.zones.length === 0) return { fit };

    context.setTransform(
      fit.scale * dpr,
      0,
      0,
      fit.scale * dpr,
      fit.originX * dpr,
      fit.originY * dpr,
    );
    const drawnGroups = new Set<string>();
    for (let index = 0; index < plan.zones.length; index += 1) {
      const entry = plan.zones[index];
      const group = entry.zone.shadowGroup;
      if (!drawnGroups.has(group)) {
        drawnGroups.add(group);
        const members = plan.zones.filter(
          (candidate) => candidate.zone.shadowGroup === group,
        );
        this.drawGroupShadow(context, members, fit, dpr);
      }
      this.drawZone(context, entry, this.overlaysByZone[index] ?? []);
    }
    return { fit };
  }

  private drawZone(
    context: CanvasRenderingContext2D,
    entry: BoardZone,
    overlays: readonly ContactOverlay[],
  ): void {
    const zone = entry.zone;
    const grouped = Array.from(
      { length: zone.bodies.length },
      () => [] as ContactOverlay[],
    );
    for (const overlay of overlays) grouped[overlay.bodyIndex].push(overlay);

    context.save();
    context.translate(entry.x, entry.y);
    if (entry.scale !== 1) context.scale(entry.scale, entry.scale);
    if (zone.rotationDeg !== 0) {
      context.translate(zone.pivotX, zone.pivotY);
      context.rotate((zone.rotationDeg * Math.PI) / 180);
      context.translate(-zone.pivotX, -zone.pivotY);
    }

    for (let index = 0; index < zone.bodies.length; index += 1) {
      const body = zone.bodies[index];
      this.drawBody(context, body.shell, body.face, body.drawX, body.drawY);
      for (const overlay of grouped[index]) {
        const image = this.images.get(overlay.textureFile);
        if (!image) continue;
        context.save();
        context.beginPath();
        overlay.clip.points.forEach(([x, y], pointIndex) => {
          if (pointIndex === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.closePath();
        context.clip();
        context.drawImage(
          image,
          overlay.drawX,
          overlay.drawY,
          overlay.texWidth,
          overlay.texHeight,
        );
        context.restore();
      }
    }
    context.restore();
  }

  private drawBody(
    context: CanvasRenderingContext2D,
    shellId: string,
    face: TileFaceId | null,
    drawX: number,
    drawY: number,
  ): void {
    const shell = this.atlas.shells.shells[shellId];
    if (face !== null && isFaceUpShellId(shellId)) {
      const key = tileRenderKey(shellId, face);
      if (this.atlas.hasSprite(key)) {
        const sprite = this.atlas.getSprite(key);
        blitTileSprite(context, this.atlas.getPage(sprite), sprite, drawX, drawY);
        return;
      }
    }
    if (!shell) return;
    const image = this.images.get(shell.textureFile);
    if (!image) return;
    context.drawImage(image, drawX, drawY, shell.texWidth, shell.texHeight);
  }

  /**
   * One shadow group: union the hard footprints at alpha 1, blur the union
   * once, composite at the group's core alpha. The mask is built in device px
   * so the blur sigma scales with the board and stays a single blur.
   */
  private drawGroupShadow(
    context: CanvasRenderingContext2D,
    members: readonly BoardZone[],
    fit: BoardFit,
    dpr: number,
  ): void {
    const rects: ShadowRect[] = [];
    let sigma = 0;
    let coreAlpha = 0;
    let color = '#0b1418';
    for (const entry of members) {
      const zone = entry.zone;
      const scale = entry.scale;
      for (const tile of zone.shadows) {
        const shell = this.atlas.shells.shells[tile.shell];
        if (!shell) continue;
        const shape = shell.shadowShape;
        sigma = Math.max(sigma, shape.sigmaPx1x * scale);
        coreAlpha = shape.coreAlpha;
        color = shape.colorHex;
        let cx = entry.x + scale * (tile.gridX + shape.centrePx[0]);
        let cy = entry.y + scale * (tile.gridY + shape.centrePx[1]);
        let angleDeg = shape.angleDeg;
        if (zone.rotationDeg !== 0) {
          [cx, cy] = rotatePoint(
            cx,
            cy,
            entry.x + scale * zone.pivotX,
            entry.y + scale * zone.pivotY,
            zone.rotationDeg,
          );
          angleDeg += zone.rotationDeg;
        }
        rects.push({
          cx,
          cy,
          halfX: shape.halfPx[0] * scale,
          halfY: shape.halfPx[1] * scale,
          radius: shape.radiusPx * scale,
          angleDeg,
        });
      }
    }
    if (rects.length === 0 || sigma <= 0 || coreAlpha <= 0) return;

    const scaleDev = fit.scale * dpr;
    if (!(scaleDev > 0)) return;

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const rect of rects) {
      const bounds = shapeBounds(rect);
      left = Math.min(left, bounds.left);
      top = Math.min(top, bounds.top);
      right = Math.max(right, bounds.right);
      bottom = Math.max(bottom, bounds.bottom);
    }
    const pad = Math.ceil(3 * sigma) + 1;
    const maskWidth = Math.max(1, Math.ceil((right - left + pad * 2) * scaleDev));
    const maskHeight = Math.max(1, Math.ceil((bottom - top + pad * 2) * scaleDev));
    if (!this.mask) this.mask = this.createCanvas(maskWidth, maskHeight);
    if (this.mask.width < maskWidth) this.mask.width = maskWidth;
    if (this.mask.height < maskHeight) this.mask.height = maskHeight;
    const maskContext = this.mask.getContext('2d');
    if (!maskContext) return;

    maskContext.setTransform(1, 0, 0, 1, 0, 0);
    maskContext.clearRect(0, 0, this.mask.width, this.mask.height);
    maskContext.setTransform(
      scaleDev,
      0,
      0,
      scaleDev,
      -(left - pad) * scaleDev,
      -(top - pad) * scaleDev,
    );
    maskContext.fillStyle = color;
    for (const rect of rects) {
      maskContext.save();
      maskContext.translate(rect.cx, rect.cy);
      if (rect.angleDeg !== 0) {
        maskContext.rotate((rect.angleDeg * Math.PI) / 180);
      }
      roundedRectPath(maskContext, rect.halfX, rect.halfY, rect.radius);
      maskContext.fill();
      maskContext.restore();
    }

    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.filter = `blur(${(sigma * scaleDev).toFixed(2)}px)`;
    context.globalAlpha = coreAlpha;
    context.drawImage(
      this.mask,
      fit.originX * dpr + (left - pad) * scaleDev,
      fit.originY * dpr + (top - pad) * scaleDev,
    );
    context.filter = 'none';
    context.restore();
  }
}
