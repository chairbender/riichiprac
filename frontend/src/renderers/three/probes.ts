/**
 * The hero tile's numeric probes (3D-05).
 *
 * AGENTS.md §6: the carving's look is the user's call, but "is the ivory the
 * committed ivory?", "is the back the committed blue?", "is there ink on the
 * face and none on the blue back?" and "does Haku stay clean?" are facts that
 * can be measured. This module turns them into four read-backs and prints the
 * numbers; nothing here inspects an image or forms an opinion about it.
 *
 * The read-back is `readPixels` over a small block at a projected plate point,
 * taken immediately after a draw (the scene re-renders before each report, so
 * `preserveDrawingBuffer: false` is not a problem). The reported colour is the
 * block's **median**, which rejects a stray bilinear/edge texel, and the paint
 * check looks at the block's **reddest** pixel, which is a presence test that
 * does not care where the stroke's edge landed.
 *
 * The targets are the committed values in linear light, run through the same
 * BRDF `lighting.ts` predicts, so a ΔE failure means the rig, the shader or the
 * material is wrong — never that someone "felt" the tile was too bright.
 */

import type { LinearRgb } from './lighting';
import { hexToBytes, hexToLinear, linearToSrgbBytes, predictLitColour } from './lighting';
import { HERO_PROBE_UV } from './hero';
import type { ProbePointSpec } from './hero';

/** What a probe's pass rule is. */
export type ProbeKind = 'ivory' | 'paint' | 'clean' | 'blue' | 'body';

/** The ΔE a committed colour probe must stay inside (3D-05's acceptance). */
export const PROBE_DELTA_E_TOLERANCE = 6;

/**
 * A paint probe must differ from the ivory by at least this ΔE.
 *
 * `1m`'s stroke is crimson, but `1p`'s artwork is navy, black, white and
 * crimson; "is the paint there?" is therefore a contrast test against the
 * unpainted ivory, not a redness test. White regions of the art deliberately do
 * not count (they are within ΔE 6 of the ivory).
 */
export const PAINT_CONTRAST_MIN = 25;

/** A clean face must sit within this ΔE of the committed ivory. */
export const CLEAN_DELTA_E_MAX = 6;

/** The block read per probe (an odd size, so there is a true centre pixel). */
export const PROBE_BLOCK = 5;

/** One probe: where it reads, and what the reading must prove. */
export interface ProbeDefinition {
  readonly id: string;
  readonly label: string;
  readonly kind: ProbeKind;
  readonly point: ProbePointSpec;
  /** The committed colour the reading is compared with (ΔE probes only). */
  readonly targetHex?: string;
}

/**
 * The five readings the hero HUD prints.
 *
 * `hakuClean` reads the *same point* as `faceIvory` on purpose: that point is
 * the deepest interior of a `1m` stroke, so it proves both that Haku's face is
 * the committed ivory and that the white dragon carries no printed mark at all.
 */
export const HERO_PROBES: readonly ProbeDefinition[] = [
  {
    id: 'faceIvory',
    label: 'face ivory (pond, Haku, open)',
    kind: 'ivory',
    point: { slot: 'pond', uv: HERO_PROBE_UV.ink },
    targetHex: '#f5f0eb',
  },
  {
    id: 'facePaint',
    label: 'paint (hand, 1p artwork)',
    kind: 'paint',
    point: { slot: 'hand', uv: HERO_PROBE_UV.ink },
  },
  {
    id: 'hakuClean',
    label: 'Haku ink-free at the same point',
    kind: 'clean',
    point: { slot: 'pond', uv: HERO_PROBE_UV.ink },
  },
  {
    id: 'backBlue',
    label: 'blue back (wall, face-down)',
    kind: 'blue',
    point: { slot: 'back', uv: HERO_PROBE_UV.centre },
    targetHex: '#132986',
  },
  {
    id: 'sideBody',
    label: 'ivory bevel (hand)',
    kind: 'body',
    point: { slot: 'hand', bevel: true },
  },
];

/** One probe's result, in the numbers the HUD shows. */
export interface ProbeReading {
  readonly id: string;
  readonly label: string;
  readonly kind: ProbeKind;
  /** The block median, 8-bit sRGB. */
  readonly rgb: readonly [number, number, number];
  readonly hex: string;
  /** The reddest pixel's `R - max(G, B)` in the block, 0..255. */
  readonly redness: number;
  readonly targetHex: string | null;
  /** CIE76 ΔE of the median to the target, or null for presence probes. */
  readonly deltaE: number | null;
  readonly tolerance: number | null;
  readonly pass: boolean;
  /** A short reason when `pass` is false. */
  readonly detail: string | null;
}

/** 8-bit sRGB to CIE XYZ (D65), then to CIE L*a*b*. */
export function srgbBytesToLab(rgb: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : Math.pow((channel + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (value: number) =>
    value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 colour difference. */
export function deltaE76(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** `#rrggbb` for an 8-bit triple. */
export function rgbToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The colour the rig predicts for a flat patch of a committed colour, viewed
 * from `viewDir` with the given normal and roughness. Used to prove the
 * committed targets are reachable at the probe orientations *before* a GPU is
 * involved; the browser probe then confirms the shader agrees.
 */
export function predictedProbeSrgb(options: {
  readonly hex: string;
  readonly normal: readonly [number, number, number];
  readonly viewDir: readonly [number, number, number];
  readonly roughness: number;
  readonly ao?: number;
}): [number, number, number] {
  const lit = predictLitColour({
    albedo: hexToLinear(options.hex) as LinearRgb,
    normal: options.normal,
    viewDir: options.viewDir,
    roughness: options.roughness,
    ao: options.ao,
  });
  return linearToSrgbBytes(lit);
}

/** The committed target as 8-bit sRGB, for a report's `targetHex` column. */
export function targetBytes(hex: string): [number, number, number] {
  return hexToBytes(hex);
}

/** A projected pixel position in the drawing buffer, or null when off-screen. */
export interface ProbeScreenPoint {
  readonly x: number;
  readonly y: number;
}

/** Where a probe reads, from the caller that owns the camera. */
export interface ProbeProjector {
  /**
   * Project a probe's definition to drawing-buffer pixels (origin bottom-left,
   * the space `readPixels` uses), or null when the point is behind the camera or
   * outside the buffer.
   */
  project(definition: ProbeDefinition): ProbeScreenPoint | null;
}

/** The raw pixel access a probe report needs. */
export interface ProbePixelSource {
  /** Drawing-buffer size, in device pixels. */
  readonly width: number;
  readonly height: number;
  /** RGBA bytes, origin bottom-left, as `gl.readPixels` returns them. */
  read(x: number, y: number, width: number, height: number): Uint8Array;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Read every hero probe and evaluate its pass rule.
 *
 * A probe whose point does not project into the buffer reports a failure with a
 * reason rather than throwing: the HUD must still render, and an off-screen
 * probe is exactly the kind of fact the handoff wants to see.
 */
export function readProbes(
  source: ProbePixelSource,
  projector: ProbeProjector,
  definitions: readonly ProbeDefinition[] = HERO_PROBES,
): readonly ProbeReading[] {
  return definitions.map((definition) => {
    const point = projector.project(definition);
    const target = definition.targetHex ?? null;
    const half = (PROBE_BLOCK - 1) / 2;
    if (!point) {
      return failed(definition, target, 'the probe point does not project on screen');
    }
    const x = Math.round(point.x) - half;
    const y = Math.round(point.y) - half;
    if (
      x < 0 ||
      y < 0 ||
      x + PROBE_BLOCK > source.width ||
      y + PROBE_BLOCK > source.height
    ) {
      return failed(definition, target, 'the probe block falls outside the drawing buffer');
    }
    const pixels = source.read(x, y, PROBE_BLOCK, PROBE_BLOCK);
    if (pixels.length < PROBE_BLOCK * PROBE_BLOCK * 4) {
      return failed(definition, target, 'readPixels returned a short block');
    }

    const reds: number[] = [];
    const greens: number[] = [];
    const blues: number[] = [];
    let redness = 0;
    for (let pixel = 0; pixel < PROBE_BLOCK * PROBE_BLOCK; pixel++) {
      const offset = pixel * 4;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      reds.push(r);
      greens.push(g);
      blues.push(b);
      redness = Math.max(redness, r - Math.max(g, b));
    }
    const rgb: [number, number, number] = [median(reds), median(greens), median(blues)];
    const lab = srgbBytesToLab(rgb);

    const ivoryContrast = deltaE76(lab, IVORY_LAB);
    let pass = false;
    let detail: string | null = null;
    if (definition.kind === 'paint') {
      pass = ivoryContrast >= PAINT_CONTRAST_MIN;
      if (!pass) {
        detail = `no paint at the probe: ΔE ${ivoryContrast.toFixed(2)} from the ivory < ${PAINT_CONTRAST_MIN}`;
      }
    } else if (definition.kind === 'clean') {
      pass = ivoryContrast <= CLEAN_DELTA_E_MAX;
      if (!pass) {
        detail = `paint where a clean face is expected: ΔE ${ivoryContrast.toFixed(2)} > ${CLEAN_DELTA_E_MAX}`;
      }
    } else if (definition.kind === 'body') {
      const blueExcess = rgb[2] - rgb[0];
      const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
      pass = blueExcess < 60 && luminance > 80 && ivoryContrast < PAINT_CONTRAST_MIN;
      if (!pass) {
        detail = `expected ivory body: ${rgbToHex(rgb)} (blue excess ${blueExcess}, luminance ${luminance.toFixed(1)})`;
      }
    }

    let deltaE: number | null = null;
    if (target) {
      deltaE = deltaE76(lab, srgbBytesToLab(targetBytes(target)));
      const inside = deltaE <= PROBE_DELTA_E_TOLERANCE;
      if (!inside) {
        detail = `ΔE ${deltaE.toFixed(2)} > ${PROBE_DELTA_E_TOLERANCE} against ${target}`;
      }
      // Colour probes are pure ΔE probes; presence probes never carry a target.
      pass = inside;
    }

    return {
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      rgb,
      hex: rgbToHex(rgb),
      redness,
      targetHex: target,
      deltaE,
      tolerance: target ? PROBE_DELTA_E_TOLERANCE : null,
      pass,
      detail,
    };
  });
}

/** The committed ivory, as a Lab reference for the paint/clean rules. */
const IVORY_LAB = srgbBytesToLab([245, 240, 235]);

function failed(
  definition: ProbeDefinition,
  target: string | null,
  detail: string,
): ProbeReading {
  return {
    id: definition.id,
    label: definition.label,
    kind: definition.kind,
    rgb: [0, 0, 0],
    hex: '#000000',
    redness: 0,
    targetHex: target,
    deltaE: null,
    tolerance: target ? PROBE_DELTA_E_TOLERANCE : null,
    pass: false,
    detail,
  };
}

/** True when every reading in a report passes its own rule. */
export function allProbesPass(readings: readonly ProbeReading[]): boolean {
  return readings.every((reading) => reading.pass);
}
