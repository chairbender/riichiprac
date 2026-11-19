/**
 * Task 6A: adjacency-aware dynamic shadow passes for the rendered 2.5D board.
 *
 * Task 4A publishes the shadow assets; this module decides, from the *live*
 * board state, which of them to draw and where. Nothing is baked per sprite:
 * a river that grows one tile at a time, a wall that breaks open and a hand
 * tile that lifts on hover all come out of the same few passes.
 *
 * ## The four passes, in render order
 *
 * 1. **Mat shadows** — one `shadow_mat_<bucket>.png` per occupied slot, drawn
 *    onto the felt between `board_bg` and every tile body. A wall casts one per
 *    *stack*, at its bottom tier (Task 4A grounds those buckets), so the upper
 *    tier adds no second footprint. Because the bodies come after, the next
 *    discard simply covers the shadow the previous one cast on the open felt:
 *    growth and a broken wall need no special case.
 * 2. **Wall stack decal** — after a wall stack's `layer_0` body, if `layer_1`
 *    is occupied, draw that seat's `shadow_wall_stack_<seat>.png` at the same
 *    layer-0 anchor, then the upper body covers it. Draw a tile off the wall
 *    and the decal disappears with the tier; it is keyed off the live cells.
 * 3. **Bevel crevices** — after each body, for every occupied orthogonal
 *    neighbour, map the matching `ao_seam_*` mask onto that tile's own
 *    `faceQuad` at {@link SEAM_OPACITY} of its authored alpha. An open edge
 *    (the newest river tile, the end of a broken wall, the separated drawn
 *    tile) draws nothing, so its lit bevel stays bright.
 * 4. **Interactive elevation** — a lifted `hand_south` tile keeps its mat
 *    shadow at the resting anchor, shrunk to {@link LIFTED_SHADOW_SCALE} and
 *    faded to {@link LIFTED_SHADOW_OPACITY}, and the left/right crevices on the
 *    tile and its neighbours are suppressed while it is lifted. The tile body
 *    itself is moved by the caller ({@link HAND_LIFT_PX} upward).
 *
 * ## Why the mat pass is an opaque transmittance layer
 *
 * Two penumbras crossing must not darken twice. `shadows.json` says to merge
 * them at MAX alpha and composite once, never with straight-over alpha. Canvas
 * 2D has no per-pixel max for alpha, so the pass works in *transmittance*
 * instead: `b = 1 - alpha` (`b` is what the eye gets, `alpha` what is removed).
 * Each mat sprite is pre-flattened onto white, which turns its alpha into the
 * grey `b` (`dest = 255 * (1 - alpha)`), and the zone buffers merge with the
 * `darken` blend, which for an opaque source is exactly `min(b)` — i.e. MAX
 * alpha. The merged layer is then drawn once with `multiply`, which is the
 * manifest's declared model (`dest * (1 - alpha)`). Two crossing 0.55 shadows
 * therefore peak at 0.55; straight-over would peak at 0.80.
 *
 * ## Cost
 *
 * The plan is one pass over the placed tiles, and the neighbour lookup is built
 * once per redraw from the zones, never per draw call. Zone masks are cached
 * by a signature of the zone's placed positions, so a one-tile change re-renders
 * that zone's mask and re-composites the merged layer (one fill and one blit
 * per zone) instead of repainting the board.
 *
 * Coordinate space: board @1x px, the space `boardPlan.ts` places zones in. A
 * zone's local point `p` lands at `zone.x + p * zone.scale`; the ponds are the
 * only scaled zones. The caller applies its viewport fit to the context; this
 * module never knows the viewport.
 *
 * Assets: the caller fetches `shadows.json` / `ao_seams.json`, validates them
 * with `parseShadowsManifest` / `parseAoSeamsManifest`, and decodes the 24
 * sprites; nothing here performs a fetch, and the rendered view's asset loader
 * is the one place that owns URLs.
 */
import type { FaceQuad, ShellsManifest, ShellStats } from './shellManifest';
import { screenRotationOfQuad } from './shellManifest';
import type { AoSeamSide, MatShadowRecord, AoSeamsManifest, ShadowsManifest } from './shadowManifest';
import { AO_SEAM_SIDES, matShadowBucketFor, wallSeatOf } from './shadowManifest';
import type { AtlasCanvas } from './TileAtlasBuilder';
import type { LayoutZone, PlacedTile } from './zoneLayout';

/** A drawing context, as much of Canvas 2D as the passes use. */
export type ShadowContext2D = CanvasRenderingContext2D;

/**
 * An image source with known dimensions: an `HTMLImageElement`, `ImageBitmap`
 * or the Node canvas `Image` the review scripts and tests use.
 */
export interface ShadowImage {
  readonly width: number;
  readonly height: number;
}

/** A zone placed on the board, in board @1x px (structurally a `BoardZone`). */
export interface ShadowZonePlacement {
  readonly zone: LayoutZone;
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}

export interface ShadowBoard {
  readonly zones: readonly ShadowZonePlacement[];
  /** Board bounds in @1x px; the mat layer covers exactly this rectangle. */
  readonly width: number;
  readonly height: number;
}

/** Where a hand tile is lifted: the zone id and the body index inside it. */
export interface LiftedTile {
  readonly zoneId: string;
  readonly bodyIndex: number;
}

/** How far a hovered/selected hand tile rises, in @1x board px. */
export const HAND_LIFT_UNITS = 0.025;
/** The reference frame the normalized lift is quoted against. */
export const REFERENCE_FRAME_HEIGHT = 1080;
/** `0.025` of a 1080-tall frame. Architecture Task 6.3 / Task 6A step 4. */
export const HAND_LIFT_PX = HAND_LIFT_UNITS * REFERENCE_FRAME_HEIGHT;
/** The lifted tile's shadow shrinks toward its anchor by this factor. */
export const LIFTED_SHADOW_SCALE = 0.92;
/** …and fades to this fraction of its resting darkness. */
export const LIFTED_SHADOW_OPACITY = 0.75;
/**
 * The AO masks are drawn at this share of their authored 35 % peak, inside the
 * 50-70 % band `ao_seams.json` asks for.
 */
export const SEAM_OPACITY = 0.6;

/** The four orthogonal neighbours of a tile, by face-local side. */
export interface TileNeighbours {
  readonly left: number | null;
  readonly right: number | null;
  readonly top: number | null;
  readonly bottom: number | null;
}

const NO_NEIGHBOURS: TileNeighbours = { left: null, right: null, top: null, bottom: null };

/** One mat shadow to draw on the felt, in board @1x px. */
export interface MatShadowDraw {
  readonly zoneIndex: number;
  /** The placed body it belongs to (used by the elevation pass). */
  readonly bodyIndex: number;
  readonly bucket: string;
  readonly textureFile: string;
  /** Board-space top-left of the sprite. */
  readonly x: number;
  readonly y: number;
  /** Board-space drawn size. */
  readonly width: number;
  readonly height: number;
  /** 1 normally, {@link LIFTED_SHADOW_OPACITY} on a lifted tile. */
  readonly opacity: number;
  readonly lifted: boolean;
}

/** A wall stack's contact decal, drawn after `bodyIndex` and under layer 1. */
export interface StackShadowDraw {
  readonly zoneIndex: number;
  readonly bodyIndex: number;
  readonly seat: string;
  readonly textureFile: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One crevice mask, drawn after `bodyIndex`. */
export interface SeamDraw {
  readonly zoneIndex: number;
  readonly bodyIndex: number;
  readonly side: AoSeamSide;
  readonly textureFile: string;
  readonly opacity: number;
}

export interface ShadowPlan {
  readonly mat: readonly MatShadowDraw[];
  readonly stacks: readonly StackShadowDraw[];
  readonly seams: readonly SeamDraw[];
  /** Per zone, per body index: which neighbours are occupied. */
  readonly adjacency: readonly (readonly TileNeighbours[])[];
  readonly lifted: (LiftedTile & { readonly zoneIndex: number }) | null;
}

/** The face-local axis vectors of a shell's plate, as screen unit vectors. */
export function faceAxes(shell: ShellStats): {
  readonly right: readonly [number, number];
  readonly down: readonly [number, number];
} {
  // `screenRotationOfQuad` is the angle that maps the glyph's own top edge onto
  // the quad's first edge: 0 right, 90 up, 180 left, 270 down. That is the
  // face-local +u direction in screen terms; +v is a quarter turn clockwise
  // from it (screen y grows downward).
  switch (screenRotationOfQuad(shell.faceQuad)) {
    case 0:
      return { right: [1, 0], down: [0, 1] };
    case 90:
      return { right: [0, -1], down: [1, 0] };
    case 180:
      return { right: [-1, 0], down: [0, -1] };
    case 270:
      return { right: [0, 1], down: [-1, 0] };
  }
}

/** Which face-local edge a screen-space direction points at. */
export function faceSideOf(
  axes: { readonly right: readonly [number, number]; readonly down: readonly [number, number] },
  dx: number,
  dy: number,
): AoSeamSide {
  const alongU = dx * axes.right[0] + dy * axes.right[1];
  const alongV = dx * axes.down[0] + dy * axes.down[1];
  if (Math.abs(alongU) >= Math.abs(alongV)) return alongU >= 0 ? 'right' : 'left';
  return alongV >= 0 ? 'bottom' : 'top';
}

/** The side facing back across an edge. */
export function oppositeSide(side: AoSeamSide): AoSeamSide {
  switch (side) {
    case 'left':
      return 'right';
    case 'right':
      return 'left';
    case 'top':
      return 'bottom';
    case 'bottom':
      return 'top';
  }
}

/**
 * The logical grid key of a placed tile inside its zone, or null when the tile
 * is not part of a neighbour grid (the separated drawn hand tile).
 *
 * The zone layout publishes the cell for ponds, melds and walls; a hand row's
 * slot comes from the shell's `handSlot`/`topHandSlot` record, because a short
 * hand is centred on the 13-slot fan.
 */
function gridKey(zone: LayoutZone, tile: PlacedTile, shell: ShellStats): string | null {
  const cell = tile.cell;
  if (cell) {
    if (zone.kind === 'pond') return `${cell.row ?? 0}:${cell.column ?? 0}`;
    if (zone.kind === 'melds') return `c${cell.column ?? 0}`;
    return `s${cell.slot ?? 0}:t${cell.tier ?? 0}`;
  }
  if (zone.kind === 'hand') {
    const meta = shell.handSlot ?? shell.topHandSlot;
    if (!meta) return null;
    const index = meta.index ?? null;
    // A null index is the drawn tile's own slot: it sits past the row gap, so
    // it has no row neighbours and no crevice (the separated tsumo tile).
    if (index === null) return null;
    return `r${index}`;
  }
  return null;
}

/** The neighbour keys of a grid cell, in the zone's own logical directions. */
function neighbourKeys(zone: LayoutZone, key: string): string[] {
  if (zone.kind === 'pond') {
    const [row, column] = key.split(':').map(Number);
    return [
      `${row}:${column - 1}`,
      `${row}:${column + 1}`,
      `${row - 1}:${column}`,
      `${row + 1}:${column}`,
    ];
  }
  if (zone.kind === 'melds') {
    const column = Number(key.slice(1));
    return [`c${column - 1}`, `c${column + 1}`];
  }
  if (zone.kind === 'wall') {
    const [slot, tier] = key.slice(1).split(':t').map(Number);
    // Only the run's neighbours: the crevice between the two tiers of a stack
    // is the pass-2 stack decal (Task 4A measured it as one band on the lower
    // tile's top face), so a second AO mask there would be a hidden duplicate.
    return [`s${slot - 1}:t${tier}`, `s${slot + 1}:t${tier}`];
  }
  if (zone.kind === 'hand') {
    const index = Number(key.slice(1));
    return [`r${index - 1}`, `r${index + 1}`];
  }
  return [];
}

/**
 * Build the orthogonal neighbour map of one zone from the placed cells.
 *
 * Adjacency is logical (the live game state's row/column/stack/slot), not a
 * pixel-proximity guess: a river's newest tile has no right neighbour until the
 * next discard lands, a wall slot with no upper tier has no top neighbour, and
 * the drawn hand tile belongs to no grid. The *side* of each neighbour is then
 * resolved geometrically, through the tile's own face axes, so a sideways
 * riichi tile or an opposite seat's reversed quad still gets the mask on the
 * edge that faces its neighbour.
 */
export function buildZoneAdjacency(
  manifest: ShellsManifest,
  zone: LayoutZone,
): TileNeighbours[] {
  const shells = zone.bodies.map((tile) => {
    const shell = manifest.shells[tile.shell];
    if (!shell) throw new Error(`shadows: shells.json has no ${tile.shell}`);
    return shell;
  });
  const byKey = new Map<string, number>();
  zone.bodies.forEach((tile, index) => {
    const key = gridKey(zone, tile, shells[index]);
    if (key !== null) byKey.set(key, index);
  });

  const result: TileNeighbours[] = zone.bodies.map(() => NO_NEIGHBOURS);
  zone.bodies.forEach((tile, index) => {
    const key = gridKey(zone, tile, shells[index]);
    if (key === null) return;
    const axes = faceAxes(shells[index]);
    const sides: Partial<Record<AoSeamSide, number>> = {};
    for (const neighbourKey of neighbourKeys(zone, key)) {
      const neighbourIndex = byKey.get(neighbourKey);
      if (neighbourIndex === undefined || neighbourIndex === index) continue;
      const other = zone.bodies[neighbourIndex];
      const side = faceSideOf(axes, other.gridX - tile.gridX, other.gridY - tile.gridY);
      // Two cells cannot share one edge; a keep-first rule keeps the plan
      // deterministic if a layout ever reports a duplicate.
      if (sides[side] === undefined) sides[side] = neighbourIndex;
    }
    result[index] = {
      left: sides.left ?? null,
      right: sides.right ?? null,
      top: sides.top ?? null,
      bottom: sides.bottom ?? null,
    };
  });
  return result;
}

function shellOf(manifest: ShellsManifest, tile: PlacedTile): ShellStats {
  const shell = manifest.shells[tile.shell];
  if (!shell) throw new Error(`shadows: shells.json has no ${tile.shell}`);
  return shell;
}

/** Where a zone-local grid anchor lands on the board, in @1x px. */
function boardPoint(
  placement: ShadowZonePlacement,
  gridX: number,
  gridY: number,
): { x: number; y: number } {
  return {
    x: placement.x + gridX * placement.scale,
    y: placement.y + gridY * placement.scale,
  };
}

/** True when two placed tiles are the same body (identity or same placement). */
function sameBody(left: PlacedTile, right: PlacedTile): boolean {
  if (left === right) return true;
  return (
    left.shell === right.shell && left.gridX === right.gridX && left.gridY === right.gridY
  );
}

export interface ShadowPlanOptions {
  /** The hovered/selected hand tile, if any. */
  readonly lifted?: LiftedTile | null;
}

/**
 * Build every shadow draw for a board, from the live zones.
 *
 * Throws when a bucket has no shadow sprite: Task 4A's assets are the contract,
 * and a silently missing shadow is worse than a loud failure (`do not fake
 * them`).
 */
export function planShadows(
  manifest: ShellsManifest,
  shadows: ShadowsManifest,
  seams: AoSeamsManifest,
  board: ShadowBoard,
  options: ShadowPlanOptions = {},
): ShadowPlan {
  const adjacency = board.zones.map((placement) => buildZoneAdjacency(manifest, placement.zone));
  const requested = options.lifted ?? null;
  let lifted: (LiftedTile & { zoneIndex: number }) | null = null;
  if (requested) {
    const zoneIndex = board.zones.findIndex((placement) => placement.zone.id === requested.zoneId);
    if (zoneIndex >= 0 && requested.bodyIndex >= 0 && requested.bodyIndex < board.zones[zoneIndex].zone.bodies.length) {
      lifted = { ...requested, zoneIndex };
    }
  }

  // Crevice sides suppressed while a hand tile is lifted: the lifted tile's own
  // left/right, and the facing side of each immediate neighbour. The
  // neighbour's other side still abuts a resting tile, so it keeps its crease.
  const suppressed = new Map<string, Set<AoSeamSide>>();
  const suppress = (key: string, side: AoSeamSide): void => {
    const entry = suppressed.get(key) ?? new Set<AoSeamSide>();
    entry.add(side);
    suppressed.set(key, entry);
  };
  if (lifted) {
    const zone = board.zones[lifted.zoneIndex].zone;
    suppress(`${lifted.zoneIndex}:${lifted.bodyIndex}`, 'left');
    suppress(`${lifted.zoneIndex}:${lifted.bodyIndex}`, 'right');
    if (zone.kind === 'hand') {
      const neighbours = adjacency[lifted.zoneIndex][lifted.bodyIndex];
      for (const side of AO_SEAM_SIDES) {
        const neighbour = neighbours[side];
        if (neighbour === null) continue;
        suppress(`${lifted.zoneIndex}:${neighbour}`, oppositeSide(side));
      }
    }
  }

  const mat: MatShadowDraw[] = [];
  const stacks: StackShadowDraw[] = [];
  const seamDraws: SeamDraw[] = [];

  board.zones.forEach((placement, zoneIndex) => {
    const { zone, scale } = placement;
    const bodyIndexOf = (tile: PlacedTile): number => {
      const index = zone.bodies.findIndex((body) => sameBody(body, tile));
      return index;
    };

    // ---- pass 1: one mat shadow per occupied slot (one per stack for a wall)
    for (const tile of zone.shadows) {
      const shell = shellOf(manifest, tile);
      const bucket = matShadowBucketFor(zone, tile, shell);
      const record: MatShadowRecord | undefined = shadows.matShadows[bucket];
      if (!record) {
        throw new Error(`shadows.json has no mat shadow for bucket ${bucket} (${zone.id})`);
      }
      const bodyIndex = bodyIndexOf(tile);
      const isLifted = lifted !== null && lifted.zoneIndex === zoneIndex && lifted.bodyIndex === bodyIndex;
      const factor = isLifted ? LIFTED_SHADOW_SCALE : 1;
      const anchor = boardPoint(placement, tile.gridX, tile.gridY);
      const pivotX = (record.pivot.x / record.pixelRatio) * scale * factor;
      const pivotY = (record.pivot.y / record.pixelRatio) * scale * factor;
      mat.push({
        zoneIndex,
        bodyIndex,
        bucket,
        textureFile: record.textureFile,
        x: anchor.x - pivotX,
        y: anchor.y - pivotY,
        width: (record.width / record.pixelRatio) * scale * factor,
        height: (record.height / record.pixelRatio) * scale * factor,
        opacity: isLifted ? LIFTED_SHADOW_OPACITY : 1,
        lifted: isLifted,
      });
    }

    // ---- pass 2: a stack's decal, keyed off a live layer-1 cell
    if (zone.kind === 'wall') {
      const seat = wallSeatOf(zone);
      const record = seat ? shadows.wallStack.seats[seat] : undefined;
      if (seat && record) {
        const lowerBodies = new Map<number, number>();
        zone.bodies.forEach((tile, index) => {
          if (tile.cell?.tier === 0 && tile.cell.slot !== undefined) {
            lowerBodies.set(tile.cell.slot, index);
          }
        });
        zone.bodies.forEach((tile) => {
          if (tile.cell?.tier !== 1 || tile.cell.slot === undefined) return;
          const lowerIndex = lowerBodies.get(tile.cell.slot);
          if (lowerIndex === undefined) return;
          const lower = zone.bodies[lowerIndex];
          const anchor = boardPoint(placement, lower.gridX, lower.gridY);
          stacks.push({
            zoneIndex,
            bodyIndex: lowerIndex,
            seat,
            textureFile: record.textureFile,
            x: anchor.x - (record.pivot.x / record.pixelRatio) * scale,
            y: anchor.y - (record.pivot.y / record.pixelRatio) * scale,
            width: (record.width / record.pixelRatio) * scale,
            height: (record.height / record.pixelRatio) * scale,
          });
        });
      }
    }

    // ---- pass 3: bevel crevices, one mask per occupied orthogonal neighbour
    zone.bodies.forEach((_tile, bodyIndex) => {
      const neighbours = adjacency[zoneIndex][bodyIndex];
      const suppressedSides = suppressed.get(`${zoneIndex}:${bodyIndex}`);
      for (const side of AO_SEAM_SIDES) {
        if (neighbours[side] === null) continue;
        if (suppressedSides?.has(side)) continue;
        seamDraws.push({
          zoneIndex,
          bodyIndex,
          side,
          textureFile: seams.seams[side].textureFile,
          opacity: SEAM_OPACITY,
        });
      }
    });
  });

  return { mat, stacks, seams: seamDraws, adjacency, lifted };
}

/** A zone's mat-shadow rectangle and the plan entries it holds. */
export interface ZoneShadowMask {
  /** Board-space origin and size in @1x px, expanded to whole pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly draws: readonly MatShadowDraw[];
  /** Changes whenever the zone's placed tiles, lean or lifted tile change. */
  readonly signature: string;
}

/** The screen rotation a zone applies to its group, about a board-space pivot. */
export interface ZoneRotation {
  readonly degrees: number;
  readonly pivotX: number;
  readonly pivotY: number;
}

/** A zone's lean, about its published pivot, in board @1x px. */
export function zoneRotation(placement: ShadowZonePlacement): ZoneRotation {
  const { zone, x, y, scale } = placement;
  if (!zone.rotationDeg) return { degrees: 0, pivotX: 0, pivotY: 0 };
  return {
    degrees: zone.rotationDeg,
    pivotX: x + zone.pivotX * scale,
    pivotY: y + zone.pivotY * scale,
  };
}

/** Rotate a board point about a zone's pivot. */
function rotateAbout(
  rotation: ZoneRotation,
  x: number,
  y: number,
): readonly [number, number] {
  if (!rotation.degrees) return [x, y];
  const radians = (rotation.degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - rotation.pivotX;
  const dy = y - rotation.pivotY;
  return [rotation.pivotX + dx * cos - dy * sin, rotation.pivotY + dx * sin + dy * cos];
}

/** Apply a zone's group transform to a context already in board space. */
export function withZoneRotation(
  ctx: ShadowContext2D,
  rotation: ZoneRotation,
  draw: () => void,
): void {
  ctx.save();
  if (rotation.degrees) {
    ctx.translate(rotation.pivotX, rotation.pivotY);
    ctx.rotate((rotation.degrees * Math.PI) / 180);
    ctx.translate(-rotation.pivotX, -rotation.pivotY);
  }
  draw();
  ctx.restore();
}

/**
 * Group the mat draws by zone and reduce each group to its integer bounds.
 * The bounds are the *rotated* union, because the side ponds carry a 1° lean.
 */
export function zoneShadowMasks(plan: ShadowPlan, board: ShadowBoard): ZoneShadowMask[] {
  const byZone = new Map<number, MatShadowDraw[]>();
  for (const draw of plan.mat) {
    const list = byZone.get(draw.zoneIndex) ?? [];
    list.push(draw);
    byZone.set(draw.zoneIndex, list);
  }
  const masks: ZoneShadowMask[] = [];
  for (const [zoneIndex, draws] of [...byZone.entries()].sort((a, b) => a[0] - b[0])) {
    const placement = board.zones[zoneIndex];
    const rotation = placement ? zoneRotation(placement) : { degrees: 0, pivotX: 0, pivotY: 0 };
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const draw of draws) {
      for (const [cx, cy] of [
        [draw.x, draw.y],
        [draw.x + draw.width, draw.y],
        [draw.x + draw.width, draw.y + draw.height],
        [draw.x, draw.y + draw.height],
      ] as const) {
        const [rx, ry] = rotateAbout(rotation, cx, cy);
        left = Math.min(left, rx);
        top = Math.min(top, ry);
        right = Math.max(right, rx);
        bottom = Math.max(bottom, ry);
      }
    }
    const x = Math.floor(left);
    const y = Math.floor(top);
    masks.push({
      x,
      y,
      width: Math.max(1, Math.ceil(right) - x),
      height: Math.max(1, Math.ceil(bottom) - y),
      draws,
      signature: drawSignature(zoneIndex, draws, x, y, rotation.degrees),
    });
  }
  return masks;
}

function drawSignature(
  zoneIndex: number,
  draws: readonly MatShadowDraw[],
  x: number,
  y: number,
  rotationDeg: number,
): string {
  const parts = draws.map(
    (draw) =>
      `${draw.bucket}|${draw.x.toFixed(2)}|${draw.y.toFixed(2)}|${draw.width.toFixed(2)}|` +
      `${draw.height.toFixed(2)}|${draw.opacity}`,
  );
  return `${zoneIndex}:${x}:${y}:${rotationDeg}:${parts.join(';')}`;
}

/** Everything the compositor needs from the caller beyond the manifests. */
export interface BoardShadowRendererOptions {
  readonly createCanvas: (width: number, height: number) => AtlasCanvas;
  readonly board: ShadowBoard;
  readonly manifest: ShellsManifest;
  readonly shadows: ShadowsManifest;
  readonly seams: AoSeamsManifest;
  /** Resolve one manifest-relative sprite path to a decoded image, or null. */
  readonly imageFor: (file: string) => ShadowImage | null;
  /**
   * Device pixels per board px for the mat layer. The layer is composited once
   * per redraw, so 1 is enough for a board that is fitted down; pass 2 to keep
   * the penumbra crisp on a large screen.
   */
  readonly pixelRatio?: 1 | 2;
}

export interface BoardShadowStats {
  /** How many zone masks this renderer has painted (incremental work). */
  readonly zoneMasksPainted: number;
  /** How many sprites the current plan holds. */
  readonly matSprites: number;
  readonly stackSprites: number;
  readonly seamSprites: number;
}

interface ZoneMaskEntry {
  readonly canvas: AtlasCanvas;
  readonly signature: string;
}

/**
 * Draws the four passes. The caller owns the frame loop and the viewport
 * transform; this class owns the merged mat layer and the per-zone caches.
 *
 * Call sites, in the renderer's zone loop (see `BoardRenderer`):
 *
 * ```
 * // once, between board_bg and the first tile body
 * shadows.drawMatShadowPass(ctx);
 * // per zone, per body, in painter order
 * shadows.drawWallStackShadow(ctx, zoneIndex, bodyIndex); // after the body
 * blitBody(...);
 * shadows.drawCreviceSeams(ctx, zoneIndex, bodyIndex);    // after blitBody
 * ```
 *
 * `update()` recomputes the plan and repaints only the zone masks whose
 * signature changed. Call it when the hand, the board or the lifted tile
 * changes — never per frame.
 */
export class BoardShadowRenderer {
  private readonly options: BoardShadowRendererOptions;
  private readonly pixelRatio: 1 | 2;
  private board: ShadowBoard;
  private matLayer: AtlasCanvas;
  private readonly zoneMasks = new Map<number, ZoneMaskEntry>();
  /** `b = 1 - alpha` versions of the mat sprites, keyed by file and opacity. */
  private readonly transmittance = new Map<string, AtlasCanvas>();
  private plan: ShadowPlan | null = null;
  private zoneMasksPainted = 0;

  constructor(options: BoardShadowRendererOptions) {
    this.options = options;
    this.pixelRatio = options.pixelRatio ?? 1;
    this.board = options.board;
    this.matLayer = options.createCanvas(
      Math.max(1, Math.ceil(options.board.width * this.pixelRatio)),
      Math.max(1, Math.ceil(options.board.height * this.pixelRatio)),
    );
  }

  /** Replace the placed board (a re-deal, a resize) and re-plan. */
  setBoard(board: ShadowBoard, options: ShadowPlanOptions = {}): ShadowPlan {
    this.board = board;
    const width = Math.max(1, Math.ceil(board.width * this.pixelRatio));
    const height = Math.max(1, Math.ceil(board.height * this.pixelRatio));
    if (this.matLayer.width !== width || this.matLayer.height !== height) {
      this.matLayer = this.options.createCanvas(width, height);
    }
    return this.update(options);
  }

  /** The plan currently drawn (null before the first {@link update}). */
  get currentPlan(): ShadowPlan | null {
    return this.plan;
  }

  get stats(): BoardShadowStats {
    const plan = this.plan;
    return {
      zoneMasksPainted: this.zoneMasksPainted,
      matSprites: plan?.mat.length ?? 0,
      stackSprites: plan?.stacks.length ?? 0,
      seamSprites: plan?.seams.length ?? 0,
    };
  }

  /** Re-plan and repaint only the zone masks that changed. */
  update(options: ShadowPlanOptions = {}): ShadowPlan {
    const plan = planShadows(
      this.options.manifest,
      this.options.shadows,
      this.options.seams,
      this.board,
      options,
    );
    this.plan = plan;
    const masks = zoneShadowMasks(plan, this.board);
    const live = new Set<number>();
    for (const mask of masks) {
      const zoneIndex = mask.draws[0].zoneIndex;
      live.add(zoneIndex);
      if (this.zoneMasks.get(zoneIndex)?.signature === mask.signature) continue;
      // A growing river widens its mask: reallocate rather than clip.
      const width = Math.max(1, Math.ceil(mask.width * this.pixelRatio));
      const height = Math.max(1, Math.ceil(mask.height * this.pixelRatio));
      const existing = this.zoneMasks.get(zoneIndex)?.canvas;
      const canvas =
        existing && existing.width === width && existing.height === height
          ? existing
          : this.options.createCanvas(width, height);
      this.paintZoneMask(canvas, mask);
      this.zoneMasks.set(zoneIndex, { canvas, signature: mask.signature });
      this.zoneMasksPainted += 1;
    }
    for (const key of [...this.zoneMasks.keys()]) {
      if (!live.has(key)) this.zoneMasks.delete(key);
    }
    this.compositeMatLayer(masks);
    return plan;
  }

  /** Paint one zone's mat shadows into its opaque transmittance mask. */
  private paintZoneMask(canvas: AtlasCanvas, mask: ZoneShadowMask): void {
    const ctx = canvas.getContext('2d') as ShadowContext2D | null;
    if (!ctx) throw new Error('shadows: no 2D context for a zone mask');
    const ratio = this.pixelRatio;
    const placement = this.board.zones[mask.draws[0].zoneIndex];
    const rotation = placement ? zoneRotation(placement) : { degrees: 0, pivotX: 0, pivotY: 0 };
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Device px per board px, with the mask's own origin removed …
    ctx.setTransform(ratio, 0, 0, ratio, -mask.x * ratio, -mask.y * ratio);
    // … then the zone's group transform, so a leaning pond's shadows lean with
    // its bodies.
    if (rotation.degrees) {
      ctx.translate(rotation.pivotX, rotation.pivotY);
      ctx.rotate((rotation.degrees * Math.PI) / 180);
      ctx.translate(-rotation.pivotX, -rotation.pivotY);
    }
    // `darken` over an opaque source is a per-pixel minimum of the
    // transmittances, i.e. the maximum of the shadows. Overlapping penumbras
    // cannot compound, which straight-over alpha would.
    ctx.globalCompositeOperation = 'darken';
    for (const draw of mask.draws) {
      const sprite = this.transmittanceSprite(draw);
      if (!sprite) continue;
      ctx.drawImage(
        sprite as unknown as CanvasImageSource,
        draw.x,
        draw.y,
        draw.width,
        draw.height,
      );
    }
    ctx.restore();
  }

  /** Fill the merged layer white, then min the zone masks into it. */
  private compositeMatLayer(masks: readonly ZoneShadowMask[]): void {
    const ctx = this.matLayer.getContext('2d') as ShadowContext2D | null;
    if (!ctx) throw new Error('shadows: no 2D context for the mat layer');
    const ratio = this.pixelRatio;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.matLayer.width, this.matLayer.height);
    ctx.globalCompositeOperation = 'darken';
    for (const mask of masks) {
      const entry = this.zoneMasks.get(mask.draws[0].zoneIndex);
      if (!entry) continue;
      ctx.drawImage(
        entry.canvas as unknown as CanvasImageSource,
        0,
        0,
        entry.canvas.width,
        entry.canvas.height,
        Math.round(mask.x * ratio),
        Math.round(mask.y * ratio),
        Math.round(mask.width * ratio),
        Math.round(mask.height * ratio),
      );
    }
    ctx.restore();
  }

  /**
   * The tile's mat sprite as a transmittance image: white where the felt is
   * untouched, grey `1 - alpha` where the shadow falls, opaque everywhere.
   * Drawing a black-alpha sprite onto white is exactly that conversion.
   */
  private transmittanceSprite(draw: MatShadowDraw): AtlasCanvas | null {
    const key = `${draw.textureFile}@${draw.opacity}`;
    const cached = this.transmittance.get(key);
    if (cached) return cached;
    const image = this.options.imageFor(draw.textureFile);
    if (!image) return null;
    const canvas = this.options.createCanvas(
      Math.max(1, image.width),
      Math.max(1, image.height),
    );
    const ctx = canvas.getContext('2d') as ShadowContext2D | null;
    if (!ctx) throw new Error('shadows: no 2D context for a mat sprite');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.globalAlpha = draw.opacity;
    ctx.drawImage(image as unknown as CanvasImageSource, 0, 0);
    ctx.globalAlpha = 1;
    this.transmittance.set(key, canvas);
    return canvas;
  }

  /**
   * Pass 1. Multiply the merged mat layer onto the felt. Call once, after
   * `board_bg` and before the first body.
   */
  drawMatShadowPass(ctx: ShadowContext2D): void {
    if (!this.plan) return;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 1;
    ctx.drawImage(
      this.matLayer as unknown as CanvasImageSource,
      0,
      0,
      this.matLayer.width,
      this.matLayer.height,
      0,
      0,
      this.board.width,
      this.board.height,
    );
    ctx.restore();
  }

  /** Pass 2. Draw the stack decal after its layer-0 body. */
  drawWallStackShadow(ctx: ShadowContext2D, zoneIndex: number, bodyIndex: number): void {
    const plan = this.plan;
    if (!plan) return;
    const placement = this.board.zones[zoneIndex];
    if (!placement) return;
    const rotation = zoneRotation(placement);
    for (const draw of plan.stacks) {
      if (draw.zoneIndex !== zoneIndex || draw.bodyIndex !== bodyIndex) continue;
      const image = this.options.imageFor(draw.textureFile);
      if (!image) continue;
      withZoneRotation(ctx, rotation, () => {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.drawImage(
          image as unknown as CanvasImageSource,
          draw.x,
          draw.y,
          draw.width,
          draw.height,
        );
        ctx.restore();
      });
    }
  }

  /** Pass 3. Draw every crevice mask attached to this body. */
  drawCreviceSeams(ctx: ShadowContext2D, zoneIndex: number, bodyIndex: number): void {
    const plan = this.plan;
    if (!plan) return;
    const placement = this.board.zones[zoneIndex];
    if (!placement) return;
    const tile = placement.zone.bodies[bodyIndex];
    if (!tile) return;
    const shell = this.options.manifest.shells[tile.shell];
    if (!shell) return;
    const quad = boardQuad(placement, tile, shell.faceQuad);
    const rotation = zoneRotation(placement);
    for (const draw of plan.seams) {
      if (draw.zoneIndex !== zoneIndex || draw.bodyIndex !== bodyIndex) continue;
      const image = this.options.imageFor(draw.textureFile);
      if (!image) continue;
      withZoneRotation(ctx, rotation, () => {
        drawMaskOnQuad(ctx, image, quad, draw.side, draw.opacity);
      });
    }
  }
}

/** A shell's face plate in board @1x px. */
export function boardQuad(
  placement: ShadowZonePlacement,
  tile: PlacedTile,
  faceQuad: FaceQuad,
): FaceQuad {
  const { x, y, scale } = placement;
  const map = ([qx, qy]: readonly [number, number]): readonly [number, number] => [
    x + (tile.drawX + qx) * scale,
    y + (tile.drawY + qy) * scale,
  ];
  return [map(faceQuad[0]), map(faceQuad[1]), map(faceQuad[2]), map(faceQuad[3])];
}

/**
 * Map one square crevice mask onto a face plate.
 *
 * The masks are authored in the plate's own normalized UV: `left` carries its
 * band at `u = 0`, `right` at `u = 1`, `top` at `v = 0`, `bottom` at `v = 1`
 * (`ao_seams.json`'s `axis`/`side` records). The plate's published `faceQuad`
 * is in the same face-local order, so the whole image maps straight onto it —
 * the mapping places all four bands on their own edges and needs no rotation,
 * which is also what keeps each mask on the axis it was authored on (u fades
 * over 0.10 of the short side, v over 0.075 of the long one). The clip keeps
 * the affine approximation inside the perspective plate, exactly like the
 * atlas's decal blit.
 */
export function drawMaskOnQuad(
  ctx: ShadowContext2D,
  image: ShadowImage,
  quad: FaceQuad,
  side: AoSeamSide,
  opacity: number,
): void {
  const source = image as unknown as CanvasImageSource;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(quad[0][0], quad[0][1]);
  ctx.lineTo(quad[1][0], quad[1][1]);
  ctx.lineTo(quad[2][0], quad[2][1]);
  ctx.lineTo(quad[3][0], quad[3][1]);
  ctx.closePath();
  ctx.clip();
  const widthPx = image.width;
  const heightPx = image.height;
  const destTL = quad[0];
  const destTR = quad[1];
  const destBL = quad[3];
  const a = (destTR[0] - destTL[0]) / widthPx;
  const b = (destTR[1] - destTL[1]) / widthPx;
  const c = (destBL[0] - destTL[0]) / heightPx;
  const d = (destBL[1] - destTL[1]) / heightPx;
  // `side` selects the mask (each image already carries its band on its own
  // edge), so the mapping is the same for all four; the parameter keeps the
  // call site honest about which edge it is drawing.
  void side;
  ctx.globalAlpha = opacity;
  ctx.setTransform(a, b, c, d, destTL[0], destTL[1]);
  ctx.drawImage(source, 0, 0, widthPx, heightPx);
  ctx.restore();
}
