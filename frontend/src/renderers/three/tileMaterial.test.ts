/**
 * The carved material's contracts, as scripted checks (3D-05).
 *
 * The GLSL itself can only be compiled by a driver, and CI has no GPU — so this
 * file pins the parts that *can* be proven in Node, and the browser probe does
 * the rest:
 *
 * - the derivative guard (the first `dFdx`/`dFdy` precedes the first `if`), and
 *   that every sample is an explicit-gradient `textureGrad` with the base
 *   gradients — the two shader invariants the acceptance criteria name;
 * - the compile-time loop bound equals `POM_MAX_STEPS`, the tier step map and
 *   the 0-step kill switch;
 * - the parallax arithmetic: the committed 40° pond is ≈ 6.6 texels, the bound
 *   is 8 and the clamp flags anything above it;
 * - a shader compile error becomes a thrown `TileShaderError` rather than a
 *   console line, which is what lets the host report `failed`.
 */

import { Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { RELIEF_RASTER } from './reliefAssets';
import { TILE_LIGHTING_UNIFORMS } from './lighting';
import { TILE_FRAGMENT_SHADER } from './materials/tile.frag';
import { TILE_VERTEX_SHADER } from './materials/tile.vert';
import {
  CARVE_DEPTH_MM,
  CARVE_DEPTH_UNITS,
  DEBUG_MODE_CODE,
  POM_MAX_STEPS,
  POM_MAX_TEXELS,
  POM_STEPS,
  TileShaderError,
  cellTexelsForTier,
  createTileMaterial,
  debugCodeFor,
  installShaderErrorTrap,
  parallaxTexels,
  pomStepsFor,
} from './tileMaterial';
import type { ShaderErrorTrapRenderer } from './tileMaterial';

function material(tier: 'high' | 'balanced' | 'compat' = 'high') {
  return createTileMaterial({
    tier,
    debug: null,
    albedo: new Texture(),
    normalDepth: new Texture(),
    aoRoughness: new Texture(),
  });
}

describe('fragment shader invariants', () => {
  it('takes the derivatives before any branch (the derivative guard)', () => {
    const firstDerivative = TILE_FRAGMENT_SHADER.search(/\bdFd[xy]\s*\(/);
    const firstBranch = TILE_FRAGMENT_SHADER.search(/\bif\s*\(/);
    expect(firstDerivative).toBeGreaterThan(-1);
    expect(firstBranch).toBeGreaterThan(-1);
    expect(firstDerivative).toBeLessThan(firstBranch);
  });

  it('uses explicit gradients for every texture sample', () => {
    // A bare implicit-derivative fetch anywhere would let the march pick a mip
    // from the displaced UV, which is exactly what the guard prevents.
    expect(TILE_FRAGMENT_SHADER).not.toMatch(/(^|[^\w])texture2D\s*\(/);
    expect(TILE_FRAGMENT_SHADER).not.toMatch(/(^|[^\w])texture\s*\(/);

    const calls = TILE_FRAGMENT_SHADER.split('textureGrad(').slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const call of calls) {
      const args = call.slice(0, call.indexOf(')'));
      expect(args).toContain('dUvDx');
      expect(args).toContain('dUvDy');
    }
  });

  it('keeps the compile-time loop bound equal to POM_MAX_STEPS', () => {
    const define = /#define\s+POM_MAX_STEPS\s+(\d+)/.exec(TILE_FRAGMENT_SHADER);
    expect(define).not.toBeNull();
    expect(Number(define?.[1])).toBe(POM_MAX_STEPS);
  });

  it('declares the attributes the geometry provides and the uniforms it reads', () => {
    for (const attribute of ['aAtlasRect', 'aFaceUp', 'tangent', 'faceZone']) {
      expect(TILE_VERTEX_SHADER).toContain(`attribute`);
      expect(TILE_VERTEX_SHADER).toContain(attribute);
    }
    for (const uniform of ['uAlbedo', 'uNormalDepth', 'uAoRoughness']) {
      expect(TILE_FRAGMENT_SHADER).toContain(`uniform sampler2D ${uniform};`);
    }
    expect(TILE_FRAGMENT_SHADER).toContain('uniform float uPomSteps;');
    expect(TILE_FRAGMENT_SHADER).toContain('uniform float uCarveDepthUnits;');
    expect(TILE_FRAGMENT_SHADER).toContain('uniform float uMaxParallaxTexels;');
  });

  it('decodes the atlas normal, mixes the paint mask and samples AO and roughness', () => {
    expect(TILE_FRAGMENT_SHADER).toContain('mix(uBodyIvory, albedoSample.rgb, albedoSample.a)');
    expect(TILE_FRAGMENT_SHADER).toContain('normalSample.rgb');
    expect(TILE_FRAGMENT_SHADER).toContain('aoSample.r');
    expect(TILE_FRAGMENT_SHADER).toContain('aoSample.g');
    // The blue back / ivory bevel split comes from the *local* normal, which is
    // what makes a face-down tile's visible surface blue without a second mesh.
    expect(TILE_FRAGMENT_SHADER).toContain('vLocalNormal.z < -0.5');
  });

  it('has a wrapped diffuse and a GGX lobe fed by the sampled roughness', () => {
    expect(TILE_FRAGMENT_SHADER).toContain('uWrap');
    expect(TILE_FRAGMENT_SHADER).toContain('uSpecularF0');
    expect(TILE_FRAGMENT_SHADER).toContain('roughness * roughness');
  });
});

describe('POM step tiers and the kill switch', () => {
  it('maps the committed tiers to 12 / 8 / 0 steps', () => {
    expect(POM_STEPS).toEqual({ high: 12, balanced: 8, compat: 0 });
    expect(POM_MAX_STEPS).toBeGreaterThanOrEqual(POM_STEPS.high);
  });

  it('lets ?debug=pom-off override any tier', () => {
    expect(pomStepsFor('high', 'pom-off')).toBe(0);
    expect(pomStepsFor('compat', null)).toBe(0);
    expect(pomStepsFor('balanced', 'albedo')).toBe(8);
    expect(pomStepsFor('high', 'hero')).toBe(12);
  });

  it('treats steps 0 as a clampable, supported uniform value', () => {
    const handle = material('high');
    expect(handle.pomSteps()).toBe(12);
    handle.setPomSteps(0);
    expect(handle.uniforms.uPomSteps.value).toBe(0);
    handle.setPomSteps(-4);
    expect(handle.pomSteps()).toBe(0);
    handle.setPomSteps(999);
    expect(handle.pomSteps()).toBe(POM_MAX_STEPS);
    handle.dispose();
  });

  it('switches the shader debug mode and the wireframe flag', () => {
    const handle = material('high');
    handle.setDebug('normal');
    expect(handle.uniforms.uDebug.value).toBe(DEBUG_MODE_CODE.normal);
    expect(handle.material.wireframe).toBe(false);

    handle.setDebug('pom-off');
    expect(handle.pomSteps()).toBe(0);
    expect(handle.uniforms.uDebug.value).toBe(DEBUG_MODE_CODE.none);

    handle.setDebug('wireframe');
    expect(handle.material.wireframe).toBe(true);

    handle.setDebug('hero');
    expect(handle.pomSteps()).toBe(POM_STEPS.high);
    expect(debugCodeFor('hero')).toBe(0);
    handle.dispose();
  });

  it('retiers the step count and the cell texel count', () => {
    const handle = material('high');
    expect(handle.uniforms.uCellTexels.value).toEqual([
      RELIEF_RASTER.cellWidth,
      RELIEF_RASTER.cellHeight,
    ]);
    handle.setTier('compat');
    expect(handle.pomSteps()).toBe(0);
    expect(handle.uniforms.uCellTexels.value).toEqual([128, 170]);
    handle.dispose();
  });

  it('disposes the underlying material exactly once', () => {
    const handle = material();
    const spy = vi.spyOn(handle.material, 'dispose');
    handle.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('material uniforms', () => {
  it('carries the committed carve depth and plate', () => {
    const handle = material();
    expect(CARVE_DEPTH_MM).toBe(0.55);
    expect(handle.uniforms.uCarveDepthUnits.value).toBeCloseTo(0.55 / 28, 12);
    expect(handle.uniforms.uPlateUnits.value).toEqual([0.64, 0.89]);
    expect(handle.uniforms.uMaxParallaxTexels.value).toBe(POM_MAX_TEXELS);
    handle.dispose();
  });

  it('reads the light rig from lighting.ts rather than a second set of numbers', () => {
    const handle = material();
    expect(handle.uniforms.uKeyDirection.value).toEqual([
      ...TILE_LIGHTING_UNIFORMS.keyDirection,
    ]);
    expect(handle.uniforms.uKeyIntensity.value).toBe(TILE_LIGHTING_UNIFORMS.keyIntensity);
    expect(handle.uniforms.uBodyIvory.value).toEqual([...TILE_LIGHTING_UNIFORMS.bodyIvory]);
    expect(handle.uniforms.uBodyBlue.value).toEqual([...TILE_LIGHTING_UNIFORMS.bodyBlue]);
    handle.dispose();
  });

  it('builds the program from the committed sources', () => {
    const handle = material();
    expect(handle.material.vertexShader).toBe(TILE_VERTEX_SHADER);
    expect(handle.material.fragmentShader).toBe(TILE_FRAGMENT_SHADER);
    expect(handle.material.name).toBe('tile-carved');
    handle.dispose();
  });

  it('maps the atlas cell for a tier', () => {
    expect(cellTexelsForTier('high')).toEqual({ x: 256, y: 340 });
    expect(cellTexelsForTier('balanced')).toEqual({ x: 256, y: 340 });
    expect(cellTexelsForTier('compat')).toEqual({ x: 128, y: 170 });
  });
});

describe('the parallax bound', () => {
  it('is zero at normal incidence and grows with the angle', () => {
    expect(parallaxTexels(0).texels).toBe(0);
    const near = parallaxTexels(10).texels;
    const pond = parallaxTexels(40).texels;
    expect(pond).toBeGreaterThan(near);
    expect(pond).toBeCloseTo(6.59, 1);
    expect(pond).toBeLessThan(POM_MAX_TEXELS);
  });

  it('uses the denser horizontal texel axis as the bound', () => {
    const reading = parallaxTexels(40);
    expect(reading.texelsU).toBeGreaterThan(reading.texelsV);
    expect(reading.texels).toBe(reading.texelsU);
  });

  it('flags and would clamp a grazing angle, which is why the shader clamps', () => {
    // A far meld at 4:3 sits near 47°: about 8.4 texels, just past the bound,
    // which is exactly where the shader's clamp takes over.
    const meld = parallaxTexels(47);
    expect(meld.texels).toBeGreaterThan(7.5);
    expect(meld.texels).toBeLessThan(POM_MAX_TEXELS * 1.25);
    expect(meld.clamped).toBe(meld.texels > POM_MAX_TEXELS);
    const grazing = parallaxTexels(80);
    expect(grazing.texels).toBeGreaterThan(POM_MAX_TEXELS);
    expect(grazing.clamped).toBe(true);
  });

  it('fails a bad depth parameter: 5 mm is far past the budget', () => {
    const bad = parallaxTexels(40, { carveDepthUnits: 5 / 28 });
    expect(bad.texels).toBeGreaterThan(50);
    expect(bad.clamped).toBe(true);
  });

  it('halves on the compat atlas upload', () => {
    const high = parallaxTexels(40);
    const compat = parallaxTexels(40, {
      cellTexels: [RELIEF_RASTER.cellWidth / 2, RELIEF_RASTER.cellHeight / 2],
    });
    expect(compat.texels).toBeCloseTo(high.texels / 2, 6);
  });

  it('reports the committed depth in tile units', () => {
    expect(CARVE_DEPTH_UNITS).toBeCloseTo(0.019642857, 9);
  });
});

describe('shader compile failures', () => {
  function fakeRenderer(): ShaderErrorTrapRenderer & { callback: unknown } {
    const renderer: ShaderErrorTrapRenderer = {
      debug: { checkShaderErrors: false, onShaderError: null },
    };
    return renderer as ShaderErrorTrapRenderer & { callback: unknown };
  }

  const fakeGl = (logs: Record<string, string>): WebGLRenderingContext =>
    ({
      getProgramInfoLog: () => logs.program ?? '',
      getShaderInfoLog: (shader: WebGLShader) =>
        shader === ('vertex' as unknown as WebGLShader)
          ? (logs.vertex ?? '')
          : (logs.fragment ?? ''),
    }) as unknown as WebGLRenderingContext;

  it('turns a compile error into a thrown TileShaderError with the driver log', () => {
    const renderer = fakeRenderer();
    installShaderErrorTrap(renderer);
    expect(renderer.debug.checkShaderErrors).toBe(true);
    const callback = renderer.debug.onShaderError as (
      gl: WebGLRenderingContext,
      program: WebGLProgram,
      vertex: WebGLShader,
      fragment: WebGLShader,
    ) => void;
    const gl = fakeGl({
      program: 'Linking failed',
      fragment: "ERROR: 0:12: 'uPomSteps' : undeclared identifier",
    });
    expect(() =>
      callback(
        gl,
        {} as WebGLProgram,
        'vertex' as unknown as WebGLShader,
        'fragment' as unknown as WebGLShader,
      ),
    ).toThrow(TileShaderError);
    try {
      callback(
        gl,
        {} as WebGLProgram,
        'vertex' as unknown as WebGLShader,
        'fragment' as unknown as WebGLShader,
      );
    } catch (error) {
      expect((error as TileShaderError).log).toContain('Linking failed');
      expect((error as TileShaderError).log).toContain('uPomSteps');
    }
  });

  it('still throws when the driver returns no log at all', () => {
    const renderer = fakeRenderer();
    installShaderErrorTrap(renderer);
    const callback = renderer.debug.onShaderError as (
      gl: WebGLRenderingContext,
      program: WebGLProgram,
      vertex: WebGLShader,
      fragment: WebGLShader,
    ) => void;
    expect(() =>
      callback(
        fakeGl({}),
        {} as WebGLProgram,
        'vertex' as unknown as WebGLShader,
        'fragment' as unknown as WebGLShader,
      ),
    ).toThrow(/no driver log/);
  });
});
