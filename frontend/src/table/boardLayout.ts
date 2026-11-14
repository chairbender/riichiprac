/**
 * Pure zone layout engine for the 2.5D rendered table (architecture Phases 3–4).
 *
 * ## Board space
 *
 * Layout happens in one fixed 2D **board space**: CSS px at the shells'
 * published @1x scale, origin top-left, x right, y down. There is no shared 3D
 * camera, no table model and no perspective. Every zone is placed directly in
 * this space from the shell manifest:
 *
 * ```text
 * gridX/gridY = logical top-left of the shell's opaque body
 * drawX = gridX - shell.anchorX
 * drawY = gridY - shell.anchorY
 * ```
 *
 * The texture's transparent margin is never part of layout: anchors come from
 * `anchorX/anchorY`, pitch from `gridStepPx` (tight rows and wall runs) and
 * `advanceWidth/advanceHeight` (hit/spacing and the tsumo gap). This module
 * never reads `texWidth`/`texHeight`; a test mutates them and asserts the
 * placements do not move.
 *
 * ## Fitting the board to the viewport
 *
 * {@link fitBoardToViewport} contains the board in the viewport, preserving its
 * aspect and centring it:
 *
 * ```text
 * scale    = min(viewportWidth / boardWidth, viewportHeight / boardHeight)
 * offsetX  = (viewportWidth  - boardWidth  * scale) / 2
 * offsetY  = (viewportHeight - boardHeight * scale) / 2
 * cssX     = offsetX + boardX * scale
 * cssY     = offsetY + boardY * scale
 * ```
 *
 * The felt is **not** part of that transform. It is a separate full-screen
 * layer with `background-size: 100% 100%` ({@link FELT_RUNTIME}), so the baked
 * vignette always hugs the real screen edges at any aspect ratio (Tenhou
 * style). The board layer above it is transparent; there is no table border,
 * rail or apron. `cover` would crop the portrait vignette, which is why the
 * felt stretches instead.
 *
 * ## Per-zone projections
 *
 * There is one shell per projection, and the same shell is used for a zone on
 * every seat:
 *
 *  - the seat's concealed hand is face-up front elevation for the human
 *    (`shell_hand_standing`) and face-down for the opponents: the top player
 *    shows the top-down back (`shell_wall_horizontal`), the side players the
 *    fixed-oblique backs (`shell_wall_side_left`/`_right`), so an opponent's
 *    hand reads as a row of backs from that seat's own projection;
 *  - every open meld is top-down (`shell_flat_upright`) with the glyph upright,
 *    exactly like a discard, so a called set has the same tile size in all four
 *    seats;
 *  - every discard pond is top-down (`shell_flat_upright`);
 *  - top/bottom walls are `shell_wall_horizontal`, side walls are the fixed
 *    oblique `shell_wall_side_left`/`_right`;
 *  - a Riichi discard is the dedicated `shell_flat_sideways`, horizontal on
 *    screen, in every pond. A pre-shaded sprite is never rotated.
 *
 * Each pond is laid out in its seat's frame: `along` runs parallel to that
 * player's edge and `away` points toward the compass. On screen a horizontal
 * row advances left→right and a vertical row top→bottom; the sprites stay
 * upright and keep the same size in every pond. That is the "impossible
 * geometry" of §2.A: readable glyphs and uniform tile size everywhere, with no
 * shared camera to constrain the layout.
 *
 * ## Hands, melds and the hand bands
 *
 * A seat's hand sits on the **outer** side of its wall, so the board reads
 * outward-in as hand → wall → pond → compass on every edge:
 *
 *  - top and bottom hands are horizontal bands above/below their walls;
 *  - left and right hands are vertical columns outside their walls.
 *
 * Calls sit at the seat's own right-hand end of its row (`meldSign`): screen
 * right for the human, screen left for the top player, screen bottom for the
 * left player and screen top for the right player. The concealed run and the
 * draw fill the rest, so a row stays roughly 13 tiles wide whichever calls it
 * holds. Each meld is separated by {@link HAND_MELD_GAP_PX}, and the human's
 * drawn tile keeps its {@link TSUMO_GAP_RATIO} gap (a draw comes before the
 * calls, as it does in a real hand).
 *
 * The bands are sized for the shell metrics, not for one hand. A seat that
 * somehow asks for a run longer than its band (for example four kans on a side
 * seat) is compressed uniformly — steps and gaps only, never the body — so
 * every body still lands inside its band. No trainer generates such a hand; the
 * clamp is there so the layout is total and never escapes its zone.
 *
 * ## Compass
 *
 * {@link BoardZones.reserve} is the empty centre region reserved for the
 * compass. Phases 3–4 draw nothing in it.
 *
 * ## Draw order
 *
 * Placements are returned already sorted back-to-front, with a unique,
 * contiguous `drawOrder`, ready for Phase 4's painter's algorithm. The global
 * zone order is fixed by architecture §4.1:
 *
 * ```text
 * felt (not a placement) → top hand/melds → top wall →
 * left wall → right wall (each top of screen to bottom) →
 * centre reserve + four ponds → bottom wall →
 * left hand/melds → right hand/melds → bottom hand/melds
 * ```
 *
 * Within a zone (§4.2): horizontal rows paint right-to-left, ponds paint rows
 * top-to-bottom (left-to-right on the vertical ones) with each row against the
 * shadow direction, a sideways Riichi tile paints after its row, and a stacked
 * wall paints the whole lower tier before the upper tier.
 */
import type { ShellsManifest, ShellStats } from './shellManifest';
import type { ShellId, TileFaceId } from './tiles';

/** The four screen edges a player can sit on, matching `TableSide`. */
export type SeatSide = 'bottom' | 'right' | 'top' | 'left';

/** Turn order around the table as the human sees it. */
export const SEAT_SIDES: readonly SeatSide[] = ['bottom', 'right', 'top', 'left'];

/** The six columns of a discard pond (architecture §4, task 3.3). */
export const POND_COLUMNS = 6;

/** A full pond is three rows: 18 discards. */
export const POND_ROWS = 3;

/**
 * The most two-tile wall stacks a side shows.
 *
 * A dealt hand leaves `tiles_remaining ≤ 69` live-wall tiles (the 14-tile dead
 * wall is not drawn), i.e. at most 9 stacks a side at 8 tiles per stack layer,
 * so 10 always fits the board. Larger requests are clamped.
 */
export const MAX_WALL_PAIRS_PER_SIDE = 10;

/** Gap before the drawn tile, as a fraction of the standing shell's advance. */
export const TSUMO_GAP_RATIO = 0.35;

/** Gap between a hand and its calls, and between one call and the next. */
export const HAND_MELD_GAP_PX = 6;

/**
 * Height of one tier of a two-high wall, as a fraction of the tile's projected
 * long axis. The tile is 16.5 / 28 = 0.589 units thick and the wall cameras
 * look down at 75–80°, so the thickness projects to
 * `0.589 · cos(elevation) ≈ 0.10` of the projected tile height: 4.71 px on the
 * 47.10 px horizontal wall step and 4.18 px on the 41.78 px side step. A
 * fraction keeps the offset in step with the shell if it is ever re-baked.
 */
export const WALL_TIER_STEP_RATIO = 0.1;

/** Board margins and the gaps between zones, in board px. */
const BOARD_MARGIN = 8;
const ZONE_GAP = 8;
const RESERVE_GAP = 10;
const RESERVE_WIDTH = 224;
const RESERVE_HEIGHT = 120;
/** Lower bound on a compressed hand run's step factor; see the file header. */
const MIN_HAND_STEP_FACTOR = 0.2;

/** The felt raster is stretched, never covered, so the vignette stays at the edges. */
export const FELT_RUNTIME = {
  backgroundSize: '100% 100%',
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'center',
} as const;

export interface BoardRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BoardSize {
  readonly width: number;
  readonly height: number;
}

export interface BoardPoint {
  readonly x: number;
  readonly y: number;
}

/** One discard in a pond. */
export interface PondDiscardInput {
  readonly face: TileFaceId;
  /** The Riichi declaration tile lies sideways in the row. */
  readonly riichi?: boolean;
}

/** A called meld's type; purely informational for the layout. */
export type MeldKind = 'chi' | 'pon' | 'kan' | 'ankan';

/** One open (or concealed) call: 2 faces for a chi, 3 for a pon, 4 for a kan. */
export interface MeldInput {
  readonly tiles: readonly TileFaceId[];
  readonly kind?: MeldKind;
}

/** One seat's concealed hand, drawn tile and calls. */
export interface SeatHandInput {
  /** Concealed tiles, oldest first. */
  readonly hand?: readonly TileFaceId[];
  /** The freshly drawn tile, if this seat has one. */
  readonly draw?: TileFaceId | null;
  /** Called melds, in call order. */
  readonly melds?: readonly MeldInput[];
}

/** Everything the engine needs to place a board. All of it is plain data. */
export interface BoardLayoutInput {
  /**
   * The human's concealed hand, oldest tile first. A legal hand is at most 13
   * tiles; the engine does not apply game rules, so the caller owns that bound.
   */
  readonly hand?: readonly TileFaceId[];
  /** The freshly drawn tile, if this hand has one; placed after the tsumo gap. */
  readonly draw?: TileFaceId | null;
  /** The human's calls. They sit at the right-hand end of the hand row. */
  readonly melds?: readonly MeldInput[];
  /**
   * Every seat's hand, including the human's. A seat present here overrides the
   * bottom shorthand above; a missing seat simply has no hand.
   *
   * An opponent's hand is drawn with that seat's face-down shell, so its faces
   * are never visible: the atlas resolves every face key to the same bare back.
   * Keeping the real faces in the placement means a review dump can say which
   * hand a row stands for without the renderer ever painting it.
   */
  readonly hands?: Readonly<Partial<Record<SeatSide, SeatHandInput>>>;
  /**
   * Each seat's discards, oldest first. Missing seats simply have no pond. Only
   * the first {@link POND_COLUMNS} × {@link POND_ROWS} (18) are placed.
   */
  readonly ponds?: Readonly<Partial<Record<SeatSide, readonly PondDiscardInput[]>>>;
  /** Two-tile stacks per wall side. Defaults to {@link MAX_WALL_PAIRS_PER_SIDE}. */
  readonly wallPairsPerSide?: number;
}

/** Which zone a placement belongs to. */
export type PlacementZone = 'hand' | 'pond' | 'wall';

/** What a placement represents within its zone. */
export type PlacementKind =
  | 'hand'
  | 'draw'
  | 'meld'
  | 'discard'
  | 'wall-lower'
  | 'wall-upper';

/** One tile to draw, in board space. */
export interface TilePlacement {
  /** Stable identity, unique across the board. */
  readonly id: string;
  readonly zone: PlacementZone;
  readonly kind: PlacementKind;
  readonly seat: SeatSide;
  readonly shell: ShellId;
  readonly face: TileFaceId;
  /** Logical top-left of the opaque body in board px. */
  readonly gridX: number;
  readonly gridY: number;
  /** Where Phase 4 blits the sprite: `grid - shell.anchor`. */
  readonly drawX: number;
  readonly drawY: number;
  /**
   * The opaque body box: the hit target and the rect Phase 5's hover/lift
   * moves. Never includes the transparent shadow/AO margin.
   */
  readonly advanceRect: BoardRect;
  /** The same box, named for the hand's logical body / hover anchor. */
  readonly bodyRect: BoardRect;
  /** Global painter's order, 0 = painted first. */
  readonly drawOrder: number;
}

/** A pond's screen frame: where its first tile sits and how it steps. */
export interface PondFrame {
  readonly axis: 'horizontal' | 'vertical';
  readonly zone: BoardRect;
  /** Grid position of row 0 / column 0 (that seat's first discard). */
  readonly originX: number;
  readonly originY: number;
  /** Unit direction of one column step (down the screen on a vertical row). */
  readonly alongX: number;
  readonly alongY: number;
  /** Unit direction of one row step (toward the compass), screen axes. */
  readonly awayX: number;
  readonly awayY: number;
  /** Tight pitch along a row, in board px. */
  readonly alongPitchPx: number;
  /** Tight pitch from one row to the next, in board px. */
  readonly awayPitchPx: number;
  /** Along-row advance of a sideways Riichi tile, in board px. */
  readonly sidewaysAlongAdvancePx: number;
}

/** One seat's hand/meld band and the run rules that fill it. */
export interface HandBand {
  readonly axis: 'horizontal' | 'vertical';
  /** Concealed-hand shell for this seat: face-up for the human, backs otherwise. */
  readonly shell: ShellId;
  /** Tight pitch of the concealed run along the band, in board px. */
  readonly pitchPx: number;
  /** Which end of the band the calls sit on: -1 = start, +1 = end. */
  readonly meldSign: -1 | 1;
}

export interface BoardZones {
  readonly hand: Readonly<Record<SeatSide, BoardRect>>;
  readonly reserve: BoardRect;
  readonly ponds: Readonly<Record<SeatSide, BoardRect>>;
  /** Wall runs at {@link MAX_WALL_PAIRS_PER_SIDE}, including both tiers. */
  readonly walls: Readonly<Record<SeatSide, BoardRect>>;
}

/** Every derived number the layout uses, exposed for tests and review dumps. */
export interface BoardMetrics {
  readonly board: BoardSize;
  readonly zones: BoardZones;
  readonly ponds: Readonly<Record<SeatSide, PondFrame>>;
  readonly hands: Readonly<Record<SeatSide, HandBand>>;
  readonly wallTierStepPx: Readonly<Record<SeatSide, number>>;
  readonly hand: {
    readonly tsumoGapPx: number;
    readonly meldGapPx: number;
    readonly meldShell: ShellId;
    readonly meldPitchPx: Readonly<Record<'horizontal' | 'vertical', number>>;
  };
  readonly wall: {
    readonly shell: Readonly<Record<SeatSide, ShellId>>;
    readonly pitchPx: Readonly<Record<'horizontal' | 'vertical', number>>;
  };
}

export interface BoardLayout {
  readonly board: BoardSize;
  readonly metrics: BoardMetrics;
  readonly placements: readonly TilePlacement[];
  readonly counts: {
    readonly hand: number;
    readonly draw: number;
    readonly melds: number;
    readonly ponds: number;
    readonly walls: number;
  };
  readonly wallPairsPerSide: number;
}

/** The viewport-to-board transform described in the file header. */
export interface BoardFit {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly boardWidth: number;
  readonly boardHeight: number;
}

function absStep(step: readonly [number, number], axis: 0 | 1): number {
  return Math.abs(step[axis]);
}

/**
 * Extent of a row of `count` tiles along the row axis. Every tile advances by
 * the tight pitch except one, which may be the sideways Riichi shell and
 * advances by its own long extent; the last tile contributes its body.
 */
function maxAlongExtent(
  count: number,
  pitchPx: number,
  sidewaysAdvancePx: number,
  bodyPx: number,
  sidewaysBodyPx: number,
): number {
  const allNormal = (count - 1) * pitchPx + bodyPx;
  const sidewaysLast = (count - 1) * pitchPx + sidewaysBodyPx;
  // A sideways tile earlier in the row shifts every later tile by the
  // difference between its advance and the normal pitch.
  const sidewaysEarlier = Math.max(0, count - 2) * pitchPx + sidewaysAdvancePx + bodyPx;
  return Math.max(allNormal, sidewaysLast, sidewaysEarlier);
}

/**
 * Extent across rows. Row origins step by a fixed pitch; a sideways tile can
 * only make its own row's body deeper, never move the following rows.
 */
function maxAwayExtent(
  rows: number,
  pitchPx: number,
  bodyPx: number,
  sidewaysBodyPx: number,
): number {
  return (rows - 1) * pitchPx + Math.max(bodyPx, sidewaysBodyPx);
}

function rect(x: number, y: number, width: number, height: number): BoardRect {
  return { x, y, width, height };
}

/** The tier offset for a wall shell: see {@link WALL_TIER_STEP_RATIO}. */
export function wallTierStepPx(shell: ShellStats): number {
  return absStep(shell.gridStepPx.y, 1) * WALL_TIER_STEP_RATIO;
}

/**
 * The seat's own right-hand end of its hand row, as a direction along the
 * band: calls sit there, the concealed hand fills the rest.
 *
 * A player's right is the screen direction their seat faces, turned
 * clockwise: +x for the human at the bottom, −x for the top player, +y (down)
 * for the left player and −y (up) for the right player.
 */
const MELD_END_SIGN: Readonly<Record<SeatSide, -1 | 1>> = {
  bottom: 1,
  top: -1,
  left: 1,
  right: -1,
};

/** Derive the board, its zones and every pitch from the shell manifest. */
export function boardMetrics(shells: ShellsManifest): BoardMetrics {
  const flat = shells.shells.shell_flat_upright;
  const sideways = shells.shells.shell_flat_sideways;
  const standing = shells.shells.shell_hand_standing;
  const wallHorizontal = shells.shells.shell_wall_horizontal;
  const sideLeft = shells.shells.shell_wall_side_left;
  const sideRight = shells.shells.shell_wall_side_right;

  // Tight axes of an upright pond tile. The step is the projected tile body;
  // the advance box also carries the AA ledge and thickness extrusion.
  const pondStepX = absStep(flat.gridStepPx.x, 0);
  const pondStepY = absStep(flat.gridStepPx.y, 1);
  // The sideways shell's long axis is horizontal on screen; its short axis is
  // vertical. 52 px and 38.41 px on the current bake.
  const sidewaysAlongX = absStep(sideways.gridStepPx.y, 0);
  const sidewaysAlongY = absStep(sideways.gridStepPx.x, 1);

  // Largest pond block each orientation can need, including a sideways tile in
  // any slot. A horizontal pond runs 6 columns along x and 3 rows along y; a
  // side pond runs 6 tiles down the screen and 3 rows across.
  const horizontalPond = {
    width: maxAlongExtent(
      POND_COLUMNS,
      pondStepX,
      sidewaysAlongX,
      flat.advanceWidth,
      sideways.advanceWidth,
    ),
    height: maxAwayExtent(
      POND_ROWS,
      pondStepY,
      flat.advanceHeight,
      sideways.advanceHeight,
    ),
  };
  const verticalPond = {
    width: maxAwayExtent(
      POND_ROWS,
      pondStepX,
      flat.advanceWidth,
      sideways.advanceWidth,
    ),
    height: maxAlongExtent(
      POND_COLUMNS,
      pondStepY,
      sidewaysAlongY,
      flat.advanceHeight,
      sideways.advanceHeight,
    ),
  };

  const wallTierStep = wallTierStepPx(wallHorizontal);
  const sideWidth = Math.max(sideLeft.advanceWidth, sideRight.advanceWidth);
  // A side hand column is as wide as a side-wall tile, which also fits an
  // upright meld; the top/bottom hand band is one horizontal-wall tile tall,
  // which fits both a face-down back and an upright meld body.
  const handColumnWidth = sideWidth;
  const handBandHeight = wallHorizontal.advanceHeight;

  // Vertical stack, top to bottom: top hand, top wall, top pond, compass
  // reserve, bottom pond, bottom wall, bottom hand. The felt is a separate
  // full-screen layer, so the board is simply centred in the viewport.
  const topHandY = BOARD_MARGIN;
  const topWallLowerY = topHandY + handBandHeight + ZONE_GAP + wallTierStep;
  const topWallBottom = topWallLowerY + wallHorizontal.advanceHeight;
  const topPondY = topWallBottom + ZONE_GAP;
  const reserveY = topPondY + horizontalPond.height + RESERVE_GAP;
  const bottomPondY = reserveY + RESERVE_HEIGHT + RESERVE_GAP;
  const bottomWallLowerY = bottomPondY + horizontalPond.height + ZONE_GAP;
  const handY = bottomWallLowerY + wallHorizontal.advanceHeight + ZONE_GAP;

  const boardHeight = Math.ceil(handY + handBandHeight + BOARD_MARGIN);
  // Horizontal: margin, hand column, wall, pond, reserve (both sides). The hand
  // columns are outside the walls so every edge reads hand → wall → pond.
  const boardWidth = Math.ceil(
    2 *
      (BOARD_MARGIN +
        handColumnWidth +
        ZONE_GAP +
        sideWidth +
        ZONE_GAP +
        verticalPond.width +
        RESERVE_GAP) +
      RESERVE_WIDTH,
  );

  const centreX = boardWidth / 2;
  const reserve = rect(centreX - RESERVE_WIDTH / 2, reserveY, RESERVE_WIDTH, RESERVE_HEIGHT);
  const leftPondX = reserve.x - RESERVE_GAP - verticalPond.width;
  const rightPondX = reserve.x + reserve.width + RESERVE_GAP;
  const leftWallX = leftPondX - ZONE_GAP - sideWidth;
  const rightWallX = boardWidth - BOARD_MARGIN - handColumnWidth - ZONE_GAP - sideWidth;
  const leftHandX = leftWallX - ZONE_GAP - handColumnWidth;
  const rightHandX = boardWidth - BOARD_MARGIN - handColumnWidth;
  const horizontalPondX = centreX - horizontalPond.width / 2;
  const playfieldCentreY = reserve.y + reserve.height / 2;

  const pondZones: Record<SeatSide, BoardRect> = {
    bottom: rect(horizontalPondX, bottomPondY, horizontalPond.width, horizontalPond.height),
    top: rect(horizontalPondX, topPondY, horizontalPond.width, horizontalPond.height),
    left: rect(leftPondX, playfieldCentreY - verticalPond.height / 2, verticalPond.width, verticalPond.height),
    right: rect(rightPondX, playfieldCentreY - verticalPond.height / 2, verticalPond.width, verticalPond.height),
  };

  // Row 0 is that seat's nearest row. Bottom/top rows are horizontal; side
  // rows run vertically so they stay parallel to their player's edge.
  const ponds: Record<SeatSide, PondFrame> = {
    bottom: {
      axis: 'horizontal',
      zone: pondZones.bottom,
      originX: pondZones.bottom.x,
      originY: pondZones.bottom.y + pondZones.bottom.height - flat.advanceHeight,
      alongX: 1,
      alongY: 0,
      awayX: 0,
      awayY: -1,
      alongPitchPx: pondStepX,
      awayPitchPx: pondStepY,
      sidewaysAlongAdvancePx: sidewaysAlongX,
    },
    top: {
      axis: 'horizontal',
      zone: pondZones.top,
      originX: pondZones.top.x,
      originY: pondZones.top.y,
      alongX: 1,
      alongY: 0,
      awayX: 0,
      awayY: 1,
      alongPitchPx: pondStepX,
      awayPitchPx: pondStepY,
      sidewaysAlongAdvancePx: sidewaysAlongX,
    },
    left: {
      axis: 'vertical',
      zone: pondZones.left,
      originX: pondZones.left.x,
      originY: pondZones.left.y,
      alongX: 0,
      alongY: 1,
      awayX: 1,
      awayY: 0,
      alongPitchPx: pondStepY,
      awayPitchPx: pondStepX,
      sidewaysAlongAdvancePx: sidewaysAlongY,
    },
    right: {
      axis: 'vertical',
      zone: pondZones.right,
      // Row 0 is the rightmost row; leave room for a sideways tile's 54 px
      // body, which extends right from its grid origin.
      originX: pondZones.right.x + pondZones.right.width - sideways.advanceWidth,
      originY: pondZones.right.y,
      alongX: 0,
      alongY: 1,
      awayX: -1,
      awayY: 0,
      alongPitchPx: pondStepY,
      awayPitchPx: pondStepX,
      sidewaysAlongAdvancePx: sidewaysAlongY,
    },
  };

  const horizontalRunWidth =
    (MAX_WALL_PAIRS_PER_SIDE - 1) * absStep(wallHorizontal.gridStepPx.x, 0) +
    wallHorizontal.advanceWidth;
  const verticalRunHeight =
    (MAX_WALL_PAIRS_PER_SIDE - 1) * absStep(sideLeft.gridStepPx.y, 1) + sideLeft.advanceHeight;
  // A wall zone is the run plus the upper tier's upward offset, so the two-tier
  // box (not just the lower run) is the zone's bounds.
  const sideRunY = playfieldCentreY - verticalRunHeight / 2;
  const wallZones: Record<SeatSide, BoardRect> = {
    top: rect(
      centreX - horizontalRunWidth / 2,
      topWallLowerY - wallTierStep,
      horizontalRunWidth,
      wallHorizontal.advanceHeight + wallTierStep,
    ),
    bottom: rect(
      centreX - horizontalRunWidth / 2,
      bottomWallLowerY - wallTierStep,
      horizontalRunWidth,
      wallHorizontal.advanceHeight + wallTierStep,
    ),
    left: rect(
      leftWallX,
      sideRunY - wallTierStepPx(sideLeft),
      sideWidth,
      verticalRunHeight + wallTierStepPx(sideLeft),
    ),
    right: rect(
      rightWallX,
      sideRunY - wallTierStepPx(sideRight),
      sideWidth,
      verticalRunHeight + wallTierStepPx(sideRight),
    ),
  };

  // The top/bottom bands are inset between the side hand columns: the columns
  // are full height, so the corners stay free for them.
  const handBandX = leftHandX + handColumnWidth + ZONE_GAP;
  const handBandWidth = rightHandX - ZONE_GAP - handBandX;
  const sideHandHeight = boardHeight - 2 * BOARD_MARGIN;
  const handZones: Record<SeatSide, BoardRect> = {
    bottom: rect(handBandX, handY, handBandWidth, handBandHeight),
    top: rect(handBandX, topHandY, handBandWidth, handBandHeight),
    left: rect(leftHandX, BOARD_MARGIN, handColumnWidth, sideHandHeight),
    right: rect(rightHandX, BOARD_MARGIN, handColumnWidth, sideHandHeight),
  };

  // Concealed-hand shells and their tight along-band pitch. The human's
  // standing hand steps by its advance box (Phase 3's hand pitch), never the
  // projected grid step: standing tiles are drawn at their full 38 px body.
  const hands: Record<SeatSide, HandBand> = {
    bottom: {
      axis: 'horizontal',
      shell: 'shell_hand_standing',
      pitchPx: standing.advanceWidth,
      meldSign: MELD_END_SIGN.bottom,
    },
    top: {
      axis: 'horizontal',
      shell: 'shell_wall_horizontal',
      pitchPx: absStep(wallHorizontal.gridStepPx.x, 0),
      meldSign: MELD_END_SIGN.top,
    },
    left: {
      axis: 'vertical',
      shell: 'shell_wall_side_left',
      pitchPx: absStep(sideLeft.gridStepPx.y, 1),
      meldSign: MELD_END_SIGN.left,
    },
    right: {
      axis: 'vertical',
      shell: 'shell_wall_side_right',
      pitchPx: absStep(sideRight.gridStepPx.y, 1),
      meldSign: MELD_END_SIGN.right,
    },
  };

  return {
    board: { width: boardWidth, height: boardHeight },
    zones: {
      hand: handZones,
      reserve,
      ponds: pondZones,
      walls: wallZones,
    },
    ponds,
    hands,
    wallTierStepPx: {
      top: wallTierStep,
      bottom: wallTierStep,
      left: wallTierStepPx(sideLeft),
      right: wallTierStepPx(sideRight),
    },
    hand: {
      tsumoGapPx: standing.advanceWidth * TSUMO_GAP_RATIO,
      meldGapPx: HAND_MELD_GAP_PX,
      meldShell: 'shell_flat_upright',
      meldPitchPx: { horizontal: pondStepX, vertical: pondStepY },
    },
    wall: {
      shell: {
        top: 'shell_wall_horizontal',
        bottom: 'shell_wall_horizontal',
        left: 'shell_wall_side_left',
        right: 'shell_wall_side_right',
      },
      pitchPx: {
        horizontal: absStep(wallHorizontal.gridStepPx.x, 0),
        vertical: absStep(sideLeft.gridStepPx.y, 1),
      },
    },
  };
}

interface MutablePlacement {
  id: string;
  zone: PlacementZone;
  kind: PlacementKind;
  seat: SeatSide;
  shell: ShellId;
  face: TileFaceId;
  gridX: number;
  gridY: number;
  advanceRect: BoardRect;
  bodyRect: BoardRect;
}

function place(
  shells: ShellsManifest,
  placement: Omit<MutablePlacement, 'advanceRect' | 'bodyRect'>,
): MutablePlacement {
  const shell = shells.shells[placement.shell];
  const box = rect(placement.gridX, placement.gridY, shell.advanceWidth, shell.advanceHeight);
  return { ...placement, advanceRect: box, bodyRect: box };
}

/** The hand input for one seat: `hands[seat]` wins, the bottom shorthands fill in. */
function seatHand(input: BoardLayoutInput, seat: SeatSide): SeatHandInput {
  const explicit = input.hands?.[seat];
  if (explicit) return explicit;
  if (seat !== 'bottom') return {};
  return { hand: input.hand ?? [], draw: input.draw ?? null, melds: input.melds ?? [] };
}

/**
 * Lay out a whole board.
 *
 * Zone paint order follows architecture §4.1: the top hand and top wall, the
 * left and right side walls (top of screen to bottom), the ponds, the bottom
 * wall, the side hands, and finally the human's calls and hand (which must
 * never be clipped by the wall). Within a zone: horizontal hand rows paint
 * right-to-left, side hand columns top-to-bottom, ponds paint rows from the top
 * of the screen downward (or left to right for the vertical side ponds) and
 * each row against the shadow direction, a sideways Riichi tile paints after
 * its neighbours, and walls paint the whole lower tier before the upper tier.
 */
export function layoutBoard(shells: ShellsManifest, input: BoardLayoutInput = {}): BoardLayout {
  const metrics = boardMetrics(shells);
  const requestedPairs = input.wallPairsPerSide ?? MAX_WALL_PAIRS_PER_SIDE;
  const wallPairsPerSide = Number.isFinite(requestedPairs)
    ? Math.max(0, Math.min(MAX_WALL_PAIRS_PER_SIDE, Math.trunc(requestedPairs)))
    : MAX_WALL_PAIRS_PER_SIDE;

  const placements: MutablePlacement[] = [];

  // ---- top hand, then the top wall -----------------------------------------
  placements.push(...handPlacements(shells, metrics, 'top', seatHand(input, 'top')));
  placements.push(...wallPlacements(shells, metrics, 'top', wallPairsPerSide));

  // ---- side walls, left then right, top of screen to bottom -----------------
  for (const side of ['left', 'right'] as const) {
    placements.push(...wallPlacements(shells, metrics, side, wallPairsPerSide));
  }

  // ---- ponds ----------------------------------------------------------------
  for (const side of ['top', 'left', 'right', 'bottom'] as const) {
    const discards = input.ponds?.[side] ?? [];
    placements.push(...pondPlacements(shells, metrics.ponds[side], side, discards));
  }

  // ---- bottom wall, then the side hands, then the human's hand -------------
  placements.push(...wallPlacements(shells, metrics, 'bottom', wallPairsPerSide));
  for (const side of ['left', 'right'] as const) {
    placements.push(...handPlacements(shells, metrics, side, seatHand(input, side)));
  }
  placements.push(...handPlacements(shells, metrics, 'bottom', seatHand(input, 'bottom')));

  const drawOrder = placements.map((placement, index) => ({
    ...placement,
    drawX: placement.gridX - shells.shells[placement.shell].anchorX,
    drawY: placement.gridY - shells.shells[placement.shell].anchorY,
    drawOrder: index,
  }));

  const counts = {
    hand: drawOrder.filter((placement) => placement.kind === 'hand').length,
    draw: drawOrder.filter((placement) => placement.kind === 'draw').length,
    melds: drawOrder.filter((placement) => placement.kind === 'meld').length,
    ponds: drawOrder.filter((placement) => placement.zone === 'pond').length,
    walls: drawOrder.filter((placement) => placement.zone === 'wall').length,
  };

  return {
    board: metrics.board,
    metrics,
    placements: drawOrder,
    counts,
    wallPairsPerSide,
  };
}

function wallPlacements(
  shells: ShellsManifest,
  metrics: BoardMetrics,
  side: SeatSide,
  pairs: number,
): MutablePlacement[] {
  if (pairs === 0) return [];
  const shellId = metrics.wall.shell[side];
  const shell = shells.shells[shellId];
  const tierStep = metrics.wallTierStepPx[side];
  const horizontal = side === 'top' || side === 'bottom';
  const pitch = horizontal ? metrics.wall.pitchPx.horizontal : metrics.wall.pitchPx.vertical;
  const runExtent = (pairs - 1) * pitch + (horizontal ? shell.advanceWidth : shell.advanceHeight);
  const zone = metrics.zones.walls[side];

  // Runs are centred on their edge. A top/bottom run sits above/below its pond;
  // the side runs are centred on the compass. The upper tier occupies the top
  // `tierStep` of the zone on every side.
  const baseX = horizontal ? zone.x + (zone.width - runExtent) / 2 : zone.x;
  const baseY = horizontal
    ? zone.y + tierStep
    : zone.y + tierStep + (zone.height - tierStep - runExtent) / 2;

  const out: MutablePlacement[] = [];
  // Lower tier completely, then the upper tier at `dy = -tierStep`, `dx = 0`.
  for (let tier = 0; tier < 2; tier += 1) {
    const dy = tier === 0 ? 0 : -tierStep;
    // A horizontal run paints right-to-left; a side run top-to-bottom (§4.2).
    const indices = horizontal
      ? Array.from({ length: pairs }, (_, index) => pairs - 1 - index)
      : Array.from({ length: pairs }, (_, index) => index);
    for (const index of indices) {
      const gridX = horizontal ? baseX + index * pitch : baseX;
      const gridY = horizontal ? baseY + dy : baseY + index * pitch + dy;
      out.push(
        place(shells, {
          id: `${side}-wall:${tier === 0 ? 'lower' : 'upper'}:${index}`,
          zone: 'wall',
          kind: tier === 0 ? 'wall-lower' : 'wall-upper',
          seat: side,
          shell: shellId,
          face: 'blank',
          gridX,
          gridY,
        }),
      );
    }
  }
  return out;
}

function pondPlacements(
  shells: ShellsManifest,
  frame: PondFrame,
  side: SeatSide,
  discards: readonly PondDiscardInput[],
): MutablePlacement[] {
  const visible = discards.slice(0, POND_COLUMNS * POND_ROWS);
  const cells: Array<{ placement: MutablePlacement; gridX: number; gridY: number }> = [];
  let along = 0;
  let away = 0;
  let column = 0;

  visible.forEach((discard, index) => {
    const riichi = discard.riichi === true;
    const shellId: ShellId = riichi ? 'shell_flat_sideways' : 'shell_flat_upright';
    const gridX = frame.originX + along * frame.alongX + away * frame.awayX;
    const gridY = frame.originY + along * frame.alongY + away * frame.awayY;
    const placement = place(shells, {
      id: `${side}-pond:${index}`,
      zone: 'pond',
      kind: 'discard',
      seat: side,
      shell: shellId,
      face: discard.face,
      gridX,
      gridY,
    });
    cells.push({ placement, gridX, gridY });

    // The sideways tile advances along the row by its own long extent; the rest
    // of the row shifts by the difference so later tiles never overlap it.
    along += riichi ? frame.sidewaysAlongAdvancePx : frame.alongPitchPx;
    column += 1;
    if (column === POND_COLUMNS) {
      column = 0;
      along = 0;
      away += frame.awayPitchPx;
    }
  });

  // Painter's order (§4.2): rows top-to-bottom on screen for horizontal ponds
  // (left-to-right for the vertical ones), each row right-to-left
  // (bottom-to-top for the vertical ones). A sideways tile paints after its
  // neighbours: its 54 px body is wider than a vertical row is deep, so the
  // next row would otherwise cover the Riichi face. It is the one tile whose
  // face must stay fully visible.
  cells.sort((left, right) => {
    const leftSideways = left.placement.shell === 'shell_flat_sideways' ? 1 : 0;
    const rightSideways = right.placement.shell === 'shell_flat_sideways' ? 1 : 0;
    if (leftSideways !== rightSideways) return leftSideways - rightSideways;
    if (frame.axis === 'horizontal') {
      if (left.gridY !== right.gridY) return left.gridY - right.gridY;
      return right.gridX - left.gridX;
    }
    if (left.gridX !== right.gridX) return left.gridX - right.gridX;
    return right.gridY - left.gridY;
  });
  return cells.map((cell) => cell.placement);
}

/** One segment of a hand row: a run of backs, a draw, or one call. */
interface HandSegment {
  readonly kind: 'hand' | 'draw' | 'meld';
  readonly shell: ShellId;
  readonly faces: readonly TileFaceId[];
  readonly gapBeforePx: number;
  /** Only for a meld segment: its index in the input's `melds` array. */
  readonly meldIndex?: number;
}

function handPlacements(
  shells: ShellsManifest,
  metrics: BoardMetrics,
  seat: SeatSide,
  input: SeatHandInput,
): MutablePlacement[] {
  const band = metrics.zones.hand[seat];
  const shape = metrics.hands[seat];
  const horizontal = shape.axis === 'horizontal';
  const meldShell = metrics.hand.meldShell;
  const meldPitch = horizontal
    ? metrics.hand.meldPitchPx.horizontal
    : metrics.hand.meldPitchPx.vertical;
  const gap = metrics.hand.meldGapPx;

  const concealed = input.hand ?? [];
  const draw = input.draw ?? null;
  const melds = (input.melds ?? [])
    .map((meld, index) => ({ meld, index }))
    .filter((entry) => entry.meld.tiles.length > 0);

  const concealedSegment: HandSegment = {
    kind: 'hand',
    shell: shape.shell,
    faces: concealed,
    gapBeforePx: 0,
  };
  const drawSegment: HandSegment | null = draw
    ? { kind: 'draw', shell: shape.shell, faces: [draw], gapBeforePx: metrics.hand.tsumoGapPx }
    : null;
  const meldSegments: HandSegment[] = melds.map(({ meld, index }) => ({
    kind: 'meld',
    shell: meldShell,
    faces: meld.tiles,
    gapBeforePx: gap,
    meldIndex: index,
  }));

  // The calls sit at the seat's own right-hand end; the concealed run and its
  // draw fill the rest, with the draw next to the concealed tiles.
  const segments: HandSegment[] = [];
  if (shape.meldSign > 0) {
    segments.push(concealedSegment);
    if (drawSegment) segments.push(drawSegment);
    segments.push(...meldSegments);
  } else {
    segments.push(...meldSegments);
    segments.push(concealedSegment);
    if (drawSegment) segments.push(drawSegment);
  }
  const groups = segments.filter((segment) => segment.faces.length > 0);
  if (groups.length === 0) return [];
  // Re-anchor the first real segment: it has nothing before it to gap from.
  groups[0] = { ...groups[0], gapBeforePx: 0 };

  const pitchOf = (segment: HandSegment): number =>
    segment.shell === meldShell ? meldPitch : shape.pitchPx;
  const advanceOf = (segment: HandSegment): number => {
    const shell = shells.shells[segment.shell];
    return horizontal ? shell.advanceWidth : shell.advanceHeight;
  };
  const stepExtent = (segment: HandSegment): number =>
    segment.gapBeforePx + (segment.faces.length - 1) * pitchOf(segment);

  const available = horizontal ? band.width : band.height;
  const steps = groups.reduce((total, segment) => total + stepExtent(segment), 0);
  const bodies = groups.reduce((total, segment) => total + advanceOf(segment), 0);
  // The band is sized from the shell metrics, so this only engages for a hand
  // no trainer generates (see the file header). Bodies are never scaled.
  const factor =
    steps > 0 && steps + bodies > available
      ? Math.max(MIN_HAND_STEP_FACTOR, (available - bodies) / steps)
      : 1;
  const extent = groups.reduce(
    (total, segment) => total + stepExtent(segment) * factor + advanceOf(segment),
    0,
  );

  let cursor = (horizontal ? band.x : band.y) + (available - extent) / 2;
  const out: MutablePlacement[] = [];
  for (const segment of groups) {
    cursor += segment.gapBeforePx * factor;
    const advance = advanceOf(segment);
    segment.faces.forEach((face, index) => {
      const along = cursor + index * pitchOf(segment) * factor;
      const shell = shells.shells[segment.shell];
      // Horizontal rows bottom-align in the band (a meld is one px shorter than
      // a back); vertical columns centre in the column.
      const gridX = horizontal ? along : band.x + (band.width - shell.advanceWidth) / 2;
      const gridY = horizontal
        ? band.y + band.height - shell.advanceHeight
        : along;
      const id =
        segment.kind === 'meld'
          ? `${seat}-meld:${segment.meldIndex}:${index}`
          : segment.kind === 'draw'
            ? `${seat}-hand:draw`
            : `${seat}-hand:${index}`;
      out.push(
        place(shells, {
          id,
          zone: 'hand',
          kind: segment.kind,
          seat,
          shell: segment.shell,
          face,
          gridX,
          gridY,
        }),
      );
    });
    cursor += (segment.faces.length - 1) * pitchOf(segment) * factor + advance;
  }

  // Painter's order (§4.2): a horizontal row paints right-to-left, a vertical
  // column top-to-bottom. The drawn tile is rightmost, so it paints first.
  out.sort((left, right) =>
    horizontal ? right.gridX - left.gridX : left.gridY - right.gridY,
  );
  return out;
}

/**
 * Contain the board in the viewport, preserving aspect and centring it. The
 * felt behind it is a separate full-screen layer and is not scaled here.
 */
export function fitBoardToViewport(viewport: BoardSize, board: BoardSize): BoardFit {
  if (viewport.width <= 0 || viewport.height <= 0 || board.width <= 0 || board.height <= 0) {
    return { scale: 0, offsetX: 0, offsetY: 0, boardWidth: board.width, boardHeight: board.height };
  }
  const scale = Math.min(viewport.width / board.width, viewport.height / board.height);
  return {
    scale,
    offsetX: (viewport.width - board.width * scale) / 2,
    offsetY: (viewport.height - board.height * scale) / 2,
    boardWidth: board.width,
    boardHeight: board.height,
  };
}

/** Map a point in board space to CSS px inside the viewport. */
export function boardToCss(fit: BoardFit, point: BoardPoint): BoardPoint {
  return {
    x: fit.offsetX + point.x * fit.scale,
    y: fit.offsetY + point.y * fit.scale,
  };
}
