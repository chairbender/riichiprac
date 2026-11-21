/**
 * Shared contracts for the opt-in 3D table renderer (3D-01).
 *
 * This module is the only coupling between the app's serialized Rust state, the
 * snapshot adapter and the renderer, and it owns the 3D chain's face
 * vocabulary. It deliberately does **not** import anything from
 * `frontend/src/table/*`: the retired 2.5D pipeline owned its own face ids, and
 * the two chains must not be able to break each other by editing a type. The
 * relief manifest's own `faces` keys are the runtime cross-check (3D-03): every
 * id below must resolve to a baked cell, and a manifest that disagrees is a
 * hard load error.
 *
 * Shapes follow §4 of `3d_renderer_implementation_plan.md`; the comments add
 * the invariants the later units depend on. The module is pure data and types:
 * no DOM, no three.js, no game rules.
 */

/**
 * One tile art id: the 34 standard faces, the three red fives and the
 * assetless blank used for face-down tiles.
 */
export type TileFaceId =
  | `${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}${'m' | 'p' | 's'}`
  | '5mr'
  | '5pr'
  | '5sr'
  | '1z'
  | '2z'
  | '3z'
  | '4z'
  | '5z'
  | '6z'
  | '7z'
  | 'blank';

/** Seat index around the table, in turn order. Seat 0 need not be the human. */
export type Seat = 0 | 1 | 2 | 3;

/** Where a snapshot tile sits on the table. */
export type Zone = 'hand' | 'draw' | 'river' | 'meld' | 'wall' | 'dora';

/** One tile the renderer draws, with the flags the layout needs. */
export interface SnapshotTile {
  readonly face: TileFaceId;
  readonly zone: Zone;
  /**
   * Zone-local index: hand slot, the draw's hand slot, river cell (oldest
   * first), position within its own meld, or wall slot
   * (`run * WALL.slotsPerRun + stack * WALL.tiers + tier`; see
   * `layoutConstants.ts`).
   */
  readonly slot: number;
  readonly faceUp: boolean;
  /** Turned 90° about its own vertical axis: riichi declaration, called meld tile. */
  readonly sideways: boolean;
  /** Newest discard of the seat a call/ron offer names. */
  readonly highlighted?: boolean;
  /** Tsumogiri discard (thrown straight off the draw). */
  readonly dimmed?: boolean;
}

/** One open or closed meld, in call order. */
export interface SnapshotMeld {
  readonly kind: 'Chi' | 'Pon' | 'Kan' | 'Ankan';
  /** Meld tiles in their own order; `slot` is the position within the meld. */
  readonly tiles: readonly SnapshotTile[];
  /**
   * Absolute seat the called tile came from, for the sideways call-tile
   * placement; null for a closed kan (and for malformed source data).
   */
  readonly calledFrom: Seat | null;
}

/** One player's visible table area, indexed by absolute seat. */
export interface SnapshotSeat {
  readonly seat: Seat;
  readonly wind: 'East' | 'South' | 'West' | 'North';
  readonly score: number;
  /**
   * 13 - 3 * open melds tiles, in display order: manzu, pinzu, souzu, then
   * honors by rank (the order the dock and the projected buttons show). The
   * engine's own order is not carried, so every view of the hand agrees.
   */
  readonly concealed: readonly SnapshotTile[];
  /** The active draw, occupying hand slot `concealed.length`, or null. */
  readonly draw: SnapshotTile | null;
  readonly melds: readonly SnapshotMeld[];
  /** Discards, oldest first: up to 18 in the 3 x 6 pond plus 4 overflow anchors. */
  readonly river: readonly SnapshotTile[];
  readonly riichi: boolean;
  /** River index of the declaration tile, or null when not declared / unknown. */
  readonly riichiDiscardIndex: number | null;
}

/** The newest discard a call, ron or kan offer is aimed at. */
export interface HighlightDiscard {
  readonly seat: Seat;
  readonly index: number;
}

/**
 * The complete, immutable picture one renderer draws.
 *
 * It carries every board fact the top-down view renders plus the
 * answered/highlight flags, and deliberately no lesson text, answer, rationale
 * or call offer: those stay in the DOM. The face vocabulary is the 3D chain's
 * own (see {@link TileFaceId}).
 */
export interface TableSnapshot {
  /**
   * Incremented by the host on every new `GameState`. A new revision is a cut,
   * never a move: the renderer must not animate a diff between two positions.
   */
  readonly revision: number;
  readonly humanSeat: Seat;
  readonly seats: readonly [
    SnapshotSeat,
    SnapshotSeat,
    SnapshotSeat,
    SnapshotSeat,
  ];
  /**
   * Face-down decorative wall. Fixed count, full ring minus the committed draw
   * end; the engine publishes no per-slot occupancy, so it is never depleted.
   * A tile's `slot` is
   * `run * WALL.slotsPerRun + stack * WALL.tiers + tier`; run `n` is the run in
   * front of absolute seat `n`, so the far wall is `(humanSeat + 2) % 4`.
   */
  readonly wall: readonly SnapshotTile[];
  /**
   * Revealed dora indicators, face-up on the far wall's dead-wall top tier.
   * `slot` is the indicator index; the layout places each one and omits the
   * decorative wall tile it covers, so the two lists never draw twice.
   */
  readonly dora: readonly SnapshotTile[];
  readonly compass: {
    readonly roundWind: 'East' | 'South' | 'West' | 'North';
    readonly handNumber: number;
    readonly honba: number;
    readonly riichiSticks: number;
    readonly tilesRemaining: number;
  };
  readonly highlightDiscard: HighlightDiscard | null;
  /** True once the hand is answered: input is locked in every view. */
  readonly locked: boolean;
}

/** Render quality tier. `compat` is the mobile/weak-GPU fallback (no POM). */
export type QualityTier = 'high' | 'balanced' | 'compat';

/**
 * Which relief art the scene draws (3D-03): the committed Task 4B atlases, or
 * the procedural neutral cell when they are missing or off-pin.
 */
export type ReliefStatus = 'relief3d' | 'fallback';

/** Query-selectable debug views of the carved face shader. */
export type DebugMode =
  | 'albedo'
  | 'height'
  | 'normal'
  | 'steps'
  /** The shader's own branch state per pixel: face-up / blue-body / plate zone. */
  | 'flags'
  /** The light-space self-shadow's key visibility (3D-10). */
  | 'shadow'
  | 'pom-off'
  /** The self-shadow march switched off, for a live A/B against `pom-off`. */
  | 'shadow-off'
  | 'wireframe'
  /** The 3D-05 hero view: the carved tile in four real board attitudes. */
  | 'hero';

/** What a WebGL2 probe can learn without keeping a context alive. */
export interface RendererCapabilities {
  readonly webgl2: boolean;
  readonly maxTextureSize: number;
  readonly devicePixelRatio: number;
  /** Reason the 3D view must not be offered, or null. */
  readonly unavailable: string | null;
}

/** Per-mount renderer options resolved by the host. */
export interface RendererOptions {
  readonly tier: QualityTier;
  readonly debug: DebugMode | null;
  readonly perfHud: boolean;
  /**
   * `prefers-reduced-motion: reduce`. Suppresses the time-based deal-in only;
   * the hover/focus lift is a discrete pose change and still applies (user
   * decision 2026-11-21).
   */
  readonly reducedMotion: boolean;
  /**
   * Whether the WebGL2 context is created with 4× MSAA (3D-20).
   *
   * Resolved by `capabilities.antiAliasFor(tier)`: on above the `compat` tier,
   * off at `compat`. Plan §2.6 originally committed `antialias: false`; 3D-20
   * measured the bevel/plateau edges and reversed that for the higher tiers —
   * see the plan's §2.6 note and the seam gate's numbers.
   */
  readonly antialias: boolean;
}

/** Reserved for a future live/replay source. Not called in v1. */
export type RendererEvent =
  | { kind: 'draw'; seat: Seat; face: TileFaceId }
  | { kind: 'discard'; seat: Seat; face: TileFaceId; riichi: boolean }
  | { kind: 'meld'; seat: Seat; meld: SnapshotMeld }
  | { kind: 'flip'; face: TileFaceId };

/** Numbers the perf HUD and budget gate read (3D-13). */
export interface RendererStats {
  readonly tier: QualityTier;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly instances: number;
  /** The ratio the backing store is actually rendered at, after the tier cap (3D-13). */
  readonly devicePixelRatio: number;
  /** The drawing buffer's pixel area: CSS area x ratio squared (3D-13). */
  readonly backingStorePixels: number;
  readonly atlasBytes: number;
  /** Which relief source the scene draws; absent before assets load (3D-03). */
  readonly relief?: ReliefStatus;
  /**
   * How the committed atlases' SHA-256 pins were verified: `webcrypto` normally,
   * `javascript` on a non-secure origin (no `crypto.subtle`), null on the
   * procedural fallback. 3D-20 follow-up.
   */
  readonly reliefVerification?: 'webcrypto' | 'javascript' | null;
  /** The carved face's live depth-march step count (0 = un-carved path, 3D-05). */
  readonly pomSteps?: number;
  /** The carved face's live self-shadow march step count (0 = off, 3D-10). */
  readonly shadowSteps?: number;
  readonly frameMsP50: number;
  readonly frameMsP95: number;
  /** How many frame durations the percentiles are computed over (3D-13). */
  readonly frameSamples: number;
}

/** One interactive tile's projected CSS rect, produced by `hitRects()`. */
export interface HitRect {
  readonly seat: Seat;
  readonly zone: 'hand' | 'draw';
  readonly slot: number;
  readonly face: TileFaceId;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A lock-independent projection rect, in CSS px, relative to the stage (3D-H2).
 *
 * The HUD anchors to the hand without caring whether the hand is still
 * interactive: after an answer the buttons are gone but the result card still
 * needs the band they occupied, so this is computed by the same
 * `frameForAspect` + hit-test code path as {@link HitRect} with the lock gate
 * removed (`three/hitTest.ts`'s `handBandRect`). A drift test asserts that while
 * unanswered it is exactly the union of `hitRects()`.
 */
export interface BandRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The identity of one interactive tile, independent of its projection. */
export interface HandTileRef {
  readonly seat: Seat;
  readonly zone: 'hand' | 'draw';
  readonly slot: number;
}

/**
 * The projected compass square (3D-09), in CSS pixels of the full-screen stage.
 *
 * The square is the physical plate laid on the felt, sized to touch the
 * innermost discard row on all four sides. `left/top/width/height` are the
 * bounding box of its four projected corners (the perspective outline is a
 * trapezoid, so a DOM box can only cover it); `centreX/centreY` is that box's
 * centre, which is where the DOM compass sits. The plate is a picture, so the
 * numbers over it are DOM, never 3D text (plan §2.7).
 */
export interface CompassRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly centreX: number;
  readonly centreY: number;
}

/**
 * The stable key that joins a {@link HitRect} to the hand buttons the overlay
 * renders (3D-08). One function, used by both sides, so a rect can never be
 * matched to the wrong tile by a string built twice.
 */
export function hitRectKey(ref: HandTileRef): string {
  return `${ref.seat}:${ref.zone}:${ref.slot}`;
}

/**
 * One probe colour the hero view read back, 8-bit sRGB, with the rule it was
 * checked against (3D-05).
 */
export interface HeroProbeNumber {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly rgb: readonly [number, number, number];
  readonly hex: string;
  /** `R - max(G, B)` of the block's reddest pixel (paint presence). */
  readonly redness: number;
  readonly targetHex: string | null;
  /** CIE76 ΔE to the committed colour, or null for a presence probe. */
  readonly deltaE: number | null;
  readonly tolerance: number | null;
  readonly pass: boolean;
  readonly detail: string | null;
}

/** One hero slot's incidence angle and parallax displacement at this frame. */
export interface HeroParallaxNumber {
  readonly slot: string;
  readonly label: string;
  readonly angleDeg: number;
  readonly texels: number;
  readonly clamped: boolean;
}

/**
 * The hero view's report (3D-05), as the debug HUD renders it. Every field is a
 * measured number: the probe read-backs, the incidence angles, the step count
 * and the carve depth. `debug=hero` only.
 */
export interface HeroReport {
  readonly relief: ReliefStatus;
  readonly tier: QualityTier;
  readonly pomSteps: number;
  readonly carveDepthMm: number;
  /** The live depth-march displacement scale (1 = the full 0.55 mm groove). */
  readonly heightScale: number;
  readonly maxParallaxTexels: number;
  readonly aspect: number;
  readonly parallax: readonly HeroParallaxNumber[];
  readonly probes: readonly HeroProbeNumber[];
  readonly allProbesPass: boolean;
  /** The same probes with the depth march switched off (POM_STEPS = 0). */
  readonly pomOff: {
    readonly probes: readonly HeroProbeNumber[];
    readonly allProbesPass: boolean;
  } | null;
}

/** One exported hero PNG: a PNG data URL plus the pixels it covers. */
export interface HeroCapture {
  /** `hero-<slot>-pom-<on|off>.png`. */
  readonly name: string;
  readonly pngDataUrl: string;
  readonly width: number;
  readonly height: number;
}

/** One dose-response reading: a carve offset at a view or light angle. */
export interface CarveReachNumber {
  /** `parallax` or `shadow`, plus the slot/zone it came from. */
  readonly id: string;
  readonly label: string;
  readonly angleDeg: number;
  /** The offset/march reach in atlas texels. */
  readonly texels: number;
  /** True when the shader's clamp shortened it. */
  readonly clamped: boolean;
}

/**
 * The carve calibration's numbers (3D-10), as the debug HUD prints them.
 *
 * All of it is measured from the live material and the live board: the two
 * step counts (which are the tier table's values and therefore the acceptance
 * criterion's numbers), the displacement scale and the two clamped worst cases
 * that the gates bound — the POM parallax and the self-shadow march reach.
 */
export interface CarveReport {
  readonly tier: QualityTier;
  readonly debug: DebugMode | null;
  readonly pomSteps: number;
  readonly shadowSteps: number;
  readonly shadowStrength: number;
  readonly shadowBias: number;
  readonly shadowSoftness: number;
  readonly carveDepthMm: number;
  readonly heightScale: number;
  readonly maxParallaxTexels: number;
  readonly shadowMaxTexels: number;
  /** The largest parallax over the face-up tiles (or hero slots). */
  readonly parallax: CarveReachNumber;
  /** The largest self-shadow reach over the same tiles. */
  readonly shadow: CarveReachNumber;
}

/** One exported carve-calibration sheet (3D-10): a 2 x 2 state matrix. */
export interface CarveCapture {
  /** `carve-<view>-states.png`. */
  readonly name: string;
  readonly pngDataUrl: string;
  readonly width: number;
  readonly height: number;
}

/**
 * One inter-tile seam's measured numbers (3D-20).
 *
 * Every field is a pixel reading reduced to a number, never an impression: the
 * per-offset luma scanline across the groove, the adjacent face's luma, the
 * groove's brightest sample (with its RGB, which is what attributes the cause),
 * and the two figures the gate checks — `contrast` (does any groove pixel read
 * brighter than the face?) and `depth` (is it still a groove?).
 */
export interface SeamReadingNumber {
  /** The seam family: `hand-row`, `pond-row`, `wall-stack` or `wall-tier`. */
  readonly id: string;
  readonly aId: string;
  readonly bId: string;
  /** Pixels between the two face plateaus' edges. */
  readonly spanPx: number;
  /** The body-to-body separation, in tile units (0.0107 for a row groove). */
  readonly gapUnits: number;
  /** Median luma per sample offset, in step order (face, groove, face). */
  readonly luma: readonly number[];
  readonly offsetsPx: readonly number[];
  /** The two adjacent faces' median luma, and the darker of the two. */
  readonly faceALuma: number;
  readonly faceBLuma: number;
  readonly faceLuma: number;
  /** The groove's **core** (its middle third), where the bodies meet. */
  readonly coreMinLuma: number;
  readonly coreMaxLuma: number;
  readonly coreMeanLuma: number;
  /** The groove's outer thirds: the two lit bevels. */
  readonly rimMaxLuma: number;
  /** Every core column's offset, luma and colour (cause attribution). */
  readonly coreColumns: readonly {
    readonly offsetPx: number;
    readonly luma: number;
    readonly rgb: readonly [number, number, number];
  }[];
  /** The brightest core sample's 8-bit sRGB. */
  readonly brightestRgb: readonly [number, number, number];
  /** What that pixel's colour is: ivory body, felt, background or other. */
  readonly brightestClass: 'body' | 'felt' | 'background' | 'other';
  /** `faceLuma - coreMaxLuma`: informational (a bevel may be as bright as a face). */
  readonly contrast: number;
  /** `faceLuma - coreMeanLuma`: informational. */
  readonly depth: number;
  /** Core pixels that read as the felt or the clear colour: the defect. */
  readonly leakPixels: number;
  readonly pass: boolean;
  readonly detail: string | null;
}

/**
 * One silhouette's anti-aliasing reading (3D-20).
 *
 * `intermediates` is the number of scanline columns whose luma lies strictly
 * between the two surfaces: without MSAA a silhouette is a hard step and that
 * count is 0; with 4x MSAA the partial-coverage boundary pixel puts it at 1-2.
 * `maxStep` is the largest jump between adjacent columns, which is the edge's
 * aliasing in luma terms.
 */
export interface EdgeReadingNumber {
  readonly id: string;
  /** Pixels from inside the face to the felt outside the silhouette. */
  readonly spanPx: number;
  readonly luma: readonly number[];
  readonly offsetsPx: readonly number[];
  readonly lightLuma: number;
  readonly darkLuma: number;
  /** Mean columns per line whose value lies between the two surfaces. */
  readonly intermediates: number;
  /** Mean over lines of each line's largest one-pixel luma step. */
  readonly maxStep: number;
  /** The worst line's largest one-pixel step (a single unlucky line cannot hide). */
  readonly worstStep: number;
  /** How many parallel scan lines were averaged. */
  readonly lines: number;
  readonly pass: boolean;
}

/**
 * One surface family's bright-pixel tally from the glint probe (3D-20 follow-up).
 *
 * `bright` counts pixels at or above the measured luma threshold; `coverage` is
 * how many pixels the family covers, so a ratio is comparable across viewports.
 * A specular highlight that saturates belongs on a flat plate (where it is a
 * uniform sheen), never on the curved body band — that is what `pass` checks.
 */
export interface GlintBucket {
  readonly coverage: number;
  readonly bright: number;
}

/** Where a bright pixel was drawn, from the shader's own flags. */
export interface GlintReport {
  readonly widthPx: number;
  readonly heightPx: number;
  /** The luma at or above which a pixel counts as bright. */
  readonly threshold: number;
  /** Body fragments with the blue backing (wall bevels and side walls). */
  readonly blueBody: GlintBucket;
  /** Body fragments with the ivory body (the shells' 4.95 mm ivory band). */
  readonly ivoryBody: GlintBucket;
  /** Fragments on a carved face or a backing plate (`faceUp`). */
  readonly plate: GlintBucket;
  /**
   * True when the glint is confined to plate-like surfaces: the ivory body's
   * bright pixels are its own albedo (it is an ivory surface, so it may be
   * bright), and the blue body — whose albedo is dark — must not carry a
   * saturated rim.
   */
  readonly pass: boolean;
}

/** The seam probe's whole report (3D-20), as `Scene.seamReport()` returns it. */
export interface SeamReport {
  /** Whether the context was created with MSAA (3D-20's alias decision). */
  readonly antialias: boolean;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly drawCalls: number;
  readonly seams: readonly SeamReadingNumber[];
  readonly allSeamsPass: boolean;
  /** The anti-aliasing reading on the human hand's outer silhouette, or null. */
  readonly edge: EdgeReadingNumber | null;
}

/**
 * The hero view's ready/failed notifications, dispatched by the scene on the
 * canvas (3D-05). Strings live here so the host can listen without importing
 * the lazy three.js chunk.
 */
export const HERO_READY_EVENT = 'tile3d:hero-ready';
export const HERO_FAILED_EVENT = 'tile3d:hero-failed';

/**
 * Automatic quality changes (3D-11), dispatched by the scene on the canvas.
 *
 * `QUALITY_CHANGED_EVENT` fires once per automatic downgrade, with the new tier
 * and the frame-time EMA that caused it. `DEGRADED_EVENT` fires when even the
 * `compat` tier stayed above 33 ms for two seconds: it is the host's signal to
 * close the view, remember the reason for the session and show the notice. Both
 * carry {@link QualityChangeDetail}.
 *
 * Events rather than polling for the same reason as the ready/failed events:
 * the host must not import the lazy three chunk to learn what the scene decided.
 */
export const QUALITY_CHANGED_EVENT = 'tile3d:quality-changed';
export const DEGRADED_EVENT = 'tile3d:degraded';

/** The detail carried by {@link QUALITY_CHANGED_EVENT} and {@link DEGRADED_EVENT}. */
export interface QualityChangeDetail {
  /** The tier now in force (`DEGRADED_EVENT` always reports `compat`). */
  readonly tier: QualityTier;
  /** The rolling frame-time EMA in milliseconds when the decision was made. */
  readonly frameMsEma: number;
  /** Why the view changed: a one-tier downgrade, or the terminal degrade. */
  readonly kind: 'downgrade' | 'degrade';
  /** A human-readable reason, for the host's notice and the one-time log. */
  readonly reason: string;
}

/**
 * The board's ready/failed notifications (3D-07), on the same canvas and for the
 * same reason: the relief atlases load asynchronously, so the host learns when
 * the whole table is on screen (or why it is not) without polling `measure()`.
 */
export const BOARD_READY_EVENT = 'tile3d:board-ready';
export const BOARD_FAILED_EVENT = 'tile3d:board-failed';

/**
 * The renderer interface. It is synchronous by design: the host owns the async
 * module load, and a renderer that can queue animation is a renderer that can
 * drift from the DOM. `hitRects()` is pure (it never creates DOM); the overlay
 * renders the buttons.
 */
export interface TableRenderer {
  /** Idempotent, cheap (O(tiles)); call on every snapshot change. */
  syncState(snapshot: TableSnapshot): void;
  setSize(cssWidth: number, cssHeight: number, dpr: number): void;
  setQuality(tier: QualityTier): void;
  /** Pure projection of interactive tiles to CSS rects, for the DOM overlay. */
  hitRects(): readonly HitRect[];
  /**
   * Hand + draw interaction union with the same 44 px expansion, computed when
   * the hand is answered too (3D-H2).
   *
   * This is the HUD's hand anchor (3d_hud.md §7.1): after an answer every button
   * is gone, but the hand still occupies that band on screen and the result
   * card must sit clear of it. It comes from the same code path as
   * {@link hitRects}, so the anchor cannot drift from the buttons it describes.
   * Optional so a renderer without a hand simply has no hand panel.
   */
  handBandRect?(): BandRect | null;
  /**
   * The projected compass well, for the DOM compass overlay (3D-09). Like
   * `hitRects()` it is pure and never creates DOM; null before a board is laid
   * out. Optional so a renderer without a compass can simply ignore it.
   */
  compassRect?(): CompassRect | null;
  /**
   * Report which hand button the pointer/focus rests on, or null when none
   * (3D-08). The overlay calls it once per change; 3D-12 turns it into the
   * bounded lift. Optional because a renderer without motion simply ignores it,
   * and the DOM buttons never move for it.
   */
  setHoverTile?(tile: HandTileRef | null): void;
  /**
   * Reserved for a future live/replay source: v1 draws no tile motion and the
   * host never calls it (3D-12 pins that). The seam's tested math —
   * `draw`/`discard`/`meld`/`flip` waypoints and the damped-spring sample — is
   * `three/motion.ts`.
   */
  playEvents(events: readonly RendererEvent[]): void;
  measure(): RendererStats;
  /**
   * 3D-05's hero view only: the measured numbers for the debug HUD, or null
   * when the hero tiles are not mounted (or are still loading). Debug-only, so
   * it is optional on the interface.
   */
  heroReport?(): HeroReport | null;
  /**
   * 3D-05's hero view only: one PNG per slot with the carve on and off, for the
   * unit's user handoff. Debug-only, so it is optional on the interface.
   */
  heroCaptures?(): readonly HeroCapture[];
  /**
   * 3D-10's carve calibration numbers: the live step counts, the calibration
   * uniforms and the worst parallax/self-shadow reach, or null before a view is
   * mounted. Debug-only, so it is optional.
   */
  carveReport?(): CarveReport | null;
  /**
   * 3D-10's handoff export: labelled 4K sheets of the live view with the carve
   * on/off against the self-shadow on/off, for the user's calibration. Debug-only.
   */
  carveCaptures?(): readonly CarveCapture[];
  /**
   * 3D-20's seam probe: the measured numbers of four inter-tile grooves, or
   * null outside the board view. Debug-only, so it is optional.
   */
  seamReport?(): SeamReport | null;
  /**
   * 3D-20's glint probe: which surface family owns each bright pixel, read from
   * two draws of the same board (lit and `?debug=flags`). Debug-only, optional.
   */
  glintReport?(): GlintReport | null;
  dispose(): void;
}

const SUIT_ORDER = ['m', 'p', 's'] as const;
const RANK_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/** The 34 standard faces in atlas order: all man, all pin, all sou. */
const SUITED_FACE_IDS: readonly TileFaceId[] = SUIT_ORDER.flatMap((suit) =>
  RANK_ORDER.map((rank) => `${rank}${suit}` as TileFaceId),
);

/** Every face id the 3D chain knows, in the committed atlas order. */
export const TILE_FACE_IDS: readonly TileFaceId[] = [
  ...SUITED_FACE_IDS,
  '5mr',
  '5pr',
  '5sr',
  '1z',
  '2z',
  '3z',
  '4z',
  '5z',
  '6z',
  '7z',
  'blank',
];

/**
 * The 37 face ids with baked relief art (3D-03): every id above except
 * `blank`, which has no printed symbol and is never sampled on a face-down
 * tile. This list is the runtime vocabulary the committed relief manifest must
 * match exactly, in atlas order.
 */
export const BAKED_TILE_FACE_IDS: readonly TileFaceId[] = TILE_FACE_IDS.filter(
  (face) => face !== 'blank',
);

const FACE_ID_SET: ReadonlySet<string> = new Set(TILE_FACE_IDS);
const RED_FIVE_FACES: ReadonlySet<string> = new Set(['5mr', '5pr', '5sr']);

/** Narrow an arbitrary value to a {@link TileFaceId}. */
export function isTileFaceId(value: unknown): value is TileFaceId {
  return typeof value === 'string' && FACE_ID_SET.has(value);
}

/** True for the three aka-dora face ids. */
export function isRedFiveFace(face: TileFaceId): boolean {
  return RED_FIVE_FACES.has(face);
}

/**
 * Resolve an engine tile code (`1m` … `7z`, or `blank`) plus its red-five flag
 * to the 3D face id.
 *
 * An unknown code throws rather than silently rendering a blank tile: a typo in
 * the generator must fail loudly at the snapshot boundary, not at runtime.
 */
export function faceIdForTile(code: string, redFive = false): TileFaceId {
  if (code === 'blank' || code === '') return 'blank';
  if (redFive) {
    if (code === '5m' || code === '5p' || code === '5s') {
      return `${code}r` as TileFaceId;
    }
    throw new Error(`tile ${JSON.stringify(code)} cannot be a red five`);
  }
  if (!isTileFaceId(code)) {
    throw new Error(`unknown tile code ${JSON.stringify(code)}`);
  }
  return code;
}
