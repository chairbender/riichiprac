/**
 * Shared contracts for the opt-in 3D table renderer (3D-01).
 *
 * This module is the only coupling between the app's serialized Rust state, the
 * snapshot adapter and the renderer, and it owns the 3D chain's face
 * vocabulary. It deliberately does **not** import anything from
 * `frontend/src/table/*`: the parallel 2.5D pipeline owns its own face ids, and
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
  /** 13 - 3 * open melds tiles, in the engine's hand order (not sorted). */
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
export type ReliefStatus = 'committed' | 'fallback';

/** Query-selectable debug views of the carved face shader. */
export type DebugMode =
  | 'albedo'
  | 'height'
  | 'normal'
  | 'steps'
  | 'pom-off'
  | 'wireframe';

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
  readonly reducedMotion: boolean;
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
  readonly atlasBytes: number;
  /** Which relief source the scene draws; absent before assets load (3D-03). */
  readonly relief?: ReliefStatus;
  readonly frameMsP50: number;
  readonly frameMsP95: number;
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
  /** v1: a no-op, unit-tested ahead of a live/replay source. */
  playEvents(events: readonly RendererEvent[]): void;
  measure(): RendererStats;
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
