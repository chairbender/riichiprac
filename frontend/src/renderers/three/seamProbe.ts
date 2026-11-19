/**
 * The seam probe (3D-20): a read-back scanline across a *known* inter-tile
 * groove, as numbers rather than an opinion.
 *
 * AGENTS.md §6 forbids an agent from judging a render by looking at it. The
 * white-seam defect is exactly the kind of thing that invites "that looks
 * better": this module turns it into two facts a script can print —
 *
 * 1. **Is the groove darker than the tiles either side of it?** — the seam must
 *    read as a groove, not a bright line. `contrast` is
 *    `plateauLuma - grooveMaxLuma`; a white seam makes it negative.
 * 2. **Is it dark *enough* to read as a groove?** — `depth` is
 *    `plateauLuma - grooveMeanLuma`. A seam that has simply been closed (or
 *    flooded with shadow) loses it.
 *
 * It also reports the **brightest groove pixel's RGB**, which is what attributes
 * the cause: tile ivory is neutral (R ≈ G ≈ B), the felt is green (G well above
 * R and B), and the scene background is near-black. A bright groove pixel whose
 * chroma is the felt's is the camera seeing *through* the groove; one that is
 * ivory is the abutting bevel catching the key.
 *
 * Geometry is pure and unit-tested: the module picks real touching pairs out of
 * the layout (`contact.ts`, so a probe can never measure a pair that is not in
 * contact), projects each pair's plateau-to-plateau window into the drawing
 * buffer, and returns the sample points. `Scene.seamReport()` owns the
 * `readPixels` call; this module owns the arithmetic and the pass rule.
 *
 * The window. Between two tiles in contact the eye reads the groove as the band
 * from one **face plateau's edge** to the other's: the pair of 0.055-unit
 * bevels plus the 0.0107-unit body groove. For a lateral contact that band lies
 * in the face plane; for the wall's tiers (a contact along the tile's own Z) it
 * lies along the body's thickness. Both are `gap / 2 + bevel` either side of the
 * surface midline, so one rule covers the two families.
 */

import { TILE, WALL } from '../layoutConstants';
import type { EdgeReadingNumber, SeamReadingNumber } from '../contract';
import { orientedBox, projectToPixels, seatBasis } from './boardLayout';
import type { BoardLayout, CameraFrame, Vec3 } from './boardLayout';
import { CONTACT_EDGE, contactPairs } from './contact';

/** Which family a probe belongs to; each reads a different part of the board. */
export type SeamKind = 'hand-row' | 'pond-row' | 'wall-stack' | 'wall-tier';

/** How many pixels of plateau are sampled on each side of the groove. */
export const SEAM_PLATEAU_PAD_PX = 5;

/** How far either side of the scan line each sample is medianed, in pixels. */
export const SEAM_PERPENDICULAR_OFFSETS_PX: readonly number[] = [-2, 0, 2];

/** The pass rule, as numbers. */
export const SEAM_GATE = {
  /**
   * The groove's **core** — its middle third, where two bodies meet — must be at
   * least this many luma below the darker of the two adjacent faces. The outer
   * thirds are legitimately bright: they are the two bevels, and a bevel is a lit
   * surface. A white seam is a *core* that does not go dark.
   */
  minContrast: 12,
  /**
   * The core's mean must be this far below the darker face, so a groove that has
   * been filled in (or washed out) fails just as a bright core does.
   */
  minDepth: 18,
  /**
   * A groove narrower than this many pixels cannot be measured: at 2 px there is
   * a core pixel, at 1 px the two bevels merge and no scanline can tell a groove
   * from a line (that case is the resolution budget's problem, and the gate says
   * so instead of pretending to measure it).
   */
  minSpanPx: 2.5,
} as const;

/** One touching pair chosen for measurement. */
export interface SeamTarget {
  readonly id: string;
  readonly kind: SeamKind;
  readonly aId: string;
  readonly bId: string;
  /** The axis of `a` that points at `b`, and its sign. */
  readonly axis: 0 | 1 | 2;
  readonly sign: 1 | -1;
  /**
   * Which camera-facing surface to measure the seam on. `top` picks the face
   * most directly toward the eye (a pond's or hand's carved face, a wall's top
   * plate); `front` picks the face most directly toward the eye *in plan* — the
   * near-side wall, where a standing tile's lateral seam is legible instead of
   * being a sub-pixel slot.
   */
  readonly facing: 'top' | 'front';
}

/** One pixel to read, and how far it sits from the groove's near edge. */
export interface SeamSample {
  /** Drawing-buffer pixel, y **down** (an `ImageData` orientation). */
  readonly x: number;
  readonly y: number;
  /** Pixels from the plateau edge: negative is on `a`, past `spanPx` is on `b`. */
  readonly offsetPx: number;
}

/** A seam's projected sample set, plus the numbers that produced it. */
export interface SeamRaster {
  readonly target: SeamTarget;
  readonly samples: readonly SeamSample[];
  /** The integer block the samples fall in, for one `readPixels` call. */
  readonly block: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Pixel distance between the two plateau edges. */
  readonly spanPx: number;
  /** The body-to-body separation, in tile units and pixels. */
  readonly gapUnits: number;
  readonly gapPx: number;
}

/** One seam's measured result (the contract type plus the local kind tag). */
export type SeamReading = SeamReadingNumber & { readonly kind: SeamKind };

/** A read-back source, matching `probes.ts`'s `ProbePixelSource`. */
export interface SeamPixelSource {
  readonly width: number;
  readonly height: number;
  read(x: number, y: number, width: number, height: number): Uint8Array;
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function radiusAlong(box: ReturnType<typeof orientedBox>, axis: Vec3): number {
  return (
    Math.abs(dot(box.axes[0], axis)) * box.halfExtents[0] +
    Math.abs(dot(box.axes[1], axis)) * box.halfExtents[1] +
    Math.abs(dot(box.axes[2], axis)) * box.halfExtents[2]
  );
}

/**
 * Pick the four representative seams out of the board.
 *
 * One per family, chosen by rule rather than by hard-coded id: the middle pair
 * of the human's concealed row, the first pair of the human's nearest pond row,
 * the middle lateral pair of the wall ring, and a wall stack's two tiers. A
 * board that cannot supply one (an odd fixture) simply omits it, and the report
 * says how many it found.
 */
export interface SeamView {
  readonly frame: CameraFrame;
  readonly widthPx: number;
  readonly heightPx: number;
}

export function seamTargets(
  layout: BoardLayout,
  view?: SeamView,
): readonly SeamTarget[] {
  const byId = new Map(layout.tiles.map((tile) => [tile.id, tile]));
  const { pairs } = contactPairs(layout.tiles);
  const targets: SeamTarget[] = [];
  const zoneOf = (id: string): string => byId.get(id)?.zone ?? '';
  const seatOf = (id: string): number | null => byId.get(id)?.seat ?? null;
  const pick = (
    kind: SeamKind,
    candidates: readonly { aId: string; bId: string; axis: 0 | 1 | 2; sign: 1 | -1 }[],
  ): void => {
    const chosen = candidates[0];
    if (!chosen) return;
    targets.push({
      id: kind,
      kind,
      aId: chosen.aId,
      bId: chosen.bId,
      axis: chosen.axis,
      sign: chosen.sign,
      facing: kind === 'wall-stack' ? 'front' : 'top',
    });
  };

  const human = layout.humanSeat;
  const handPairs = pairs.filter(
    (pair) =>
      zoneOf(pair.aId) === 'hand' &&
      zoneOf(pair.bId) === 'hand' &&
      seatOf(pair.aId) === human &&
      seatOf(pair.bId) === human,
  );
  const hand = handPairs[Math.floor(handPairs.length / 2)];
  if (hand) {
    targets.push({
      id: 'hand-row',
      kind: 'hand-row',
      aId: hand.aId,
      bId: hand.bId,
      axis: hand.axis,
      sign: hand.sign,
      facing: 'top',
    });
  }

  pick(
    'pond-row',
    pairs.filter(
      (pair) =>
        zoneOf(pair.aId) === 'river' &&
        zoneOf(pair.bId) === 'river' &&
        seatOf(pair.aId) === human &&
        seatOf(pair.bId) === human &&
        pair.axis !== 2,
    ),
  );

  // The wall families. A lateral pair is measured on the wall's **top tier's
  // back plates** — the surface the camera sees most of — and among those the
  // pair nearest the frame centre, where the seam is least foreshortened. The
  // tier pair is measured on the near run's front wall, the only place the tier
  // line is visible at all.
  const wallRun = (id: string): number => {
    const tile = byId.get(id);
    return tile ? Math.floor(tile.slot / WALL.slotsPerRun) : -1;
  };
  const wallTier = (id: string): number => {
    const tile = byId.get(id);
    return tile ? tile.slot % WALL.tiers : -1;
  };
  const wallPairs = pairs.filter(
    (pair) => zoneOf(pair.aId) === 'wall' && zoneOf(pair.bId) === 'wall',
  );
  const distanceToCentre = (pair: { aId: string; bId: string }): number => {
    if (!view) return 0;
    const centre = (id: string): Vec3 => byId.get(id)?.pose.position ?? [0, 0, 0];
    const a = projectToPixels(centre(pair.aId), view.frame, view.widthPx, view.heightPx);
    const b = projectToPixels(centre(pair.bId), view.frame, view.widthPx, view.heightPx);
    return Math.hypot(
      (a.x + b.x) / 2 - view.widthPx / 2,
      (a.y + b.y) / 2 - view.heightPx / 2,
    );
  };
  const best = (
    candidates: readonly { aId: string; bId: string; axis: 0 | 1 | 2; sign: 1 | -1 }[],
  ) =>
    [...candidates].sort((left, right) => distanceToCentre(left) - distanceToCentre(right))[0];

  const topTierWallPairs = wallPairs.filter(
    (pair) => wallTier(pair.aId) === WALL.tiers - 1 && wallTier(pair.bId) === WALL.tiers - 1,
  );
  pick(
    'wall-stack',
    [...topTierWallPairs.filter((pair) => pair.axis === 0)]
      .map((pair) => pair)
      .sort((left, right) => distanceToCentre(left) - distanceToCentre(right))
      .slice(0, 1),
  );
  const nearTierPairs = wallPairs.filter(
    (pair) =>
      pair.axis === 2 && wallRun(pair.aId) === human && wallRun(pair.bId) === human,
  );
  pick(
    'wall-tier',
    nearTierPairs.length
      ? [best(nearTierPairs) as { aId: string; bId: string; axis: 0 | 1 | 2; sign: 1 | -1 }]
      : [],
  );
  return targets;
}

/**
 * The pixel samples for one seam. Pure: same layout, frame and size, same
 * points.
 *
 * @throws when a target names a tile the layout does not hold (a constructing
 *   bug, not a board state).
 */
export function seamRaster(
  layout: BoardLayout,
  target: SeamTarget,
  frame: CameraFrame,
  widthPx: number,
  heightPx: number,
): SeamRaster {
  const byId = new Map(layout.tiles.map((tile) => [tile.id, tile]));
  const a = byId.get(target.aId);
  const b = byId.get(target.bId);
  if (!a || !b) {
    throw new Error(
      `3D seam probe: ${target.id} names ${!a ? target.aId : target.bId}, which the layout does not hold`,
    );
  }
  const boxA = orientedBox(a.pose);
  const boxB = orientedBox(b.pose);
  const direction = boxA.axes[target.axis];
  const normal: Vec3 = [
    direction[0] * target.sign,
    direction[1] * target.sign,
    direction[2] * target.sign,
  ];
  const radiusA = radiusAlong(boxA, normal);
  const radiusB = radiusAlong(boxB, normal);
  const surfaceA: Vec3 = [
    boxA.centre[0] + normal[0] * radiusA,
    boxA.centre[1] + normal[1] * radiusA,
    boxA.centre[2] + normal[2] * radiusA,
  ];
  const surfaceB: Vec3 = [
    boxB.centre[0] - normal[0] * radiusB,
    boxB.centre[1] - normal[1] * radiusB,
    boxB.centre[2] - normal[2] * radiusB,
  ];
  const gapUnits = dot(
    [surfaceB[0] - surfaceA[0], surfaceB[1] - surfaceA[1], surfaceB[2] - surfaceA[2]],
    normal,
  );
  // The seam's mid-line sits in the gap between the two bodies — usually *inside*
  // the geometry as far as the camera is concerned (a wall stack's tier line is
  // hidden behind the top tier). Snap it onto each body's camera-facing face so
  // the scanline is measured on the surface the player actually sees.
  const mid: Vec3 = [
    (surfaceA[0] + surfaceB[0]) / 2,
    (surfaceA[1] + surfaceB[1]) / 2,
    (surfaceA[2] + surfaceB[2]) / 2,
  ];
  const visibleA = facingSurface(boxA, mid, frame.eye, normal, target.facing, [boxA, boxB]);
  const visibleB = facingSurface(boxB, mid, frame.eye, normal, target.facing, [boxA, boxB]);
  const visible: Vec3 = [
    (visibleA[0] + visibleB[0]) / 2,
    (visibleA[1] + visibleB[1]) / 2,
    (visibleA[2] + visibleB[2]) / 2,
  ];
  // The visible groove runs from one bevel's far edge to the other's: half the
  // body groove plus one bevel on each side of the seam.
  const halfUnits = Math.max(gapUnits, 0) / 2 + TILE.bevelUnits;
  const near: Vec3 = [
    visible[0] - normal[0] * halfUnits,
    visible[1] - normal[1] * halfUnits,
    visible[2] - normal[2] * halfUnits,
  ];
  const far: Vec3 = [
    visible[0] + normal[0] * halfUnits,
    visible[1] + normal[1] * halfUnits,
    visible[2] + normal[2] * halfUnits,
  ];
  const scan = buildScan(near, far, frame, widthPx, heightPx, SEAM_PLATEAU_PAD_PX);
  return {
    target,
    samples: scan.samples,
    block: scan.block,
    spanPx: scan.spanPx,
    gapUnits,
    // The body groove's share of the pixel window, for the report.
    gapPx: (Math.abs(gapUnits) / (Math.abs(gapUnits) + 2 * TILE.bevelUnits)) * scan.spanPx,
  };
}

/** One projected scanline: its samples, their bounding block and its length. */
interface PixelScan {
  readonly samples: readonly SeamSample[];
  readonly block: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly spanPx: number;
}

/**
 * Project the segment `from`→`to` and sample it every pixel, extended `padPx`
 * past both ends and medianed over the perpendicular offsets.
 *
 * Shared by the seam probe (a groove's plateau-to-plateau window) and the edge
 * probe (a silhouette's inside-to-outside window), so both measure the same way.
 */
function buildScan(
  from: Vec3,
  to: Vec3,
  frame: CameraFrame,
  widthPx: number,
  heightPx: number,
  padPx: number,
): PixelScan {
  const fromPx = projectToPixels(from, frame, widthPx, heightPx);
  const toPx = projectToPixels(to, frame, widthPx, heightPx);
  const dx = toPx.x - fromPx.x;
  const dy = toPx.y - fromPx.y;
  const spanPx = Math.hypot(dx, dy);
  const unitX = spanPx > 0 ? dx / spanPx : 1;
  const unitY = spanPx > 0 ? dy / spanPx : 0;
  const perpX = -unitY;
  const perpY = unitX;
  const steps = Math.max(1, Math.round(spanPx));
  const samples: SeamSample[] = [];
  for (let offset = -padPx; offset <= steps + padPx; offset += 1) {
    const baseX = fromPx.x + unitX * offset;
    const baseY = fromPx.y + unitY * offset;
    for (const sideways of SEAM_PERPENDICULAR_OFFSETS_PX) {
      samples.push({
        x: Math.round(baseX + perpX * sideways),
        y: Math.round(baseY + perpY * sideways),
        offsetPx: offset,
      });
    }
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const sample of samples) {
    minX = Math.min(minX, sample.x);
    minY = Math.min(minY, sample.y);
    maxX = Math.max(maxX, sample.x);
    maxY = Math.max(maxY, sample.y);
  }
  const x = Math.max(0, Math.min(widthPx - 1, minX));
  const y = Math.max(0, Math.min(heightPx - 1, minY));
  const right = Math.max(0, Math.min(widthPx - 1, maxX));
  const bottom = Math.max(0, Math.min(heightPx - 1, maxY));
  return {
    samples,
    block: {
      x,
      y,
      width: Math.max(1, right - x + 1),
      height: Math.max(1, bottom - y + 1),
    },
    spanPx,
  };
}

/**
 * The point on `box`'s camera-facing face that lies at `point`'s position along
 * the seam's other two axes.
 *
 * `point` is the seam's mid-line, which for a wall stack is buried inside the
 * geometry (the tier line is hidden behind the top tier). Projecting it would
 * measure whatever occludes it instead of the seam; snapping it onto the face the
 * camera actually sees puts the scanline on the visible surface — the pond's and
 * hand's carved face, the wall's near wall.
 *
 * Two rules, both needed:
 *
 * 1. **Never snap along the contact axis.** That face is the one touching the
 *    neighbour, so snapping to it would move the sample off the seam (a wall
 *    bottom tier's up face is the contact face, not something to look at).
 * 2. **Prefer a face whose ray to the eye is clear.** The bottom tier's up face
 *    also has the largest dot with the view direction, and it is covered by the
 *    top tier; a contained-face pick would sample the top plate instead of the
 *    tier line. Candidates are tried best-facing first and rejected when either
 *    body blocks the ray.
 */
function facingSurface(
  box: ReturnType<typeof orientedBox>,
  point: Vec3,
  eye: Vec3,
  contactAxis: Vec3,
  facing: 'top' | 'front',
  blockers: readonly ReturnType<typeof orientedBox>[],
): Vec3 {
  const delta: Vec3 = [
    point[0] - box.centre[0],
    point[1] - box.centre[1],
    point[2] - box.centre[2],
  ];
  const local = [dot(delta, box.axes[0]), dot(delta, box.axes[1]), dot(delta, box.axes[2])];
  const toEye: Vec3 = [eye[0] - box.centre[0], eye[1] - box.centre[1], eye[2] - box.centre[2]];
  // `front` scores against the eye direction with its vertical component dropped,
  // so a standing tile's near side wall wins over its top plate.
  const scoreAgainst: Vec3 =
    facing === 'front' ? [toEye[0], 0, toEye[2]] : toEye;

  const candidates = [0, 1, 2]
    .filter((axis) => Math.abs(dot(box.axes[axis], contactAxis)) < 0.5)
    .map((axis) => {
      const score = dot(box.axes[axis], scoreAgainst);
      return { axis, sign: score >= 0 ? 1 : -1, score: Math.abs(score) };
    })
    .sort((left, right) => right.score - left.score);

  const build = (candidate: { axis: number; sign: number }): Vec3 => {
    const snapped = [...local];
    snapped[candidate.axis] = candidate.sign * box.halfExtents[candidate.axis];
    return [
      box.centre[0] +
        box.axes[0][0] * snapped[0] +
        box.axes[1][0] * snapped[1] +
        box.axes[2][0] * snapped[2],
      box.centre[1] +
        box.axes[0][1] * snapped[0] +
        box.axes[1][1] * snapped[1] +
        box.axes[2][1] * snapped[2],
      box.centre[2] +
        box.axes[0][2] * snapped[0] +
        box.axes[1][2] * snapped[1] +
        box.axes[2][2] * snapped[2],
    ];
  };

  for (const candidate of candidates) {
    const surface = build(candidate);
    const outward = box.axes[candidate.axis];
    const origin: Vec3 = [
      surface[0] + outward[0] * candidate.sign * 1e-3,
      surface[1] + outward[1] * candidate.sign * 1e-3,
      surface[2] + outward[2] * candidate.sign * 1e-3,
    ];
    if (!blocked(origin, eye, blockers)) return surface;
  }
  const first = candidates[0];
  return first ? build(first) : [...local] as unknown as Vec3;
}

/** The entry distance of a ray into an oriented box, or null when it misses. */
function rayBoxEntry(
  box: ReturnType<typeof orientedBox>,
  origin: Vec3,
  direction: Vec3,
): number | null {
  const offset: Vec3 = [
    origin[0] - box.centre[0],
    origin[1] - box.centre[1],
    origin[2] - box.centre[2],
  ];
  let enter = 0;
  let exit = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 3; axis += 1) {
    const localOrigin = dot(offset, box.axes[axis]);
    const localDirection = dot(direction, box.axes[axis]);
    const half = box.halfExtents[axis];
    if (Math.abs(localDirection) < 1e-9) {
      if (localOrigin < -half || localOrigin > half) return null;
      continue;
    }
    const first = (-half - localOrigin) / localDirection;
    const second = (half - localOrigin) / localDirection;
    enter = Math.max(enter, Math.min(first, second));
    exit = Math.min(exit, Math.max(first, second));
    if (enter > exit) return null;
  }
  return enter <= 0 ? null : enter;
}

/** Whether the segment from `origin` to `eye` passes through any of `boxes`. */
function blocked(
  origin: Vec3,
  eye: Vec3,
  boxes: readonly ReturnType<typeof orientedBox>[],
): boolean {
  const direction: Vec3 = [eye[0] - origin[0], eye[1] - origin[1], eye[2] - origin[2]];
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) return false;
  const unit: Vec3 = [direction[0] / length, direction[1] / length, direction[2] / length];
  for (const box of boxes) {
    const entry = rayBoxEntry(box, origin, unit);
    if (entry !== null && entry < length - 1e-3) return true;
  }
  return false;
}

/** Every seam's raster, in target order. */
export function seamRasters(
  layout: BoardLayout,
  frame: CameraFrame,
  widthPx: number,
  heightPx: number,
  targets: readonly SeamTarget[] = seamTargets(layout, { frame, widthPx, heightPx }),
): readonly SeamRaster[] {
  return targets.map((target) => {
    try {
      return seamRaster(layout, target, frame, widthPx, heightPx);
    } catch {
      return null;
    }
  }).filter((raster): raster is SeamRaster => raster !== null);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function luma(rgb: readonly [number, number, number]): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/**
 * Read one seam's pixels and reduce them to the two facts the gate needs.
 *
 * Each offset's value is the **median** of its three perpendicular samples, so
 * one stray texel cannot flip the verdict; the offsets inside the window are the
 * groove and the ones outside are the adjacent faces.
 */
export function readSeam(source: SeamPixelSource, raster: SeamRaster): SeamReading {
  const { block } = raster;
  const pixels = source.read(block.x, block.y, block.width, block.height);
  const byOffset = new Map<number, { luma: number; rgb: [number, number, number] }[]>();
  for (const sample of raster.samples) {
    const localX = sample.x - block.x;
    const localY = sample.y - block.y;
    if (localX < 0 || localY < 0 || localX >= block.width || localY >= block.height) continue;
    const index = (localY * block.width + localX) * 4;
    if (index + 3 >= pixels.length) continue;
    const rgb: [number, number, number] = [pixels[index], pixels[index + 1], pixels[index + 2]];
    const list = byOffset.get(sample.offsetPx) ?? [];
    list.push({ luma: luma(rgb), rgb });
    byOffset.set(sample.offsetPx, list);
  }

  // One value per pixel column across the groove: the median of its
  // perpendicular samples (so a stray texel cannot flip a verdict), plus the
  // sample that produced it for the colour attribution.
  const offsetsPx = [...byOffset.keys()].sort((left, right) => left - right);
  const columns = offsetsPx.map((offset) => {
    const list = byOffset.get(offset) ?? [];
    const medianLuma = median(list.map((entry) => entry.luma));
    const closest = list.reduce(
      (best, entry) =>
        Math.abs(entry.luma - medianLuma) < Math.abs(best.luma - medianLuma) ? entry : best,
      list[0] ?? { luma: 0, rgb: [0, 0, 0] as [number, number, number] },
    );
    return { offset, luma: medianLuma, rgb: closest.rgb };
  });
  const lumaPerOffset = columns.map((column) => column.luma);

  const faceA: number[] = [];
  const faceB: number[] = [];
  const core: typeof columns = [];
  const rim: number[] = [];
  const coreStart = raster.spanPx / 3;
  const coreEnd = (raster.spanPx * 2) / 3;
  for (const column of columns) {
    if (column.offset < 0) {
      faceA.push(column.luma);
    } else if (column.offset > raster.spanPx) {
      faceB.push(column.luma);
    } else if (column.offset >= coreStart && column.offset <= coreEnd) {
      core.push(column);
    } else {
      rim.push(column.luma);
    }
  }

  const faceALuma = faceA.length ? median(faceA) : 0;
  const faceBLuma = faceB.length ? median(faceB) : 0;
  // The reference is the **mean of the two faces**. Neither extreme works: the
  // darker flank is already in shadow at a high-contrast seam (a blue wall face
  // beside an ivory one), and the brighter flank would excuse a groove that is
  // as bright as the lit tile. The mean is the level a crevice has to fall below
  // to read as one. `faceLuma` stays as the mean's name for the report.
  const faceLuma = (faceALuma + faceBLuma) / 2;
  const coreLuma = core.map((column) => column.luma);
  const coreMinLuma = coreLuma.length ? Math.min(...coreLuma) : 0;
  const coreMaxLuma = coreLuma.length ? Math.max(...coreLuma) : 0;
  const coreMeanLuma = coreLuma.length
    ? coreLuma.reduce((sum, value) => sum + value, 0) / coreLuma.length
    : 0;
  const rimMaxLuma = rim.length ? Math.max(...rim) : 0;
  // The core's per-column values and colours: the smallest set of numbers that
  // says *what* the bright pixel in a seam is (AGENTS.md §6: a colour, not an
  // opinion about the picture).
  const coreColumns = core.map((column) => ({
    offsetPx: column.offset,
    luma: Math.round(column.luma),
    rgb: column.rgb,
  }));
  const brightest = core.reduce(
    (best, column) => (column.luma > best.luma ? column : best),
    core[0] ?? { offset: 0, luma: 0, rgb: [0, 0, 0] as [number, number, number] },
  );
  const contrast = faceLuma - coreMaxLuma;
  const depth = faceLuma - coreMeanLuma;

  let detail: string | null = null;
  if (raster.spanPx < SEAM_GATE.minSpanPx) {
    detail = `the seam projects to ${raster.spanPx.toFixed(1)} px (< ${SEAM_GATE.minSpanPx}): too narrow to tell a groove from a line at this size`;
  } else if (contrast < SEAM_GATE.minContrast) {
    detail = `the groove's core is only ${contrast.toFixed(1)} luma below the darker face (< ${SEAM_GATE.minContrast})`;
  } else if (depth < SEAM_GATE.minDepth) {
    detail = `the groove's core averages only ${depth.toFixed(1)} luma below the darker face (< ${SEAM_GATE.minDepth}): it no longer reads as a groove`;
  }

  return {
    id: raster.target.id,
    kind: raster.target.kind,
    aId: raster.target.aId,
    bId: raster.target.bId,
    spanPx: raster.spanPx,
    gapUnits: raster.gapUnits,
    luma: lumaPerOffset,
    offsetsPx,
    faceALuma,
    faceBLuma,
    faceLuma,
    coreMinLuma,
    coreMaxLuma,
    coreMeanLuma,
    rimMaxLuma,
    coreColumns,
    brightestRgb: brightest.rgb,
    brightestClass: classifySeamPixel(brightest.rgb),
    contrast,
    depth,
    pass: detail === null,
    detail,
  };
}

/**
 * What colour a groove pixel is, from its 8-bit sRGB — the cause attribution.
 *
 * `body` is the neutral tile ivory (and its shading), `felt` is the green cloth
 * (`#1a5038` base, so green well above red and blue), `background` is the
 * near-black scene clear colour, and anything else is reported as `other` rather
 * than guessed at.
 */
export function classifySeamPixel(
  rgb: readonly [number, number, number],
): 'body' | 'felt' | 'background' | 'other' {
  const [r, g, b] = rgb;
  const brightest = Math.max(r, g, b);
  if (brightest < 45) return 'background';
  if (g - Math.max(r, b) > 18 && g > 45) return 'felt';
  if (Math.abs(r - g) < 22 && Math.abs(g - b) < 26) return 'body';
  return 'other';
}

/* -------------------------------------------------------------------------- */
/* The aliasing probe                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The anti-aliasing rule, as a number.
 *
 * Without MSAA a silhouette is a hard step: every pixel is either the tile or
 * the felt, and the edge's position jumps a whole pixel from row to row. With
 * 4x MSAA the boundary pixel's coverage is partial, so the scanline shows at
 * least one column whose value lies *between* the two surfaces. `intermediates`
 * counts those columns, and the gate requires at least one where MSAA is on.
 */
export const EDGE_GATE = {
  /** Columns between the two surfaces that count as an anti-aliased transition. */
  minIntermediates: 1,
  /** How far inside the surface's own luma a column must be to count. */
  thresholdLuma: 10,
} as const;

/** One silhouette's projected scan and the numbers read from it. */
export interface EdgeScan {
  readonly id: string;
  readonly samples: readonly SeamSample[];
  readonly block: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly spanPx: number;
}

/**
 * The outer silhouette of the human hand's leftmost tile, sampled from inside
 * its face to the felt outside it.
 *
 * That edge is the sharpest, most visible boundary on the table (ivory against
 * cloth) and it belongs to the one zone the player looks at most, so it is the
 * fairest place to ask "is this edge anti-aliased?". Returns null when the hand
 * is empty.
 */
export function edgeScan(
  layout: BoardLayout,
  frame: CameraFrame,
  widthPx: number,
  heightPx: number,
): EdgeScan | null {
  const hand = layout.foreground.filter(
    (tile) => tile.seat === layout.humanSeat && tile.zone === 'hand',
  );
  if (hand.length === 0) return null;
  // The row's own axis: "leftmost" means the same thing for every seat, so the
  // probe does not depend on which seat the human happens to sit in.
  const { right } = seatBasis(layout.humanSeat);
  const along = (position: Vec3): number => position[0] * right[0] + position[2] * right[2];
  const tile = [...hand].sort(
    (left, rightTile) => along(left.pose.position) - along(rightTile.pose.position),
  )[0];
  const box = orientedBox(tile.pose);
  const [axisX, , axisZ] = box.axes;
  // The outer edge is whichever of the tile's two X edges has no neighbour.
  const outerSign = (tile.contact & CONTACT_EDGE.minusX) === 0 ? -1 : 1;
  const halfWidth = box.halfExtents[0];
  const halfThickness = box.halfExtents[2];
  const facePoint: Vec3 = [
    box.centre[0] + axisZ[0] * halfThickness,
    box.centre[1] + axisZ[1] * halfThickness,
    box.centre[2] + axisZ[2] * halfThickness,
  ];
  const alongAxis = (units: number): Vec3 => [
    facePoint[0] + axisX[0] * outerSign * units,
    facePoint[1] + axisX[1] * outerSign * units,
    facePoint[2] + axisX[2] * outerSign * units,
  ];
  const from = alongAxis(halfWidth - 0.22);
  const to = alongAxis(halfWidth + 0.22);
  const scan = buildScan(from, to, frame, widthPx, heightPx, 2);
  return { id: 'hand-end', ...scan };
}

/** Read one silhouette scan and count its anti-aliased transition columns. */
export function readEdge(source: SeamPixelSource, scan: EdgeScan): EdgeReadingNumber {
  const { block } = scan;
  const pixels = source.read(block.x, block.y, block.width, block.height);
  const byOffset = new Map<number, number[]>();
  for (const sample of scan.samples) {
    const localX = sample.x - block.x;
    const localY = sample.y - block.y;
    if (localX < 0 || localY < 0 || localX >= block.width || localY >= block.height) continue;
    const index = (localY * block.width + localX) * 4;
    if (index + 3 >= pixels.length) continue;
    const value = luma([pixels[index], pixels[index + 1], pixels[index + 2]]);
    const list = byOffset.get(sample.offsetPx) ?? [];
    list.push(value);
    byOffset.set(sample.offsetPx, list);
  }
  const offsetsPx = [...byOffset.keys()].sort((left, right) => left - right);
  const lumaPerOffset = offsetsPx.map((offset) => median(byOffset.get(offset) ?? []));
  const lightLuma = Math.max(...lumaPerOffset);
  const darkLuma = Math.min(...lumaPerOffset);
  const low = darkLuma + EDGE_GATE.thresholdLuma;
  const high = lightLuma - EDGE_GATE.thresholdLuma;
  const intermediates = lumaPerOffset.filter((value) => value > low && value < high).length;
  let maxStep = 0;
  for (let index = 1; index < lumaPerOffset.length; index += 1) {
    maxStep = Math.max(maxStep, Math.abs(lumaPerOffset[index] - lumaPerOffset[index - 1]));
  }
  return {
    id: scan.id,
    spanPx: scan.spanPx,
    luma: lumaPerOffset,
    offsetsPx,
    lightLuma,
    darkLuma,
    intermediates,
    maxStep,
    pass: intermediates >= EDGE_GATE.minIntermediates,
  };
}
