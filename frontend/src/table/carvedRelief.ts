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
import type { ReliefCell, ReliefManifest } from './reliefManifest';
import type { AtlasCanvas, CreateAtlasCanvas, LoadAtlasImage, ResolveAssetUrl } from './TileAtlasBuilder';
import type {
  OrientationGroup,
  SlotBasis,
  TableLayoutManifest,
  TableLighting,
  Vec3,
} from './tableLayoutManifest';
import {
  groupSlotsByOrientation,
  normalizeVec3,
  reliefGroupForShell,
} from './tableLayoutManifest';
import type { FaceUpShellId } from './tiles';

/** The plan's one-step carving scale, in face-plate UV units. */
export const DEFAULT_D_CARVE = 0.018;
/** Grazing views divide by this floor instead of exploding. */
export const DEFAULT_MIN_VIEW_Z = 0.35;
/** Bare V-carve walls fade in from the un-carved surface by this factor. */
export const DEFAULT_BEVEL_GAIN = 8;
/** Enamel specular: a tight, low-gain lobe, per the plan. */
export const SPECULAR_POWER = 48;
export const SPECULAR_GAIN = 0.45;

export interface ReliefShadingFrame {
  readonly basis: SlotBasis;
  readonly viewWorld: Vec3;
  readonly viewTan: Vec3;
  readonly lightWorld: Vec3;
  readonly keyColor: Vec3;
  readonly ambientColor: Vec3;
  /** Per-channel tone match from the shell's measured flat face. */
  readonly exposure: Vec3;
  readonly dCarve: number;
  readonly minViewZ: number;
  readonly bevelGain: number;
}

export interface ReliefSample {
  /** Pigment RGB in [0, 255], as stored in `face_albedo`. */
  readonly albedo: Vec3;
  /** Paint mask in [0, 1]. */
  readonly paint: number;
  /** Tangent-space normal, unit length. */
  readonly normal: Vec3;
  /** Surface height in [0, 1] (1 un-carved, 0 deepest). */
  readonly height: number;
  readonly ao: number;
  readonly roughness: number;
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

/**
 * Step 1: the shading frame for one group. `ivorySrgb` is the shell's measured
 * flat-face sample (0-255), used only for the tone match.
 */
export function reliefShadingFrame(input: {
  readonly basis: SlotBasis;
  readonly position: Vec3;
  readonly lighting: TableLighting;
  readonly ivorySrgb: Vec3;
  readonly dCarve?: number;
  readonly minViewZ?: number;
  readonly bevelGain?: number;
}): ReliefShadingFrame {
  const viewWorld = normalizeVec3([
    input.lighting.cameraPos[0] - input.position[0],
    input.lighting.cameraPos[1] - input.position[1],
    input.lighting.cameraPos[2] - input.position[2],
  ] as const);
  const { tangent, bitangent, normal } = input.basis;
  const viewTan: Vec3 = [
    dot(viewWorld, tangent),
    dot(viewWorld, bitangent),
    dot(viewWorld, normal),
  ] as const;
  const lightWorld = normalizeVec3(input.lighting.keyLightDir);
  const flatIrradiance = Math.max(dot(normal, lightWorld), 0);
  const exposure: Vec3 = [
    srgbToLinear(input.ivorySrgb[0]) /
      Math.max(flatIrradiance * input.lighting.keyLightColor[0] + input.lighting.ambientColor[0], 1e-3),
    srgbToLinear(input.ivorySrgb[1]) /
      Math.max(flatIrradiance * input.lighting.keyLightColor[1] + input.lighting.ambientColor[1], 1e-3),
    srgbToLinear(input.ivorySrgb[2]) /
      Math.max(flatIrradiance * input.lighting.keyLightColor[2] + input.lighting.ambientColor[2], 1e-3),
  ].map((value) => clamp(value, 0.02, 4)) as unknown as Vec3;
  return {
    basis: input.basis,
    viewWorld,
    viewTan,
    lightWorld,
    keyColor: input.lighting.keyLightColor,
    ambientColor: input.lighting.ambientColor,
    exposure,
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
    sample.normal[0],
    sample.normal[1],
    sample.normal[2],
    sample.height,
    sample.ao,
    out,
    0,
  );
  return { r: out[0], g: out[1], b: out[2], a: out[3] };
}

/**
 * The scalar frame the bake loop uses. Kept separate from
 * {@link ReliefShadingFrame} so the hot path has no array allocation; the
 * public sample function above goes through the same code.
 */
export interface ReliefScalars {
  readonly t0: number; readonly t1: number; readonly t2: number;
  readonly b0: number; readonly b1: number; readonly b2: number;
  readonly n0: number; readonly n1: number; readonly n2: number;
  readonly l0: number; readonly l1: number; readonly l2: number;
  readonly v0: number; readonly v1: number; readonly v2: number;
  readonly k0: number; readonly k1: number; readonly k2: number;
  readonly a0: number; readonly a1: number; readonly a2: number;
  readonly e0: number; readonly e1: number; readonly e2: number;
  readonly bevelGain: number;
}

export function reliefScalars(frame: ReliefShadingFrame): ReliefScalars {
  const { tangent, bitangent, normal } = frame.basis;
  return {
    t0: tangent[0], t1: tangent[1], t2: tangent[2],
    b0: bitangent[0], b1: bitangent[1], b2: bitangent[2],
    n0: normal[0], n1: normal[1], n2: normal[2],
    l0: frame.lightWorld[0], l1: frame.lightWorld[1], l2: frame.lightWorld[2],
    v0: frame.viewWorld[0], v1: frame.viewWorld[1], v2: frame.viewWorld[2],
    k0: frame.keyColor[0], k1: frame.keyColor[1], k2: frame.keyColor[2],
    a0: frame.ambientColor[0], a1: frame.ambientColor[1], a2: frame.ambientColor[2],
    e0: frame.exposure[0], e1: frame.exposure[1], e2: frame.exposure[2],
    bevelGain: frame.bevelGain,
  };
}

/**
 * Step 3b, scalar version: decode the tangent normal, rotate it into world
 * space, light it and write straight-alpha sRGB bytes at `out[offset…]`.
 *
 * Allocation-free; the startup bake runs this once per decal texel.
 */
export function shadeReliefInto(
  s: ReliefScalars,
  albedoR: number,
  albedoG: number,
  albedoB: number,
  paint: number,
  normalX: number,
  normalY: number,
  normalZ: number,
  height: number,
  aoRaw: number,
  out: Uint8ClampedArray,
  offset: number,
): void {
  const inverseTangent = 1 / (Math.sqrt(normalX * normalX + normalY * normalY + normalZ * normalZ) || 1);
  const nx = normalX * inverseTangent;
  const ny = normalY * inverseTangent;
  const nz = normalZ * inverseTangent;

  // n_world = n_x*T + n_y*B + n_z*N (no sign flip; N = B x T, per the layout).
  let wx = nx * s.t0 + ny * s.b0 + nz * s.n0;
  let wy = nx * s.t1 + ny * s.b1 + nz * s.n1;
  let wz = nx * s.t2 + ny * s.b2 + nz * s.n2;
  const inverseWorld = 1 / (Math.sqrt(wx * wx + wy * wy + wz * wz) || 1);
  wx *= inverseWorld;
  wy *= inverseWorld;
  wz *= inverseWorld;

  const lambert = wx * s.l0 + wy * s.l1 + wz * s.l2;
  const nDotL = lambert > 0 ? lambert : 0;

  // Half vector, then a fixed 48-degree lobe. The q32*q16 trick avoids a
  // Math.pow per texel.
  let hx = s.l0 + s.v0;
  let hy = s.l1 + s.v1;
  let hz = s.l2 + s.v2;
  const inverseHalf = 1 / (Math.sqrt(hx * hx + hy * hy + hz * hz) || 1);
  hx *= inverseHalf;
  hy *= inverseHalf;
  hz *= inverseHalf;
  let nDotH = wx * hx + wy * hy + wz * hz;
  if (nDotH < 0) nDotH = 0;
  const q2 = nDotH * nDotH;
  const q4 = q2 * q2;
  const q8 = q4 * q4;
  const q16 = q8 * q8;
  const q32 = q16 * q16;
  const specular = paint * (q32 * q16) * SPECULAR_GAIN;

  const ao = aoRaw < 0 ? 0 : aoRaw > 1 ? 1 : aoRaw;
  const p = paint < 0 ? 0 : paint > 1 ? 1 : paint;

  // Blend pigment toward the blank tile's white where the paint mask feathers.
  const pigmentR = 1 + (srgbTable[albedoR | 0] - 1) * p;
  const pigmentG = 1 + (srgbTable[albedoG | 0] - 1) * p;
  const pigmentB = 1 + (srgbTable[albedoB | 0] - 1) * p;

  out[offset] = encodeLinear(
    (pigmentR * (s.k0 * nDotL + s.a0) * ao + specular) * s.e0,
  );
  out[offset + 1] = encodeLinear(
    (pigmentG * (s.k1 * nDotL + s.a1) * ao + specular) * s.e1,
  );
  out[offset + 2] = encodeLinear(
    (pigmentB * (s.k2 * nDotL + s.a2) * ao + specular) * s.e2,
  );

  // Cover only the carve: painted floors and the bare V-carve walls/lip. The
  // un-carved plate stays transparent for the shell's own baked shading.
  const h = height < 0 ? 0 : height > 1 ? 1 : height;
  let bevel = (1 - h) * s.bevelGain;
  if (bevel > 1) bevel = 1;
  bevel *= 1 - p;
  let coverage = p + bevel;
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
  readonly loadImage: LoadAtlasImage;
  readonly resolveUrl: ResolveAssetUrl;
  readonly createCanvas: CreateAtlasCanvas;
  readonly dCarve?: number;
  readonly minViewZ?: number;
  readonly bevelGain?: number;
}

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
  loadImage: LoadAtlasImage,
  createCanvas: CreateAtlasCanvas,
): Promise<PlatePixels> {
  const image = await loadImage(url);
  if (image.width !== expectedWidth || image.height !== expectedHeight) {
    throw new Error(
      `${url} is ${image.width}x${image.height}, expected ${expectedWidth}x${expectedHeight}`,
    );
  }
  const canvas = createCanvas(expectedWidth, expectedHeight);
  const context = canvas.getContext('2d') as CanvasRenderingContext2D | null;
  if (!context) throw new Error(`${url}: no 2D context to decode the relief atlas`);
  context.drawImage(image as unknown as CanvasImageSource, 0, 0);
  const { data } = context.getImageData(0, 0, expectedWidth, expectedHeight);
  return { width: expectedWidth, height: expectedHeight, data };
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
      const { manifest, loadImage, createCanvas, resolveUrl } = this.options;
      this.atlasPixels = Promise.all([
        loadPixels(
          resolveUrl(manifest.atlases.albedo.file),
          manifest.atlases.albedo.width,
          manifest.atlases.albedo.height,
          loadImage,
          createCanvas,
        ),
        loadPixels(
          resolveUrl(manifest.atlases.normalDepth.file),
          manifest.atlases.normalDepth.width,
          manifest.atlases.normalDepth.height,
          loadImage,
          createCanvas,
        ),
        loadPixels(
          resolveUrl(manifest.atlases.aoRoughness.file),
          manifest.atlases.aoRoughness.width,
          manifest.atlases.aoRoughness.height,
          loadImage,
          createCanvas,
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
      basis: group.basis,
      position: group.position,
      lighting: this.options.layout.lighting,
      ivorySrgb,
      ...(this.options.dCarve === undefined ? {} : { dCarve: this.options.dCarve }),
      ...(this.options.minViewZ === undefined ? {} : { minViewZ: this.options.minViewZ }),
      ...(this.options.bevelGain === undefined ? {} : { bevelGain: this.options.bevelGain }),
    });

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
    const carveShift = new Float64Array(2);

    for (let y = 0; y < height; y += 1) {
      const v = (y + 0.5) / height;
      for (let x = 0; x < width; x += 1) {
        const u = (x + 0.5) / width;

        // Step 2: the depth probe is the unshifted height; the shifted lookup
        // then supplies albedo, normal and AO exactly as the plan defines.
        samplePixel(normalDepth, cell, cellWidth, cellHeight, u, v, depth);
        carveUvOffsetInto(
          depth[3] / 255,
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

        // Decode: the normal atlas is x right / y down / z out, no sign flip.
        const index = (y * width + x) * 4;
        shadeReliefInto(
          scalars,
          albedoPixel[0],
          albedoPixel[1],
          albedoPixel[2],
          albedoPixel[3] / 255,
          (normalPixel[0] / 255) * 2 - 1,
          (normalPixel[1] / 255) * 2 - 1,
          (normalPixel[2] / 255) * 2 - 1,
          normalPixel[3] / 255,
          aoPixel[0] / 255,
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

