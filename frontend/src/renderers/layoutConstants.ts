/**
 * The 3D chain's committed table and camera constants (3D-01; the board and
 * framing constants are 3D-06's additions to the same module).
 *
 * These mirror the user-signed-off whole-table reference
 * (`tools/render/table-reference-spec.json`, rig v13) and the committed tile
 * proportions (`tools/render/shell-spec.json`), but the 3D chain owns them: it
 * does not import across the `tools/` boundary at build time and never writes
 * there. `frontend/scripts/check-3d-layout.mjs` (3D-06) asserts the internal
 * invariants from these values; comparing them against the reference spec is an
 * optional local `--reference` run, not a CI gate, so a 2.5D edit cannot turn
 * the 3D gate red.
 *
 * Everything here is pure data: no three.js, no DOM, no game rules. The
 * consumer is `three/boardLayout.ts`, which turns these numbers into world
 * transforms and a solved camera per aspect.
 *
 * All lengths are tile units: **1 unit = 28 mm**, the tile height. The 3D world
 * is +X right, +Y up, +Z toward the human, which maps from the Blender reference
 * as `(x, y, z)three = (x, z, -y)blender`.
 */

/** The committed tile proportions in millimetres (height x width x thickness). */
export const TILE_MM = {
  height: 28,
  width: 21,
  thickness: 16.5,
} as const;

/** The world unit, in millimetres. */
export const UNIT_MM = TILE_MM.height;

/**
 * The committed tile body, in world units, plus the groove width used to
 * derive every row pitch.
 *
 * The body and bevel are `shell-spec.json`'s values, so the 3D tile cannot
 * drift from the shipped 2.5D shell. The face plate is the carved relief's
 * 17.92 x 24.92 mm cell (0.64 x 0.89 units), inset by the 0.055-unit bevel.
 */
export const TILE = {
  widthUnits: TILE_MM.width / UNIT_MM,
  heightUnits: TILE_MM.height / UNIT_MM,
  thicknessUnits: TILE_MM.thickness / UNIT_MM,
  /** The 0.3 mm gap between tiles in a row. */
  gapUnits: 0.3 / UNIT_MM,
  bevelUnits: 0.055,
  facePlateWidthUnits: 17.92 / UNIT_MM,
  facePlateHeightUnits: 24.92 / UNIT_MM,
} as const;

/**
 * The play surface: one felt plane, plus the compass well the DOM overlay
 * anchors to. There is no modelled table (no rails, aprons, floor or room).
 */
export const TABLE = {
  /** 700 mm square mat. */
  matSizeUnits: 25,
  /** Screen-space compass well; the overlay is DOM, not 3D text. */
  compassWellUnits: 4,
} as const;

/**
 * A point stick (1000 points), lying flat next to the compass well.
 *
 * The sticks are table furniture, not tiles: the layout never merges them into
 * the tile list and the collision gate skips them. They sit in the free band
 * between the compass well (half-width 2) and the human's nearest pond row
 * (inner edge 2.2886), a 0.29-unit annulus wide enough for the 0.22-unit width,
 * and they lie along +X so the row reads from the camera.
 */
export const STICK = {
  lengthUnits: 1.2,
  widthUnits: 0.22,
  heightUnits: 0.1,
  /** Centre-line distance from the table centre, on the human's (+Z) side. */
  radiusUnits: 2.144,
  /** Centre-to-centre step along the row. */
  pitchUnits: 0.3,
} as const;

/** Seats around the table, in turn order from the human. */
export const SEATS = {
  count: 4,
  /**
   * Y rotation, in degrees, per seat step from the human (0, +1, +2, +3). The
   * human sits on the +Z edge, so the next player is on +X, then -Z, then -X;
   * the reference's bottom/right/top/left `rotateZDeg` values.
   */
  relativeRotationDeg: [0, 90, 180, 270],
} as const;

/**
 * The wall: four runs of 17 stacks, two face-down tiles high, on a ring of
 * radius 7.0. Every run is missing its top tile at the draw end (slot 16), as
 * the committed reference draws it. The wall is decorative: the engine
 * publishes `tiles_remaining`, not per-slot occupancy, so it is never depleted
 * (§9 R6 of the plan).
 *
 * A wall tile's snapshot slot is
 * `run * slotsPerRun + stack * tiers + tier`, with tiers 0 (bottom) and 1 (top).
 * Run `n` is the run in front of absolute seat `n`, so the far wall is
 * `(humanSeat + 2) % 4`. The draw-end top positions are absent, so a full
 * snapshot wall has {@link WALL.tileCount} tiles and no gaps in the slot
 * meanings it does use. The wall is decorative; board layout is free to use the
 * constants for a symmetric ring.
 */
const WALL_RUNS = 4;
const WALL_STACKS_PER_RUN = 17;
const WALL_TIERS = 2;
const WALL_DRAW_END_SLOT = 16;
const WALL_DRAW_END_TIERS = 1;

export const WALL = {
  runs: WALL_RUNS,
  stacksPerRun: WALL_STACKS_PER_RUN,
  tiers: WALL_TIERS,
  /** Ring radius from the table centre to a run's tile centre line. */
  radiusUnits: 7,
  /** One stack pitch: a 21 mm tile plus the 0.3 mm groove. */
  stackPitchUnits: TILE.widthUnits + TILE.gapUnits,
  /** The second tier's rise: one 16.5 mm thickness plus the 0.3 mm tier gap. */
  tierStepUnits: TILE.thicknessUnits + TILE.gapUnits,
  /** Centre-to-centre length of one 17-stack run (the reference's 12.932143). */
  runSpanUnits: WALL_STACKS_PER_RUN * (TILE.widthUnits + TILE.gapUnits),
  /** The committed one-tile draw end: slot 16 loses its top tier on every run. */
  drawEndSlot: WALL_DRAW_END_SLOT,
  drawEndTiers: WALL_DRAW_END_TIERS,
  /**
   * The draw end sits at the seat's **right** (local +tangential), which is the
   * committed clockwise draw: the close wall draws from its right, the top wall
   * from its left, the right wall from its far side and the left wall from its
   * close side. In each seat's own frame that is the same +w end, so the layout
   * and its gate can assert one rule instead of four.
   */
  drawEndIsSeatRight: true,
  slotsPerRun: WALL_STACKS_PER_RUN * WALL_TIERS,
  tileCount:
    WALL_RUNS *
    (WALL_STACKS_PER_RUN * WALL_TIERS - (WALL_TIERS - WALL_DRAW_END_TIERS)),
} as const;

/**
 * The revealed dora indicators: face-up on the far wall's top tier, one per
 * indicator, counting in from the draw end (the 3D contract places them there,
 * §4 of `3d_renderer_implementation_plan.md`; the 2.5D reference's dead wall is
 * on the left run and is not modelled here).
 *
 * Indicator `i` covers the wall stack at `drawEndSlot - 1 - i`, tier 1, and the
 * decorative wall tile underneath it is omitted, so the two lists never draw the
 * same tile twice. A game reveals at most five indicators (four kans plus the
 * initial flip), which is what the layout accepts.
 */
export const DORA = {
  /** Top tier, matching the flipped wall tile. */
  tier: 1,
  /** Indicator 0 sits one stack inboard of the missing draw-end top. */
  firstStackFromDrawEnd: 1,
  maxIndicators: 5,
} as const;

/**
 * One seat's discard pond: 3 rows of 6, filled from the far row toward the
 * player, plus four overflow anchors that extend the nearest row. Rows are
 * listed nearest-to-player first, matching the reference's radii; the first
 * chronological discard therefore lands in row 2, the last row listed.
 */
export const POND = {
  columns: 6,
  rows: 3,
  /** A 21 mm tile plus the 0.2 mm column groove. */
  columnPitchUnits: TILE.widthUnits + 0.2 / UNIT_MM,
  /** The column gap a turned tile is set out from its neighbour by. */
  columnGapUnits: 0.2 / UNIT_MM,
  /** A 28 mm tile plus the 0.3 mm row groove. */
  rowPitchUnits: TILE.heightUnits + TILE.gapUnits,
  /** Distance from table centre to each row's centre line, nearest first. */
  rowRadiiUnits: [4.81, 3.799286, 2.788571],
  /** Half of a 6-column row (2.5 pitches), measured from the seat's centre line. */
  columnCentreOffsetUnits: 2.5 * (TILE.widthUnits + 0.2 / UNIT_MM),
  /** Extra anchors on the nearest row, at columns 6..9. */
  overflowColumns: 4,
  /** Which row the overflow cells extend: the nearest row, index into rowRadiiUnits. */
  overflowRow: 0,
  /**
   * A turned (riichi) discard advances the row by its long axis: a 28 mm tile
   * plus the 0.3 mm groove, exactly the reference's `turned` step.
   */
  sidewaysPitchUnits: TILE.heightUnits + TILE.gapUnits,
  /** 18 pond cells plus the four overflow anchors. */
  capacity: 18 + 4,
} as const;

/**
 * The human hand: 13 concealed tiles in a row, plus a separated draw slot.
 *
 * The hand is reclined by user decision 3 (40° back from upright, accepted band
 * 30-45°); the 2.5D reference's 12° pose is a camera cheat that true 3D does not
 * need. The gate is numeric: the angle between the hand face normal and the
 * camera view ray must stay within {@link HAND.maxFaceToViewDeg} at every
 * supported aspect. The draw offset comes from the reference's structured
 * `hand.drawnOffsetUnits` field (its prose rounds the same slot to 5.5805).
 */
export const HAND = {
  concealedCount: 13,
  /** One stack pitch: a 21 mm tile plus the 0.3 mm groove. */
  pitchUnits: TILE.widthUnits + TILE.gapUnits,
  /** The intentional tsumogiri gap between the hand row and the drawn tile. */
  drawGapUnits: 0.2625,
  /** The drawn tile's centre offset from the seat's centre line. */
  drawOffsetUnits: 5.576785714,
  /** Distance from table centre to the standing hand's back edge. */
  backRadiusUnits: 10.6,
  reclineDeg: 40,
  reclineBandDeg: [30, 45],
  /** Largest allowed angle between the hand face normal and the view ray. */
  maxFaceToViewDeg: 25,
} as const;

/**
 * One seat's open-meld row: four slots to the right of the hand, outside the
 * wall ring at the hand's radius (the reference's `meld` block).
 *
 * The row is laid out as a sequence, not a fixed grid: an upright slot advances
 * by a 21 mm tile plus the 0.3 mm groove, and a sideways (called) slot advances
 * by its 28 mm long axis plus the groove, exactly the reference's
 * `calledWidthUnits`. A meld therefore occupies as many slots as it has tiles,
 * and consecutive melds follow each other along the row (the reference only
 * models the single 4-slot row). If a row would run past {@link MELD.maxRowUnits}
 * the next meld starts a row one pitch nearer the player, so a four-meld hand
 * never leaves the mat.
 */
export const MELD = {
  /** A full row's nominal slots: two upright, the called tile, the kan extension. */
  slots: 4,
  /** Advance past an upright meld tile. */
  uprightPitchUnits: TILE.widthUnits + TILE.gapUnits,
  /** Advance past a sideways (called) meld tile. */
  sidewaysPitchUnits: TILE.heightUnits + TILE.gapUnits,
  /** The gap a sideways slot is set out from its neighbour by. */
  slotGapUnits: TILE.gapUnits,
  /** Tangential start of the row, clear of the drawn tile (5.58 + 0.375). */
  rowStartUnits: 6.1,
  /** Centre-line radius of the first meld row, at the hand's radius. */
  rowRadiusUnits: HAND.backRadiusUnits,
  /** Radius step for a second/third meld row (a 28 mm tile plus clearance). */
  rowPitchUnits: 1.05,
  /** Meld rows before a row has to keep growing along its own length. */
  rowCount: 3,
  /** Tangential limit of one row: the mat edge (12.5) less 0.1 units. */
  maxRowUnits: 12.4,
} as const;

/**
 * The committed whole-table camera rig: 75 mm on a 36 mm gauge, pitched 50°
 * down, centred on X = 0 at 76 units behind the south edge and aimed 0.35 units
 * above the felt. Blender's Shift Y is measured against the sensor width and
 * raises the image when negative; the 3D rig reproduces that as a projection
 * offset rather than by pitching further down.
 *
 * `distanceUnits` solves the 1920 x 1080 reference frame; the renderer's aspect
 * fit (3D-02) keeps the mat and the human hand inside a safe area at every
 * aspect in {@link CAMERA.supportedAspects}, using {@link CAMERA.portraitPitchDeg}
 * for the portrait preset so the table fills the width.
 */
export const CAMERA = {
  mode: 'perspective',
  lensMm: 75,
  sensorWidthMm: 36,
  sensorFit: 'horizontal',
  pitchDeg: 50,
  distanceUnits: 76,
  /** Aim point in 3D world space; the reference's (0, 0, 0.35) Blender Z-up. */
  targetUnits: [0, 0.35, 0],
  shiftX: 0,
  shiftY: -0.02,
  clipStartUnits: 1,
  clipEndUnits: 600,
  /** The portrait preset's steeper pitch (plan §2.4). */
  portraitPitchDeg: 62,
  /** Aspects narrower than this use {@link CAMERA.portraitPitchDeg}. */
  portraitBelowAspect: 1,
  /** The reference frame whose relative margins every other aspect preserves. */
  framingAspect: 16 / 9,
  /** The safe-area margin the framing solver must keep at every aspect. */
  safeAreaMargin: 0.02,
  /** The hand's projected long axis, as a fraction of the frame height. */
  handLongAxisMinViewportFraction: 0.05,
  /** Every aspect the framing solver must keep inside the safe area. */
  supportedAspects: [
    21 / 9,
    16 / 9,
    3 / 2,
    4 / 3,
    1,
    3 / 4,
    9 / 16,
  ],
} as const;

/**
 * The one fixed key light (plan §2.6): the 2.5D rig's authored key at azimuth
 * 315°, elevation 55°, so highlights land top-left in both views. The direction
 * is a unit vector **from the surface toward the light** in 3D world space,
 * i.e. `normalize(-0.406, 0.819, 0.406)`.
 */
export const LIGHT = {
  azimuthDeg: 315,
  elevationDeg: 55,
  keyDirection: [-0.40591213, 0.818822744, 0.40591213],
  /** Colour of the authored key; the fills are cool and very low (3D-05). */
  keyHex: '#fff7ea',
} as const;
