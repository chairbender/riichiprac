/**
 * The glint probe (3D-20 follow-up): which surface drew each bright pixel.
 *
 * After the 3D-20 seam work the user reported a different defect: "very bright
 * prominent white highlights" on the bevelled edge of *some* wall tiles, and
 * only some. Attributing that from geometry guesses was the wrong instrument —
 * a bright pixel can sit inside two tiles' projected footprints, and a face-up
 * hand tile in front of a wall looks exactly like a wall tile's face — so this
 * probe asks the **shader itself** which branch each pixel took.
 *
 * It compares two draws of the *same* board with the same camera:
 *
 * 1. the lit frame, for the colour, and
 * 2. `?debug=flags`, whose RGB is `(face-up, blue-body, plate-zone)`, i.e. the
 *    exact values the fragment shader branched on (`materials/tile.frag.ts`).
 *
 * A pixel's family is then a fact, not an inference:
 *
 * - `plate` — a carved face or a backing plate: flat, so any specular lands as a
 *   uniform sheen over the whole plate and cannot vary from tile to tile;
 * - `blueBody` — the wall's bevels and side walls over the blue backing. Its
 *   albedo is dark (43 luma), so anything bright here is *specular*, and a
 *   saturated rim on this family is the defect;
 * - `ivoryBody` — the shells' 4.95 mm ivory band. It is an ivory surface, so it
 *   is legitimately bright and is reported, not failed.
 *
 * Pure: takes two RGBA buffers, no GPU, no DOM. `Scene.glintReport()` owns the
 * two draws and the two `readPixels` calls.
 */

import type { GlintBucket, GlintReport } from '../contract';

/** The luma at or above which a pixel counts as a bright glint. */
export const GLINT_THRESHOLD = 200;

/**
 * The pass rule. A saturated specular rim on the blue body must be at most this
 * fraction of the body's own coverage.
 *
 * Measured on the fixture board at 1280 x 720 with the shell's finish on every
 * surface: 276 of 141,862 blue-body pixels (0.195 %) were at 200+, and 142 were
 * fully clipped (250+). With the finish confined to plate-like surfaces: 24
 * (0.017 %), none clipped. 0.1 % sits between the two with 6x margin below and
 * 2x above.
 */
export const GLINT_BODY_MAX_FRACTION = 0.001;

/** One RGBA frame, 8-bit sRGB, top-down (`ImageData` order). */
export interface GlintFrame {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

function luma(red: number, green: number, blue: number): number {
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Tally the bright pixels of one lit frame by the family the flags frame says
 * drew them.
 *
 * @throws when the two frames disagree about their size, which would silently
 *   pair the colour of one pixel with the flags of another.
 */
export function classifyGlintFrame(
  lit: GlintFrame,
  flags: GlintFrame,
  threshold: number = GLINT_THRESHOLD,
): Omit<GlintReport, 'widthPx' | 'heightPx'> {
  if (lit.width !== flags.width || lit.height !== flags.height) {
    throw new Error(
      `3D glint probe: frames differ in size (${lit.width}x${lit.height} vs ${flags.width}x${flags.height})`,
    );
  }
  if (lit.data.length !== lit.width * lit.height * 4 || flags.data.length !== lit.data.length) {
    throw new Error('3D glint probe: a frame has the wrong byte length for its size');
  }
  const buckets: Record<'blueBody' | 'ivoryBody' | 'plate', GlintBucket> = {
    blueBody: { coverage: 0, bright: 0 },
    ivoryBody: { coverage: 0, bright: 0 },
    plate: { coverage: 0, bright: 0 },
  };
  const counters = {
    blueBody: { coverage: 0, bright: 0 },
    ivoryBody: { coverage: 0, bright: 0 },
    plate: { coverage: 0, bright: 0 },
  };
  for (let index = 0; index < lit.data.length; index += 4) {
    const faceUp = flags.data[index] > 128;
    const blueBody = flags.data[index + 1] > 128;
    const family = faceUp ? 'plate' : blueBody ? 'blueBody' : 'ivoryBody';
    counters[family].coverage += 1;
    const value = luma(lit.data[index], lit.data[index + 1], lit.data[index + 2]);
    if (value >= threshold) counters[family].bright += 1;
  }
  (Object.keys(counters) as (keyof typeof counters)[]).forEach((key) => {
    buckets[key] = counters[key];
  });
  const bodyFraction =
    buckets.blueBody.coverage > 0
      ? buckets.blueBody.bright / buckets.blueBody.coverage
      : 0;
  return {
    threshold,
    blueBody: buckets.blueBody,
    ivoryBody: buckets.ivoryBody,
    plate: buckets.plate,
    pass: bodyFraction <= GLINT_BODY_MAX_FRACTION,
  };
}
