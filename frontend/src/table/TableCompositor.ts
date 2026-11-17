/**
 * The rendered table's 2D compositor (architecture Phase 4).
 *
 * `zoneLayout.ts` places tiles; `boardLayout.ts` places the zones on screen in
 * Task 4.1's painter order and publishes each shadow union's hard shapes. This
 * module is the strict painter and the group-shadow recipe:
 *
 *   - one offscreen layer per shadow group: draw every hard shape at alpha 1,
 *     blur that layer **once** at the group's sigma, then composite it at
 *     `coreAlpha` (never per-tile filters, so overlaps merge instead of
 *     double-darkening and a fan/wall join has no seam);
 *   - one offscreen layer per body zone, with the zone's bodies drawn in the
 *     published back-to-front order and the Phase 3.5 contact decals drawn
 *     between them;
 *   - composite every shadow layer, then every body zone, in `Board.zones`
 *     order.
 *
 * Layers are cached by a content signature. `update()` rebuilds only the zones
 * (and shadow groups) whose tiles moved, which is the rebuild contract Phase 5
 * needs for a discard, a call, or a hover lift. Compositing is still one
 * `drawImage` per layer onto the visible canvas; no blur runs twice for an
 * unchanged group.
 *
 * All coordinates are @1x board px. The host scales the visible canvas with
 * CSS; nothing here knows or cares about the display scale.
 */
import type { Board, BoardShadowGroup, BoardZone } from './boardLayout';
import type { AtlasPage, BakedTileSprite } from './TileAtlasBuilder';
import { overlaysByBody } from './contactOverlays';
import type { ContactOverlay } from './contactOverlays';
import type { ShellsManifest } from './shellManifest';
import { isFaceUpShellId, tileRenderKey } from './tiles';
import type { TileRenderKey } from './tiles';
import { blitTileSprite } from './TileAtlas';

/** A canvas the compositor can draw into; DOM or a test double. */
export interface BoardCanvas {
  width: number;
  height: number;
  getContext(contextId: '2d'): CanvasRenderingContext2D | null;
}

/** The compositor only needs the atlas' sprite lookup, not the loader. */
export interface TileSpriteSource {
  getSprite(key: TileRenderKey): BakedTileSprite;
  getPage(sprite: BakedTileSprite): AtlasPage;
}

/** Injected offscreen-canvas factory (DOM in the app, node-canvas in tests). */
export type CreateBoardCanvas = (width: number, height: number) => BoardCanvas;

export interface CompositorUpdate {
  /** Zone ids whose body layer was drawn again this update. */
  readonly rebuiltZones: readonly string[];
  /** Shadow-group ids whose blurred union was drawn again. */
  readonly rebuiltGroups: readonly string[];
  readonly reusedZones: number;
  readonly reusedGroups: number;
  /** `shadow:<id>` then `zone:<id>`, in composite order. */
  readonly drawOrder: readonly string[];
}

interface CachedLayer {
  readonly signature: string;
  readonly canvas: BoardCanvas;
  readonly x: number;
  readonly y: number;
}

interface CachedZoneLayer extends CachedLayer {
  readonly id: string;
}

interface CachedGroupLayer extends CachedLayer {
  readonly id: string;
}

/** A rounded rectangle path, independent of `ctx.roundRect` support. */
function roundedRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, Math.abs(width) / 2, Math.abs(height) / 2));
  context.beginPath();
  context.moveTo(x + r, y);
  context.lineTo(x + width - r, y);
  context.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
  context.lineTo(x + width, y + height - r);
  context.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
  context.lineTo(x + r, y + height);
  context.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
  context.lineTo(x, y + r);
  context.arc(x + r, y + r, r, Math.PI, (Math.PI * 3) / 2);
  context.closePath();
}

function contextOf(canvas: BoardCanvas): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('rendered table: canvas has no 2d context');
  return context;
}

export interface ShadowGroupLayer {
  readonly canvas: BoardCanvas;
  /** Top-left of the canvas, including the Gaussian tail. */
  readonly x: number;
  readonly y: number;
}

/**
 * Draw one group's shadow union. This is the exported seam test: every shape
 * goes into a mask at alpha 1, then the mask is blurred and alpha-scaled in a
 * **single** `drawImage`.
 */
export function drawShadowGroupLayer(
  group: BoardShadowGroup,
  createCanvas: CreateBoardCanvas,
): ShadowGroupLayer {
  const width = Math.max(1, group.width + group.pad * 2);
  const height = Math.max(1, group.height + group.pad * 2);
  const mask = createCanvas(width, height);
  const maskContext = contextOf(mask);
  maskContext.fillStyle = group.colorHex;
  for (const shape of group.shapes) {
    maskContext.save();
    maskContext.translate(shape.centreX + group.pad, shape.centreY + group.pad);
    maskContext.rotate((shape.angleDeg * Math.PI) / 180);
    roundedRectPath(
      maskContext,
      -shape.halfX,
      -shape.halfY,
      shape.halfX * 2,
      shape.halfY * 2,
      shape.radiusPx,
    );
    maskContext.fill();
    maskContext.restore();
  }

  const canvas = createCanvas(width, height);
  const context = contextOf(canvas);
  if (group.sigmaPx1x > 0) context.filter = `blur(${group.sigmaPx1x}px)`;
  context.globalAlpha = Math.max(0, Math.min(1, group.coreAlpha));
  context.drawImage(mask as unknown as CanvasImageSource, 0, 0);
  context.filter = 'none';
  context.globalAlpha = 1;
  return { canvas, x: group.x - group.pad, y: group.y - group.pad };
}

export interface ZoneLayer {
  readonly canvas: BoardCanvas;
  readonly x: number;
  readonly y: number;
}

/**
 * Draw one zone's bodies in painter order, with each contact decal after the
 * body it shades and before the body that casts it. A leaned zone is rotated
 * inside its own padded layer, so the board composite stays a plain blit.
 */
export function drawZoneLayer(
  placement: BoardZone,
  manifest: ShellsManifest,
  sprites: TileSpriteSource,
  images: ReadonlyMap<string, CanvasImageSource>,
  overlays: readonly ContactOverlay[],
  createCanvas: CreateBoardCanvas,
): ZoneLayer {
  const { zone } = placement;
  const pad = placement.rotationPad;
  const canvas = createCanvas(
    Math.max(1, zone.width + pad * 2),
    Math.max(1, zone.height + pad * 2),
  );
  const context = contextOf(canvas);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.save();
  if (zone.rotationDeg !== 0) {
    context.translate(pad + zone.pivotX, pad + zone.pivotY);
    context.rotate((zone.rotationDeg * Math.PI) / 180);
    context.translate(-zone.pivotX, -zone.pivotY);
  } else {
    context.translate(pad, pad);
  }

  const byBody = overlaysByBody(overlays, zone.bodies.length);
  zone.bodies.forEach((tile, index) => {
    const shell = manifest.shells[tile.shell];
    if (!shell) throw new Error(`rendered table: shells.json has no ${tile.shell}`);
    if (tile.face && isFaceUpShellId(tile.shell)) {
      const sprite = sprites.getSprite(tileRenderKey(tile.shell, tile.face));
      blitTileSprite(context, sprites.getPage(sprite), sprite, tile.gridX, tile.gridY);
    } else {
      const image = images.get(shell.textureFile);
      if (image) context.drawImage(image, tile.drawX, tile.drawY);
    }

    for (const overlay of byBody[index]) {
      const image = images.get(overlay.textureFile);
      if (!image) continue;
      context.save();
      const points = overlay.clip.points;
      context.beginPath();
      context.moveTo(points[0][0], points[0][1]);
      for (let point = 1; point < points.length; point += 1) {
        context.lineTo(points[point][0], points[point][1]);
      }
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
  });

  context.restore();
  return { canvas, x: placement.x - pad, y: placement.y - pad };
}

function zoneSignature(
  placement: BoardZone,
  overlays: readonly ContactOverlay[],
): string {
  const { zone } = placement;
  return JSON.stringify([
    placement.id,
    placement.x,
    placement.y,
    placement.rotationPad,
    zone.rotationDeg,
    zone.pivotX,
    zone.pivotY,
    zone.width,
    zone.height,
    zone.bodies.map((tile) => [
      tile.shell,
      tile.face,
      tile.drawX,
      tile.drawY,
      tile.riichi,
      tile.dora,
    ]),
    overlays.map((overlay) => [
      overlay.bodyIndex,
      overlay.casterIndex,
      overlay.textureFile,
      overlay.drawX,
      overlay.drawY,
      overlay.texWidth,
      overlay.texHeight,
      overlay.clip.points,
    ]),
  ]);
}

function groupSignature(group: BoardShadowGroup): string {
  return JSON.stringify([
    group.id,
    group.x,
    group.y,
    group.width,
    group.height,
    group.pad,
    group.sigmaPx1x,
    group.coreAlpha,
    group.colorHex,
    group.shapes,
  ]);
}

/**
 * The board compositor. One instance lives for the lifetime of the rendered
 * view; `update()` may be called for every game state.
 */
export class TableCompositor {
  private readonly manifest: ShellsManifest;
  private readonly sprites: TileSpriteSource;
  private readonly images: ReadonlyMap<string, CanvasImageSource>;
  private readonly createCanvas: CreateBoardCanvas;
  private readonly destination: BoardCanvas;
  private readonly zones = new Map<string, CachedZoneLayer>();
  private readonly groups = new Map<string, CachedGroupLayer>();
  private board: Board | null = null;

  constructor(
    manifest: ShellsManifest,
    sprites: TileSpriteSource,
    images: ReadonlyMap<string, CanvasImageSource>,
    destination: BoardCanvas,
    createCanvas: CreateBoardCanvas,
  ) {
    this.manifest = manifest;
    this.sprites = sprites;
    this.images = images;
    this.destination = destination;
    this.createCanvas = createCanvas;
  }

  /** The last board drawn, or null before the first update. */
  get current(): Board | null {
    return this.board;
  }

  /**
   * Rebuild the layers whose content changed, drop stale layers, then
   * composite shadow groups and body zones in painter order.
   */
  update(
    board: Board,
    overlaysByZone: ReadonlyMap<string, readonly ContactOverlay[]>,
  ): CompositorUpdate {
    const rebuiltZones: string[] = [];
    const rebuiltGroups: string[] = [];
    const liveZones = new Set<string>();

    for (const placement of board.zones) {
      liveZones.add(placement.id);
      const overlays = overlaysByZone.get(placement.id) ?? [];
      const signature = zoneSignature(placement, overlays);
      const cached = this.zones.get(placement.id);
      if (cached && cached.signature === signature) continue;
      const layer = drawZoneLayer(
        placement,
        this.manifest,
        this.sprites,
        this.images,
        overlays,
        this.createCanvas,
      );
      this.zones.set(placement.id, { id: placement.id, signature, ...layer });
      rebuiltZones.push(placement.id);
    }
    for (const id of [...this.zones.keys()]) {
      if (!liveZones.has(id)) this.zones.delete(id);
    }

    const liveGroups = new Set<string>();
    for (const group of board.groups) {
      liveGroups.add(group.id);
      const signature = groupSignature(group);
      const cached = this.groups.get(group.id);
      if (cached && cached.signature === signature) continue;
      const layer = drawShadowGroupLayer(group, this.createCanvas);
      this.groups.set(group.id, { id: group.id, signature, ...layer });
      rebuiltGroups.push(group.id);
    }
    for (const id of [...this.groups.keys()]) {
      if (!liveGroups.has(id)) this.groups.delete(id);
    }

    this.board = board;
    this.composite(board);
    return {
      rebuiltZones,
      rebuiltGroups,
      reusedZones: board.zones.length - rebuiltZones.length,
      reusedGroups: board.groups.length - rebuiltGroups.length,
      drawOrder: [
        ...board.groups.map((group) => `shadow:${group.id}`),
        ...board.zones.map((zone) => `zone:${zone.id}`),
      ],
    };
  }

  private composite(board: Board): void {
    this.destination.width = Math.max(1, board.width);
    this.destination.height = Math.max(1, board.height);
    const context = contextOf(this.destination);
    context.clearRect(0, 0, this.destination.width, this.destination.height);
    for (const group of board.groups) {
      const layer = this.groups.get(group.id);
      if (!layer) continue;
      context.drawImage(layer.canvas as unknown as CanvasImageSource, layer.x, layer.y);
    }
    for (const placement of board.zones) {
      const layer = this.zones.get(placement.id);
      if (!layer) continue;
      context.drawImage(layer.canvas as unknown as CanvasImageSource, layer.x, layer.y);
    }
  }
}
