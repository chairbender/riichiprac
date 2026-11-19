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
 * The committed tile body, in world units.
 *
 * The body and bevel are `shell-spec.json`'s values, so the 3D tile cannot
 * drift from the shipped 2.5D shell. The face plate is the carved relief's
 * 17.92 x 24.92 mm cell (0.64 x 0.89 units), inset by the 0.055-unit bevel.
 *
 * **There is no groove constant.** Every row pitch in this module is derived
 * from a body extent, so two tiles in a row meet exactly. The 2.5D reference
 * spaces its shells by a 0.2-0.3 mm groove; in 3D that slot is a hole the eye can
 * see through (the wall ring's corners were 1.1 mm open), so the 3D chain closes
 * it instead: see `gaps.ts` and the layout gate's gap table. What remains between
 * two touching tiles is their own bevels' shallow V, which is geometry, not a
 * gap.
 */
export const TILE = {
  widthUnits: TILE_MM.width / UNIT_MM,
  heightUnits: TILE_MM.height / UNIT_MM,
  thicknessUnits: TILE_MM.thickness / UNIT_MM,
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
 * The real 1000-point stick, in millimetres (user revision 2026-11-19):
 * 65 mm long, 7 mm wide and 3.5 mm thick, made of polystyrene resin. A common
 * commercial tenbo is 69 x 7 x 3 mm; the user's 65 x 7 x 3.5 is the model's
 * spec. Its longitudinal edges carry a 0.4 mm round-over (rendered in
 * `three/sticks.ts`).
 */
export const STICK_MM = {
  length: 65,
  width: 7,
  thickness: 3.5,
} as const;

/**
 * A point stick (1000 points) on the compass plate.
 *
 * The sticks are table furniture, not tiles: the layout never merges them into
 * the tile list and the collision gate skips them. 3D-09 draws **one stick per
 * declarer**, on that seat's side of the compass, lengthways along its edge
 * (the same place `PhysicalTable` puts a seat's stick). The 1000-point pot
 * (`compass.riichiSticks`) is not drawn on the 3D table: it stays in the table
 * information drawer, so the two never read as the same thing.
 *
 * Since the plate extends to the discards ({@link COMPASS_PLATE}), the sticks
 * stand on its top face rather than on the felt; `layoutBoard` places their
 * centres at `COMPASS_PLATE.topUnits + heightUnits / 2`. They sit **inboard of
 * the score row** — the user's third revision (2026-11-19): "the sticks should
 * go above the number (closer to the center) as there is a nice space there on
 * all sides" — in the clear band between the number row and the round/tiles-left
 * group.
 */
export const STICK = {
  lengthUnits: STICK_MM.length / UNIT_MM,
  widthUnits: STICK_MM.width / UNIT_MM,
  heightUnits: STICK_MM.thickness / UNIT_MM,
  /**
   * Centre-line distance from the table centre, on the declarer's side.
   *
   * At 65 mm the bar is 2.32 units long, so a ring of four at the old 0.95
   * would cross its neighbours (each half-length is 1.16). 1.35 is the first
   * radius that clears them: the perpendicular bar's inner face is 1.225, and
   * the strip left by the score rows (which sit against the plate's outer
   * edge, ~1.95 out) leaves a 0.2-unit gap on the other side.
   */
  radiusUnits: 1.35,
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
 * The wall: four runs of 17 stacks, two face-down tiles high, on a ring. Every
 * run is missing its top tile at the draw end (slot 16), as the committed
 * reference draws it. The wall is decorative: the engine publishes
 * `tiles_remaining`, not per-slot occupancy, so it is never depleted
 * (§9 R6 of the plan).
 *
 * A wall tile's snapshot slot is
 * `run * slotsPerRun + stack * tiers + tier`, with tiers 0 (bottom) and 1 (top).
 * Run `n` is the run in front of absolute seat `n`, so the far wall is
 * `(humanSeat + 2) % 4`. The draw-end top positions are absent, so a full
 * snapshot wall has {@link WALL.tileCount} tiles and no gaps in the slot
 * meanings it does use. The wall is decorative; board layout is free to use the
 * constants for a symmetric ring.
 *
 * The ring is **not** four identical rotations: the two runs at the human's own
 * edge and the far edge sit at {@link WALL.endRunRadiusUnits} so their outer
 * faces are flush with the side runs' end tiles (see that constant). The side
 * runs stay at {@link WALL.radiusUnits}; `boardLayout.wallRunRadius` is the one
 * place that decides which is which.
 */
const WALL_RUNS = 4;
const WALL_STACKS_PER_RUN = 17;
const WALL_TIERS = 2;
const WALL_DRAW_END_SLOT = 16;
const WALL_DRAW_END_TIERS = 1;

/**
 * A run's tangential half-length: the outer edge of its end tile.
 *
 * The end stack's centre is `(stacks - 1) / 2` pitches from the run's centre
 * line, and half a tile width beyond that is the tile's outer edge. Because the
 * stack pitch is exactly one tile width, consecutive runs' end tiles meet here
 * with no slot (see {@link WALL.radiusUnits}).
 */
const WALL_RUN_HALF_LENGTH_UNITS =
  ((WALL_STACKS_PER_RUN - 1) / 2) * TILE.widthUnits + TILE.widthUnits / 2;

export const WALL = {
  runs: WALL_RUNS,
  stacksPerRun: WALL_STACKS_PER_RUN,
  tiers: WALL_TIERS,
  /**
   * Ring radius from the table centre to a **side** run's tile centre line.
   *
   * Derived, not authored: a side run's inner face must land exactly on an end
   * run's end tile's end face, so the four runs close the square with no corner
   * slot. A side tile is `tileHeight` long across the radial axis, so its inner
   * face is `radius - tileHeight / 2`; setting that equal to
   * `runHalfLengthUnits` gives this value. (It was the literal 7 while the
   * pitches carried a 0.3 mm groove, which left a 1.1 mm slot at every corner —
   * the defect 3D-20 exists for.)
   */
  radiusUnits: WALL_RUN_HALF_LENGTH_UNITS + TILE.heightUnits / 2,
  /** A run's tangential half-length: the outer edge of its end tile. */
  runHalfLengthUnits: WALL_RUN_HALF_LENGTH_UNITS,
  /**
   * Centre-line radius of the **front and back** runs (the ones at the human's
   * own edge and the far edge), inset so their outer face is flush with a side
   * run's end tile.
   *
   * A wall tile lies with its 28 mm long axis pointing radially, so a run's
   * outer face is `radius + tileHeight / 2`. Leaving all four runs on one ring
   * makes the front/back runs stick out past the side runs' ends by
   * `radiusUnits + tileHeight / 2 - runHalfLengthUnits` (~29 mm), and that
   * protrusion is exactly the board's vertical (front-to-back) extent on
   * screen. Insetting them squares the ring's outer corners and buys the camera
   * that much more room (board handoff, 2026-11-18). With the pitches closed this
   * is also what makes the ring watertight: the end run's outer face and a side
   * run's inner face are the same plane, and the end tiles overlap along the run
   * by three quarters of a tile, so the corner is a shared edge, not a slot.
   */
  endRunRadiusUnits: WALL_RUN_HALF_LENGTH_UNITS - TILE.heightUnits / 2,
  /** One stack pitch: exactly one tile width, so stacks touch. */
  stackPitchUnits: TILE.widthUnits,
  /** The second tier's rise: exactly one tile thickness, so the tiers touch. */
  tierStepUnits: TILE.thicknessUnits,
  /** Centre-to-centre length of one 17-stack run. */
  runSpanUnits: WALL_STACKS_PER_RUN * TILE.widthUnits,
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
 * The nearest pond row's centre-line radius. The two further rows are one tile
 * height inside it each, so the three rows touch.
 */
const POND_NEAREST_ROW_RADIUS_UNITS = 4.81;

/**
 * One seat's discard pond: 3 rows of 6, filled from the far row toward the
 * player, plus four overflow anchors that extend the nearest row. Rows are
 * listed nearest-to-player first, matching the reference's radii; the first
 * chronological discard therefore lands in row 2, the last row listed.
 */
export const POND = {
  columns: 6,
  rows: 3,
  /** One column pitch: exactly one tile width, so a row's discards touch. */
  columnPitchUnits: TILE.widthUnits,
  /** A turned tile is set out from its neighbour by no gap at all. */
  columnGapUnits: 0,
  /** One row pitch: exactly one tile height, so stacked rows touch. */
  rowPitchUnits: TILE.heightUnits,
  /** Distance from table centre to each row's centre line, nearest first. */
  rowRadiiUnits: [
    POND_NEAREST_ROW_RADIUS_UNITS,
    POND_NEAREST_ROW_RADIUS_UNITS - TILE.heightUnits,
    POND_NEAREST_ROW_RADIUS_UNITS - 2 * TILE.heightUnits,
  ],
  /** Half of a 6-column row (2.5 pitches), measured from the seat's centre line. */
  columnCentreOffsetUnits: 2.5 * TILE.widthUnits,
  /** Extra anchors on the nearest row, at columns 6..9. */
  overflowColumns: 4,
  /** Which row the overflow cells extend: the nearest row, index into rowRadiiUnits. */
  overflowRow: 0,
  /**
   * A turned (riichi) discard advances the row by its long axis: exactly one
   * tile height, so the next discard touches it.
   */
  sidewaysPitchUnits: TILE.heightUnits,
  /** 18 pond cells plus the four overflow anchors. */
  capacity: 18 + 4,
} as const;

/**
 * The physical compass square (3D-09, user revision 2026-11-19).
 *
 * The user asked for the square to "extend out so it's touching the top row of
 * discards for each player": the plate's half-width is therefore the innermost
 * pond row's **inner edge** (`rowRadiiUnits[rows - 1]` is the row nearest the
 * table centre; a lying tile's radial half-extent is half its long axis). A
 * 0.008-unit gap keeps it touching without interpenetrating, which the tile
 * collision gate would otherwise flag.
 *
 * The numbers and wind glyphs are DOM over this plate, so the DOM box grows
 * with it; only the plate itself is 3D.
 */
const COMPASS_PLATE_GAP_UNITS = 0.008;
const COMPASS_PLATE_BEVEL_UNITS = 0.015;
const COMPASS_PLATE_THICKNESS_UNITS = 0.08;
/** The innermost pond row's edge, which the plate's chamfer must not cross. */
const POND_INNER_EDGE_UNITS =
  POND.rowRadiiUnits[POND.rows - 1] - TILE.heightUnits / 2;

export const COMPASS_PLATE = {
  /**
   * Exactly spans the clear middle: the innermost pond row on all four sides.
   * The extrusion's chamfer grows the footprint by `bevelUnits`, so the nominal
   * square is inset by that much, leaving a 4 µm-scale hair of felt between the
   * plate and the first discard (which is what "touching" means without the
   * collision gate seeing an overlap).
   */
  sizeUnits:
    2 * (POND_INNER_EDGE_UNITS - COMPASS_PLATE_BEVEL_UNITS) -
    COMPASS_PLATE_GAP_UNITS,
  /** Rounded corners, so it reads as a finished panel rather than a cut slab. */
  cornerRadiusUnits: 0.28,
  /** 2.24 mm proud of the felt: an inlay, not a tray. */
  thicknessUnits: COMPASS_PLATE_THICKNESS_UNITS,
  /** The small chamfer on both faces. */
  bevelUnits: COMPASS_PLATE_BEVEL_UNITS,
  /** The top face's height: the slab plus both chamfers. Sticks rest on this. */
  topUnits: COMPASS_PLATE_THICKNESS_UNITS + 2 * COMPASS_PLATE_BEVEL_UNITS,
  /** Lacquer face: the 2.5D compass panel's colour (`#171c24`), a shade deeper. */
  topColor: '#151b23',
  roughness: 0.46,
  metalness: 0,
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
/** The felt between a side wall run's outer face and a hand's front edge. */
const HAND_WALL_GAP_UNITS = 0.85;

/**
 * The tsumogiri gap between the concealed row and the drawn tile: 7.35 mm.
 *
 * This one is deliberate, not a groove: the drawn tile is *supposed* to read as
 * separate, and the felt shows between it and the row (the layout gate lists it
 * as an intentional gap). 0.2625 x 28 = 7.35 mm.
 */
const HAND_DRAW_GAP_UNITS = 0.2625;

export const HAND = {
  concealedCount: 13,
  /** One hand-row pitch: exactly one tile width, so the row is closed. */
  pitchUnits: TILE.widthUnits,
  /** The intentional tsumogiri gap between the hand row and the drawn tile. */
  drawGapUnits: 0.2625,
  /**
   * The drawn tile's centre offset from the seat's centre line: six pitches plus
   * half a tile to the row's right edge, the tsumogiri gap, then half a tile.
   */
  drawOffsetUnits:
    6 * TILE.widthUnits + TILE.widthUnits + HAND_DRAW_GAP_UNITS,
  /**
   * Gap from a wall run's **outer face** to the hand's front edge: ~24 mm.
   *
   * The binding wall for a left/right player is a **side** run, which occupies
   * the band `radius ± tileHeight / 2` right beside that player's hand, so their
   * hand's front edge is `WALL.radiusUnits + tileHeight / 2 + this gap` — the
   * geometric floor, because the side runs cannot be inset (a 17-stack run
   * already spans its whole side of the ring, so a smaller square would overlap
   * at the corners). See {@link HAND.endSeatRadiusUnits} for the near/far hands,
   * which face the inset end runs and sit a tile thickness closer.
   */
  wallGapUnits: 0.85,
  /**
   * Distance from table centre to a **left/right** player's standing-hand back
   * edge: the side run's outer face plus `wallGapUnits`.
   *
   * The hand's front edge (its nearest point: the tile stands on its far bottom
   * edge and leans back toward the table centre) sits 24 mm in front of the side
   * run it is next to. Melds of that seat share it.
   */
  backRadiusUnits:
    WALL.radiusUnits + TILE.heightUnits / 2 + HAND_WALL_GAP_UNITS,
  /**
   * Distance from table centre to the **human's** and the **across** player's
   * standing-hand back edge: one tile thickness closer to the wall than
   * {@link HAND.backRadiusUnits} (board handoff, 2026-11-18).
   *
   * Those two seats face the inset end runs, not the side runs, so there is a
   * tile thickness of slack in front of them; the handoff asked for exactly that
   * much and for the camera to use the freed depth. It leaves 36 mm of felt
   * between the near wall's outer face and the hand (an equal-*gap* rule would
   * give 24 mm, i.e. `WALL.endRunRadiusUnits + tileHeight / 2 + wallGapUnits`
   * = 7.31, if that is ever wanted instead).
   */
  endSeatRadiusUnits:
    WALL.radiusUnits + TILE.heightUnits / 2 + HAND_WALL_GAP_UNITS - TILE.thicknessUnits,
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
 * the next meld starts a row one pitch **toward the player** — away from the wall
 * ring — so a four-meld hand never leaves the mat and never reaches into the
 * wall; the hand now sits at 8.35, so stepping inward would collide.
 */
/** The felt between the drawn tile's right edge and the meld row: 4.2 mm. */
const MELD_ROW_CLEARANCE_UNITS = 0.15;

/**
 * The felt between two meld rows: 2.8 mm.
 *
 * A meld's own tiles touch (they are one slab), but two *different* melds sit on
 * separate rows with visible felt between them — a deliberate separation, wide
 * enough that it never reads as a slot the camera could look through (the layout
 * gate's slot threshold is 1.4 mm).
 */
const MELD_ROW_GAP_UNITS = 0.1;

export const MELD = {
  /** A full row's nominal slots: two upright, the called tile, the kan extension. */
  slots: 4,
  /** Advance past an upright meld tile: exactly its width. */
  uprightPitchUnits: TILE.widthUnits,
  /** Advance past a sideways (called) meld tile: exactly its height. */
  sidewaysPitchUnits: TILE.heightUnits,
  /** Meld tiles touch: a called meld is one slab, as in a real hand. */
  slotGapUnits: 0,
  /**
   * Tangential start of the row: the drawn tile's right edge plus
   * {@link MELD.rowClearanceUnits}, so the row never grazes the draw.
   */
  rowStartUnits: HAND.drawOffsetUnits + TILE.widthUnits / 2 + MELD_ROW_CLEARANCE_UNITS,
  /** The felt between the drawn tile and the meld row: 4.2 mm. */
  rowClearanceUnits: 0.15,
  /**
   * Centre-line radius of the first meld row, at a **left/right** seat's hand
   * radius. The near/far seats' melds use their own hand radius
   * (`HAND.endSeatRadiusUnits`); `boardLayout.handRadius` is the rule.
   */
  rowRadiusUnits: HAND.backRadiusUnits,
  /** Radius step for a second/third meld row: a tile height plus 2.8 mm felt. */
  rowPitchUnits: TILE.heightUnits + MELD_ROW_GAP_UNITS,
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
