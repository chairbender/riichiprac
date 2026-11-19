/**
 * Parser and types for the committed Task 4A shadow manifests:
 * `frontend/public/table/shadows.json` and `ao_seams.json`.
 *
 * Task 4A took the cast shadows and the inter-tile bevel occlusion out of the
 * blank bodies, because the board changes every move: a river grows one tile at
 * a time, a wall breaks open, a hand tile lifts on hover. The runtime puts them
 * back from the live board state (Task 6A, `boardShadows.ts`):
 *
 *   - `shadow_mat_<bucket>.png` — the shadow one tile of that bucket casts onto
 *     the mat. Black ink, `alpha = 1 - shadowedLuma / litLuma`, so source-over
 *     black reproduces the measured darkening. Drawn at the tile's own anchor
 *     for every lying/hand/meld bucket, and at the stack's *bottom tier* anchor
 *     for the horizontal wall buckets (their representative is a top-tier tile
 *     whose shadow was re-rendered on the mat: `grounded`).
 *   - `shadow_wall_stack_<seat>.png` — the contact shadow an upper-tier wall
 *     tile throws onto the tile under it. One per seat: the measured
 *     `seatAgreement` worst case is 1.0 alpha, so the four are not
 *     interchangeable. Drawn at that stack's layer-0 anchor.
 *   - `ao_seam_{left,right,top,bottom}.png` — normalized-UV bevel crevice masks,
 *     square, one 35 %-black band along one edge. The whole image maps onto a
 *     tile's `faceQuad`; `left`/`top` are drawn untransformed and
 *     `right`/`bottom` are a half turn, which keeps each mask's fade on its own
 *     authored axis (0.10 of the short side along u, 0.075 of the long side
 *     along v).
 *
 * Coordinates are pixels of the `pixelRatio`-scaled 1920 × 1080 frame, exactly
 * like `blanks.json`: draw a sprite so its `pivot` lands on the tile's anchor
 * (`gridX/gridY`), so a blank and its mat shadow share one draw position.
 */
import type { BlankBucket } from './blankManifest';
import type { ShellStats } from './shellManifest';
import type { LayoutZone, PlacedTile } from './zoneLayout';

/** Which edge of a tile's face plate a crevice mask fades from. */
export type AoSeamSide = 'left' | 'right' | 'top' | 'bottom';

export const AO_SEAM_SIDES: readonly AoSeamSide[] = ['left', 'right', 'top', 'bottom'];

/** A point in the manifest's @2x frame pixels (`pivot`) or normalized (`anchor`). */
export interface ShadowPoint {
  readonly x: number;
  readonly y: number;
}

/** One mat-shadow sprite: the shadow a single tile of a bucket casts on the mat. */
export interface MatShadowRecord {
  readonly bucket: string;
  /** `flat`, `hand`, `wall_horizontal` or `wall_side`. */
  readonly family: string;
  /** The layout slot the sprite was baked from. */
  readonly representative: string;
  readonly slotCount: number;
  /** The blank whose pivot the sprite shares. */
  readonly blank: {
    readonly textureFile: string;
    readonly anchor: ShadowPoint;
    readonly pivot: ShadowPoint;
  };
  readonly textureFile: string;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly pivot: ShadowPoint;
  /**
   * Where the pivot lands in the reference frame. For `grounded` wall buckets
   * this is the stack's *bottom tier* anchor, not the representative's own.
   */
  readonly anchor: ShadowPoint;
  readonly grounded: boolean;
  readonly groundDropUnits: number;
  readonly alpha: {
    readonly peakAlpha: number;
    readonly meanAlpha: number;
    readonly supportPx: number;
  };
  readonly bytes: number;
}

/** One per-seat wall-stack decal: upper tier's contact shadow on the lower tile. */
export interface WallStackRecord {
  readonly seat: string;
  readonly layer0: string;
  readonly layer1: string;
  /** The blank bucket both tiers are drawn with. */
  readonly bucket: string;
  readonly textureFile: string;
  readonly width: number;
  readonly height: number;
  readonly pixelRatio: number;
  readonly pivot: ShadowPoint;
  /** The layer-0 anchor the decal is drawn at. */
  readonly anchor: ShadowPoint;
  readonly alpha: {
    readonly peakAlpha: number;
    readonly meanAlpha: number;
    readonly supportPx: number;
  };
}

export interface ShadowsManifest {
  readonly version: 1;
  readonly generatedBy: string;
  readonly task: string;
  /** The rig variant the set was baked with (`v13-shadow-darker`). */
  readonly variant: string;
  readonly pixelRatio: 2;
  readonly referenceResolution: { readonly width: number; readonly height: number };
  readonly frame: { readonly width: number; readonly height: number };
  /**
   * `multiply` with black ink. `alpha = 1 - shadowedLuma / litLuma`, so a
   * source-over black sprite darkens by `dest * (1 - alpha)`. The runtime
   * merges every mat shadow at MAX alpha (never straight-over) before it
   * composites once, so two overlapping penumbras darken no more than one.
   */
  readonly composite: { readonly model: string; readonly note: string };
  readonly coordinateSpace: string;
  readonly wallStack: {
    readonly canonical: string;
    readonly perSeat: boolean;
    readonly seatAgreement: {
      readonly worst: number;
      readonly maxAlphaDifference: Readonly<Record<string, number>>;
    };
    readonly seats: Readonly<Record<string, WallStackRecord>>;
  };
  /** Keyed by blank bucket name; exactly the 16 `blanks.json` buckets. */
  readonly matShadows: Readonly<Record<string, MatShadowRecord>>;
  readonly totals: {
    readonly matShadows: number;
    readonly wallStacks: number;
    readonly bytes: number;
  };
}

/** One crevice mask: a square image with a 35 %-black band along one edge. */
export interface AoSeamRecord {
  readonly edge: AoSeamSide;
  /** The face UV axis the fade runs along. */
  readonly axis: 'u' | 'v';
  /** Which end of that axis holds the band. */
  readonly side: 'low' | 'high';
  readonly textureFile: string;
  readonly width: number;
  readonly height: number;
  readonly channels: string;
  readonly ink: string;
  readonly profile: string;
  readonly fadeFractionOfAxis: number;
  readonly measured: {
    readonly edgeAlpha: number;
    readonly peakAlpha: number;
    readonly fadeAxisFraction: number;
    readonly fadeFractionOfTileWidth: number;
    readonly monotonic: boolean;
  };
}

export interface AoSeamsManifest {
  readonly version: 1;
  readonly generatedBy: string;
  readonly task: string;
  readonly peakAlpha: number;
  readonly resolution: { readonly width: number; readonly height: number };
  /** `(0,0)` is the face quad's top-left corner, `(1,1)` its bottom-right. */
  readonly coordinateSpace: string;
  /** The runtime contract: per occupied neighbour, at 50-70 % of the mask alpha. */
  readonly runtime: string;
  readonly seams: Readonly<Record<AoSeamSide, AoSeamRecord>>;
  readonly totals: { readonly masks: number; readonly bytes: number };
}

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function object(value: unknown, label: string, source: string): Record<string, unknown> {
  if (!isObject(value)) fail(source, `${label} must be an object`);
  return value;
}

function finite(value: unknown, label: string, source: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(source, `${label} must be a finite number`);
  }
  return value;
}

function text(value: unknown, label: string, source: string): string {
  if (typeof value !== 'string' || value === '') fail(source, `${label} must be a string`);
  return value;
}

function bool(value: unknown, label: string, source: string): boolean {
  if (typeof value !== 'boolean') fail(source, `${label} must be a boolean`);
  return value;
}

function point(value: unknown, label: string, source: string): ShadowPoint {
  const raw = object(value, label, source);
  return {
    x: finite(raw.x, `${label}.x`, source),
    y: finite(raw.y, `${label}.y`, source),
  };
}

function stringMap(value: unknown, label: string, source: string): Readonly<Record<string, number>> {
  const raw = object(value, label, source);
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(raw)) {
    out[key] = finite(entry, `${label}.${key}`, source);
  }
  return out;
}

function parseMatShadow(bucket: string, value: unknown, source: string): MatShadowRecord {
  const raw = object(value, `matShadows.${bucket}`, source);
  const label = `matShadows.${bucket}`;
  const blank = object(raw.blank, `${label}.blank`, source);
  const alpha = object(raw.alpha, `${label}.alpha`, source);
  return {
    bucket,
    family: text(raw.family, `${label}.family`, source),
    representative: text(raw.representative, `${label}.representative`, source),
    slotCount: finite(raw.slotCount, `${label}.slotCount`, source),
    blank: {
      textureFile: text(blank.textureFile, `${label}.blank.textureFile`, source),
      anchor: point(blank.anchor, `${label}.blank.anchor`, source),
      pivot: point(blank.pivot, `${label}.blank.pivot`, source),
    },
    textureFile: text(raw.textureFile, `${label}.textureFile`, source),
    width: finite(raw.width, `${label}.width`, source),
    height: finite(raw.height, `${label}.height`, source),
    pixelRatio: finite(raw.pixelRatio, `${label}.pixelRatio`, source),
    pivot: point(raw.pivot, `${label}.pivot`, source),
    anchor: point(raw.anchor, `${label}.anchor`, source),
    grounded: bool(raw.grounded, `${label}.grounded`, source),
    groundDropUnits: finite(raw.groundDropUnits, `${label}.groundDropUnits`, source),
    alpha: {
      peakAlpha: finite(alpha.peakAlpha, `${label}.alpha.peakAlpha`, source),
      meanAlpha: finite(alpha.meanAlpha, `${label}.alpha.meanAlpha`, source),
      supportPx: finite(alpha.supportPx, `${label}.alpha.supportPx`, source),
    },
    bytes: finite(raw.bytes, `${label}.bytes`, source),
  };
}

function parseWallStack(seat: string, value: unknown, source: string): WallStackRecord {
  const raw = object(value, `wallStack.seats.${seat}`, source);
  const label = `wallStack.seats.${seat}`;
  const alpha = object(raw.alpha, `${label}.alpha`, source);
  return {
    seat,
    layer0: text(raw.layer0, `${label}.layer0`, source),
    layer1: text(raw.layer1, `${label}.layer1`, source),
    bucket: text(raw.bucket, `${label}.bucket`, source),
    textureFile: text(raw.textureFile, `${label}.textureFile`, source),
    width: finite(raw.width, `${label}.width`, source),
    height: finite(raw.height, `${label}.height`, source),
    pixelRatio: finite(raw.pixelRatio, `${label}.pixelRatio`, source),
    pivot: point(raw.pivot, `${label}.pivot`, source),
    anchor: point(raw.anchor, `${label}.anchor`, source),
    alpha: {
      peakAlpha: finite(alpha.peakAlpha, `${label}.alpha.peakAlpha`, source),
      meanAlpha: finite(alpha.meanAlpha, `${label}.alpha.meanAlpha`, source),
      supportPx: finite(alpha.supportPx, `${label}.alpha.supportPx`, source),
    },
  };
}

/** Validate the committed `shadows.json`. */
export function parseShadowsManifest(raw: unknown): ShadowsManifest {
  const source = 'shadows.json';
  const doc = object(raw, 'document', source);
  if (doc.version !== 1) fail(source, 'version must be 1');
  const referenceResolution = object(doc.referenceResolution, 'referenceResolution', source);
  const frame = object(doc.frame, 'frame', source);
  const composite = object(doc.composite, 'composite', source);
  const wallStack = object(doc.wallStack, 'wallStack', source);
  const seatsRaw = object(wallStack.seats, 'wallStack.seats', source);
  const seats: Record<string, WallStackRecord> = {};
  for (const [seat, record] of Object.entries(seatsRaw)) {
    seats[seat] = parseWallStack(seat, record, source);
  }
  if (Object.keys(seats).length !== 4) fail(source, 'wallStack.seats must hold all four seats');

  const agreement = object(wallStack.seatAgreement, 'wallStack.seatAgreement', source);

  const matsRaw = object(doc.matShadows, 'matShadows', source);
  const matShadows: Record<string, MatShadowRecord> = {};
  for (const [bucket, record] of Object.entries(matsRaw)) {
    matShadows[bucket] = parseMatShadow(bucket, record, source);
  }
  if (Object.keys(matShadows).length === 0) fail(source, 'matShadows must not be empty');

  const totals = object(doc.totals, 'totals', source);
  return {
    version: 1,
    generatedBy: text(doc.generatedBy, 'generatedBy', source),
    task: text(doc.task, 'task', source),
    variant: text(doc.variant, 'variant', source),
    pixelRatio: finite(doc.pixelRatio, 'pixelRatio', source) as 2,
    referenceResolution: {
      width: finite(referenceResolution.width, 'referenceResolution.width', source),
      height: finite(referenceResolution.height, 'referenceResolution.height', source),
    },
    frame: {
      width: finite(frame.width, 'frame.width', source),
      height: finite(frame.height, 'frame.height', source),
    },
    composite: {
      model: text(composite.model, 'composite.model', source),
      note: text(composite.note, 'composite.note', source),
    },
    coordinateSpace: text(doc.coordinateSpace, 'coordinateSpace', source),
    wallStack: {
      canonical: text(wallStack.canonical, 'wallStack.canonical', source),
      perSeat: bool(wallStack.perSeat, 'wallStack.perSeat', source),
      seatAgreement: {
        worst: finite(agreement.worst, 'wallStack.seatAgreement.worst', source),
        maxAlphaDifference: stringMap(
          agreement.maxAlphaDifference,
          'wallStack.seatAgreement.maxAlphaDifference',
          source,
        ),
      },
      seats,
    },
    matShadows,
    totals: {
      matShadows: finite(totals.matShadows, 'totals.matShadows', source),
      wallStacks: finite(totals.wallStacks, 'totals.wallStacks', source),
      bytes: finite(totals.bytes, 'totals.bytes', source),
    },
  };
}

function parseSeam(edge: AoSeamSide, value: unknown, source: string): AoSeamRecord {
  const raw = object(value, `seams.${edge}`, source);
  const label = `seams.${edge}`;
  const measured = object(raw.measured, `${label}.measured`, source);
  const axis = text(raw.axis, `${label}.axis`, source);
  if (axis !== 'u' && axis !== 'v') fail(source, `${label}.axis must be u or v`);
  const side = text(raw.side, `${label}.side`, source);
  if (side !== 'low' && side !== 'high') fail(source, `${label}.side must be low or high`);
  if (raw.edge !== edge) fail(source, `${label}.edge must be ${edge}`);
  return {
    edge,
    axis,
    side,
    textureFile: text(raw.textureFile, `${label}.textureFile`, source),
    width: finite(raw.width, `${label}.width`, source),
    height: finite(raw.height, `${label}.height`, source),
    channels: text(raw.channels, `${label}.channels`, source),
    ink: text(raw.ink, `${label}.ink`, source),
    profile: text(raw.profile, `${label}.profile`, source),
    fadeFractionOfAxis: finite(raw.fadeFractionOfAxis, `${label}.fadeFractionOfAxis`, source),
    measured: {
      edgeAlpha: finite(measured.edgeAlpha, `${label}.measured.edgeAlpha`, source),
      peakAlpha: finite(measured.peakAlpha, `${label}.measured.peakAlpha`, source),
      fadeAxisFraction: finite(measured.fadeAxisFraction, `${label}.measured.fadeAxisFraction`, source),
      fadeFractionOfTileWidth: finite(
        measured.fadeFractionOfTileWidth,
        `${label}.measured.fadeFractionOfTileWidth`,
        source,
      ),
      monotonic: bool(measured.monotonic, `${label}.measured.monotonic`, source),
    },
  };
}

/** Validate the committed `ao_seams.json`. */
export function parseAoSeamsManifest(raw: unknown): AoSeamsManifest {
  const source = 'ao_seams.json';
  const doc = object(raw, 'document', source);
  if (doc.version !== 1) fail(source, 'version must be 1');
  const resolution = object(doc.resolution, 'resolution', source);
  const seamsRaw = object(doc.seams, 'seams', source);
  const seams = {} as Record<AoSeamSide, AoSeamRecord>;
  for (const edge of AO_SEAM_SIDES) {
    seams[edge] = parseSeam(edge, seamsRaw[edge], source);
  }
  const totals = object(doc.totals, 'totals', source);
  return {
    version: 1,
    generatedBy: text(doc.generatedBy, 'generatedBy', source),
    task: text(doc.task, 'task', source),
    peakAlpha: finite(doc.peakAlpha, 'peakAlpha', source),
    resolution: {
      width: finite(resolution.width, 'resolution.width', source),
      height: finite(resolution.height, 'resolution.height', source),
    },
    coordinateSpace: text(doc.coordinateSpace, 'coordinateSpace', source),
    runtime: text(doc.runtime, 'runtime', source),
    seams,
    totals: {
      masks: finite(totals.masks, 'totals.masks', source),
      bytes: finite(totals.bytes, 'totals.bytes', source),
    },
  };
}

/**
 * The seat a wall zone belongs to, which selects that seat's stack decal.
 * A front wall is the human (south) side, a back wall the far (north) side.
 */
export function wallSeatOf(zone: LayoutZone): 'north' | 'south' | 'east' | 'west' | null {
  if (zone.kind !== 'wall') return null;
  if (zone.side === 'left') return 'west';
  if (zone.side === 'right') return 'east';
  if (zone.wall === 'front') return 'south';
  if (zone.wall === 'back') return 'north';
  return null;
}

/** Rotation class of a shell's pose: 0/180 and 90/270 share a bucket. */
function isSidewaysShell(shell: ShellStats): boolean {
  return shell.faceRotationDeg === 90 || shell.faceRotationDeg === 270;
}

/**
 * Which hand-row bucket a standing tile of the human or far hand uses.
 *
 * The five buckets follow the fan's perspective: the outer slots show more of
 * the tile's side, the centre is straight on. The far hand mirrors the row,
 * because it faces away from the camera.
 */
function handBucket(side: 'bottom' | 'top', rowIndex: number): string {
  if (side === 'bottom') {
    if (rowIndex <= 2) return 'hand_far_left';
    if (rowIndex <= 4) return 'hand_mid_left';
    if (rowIndex <= 7) return 'hand_center';
    if (rowIndex <= 9) return 'hand_mid_right';
    return 'hand_far_right';
  }
  if (rowIndex <= 1) return 'hand_far_right';
  if (rowIndex <= 4) return 'hand_mid_right';
  if (rowIndex <= 7) return 'hand_center';
  if (rowIndex <= 10) return 'hand_mid_left';
  return 'hand_far_left';
}

/** The hand row index of a standing shell; the drawn slot sits at the row's end. */
function handRowIndex(shell: ShellStats): number | null {
  const meta = shell.handSlot ?? shell.topHandSlot;
  if (!meta) return null;
  return meta.index ?? 13;
}

/**
 * The blank bucket (and therefore mat-shadow sprite) a placed tile uses.
 *
 * The bucket is a property of the shell's *pose*, not of the tile's table
 * position: `zoneLayout` draws each pond with one shell family, so a bottom
 * pond tile is a `flat_center` pose whatever its column, and only the four
 * side-wall and five hand families vary across a zone. A 90° and a 270° pose
 * share a bucket because a rectangular tile body is symmetric under a half
 * turn, and so do 0° and 180°.
 *
 * The horizontal wall buckets are chosen by stack index (the bake's
 * representatives: slots 6-10 are the straight-on centre of the run) and the
 * meld buckets by the seat the meld lies on (the reference layout puts a meld
 * outside the wall on the player's right, so a bottom/right seat's meld shows
 * its right side).
 */
export function matShadowBucketFor(zone: LayoutZone, tile: PlacedTile, shell: ShellStats): string {
  const sideways = isSidewaysShell(shell);
  const suffix = sideways ? '_rotated' : '';

  if (zone.kind === 'hand') {
    if (zone.side === 'left') return 'hand_far_left';
    if (zone.side === 'right') return 'hand_far_right';
    const index = handRowIndex(shell);
    if (index === null) {
      throw new Error(
        `shadows: hand tile ${tile.shell} in ${zone.id} has no hand slot metadata`,
      );
    }
    return handBucket(zone.side === 'top' ? 'top' : 'bottom', index);
  }

  if (zone.kind === 'pond') {
    if (zone.side === 'left') return `flat_left${suffix}`;
    if (zone.side === 'right') return `flat_right${suffix}`;
    return `flat_center${suffix}`;
  }

  if (zone.kind === 'melds') {
    return zone.side === 'bottom' || zone.side === 'right' ? `flat_right${suffix}` : `flat_left${suffix}`;
  }

  if (zone.kind === 'wall') {
    if (zone.side === 'left') return 'wall_left_side';
    if (zone.side === 'right') return 'wall_right_side';
    const slot = tile.cell?.slot;
    if (slot === undefined) {
      throw new Error(`shadows: wall tile ${tile.shell} in ${zone.id} has no stack slot`);
    }
    // The bake's representatives put slots 6-10 straight on. North (the far
    // wall) shows its left side at the higher indices because the run is seen
    // from the opposite side.
    const family = slot >= 6 && slot <= 10 ? 'center' : zone.wall === 'back' ? (slot <= 5 ? 'right' : 'left') : slot <= 5 ? 'left' : 'right';
    return `wall_horiz_${family}`;
  }

  throw new Error(`shadows: ${zone.id} (${zone.kind}) has no mat-shadow bucket`);
}

/** The stack decal of a wall zone: one per seat, measured not interchangeable. */
export function wallStackRecordFor(
  manifest: ShadowsManifest,
  zone: LayoutZone,
): WallStackRecord | null {
  const seat = wallSeatOf(zone);
  if (!seat) return null;
  return manifest.wallStack.seats[seat] ?? null;
}

/**
 * The scale that maps a Task 4A sprite from the reference frame into the shell
 * space the runtime draws in.
 *
 * `shadows.json` and `blanks.json` are baked against `table_layout.json`'s
 * 1920 x 1080 reference frame, whose tiles are ~48 x 69 px. The runtime draws
 * `shells.json`'s per-slot shells at their own @1x size (~72 x 102 px for the
 * same tile), so a shadow sprite drawn unscaled is both too small and offset —
 * its dense core pokes out from under the tile. The scale is the ratio of the
 * two published body boxes (the shell's advance and the bucket's measured
 * `alphaBBox`), taken as their geometric mean because the two cameras are not
 * exactly proportional.
 *
 * Returns 1 when the bucket is unknown, so a caller without `blanks.json` still
 * draws something rather than throwing.
 */
export function referenceToShellScale(shell: ShellStats, blank: BlankBucket | null): number {
  if (!blank || blank.bodyWidth <= 0 || blank.bodyHeight <= 0) return 1;
  return Math.sqrt(
    (shell.advanceWidth / blank.bodyWidth) * (shell.advanceHeight / blank.bodyHeight),
  );
}
