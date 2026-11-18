/**
 * Task 5A: world-space carved relief shading for the startup atlas.
 *
 * The renderer is 2D (Canvas 2D, no WebGL/WebGPU), so this is a **CPU startup
 * bake**, not a per-frame shader. For every `(bucket, rounded basis)` group and
 * every face it produces one lit face-plate decal, cached by
 * `(face, group key, output size, ivory calibration)`; the frame path stays a
 * single `drawImage` per tile. Nothing here runs per frame.
 *
 * Per pixel, following `2_5d_implementation_plan.md` Task 5A:
 *
 *  1. `V_world = normalize(P_cam - P_slot)`; `V_tan = (V·T, V·B, V·N)` using
 *     the slot's published basis. `P_slot` is recovered from the layout's
 *     anchor + depth with the rig camera's pinhole inverse.
 *  2. One-step groove parallax: `uv_carved = uv - (V_tan.xy / max(V_tan.z,
 *     0.35)) * (1 - h) * d_carve` with `h` from `face_normal_depth.a`. The
 *     albedo, normal and AO/roughness are re-sampled at `uv_carved`.
 *  3. `n_world = normalize(n_x*T + n_y*B + n_z*N)`; diffuse
 *     `I = max(n_world·L, 0)*C_key + C_amb`, multiplied by cavity AO; enamel
 *     specular `paintMask * pow(max(n_world·H, 0), 48) * 0.45`.
 *  4. The lit pigment / carved ivory is composited over the blank body, and
 *     the decal is cached so the atlas composition is the only per-boot cost.
 *
 * The exposure term is a tone match, not a second light: the three atlases are
 * unlit data, while the blank shells are Cycles/AgX renders. Scaling the
 * computed radiance so the flat ivory equals the shell's own measured face
 * sample keeps the carve's highlights and cavities relative to the body it
 * sits on (the human's standing hand is much darker than a pond tile), without
 * changing the key/ambient ratio the plan defines.
 */
import type { TileFaceId } from './tiles';
import { decodePng } from './pngDecoder';
import type { ReliefCell, ReliefManifest } from './reliefManifest';
import type { AtlasCanvas, CreateAtlasCanvas, ResolveAssetUrl } from './TileAtlasBuilder';
import type {
  OrientationGroup,
  SlotBasis,
  TableCamera,
  TableLayoutManifest,
  Vec3,
} from './tableLayoutManifest';
import {
  cameraAxes,
  groupSlotsByOrientation,
  normalizeVec3,
  reliefGroupForShell,
} from './tableLayoutManifest';
import type { FaceUpShellId } from './tiles';

/* ------------------------------------------------------------------------- *
 * Display light rig (a deliberate cheat, not the table's bake rig)
 * ------------------------------------------------------------------------- */

/**
 * The relief is a close-up: it can afford stronger, lower light than the
 * table scene. These lights are still **world space**, so the highlight stays
 * on the same side of the tile after a 90/180/270 rotation, but they are
 * chosen for contrast and glare rather than for matching the shell bake.
 *
 * Key: warm, low, from screen lower-left (world -x, -y, +z). It lights the
 * upper/left inner walls of a pit and drops the opposite walls into shadow.
 * Fill: cool, weak, from the opposite side, to keep the shadow side readable.
 * Rim: a warm grazing kicker from above/back for the lip and stroke tops.
 */
export interface ReliefLightConfig {
  /**
   * Around the face normal, in degrees: 0 = glyph-up, 90 = glyph-right.
   * The display rig is face-normal, like the Phase 2b decals.
   */
  readonly aroundDeg: number;
  /** Angle from the face normal: 0 head-on, 90 grazing, >90 behind. */
  readonly tiltDeg: number;
  /** Linear RGB tint. */
  readonly color: Vec3;
  readonly intensity: number;
  /** Whether the groove-shadow march applies to this light. */
  readonly castShadow?: boolean;
}

export interface ReliefLightingConfig {
  readonly key: ReliefLightConfig;
  readonly fill: ReliefLightConfig;
  readonly bounce: ReliefLightConfig;
  readonly rim: ReliefLightConfig;
  /** Linear RGB ambient fill. */
  readonly ambient: Vec3;
  /** Upward-facing surfaces get `ambient * (1 + ambientSky)`. */
  readonly ambientSky: number;
  /** Exaggerates the baked tangent normal XY for a deeper-looking carve. */
  readonly normalStrength: number;
  /** Enamel (paint) specular lobe. */
  readonly enamel: { readonly power: number; readonly gain: number };
  /** Broad resin/coat sheen on the bare ivory. */
  readonly resin: { readonly power: number; readonly gain: number };
  /** Grazing-angle ivory kicker. */
  readonly fresnel: number;
  /** A small diffuse floor so black ink still shows the carving's relief. */
  readonly inkBase: number;
  /**
   * Scale applied to the pigment albedo before tone mapping. The Phase 2b
   * decals read much brighter than a naive diffuse of the raw #A60C0C pigment;
   * this is the display cheat that brings the paint up to that level without
   * washing out the ivory.
   */
  readonly paintGain: number;
  /** Multiplier before the ACES-like tone curve. */
  readonly toneExposure: number;
  /** The decorative ivory is allowed to be brighter than the shell body. */
  readonly ivoryBoost: number;
  /** A floor so the dark standing-hand shell still gets a luminous carve. */
  readonly ivoryFloor: number;
  /**
   * Rotate the whole rig around the face normal by `-quadRotation`, exactly
   * like the Phase 2b bake. This keeps the light in the same place on screen
   * for every tile orientation.
   */
  readonly screenLock: boolean;
  /**
   * One-step directional groove shadow. `distanceUv` is the march length in
   * face UV, `lift` is the ray height over that distance in normalized carve
   * depth, `softness` feathers the blocker.
   */
  readonly shadow: {
    readonly strength: number;
    readonly distanceUv: number;
    readonly steps: number;
    readonly lift: number;
    readonly softness: number;
  };
  /** Paint bleed over the V-carve wall. */
  readonly paintSpill: {
    readonly radiusUv: number;
    readonly strength: number;
    /** Lower is a wider, softer bleed; 1 is linear. */
    readonly falloff: number;
  };
}

/**
 * The Phase 2b lying-decal rig, ported from `tools/render/decal-spec.json`.
 * The key is only 23° off the face normal from glyph-up, which is what makes
 * the old decals read bright and glossy rather than dark and uniform. Fill,
 * bounce and a behind-the-face rim are the original relative fixtures; the
 * world ambient is the old `#b9c6d6 @ 0.4`.
 *
 * Intensities are relative (the Blender rig used area-light watts and
 * distances), so they keep the same key/fill/bounce/rim ordering while the
 * per-shell exposure calibration sets the absolute level.
 */
export const DEFAULT_RELIEF_LIGHTING: ReliefLightingConfig = {
  key: {
    aroundDeg: 0,
    tiltDeg: 23.34,
    color: [1.0, 0.905, 0.776],
    intensity: 1.6,
    castShadow: true,
  },
  fill: {
    aroundDeg: 56.6,
    tiltDeg: 50.14,
    color: [0.738, 0.815, 1.0],
    intensity: 0.75,
  },
  bounce: {
    aroundDeg: 70.57,
    tiltDeg: 31.47,
    color: [0.624, 0.776, 0.65],
    intensity: 0.3,
  },
  rim: {
    aroundDeg: 9.85,
    tiltDeg: 134.14,
    color: [1.0, 1.0, 1.0],
    intensity: 0.3,
  },
  ambient: [0.22, 0.25, 0.3],
  ambientSky: 0.2,
  normalStrength: 1.15,
  enamel: { power: 70, gain: 1.1 },
  resin: { power: 16, gain: 0.35 },
  fresnel: 0.3,
  inkBase: 0.02,
  paintGain: 1.75,
  toneExposure: 1.0,
  ivoryBoost: 1.04,
  ivoryFloor: 190,
  screenLock: true,
  shadow: { strength: 0.3, distanceUv: 0.02, steps: 2, lift: 0.8, softness: 0.2 },
  paintSpill: { radiusUv: 0.038, strength: 0.98, falloff: 0.45 },
};

/** The plan's one-step carving scale, in face-plate UV units. */
export const DEFAULT_D_CARVE = 0.018;
/** Grazing views divide by this floor instead of exploding. */
export const DEFAULT_MIN_VIEW_Z = 0.35;
/** Bare V-carve walls fade in from the un-carved surface by this factor. */
export const DEFAULT_BEVEL_GAIN = 8;

export interface ReliefLightFrame {
  /** World-space direction toward the light. */
  readonly direction: Vec3;
  /** Linear RGB times intensity. */
  readonly color: Vec3;
  readonly castShadow: boolean;
}

export interface ReliefShadingFrame {
  readonly basis: SlotBasis;
  readonly viewWorld: Vec3;
  readonly viewTan: Vec3;
  readonly lights: readonly ReliefLightFrame[];
  readonly ambientColor: Vec3;
  readonly ambientSky: number;
  /** Per-channel tone match from the shell's measured flat face. */
  readonly exposure: Vec3;
  readonly normalStrength: number;
  readonly enamelPower: number;
  readonly enamelGain: number;
  readonly resinPower: number;
  readonly resinGain: number;
  readonly fresnelGain: number;
  readonly inkBase: number;
  readonly paintGain: number;
  readonly toneExposure: number;
  /** Key light's in-face direction in UV, for the groove-shadow march. */
  readonly keyShadowDir: readonly [number, number];
  readonly shadowStrength: number;
  readonly shadowDistanceUv: number;
  readonly shadowSteps: number;
  readonly shadowLift: number;
  readonly shadowSoftness: number;
  readonly dCarve: number;
  readonly minViewZ: number;
  readonly bevelGain: number;
}

export interface ReliefSample {
  /** Nearest pigment RGB in [0, 255] (from the paint or the spill). */
  readonly albedo: Vec3;
  /** Original paint mask in [0, 1]. */
  readonly paint: number;
  /** Ink mask in [0, 1]: the paint mask plus the spilled edge. */
  readonly ink?: number;
  /** Tangent-space normal, unit length. */
  readonly normal: Vec3;
  /** Surface height in [0, 1] (1 un-carved, 0 deepest). */
  readonly height: number;
  readonly ao: number;
  readonly roughness: number;
  /** Groove-shadow visibility, 1 lit … 0 blocked. Defaults to lit. */
  readonly keyShadow?: number;
}

export interface ReliefPixel {
  /** Straight-alpha sRGB bytes. */
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

const srgbTable = new Float64Array(256);
for (let byte = 0; byte < 256; byte += 1) {
  const value = byte / 255;
  srgbTable[byte] = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Linear -> sRGB byte lookup, 1/4096 steps; the output is 8-bit, so this is lossless in practice. */
const linearToSrgbTable = new Uint8Array(4097);
for (let index = 0; index <= 4096; index += 1) {
  const c = index / 4096;
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  linearToSrgbTable[index] = Math.round(clamp(encoded, 0, 1) * 255);
}

/**
 * ACES-like filmic curve, the display analogue of the old decals' AgX
 * "Medium High Contrast". It lifts the mids and rolls the highlights off
 * instead of clipping them, which is what makes the bright Phase 2b look.
 */
const TONE_STEPS = 1024;
const TONE_MAX = 8;
const toneTable = new Uint8Array(TONE_MAX * TONE_STEPS + 1);
for (let index = 0; index <= TONE_MAX * TONE_STEPS; index += 1) {
  const x = index / TONE_STEPS;
  const mapped = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  // ACES is linear; encode it back to sRGB, exactly like the old AgX output.
  toneTable[index] = linearToSrgbTable[(clamp(mapped, 0, 1) * 4096 + 0.5) | 0];
}

function encodeTone(value: number, exposure: number): number {
  const x = value * exposure;
  if (x <= 0) return 0;
  if (x >= TONE_MAX) return 255;
  return toneTable[(x * TONE_STEPS + 0.5) | 0];
}

/**
 * The linear input that tone-maps to a target sRGB byte. Used to calibrate the
 * flat ivory through the filmic curve (a linear division is not enough once
 * the tone curve is non-linear).
 */
const toneInputForByte = new Float64Array(256);
{
  let index = 0;
  for (let byte = 0; byte < 256; byte += 1) {
    while (index < toneTable.length - 1 && toneTable[index] < byte) index += 1;
    toneInputForByte[byte] = index / TONE_STEPS;
  }
}


function encodeLinear(value: number): number {
  if (value <= 0) return linearToSrgbTable[0];
  if (value >= 1) return linearToSrgbTable[4096];
  return linearToSrgbTable[(value * 4096 + 0.5) | 0];
}

/** sRGB byte -> linear [0, 1]. */
export function srgbToLinear(byte: number): number {
  return srgbTable[clamp(byte, 0, 255) | 0];
}

/** Linear [0, inf) -> sRGB byte, clipped at white. */
export function linearToSrgb(value: number): number {
  return encodeLinear(value);
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Integer power with ~log2(p) multiplies. */
function powi(base: number, exponent: number): number {
  let result = 1;
  let value = base;
  let power = exponent;
  while (power > 0) {
    if (power & 1) result *= value;
    value *= value;
    power >>= 1;
  }
  return result;
}

/**
 * The display frame for one group. `ivorySrgb` is the shell's measured flat
 * face sample; it calibrates the flat plate to the shell, while the carve is
 * lit with the deliberately dramatic {@link DEFAULT_RELIEF_LIGHTING} rig.
 */
export function reliefShadingFrame(input: {
  readonly basis: SlotBasis;
  readonly position: Vec3;
  readonly cameraPos: Vec3;
  readonly ivorySrgb: Vec3;
  /**
   * The shell quad's screen rotation. The old decal rig rotates around the
   * face normal by `-quadRotation` so the room light stays fixed on screen.
   */
  readonly quadRotationDeg: 0 | 90 | 180 | 270;
  readonly config?: ReliefLightingConfig;
  readonly dCarve?: number;
  readonly minViewZ?: number;
  readonly bevelGain?: number;
}): ReliefShadingFrame {
  const config = input.config ?? DEFAULT_RELIEF_LIGHTING;
  const viewWorld = normalizeVec3([
    input.cameraPos[0] - input.position[0],
    input.cameraPos[1] - input.position[1],
    input.cameraPos[2] - input.position[2],
  ] as const);
  const { tangent, bitangent, normal } = input.basis;
  const up: Vec3 = [-bitangent[0], -bitangent[1], -bitangent[2]] as const;
  const viewTan: Vec3 = [
    dot(viewWorld, tangent),
    dot(viewWorld, bitangent),
    dot(viewWorld, normal),
  ] as const;

  const screenRotation = config.screenLock ? input.quadRotationDeg : 0;
  const lights: ReliefLightFrame[] = [config.key, config.fill, config.bounce, config.rim].map(
    (light) => {
      const around = ((light.aroundDeg + screenRotation) * Math.PI) / 180;
      const tilt = (light.tiltDeg * Math.PI) / 180;
      const towardTangent = Math.sin(tilt) * Math.sin(around);
      const towardUp = Math.sin(tilt) * Math.cos(around);
      const towardOut = Math.cos(tilt);
      const direction = normalizeVec3([
        tangent[0] * towardTangent + up[0] * towardUp + normal[0] * towardOut,
        tangent[1] * towardTangent + up[1] * towardUp + normal[1] * towardOut,
        tangent[2] * towardTangent + up[2] * towardUp + normal[2] * towardOut,
      ] as const);
      return {
        direction,
        color: [
          light.color[0] * light.intensity,
          light.color[1] * light.intensity,
          light.color[2] * light.intensity,
        ] as const,
        castShadow: light.castShadow === true,
      };
    },
  );

  // Flat-ivory calibration includes every light that can hit the face.
  const sky = 1 + config.ambientSky * Math.max(normal[2], 0);
  const reference: Vec3 = [
    config.ambient[0] * sky,
    config.ambient[1] * sky,
    config.ambient[2] * sky,
  ] as const;
  const flat = [0, 0, 0];
  for (const light of lights) {
    const amount = Math.max(dot(normal, light.direction), 0);
    flat[0] += amount * light.color[0];
    flat[1] += amount * light.color[1];
    flat[2] += amount * light.color[2];
  }
  const ivoryTarget: Vec3 = [
    clamp(Math.max(input.ivorySrgb[0] * config.ivoryBoost, config.ivoryFloor), 0, 255),
    clamp(Math.max(input.ivorySrgb[1] * config.ivoryBoost, config.ivoryFloor), 0, 255),
    clamp(Math.max(input.ivorySrgb[2] * config.ivoryBoost, config.ivoryFloor), 0, 255),
  ] as const;
  const exposure: Vec3 = [
    toneInputForByte[Math.round(ivoryTarget[0])] / Math.max(reference[0] + flat[0], 1e-3),
    toneInputForByte[Math.round(ivoryTarget[1])] / Math.max(reference[1] + flat[1], 1e-3),
    toneInputForByte[Math.round(ivoryTarget[2])] / Math.max(reference[2] + flat[2], 1e-3),
  ].map((value) => clamp(value, 0.02, 6)) as unknown as Vec3;

  const key = lights[0].direction;
  const keyX = dot(key, tangent);
  const keyY = dot(key, bitangent);
  const keyLength = Math.hypot(keyX, keyY);

  return {
    basis: input.basis,
    viewWorld,
    viewTan,
    lights,
    ambientColor: config.ambient,
    ambientSky: config.ambientSky,
    exposure,
    normalStrength: config.normalStrength,
    enamelPower: config.enamel.power,
    enamelGain: config.enamel.gain,
    resinPower: config.resin.power,
    resinGain: config.resin.gain,
    fresnelGain: config.fresnel,
    inkBase: config.inkBase,
    paintGain: config.paintGain,
    toneExposure: config.toneExposure,
    keyShadowDir:
      keyLength > 1e-4 ? [keyX / keyLength, keyY / keyLength] : [0, 0],
    shadowStrength: config.shadow.strength,
    shadowDistanceUv: config.shadow.distanceUv,
    shadowSteps: config.shadow.steps,
    shadowLift: config.shadow.lift,
    shadowSoftness: config.shadow.softness,
    dCarve: input.dCarve ?? DEFAULT_D_CARVE,
    minViewZ: input.minViewZ ?? DEFAULT_MIN_VIEW_Z,
    bevelGain: input.bevelGain ?? DEFAULT_BEVEL_GAIN,
  };
}

/**
 * Step 2: the one-step carved-groove UV shift. Depth `h` is the unshifted
 * height at `uv`; `(1 - h)` is how far into the carve the texel sits.
 */
export function carveUvOffset(
  height: number,
  viewTan: Vec3,
  dCarve = DEFAULT_D_CARVE,
  minViewZ = DEFAULT_MIN_VIEW_Z,
): readonly [number, number] {
  const out = new Float64Array(2);
  carveUvOffsetInto(height, viewTan, dCarve, minViewZ, out, 0);
  return [out[0], out[1]] as const;
}

/** Allocation-free form used by the bake loop; writes `[u, v]` at `offset`. */
export function carveUvOffsetInto(
  height: number,
  viewTan: Vec3,
  dCarve: number,
  minViewZ: number,
  out: Float64Array,
  offset: number,
): void {
  const scale = ((1 - clamp01(height)) * dCarve) / Math.max(viewTan[2], minViewZ);
  out[offset] = -viewTan[0] * scale;
  out[offset + 1] = -viewTan[1] * scale;
}

/**
 * The shell quad's screen rotation for a slot. The Phase 2b rig rotated the
 * light by `-quadRotation`, so two tiles with the same face basis but a
 * different screen orientation get the light rotated to the same place on
 * screen. Derived from the glyph's right axis projected into the camera's
 * screen plane, so it needs no shell id.
 */
export function screenRotationOfBasis(
  basis: SlotBasis,
  camera: TableCamera,
): 0 | 90 | 180 | 270 {
  const { right, up } = cameraAxes(camera);
  let degrees =
    (Math.atan2(dot(basis.tangent, up), dot(basis.tangent, right)) * 180) / Math.PI;
  if (degrees < 0) degrees += 360;
  const wrapped = ((Math.round(degrees / 90) * 90) % 360 + 360) % 360;
  return wrapped as 0 | 90 | 180 | 270;
}

/** Step 3a: decode a tangent normal into world space. No sign flip. */
export function tangentNormalToWorld(normal: Vec3, basis: SlotBasis): Vec3 {
  return normalizeVec3([
    normal[0] * basis.tangent[0] + normal[1] * basis.bitangent[0] + normal[2] * basis.normal[0],
    normal[0] * basis.tangent[1] + normal[1] * basis.bitangent[1] + normal[2] * basis.normal[1],
    normal[0] * basis.tangent[2] + normal[1] * basis.bitangent[2] + normal[2] * basis.normal[2],
  ] as const);
}

/** Step 3b: light one sampled texel through the frame. */
export function shadeReliefSample(sample: ReliefSample, frame: ReliefShadingFrame): ReliefPixel {
  const scalars = reliefScalars(frame);
  const out = new Uint8ClampedArray(4);
  shadeReliefInto(
    scalars,
    sample.albedo[0],
    sample.albedo[1],
    sample.albedo[2],
    sample.paint,
    sample.ink ?? sample.paint,
    sample.normal[0],
    sample.normal[1],
    sample.normal[2],
    sample.height,
    sample.ao,
    sample.keyShadow ?? 1,
    out,
    0,
  );
  return { r: out[0], g: out[1], b: out[2], a: out[3] };
}

interface ScalarLight {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly shadow: boolean;
}

/**
 * The scalar frame the bake loop uses. Kept separate from
 * {@link ReliefShadingFrame} so the hot path has no per-texel allocation; the
 * public sample function above goes through the same code.
 */
export interface ReliefScalars {
  readonly t0: number; readonly t1: number; readonly t2: number;
  readonly b0: number; readonly b1: number; readonly b2: number;
  readonly n0: number; readonly n1: number; readonly n2: number;
  readonly v0: number; readonly v1: number; readonly v2: number;
  readonly lights: readonly ScalarLight[];
  readonly a0: number; readonly a1: number; readonly a2: number;
  readonly ambientSky: number;
  readonly e0: number; readonly e1: number; readonly e2: number;
  readonly normalStrength: number;
  readonly enamelPower: number; readonly enamelGain: number;
  readonly resinPower: number; readonly resinGain: number;
  readonly fresnelGain: number;
  readonly inkBase: number;
  readonly paintGain: number;
  readonly toneExposure: number;
  readonly bevelGain: number;
}

export function reliefScalars(frame: ReliefShadingFrame): ReliefScalars {
  const { tangent, bitangent, normal } = frame.basis;
  return {
    t0: tangent[0], t1: tangent[1], t2: tangent[2],
    b0: bitangent[0], b1: bitangent[1], b2: bitangent[2],
    n0: normal[0], n1: normal[1], n2: normal[2],
    v0: frame.viewWorld[0], v1: frame.viewWorld[1], v2: frame.viewWorld[2],
    lights: frame.lights.map((light) => ({
      x: light.direction[0],
      y: light.direction[1],
      z: light.direction[2],
      r: light.color[0],
      g: light.color[1],
      b: light.color[2],
      shadow: light.castShadow,
    })),
    a0: frame.ambientColor[0], a1: frame.ambientColor[1], a2: frame.ambientColor[2],
    ambientSky: frame.ambientSky,
    e0: frame.exposure[0], e1: frame.exposure[1], e2: frame.exposure[2],
    normalStrength: frame.normalStrength,
    enamelPower: frame.enamelPower, enamelGain: frame.enamelGain,
    resinPower: frame.resinPower, resinGain: frame.resinGain,
    fresnelGain: frame.fresnelGain,
    inkBase: frame.inkBase,
    paintGain: frame.paintGain,
    toneExposure: frame.toneExposure,
    bevelGain: frame.bevelGain,
  };
}

/**
 * Step 3b, scalar version: decode the tangent normal, rotate it into world
 * space, light it and write straight-alpha sRGB bytes at `out[offset…]`.
 *
 * The display cheat lives here: normal XY is exaggerated, three lights with
 * separate enamel/resin specular lobes are summed, a grazing Fresnel kicker
 * lifts the ivory lip, and the key light is multiplied by the caller's
 * groove-shadow visibility. Allocation-free; the startup bake runs this once
 * per decal texel.
 */
export function shadeReliefInto(
  s: ReliefScalars,
  pigmentR: number,
  pigmentG: number,
  pigmentB: number,
  paint: number,
  ink: number,
  normalX: number,
  normalY: number,
  normalZ: number,
  height: number,
  aoRaw: number,
  keyShadow: number,
  out: Uint8ClampedArray,
  offset: number,
): void {
  const strength = s.normalStrength;
  const inverseTangent =
    1 / (Math.sqrt(normalX * normalX * strength * strength + normalY * normalY * strength * strength + normalZ * normalZ) || 1);
  const nx = normalX * strength * inverseTangent;
  const ny = normalY * strength * inverseTangent;
  const nz = normalZ * inverseTangent;

  // n_world = n_x*T + n_y*B + n_z*N (no sign flip; N = B x T, per the layout).
  let wx = nx * s.t0 + ny * s.b0 + nz * s.n0;
  let wy = nx * s.t1 + ny * s.b1 + nz * s.n1;
  let wz = nx * s.t2 + ny * s.b2 + nz * s.n2;
  const inverseWorld = 1 / (Math.sqrt(wx * wx + wy * wy + wz * wz) || 1);
  wx *= inverseWorld;
  wy *= inverseWorld;
  wz *= inverseWorld;

  const ao = aoRaw < 0 ? 0 : aoRaw > 1 ? 1 : aoRaw;
  const paintMask = paint < 0 ? 0 : paint > 1 ? 1 : paint;
  const inkMask = ink < 0 ? 0 : ink > 1 ? 1 : ink;
  const shadow = keyShadow < 0 ? 0 : keyShadow > 1 ? 1 : keyShadow;

  // Irradiance (linear RGB) and the two specular lobes.
  const ambient = Math.max(wz, 0) * s.ambientSky + 1;
  let irradianceR = s.a0 * ambient;
  let irradianceG = s.a1 * ambient;
  let irradianceB = s.a2 * ambient;
  let enamelR = 0;
  let enamelG = 0;
  let enamelB = 0;
  let resinR = 0;
  let resinG = 0;
  let resinB = 0;
  let fresnelR = 0;
  let fresnelG = 0;
  let fresnelB = 0;

  for (const light of s.lights) {
    const lightShadow = light.shadow ? shadow : 1;
    const toward = wx * light.x + wy * light.y + wz * light.z;
    const amount = toward > 0 ? toward * lightShadow : 0;
    irradianceR += light.r * amount;
    irradianceG += light.g * amount;
    irradianceB += light.b * amount;

    let hx = light.x + s.v0;
    let hy = light.y + s.v1;
    let hz = light.z + s.v2;
    const inverseHalf = 1 / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
    hx *= inverseHalf;
    hy *= inverseHalf;
    hz *= inverseHalf;
    let nDotH = wx * hx + wy * hy + wz * hz;
    if (nDotH < 0) nDotH = 0;
    const enamel = powi(nDotH, s.enamelPower) * s.enamelGain * inkMask * lightShadow;
    const resin = powi(nDotH, s.resinPower) * s.resinGain * (1 - inkMask) * lightShadow;
    enamelR += light.r * enamel;
    enamelG += light.g * enamel;
    enamelB += light.b * enamel;
    resinR += light.r * resin;
    resinG += light.g * resin;
    resinB += light.b * resin;

    const fresnel =
      powi(1 - Math.min(Math.max(wx * s.v0 + wy * s.v1 + wz * s.v2, 0), 1), 3) *
      s.fresnelGain *
      (1 - inkMask) *
      lightShadow;
    fresnelR += light.r * fresnel;
    fresnelG += light.g * fresnel;
    fresnelB += light.b * fresnel;
  }

  // Blend the nearest pigment toward the blank tile's white with the ink mask:
  // this is also what makes the spill read as paint creeping over the lip.
  const base = s.inkBase * inkMask;
  const pigmentRl =
    1 + (Math.min(1, srgbTable[pigmentR | 0] * s.paintGain) - 1) * inkMask + base;
  const pigmentGl =
    1 + (Math.min(1, srgbTable[pigmentG | 0] * s.paintGain) - 1) * inkMask + base;
  const pigmentBl =
    1 + (Math.min(1, srgbTable[pigmentB | 0] * s.paintGain) - 1) * inkMask + base;

  out[offset] = encodeTone(
    (pigmentRl * irradianceR * ao + enamelR + resinR + fresnelR) * s.e0,
    s.toneExposure,
  );
  out[offset + 1] = encodeTone(
    (pigmentGl * irradianceG * ao + enamelG + resinG + fresnelG) * s.e1,
    s.toneExposure,
  );
  out[offset + 2] = encodeTone(
    (pigmentBl * irradianceB * ao + enamelB + resinB + fresnelB) * s.e2,
    s.toneExposure,
  );

  // Cover only the carve: painted floors and the bare V-carve walls/lip. The
  // un-carved plate stays transparent for the shell's own baked shading.
  const h = height < 0 ? 0 : height > 1 ? 1 : height;
  let bevel = (1 - h) * s.bevelGain;
  if (bevel > 1) bevel = 1;
  bevel *= 1 - paintMask;
  let coverage = paintMask + bevel;
  if (coverage > 1) coverage = 1;
  out[offset + 3] = (coverage * 255 + 0.5) | 0;
}


/* ------------------------------------------------------------------------- *
 * Atlas pixels and the startup decal cache
 * ------------------------------------------------------------------------- */

interface PlatePixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export interface BakedReliefFace {
  readonly face: TileFaceId;
  readonly groupKey: string;
  readonly basis: SlotBasis;
  /** The representative slot's recovered world position. */
  readonly position: Vec3;
  readonly canvas: AtlasCanvas;
  readonly width: number;
  readonly height: number;
  /** Pixels whose decal alpha is non-zero; a zero count means a blank face. */
  readonly carvedPixels: number;
  /** The largest output luminance byte (0-255) in the decal. */
  readonly maxLuminance: number;
}

export interface CarvedReliefStats {
  readonly groups: number;
  readonly bakes: number;
  readonly cacheHits: number;
  readonly bakeMs: number;
  readonly atlasLoadMs: number;
  readonly cacheEntries: number;
}

export interface CarvedReliefOptions {
  readonly manifest: ReliefManifest;
  readonly layout: TableLayoutManifest;
  /**
   * Raw PNG bytes for the relief atlases. A Canvas must NOT be used here: it
   * premultiplies the normal RGB by the height alpha and destroys the normal
   * wherever the carve is deep (see `pngDecoder.ts`).
   */
  readonly loadBytes: LoadAtlasBytes;
  readonly resolveUrl: ResolveAssetUrl;
  readonly createCanvas: CreateAtlasCanvas;
  readonly dCarve?: number;
  readonly minViewZ?: number;
  readonly bevelGain?: number;
  /** Display-only relief light rig; defaults to {@link DEFAULT_RELIEF_LIGHTING}. */
  readonly lighting?: ReliefLightingConfig;
}

/** Fetch a PNG as raw bytes (no image decode). */
export type LoadAtlasBytes = (url: string) => Promise<Uint8Array>;

const now = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

function createImageData(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): ImageData {
  return context.createImageData(width, height);
}

/** Bilinear sample of one source pixel, clamped to the cell. */
function samplePixel(
  atlas: PlatePixels,
  cell: ReliefCell,
  cellWidth: number,
  cellHeight: number,
  u: number,
  v: number,
  out: Uint8Array | Uint8ClampedArray,
): void {
  const fx = cell.x + clamp01(u) * (cellWidth - 1);
  const fy = cell.y + clamp01(v) * (cellHeight - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, cell.x + cellWidth - 1);
  const y1 = Math.min(y0 + 1, cell.y + cellHeight - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const { width, data } = atlas;
  const i00 = (y0 * width + x0) * 4;
  const i10 = (y0 * width + x1) * 4;
  const i01 = (y1 * width + x0) * 4;
  const i11 = (y1 * width + x1) * 4;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  // Unrolled: the bake calls this three times per texel, and a channel loop
  // costs as much as the bilinear itself.
  out[0] =
    (data[i00] * w00 + data[i10] * w10 + data[i01] * w01 + data[i11] * w11 + 0.5) | 0;
  out[1] =
    (data[i00 + 1] * w00 + data[i10 + 1] * w10 + data[i01 + 1] * w01 + data[i11 + 1] * w11 + 0.5) | 0;
  out[2] =
    (data[i00 + 2] * w00 + data[i10 + 2] * w10 + data[i01 + 2] * w01 + data[i11 + 2] * w11 + 0.5) | 0;
  out[3] =
    (data[i00 + 3] * w00 + data[i10 + 3] * w10 + data[i01 + 3] * w01 + data[i11 + 3] * w11 + 0.5) | 0;
}

async function loadPixels(
  url: string,
  expectedWidth: number,
  expectedHeight: number,
  loadBytes: LoadAtlasBytes,
): Promise<PlatePixels> {
  const png = await decodePng(await loadBytes(url), url);
  if (png.width !== expectedWidth || png.height !== expectedHeight) {
    throw new Error(
      `${url} is ${png.width}x${png.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  return { width: png.width, height: png.height, data: png.data };
}

/**
 * The startup bake and its cache. One instance per atlas builder. The cache
 * key contains the face, the `(bucket, rounded basis)` group, the output size
 * and the shell's ivory calibration, so a rotated riichi tile can never hit
 * another orientation's decal.
 */
export class CarvedReliefBakery {
  private readonly options: CarvedReliefOptions;
  private readonly groups: readonly OrientationGroup[];
  private atlasPixels: Promise<{
    readonly albedo: PlatePixels;
    readonly normalDepth: PlatePixels;
    readonly aoRoughness: PlatePixels;
  }> | null = null;
  private readonly cache = new Map<string, Promise<BakedReliefFace | null>>();
  private readonly spillCache = new Map<TileFaceId, PlatePixels>();
  private bakes = 0;
  private cacheHits = 0;
  private bakeMs = 0;
  private atlasLoadMs = 0;
  private disabled = false;

  constructor(options: CarvedReliefOptions) {
    this.options = options;
    this.groups = groupSlotsByOrientation(options.layout);
  }

  /** The layout orientation groups this bakery can shade. */
  get orientationGroups(): readonly OrientationGroup[] {
    return this.groups;
  }

  /** Resolve a face-up shell to the group of the slot its camera was built for. */
  groupForShell(shell: FaceUpShellId): OrientationGroup | null {
    return reliefGroupForShell(this.options.layout, shell, this.groups);
  }

  private async atlases(): Promise<{
    readonly albedo: PlatePixels;
    readonly normalDepth: PlatePixels;
    readonly aoRoughness: PlatePixels;
  }> {
    if (!this.atlasPixels) {
      const started = now();
      const { manifest, loadBytes, resolveUrl } = this.options;
      this.atlasPixels = Promise.all([
        loadPixels(
          resolveUrl(manifest.atlases.albedo.file),
          manifest.atlases.albedo.width,
          manifest.atlases.albedo.height,
          loadBytes,
        ),
        loadPixels(
          resolveUrl(manifest.atlases.normalDepth.file),
          manifest.atlases.normalDepth.width,
          manifest.atlases.normalDepth.height,
          loadBytes,
        ),
        loadPixels(
          resolveUrl(manifest.atlases.aoRoughness.file),
          manifest.atlases.aoRoughness.width,
          manifest.atlases.aoRoughness.height,
          loadBytes,
        ),
      ]).then(([albedo, normalDepth, aoRoughness]) => {
        this.atlasLoadMs += now() - started;
        return { albedo, normalDepth, aoRoughness };
      });
    }
    return this.atlasPixels;
  }

  /**
   * Bake (or reuse) one lit face plate. Returns null when the face has no
   * relief cell (`blank`), so the caller keeps the Task 5 fallback.
   */
  async decalFor(
    face: TileFaceId,
    group: OrientationGroup,
    width: number,
    height: number,
    ivorySrgb: Vec3,
  ): Promise<BakedReliefFace | null> {
    const cell = this.options.manifest.cells[face];
    if (!cell || this.disabled) return null;
    const key = [
      face,
      group.key,
      `${Math.max(1, Math.round(width))}x${Math.max(1, Math.round(height))}`,
      ivorySrgb.map((value) => Math.round(value)).join(','),
    ].join('@');
    const cached = this.cache.get(key);
    if (cached) {
      this.cacheHits += 1;
      return cached;
    }
    // A missing or corrupt relief atlas must not fail the whole board: the
    // face falls back to the Task 5 carved decal / flat glyph, and every later
    // face skips the bakery instead of retrying the same 404.
    const pending = this.bake(
      face,
      cell,
      group,
      Math.max(1, Math.round(width)),
      Math.max(1, Math.round(height)),
      ivorySrgb,
    ).catch((error: unknown) => {
      this.disabled = true;
      console.warn(`carved relief disabled: ${String(error)}`);
      return null;
    });
    this.cache.set(key, pending);
    return pending;
  }

  /**
   * A nearest-painted-pixel bleed map for one face, at the source cell
   * resolution. RGB is the nearest paint colour, A is the spill strength.
   * This is the display cheat that lets the enamel creep over the V-carve
   * wall instead of stopping exactly at the stroke outline.
   */
  private spillFor(
    face: TileFaceId,
    albedo: PlatePixels,
    cellWidth: number,
    cellHeight: number,
  ): PlatePixels {
    const cached = this.spillCache.get(face);
    if (cached) return cached;
    const cell = this.options.manifest.cells[face];
    const count = cellWidth * cellHeight;
    const distance = new Int32Array(count).fill(-1);
    const color = new Uint8ClampedArray(count * 3);
    const queue = new Int32Array(count);
    let head = 0;
    let tail = 0;
    for (let y = 0; y < cellHeight; y += 1) {
      for (let x = 0; x < cellWidth; x += 1) {
        const source = ((cell.y + y) * albedo.width + cell.x + x) * 4;
        if (albedo.data[source + 3] <= 128) continue;
        const index = y * cellWidth + x;
        distance[index] = 0;
        color[index * 3] = albedo.data[source];
        color[index * 3 + 1] = albedo.data[source + 1];
        color[index * 3 + 2] = albedo.data[source + 2];
        queue[tail] = index;
        tail += 1;
      }
    }
    const radius = Math.max(
      1,
      Math.round((this.options.lighting ?? DEFAULT_RELIEF_LIGHTING).paintSpill.radiusUv * cellWidth),
    );
    while (head < tail) {
      const index = queue[head];
      head += 1;
      const step = distance[index];
      if (step >= radius) continue;
      const x = index % cellWidth;
      const y = (index - x) / cellWidth;
      for (let direction = 0; direction < 4; direction += 1) {
        const nx = x + (direction === 0 ? -1 : direction === 1 ? 1 : 0);
        const ny = y + (direction === 2 ? -1 : direction === 3 ? 1 : 0);
        if (nx < 0 || ny < 0 || nx >= cellWidth || ny >= cellHeight) continue;
        const neighbor = ny * cellWidth + nx;
        if (distance[neighbor] !== -1) continue;
        distance[neighbor] = step + 1;
        color[neighbor * 3] = color[index * 3];
        color[neighbor * 3 + 1] = color[index * 3 + 1];
        color[neighbor * 3 + 2] = color[index * 3 + 2];
        queue[tail] = neighbor;
        tail += 1;
      }
    }
    const spill = (this.options.lighting ?? DEFAULT_RELIEF_LIGHTING).paintSpill;
    const data = new Uint8ClampedArray(count * 4);
    for (let index = 0; index < count; index += 1) {
      const step = distance[index];
      if (step < 0) continue;
      const t = 1 - step / radius;
      const alpha = spill.strength * t ** spill.falloff;
      data[index * 4] = color[index * 3];
      data[index * 4 + 1] = color[index * 3 + 1];
      data[index * 4 + 2] = color[index * 3 + 2];
      data[index * 4 + 3] = Math.round(clamp01(alpha) * 255);
    }
    const result: PlatePixels = { width: cellWidth, height: cellHeight, data };
    this.spillCache.set(face, result);
    return result;
  }

  private async bake(
    face: TileFaceId,
    cell: ReliefCell,
    group: OrientationGroup,
    width: number,
    height: number,
    ivorySrgb: Vec3,
  ): Promise<BakedReliefFace> {
    const { albedo, normalDepth, aoRoughness } = await this.atlases();
    const started = now();
    const { cellWidth, cellHeight } = this.options.manifest.raster;
    const frame = reliefShadingFrame({
      quadRotationDeg: screenRotationOfBasis(group.basis, this.options.layout.camera),
      basis: group.basis,
      position: group.position,
      cameraPos: this.options.layout.lighting.cameraPos,
      ivorySrgb,
      ...(this.options.lighting === undefined ? {} : { config: this.options.lighting }),
      ...(this.options.dCarve === undefined ? {} : { dCarve: this.options.dCarve }),
      ...(this.options.minViewZ === undefined ? {} : { minViewZ: this.options.minViewZ }),
      ...(this.options.bevelGain === undefined ? {} : { bevelGain: this.options.bevelGain }),
    });
    const spill = this.spillFor(face, albedo, cellWidth, cellHeight);
    const spillCell = {
      face,
      index: 0,
      column: 0,
      row: 0,
      x: 0,
      y: 0,
      rect: [0, 0, 1, 1] as const,
    };

    const canvas = this.options.createCanvas(width, height);
    const context = canvas.getContext('2d') as CanvasRenderingContext2D | null;
    if (!context) throw new Error(`carved relief: no 2D context for ${face}`);
    const image = createImageData(context, width, height);
    const target = image.data;
    const scalars = reliefScalars(frame);
    let carvedPixels = 0;
    let maxLuminance = 0;

    const depth = new Uint8ClampedArray(4);
    const albedoPixel = new Uint8ClampedArray(4);
    const normalPixel = new Uint8ClampedArray(4);
    const aoPixel = new Uint8ClampedArray(4);
    const spillPixel = new Uint8ClampedArray(4);
    const ahead = new Uint8ClampedArray(4);
    const carveShift = new Float64Array(2);
    const [shadowX, shadowY] = frame.keyShadowDir;
    const shadowEnabled = frame.shadowStrength > 0 && (shadowX !== 0 || shadowY !== 0);

    for (let y = 0; y < height; y += 1) {
      const v = (y + 0.5) / height;
      for (let x = 0; x < width; x += 1) {
        const u = (x + 0.5) / width;

        // Step 2: the depth probe is the unshifted height; the shifted lookup
        // then supplies albedo, normal and AO exactly as the plan defines.
        samplePixel(normalDepth, cell, cellWidth, cellHeight, u, v, depth);
        const probeHeight = depth[3] / 255;
        carveUvOffsetInto(
          probeHeight,
          frame.viewTan,
          frame.dCarve,
          frame.minViewZ,
          carveShift,
          0,
        );
        const carvedU = u + carveShift[0];
        const carvedV = v + carveShift[1];

        samplePixel(albedo, cell, cellWidth, cellHeight, carvedU, carvedV, albedoPixel);
        samplePixel(normalDepth, cell, cellWidth, cellHeight, carvedU, carvedV, normalPixel);
        samplePixel(aoRoughness, cell, cellWidth, cellHeight, carvedU, carvedV, aoPixel);
        samplePixel(spill, spillCell, cellWidth, cellHeight, carvedU, carvedV, spillPixel);

        // Directional groove shadow: march the height field toward the key.
        // The terrain blocks when it rises above the ray (depth falls below
        // `depthHere - ray`). Two steps make the far wall read as a cast
        // shadow without a real shadow map.
        let keyShadow = 1;
        if (shadowEnabled) {
          const depthHere = 1 - probeHeight;
          let block = 0;
          for (let step = 1; step <= frame.shadowSteps; step += 1) {
            const t = step / frame.shadowSteps;
            samplePixel(
              normalDepth,
              cell,
              cellWidth,
              cellHeight,
              u + shadowX * frame.shadowDistanceUv * t,
              v + shadowY * frame.shadowDistanceUv * t,
              ahead,
            );
            const depthAhead = 1 - ahead[3] / 255;
            const amount = (depthHere - frame.shadowLift * t - depthAhead) / frame.shadowSoftness;
            if (amount > block) block = amount;
          }
          keyShadow = 1 - frame.shadowStrength * clamp01(block);
        }

        const paint = albedoPixel[3] / 255;
        const spilled = spillPixel[3] / 255;
        const ink = Math.max(paint, spilled);
        const pigmentR = spilled > paint ? spillPixel[0] : albedoPixel[0];
        const pigmentG = spilled > paint ? spillPixel[1] : albedoPixel[1];
        const pigmentB = spilled > paint ? spillPixel[2] : albedoPixel[2];

        // Decode: the normal atlas is x right / y down / z out, no sign flip.
        const index = (y * width + x) * 4;
        shadeReliefInto(
          scalars,
          pigmentR,
          pigmentG,
          pigmentB,
          paint,
          ink,
          (normalPixel[0] / 255) * 2 - 1,
          (normalPixel[1] / 255) * 2 - 1,
          (normalPixel[2] / 255) * 2 - 1,
          normalPixel[3] / 255,
          aoPixel[0] / 255,
          keyShadow,
          target,
          index,
        );
        const alpha = target[index + 3];
        if (alpha > 0) carvedPixels += 1;
        const luminance =
          target[index] > target[index + 1]
            ? target[index] > target[index + 2]
              ? target[index]
              : target[index + 2]
            : target[index + 1] > target[index + 2]
              ? target[index + 1]
              : target[index + 2];
        if (luminance > maxLuminance) maxLuminance = luminance;
      }
    }

    context.putImageData(image, 0, 0);
    this.bakes += 1;
    this.bakeMs += now() - started;
    return {
      face,
      groupKey: group.key,
      basis: group.basis,
      position: group.position,
      canvas,
      width,
      height,
      carvedPixels,
      maxLuminance,
    };
  }

  /** Drop the source atlases and the decal cache (called once the atlas is built). */
  release(): void {
    this.atlasPixels = null;
    this.cache.clear();
    this.spillCache.clear();
  }

  get stats(): CarvedReliefStats {
    return {
      groups: this.groups.length,
      bakes: this.bakes,
      cacheHits: this.cacheHits,
      bakeMs: this.bakeMs,
      atlasLoadMs: this.atlasLoadMs,
      cacheEntries: this.cache.size,
    };
  }
}

