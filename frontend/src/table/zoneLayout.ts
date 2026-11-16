/**
 * The 2.5D table's zone layout engine (architecture Phase 3).
 *
 * The manifest, not the code, owns the geometry. Every placement starts from a
 * *logical face position* and converts it to the shell's draw anchor:
 *
 *   gridX = faceX - (faceQuadCentreX - anchorX)
 *   drawX = round(gridX - anchorX)
 *
 * The face centre is the anchor, not the body box's left edge: the per-slot
 * cameras widen the outer shells with a visible side reveal, so body-box
 * placement spreads the right half of a fan. `gridStepPx` is the projected
 * tile axis used for tight rows; `advanceWidth/Height` is the opaque body box
 * used for hit-testing (`hitBox`).
 *
 * Zones are laid out in their own local @1x board space and normalised so the
 * body + shadow bounds start at (0, 0). A zone is a body list in painter order
 * plus a separate shadow-footprint list (a wall casts one footprint per stack,
 * from its lower tier), the hard shapes and blur sigma, and the layer/group the
 * Phase 4 compositor needs:
 *
 *   - layer follows architecture Task 4.1;
 *   - `shadowGroup` merges the zones that share one blurred union: all four
 *     walls together, one per pond, and a hand group and meld group per seat
 *     (their published sigmas differ, 5 standing vs 12 lying).
 *
 * Draw positions are rounded to whole @1x px because the PNG compositor ignores
 * fractional coordinates. The logical `gridX/gridY` and `hitBox` stay
 * fractional so Phase 5 can hit-test the published advance box.
 *
 * The approved reference layouts live in
 * `tools/render/scripts/group-layouts.mjs`; `zoneLayout.test.ts` compares the
 * representative zones against it so the two cannot drift.
 */
import type { TableSide } from '../seatOrder';
import type { PointPx, ShellStats, ShellsManifest } from './shellManifest';
import type { TileFaceId } from './tiles';

export type { TableSide } from '../seatOrder';

/** The human-side wall is `front`; the far wall is `back` (§10.8). */
export type WallSide = 'front' | 'back';

export type LayoutZoneKind = 'hand' | 'melds' | 'pond' | 'wall';

/** The 17 stacks a full wall run starts with. */
export const WALL_STACKS = 17;
/** The centre slot of the 17-slot front/back wall fan. */
export const WALL_CENTRE_INDEX = 8;
/** Discards per pond row. */
export const POND_COLUMNS = 6;
/** Concealed hand row slots; the drawn tile has its own shell. */
export const HAND_ROW_SLOTS = 13;
/** The straight-on fan's centre slot. */
export const HAND_CENTRE_INDEX = 6;
/**
 * The whole-zone lean of each side pond, in screen degrees. Positive is
 * clockwise. It is a group transform of the composed pond (shadow + bodies),
 * not a per-tile position change or a new sprite.
 */
export const SIDE_POND_LEAN_DEG = 1;

/**
 * Architecture Task 4.1's global paint order. Felt is layer 0 and is not a
 * zone; a zone's tiles are all drawn once that layer is reached.
 */
export const ZONE_LAYER = {
  felt: 0,
  topWallAndHand: 1,
  sideWalls: 2,
  centreAndPonds: 3,
  bottomWall: 4,
  sideHandsAndMelds: 5,
  bottomHandAndMelds: 6,
} as const;

export type ZoneLayer = (typeof ZONE_LAYER)[keyof typeof ZONE_LAYER];

/** The published opaque body box, positioned at the tile's logical grid. */
export interface LayoutHitBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The logical cell a lying tile occupies (the 3D catch bake needs it). */
export interface PlacedCell {
  readonly row?: number;
  readonly column?: number;
  readonly slot?: number;
  readonly tier?: number;
}

/** One shell placed on the board. */
export interface PlacedTile {
  /** Key into `shells.json` (`shell_hand_slot_06`, `shell_flat_upright`, ...). */
  readonly shell: string;
  /** Atlas face, or null for a bare face-down/dora shell. */
  readonly face: TileFaceId | null;
  /** Logical face-anchored grid position, fractional @1x px. */
  readonly gridX: number;
  readonly gridY: number;
  /** Integer @1x px: the shell PNG's draw position. */
  readonly drawX: number;
  readonly drawY: number;
  /** The projected face centre in zone-local @1x px. */
  readonly faceX: number;
  readonly faceY: number;
  /** `[gridX, gridY, advanceWidth, advanceHeight]`, the Phase 5 hit box. */
  readonly hitBox: LayoutHitBox;
  /** True on a revealed dora indicator. */
  readonly dora: boolean;
  /** True on a Riichi declaration discard. */
  readonly riichi: boolean;
  /** Logical cell for the lying-family catch bake; absent on standing shells. */
  readonly cell?: PlacedCell;
}

/** A placed zone in its own local coordinate space, starting at (0, 0). */
export interface LayoutZone {
  readonly id: string;
  readonly kind: LayoutZoneKind;
  readonly side: TableSide | null;
  /** Architecture Task 4.1 paint layer. */
  readonly layer: ZoneLayer;
  /** Zones that share one blurred shadow union (§10.12). */
  readonly shadowGroup: string;
  /** Bodies in painter order. */
  readonly bodies: readonly PlacedTile[];
  /** Tiles whose `shadowShape` is cast into the group layer. */
  readonly shadows: readonly PlacedTile[];
  /** Body + hard-shadow bounds, from (0, 0), in @1x px. */
  readonly width: number;
  readonly height: number;
  /** One blur per group, in @1x px. */
  readonly sigmaPx1x: number;
  /** Transparent margin the Gaussian tail needs around the bounds. */
  readonly blurPad: number;
  /**
   * Optional whole-zone rotation in screen degrees (positive clockwise). It is
   * applied as one group transform to the shadow layer and the bodies; the
   * placements and hit boxes below remain in the unrotated local space.
   */
  readonly rotationDeg: number;
  /** Rotation pivot in zone-local @1x px. */
  readonly pivotX: number;
  readonly pivotY: number;
}

export interface HandLayoutOptions {
  /** Concealed row tiles, left to right. Up to 13; a short hand is centred. */
  readonly faces: readonly TileFaceId[];
  /** The drawn tile, placed after the row gap. */
  readonly draw?: TileFaceId | null;
  /** Zone id; defaults to `hand-bottom`. */
  readonly id?: string;
}

export interface TopHandLayoutOptions {
  readonly faces: readonly TileFaceId[];
}

export interface SideHandLayoutOptions {
  readonly side: 'left' | 'right';
  /** Concealed tiles; 13 is the full row. */
  readonly count?: number;
}

export interface MeldLayoutOptions {
  readonly faces: readonly TileFaceId[];
  readonly side?: TableSide;
  /** Index of the called tile, which lies sideways. */
  readonly calledIndex?: number | null;
}

export interface PondDiscard {
  readonly face: TileFaceId;
  /** A Riichi declaration tile lies sideways and advances by its long axis. */
  readonly riichi?: boolean;
}

export interface PondLayoutOptions {
  readonly discards: readonly PondDiscard[];
  readonly side?: TableSide;
  /**
   * Whole-zone lean for the left/right ponds, in screen degrees (positive
   * clockwise). Defaults to {@link SIDE_POND_LEAN_DEG}; 0 disables it. The
   * bottom/top ponds ignore it.
   */
  readonly leanDeg?: number;
}

export interface WallLayoutOptions {
  readonly wall: WallSide;
  readonly count?: number;
  readonly startIndex?: number;
  /** Slot whose upper tier is the face-up dora indicator. */
  readonly doraIndex?: number | null;
}

export interface SideWallLayoutOptions {
  readonly side: 'left' | 'right';
  readonly count?: number;
  readonly startIndex?: number;
  /** Column whose upper tier is the face-up dora indicator. */
  readonly doraIndex?: number | null;
}

/** Screen-space unit axes of a seat: the player's right and toward-player. */
const SEAT_AXES: Record<TableSide, { readonly right: PointPx; readonly down: PointPx }> = {
  bottom: { right: [1, 0], down: [0, 1] },
  right: { right: [0, -1], down: [1, 0] },
  top: { right: [-1, 0], down: [0, -1] },
  left: { right: [0, 1], down: [-1, 0] },
};

/**
 * The flat shell family a seat uses for its normal discards. The four ids are
 * the four river orientations; a turned tile (Riichi or a called meld tile)
 * advances 90 degrees from the seat's normal glyph.
 */
const SEAT_FACE_ROTATION: Record<TableSide, 0 | 90 | 180 | 270> = {
  bottom: 0,
  right: 90,
  top: 180,
  left: 270,
};

const SHELL_BY_FACE_ROTATION: Readonly<Record<0 | 90 | 180 | 270, string>> = {
  0: 'shell_flat_upright',
  90: 'shell_flat_sideways',
  180: 'shell_flat_upright_180',
  270: 'shell_flat_sideways_270',
};

interface RawTile {
  readonly shell: string;
  readonly face: TileFaceId | null;
  readonly gridX: number;
  readonly gridY: number;
  readonly faceX: number;
  readonly faceY: number;
  readonly dora: boolean;
  readonly riichi: boolean;
  readonly cell?: PlacedCell;
}

interface ZoneSeed {
  readonly id: string;
  readonly kind: LayoutZoneKind;
  readonly side: TableSide | null;
  readonly wall?: WallSide;
  readonly bodies: readonly RawTile[];
  readonly shadows: readonly RawTile[];
  /** Shell whose shadow sigma the zone's group uses. */
  readonly sigmaShell: string;
  /** Whole-zone lean in screen degrees; the pivot is the body near edge. */
  readonly rotationDeg?: number;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

const dot = (left: PointPx, right: PointPx): number =>
  left[0] * right[0] + left[1] * right[1];

/** Absolute projected length of a manifest step along a seat axis. */
const along = (step: PointPx, axis: PointPx): number => Math.abs(dot(step, axis));

function normalizeRotation(value: number): 0 | 90 | 180 | 270 {
  const wrapped = (((Math.round(value / 90) * 90) % 360) + 360) % 360;
  return wrapped as 0 | 90 | 180 | 270;
}

/** The seat's normal discard shell and the turned (Riichi/called) shell. */
export function flatShellsForSeat(
  manifest: ShellsManifest,
  side: TableSide,
): { readonly normalId: string; readonly turnedId: string; readonly normal: ShellStats; readonly turned: ShellStats } {
  const normalId = SHELL_BY_FACE_ROTATION[SEAT_FACE_ROTATION[side]];
  const turnedId = SHELL_BY_FACE_ROTATION[normalizeRotation(SEAT_FACE_ROTATION[side] + 90)];
  return {
    normalId,
    turnedId,
    normal: shellOf(manifest, normalId),
    turned: shellOf(manifest, turnedId),
  };
}

/** The four corners' average, in shell texture coordinates. */
export function faceCentreOf(shell: ShellStats): PointPx {
  const [first, second, third, fourth] = shell.faceQuad;
  return [
    (first[0] + second[0] + third[0] + fourth[0]) / 4,
    (first[1] + second[1] + third[1] + fourth[1]) / 4,
  ];
}

function shellOf(manifest: ShellsManifest, id: string): ShellStats {
  const shell = manifest.shells[id];
  if (!shell) throw new Error(`zone layout: shells.json has no ${id}`);
  return shell;
}

/**
 * Architecture Task 4.1's layer for a zone. A front wall is the human-side
 * wall; a back wall is the far one.
 */
export function zoneLayer(kind: LayoutZoneKind, side: TableSide | null, wall?: WallSide): ZoneLayer {
  if (kind === 'wall') {
    if (side === 'left' || side === 'right') return ZONE_LAYER.sideWalls;
    return wall === 'back' ? ZONE_LAYER.topWallAndHand : ZONE_LAYER.bottomWall;
  }
  if (kind === 'pond') return ZONE_LAYER.centreAndPonds;
  if (side === 'top') return ZONE_LAYER.topWallAndHand;
  if (side === 'bottom') return ZONE_LAYER.bottomHandAndMelds;
  return ZONE_LAYER.sideHandsAndMelds;
}

/**
 * The shadow union a zone contributes to. All four walls share one layer
 * because they meet at the corners; each pond and each seat's hand / melds are
 * separate. A hand (standing sigma 5) and its melds (lying sigma 12) cannot
 * share one blur, so they stay separate groups.
 */
export function zoneShadowGroup(
  kind: LayoutZoneKind,
  side: TableSide | null,
): string {
  if (kind === 'wall') return 'walls';
  if (kind === 'pond') return `pond-${side}`;
  return `seat-${side}-${kind}`;
}

/** Integer grid slots for a short hand centred on the 13-slot fan. */
export function centredSlotIndices(count: number, rowSlots = HAND_ROW_SLOTS): number[] {
  if (count < 0 || count > rowSlots) {
    throw new Error(`zone layout: a hand row holds 0..${rowSlots} tiles, got ${count}`);
  }
  const start = Math.round((rowSlots - count) / 2);
  return Array.from({ length: count }, (_, offset) => start + offset);
}

/**
 * Painter order for a fan row: outermost of each half first, inward, centre
 * last. The camera sits at the row centre, so the inner tile is nearer and must
 * be drawn after its outer neighbour.
 */
export function fanOrder(slots: readonly number[]): number[] {
  const order: number[] = [];
  let low = 0;
  let high = slots.length - 1;
  while (low < high) {
    order.push(slots[low], slots[high]);
    low += 1;
    high -= 1;
  }
  if (low === high) order.push(slots[low]);
  return order;
}

function placeAtFace(
  shellId: string,
  shell: ShellStats,
  face: TileFaceId | null,
  faceX: number,
  faceY: number,
  dora = false,
  riichi = false,
): RawTile {
  const centre = faceCentreOf(shell);
  return {
    shell: shellId,
    face,
    gridX: faceX - (centre[0] - shell.anchorX),
    gridY: faceY - (centre[1] - shell.anchorY),
    faceX,
    faceY,
    dora,
    riichi,
  };
}

/**
 * Place a shell by its grid anchor, not its face. The wall's upper tier is
 * published as a body-box offset (`stackStepPx`) from the lower tier, so it
 * cannot go through the face anchor.
 */
function placeAtGrid(
  shellId: string,
  shell: ShellStats,
  face: TileFaceId | null,
  gridX: number,
  gridY: number,
  dora = false,
  riichi = false,
): RawTile {
  const centre = faceCentreOf(shell);
  return {
    shell: shellId,
    face,
    gridX,
    gridY,
    faceX: gridX + (centre[0] - shell.anchorX),
    faceY: gridY + (centre[1] - shell.anchorY),
    dora,
    riichi,
  };
}

/**
 * The body's far coordinate along a unit axis, measured from the grid anchor.
 * A turned tile is shorter along the row axis, so it is offset along the
 * row-toward-player axis until the two near body edges line up: +7 px for the
 * bottom pond, exactly the reference layout.
 */
function bodyFarEdgeAlong(shell: ShellStats, axis: PointPx): number {
  if (axis[1] === 1) return shell.anchorY + shell.advanceHeight;
  if (axis[1] === -1) return -shell.anchorY;
  if (axis[0] === 1) return shell.anchorX + shell.advanceWidth;
  return -shell.anchorX;
}

interface RowItem {
  readonly face: TileFaceId;
  readonly turned?: boolean;
  readonly riichi?: boolean;
}

interface FaceExtent {
  readonly min: number;
  readonly max: number;
}

/**
 * The projected face plate extent along a screen axis, relative to the face
 * centre. A turned tile is wider along the row, so the row keeps its normal
 * face-to-face gap by shifting the turned tile instead of letting the tile to
 * its left clip the visible face.
 */
function faceExtentAlong(shell: ShellStats, axis: PointPx): FaceExtent {
  const centre = faceCentreOf(shell);
  let min = Infinity;
  let max = -Infinity;
  for (const [x, y] of shell.faceQuad) {
    const projection = (x - centre[0]) * axis[0] + (y - centre[1]) * axis[1];
    min = Math.min(min, projection);
    max = Math.max(max, projection);
  }
  return { min, max };
}

/**
 * Lay a row across the seat's view. The normal shell steps by `gridStepPx.x`
 * (the projected short axis); a turned tile steps by `gridStepPx.y` (its long
 * axis now lies along the row), which is the reference's 104 px Riichi advance.
 * A turned tile's face is wider along the row, so it is placed after the
 * previous face with the row's normal face gap; the next tile keeps its slot.
 */
function placeRow(
  manifest: ShellsManifest,
  side: TableSide,
  items: readonly RowItem[],
  startFace: PointPx,
): RawTile[] {
  const { normalId, turnedId, normal, turned } = flatShellsForSeat(manifest, side);
  const axes = SEAT_AXES[side];
  const normalStep = along(normal.gridStepPx.x, axes.right);
  const turnedStep = along(turned.gridStepPx.y, axes.right);
  const normalExtent = faceExtentAlong(normal, axes.right);
  const faceGap = normalStep - (normalExtent.max - normalExtent.min);
  // The near-edge nudge keeps a horizontal row's body baseline straight. A
  // side row is a vertical line on screen: shifting the narrower turned body
  // along the row progression would push it off that line and into the next
  // discard row, so the turned tile stays centred on the line.
  const nearOffset =
    Math.abs(axes.down[1]) === 1
      ? bodyFarEdgeAlong(normal, axes.down) - bodyFarEdgeAlong(turned, axes.down)
      : 0;

  const placed: RawTile[] = [];
  let cursor = 0;
  let previous: { readonly position: number; readonly extent: FaceExtent } | null = null;
  for (const item of items) {
    const isTurned = item.turned === true;
    const shellId = isTurned ? turnedId : normalId;
    const shell = isTurned ? turned : normal;
    const extent = isTurned ? faceExtentAlong(turned, axes.right) : normalExtent;
    const processPosition: number =
      isTurned && previous
        ? previous.position + previous.extent.max + faceGap - extent.min
        : cursor;
    const near = isTurned ? nearOffset : 0;
    const faceX = startFace[0] + axes.right[0] * processPosition + axes.down[0] * near;
    const faceY = startFace[1] + axes.right[1] * processPosition + axes.down[1] * near;
    placed.push(
      placeAtFace(shellId, shell, item.face, faceX, faceY, false, item.riichi === true),
    );
    previous = { position: processPosition, extent };
    cursor += isTurned ? turnedStep : normalStep;
  }
  return placed;
}

/**
 * Uniform-row body order. A horizontal row is drawn right-to-left so the left
 * tile's bevel lands over its neighbour; a vertical row is drawn from the far
 * (top) tile toward the near (bottom) one.
 */
function paintOrderForRow(row: readonly RawTile[]): RawTile[] {
  if (row.length < 2) return [...row];
  const first = row[0];
  const last = row[row.length - 1];
  const horizontal = Math.abs(last.faceX - first.faceX) >= Math.abs(last.faceY - first.faceY);
  return [...row].sort((left, right) =>
    horizontal ? right.faceX - left.faceX : left.faceY - right.faceY,
  );
}

function shadowBounds(shell: ShellStats): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const shape = shell.shadowShape;
  const radians = (shape.angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const halfX = shape.halfPx[0] * cos + shape.halfPx[1] * sin;
  const halfY = shape.halfPx[0] * sin + shape.halfPx[1] * cos;
  return {
    left: shape.centrePx[0] - halfX,
    top: shape.centrePx[1] - halfY,
    right: shape.centrePx[0] + halfX,
    bottom: shape.centrePx[1] + halfY,
  };
}

/**
 * Normalise a zone to (0, 0) using the body + hard-shadow bounds, round each
 * draw position, and attach the layer/group metadata.
 */
function finishZone(manifest: ShellsManifest, seed: ZoneSeed): LayoutZone {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const include = (x0: number, y0: number, x1: number, y1: number) => {
    left = Math.min(left, x0);
    top = Math.min(top, y0);
    right = Math.max(right, x1);
    bottom = Math.max(bottom, y1);
  };
  let bodyLeft = Infinity;
  let bodyTop = Infinity;
  let bodyRight = -Infinity;
  let bodyBottom = -Infinity;

  for (const tile of seed.bodies) {
    const shell = shellOf(manifest, tile.shell);
    const bodyLeftEdge = tile.gridX - shell.anchorX;
    const bodyTopEdge = tile.gridY - shell.anchorY;
    const bodyRightEdge = bodyLeftEdge + shell.texWidth;
    const bodyBottomEdge = bodyTopEdge + shell.texHeight;
    bodyLeft = Math.min(bodyLeft, bodyLeftEdge);
    bodyTop = Math.min(bodyTop, bodyTopEdge);
    bodyRight = Math.max(bodyRight, bodyRightEdge);
    bodyBottom = Math.max(bodyBottom, bodyBottomEdge);
    include(bodyLeftEdge, bodyTopEdge, bodyRightEdge, bodyBottomEdge);
  }
  for (const tile of seed.shadows) {
    const shell = shellOf(manifest, tile.shell);
    const bounds = shadowBounds(shell);
    include(
      tile.gridX + bounds.left,
      tile.gridY + bounds.top,
      tile.gridX + bounds.right,
      tile.gridY + bounds.bottom,
    );
  }

  if (!Number.isFinite(left)) {
    left = 0;
    top = 0;
    right = 0;
    bottom = 0;
  }

  const finalize = (tile: RawTile): PlacedTile => {
    const shell = shellOf(manifest, tile.shell);
    const gridX = tile.gridX - left;
    const gridY = tile.gridY - top;
    return {
      shell: tile.shell,
      face: tile.face,
      gridX,
      gridY,
      drawX: Math.round(gridX - shell.anchorX),
      drawY: Math.round(gridY - shell.anchorY),
      faceX: tile.faceX - left,
      faceY: tile.faceY - top,
      hitBox: {
        x: gridX,
        y: gridY,
        width: shell.advanceWidth,
        height: shell.advanceHeight,
      },
      dora: tile.dora,
      riichi: tile.riichi,
      ...(tile.cell === undefined ? {} : { cell: tile.cell }),
    };
  };

  const sigmaPx1x = shellOf(manifest, seed.sigmaShell).shadowShape.sigmaPx1x;
  const rotationDeg = seed.rotationDeg ?? 0;
  const hasBodies = Number.isFinite(bodyLeft);
  return {
    id: seed.id,
    kind: seed.kind,
    side: seed.side,
    layer: zoneLayer(seed.kind, seed.side, seed.wall),
    shadowGroup: zoneShadowGroup(seed.kind, seed.side),
    bodies: seed.bodies.map(finalize),
    shadows: seed.shadows.map(finalize),
    width: Math.ceil(right - left),
    height: Math.ceil(bottom - top),
    sigmaPx1x,
    blurPad: Math.ceil(3 * sigmaPx1x),
    rotationDeg,
    pivotX: rotationDeg && hasBodies ? (bodyLeft + bodyRight) / 2 - left : 0,
    pivotY: rotationDeg && hasBodies ? bodyBottom - top : 0,
  };
}

/**
 * The human hand: a 13-slot face-centred fan, plus the separately baked drawn
 * tile at +5.5125 units (1.35 row steps). A shorter row is centred on the same
 * 13-slot fan.
 */
export function layoutHand(manifest: ShellsManifest, options: HandLayoutOptions): LayoutZone {
  const rowIds = Array.from(
    { length: HAND_ROW_SLOTS },
    (_, index) => `shell_hand_slot_${pad2(index)}`,
  );
  const centreId = `shell_hand_slot_${pad2(HAND_CENTRE_INDEX)}`;
  const centre = shellOf(manifest, centreId);
  const first = shellOf(manifest, rowIds[0]).handSlot;
  const second = shellOf(manifest, rowIds[1]).handSlot;
  if (!first || !second || !centre.handSlot) {
    throw new Error('zone layout: hand slots are missing their handSlot records');
  }
  const stepUnits = second.offsetUnits - first.offsetUnits;
  const unitPx = centre.gridStepPx.x[0] / stepUnits;
  const centreOffset = centre.handSlot.offsetUnits;

  const slots = centredSlotIndices(options.faces.length);
  const raw: RawTile[] = slots.map((slotIndex, faceIndex) => {
    const id = rowIds[slotIndex];
    const shell = shellOf(manifest, id);
    const meta = shell.handSlot;
    if (!meta) throw new Error(`zone layout: ${id} has no handSlot record`);
    const faceX = (meta.offsetUnits - centreOffset) * unitPx;
    return placeAtFace(id, shell, options.faces[faceIndex], faceX, 0);
  });

  const shadows = [...raw];
  const bodies = fanOrder(Array.from({ length: raw.length }, (_, index) => index)).map(
    (index) => raw[index],
  );

  if (options.draw) {
    const drawId = 'shell_hand_slot_draw';
    const drawShell = shellOf(manifest, drawId);
    const meta = drawShell.handSlot;
    if (!meta) throw new Error(`zone layout: ${drawId} has no handSlot record`);
    const faceX = (meta.offsetUnits - centreOffset) * unitPx;
    const drawn = placeAtFace(drawId, drawShell, options.draw, faceX, 0);
    bodies.push(drawn);
    shadows.push(drawn);
  }

  return finishZone(manifest, {
    id: options.id ?? 'hand-bottom',
    kind: 'hand',
    side: 'bottom',
    bodies,
    shadows,
    sigmaShell: centreId,
  });
}

/** The opposite seat's concealed hand: the bare blue-back standing fan. */
export function layoutTopHand(
  manifest: ShellsManifest,
  options: TopHandLayoutOptions,
): LayoutZone {
  const rowIds = Array.from(
    { length: HAND_ROW_SLOTS },
    (_, index) => `shell_hand_top_slot_${pad2(index)}`,
  );
  const centreId = `shell_hand_top_slot_${pad2(HAND_CENTRE_INDEX)}`;
  const centre = shellOf(manifest, centreId);
  const first = shellOf(manifest, rowIds[0]).topHandSlot;
  const second = shellOf(manifest, rowIds[1]).topHandSlot;
  if (!first || !second || !centre.topHandSlot) {
    throw new Error('zone layout: top-hand slots are missing their topHandSlot records');
  }
  const unitPx = centre.gridStepPx.x[0] / (second.offsetUnits - first.offsetUnits);
  const centreOffset = centre.topHandSlot.offsetUnits;

  const slots = centredSlotIndices(options.faces.length);
  const raw: RawTile[] = slots.map((slotIndex) => {
    const id = rowIds[slotIndex];
    const shell = shellOf(manifest, id);
    const meta = shell.topHandSlot;
    if (!meta) throw new Error(`zone layout: ${id} has no topHandSlot record`);
    const faceX = (meta.offsetUnits - centreOffset) * unitPx;
    return placeAtFace(id, shell, null, faceX, 0);
  });

  const bodies = fanOrder(Array.from({ length: raw.length }, (_, index) => index)).map(
    (index) => raw[index],
  );

  return finishZone(manifest, {
    id: 'hand-top',
    kind: 'hand',
    side: 'top',
    bodies,
    shadows: raw,
    sigmaShell: centreId,
  });
}

/**
 * A side player's concealed hand: one standing blue-back shell reused down a
 * single row, exactly like a side-wall column but upright. The row steps by the
 * shell's projected short axis and runs toward the viewer.
 */
export function layoutSideHand(
  manifest: ShellsManifest,
  options: SideHandLayoutOptions,
): LayoutZone {
  const baseId = `shell_hand_side_${options.side}`;
  const base = shellOf(manifest, baseId);
  const count = options.count ?? HAND_ROW_SLOTS;
  if (count < 1 || count > HAND_ROW_SLOTS) {
    throw new Error(
      `zone layout: side hand ${options.side} holds 1..${HAND_ROW_SLOTS} tiles, got ${count}`,
    );
  }
  const axis = base.gridStepPx.x;
  const step: PointPx = axis[1] < 0 ? [-axis[0], -axis[1]] : axis;
  const tiles = Array.from({ length: count }, (_, index) =>
    placeAtFace(baseId, base, null, index * step[0], index * step[1]),
  );
  return finishZone(manifest, {
    id: `hand-${options.side}`,
    kind: 'hand',
    side: options.side,
    bodies: tiles,
    shadows: tiles,
    sigmaShell: baseId,
  });
}

/** An open meld: the same face-up row, with the called tile lying sideways. */
export function layoutMeld(manifest: ShellsManifest, options: MeldLayoutOptions): LayoutZone {  const side = options.side ?? 'bottom';
  const calledIndex = options.calledIndex ?? null;
  const row = placeRow(
    manifest,
    side,
    options.faces.map((face, index) => ({ face, turned: index === calledIndex })),
    [0, 0],
  );
  const cells = row.map((tile, column) => ({ ...tile, cell: { column } }));
  return finishZone(manifest, {
    id: `melds-${side}`,
    kind: 'melds',
    side,
    bodies: paintOrderForRow(cells),
    shadows: cells,
    sigmaShell: flatShellsForSeat(manifest, side).normalId,
  });
}

/**
 * A discard pond: 6 columns per row, rows laid by the normal shell's long-axis
 * step. A Riichi tile lies sideways and advances the row by its long axis.
 *
 * The body order is a depth sort, not a row order: the furthest tiles on screen
 * are drawn first. For the bottom/top ponds depth is the logical row; for the
 * side ponds it is the logical column (the vertical column runs into the
 * screen). Within one depth line the tiles are drawn right-to-left.
 */
export function layoutPond(manifest: ShellsManifest, options: PondLayoutOptions): LayoutZone {
  const side = options.side ?? 'bottom';
  const axes = SEAT_AXES[side];
  const shells = flatShellsForSeat(manifest, side);
  const rowStep = along(shells.normal.gridStepPx.y, axes.down);

  interface PondPlacement {
    readonly tile: RawTile;
    readonly rowIndex: number;
    readonly columnIndex: number;
  }

  const placed: PondPlacement[] = [];
  const shadows: RawTile[] = [];
  const rowCount = Math.ceil(options.discards.length / POND_COLUMNS);
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const discards = options.discards.slice(
      rowIndex * POND_COLUMNS,
      (rowIndex + 1) * POND_COLUMNS,
    );
    const startFace: PointPx = [
      axes.down[0] * rowStep * rowIndex,
      axes.down[1] * rowStep * rowIndex,
    ];
    const row = placeRow(
      manifest,
      side,
      discards.map((discard) => ({
        face: discard.face,
        turned: discard.riichi === true,
        riichi: discard.riichi === true,
      })),
      startFace,
    );
    row.forEach((tile, columnIndex) => {
      const cell = { ...tile, cell: { row: rowIndex, column: columnIndex } };
      placed.push({ tile: cell, rowIndex, columnIndex });
      shadows.push(cell);
    });
  }

  // Depth is the screen-y grid line: row-major for the front/back ponds,
  // column-major for the side ponds. The turned tile's near-edge offset is a
  // within-line alignment shift, so it does not move the tile's depth line.
  const depthKey = (entry: PondPlacement): number => {
    if (side === 'bottom') return entry.rowIndex;
    if (side === 'top') return -entry.rowIndex;
    if (side === 'right') return -entry.columnIndex;
    return entry.columnIndex;
  };
  const bodies = [...placed]
    .sort(
      (left, right) =>
        depthKey(left) - depthKey(right) || right.tile.faceX - left.tile.faceX,
    )
    .map((entry) => entry.tile);

  const lean = options.leanDeg ?? SIDE_POND_LEAN_DEG;
  const rotationDeg =
    lean === 0 ? 0 : side === 'right' ? -lean : side === 'left' ? lean : 0;

  return finishZone(manifest, {
    id: `pond-${side}`,
    kind: 'pond',
    side,
    bodies,
    shadows,
    sigmaShell: shells.normalId,
    rotationDeg,
  });
}

function wallSlotId(wall: WallSide, index: number, faceUp = false): string {
  return `shell_wall_${wall}_slot_${pad2(index)}${faceUp ? '_faceup' : ''}`;
}

/**
 * A front or back wall: 17 stacks (or a contiguous remaining run). Every stack
 * is two tiles; the upper tier sits at the lower tier's grid + `stackStepPx`,
 * and a revealed dora indicator is the face-up shell at its slot. The shadow
 * group casts one footprint per stack from the lower tier.
 */
export function layoutWall(manifest: ShellsManifest, options: WallLayoutOptions): LayoutZone {
  const count = options.count ?? WALL_STACKS;
  const startIndex = options.startIndex ?? 0;
  if (count < 1 || startIndex < 0 || startIndex + count > WALL_STACKS) {
    throw new Error(
      `zone layout: wall ${options.wall} takes 1..${WALL_STACKS} stacks from a valid start, ` +
        `got start ${startIndex} count ${count}`,
    );
  }
  const indices = Array.from({ length: count }, (_, offset) => startIndex + offset);
  const centre = shellOf(manifest, wallSlotId(options.wall, WALL_CENTRE_INDEX));
  const step = centre.gridStepPx.x[0];

  const lowers = new Map<number, RawTile>();
  const baseShells = new Map<number, ShellStats>();
  for (const index of indices) {
    const id = wallSlotId(options.wall, index);
    const shell = shellOf(manifest, id);
    baseShells.set(index, shell);
    lowers.set(index, {
      ...placeAtFace(id, shell, null, index * step, 0),
      cell: { slot: index, tier: 0 },
    });
  }

  const order = fanOrder(indices);
  const lowerBodies = order.map((index) => lowers.get(index)!);
  const uppers = order.map((index) => {
    const down = baseShells.get(index)!;
    if (!down.stackStepPx) {
      throw new Error(`zone layout: wall slot ${index} has no stackStepPx`);
    }
    const lower = lowers.get(index)!;
    const dora = options.doraIndex === index;
    const id = wallSlotId(options.wall, index, dora);
    const shell = shellOf(manifest, id);
    return {
      ...placeAtGrid(
        id,
        shell,
        null,
        lower.gridX + down.stackStepPx[0],
        lower.gridY + down.stackStepPx[1],
        dora,
      ),
      cell: { slot: index, tier: 1 },
    };
  });

  return finishZone(manifest, {
    id: `wall-${options.wall}`,
    kind: 'wall',
    side: null,
    wall: options.wall,
    bodies: [...lowerBodies, ...uppers],
    shadows: lowerBodies,
    sigmaShell: wallSlotId(options.wall, WALL_CENTRE_INDEX),
  });
}

/**
 * A side wall: one fixed oblique shell reused down the column. The column steps
 * down whichever published tile axis points down the screen, and the upper tier
 * uses the slot's own `stackStepPx`. Bodies are drawn back-to-front, all bottom
 * tiers before the top tiers (Task 4.2).
 */
export function layoutSideWall(
  manifest: ShellsManifest,
  options: SideWallLayoutOptions,
): LayoutZone {
  const baseId = `shell_wall_side_${options.side}`;
  const base = shellOf(manifest, baseId);
  const count = options.count ?? WALL_STACKS;
  const startIndex = options.startIndex ?? 0;
  if (count < 1 || startIndex < 0 || startIndex + count > WALL_STACKS) {
    throw new Error(
      `zone layout: side wall ${options.side} takes 1..${WALL_STACKS} stacks, ` +
        `got start ${startIndex} count ${count}`,
    );
  }
  if (!base.stackStepPx) throw new Error(`zone layout: ${baseId} has no stackStepPx`);

  const downAxis =
    Math.abs(base.gridStepPx.x[1]) >= Math.abs(base.gridStepPx.y[1])
      ? base.gridStepPx.x
      : base.gridStepPx.y;
  const step: PointPx = downAxis[1] < 0 ? [-downAxis[0], -downAxis[1]] : downAxis;
  const indices = Array.from({ length: count }, (_, offset) => startIndex + offset);

  const lowers = indices.map((index) => ({
    ...placeAtFace(baseId, base, null, index * step[0], index * step[1]),
    cell: { slot: index, tier: 0 },
  }));
  const uppers = indices.map((index) => {
    const lower = lowers[index - startIndex];
    const dora = options.doraIndex === index;
    const id = dora ? `${baseId}_faceup` : baseId;
    const shell = shellOf(manifest, id);
    return {
      ...placeAtGrid(
        id,
        shell,
        null,
        lower.gridX + base.stackStepPx![0],
        lower.gridY + base.stackStepPx![1],
        dora,
      ),
      cell: { slot: index, tier: 1 },
    };
  });

  return finishZone(manifest, {
    id: `wall-side-${options.side}`,
    kind: 'wall',
    side: options.side,
    bodies: [...lowers, ...uppers],
    shadows: lowers,
    sigmaShell: baseId,
  });
}

/**
 * The representative zones from `tools/render/scripts/group-layouts.mjs`, in
 * the same order. Used by the parity test and the review sheet; the app builds
 * its own zones from a table snapshot.
 */
export function representativeZones(manifest: ShellsManifest): LayoutZone[] {
  const faces: TileFaceId[] = [
    '1m',
    '2m',
    '3m',
    '4m',
    '5m',
    '6m',
    '7m',
    '8m',
    '9m',
    '1p',
    '2p',
    '3p',
    '4p',
  ];
  const pondFaces: TileFaceId[] = [
    '1m',
    '2m',
    '3m',
    '4m',
    '5m',
    '6m',
    '7m',
    '8m',
    '9m',
    '1p',
    '2p',
    '3p',
    '4p',
    '5p',
    '6p',
    '7p',
    '8p',
    '9p',
    '1s',
    '2s',
    '3s',
    '4s',
    '5s',
    '6s',
  ];
  return [
    layoutHand(manifest, { faces }),
    layoutHand(manifest, { faces, draw: '5p', id: 'hand-bottom-draw' }),
    layoutTopHand(manifest, { faces }),
    layoutMeld(manifest, { faces: faces.slice(0, 3) }),
    layoutPond(manifest, {
      discards: pondFaces.slice(0, POND_COLUMNS).map((face) => ({ face })),
    }),
    layoutPond(manifest, {
      discards: pondFaces.map((face, index) => ({ face, riichi: index === 16 })),
    }),
    layoutWall(manifest, { wall: 'front', doraIndex: 12 }),
    layoutSideWall(manifest, { side: 'left', doraIndex: 5 }),
  ];
}
