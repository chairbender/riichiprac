/**
 * The carved tile material (3D-05): the shader program, its uniforms, the POM
 * step tiers and the numeric parallax bound. Since 3D-07 one material also
 * draws the whole board, so it owns the per-instance highlight/dim ranges the
 * `aFlags` bits select ({@link TILE_HIGHLIGHT}).
 *
 * The material is one `ShaderMaterial` shared by every tile instance. It reads
 * the three committed relief atlases (3D-03) with per-instance atlas rects, and
 * the light rig's numbers from `lighting.ts` — never three's own light uniforms,
 * because the carve is shaded by hand. The geometry it draws is 3D-04's mesh,
 * whose `faceZone` attribute is exactly 1 on the carved plate and 0 everywhere
 * else, so the face branch is geometrically exact rather than a UV guess.
 *
 * Two gates live here as numbers rather than assumptions:
 *
 * - **The step tiers** ({@link POM_STEPS}, {@link SHADOW_STEPS}): `high` 12 depth
 *   / 4 shadow, `balanced` 8 / 2, `compat` 0 / 0, with 0 a supported end state
 *   rather than an absence — the same uniforms remove the marches for
 *   `?debug=pom-off` and `?debug=shadow-off`. The compile-time loop bounds are
 *   {@link POM_MAX_STEPS}/{@link SHADOW_MAX_STEPS} and the shader's `#define`s
 *   must equal them (a unit test asserts the source and the constants agree).
 * - **The parallax bound** ({@link parallaxTexels}): the full-depth
 *   displacement of a carving, in atlas texels, from the committed camera
 *   angle, the carve depth and the plate/cell sizes. The shader clamps to
 *   {@link POM_MAX_TEXELS}, so the bound holds at every view by construction;
 *   the test prints the pre-clamp worst case at every supported aspect.
 *
 * Shader compile failures are never silent: {@link installShaderErrorTrap}
 * turns three's `onShaderError` diagnostic into a thrown {@link TileShaderError}
 * before the first frame, which the host reports as `failed`.
 */

import { ShaderMaterial, FrontSide } from 'three';
import type { IUniform, Texture, WebGLRenderer } from 'three';
import type { DebugMode, QualityTier } from '../contract';
import { debugCodeFor } from '../debugLegend';
import { TILE, UNIT_MM } from '../layoutConstants';
import { RELIEF_RASTER } from './reliefAssets';
import { BODY_SPECULAR, TILE_LIGHTING_UNIFORMS } from './lighting';
import { TILE_VERTEX_SHADER } from './materials/tile.vert';
import { TILE_FRAGMENT_SHADER } from './materials/tile.frag';

/**
 * The carve depth the shader integrates against, in millimetres (1 unit = 28 mm).
 *
 * 0.55 mm is the value 3D-05 calibrated the POM march, the probe gates and the
 * 8-texel parallax bound with, and every reading in this unit's report names it.
 * The 3D-owned carve that ships today (`relief3d.json`) is 0.495 mm deep, so
 * this is the ~11% conservative end for both the displacement and the
 * self-shadow reach. Aligning the constant to 0.495 is a calibration decision
 * (it shortens both marches), not a drive-by edit; 3D-10's handoff keeps 0.55
 * so the numbers the user judges are the numbers that were measured.
 */
export const CARVE_DEPTH_MM = 0.55;
export const CARVE_DEPTH_UNITS = CARVE_DEPTH_MM / UNIT_MM;

/**
 * The committed plate the atlas cells map onto, in tile units: the mesh's own
 * face plateau (0.64 x 0.89 units), which 3D-03 already pins to the manifest.
 */
export const PLATE_UNITS = [TILE.facePlateWidthUnits, TILE.facePlateHeightUnits] as const;

/**
 * The POM depth-march step count per quality tier (§2.8). `compat` is 0: the
 * plate still samples the normal, AO and paint maps, it just does not displace.
 * 3D-11 owns automatic downgrade; 3D-05 owns the numbers and the kill switch.
 */
export const POM_STEPS: Readonly<Record<QualityTier, number>> = {
  high: 12,
  balanced: 8,
  compat: 0,
};

/**
 * The light-space self-shadow's step count per tier (3D-10).
 *
 * §2.8's table said 3 / 2 / 0 when it was written before the shader existed;
 * 3D-10's deliverable, 3D-S1's fallback and this unit's gate name
 * **4 / 2 / 0**, so the table was corrected to match (and §2.8 with it). The
 * march is a fraction of the depth march's cost — one height tap per step, no
 * dependent refinement — and `compat` is 0 for the same reason as POM: it is
 * the tier for phones and weak GPUs, and the AO map still shades the groove.
 */
export const SHADOW_STEPS: Readonly<Record<QualityTier, number>> = {
  high: 4,
  balanced: 2,
  compat: 0,
};

/**
 * The compile-time loop bound, mirrored by the fragment shader's
 * `#define SHADOW_MAX_STEPS 8`. Four steps at `high`, so the bound leaves room
 * for a calibration sweep without recompiling.
 */
export const SHADOW_MAX_STEPS = 8;

/**
 * The compile-time loop bound, mirrored by the fragment shader's
 * `#define POM_MAX_STEPS 32`. A constant bound lets the driver unroll the loop;
 * the live count is `uPomSteps`.
 */
export const POM_MAX_STEPS = 32;

/**
 * The parallax budget: the shader never displaces a plate sample by more than
 * this many atlas texels, so the dependent-fetch footprint and the risk of
 * walking off the cell are both bounded at every angle (§2.8, 3D-05's gate).
 */
export const POM_MAX_TEXELS = 8;

/**
 * The self-shadow's calibration (3D-10).
 *
 * - `depthUnits` is the **physical** carve depth, not the POM displacement
 *   scale: the self-shadow is shading, and the normal/AO maps already shade the
 *   full 0.55 mm groove. The reach is therefore
 *   `depth * tan(light's angle from the plate normal)`, converted to atlas
 *   texels with the plate/cell arithmetic (see {@link shadowReachTexels}).
 * - `strength` is the fraction of the key removed at full occlusion. It is
 *   deliberately below 1: the AO map already darkens the groove, and the decal
 *   comparison in 3D-05 calibrated the paint's median brightness. 0.45 adds the
 *   directional term without turning the small glyphs' floors black.
 * - `bias` is in normalized height units (0.02 = 0.011 mm at the committed
 *   depth): it is above the map's own quantization so a flat face can never
 *   self-shadow itself.
 * - `softness` is the depth range over which occlusion ramps in (0.35 of the
 *   carve depth ≈ 0.19 mm), so the term reads as shading, not a hard cut.
 * - `maxTexels` bounds the march to 6 texels, inside the 8-texel parallax gate,
 *   so a grazing key cannot walk off the cell.
 */
export const SHADOW_CALIBRATION = {
  depthUnits: CARVE_DEPTH_UNITS,
  strength: 0.45,
  bias: 0.02,
  softness: 0.35,
  maxTexels: 6,
} as const;

/**
 * How much of the physical engraving depth the depth march displaces.
 *
 * The committed relief map describes a real 0.55 mm groove and the normal and
 * AO channels shade that carve in full. The *displacement*, though, is what the
 * approved 2.5D carved decals never show: they bake the same geometry head-on,
 * so a stroke's silhouette cannot slide. At the pond's 37° the full depth moves
 * an edge by 0.55 mm x tan(37°) ≈ 0.41 mm — about a whole stroke width — which
 * reads far deeper than the decals the user signed off. 0.25 keeps a subtle
 * settle (1.5 texels at the pond, 0.6 at the hand) while the shading does the
 * work; 0 is the decal-equivalent "shading only" end of the sweep, and the hero
 * view exports the depth sweep so the value can be re-picked against the decals.
 */
export const POM_HEIGHT_SCALE = 0.25;

/** The height scales the hero handoff exports for comparison (0 = POM off). */
export const POM_HEIGHT_SCALE_SWEEP: readonly number[] = [0, 0.25, 0.5, 1];

/**
 * Carve response calibration, measured against the approved 2.5D decals.
 *
 * Two knobs, and what the measurements say about each:
 *
 * - `CARVE_NORMAL_STRENGTH` steepens the sampled wall and `CARVE_AO_POWER`
 *   curves the cavity. Both are kept at **1.0** because the committed relief
 *   bake is already sharper than the decal at the edge: measured as the mean
 *   ivory luma against distance from the paint boundary, the decal reads
 *   217 / 240 / 240 at 0 / 0.5 / 1.0 mm and the render 179 / 227 / 238 (1.0)
 *   or 171 / 223 / 238 (1.2 + a 1.15 normal). Curving harder only spreads a
 *   dark halo (a first pass at `ao^4` + 1.6 read 110 / 195 / 238). The real
 *   residual is *width*: the relief bake's wall is 0.655 mm at 40° where the
 *   decal's is 0.3 mm, so no shader curve can narrow it. That is what the
 *   3D-owned rebake is for; the knobs stay as the controls for it.
 * - The paint's *brightness* was the visible gap: the decal's paint is a
 *   glossy lacquer whose median is 80/255 with a sheen (rgb 196,46,37 against
 *   the glyph's 166,12,12), and the render's was 41 — a flat dark red, which
 *   is what "looks like paint" meant. {@link PAINT_SHEEN} closes that median.
 */
export const CARVE_NORMAL_STRENGTH = 1.0;
export const CARVE_AO_POWER = 1.0;

/** The area-key approximation's angular radius (see `lighting.ts`). */
export const KEY_SPREAD_DEG = TILE_LIGHTING_UNIFORMS.keySpreadDeg;

/**
 * How much of the cavity curve a *painted* pixel takes.
 *
 * The decal's paint is a glossy lacquer sitting in the groove: its baked luma
 * spreads 30..212 (median 77) with a sheen, while the ivory lip around it is
 * only faintly shaded (mean 217 at the edge, back to 240 by 0.5 mm). Applying
 * the lip's cavity curve to the paint crushes it to a flat dark red, so the
 * paint keeps the atlas's own AO and the ivory gets the curve.
 */
export const PAINT_CAVITY_BLEND = 0.0;

/**
 * The paint's broad lacquer sheen, in linear light added on painted pixels.
 *
 * The committed decal bakes its paint with a 40°-wide tube key, and the groove
 * floor's slight concavity spreads that highlight over the whole stroke: the
 * decal's paint is a neutral +0.05 linear over the same pigment (its median
 * rgb 196,46,37 against the glyph's 166,12,12). A flat floor under one
 * directional key produces almost none of that (our median was 41 against the
 * decal's 77), so the plate adds it as a calibrated sheen. It only applies to
 * painted pixels; the ivory's probe stays exact.
 */
export const PAINT_SHEEN = 0.05;

/**
 * How the per-instance flags shade a tile (3D-07).
 *
 * `boardMesh.INSTANCE_FLAG` carries two *shading* bits: a highlighted tile is
 * the newest discard of a seat a call/ron offer names, and a dimmed tile is a
 * tsumogiri discard. The numbers are deliberately modest — both are
 * information, not a spotlight — but large enough to be measured: the highlight
 * lifts a tile ~35 % and warms it, the dim drops it to 62 %. They apply after
 * the BRDF, so the carved face, the body and the blue back all respond
 * consistently.
 */
export const TILE_HIGHLIGHT = {
  /** Multiplied into the shaded colour of a highlighted instance. */
  tint: [1.35, 1.22, 1.05] as const,
  /** 1 = the tint applies in full to a highlighted instance. */
  strength: 1,
  /** Multiplier on a dimmed (tsumogiri) instance. */
  dimGain: 0.62,
} as const;

/**
 * The debug-mode codes live in the pure `debugLegend.ts` module (3D-10), so the
 * host can print each mode's legend without importing the lazy three chunk. They
 * are re-exported here because this module is the material's public surface.
 */
export { DEBUG_MODE_CODE, debugCodeFor } from '../debugLegend';

/** Bitmap size of one atlas cell at a tier's upload scale. */
export function cellTexelsForTier(tier: QualityTier): { readonly x: number; readonly y: number } {
  // `compat` halves each atlas axis at load (3D-03), so the cell halves too.
  const scale = tier === 'compat' ? 0.5 : 1;
  return {
    x: RELIEF_RASTER.cellWidth * scale,
    y: RELIEF_RASTER.cellHeight * scale,
  };
}

/**
 * The POM step count a tier and a debug mode resolve to. `?debug=pom-off` wins
 * over the tier, and `compat` is already 0.
 */
export function pomStepsFor(tier: QualityTier, debug: DebugMode | null): number {
  if (debug === 'pom-off') return 0;
  return POM_STEPS[tier];
}

/**
 * The self-shadow step count a tier and a debug mode resolve to (3D-10).
 * `?debug=shadow-off` wins over the tier; `compat` is already 0.
 */
export function shadowStepsFor(tier: QualityTier, debug: DebugMode | null): number {
  if (debug === 'shadow-off') return 0;
  return SHADOW_STEPS[tier];
}

/** Everything {@link createTileMaterial} needs. */
export interface TileMaterialOptions {
  readonly tier: QualityTier;
  readonly debug: DebugMode | null;
  /** `face_albedo`: pigment RGB + paint mask in alpha, sRGB. */
  readonly albedo: Texture;
  /** `face_normal_depth`: tangent normal RGB + normalized height in alpha. */
  readonly normalDepth: Texture;
  /** `face_ao_roughness`: cavity AO in R, roughness in G. */
  readonly aoRoughness: Texture;
}

/** The material plus the handful of live controls the scene needs. */
export interface TileMaterialHandle {
  readonly material: ShaderMaterial;
  readonly uniforms: Readonly<Record<string, IUniform>>;
  /** The live POM step count (0 = un-carved shading path). */
  pomSteps(): number;
  setPomSteps(steps: number): void;
  /** The live self-shadow step count (0 = no light-space shadow). */
  shadowSteps(): number;
  setShadowSteps(steps: number): void;
  /** The live self-shadow strength (0 = off, 1 = full). */
  shadowStrength(): number;
  setShadowStrength(strength: number): void;
  /** The live displacement scale (1 = the full physical 0.55 mm groove). */
  heightScale(): number;
  setHeightScale(scale: number): void;
  setTier(tier: QualityTier): void;
  setDebug(debug: DebugMode | null): void;
  dispose(): void;
}

const PLATE_WIDTH_UNITS = PLATE_UNITS[0];
const PLATE_HEIGHT_UNITS = PLATE_UNITS[1];

/**
 * Build the tile material for a tier and debug mode. Textures are owned by the
 * caller (3D-03's relief bridge); this only samples them.
 */
export function createTileMaterial(options: TileMaterialOptions): TileMaterialHandle {
  const cell = cellTexelsForTier(options.tier);
  const uniforms: Record<string, IUniform> = {
    uAlbedo: { value: options.albedo },
    uNormalDepth: { value: options.normalDepth },
    uAoRoughness: { value: options.aoRoughness },
    uPomSteps: { value: pomStepsFor(options.tier, options.debug) },
    uCarveDepthUnits: { value: CARVE_DEPTH_UNITS },
    uHeightScale: { value: POM_HEIGHT_SCALE },
    uPlateUnits: { value: [PLATE_WIDTH_UNITS, PLATE_HEIGHT_UNITS] },
    uCellTexels: { value: [cell.x, cell.y] },
    uMaxParallaxTexels: { value: POM_MAX_TEXELS },
    uDebug: { value: debugCodeFor(options.debug) },
    uShadowSteps: { value: shadowStepsFor(options.tier, options.debug) },
    uShadowDepthUnits: { value: SHADOW_CALIBRATION.depthUnits },
    uShadowMaxTexels: { value: SHADOW_CALIBRATION.maxTexels },
    uShadowStrength: { value: SHADOW_CALIBRATION.strength },
    uShadowBias: { value: SHADOW_CALIBRATION.bias },
    uShadowSoftness: { value: SHADOW_CALIBRATION.softness },
    uBodyIvory: { value: [...TILE_LIGHTING_UNIFORMS.bodyIvory] },
    uBodyBlue: { value: [...TILE_LIGHTING_UNIFORMS.bodyBlue] },
    uBodyIvoryRoughness: { value: TILE_LIGHTING_UNIFORMS.bodyIvoryRoughness },
    uBodyBlueRoughness: { value: TILE_LIGHTING_UNIFORMS.bodyBlueRoughness },
    uBackEdgeFraction: { value: TILE_LIGHTING_UNIFORMS.backEdgeFraction },
    uThicknessUnits: { value: TILE_LIGHTING_UNIFORMS.thicknessUnits },
    uCoatFace: { value: TILE_LIGHTING_UNIFORMS.coatFace },
    uCoatBack: { value: TILE_LIGHTING_UNIFORMS.coatBack },
    uCoatRoughness: { value: TILE_LIGHTING_UNIFORMS.coatRoughness },
    uNormalStrength: { value: CARVE_NORMAL_STRENGTH },
    uAoPower: { value: CARVE_AO_POWER },
    uPaintCavityBlend: { value: PAINT_CAVITY_BLEND },
    uPaintSheen: { value: PAINT_SHEEN },
    uKeySpreadDeg: { value: KEY_SPREAD_DEG },
    uKeyDirection: { value: [...TILE_LIGHTING_UNIFORMS.keyDirection] },
    uKeyColor: { value: [...TILE_LIGHTING_UNIFORMS.keyColor] },
    uKeyIntensity: { value: TILE_LIGHTING_UNIFORMS.keyIntensity },
    uFillSky: { value: [...TILE_LIGHTING_UNIFORMS.fillSky] },
    uFillGround: { value: [...TILE_LIGHTING_UNIFORMS.fillGround] },
    uFillIntensity: { value: TILE_LIGHTING_UNIFORMS.fillIntensity },
    uAmbientColor: { value: [...TILE_LIGHTING_UNIFORMS.ambientColor] },
    uAmbientIntensity: { value: TILE_LIGHTING_UNIFORMS.ambientIntensity },
    uSpecularF0: { value: TILE_LIGHTING_UNIFORMS.specularF0 },
    uBodySpecularRoughness: { value: BODY_SPECULAR.roughness },
    uPlateLikeEdges: { value: [...BODY_SPECULAR.plateLikeEdges] },
    uWrap: { value: TILE_LIGHTING_UNIFORMS.wrap },
    uHighlightTint: { value: [...TILE_HIGHLIGHT.tint] },
    uHighlightStrength: { value: TILE_HIGHLIGHT.strength },
    uDimGain: { value: TILE_HIGHLIGHT.dimGain },
  };

  const material = new ShaderMaterial({
    name: 'tile-carved',
    uniforms,
    vertexShader: TILE_VERTEX_SHADER,
    fragmentShader: TILE_FRAGMENT_SHADER,
    side: FrontSide,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    wireframe: options.debug === 'wireframe',
  });

  let tier = options.tier;
  let debug: DebugMode | null = options.debug;
  return {
    material,
    uniforms,
    pomSteps: () => uniforms.uPomSteps.value as number,
    setPomSteps(steps: number) {
      const value = Number.isFinite(steps) ? Math.round(steps) : 0;
      uniforms.uPomSteps.value = Math.min(POM_MAX_STEPS, Math.max(0, value));
    },
    shadowSteps: () => uniforms.uShadowSteps.value as number,
    setShadowSteps(steps: number) {
      const value = Number.isFinite(steps) ? Math.round(steps) : 0;
      uniforms.uShadowSteps.value = Math.min(SHADOW_MAX_STEPS, Math.max(0, value));
    },
    shadowStrength: () => uniforms.uShadowStrength.value as number,
    setShadowStrength(strength: number) {
      const value = Number.isFinite(strength) ? strength : SHADOW_CALIBRATION.strength;
      uniforms.uShadowStrength.value = Math.min(1, Math.max(0, value));
    },
    heightScale: () => uniforms.uHeightScale.value as number,
    setHeightScale(scale: number) {
      const value = Number.isFinite(scale) ? scale : POM_HEIGHT_SCALE;
      uniforms.uHeightScale.value = Math.min(1, Math.max(0, value));
    },
    setTier(next: QualityTier) {
      tier = next;
      uniforms.uPomSteps.value = pomStepsFor(tier, debug);
      uniforms.uShadowSteps.value = shadowStepsFor(tier, debug);
      const texels = cellTexelsForTier(tier);
      uniforms.uCellTexels.value = [texels.x, texels.y];
    },
    setDebug(next: DebugMode | null) {
      debug = next;
      uniforms.uDebug.value = debugCodeFor(next);
      material.wireframe = next === 'wireframe';
      uniforms.uPomSteps.value = pomStepsFor(tier, next);
      uniforms.uShadowSteps.value = shadowStepsFor(tier, next);
    },
    dispose() {
      material.dispose();
    },
  };
}

/** The angle a view ray (or a light ray) can make with a plate normal. */
const MAX_ANGLE_DEG = 89;

/** One parallax measurement. All lengths in atlas texels. */
export interface ParallaxReading {
  /** The angle between the view ray and the plate's face normal. */
  readonly angleDeg: number;
  /** Displacement along the cell's U axis at the applied depth. */
  readonly texelsU: number;
  /** Displacement along the cell's V axis at the applied depth. */
  readonly texelsV: number;
  /** The larger of the two: what the shader's bound applies to. */
  readonly texels: number;
  /** True when the shader's clamp shortened it. */
  readonly clamped: boolean;
}

/** The plate/cell/bound options shared by the parallax and shadow readings. */
export interface CarveOffsetOptions {
  readonly plateUnits?: readonly [number, number];
  readonly cellTexels?: readonly [number, number];
  readonly maxTexels?: number;
}

/**
 * The lateral displacement of a carve at a ray angle, in atlas texels.
 *
 * The plate is 0.64 x 0.89 units mapped to a 256 x 340 texel cell, so a
 * displacement of `depth * tan(angle)` tile units becomes
 * `depth * tan(angle) * cellTexels / plateUnits` texels per axis. Both the POM
 * offset and the self-shadow march use this one conversion, so their bounds
 * cannot disagree.
 */
function carveOffsetTexels(
  angleDeg: number,
  depthUnits: number,
  options: CarveOffsetOptions,
  maxTexels: number,
): ParallaxReading {
  const plate = options.plateUnits ?? [PLATE_WIDTH_UNITS, PLATE_HEIGHT_UNITS];
  const cell = options.cellTexels ?? [RELIEF_RASTER.cellWidth, RELIEF_RASTER.cellHeight];
  const angle = Math.min(MAX_ANGLE_DEG, Math.max(0, Number.isFinite(angleDeg) ? angleDeg : 0));
  const lateralUnits = depthUnits * Math.tan((angle * Math.PI) / 180);
  const texelsU = (lateralUnits / plate[0]) * cell[0];
  const texelsV = (lateralUnits / plate[1]) * cell[1];
  const texels = Math.max(texelsU, texelsV);
  return {
    angleDeg: angle,
    texelsU,
    texelsV,
    texels,
    clamped: texels > maxTexels,
  };
}

/**
 * The parallax displacement of a carve at a view angle, in atlas texels.
 *
 * The depth is the committed 0.55 mm groove times the {@link POM_HEIGHT_SCALE}
 * the live material uses: the scale-1 figure is what a physical 0.55 mm
 * engraving would do (≈ 6.6 texels at the pond's 40°), and the scaled one is
 * what the renderer actually displaces. The decal comparison calibrates the
 * latter.
 */
export function parallaxTexels(
  angleDeg: number,
  options: CarveOffsetOptions & {
    readonly carveDepthUnits?: number;
    readonly heightScale?: number;
  } = {},
): ParallaxReading {
  const depth =
    (options.carveDepthUnits ?? CARVE_DEPTH_UNITS) *
    (options.heightScale ?? POM_HEIGHT_SCALE);
  return carveOffsetTexels(angleDeg, depth, options, options.maxTexels ?? POM_MAX_TEXELS);
}

/**
 * The self-shadow march's reach at a light angle, in atlas texels (3D-10).
 *
 * This is the same conversion as {@link parallaxTexels} but with the
 * **physical** carve depth ({@link SHADOW_CALIBRATION}.depthUnits) and its own
 * 6-texel bound, because the shadow is shading, not displacement: the key must
 * see the full groove to occlude it. `angleDeg` is the angle between the key
 * and the plate normal; the shader measures that in the plate's tangent frame.
 */
export function shadowReachTexels(
  angleDeg: number,
  options: CarveOffsetOptions & { readonly depthUnits?: number } = {},
): ParallaxReading {
  const depth = options.depthUnits ?? SHADOW_CALIBRATION.depthUnits;
  return carveOffsetTexels(
    angleDeg,
    depth,
    options,
    options.maxTexels ?? SHADOW_CALIBRATION.maxTexels,
  );
}

/**
 * A shader compile or link failure, reported by three's `onShaderError` hook.
 *
 * three logs shader errors instead of throwing, so a broken program would
 * otherwise draw nothing and leave the view "ready". This error carries the
 * driver's info logs so the host's failure message names the actual problem.
 */
export class TileShaderError extends Error {
  readonly log: string;

  constructor(log: string) {
    super(`3D tile shader failed to compile or link:\n${log || '(no driver log)'}`);
    this.name = 'TileShaderError';
    this.log = log;
  }
}

/** The slice of three's renderer the trap needs (injectable for tests). */
export interface ShaderErrorTrapRenderer {
  debug: {
    checkShaderErrors: boolean;
    /**
     * three types this callback's `program` as its own `WebGLProgram` class,
     * which collides with the DOM's `WebGLProgram` interface. This module only
     * ever *assigns* the callback, so the exact signature is not restated.
     */
    onShaderError: unknown;
  };
}

/**
 * Make a shader compile failure throw instead of console-erroring.
 *
 * Install it on the renderer before the first tile material is compiled; the
 * throw then reaches `createRenderer` (or the first `render`) and the host
 * reports `failed` with the driver's log.
 */
export function installShaderErrorTrap(renderer: ShaderErrorTrapRenderer): void {
  renderer.debug.checkShaderErrors = true;
  renderer.debug.onShaderError = (
    gl: WebGLRenderingContext,
    program: WebGLProgram,
    vertexShader: WebGLShader,
    fragmentShader: WebGLShader,
  ) => {
    const logs = [
      gl.getProgramInfoLog(program),
      gl.getShaderInfoLog(vertexShader),
      gl.getShaderInfoLog(fragmentShader),
    ]
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim());
    throw new TileShaderError(logs.join('\n'));
  };
}

/** The renderer type the trap accepts in production. */
export type TileRenderer = WebGLRenderer;
