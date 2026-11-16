#!/usr/bin/env node
/**
 * Bake the Phase 3.5 tile-to-tile contact shadows.
 *
 *   node tools/render/scripts/bake_overlays.mjs [--dry-run] [--verify-determinism]
 *
 * The group shadow (§10.12) is one blurred union under the bodies; it cannot
 * darken a neighbour's face where two tiles touch. Each decal here is a small
 * translucent band that hugs one *screen edge* of a caster shell's own body
 * silhouette, baked from the committed PNG alpha:
 *
 *   alpha(d) = coreAlpha * exp(-0.5 (d / sigma)^2)
 *
 * where `d` is the distance outward from the silhouette's opaque contour, in
 * @1x px. It is zero inside the silhouette and beyond `supportSigma * sigma`,
 * and fades to zero over `tangentFadePx1x` at both ends of the edge. The runtime
 * draws it after the neighbour's body, clips it to the neighbour's advance box,
 * and then draws the caster's body, so only the neighbour's exposed sliver is
 * shaded.
 *
 * The `(shell, side)` set is not hand-written: it comes from the real layout via
 * `frontend/scripts/export-overlays.ts --sides`, which runs every supported
 * composition. This baker refuses to bake a side the layout never asks for, and
 * the checker refuses a contact with no decal.
 *
 * Assets are lossless PNG: the band is a smooth alpha ramp and must not band.
 * The `_faceup` wall shells alias to their face-down twin (same drawn body
 * geometry, only the dora face differs), so the set is not duplicated.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng, readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(renderDir, '../..');
const tableDir = resolve(repoDir, 'frontend/public/table');
const specPath = join(renderDir, 'shell-spec.json');
const manifestPath = join(tableDir, 'shells.json');
const sidesPath = join(renderDir, 'build/overlays-sides.json');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const verifyDeterminism = args.includes('--verify-determinism');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const spec = readJson(specPath);
const overlaySpec = spec.overlay;
if (!overlaySpec) {
  console.error('[overlays] shell-spec.json has no "overlay" block');
  process.exit(2);
}
const shells = readJson(manifestPath).shells;
if (!existsSync(sidesPath)) {
  console.error(
    `[overlays] ${sidesPath} is missing; run ` +
      '`cd frontend && npm run overlays:export -- --sides` first',
  );
  process.exit(1);
}
const sidesReport = readJson(sidesPath);

const SIGMA = overlaySpec.sigmaPx1x;
const CORE = overlaySpec.coreAlpha;
const FADE = overlaySpec.tangentFadePx1x;
const SUPPORT_SIGMA = overlaySpec.supportSigma;
const CONTOUR_ALPHA = overlaySpec.contourAlpha;
const INK = hexRgb(overlaySpec.colorHex);
const PIXEL_RATIO = 2;

function hexRgb(hex) {
  const value = hex.replace('#', '');
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The drawn body geometry is all a shared decal depends on. */
const geometryKey = (shell) =>
  [
    shell.texWidth,
    shell.texHeight,
    shell.anchorX,
    shell.anchorY,
    shell.advanceWidth,
    shell.advanceHeight,
  ].join('x');

/**
 * `_faceup` shells differ only in the face glyph; their drawn body is the same
 * shell, so one decal serves both. Assert that before aliasing.
 */
function buildAliases() {
  const aliases = {};
  for (const id of Object.keys(shells)) {
    if (!id.endsWith('_faceup')) continue;
    const base = id.slice(0, -'_faceup'.length);
    if (!shells[base]) continue;
    if (geometryKey(shells[id]) !== geometryKey(shells[base])) {
      throw new Error(`${id} cannot alias ${base}: drawn body geometry differs`);
    }
    aliases[id] = base;
  }
  return aliases;
}

const aliases = buildAliases();
const canonicalOf = (id) => aliases[id] ?? id;

/** Opaque silhouette bbox and per-column/row contour of a shell texture. */
function silhouetteOf(image) {
  const { width, height, data } = image;
  const alphaAt = (x, y) => data[(y * width + x) * 4 + 3];
  const mask = new Uint8Array(width * height);
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (alphaAt(x, y) >= CONTOUR_ALPHA * 255) {
        mask[y * width + x] = 1;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
  }
  if (right < 0) throw new Error('empty shell silhouette');
  return { width, height, mask, left, top, right: right + 1, bottom: bottom + 1 };
}

/**
 * Convex hull of the opaque silhouette, inset far enough to stay inside the
 * bevel. The compositor clips each decal to this polygon, not to the advance
 * box: an oblique side-wall/hand body does not fill its box, and a box clip
 * would let the band show through the empty corners onto the felt.
 */
function bodyPolygon(silhouette) {
  const { width, height, mask } = silhouette;
  const points = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      const outside =
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        !mask[y * width + x - 1] || !mask[y * width + x + 1] ||
        !mask[(y - 1) * width + x] || !mask[(y + 1) * width + x];
      if (outside) points.push([x, y]);
    }
  }
  return cleanPolygon(insetPolygon(convexHull(points), 2.5));
}

function convexHull(points) {
  points = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const point of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper = [];
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const point = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** The inset of a hull is convex in exact arithmetic; rounding can fold a
 * vertex. Re-hull and drop near-duplicate / collinear points so the published
 * polygon is convex by construction. */
function cleanPolygon(points) {
  const deduped = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1.5) continue;
    deduped.push(point);
  }
  const hull = convexHull(deduped);
  const result = [];
  for (let i = 0; i < hull.length; i += 1) {
    const a = hull[(i + hull.length - 1) % hull.length];
    const b = hull[i];
    const c = hull[(i + 1) % hull.length];
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(area) <= 2) continue;
    result.push(b);
  }
  return result.length >= 3 ? result : hull;
}

/** Offset every edge inward by `inset` and re-intersect (convex polygon). */
function insetPolygon(points, inset) {
  const count = points.length;
  const centroid = points.reduce((sum, [x, y]) => [sum[0] + x / count, sum[1] + y / count], [0, 0]);
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % count];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    let nx = -dy / length;
    let ny = dx / length;
    if ((centroid[0] - a[0]) * nx + (centroid[1] - a[1]) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    lines.push({ point: [a[0] + nx * inset, a[1] + ny * inset], dir: [dx, dy] });
  }
  const result = [];
  for (let i = 0; i < count; i += 1) {
    const first = lines[(i + count - 1) % count];
    const second = lines[i];
    const denom = first.dir[0] * second.dir[1] - first.dir[1] * second.dir[0];
    if (Math.abs(denom) < 1e-9) continue;
    const t = ((second.point[0] - first.point[0]) * second.dir[1] - (second.point[1] - first.point[1]) * second.dir[0]) / denom;
    result.push([
      Math.round(first.point[0] + first.dir[0] * t),
      Math.round(first.point[1] + first.dir[1] * t),
    ]);
  }
  return result;
}

/**
 * The contour rows/columns of the silhouette for one side, in texture px:
 * `extreme` is the outermost contour (min for up/left, max for down/right) and
 * `farthest` is the innermost one across the edge span (used to size the crop
 * so a rounded corner still gets its band).
 */
function contourExtents(silhouette, side) {
  const { width, height, mask } = silhouette;
  let extreme = side === 'up' || side === 'left' ? Infinity : -Infinity;
  let farthest = side === 'up' || side === 'left' ? -Infinity : Infinity;
  const record = (value) => {
    if (side === 'up' || side === 'left') {
      extreme = Math.min(extreme, value);
      farthest = Math.max(farthest, value);
    } else {
      extreme = Math.max(extreme, value);
      farthest = Math.min(farthest, value);
    }
  };
  if (side === 'up' || side === 'down') {
    for (let x = silhouette.left; x < silhouette.right; x += 1) {
      let contour = -1;
      if (side === 'up') {
        for (let y = silhouette.top; y < silhouette.bottom; y += 1) {
          if (mask[y * width + x]) {
            contour = y;
            break;
          }
        }
      } else {
        for (let y = silhouette.bottom - 1; y >= silhouette.top; y -= 1) {
          if (mask[y * width + x]) {
            contour = y;
            break;
          }
        }
      }
      if (contour >= 0) record(contour);
    }
  } else {
    for (let y = silhouette.top; y < silhouette.bottom; y += 1) {
      let contour = -1;
      if (side === 'left') {
        for (let x = silhouette.left; x < silhouette.right; x += 1) {
          if (mask[y * width + x]) {
            contour = x;
            break;
          }
        }
      } else {
        for (let x = silhouette.right - 1; x >= silhouette.left; x -= 1) {
          if (mask[y * width + x]) {
            contour = x;
            break;
          }
        }
      }
      if (contour >= 0) record(contour);
    }
  }
  return { extreme, farthest };
}

/**
 * The support box for one side, in *texture* coordinates. The band may extend
 * outside the shell texture (the body's padding is only 2 px), so the outward
 * side is not clamped to the image. The tangential span is the silhouette bbox.
 */
function supportBox(silhouette, side, sigma) {
  const outward = Math.ceil(SUPPORT_SIGMA * sigma) + 6;
  const { left, top, right, bottom } = silhouette;
  const { extreme, farthest } = contourExtents(silhouette, side);
  if (side === 'up') return { x: left, y: extreme - outward, width: right - left, height: farthest - (extreme - outward) };
  if (side === 'down') {
    const y0 = farthest;
    return { x: left, y: y0, width: right - left, height: extreme + outward - y0 };
  }
  if (side === 'left') {
    const x0 = extreme - outward;
    return { x: x0, y: top, width: farthest - x0, height: bottom - top };
  }
  const x0 = farthest;
  return { x: x0, y: top, width: extreme + outward - x0, height: bottom - top };
}

/**
 * Fill one band. `crop` is the support box in this image's pixel space; for the
 * 2x pass it is exactly 2x the 1x crop, so the two textures describe the same
 * rectangle. Returns straight-alpha RGBA.
 */
function bandImage(image, silhouette, side, crop, sigma, fade) {
  const data = Buffer.alloc(crop.width * crop.height * 4);
  const cutoff = SUPPORT_SIGMA * sigma;
  let peak = 0;
  let nonzero = 0;

  const write = (lx, ly, alpha) => {
    if (alpha <= 0) return;
    const index = (ly * crop.width + lx) * 4;
    data[index] = INK[0];
    data[index + 1] = INK[1];
    data[index + 2] = INK[2];
    data[index + 3] = Math.round(Math.min(1, alpha) * 255);
    peak = Math.max(peak, alpha);
    nonzero += 1;
  };

  const tangent = (position, start, end) => {
    if (fade <= 0) return 1;
    const fromStart = (position - start) / fade;
    const fromEnd = (end - 1 - position) / fade;
    return Math.max(0, Math.min(1, Math.min(fromStart, fromEnd)));
  };

  if (side === 'up' || side === 'down') {
    for (let lx = 0; lx < crop.width; lx += 1) {
      const x = crop.x + lx;
      if (x < 0 || x >= silhouette.width) continue;
      let contour = -1;
      if (side === 'up') {
        for (let y = 0; y < silhouette.height; y += 1) {
          if (silhouette.mask[y * silhouette.width + x]) {
            contour = y;
            break;
          }
        }
      } else {
        for (let y = silhouette.height - 1; y >= 0; y -= 1) {
          if (silhouette.mask[y * silhouette.width + x]) {
            contour = y;
            break;
          }
        }
      }
      if (contour < 0) continue;
      const t = tangent(x, silhouette.left, silhouette.right);
      if (t <= 0) continue;
      for (let ly = 0; ly < crop.height; ly += 1) {
        const y = crop.y + ly;
        const d = side === 'up' ? contour - y - 0.5 : y - contour - 0.5;
        if (d <= 0 || d > cutoff) continue;
        const alpha = CORE * Math.exp(-0.5 * (d / sigma) ** 2) * t;
        write(lx, ly, alpha);
      }
    }
  } else {
    for (let ly = 0; ly < crop.height; ly += 1) {
      const y = crop.y + ly;
      if (y < 0 || y >= silhouette.height) continue;
      let contour = -1;
      if (side === 'left') {
        for (let x = 0; x < silhouette.width; x += 1) {
          if (silhouette.mask[y * silhouette.width + x]) {
            contour = x;
            break;
          }
        }
      } else {
        for (let x = silhouette.width - 1; x >= 0; x -= 1) {
          if (silhouette.mask[y * silhouette.width + x]) {
            contour = x;
            break;
          }
        }
      }
      if (contour < 0) continue;
      const t = tangent(y, silhouette.top, silhouette.bottom);
      if (t <= 0) continue;
      for (let lx = 0; lx < crop.width; lx += 1) {
        const x = crop.x + lx;
        const d = side === 'left' ? contour - x - 0.5 : x - contour - 0.5;
        if (d <= 0 || d > cutoff) continue;
        const alpha = CORE * Math.exp(-0.5 * (d / sigma) ** 2) * t;
        write(lx, ly, alpha);
      }
    }
  }
  return { width: crop.width, height: crop.height, data, peak, nonzero };
}

/** Load one shell at one scale and cache its silhouette. */
const imageCache = new Map();
function imageOf(shellId, scale) {
  const key = `${shellId}@${scale}`;
  if (!imageCache.has(key)) {
    const shell = shells[shellId];
    const file = scale === 1 ? shell.textureFile : shell.textureFile2x;
    imageCache.set(key, readPng(resolve(tableDir, file)));
  }
  return imageCache.get(key);
}
const silhouetteCache = new Map();
function silhouetteOfShell(shellId, scale) {
  const key = `${shellId}@${scale}`;
  if (!silhouetteCache.has(key)) {
    silhouetteCache.set(key, silhouetteOf(imageOf(shellId, scale)));
  }
  return silhouetteCache.get(key);
}

/**
 * Which sides to bake, canonicalised across the alias map. Two shells with the
 * same drawn body geometry are still baked separately unless aliased: a hand
 * slot's silhouette is unique even when its body box matches.
 */
const targets = new Map();
for (const key of Object.keys(sidesReport.sides)) {
  const [shell, side] = key.split(':');
  if (!shells[shell]) throw new Error(`overlays-sides.json names missing shell ${shell}`);
  const canonical = canonicalOf(shell);
  targets.set(`${canonical}:${side}`, { shell: canonical, side });
}
const targetList = [...targets.values()].sort(
  (a, b) => a.shell.localeCompare(b.shell) || a.side.localeCompare(b.side),
);

const outputDir = resolve(renderDir, overlaySpec.outputDir);
const output2xDir = resolve(renderDir, overlaySpec.output2xDir);
const outputManifestPath = resolve(renderDir, overlaySpec.manifest);

if (!dryRun) {
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(output2xDir, { recursive: true });
  for (const directory of [outputDir, output2xDir]) {
    for (const file of readdirSync(directory)) {
      if (file.endsWith('.png')) unlinkSync(join(directory, file));
    }
  }
}

const decals = {};
let total1x = 0;
let total2x = 0;
let generated = 0;

for (const { shell: shellId, side } of targetList) {
  const shell = shells[shellId];
  const sigma1x = shell.shadowShape.lying ? SIGMA.lying : SIGMA.standing;
  const silhouette1x = silhouetteOfShell(shellId, 1);
  const crop1x = supportBox(silhouette1x, side, sigma1x);
  // (band1x is filled after the crop union below, so both scales share a box.)

  const sigma2x = sigma1x * PIXEL_RATIO;
  const silhouette2x = silhouetteOfShell(shellId, 2);
  const crop2xRequired = supportBox(silhouette2x, side, sigma2x);
  // The 2x file must be exactly twice the 1x texture. Grow the 1x box until its
  // doubled box contains the 2x contour's own support, so the 2x band's outer
  // ring is empty instead of being cut by the crop.
  const crop1xFinal = {
    x: Math.min(crop1x.x, Math.floor(crop2xRequired.x / PIXEL_RATIO)),
    y: Math.min(crop1x.y, Math.floor(crop2xRequired.y / PIXEL_RATIO)),
  };
  const right1x = Math.ceil(
    Math.max(crop1x.x + crop1x.width, (crop2xRequired.x + crop2xRequired.width) / PIXEL_RATIO),
  );
  const bottom1x = Math.ceil(
    Math.max(crop1x.y + crop1x.height, (crop2xRequired.y + crop2xRequired.height) / PIXEL_RATIO),
  );
  crop1xFinal.width = right1x - crop1xFinal.x;
  crop1xFinal.height = bottom1x - crop1xFinal.y;
  const crop2x = {
    x: crop1xFinal.x * PIXEL_RATIO,
    y: crop1xFinal.y * PIXEL_RATIO,
    width: crop1xFinal.width * PIXEL_RATIO,
    height: crop1xFinal.height * PIXEL_RATIO,
  };
  const band1x = bandImage(imageOf(shellId, 1), silhouette1x, side, crop1xFinal, sigma1x, FADE);
  const band2x = bandImage(
    imageOf(shellId, 2),
    silhouette2x,
    side,
    crop2x,
    sigma2x,
    FADE * PIXEL_RATIO,
  );

  const base = `${shellId}--${side}`;
  const file1x = `${base}.png`;
  const file2x = join('2x', `${base}.png`);
  const png1x = encodePng(band1x.width, band1x.height, 4, band1x.data);
  const png2x = encodePng(band2x.width, band2x.height, 4, band2x.data);

  const bodyAnchorX = crop1xFinal.x - shell.anchorX;
  const bodyAnchorY = crop1xFinal.y - shell.anchorY;
  const record = {
    shell: shellId,
    contact: side,
    textureFile: `overlays/${file1x}`,
    textureFile2x: `overlays/${file2x}`,
    texWidth: crop1xFinal.width,
    texHeight: crop1xFinal.height,
    bodyAnchorX,
    bodyAnchorY,
    supportPx: {
      x: bodyAnchorX,
      y: bodyAnchorY,
      width: crop1xFinal.width,
      height: crop1xFinal.height,
    },
    peakAlpha: Math.round(band1x.peak * 1000) / 1000,
    sha256: {
      decodedRgba1x: sha256(band1x.data),
      decodedRgba2x: sha256(band2x.data),
    },
    bytes1x: png1x.length,
    bytes2x: png2x.length,
  };
  decals[`${shellId}:${side}`] = record;
  total1x += png1x.length;
  total2x += png2x.length;
  generated += 1;

  if (!dryRun) {
    writeFileSync(join(outputDir, file1x), png1x);
    writeFileSync(join(output2xDir, basename(file2x)), png2x);
    if (verifyDeterminism) {
      const again = bandImage(imageOf(shellId, 1), silhouette1x, side, crop1x, sigma1x, FADE);
      if (sha256(again.data) !== record.sha256.decodedRgba1x) {
        throw new Error(`${base} is not deterministic`);
      }
    }
  }
}

// One clip polygon per shell, in drawn body-box coordinates. Every shell is
// published, so a future zone cannot meet an undeclared neighbour.
const bodyQuads = {};
for (const shellId of Object.keys(shells)) {
  const shell = shells[shellId];
  const silhouette = silhouetteOfShell(shellId, 1);
  bodyQuads[shellId] = bodyPolygon(silhouette).map(([x, y]) => [
    x - shell.anchorX,
    y - shell.anchorY,
  ]);
}

const manifest = {
  version: 1,
  generatedBy: 'tools/render/scripts/bake_overlays.mjs',
  pixelRatio: PIXEL_RATIO,
  model: {
    kind: 'contact-ao-band',
    anchor:
      'bodyAnchorX/bodyAnchorY are the decal texture top-left relative to the caster drawn body-box top-left; draw at bodyLeft + bodyAnchorX',
    clip:
      'draw after the neighbour body, clip to its bodyQuads polygon, then draw the caster body',
    coreAlpha: CORE,
    sigmaPx1x: { lying: SIGMA.lying, standing: SIGMA.standing },
    tangentFadePx1x: FADE,
    supportSigma: SUPPORT_SIGMA,
    colorHex: overlaySpec.colorHex,
  },
  aliases,
  bodyQuads,
  decals,
};

if (!dryRun) {
  writeFileSync(outputManifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const bySide = {};
for (const record of Object.values(decals)) {
  bySide[record.contact] = (bySide[record.contact] ?? 0) + 1;
}
console.log(
  `[overlays] ${generated} decals from ${Object.keys(sidesReport.sides).length} layout keys ` +
    `(${Object.keys(aliases).length} faceup aliases)`,
);
console.log(
  `[overlays] sides ${Object.entries(bySide)
    .map(([side, count]) => `${side} ${count}`)
    .join(', ')}`,
);
console.log(
  `[overlays] textures ${total1x} B @1x + ${total2x} B @2x = ${total1x + total2x} B ` +
    `(${((total1x + total2x) / 1024).toFixed(1)} KiB); advisory budgets per AGENTS.md §1c`,
);
const largest = Object.values(decals).sort((a, b) => b.bytes1x - a.bytes1x)[0];
if (largest) {
  console.log(
    `[overlays] largest ${largest.shell}:${largest.contact} ` +
      `${largest.texWidth}x${largest.texHeight} ${largest.bytes1x} B @1x`,
  );
}
console.log(
  dryRun
    ? '[overlays] dry run: wrote nothing'
    : `[overlays] wrote ${outputManifestPath} and ${generated} textures`,
);
