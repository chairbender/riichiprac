/**
 * The carved tile material (3D-05): the shader program, its uniforms, the POM
 * step tiers and the numeric parallax bound.
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
 * - **The step tiers** ({@link POM_STEPS}): `high` 12, `balanced` 8, `compat` 0,
 *   with 0 a supported end state rather than an absence — the same uniform
 *   removes the march for `?debug=pom-off`. The compile-time loop bound is
 *   {@link POM_MAX_STEPS} and {@link TILE_FRAGMENT_SHADER}'s `#define` must
 *   equal it (a unit test asserts the source and the constant agree).
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
import { TILE, UNIT_MM } from '../layoutConstants';
import { RELIEF_RASTER } from './reliefAssets';
import { TILE_LIGHTING_UNIFORMS } from './lighting';
import { TILE_VERTEX_SHADER } from './materials/tile.vert';
import { TILE_FRAGMENT_SHADER } from './materials/tile.frag';

/**
 * The committed carve depth: `relief.json`'s `carve.depthMm` (0.55 mm), in tile
 * units (1 unit = 28 mm). The shader scales the height channel by this.
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
 * Debug-mode codes the shader branches on. `hero` selects a *view* (the scene
 * composition), and `pom-off` is a step count of 0, so neither has a code here;
 * `wireframe` is a material flag rather than a fragment output.
 */
export const DEBUG_MODE_CODE = {
  none: 0,
  albedo: 1,
  height: 2,
  normal: 3,
  steps: 4,
} as const;

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

/** The shader debug code for a mode, or `none`. */
export function debugCodeFor(debug: DebugMode | null): number {
  if (debug === null || debug === 'hero' || debug === 'pom-off' || debug === 'wireframe') {
    return DEBUG_MODE_CODE.none;
  }
  return DEBUG_MODE_CODE[debug];
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
    uBodyIvory: { value: [...TILE_LIGHTING_UNIFORMS.bodyIvory] },
    uBodyBlue: { value: [...TILE_LIGHTING_UNIFORMS.bodyBlue] },
    uBodyIvoryRoughness: { value: TILE_LIGHTING_UNIFORMS.bodyIvoryRoughness },
    uBodyBlueRoughness: { value: TILE_LIGHTING_UNIFORMS.bodyBlueRoughness },
    uBackEdgeFraction: { value: TILE_LIGHTING_UNIFORMS.backEdgeFraction },
    uThicknessUnits: { value: TILE_LIGHTING_UNIFORMS.thicknessUnits },
    uCoatFace: { value: TILE_LIGHTING_UNIFORMS.coatFace },
    uCoatBack: { value: TILE_LIGHTING_UNIFORMS.coatBack },
    uCoatRoughness: { value: TILE_LIGHTING_UNIFORMS.coatRoughness },
    uKeyDirection: { value: [...TILE_LIGHTING_UNIFORMS.keyDirection] },
    uKeyColor: { value: [...TILE_LIGHTING_UNIFORMS.keyColor] },
    uKeyIntensity: { value: TILE_LIGHTING_UNIFORMS.keyIntensity },
    uFillSky: { value: [...TILE_LIGHTING_UNIFORMS.fillSky] },
    uFillGround: { value: [...TILE_LIGHTING_UNIFORMS.fillGround] },
    uFillIntensity: { value: TILE_LIGHTING_UNIFORMS.fillIntensity },
    uAmbientColor: { value: [...TILE_LIGHTING_UNIFORMS.ambientColor] },
    uAmbientIntensity: { value: TILE_LIGHTING_UNIFORMS.ambientIntensity },
    uSpecularF0: { value: TILE_LIGHTING_UNIFORMS.specularF0 },
    uWrap: { value: TILE_LIGHTING_UNIFORMS.wrap },
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
  return {
    material,
    uniforms,
    pomSteps: () => uniforms.uPomSteps.value as number,
    setPomSteps(steps: number) {
      const value = Number.isFinite(steps) ? Math.round(steps) : 0;
      uniforms.uPomSteps.value = Math.min(POM_MAX_STEPS, Math.max(0, value));
    },
    heightScale: () => uniforms.uHeightScale.value as number,
    setHeightScale(scale: number) {
      const value = Number.isFinite(scale) ? scale : POM_HEIGHT_SCALE;
      uniforms.uHeightScale.value = Math.min(1, Math.max(0, value));
    },
    setTier(next: QualityTier) {
      tier = next;
      uniforms.uPomSteps.value = POM_STEPS[tier];
      const texels = cellTexelsForTier(tier);
      uniforms.uCellTexels.value = [texels.x, texels.y];
    },
    setDebug(debug: DebugMode | null) {
      uniforms.uDebug.value = debugCodeFor(debug);
      material.wireframe = debug === 'wireframe';
      if (debug === 'pom-off') {
        uniforms.uPomSteps.value = 0;
      } else {
        uniforms.uPomSteps.value = POM_STEPS[tier];
      }
    },
    dispose() {
      material.dispose();
    },
  };
}

/** The angle a view ray can make with a plate normal and still be seen at all. */
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
  /** True when the shader's {@link POM_MAX_TEXELS} clamp shortened it. */
  readonly clamped: boolean;
}

/**
 * The parallax displacement of a carve at a view angle, in atlas texels.
 *
 * The plate is 0.64 x 0.89 units mapped to a 256 x 340 texel cell, so a
 * displacement of `depth * tan(angle)` tile units becomes
 * `depth * tan(angle) * cellTexels / plateUnits` texels per axis. The depth is
 * the committed 0.55 mm groove times the {@link POM_HEIGHT_SCALE} the live
 * material uses: the scale-1 figure is what a physical 0.55 mm engraving would
 * do (≈ 6.6 texels at the pond's 40°), and the scaled one is what the renderer
 * actually displaces. The decal comparison calibrates the latter.
 */
export function parallaxTexels(
  angleDeg: number,
  options: {
    readonly carveDepthUnits?: number;
    readonly heightScale?: number;
    readonly plateUnits?: readonly [number, number];
    readonly cellTexels?: readonly [number, number];
    readonly maxTexels?: number;
  } = {},
): ParallaxReading {
  const depth =
    (options.carveDepthUnits ?? CARVE_DEPTH_UNITS) *
    (options.heightScale ?? POM_HEIGHT_SCALE);
  const plate = options.plateUnits ?? [PLATE_WIDTH_UNITS, PLATE_HEIGHT_UNITS];
  const cell = options.cellTexels ?? [RELIEF_RASTER.cellWidth, RELIEF_RASTER.cellHeight];
  const maxTexels = options.maxTexels ?? POM_MAX_TEXELS;
  const angle = Math.min(MAX_ANGLE_DEG, Math.max(0, Number.isFinite(angleDeg) ? angleDeg : 0));
  const lateralUnits = depth * Math.tan((angle * Math.PI) / 180);
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
