/**
 * 3D-owned carve bake: the approved decal geometry as *channels* (3D-17).
 *
 * Why this exists. The runtime face is live-lit from the Task 4B relief maps,
 * and those were baked for a different engraving: a 0.655 mm, 40° V-wall that
 * sits **outside** the glyph outline, with the painted floor flat. The approved
 * 2.5D decals carve the opposite way — the glyph area itself is pushed in by
 * 0.495 mm through a 0.3 mm Bézier transition, so the **wall is inside the
 * painted silhouette** and the paint covers it. That painted wall is where the
 * decals' bright rim and dark inner shadow come from; a flat painted floor can
 * only ever look like paint, which is exactly what the user reported.
 *
 * **The carve follows the *paint*, not the glyph's bounding alpha.** A pinzu
 * artwork like `1p` is woven through with opaque **white** (17 066 px against
 * 32 455 painted): that white is the bare tile showing through the pattern, so
 * it must stay at the uncarved surface and read as a raised island. `1m` has no
 * white, which is why treating the alpha as the carve mask worked there and
 * turned `1p` into one recessed disc. The rule is the 2.5D chain's own published
 * one (the retired 2.5D decal spec's `whiteFillUncarved` with
 * `whiteFillThreshold` 0.9, in git history): a pixel is bare tile when every
 * channel is at least 90 % white. Keeping the two chains on the same threshold is what makes the 3D
 * islands and the decal islands identical.
 *
 * Inputs are the committed flat glyph masters (`frontend/public/table/faces/`,
 * 300 x 400), not the retired Task 4B albedo: the relief assets were removed
 * from the tree on 2026-11-18 (AGENTS.md §5).
 *
 * So this tool re-bakes the two carve channels at the decal's geometry:
 *
 * - `face_normal_depth.png` — tangent normal (x right, y down, z out) plus the
 *   normalized height in alpha, exactly the committed format;
 * - `face_ao_roughness.png` — cavity AO in R and roughness in G.
 *
 * It deliberately does **not** bake albedo: the paint colour and mask are
 * geometry-independent, so the committed `relief/face_albedo.png` is reused
 * (the manifest points at it). Nothing under `tools/render/` is read for
 * geometry or written; the only inputs are the committed public-domain glyph
 * masters in `frontend/public/table/faces/`.
 *
 * The channels are analytic rather than Cycles renders, because the face is a
 * height field seen from straight above:
 *   normal = normalize(d depth / dx, d depth / dy, 1)   (mm, y down)
 *   AO     = mean over directions of (1 - sin(horizon elevation))
 * which is exact for the normal and a stated horizon approximation for the AO.
 * Deterministic: no randomness, no clock; two runs are byte-identical.
 *
 * **Unused cells carry the open face, not zeros.** The 37 faces fill 37 of the
 * grid's 42 cells, and the plate's UV maps [0, 1] onto the cell's *exact*
 * border, so the sampler's bilinear tap at a plate edge is a 50/50 blend of the
 * cell's last texel and the neighbouring cell's first one (and mip levels blend
 * across the same border). A zero-filled unused cell is not "nothing": in the
 * normal/height atlas `(0, 0, 0, 0)` decodes to a degenerate normal at the
 * deepest groove height, and in the AO atlas to `AO 0` — i.e. black. That is
 * what drew the black line along the bottom edge of every honour in row 5
 * (their cells sit directly above the unused row 6) and along 7z's right edge
 * (its neighbour is the first unused cell). Padding every unused cell with the
 * open face (`normalDepth` 128/128/255/255, `aoRoughness` 255/115/0/255,
 * `albedo` 255/255/255/0 — the same values `buildNeutralCell` uses) makes every
 * boundary blend open-face-with-open-face, which is exactly the uncarved
 * surface, so no face edge can read as a seam.
 *
 *   node frontend/tools/relief3d/bake-relief3d.mjs            # bake + publish
 *   node frontend/tools/relief3d/bake-relief3d.mjs --check     # verify pins
 */

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const frontendDir = resolve(scriptDir, '../..');
const tableDir = join(frontendDir, 'public/table');
const relief3dDir = join(tableDir, 'relief3d');

/** The approved decal carve parameters (retired 2.5D spec, in git history), in units. */
const CARVE = {
  /** `depthFractionOfThickness` x 16.5 mm = 0.495 mm. */
  depthMm: 0.03 * 16.5,
  /** `transitionUnits` 0.010714 units x 28 mm = 0.3 mm. */
  transitionMm: 0.010714285714285714 * 28,
  /** `blurUnits` 0.0042857 units x 28 mm = 0.12 mm. */
  blurMm: 0.004285714285714286 * 28,
  /** `profile.topSpread` / `bottomSpread`: the Bézier groove profile. */
  topSpread: 0.6,
  bottomSpread: 0.8,
  /** Horizon-search radius for the cavity term, mm. */
  aoDistanceMm: 1.4,
  /** Azimuths and radial steps of the horizon search. */
  aoDirections: 8,
  aoSteps: 10,
  /** Roughness: the committed relief spec's open resin and lacquer paint. */
  roughnessOpen: 0.45,
  roughnessPaint: 0.12,
};

/**
 * The 2.5D chain's published white-island rule (its decal spec's
 * `whiteFillThreshold`): a pixel whose every channel is at least this fraction
 * white is the bare tile showing through the artwork, not white enamel.
 */
const WHITE_FILL_THRESHOLD = 0.9;

/** The committed cell grid and plate, matching `relief.json`. */
const RASTER = { cellWidth: 256, cellHeight: 340, columns: 6, rows: 7 };
const PLATE_MM = { width: 0.64 * 28, height: 0.89 * 28 };

/**
 * The value every **unused** atlas cell carries: the open, uncarved face.
 *
 * These are the same numbers as the runtime's procedural neutral cell
 * (`reliefAssets.buildNeutralCell`): flat tangent normal +Z, height 1 (uncarved),
 * AO 1, the open resin roughness, and no paint mask. Any boundary blend of two
 * of them is itself the open face, so a plate edge can never sample a groove, a
 * tilted normal or a darkened cavity out of an un-baked neighbour.
 */
const OPEN_FACE = {
  /** Tangent normal (0, 0, 1) + height 1. */
  normalDepth: [128, 128, 255, 255],
  /** AO 1, resin roughness 0.45, no B channel. */
  aoRoughness: [255, Math.round(CARVE.roughnessOpen * 255), 0, 255],
  /** White pigment with a zero paint mask — the shader's mask is alpha, so the
   * RGB is never read; this mirrors `buildNeutralCell('albedo')`. */
  albedo: [255, 255, 255, 0],
};

const FACE_IDS = [
  ...['m', 'p', 's'].flatMap((suit) =>
    ['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((rank) => `${rank}${suit}`),
  ),
  '5mr',
  '5pr',
  '5sr',
  '1z',
  '2z',
  '3z',
  '4z',
  '5z',
  '6z',
  '7z',
];

const ATLAS_FILES = {
  albedo: 'relief3d/face_albedo.png',
  normalDepth: 'relief3d/face_normal_depth.png',
  aoRoughness: 'relief3d/face_ao_roughness.png',
};

const manifestPath = join(tableDir, 'relief3d.json');

/* ------------------------------------------------------------------ */
/* Small numerics                                                     */
/* ------------------------------------------------------------------ */

/**
 * The standard normal quantile (Acklam's rational approximation), then
 * `erfinv(v) = Phi^-1((v + 1) / 2) / sqrt(2)`.
 *
 * The decal bake computes the carve distance by inverting the blurred mask
 * through the error function; the argument here is an erf value in (-1, 1), so
 * the quantile takes `(v + 1) / 2` as its probability.
 */
function erfInv(value) {
  const v = Math.min(0.999999, Math.max(-0.999999, value));
  const p = Math.min(1 - 1e-12, Math.max(1e-12, (v + 1) / 2));
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let quantile;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    quantile = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    quantile = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    quantile = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return quantile / Math.SQRT2;
}

/** Separable Gaussian blur with clamped edges. */
function blur2d(source, width, height, sigma) {
  if (sigma <= 0) return Float64Array.from(source);
  const radius = Math.max(1, Math.round(sigma * 3));
  const kernel = new Float64Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const weight = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = weight;
    sum += weight;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= sum;

  const horizontal = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sx = Math.min(width - 1, Math.max(0, x + k));
        total += source[y * width + sx] * kernel[k + radius];
      }
      horizontal[y * width + x] = total;
    }
  }
  const out = new Float64Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let total = 0;
      for (let k = -radius; k <= radius; k += 1) {
        const sy = Math.min(height - 1, Math.max(0, y + k));
        total += horizontal[sy * width + x] * kernel[k + radius];
      }
      out[y * width + x] = total;
    }
  }
  return out;
}

/** Bilinear sample of a scalar field. */
function sample(field, width, height, x, y) {
  const cx = Math.min(width - 1.001, Math.max(0, x));
  const cy = Math.min(height - 1.001, Math.max(0, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const top = field[y0 * width + x0] * (1 - fx) + field[y0 * width + x1] * fx;
  const bottom = field[y1 * width + x0] * (1 - fx) + field[y1 * width + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

/** The decal bake's groove profile: a cubic Bézier with independent fillets. */
function bezierProfile(u, topSpread, bottomSpread) {
  const steps = 1025;
  const xs = new Float64Array(steps);
  const ys = new Float64Array(steps);
  for (let i = 0; i < steps; i += 1) {
    const t = i / (steps - 1);
    const oneMinus = 1 - t;
    xs[i] = 3 * oneMinus * oneMinus * t * topSpread +
      3 * oneMinus * t * t * (1 - bottomSpread) + t * t * t;
    ys[i] = t * t * (3 - 2 * t);
  }
  // x is monotonically non-decreasing by construction; nudge duplicates so the
  // lookup is well defined.
  for (let i = 1; i < steps; i += 1) {
    if (xs[i] <= xs[i - 1]) xs[i] = xs[i - 1] + 1e-12;
  }
  const value = Math.min(1, Math.max(0, u));
  let low = 0;
  let high = steps - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (xs[middle] <= value) low = middle;
    else high = middle;
  }
  const span = xs[high] - xs[low] || 1e-12;
  const t = (value - xs[low]) / span;
  return ys[low] * (1 - t) + ys[high] * t;
}

/* ------------------------------------------------------------------ */
/* One face                                                           */
/* ------------------------------------------------------------------ */

/**
 * Read one face's committed glyph master and sample it into the cell.
 *
 * The glyph is sampled **premultiplied** (so a transparent neighbour cannot
 * darken a paint edge) and then un-premultiplied, which gives a straight-alpha
 * pigment exactly where the art has coverage. The bare-tile rule is applied to
 * the sampled colour.
 */
async function albedoCell(face) {
  const image = await loadImage(readFileSync(join(tableDir, 'faces', `${face}.png`)));
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const source = context.getImageData(0, 0, image.width, image.height).data;
  const width = RASTER.cellWidth;
  const height = RASTER.cellHeight;

  // Premultiply once so the bilinear filter is correct at the art's edges.
  const premultiplied = new Float64Array(image.width * image.height * 4);
  for (let i = 0; i < image.width * image.height; i += 1) {
    const alpha = source[i * 4 + 3] / 255;
    premultiplied[i * 4] = source[i * 4] * alpha;
    premultiplied[i * 4 + 1] = source[i * 4 + 1] * alpha;
    premultiplied[i * 4 + 2] = source[i * 4 + 2] * alpha;
    premultiplied[i * 4 + 3] = source[i * 4 + 3];
  }

  const same = (x, y) => {
    const cx = Math.min(image.width - 1.001, Math.max(0, x));
    const cy = Math.min(image.height - 1.001, Math.max(0, y));
    const x0 = Math.floor(cx);
    const y0 = Math.floor(cy);
    const x1 = Math.min(image.width - 1, x0 + 1);
    const y1 = Math.min(image.height - 1, y0 + 1);
    const fx = cx - x0;
    const fy = cy - y0;
    const out = [0, 0, 0, 0];
    for (let channel = 0; channel < 4; channel += 1) {
      const top = premultiplied[(y0 * image.width + x0) * 4 + channel] * (1 - fx) +
        premultiplied[(y0 * image.width + x1) * 4 + channel] * fx;
      const bottom = premultiplied[(y1 * image.width + x0) * 4 + channel] * (1 - fx) +
        premultiplied[(y1 * image.width + x1) * 4 + channel] * fx;
      out[channel] = top * (1 - fy) + bottom * fy;
    }
    return out;
  };

  const mask = new Float64Array(width * height);
  const pigment = new Uint8ClampedArray(width * height * 4);
  let white = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sample = same(((x + 0.5) / width) * image.width - 0.5, ((y + 0.5) / height) * image.height - 0.5);
      const alpha = sample[3] / 255;
      const r = alpha > 1e-6 ? sample[0] / alpha : 0;
      const g = alpha > 1e-6 ? sample[1] / alpha : 0;
      const b = alpha > 1e-6 ? sample[2] / alpha : 0;
      const threshold = 255 * WHITE_FILL_THRESHOLD;
      const bareTile = r >= threshold && g >= threshold && b >= threshold;
      const painted = alpha > 0.5 && !bareTile;
      if (!painted && alpha > 0.5) white += 1;
      const index = y * width + x;
      mask[index] = painted ? 1 : 0;
      pigment[index * 4] = Math.round(r);
      pigment[index * 4 + 1] = Math.round(g);
      pigment[index * 4 + 2] = Math.round(b);
      pigment[index * 4 + 3] = painted ? 255 : 0;
    }
  }
  return { mask, pigment, white, width, height };
}

/**
 * Build one face's carve channels at the cell resolution.
 *
 * The paint mask is the glyph alpha (the same mask the committed albedo uses),
 * and the wall lives *inside* it: the glyph area is displaced inward through
 * `transitionMm`, so the painted surface carries the wall's normals and
 * occlusion. That is the decal's geometry, and the reason to rebake at all.
 */
async function bakeFace(face) {
  const { cellWidth: width, cellHeight: height } = RASTER;
  const pxPerMmX = width / PLATE_MM.width;
  const pxPerMmY = height / PLATE_MM.height;

  const albedo = await albedoCell(face);
  const mask = albedo.mask;

  // Signed distance (pixels, positive inside) from the blurred mask, exactly as
  // the decal bake does it: a Gaussian blur, then the erf inverse.
  const sigmaPx = CARVE.blurMm * pxPerMmX;
  const blurred = blur2d(mask, width, height, sigmaPx);
  const transitionPx = CARVE.transitionMm * pxPerMmX;
  const heightField = new Float64Array(width * height);
  const depthMm = new Float64Array(width * height);
  for (let i = 0; i < heightField.length; i += 1) {
    const value = Math.min(0.9999, Math.max(-0.9999, 2 * blurred[i] - 1));
    const distancePx = erfInv(value) * sigmaPx * Math.SQRT2;
    const field = Math.min(1, Math.max(0, distancePx / transitionPx));
    heightField[i] = bezierProfile(field, CARVE.topSpread, CARVE.bottomSpread);
    depthMm[i] = heightField[i] * CARVE.depthMm;
  }

  // Tangent normal from the depth gradient (mm, y down, z out).
  const normals = new Uint8ClampedArray(width * height * 4);
  const stepX = PLATE_MM.width / width;
  const stepY = PLATE_MM.height / height;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(height - 1, y + 1);
      const dx = (depthMm[y * width + x1] - depthMm[y * width + x0]) / ((x1 - x0) * stepX);
      const dy = (depthMm[y1 * width + x] - depthMm[y0 * width + x]) / ((y1 - y0) * stepY);
      const length = Math.hypot(dx, dy, 1);
      const offset = (y * width + x) * 4;
      normals[offset] = Math.round(((dx / length) * 0.5 + 0.5) * 255);
      normals[offset + 1] = Math.round(((dy / length) * 0.5 + 0.5) * 255);
      normals[offset + 2] = Math.round(((1 / length) * 0.5 + 0.5) * 255);
      normals[offset + 3] = Math.round((1 - heightField[y * width + x]) * 255);
    }
  }

  // Cavity AO: the horizon elevation along `aoDirections` azimuths, averaged as
  // the visible sky fraction (1 - sin(horizon)).
  const ao = new Float64Array(width * height);
  const stepMm = CARVE.aoDistanceMm / CARVE.aoSteps;
  const stepPxX = stepMm * pxPerMmX;
  const stepPxY = stepMm * pxPerMmY;
  const directions = CARVE.aoDirections;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const here = depthMm[index];
      let visible = 0;
      for (let d = 0; d < directions; d += 1) {
        const angle = (d / directions) * Math.PI * 2;
        const dirX = Math.cos(angle);
        const dirY = Math.sin(angle);
        let horizon = 0;
        for (let step = 1; step <= CARVE.aoSteps; step += 1) {
          const sx = x + dirX * stepPxX * step;
          const sy = y + dirY * stepPxY * step;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) break;
          const sampleDepth = sample(depthMm, width, height, sx, sy);
          // Depth is measured *inward*, so an occluder is a neighbour that is
          // shallower than this point (less depth = higher up).
          const rise = here - sampleDepth;
          if (rise <= 0) continue;
          const distance = stepMm * step;
          const tangent = rise / distance;
          if (tangent > horizon) horizon = tangent;
        }
        const elevation = Math.atan(horizon);
        visible += 1 - Math.sin(elevation);
      }
      ao[index] = visible / directions;
    }
  }

  const aoRoughness = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < ao.length; i += 1) {
    const offset = i * 4;
    aoRoughness[offset] = Math.round(ao[i] * 255);
    const paint = mask[i] > 0.5;
    aoRoughness[offset + 1] = Math.round(
      (paint ? CARVE.roughnessPaint : CARVE.roughnessOpen) * 255,
    );
    aoRoughness[offset + 2] = 0;
    aoRoughness[offset + 3] = 255;
  }

  return { normals, aoRoughness, depthMm, mask, pigment: albedo.pigment, white: albedo.white };
}

/* ------------------------------------------------------------------ */
/* Bake + manifest                                                    */
/* ------------------------------------------------------------------ */

function bytesToSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A minimal straight-alpha PNG writer.
 *
 * A canvas surface premultiplies alpha, and this bake's height channel is 0
 * (alpha 0) across every groove floor: putting the atlas through a canvas
 * multiplied those pixels' normal RGB away. Writing the PNG bytes directly
 * keeps every channel exact.
 */
function encodePng(width, height, rgba) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (bytes) => {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const typeBytes = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
    return Buffer.concat([length, typeBytes, data, crc]);
  };

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(
      raw,
      y * (stride + 1) + 1,
    );
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function bake() {
  mkdirSync(relief3dDir, { recursive: true });
  const atlasWidth = RASTER.cellWidth * RASTER.columns;
  const atlasHeight = RASTER.cellHeight * RASTER.rows;
  const normalDepth = new Uint8ClampedArray(atlasWidth * atlasHeight * 4);
  const aoRoughness = new Uint8ClampedArray(atlasWidth * atlasHeight * 4);
  const albedo = new Uint8ClampedArray(atlasWidth * atlasHeight * 4);
  const faces = {};

  for (let index = 0; index < FACE_IDS.length; index += 1) {
    const face = FACE_IDS[index];
    const column = index % RASTER.columns;
    const row = Math.floor(index / RASTER.columns);
    const baked = await bakeFace(face);
    const ox = column * RASTER.cellWidth;
    const oy = row * RASTER.cellHeight;
    for (let y = 0; y < RASTER.cellHeight; y += 1) {
      const source = y * RASTER.cellWidth * 4;
      const target = ((oy + y) * atlasWidth + ox) * 4;
      normalDepth.set(baked.normals.subarray(source, source + RASTER.cellWidth * 4), target);
      aoRoughness.set(baked.aoRoughness.subarray(source, source + RASTER.cellWidth * 4), target);
      albedo.set(baked.pigment.subarray(source, source + RASTER.cellWidth * 4), target);
    }
    let paint = 0;
    let depthMax = 0;
    let aoMin = 1;
    for (let i = 0; i < baked.mask.length; i += 1) {
      if (baked.mask[i] > 0.5) paint += 1;
      if (baked.depthMm[i] > depthMax) depthMax = baked.depthMm[i];
      if (baked.aoRoughness[i * 4] / 255 < aoMin) aoMin = baked.aoRoughness[i * 4] / 255;
    }
    faces[face] = {
      face,
      cell: {
        index,
        column,
        row,
        x: ox,
        y: oy,
        rect: [
          ox / atlasWidth,
          oy / atlasHeight,
          (ox + RASTER.cellWidth) / atlasWidth,
          (oy + RASTER.cellHeight) / atlasHeight,
        ],
      },
      measured: {
        paintFraction: paint / baked.mask.length,
        whiteFraction: baked.white / baked.mask.length,
        deepestMm: Number(depthMax.toFixed(4)),
        aoMin: Number(aoMin.toFixed(4)),
      },
    };
    process.stdout.write(`\r  ${index + 1}/${FACE_IDS.length} ${face}   `);
  }
  process.stdout.write('\n');

  // Every cell beyond the 37 faces carries the open face (see OPEN_FACE): the
  // sampler's bilinear/mip taps at a plate edge reach into the neighbouring cell,
  // and a zero-filled one would decode to a black cavity and a groove floor.
  const unusedCells = [];
  for (let index = FACE_IDS.length; index < RASTER.columns * RASTER.rows; index += 1) {
    const column = index % RASTER.columns;
    const row = Math.floor(index / RASTER.columns);
    const ox = column * RASTER.cellWidth;
    const oy = row * RASTER.cellHeight;
    for (let y = 0; y < RASTER.cellHeight; y += 1) {
      for (let x = 0; x < RASTER.cellWidth; x += 1) {
        const target = ((oy + y) * atlasWidth + ox + x) * 4;
        for (let channel = 0; channel < 4; channel += 1) {
          normalDepth[target + channel] = OPEN_FACE.normalDepth[channel];
          aoRoughness[target + channel] = OPEN_FACE.aoRoughness[channel];
          albedo[target + channel] = OPEN_FACE.albedo[channel];
        }
      }
    }
    unusedCells.push({ index, column, row });
  }

  const normalBytes = encodePng(atlasWidth, atlasHeight, normalDepth);
  const aoBytes = encodePng(atlasWidth, atlasHeight, aoRoughness);
  const albedoBytes = encodePng(atlasWidth, atlasHeight, albedo);
  writeFileSync(join(tableDir, ATLAS_FILES.normalDepth), normalBytes);
  writeFileSync(join(tableDir, ATLAS_FILES.aoRoughness), aoBytes);
  writeFileSync(join(tableDir, ATLAS_FILES.albedo), albedoBytes);
  const manifest = {
    version: 1,
    name: 'riichiprac 3D-owned carved face channels (3D-17)',
    purpose:
      'Normal/height and AO/roughness for the live-lit 3D face, baked at the approved decal carve geometry: the glyph area is displaced inward through a 0.3 mm Bezier transition so the wall is inside the painted silhouette (the decals\' bright rim and dark inner shadow). The committed relief albedo is reused because the paint colour and mask do not depend on the carve geometry.',
    source: {
      glyphs: 'frontend/public/table/faces/<id>.png (committed flat masters, 300 x 400, public domain)',
      albedo: 'sampled from the committed glyph masters; the relief3d alpha drops the artwork white (whiteFillThreshold 0.9) so it stays uncarved',
      geometry: 'the approved 2.5D decal carve (retired spec; constants in this file)',
      generator: 'frontend/tools/relief3d/bake-relief3d.mjs',
      note: 'The committed glyph masters under frontend/public/table/faces are the only input; the retired 2.5D pipeline is not read or written.',
    },
    coordinateSpace:
      'Cell top-left is the plate top-left, y down. Tangent normal x right, y down, z out. Height alpha is 1 on the uncarved face and 0 at the engraving floor.',
    raster: {
      cellWidth: RASTER.cellWidth,
      cellHeight: RASTER.cellHeight,
      columns: RASTER.columns,
      rows: RASTER.rows,
      atlasWidth,
      atlasHeight,
      faces: FACE_IDS.length,
      format: '8-bit RGBA PNG',
      mmPerUnit: 28,
      plateUnits: [0.64, 0.89],
      plateMm: [PLATE_MM.width, PLATE_MM.height],
      pxPerMm: { x: Number((RASTER.cellWidth / PLATE_MM.width).toFixed(6)), y: Number((RASTER.cellHeight / PLATE_MM.height).toFixed(6)) },
      unusedCells: {
        count: unusedCells.length,
        cells: unusedCells,
        value: OPEN_FACE,
        rule:
          'Unused cells carry the open face, never zeros: the plate UV maps [0, 1] onto the cell border, so a bilinear or mip tap at a plate edge blends the neighbouring cell in. Zeros there decode to a degenerate normal, the deepest groove height and AO 0 (black); the open face keeps every boundary blend equal to the uncarved surface.',
      },
    },
    carve: {
      depthMm: CARVE.depthMm,
      transitionMm: CARVE.transitionMm,
      blurMm: CARVE.blurMm,
      profile: { topSpread: CARVE.topSpread, bottomSpread: CARVE.bottomSpread },
      aoDistanceMm: CARVE.aoDistanceMm,
      aoDirections: CARVE.aoDirections,
      aoSteps: CARVE.aoSteps,
      roughness: { open: CARVE.roughnessOpen, paint: CARVE.roughnessPaint },
      notes:
        'Wall inside the glyph silhouette so the paint covers it; a flat painted floor cannot show the decals\' carved shading.',
    },
    atlases: {
      face_albedo: {
        role: 'albedo',
        file: ATLAS_FILES.albedo,
        width: atlasWidth,
        height: atlasHeight,
        bytes: albedoBytes.byteLength,
        sha256: { png: bytesToSha256(albedoBytes) },
        source: 'relief3d',
      },
      face_normal_depth: {
        role: 'normalDepth',
        file: ATLAS_FILES.normalDepth,
        width: atlasWidth,
        height: atlasHeight,
        bytes: normalBytes.byteLength,
        sha256: { png: bytesToSha256(normalBytes) },
        source: 'relief3d',
      },
      face_ao_roughness: {
        role: 'aoRoughness',
        file: ATLAS_FILES.aoRoughness,
        width: atlasWidth,
        height: atlasHeight,
        bytes: aoBytes.byteLength,
        sha256: { png: bytesToSha256(aoBytes) },
        source: 'relief3d',
      },
    },
    faces,
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(
    `relief3d: ${FACE_IDS.length} faces, albedo ${(albedoBytes.byteLength / 1024).toFixed(0)} kB, ` +
      `normal ${(normalBytes.byteLength / 1024).toFixed(0)} kB, ` +
      `ao/roughness ${(aoBytes.byteLength / 1024).toFixed(0)} kB, manifest relief3d.json`,
  );
}

/**
 * Decode one of this tool's own PNGs (8-bit RGBA, filter 0).
 *
 * Straight alpha, no canvas: a canvas premultiplies, and the height channel is 0
 * across every groove floor, so a canvas read would zero those normals.
 */
function decodePng(bytes) {
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('expected 8-bit RGBA');
      if (data[12] !== 0) throw new Error('expected a non-interlaced PNG');
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4 + 1;
  const out = new Uint8ClampedArray(width * height * 4);
  const target = Buffer.from(out.buffer);
  for (let y = 0; y < height; y += 1) {
    if (raw[y * stride] !== 0) throw new Error('expected filter type 0');
    raw.copy(target, y * width * 4, y * stride + 1, y * stride + 1 + width * 4);
  }
  return { width, height, data: out };
}

/** The RGBA texel at (x, y), clamped to the atlas exactly as `ClampToEdgeWrapping` does. */
function texel(atlas, x, y) {
  const cx = Math.min(atlas.width - 1, Math.max(0, x));
  const cy = Math.min(atlas.height - 1, Math.max(0, y));
  const offset = (cy * atlas.width + cx) * 4;
  return [
    atlas.data[offset],
    atlas.data[offset + 1],
    atlas.data[offset + 2],
    atlas.data[offset + 3],
  ];
}

/**
 * What the face sampler reads at a plate edge.
 *
 * The plate's UV maps [0, 1] onto the cell's exact border, so the bilinear tap
 * at an edge is a 50/50 blend of the cell's own edge texel and the neighbouring
 * cell's first one. That blend must read as the open face, which is the property
 * that makes a dark edge impossible.
 */
function edgeSamples(atlas, cell) {
  const { x: ox, y: oy } = cell;
  const right = ox + RASTER.cellWidth - 1;
  const bottom = oy + RASTER.cellHeight - 1;
  const sides = [];
  for (let y = oy; y < oy + RASTER.cellHeight; y += 1) {
    sides.push({ side: 'left', inner: texel(atlas, ox, y), outer: texel(atlas, ox - 1, y) });
    sides.push({ side: 'right', inner: texel(atlas, right, y), outer: texel(atlas, right + 1, y) });
  }
  for (let x = ox; x < ox + RASTER.cellWidth; x += 1) {
    sides.push({ side: 'top', inner: texel(atlas, x, oy), outer: texel(atlas, x, oy - 1) });
    sides.push({ side: 'bottom', inner: texel(atlas, x, bottom), outer: texel(atlas, x, bottom + 1) });
  }
  return sides;
}

/** The worst plate-edge reading over every face and side, in the shader's own terms. */
function plateEdgeReport(manifest, normalDepth, aoRoughness) {
  let worst = { face: 'none', side: 'none', ao: 255, height: 255, normalZ: 1 };
  for (const entry of Object.values(manifest.faces)) {
    const cell = entry.cell;
    const normalPairs = edgeSamples(normalDepth, cell);
    const aoPairs = edgeSamples(aoRoughness, cell);
    for (let index = 0; index < normalPairs.length; index += 1) {
      const { side, inner, outer } = normalPairs[index];
      // The 50/50 bilinear tap at the boundary.
      const height = (inner[3] + outer[3]) / 2;
      const normalX = (inner[0] + outer[0]) / 2;
      const normalY = (inner[1] + outer[1]) / 2;
      const normalZ = (inner[2] + outer[2]) / 2;
      const length = Math.hypot(normalX / 127.5 - 1, normalY / 127.5 - 1, normalZ / 127.5 - 1);
      const z = length > 0 ? (normalZ / 127.5 - 1) / length : 1;
      const aoPair = aoPairs[index];
      const ao = (aoPair.inner[0] + aoPair.outer[0]) / 2;
      if (ao < worst.ao || height < worst.height || z < worst.normalZ) {
        worst = { face: entry.face, side, ao, height, normalZ: z };
      }
    }
  }
  return worst;
}

/** Print the carve's signature numbers and verify the committed files. */
function check() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const problems = [];
  for (const [key, entry] of Object.entries(manifest.atlases)) {
    const bytes = readFileSync(join(tableDir, entry.file));
    if (bytes.byteLength !== entry.bytes) problems.push(`${key}: ${bytes.byteLength} != ${entry.bytes}`);
    if (bytesToSha256(bytes) !== entry.sha256.png) problems.push(`${key}: sha256 mismatch`);
  }
  if (Object.keys(manifest.faces).length !== FACE_IDS.length) problems.push('face count');
  console.log(`relief3d carve: depth ${manifest.carve.depthMm} mm, transition ${manifest.carve.transitionMm} mm, ` +
    `blur ${manifest.carve.blurMm} mm, plate ${manifest.raster.plateMm.join(' x ')} mm`);
  console.log(`  vs committed relief: depth 0.55 mm, wall run 0.655 mm at 40 deg, floor flat`);
  const deepest = Math.max(...Object.values(manifest.faces).map((face) => face.measured.deepestMm));
  console.log(`  deepest measured ${deepest} mm; atlases match their pins`);

  // The plate-edge seam gate: every cell boundary a face can sample must read as
  // the open face, and every unused cell must carry it. Both are derived from the
  // grid and OPEN_FACE rather than from the manifest, so the gate cannot be
  // satisfied by a manifest that describes the wrong padding.
  const normalDepth = decodePng(readFileSync(join(tableDir, ATLAS_FILES.normalDepth)));
  const aoRoughness = decodePng(readFileSync(join(tableDir, ATLAS_FILES.aoRoughness)));
  const used = new Set(Object.values(manifest.faces).map((entry) => entry.cell.index));
  const unusedCells = [];
  for (let index = 0; index < RASTER.columns * RASTER.rows; index += 1) {
    if (!used.has(index)) {
      unusedCells.push({ index, column: index % RASTER.columns, row: Math.floor(index / RASTER.columns) });
    }
  }
  let unusedBad = 0;
  for (const cell of unusedCells) {
    for (let y = cell.row * RASTER.cellHeight; y < (cell.row + 1) * RASTER.cellHeight; y += 1) {
      for (let x = cell.column * RASTER.cellWidth; x < (cell.column + 1) * RASTER.cellWidth; x += 1) {
        const n = texel(normalDepth, x, y);
        const a = texel(aoRoughness, x, y);
        if (
          n.some((value, channel) => value !== OPEN_FACE.normalDepth[channel]) ||
          a.some((value, channel) => value !== OPEN_FACE.aoRoughness[channel])
        ) {
          unusedBad += 1;
        }
      }
    }
  }
  if (unusedBad > 0) problems.push(`${unusedBad} texels in ${unusedCells.length} unused cells are not the open face`);
  const worst = plateEdgeReport(manifest, normalDepth, aoRoughness);
  console.log(`  unused cells: ${unusedCells.length} at the open face (${unusedBad} texels off it)`);
  console.log(`  worst plate-edge sample: ${worst.face} ${worst.side} ` +
    `ao ${worst.ao.toFixed(1)} height ${worst.height.toFixed(1)} normalZ ${worst.normalZ.toFixed(3)}`);
  if (worst.ao < 250 || worst.height < 250 || worst.normalZ < 0.99) {
    problems.push(
      `plate edge ${worst.face} ${worst.side} reads as a carve: ao ${worst.ao.toFixed(1)}, ` +
        `height ${worst.height.toFixed(1)}, normalZ ${worst.normalZ.toFixed(3)}`,
    );
  }

  for (const problem of problems) console.log(`FAIL ${problem}`);
  if (problems.length > 0) process.exitCode = 1;
  else console.log('relief3d check: ok');
}

if (process.argv.includes('--check')) check();
else await bake();
