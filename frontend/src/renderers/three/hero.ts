/**
 * The hero tile arrangement (3D-05).
 *
 * 3D-05 proves the carved look on one tile before 3D-07 scales it to a board,
 * and the handoff has to answer questions about four different *attitudes*:
 * the reclined human hand, a flat pond discard, the face-up dora indicator on
 * the wall, and a face-down wall tile's blue back. Rather than invent a review
 * layout, this module places the hero tile at those four **real** committed
 * positions with the **real** committed attitudes (the same numbers
 * `boardLayout.ts` uses), so the incidence angle, the on-screen size and the
 * lighting context are the ones the board will have:
 *
 * | slot | where | attitude |
 * | --- | --- | --- |
 * | `hand` | the human hand's centre slot, radius 10.6 | reclined 40° about its far bottom edge |
 * | `pond` | the human pond's nearest row centre | lying face-up (`tiltDeg -90`) |
 * | `wall` | the far wall's first dora indicator, top tier | lying face-up, oriented the human's way |
 * | `back` | the next stack on the far wall's top tier | lying face-down (`tiltDeg +90`) |
 *
 * Facts are therefore measured, not asserted: the pond sees the plate ~40° off
 * normal and the reclined hand ~10°, which is where the parallax budget's
 * numbers come from, and the hand is the largest tile on screen exactly as the
 * plan's fill-rate notes say.
 *
 * Pure module: pose math is `boardLayout`'s (one convention for the whole
 * chain), the camera is `boardLayout.frameForAspect` (the chain's single
 * projection source since 3D-07, §2.4), and nothing here imports three or
 * touches the DOM. `Scene.ts` turns these values into an `InstancedMesh`;
 * `probes.ts` projects the probe points.
 */

import type { TileFaceId } from '../contract';
import { DORA, HAND, POND, TILE, WALL } from '../layoutConstants';
import {
  poseAxes,
  poseMatrix,
  seatPoint,
  frameForAspect,
  handRadius,
  wallRunRadius,
  wallTierHeightUnits,
} from './boardLayout';
import type { TilePose, Vec3 } from './boardLayout';
import { POM_HEIGHT_SCALE, parallaxTexels } from './tileMaterial';
import type { ParallaxReading } from './tileMaterial';

/** The four attitudes the hero handoff judges. */
export type HeroSlotId = 'hand' | 'pond' | 'wall' | 'back';

/** One hero tile: which face it shows, whether it is face-up and how it sits. */
export interface HeroSlot {
  readonly id: HeroSlotId;
  readonly label: string;
  /** The baked face id. The face-down slot's id is irrelevant but never blank. */
  readonly face: TileFaceId;
  readonly faceUp: boolean;
  readonly pose: TilePose;
}

const DEG = Math.PI / 180;

/** The committed tile body size along its own axes. */
const TILE_SIZE: Vec3 = [TILE.widthUnits, TILE.heightUnits, TILE.thicknessUnits];

/**
 * The human hand's reclined pose, reproducing `boardLayout.handPose`'s
 * committed geometry: the tile stands on its far bottom edge at
 * `HAND.backRadiusUnits` and leans back `HAND.reclineDeg` about that edge, so
 * the body centre moves with the tilt.
 */
function handHeroPose(): TilePose {
  const tiltDeg = -HAND.reclineDeg;
  const phi = tiltDeg * DEG;
  const u0 = TILE.thicknessUnits / 2;
  const v0 = TILE.heightUnits / 2;
  const du = u0 * Math.cos(phi) + v0 * Math.sin(phi);
  const dv = v0 * Math.cos(phi) - u0 * Math.sin(phi);
  return {
    // The human is an end seat, so the hero hand sits at the end-run radius.
    position: seatPoint(0, 0, handRadius(0, 0) + du, dv),
    yawDeg: 0,
    tiltDeg,
    rollDeg: 0,
    sizeUnits: TILE_SIZE,
  };
}

/** A lying tile (pond or dora): face-up, body centre half a thickness up. */
function lyingHeroPose(
  seat: 0 | 2,
  u: number,
  v: number,
  w = 0,
  yawDeg = 0,
): TilePose {
  return {
    position: seatPoint(seat, w, u, v),
    yawDeg,
    tiltDeg: -90,
    rollDeg: 0,
    sizeUnits: TILE_SIZE,
  };
}

/**
 * The dead wall's stack centre line for a stack index.
 *
 * Both hero slots on the far run are dead-wall positions (the first dora
 * indicator and the blue-backed stack just inboard of the five indicator
 * stacks), so they ride the same deliberate dead-wall offset the board uses.
 */
function wallStackW(stack: number): number {
  return (
    (stack - (WALL.stacksPerRun - 1) / 2) * WALL.stackPitchUnits +
    WALL.deadWallGapUnits
  );
}

/** The top tier's body centre height (the layout's own formula). */
const WALL_TOP_TIER_UNITS = wallTierHeightUnits(DORA.tier);

/** The first dora indicator's stack: one in from the missing draw-end top. */
const DORA_STACK = WALL.drawEndSlot - 1;

/**
 * The stack whose top-tier face-down tile shows the blue back. It sits just
 * beyond the five stacks a game can reveal dora indicators on, so it is a wall
 * tile in every state (and visible, on the far wall's top tier).
 */
const BACK_STACK = DORA_STACK - DORA.maxIndicators;

/**
 * The hero slots, top to bottom of the screen's reading order. The hand's face
 * carries ink (a `1m`), the pond's is Haku (`5z`, the white dragon whose
 * symbol-only art has no printed mark at all), the dora is East, and the wall
 * tile shows its blue back.
 */
export const HERO_SLOTS: readonly HeroSlot[] = [
  {
    id: 'hand',
    label: 'human hand (reclined 40°)',
    face: '1p',
    faceUp: true,
    pose: handHeroPose(),
  },
  {
    id: 'pond',
    label: 'pond (lying face-up)',
    face: '5z',
    faceUp: true,
    pose: lyingHeroPose(
      0,
      POND.rowRadiiUnits[POND.overflowRow],
      TILE.thicknessUnits / 2,
    ),
  },
  {
    id: 'wall',
    label: 'dora indicator (far wall, face-up)',
    face: '1z',
    faceUp: true,
    // The hero view is the human-at-seat-0 board, where run 2 is the far (inset)
  // run; `boardLayout.wallRunRadius` is the same rule the layout applies.
  pose: lyingHeroPose(
    2,
    wallRunRadius(2, 0),
    WALL_TOP_TIER_UNITS,
    wallStackW(DORA_STACK),
  ),
  },
  {
    id: 'back',
    label: 'wall tile (face-down, blue back)',
    face: '3z',
    faceUp: false,
    pose: {
      // The far seat's frame: its right is -X, which is what turns the wall run
      // (and the back's 180° yaw) the same way the board does.
      position: seatPoint(
        2,
        wallStackW(BACK_STACK),
        wallRunRadius(2, 0),
        WALL_TOP_TIER_UNITS,
      ),
      yawDeg: 180,
      tiltDeg: 90,
      rollDeg: 0,
      sizeUnits: TILE_SIZE,
    },
  },
];

/** One instance's data for the renderer, independent of three's classes. */
export interface HeroInstance {
  readonly slot: HeroSlot;
  /** Column-major 4 x 4, as `poseMatrix` publishes it. */
  readonly matrix: readonly number[];
  /** Normalized atlas rect `[u0, v0, u1, v1]`, or null when the face has no art. */
  readonly atlasRect: readonly [number, number, number, number] | null;
}

/** The rect a face with no baked art (or an un-sampled back) declares. */
const NEUTRAL_RECT = [0, 0, 1, 1] as const;

/** Build the four instances, resolving each baked face to its atlas cell. */
export function heroInstances(
  cellForFace: (face: TileFaceId) =>
    | { readonly rect: readonly [number, number, number, number] }
    | null,
): readonly HeroInstance[] {
  return HERO_SLOTS.map((slot) => ({
    slot,
    matrix: poseMatrix(slot.pose),
    // A face-down tile never samples the atlas; giving it the neutral rect keeps
    // the attribute buffer uniform without inventing art.
    atlasRect: slot.faceUp
      ? (cellForFace(slot.face)?.rect ?? NEUTRAL_RECT)
      : NEUTRAL_RECT,
  }));
}

/**
 * Probe points in the plate's own UV space (V down, like the atlas cells).
 *
 * `ink` is the widest point of *distinct* paint on the hero hand's face (a
 * colour at least ΔE 25 from the ivory, so a white part of the artwork does
 * not count) — a distance transform over the committed albedo atlas. For `1p`
 * that is a 22-texel-wide navy band at 11.2 texels of clearance; the earlier
 * `1m` stroke offered 15.7. A 5 x 5 read-back is therefore guaranteed to be
 * inside the paint. It is reused on Haku on purpose: the same point must be
 * *clean* there, because Haku has no printed mark at all.
 */
export const HERO_PROBE_UV = {
  ink: { u: 0.5684, v: 0.7985 },
  centre: { u: 0.5, v: 0.5 },
} as const;

/** The plate's half-size, for turning UV into a local tile point. */
const PLATE_HALF_WIDTH_UNITS = TILE.facePlateWidthUnits / 2;
const PLATE_HALF_HEIGHT_UNITS = TILE.facePlateHeightUnits / 2;

/**
 * A plate UV as a point in the tile's local frame. The face plate sits at
 * `+thickness/2`; a face-down tile shows the same UV mapping on its `-Z` back.
 */
export function probeLocalPoint(
  slot: HeroSlot,
  uv: { readonly u: number; readonly v: number },
): Vec3 {
  return [
    (uv.u - 0.5) * 2 * PLATE_HALF_WIDTH_UNITS,
    (0.5 - uv.v) * 2 * PLATE_HALF_HEIGHT_UNITS,
    (slot.faceUp ? 1 : -1) * (TILE.thicknessUnits / 2),
  ];
}

/**
 * A point on the visible front bevel, just outside the plate, for the "side"
 * probe. The reclined hand's vertical sides are nearly edge-on, so the bevel
 * between the plate and the body edge is the honest sample of the ivory body
 * that is not the carved face.
 */
export function bevelLocalPoint(): Vec3 {
  const halfWidth = TILE.widthUnits / 2;
  const halfThickness = TILE.thicknessUnits / 2;
  const bevel = TILE.bevelUnits;
  return [
    halfWidth - bevel * 0.5,
    0,
    halfThickness - bevel * 0.5,
  ];
}

function applyMatrix(matrix: readonly number[], point: Vec3): Vec3 {
  return [
    matrix[0] * point[0] + matrix[4] * point[1] + matrix[8] * point[2] + matrix[12],
    matrix[1] * point[0] + matrix[5] * point[1] + matrix[9] * point[2] + matrix[13],
    matrix[2] * point[0] + matrix[6] * point[1] + matrix[10] * point[2] + matrix[14],
  ];
}

/** A slot-local point in world space. */
export function slotWorldPoint(slot: HeroSlot, local: Vec3): Vec3 {
  return applyMatrix(poseMatrix(slot.pose), local);
}

/** A slot's column-major model matrix (the same one the hero mesh draws with). */
export function heroPoseMatrix(slot: HeroSlot): readonly number[] {
  return poseMatrix(slot.pose);
}

/**
 * The normal of the surface the camera actually sees: the plate's +Z for a
 * face-up tile, and the blue back's -Z for a face-down one. Used by the probe
 * prediction, never by the parallax bound (a face-down tile has no carving).
 */
export function heroVisibleNormal(slot: HeroSlot): Vec3 {
  const [x, y, z] = poseAxes(slot.pose)[2];
  return slot.faceUp ? [x, y, z] : [-x, -y, -z];
}

/** One slot's incidence angle and parallax displacement at one aspect. */
export interface HeroSlotParallax extends ParallaxReading {
  readonly slot: HeroSlotId;
  readonly label: string;
}

/** The hero parallax report for one viewport aspect. */
export interface HeroParallaxReport {
  readonly aspect: number;
  /** The displacement scale the material applied (see {@link POM_HEIGHT_SCALE}). */
  readonly heightScale: number;
  readonly slots: readonly HeroSlotParallax[];
  /** The largest displacement across the four slots (what the gate bounds). */
  readonly worst: HeroSlotParallax;
}

function angleToEyeDeg(slot: HeroSlot, eye: Vec3): number {
  const normal = poseAxes(slot.pose)[2];
  const centre = slot.pose.position;
  const toEye: Vec3 = [eye[0] - centre[0], eye[1] - centre[1], eye[2] - centre[2]];
  const length = Math.hypot(toEye[0], toEye[1], toEye[2]) || 1;
  const cosine = Math.min(
    1,
    Math.max(-1, (normal[0] * toEye[0] + normal[1] * toEye[1] + normal[2] * toEye[2]) / length),
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

/**
 * Measure the four hero slots at one viewport aspect: the exact angle between
 * each plate's face normal and the ray from the plate to the committed camera,
 * and the full-depth displacement that angle implies at the committed carve
 * depth. The eye comes from 3D-06's solved frame — from 3D-07 on, the single
 * projection source for the whole 3D chain (§2.4), so the hero view and the
 * board see exactly the same camera.
 */
export function heroParallaxAt(
  aspect: number,
  heightScale: number = POM_HEIGHT_SCALE,
): HeroParallaxReport {
  const frame = frameForAspect(aspect);
  const slots = HERO_SLOTS.map((slot) => {
    const angle = slot.faceUp ? angleToEyeDeg(slot, frame.eye) : 0;
    // A face-down tile shows no carving, so only the three face-up slots can
    // contribute a displacement.
    const reading = parallaxTexels(slot.faceUp ? angle : 0, { heightScale });
    return { slot: slot.id, label: slot.label, ...reading };
  });
  let worst = slots[0];
  for (const entry of slots) if (entry.texels > worst.texels) worst = entry;
  return { aspect: frame.aspect, heightScale, slots, worst };
}

/** The report at every aspect the framing solver must support. */
export function heroParallaxAllAspects(
  aspects: readonly number[],
  heightScale: number = POM_HEIGHT_SCALE,
): readonly HeroParallaxReport[] {
  return aspects.map((aspect) => heroParallaxAt(aspect, heightScale));
}

/** Which slot a probe point belongs to, for the read-back. */
export interface ProbePointSpec {
  readonly slot: HeroSlotId;
  readonly uv?: { readonly u: number; readonly v: number };
  /** Sample the front bevel instead of the plate. */
  readonly bevel?: boolean;
}

/** The world point a probe reads, from the hero slot it names. */
export function probeWorldPoint(spec: ProbePointSpec): Vec3 {
  const slot = HERO_SLOTS.find((entry) => entry.id === spec.slot);
  if (!slot) throw new Error(`unknown hero slot ${String(spec.slot)}`);
  if (spec.bevel) return slotWorldPoint(slot, bevelLocalPoint());
  if (!spec.uv) throw new Error(`probe on ${spec.slot} needs a plate uv`);
  return slotWorldPoint(slot, probeLocalPoint(slot, spec.uv));
}
