#!/usr/bin/env node
/**
 * Integrity check for the 2.5D rendered-view assets.
 *
 *   node tools/render/scripts/check-shells.mjs
 *
 * Dependency-free on purpose: it runs in CI and on any machine with Node, and
 * it never needs Blender. It validates facts, not looks:
 *
 *   - the shell spec still catalogs exactly the canonical shells, with the
 *     0.055 / 6-segment bevel and the matching face inset;
 *   - the committed full-screen felt raster exists, decodes as 8-bit RGB PNG at
 *     the spec's size, is inside its byte budget, and its baked vignette really
 *     darkens toward the screen edges (centre/corner ratio, edge symmetry, no
 *     clipping, real mottling);
 *   - `frontend/public/table/shells.json` and both texture scales exist, the
 *     @2x rasters are exactly twice the @1x rasters, the declared anchor +
 *     advance + padding equals the texture size, the measured opaque body sits
 *     exactly one pixel inside the declared body (the anti-aliased edge ledge),
 *     every `faceQuad` is a non-degenerate clockwise quad inside the body, the
 *     shadow/AO alpha profile stays inside the 3-4 px right/bottom and 1-2 px
 *     top/left contract, the light really comes from the top-left (top edge
 *     brighter than the bottom edge, cool dark thickness on the bottom), the
 *     face-up shells are ivory while the face-down shells are blue, and the
 *     decoded RGBA hashes in the manifest match the committed PNGs (a
 *     hand-edited or drifted bake fails here);
 *   - per-shell and total byte budgets.
 *
 * `--audition` adds the candidate matrix: the spec's `audition` block,
 * `build/review/shell-candidates.json` and every candidate texture at the new
 * base (both scales, padding/anchor/advance, 1 px ledge, shadow/AO contract,
 * faceQuad, gridStepPx, hashes) plus the labelled sheets under
 * `build/review/shell-candidates-<shell>.png`, whose exact bitmap-font colours
 * and composited-tile pixel counts prove the parameters were printed.
 *
 * Visual quality is the user's call (AGENTS.md §6). This script only prints
 * numbers and pass/fail.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shellSpecPath = join(renderDir, 'shell-spec.json');
const feltSpecPath = join(renderDir, 'felt-spec.json');

const CANONICAL_SHELL_IDS = [
  'shell_hand_standing',
  'shell_flat_upright',
  'shell_flat_sideways',
  'shell_wall_horizontal',
  'shell_wall_horizontal_faceup',
  'shell_wall_side_left',
  'shell_wall_side_left_faceup',
  'shell_wall_side_right',
  'shell_wall_side_right_faceup',
];

const FACE_UP = new Set([
  'shell_hand_standing',
  'shell_flat_upright',
  'shell_flat_sideways',
  'shell_wall_horizontal_faceup',
  'shell_wall_side_left_faceup',
  'shell_wall_side_right_faceup',
]);
const FACE_DOWN = new Set([
  'shell_wall_horizontal',
  'shell_wall_side_left',
  'shell_wall_side_right',
]);
const WALL = new Set([
  'shell_wall_horizontal',
  'shell_wall_horizontal_faceup',
  'shell_wall_side_left',
  'shell_wall_side_left_faceup',
  'shell_wall_side_right',
  'shell_wall_side_right_faceup',
]);
// Phase 1c shadow contract, in @1x px / alpha. The committed bake and every
// audition candidate must satisfy it.
const SHADOW_EXTENT = { right: [10, 16], bottom: [10, 16], left: [1, 2], top: [1, 2] };
const SHADOW_PEAK = { right: [0.08, 0.16], bottom: [0.08, 0.16], left: [0.14, 0.26], top: [0.14, 0.26] };

const failures = [];
let checks = 0;

function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`);
}

function note(message) {
  console.log(`INFO ${message}`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function regionStats(image, x0, y0, x1, y1, step = 1) {
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(image.width, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(image.height, Math.ceil(y1));
  let sum = 0;
  let sumSquares = 0;
  let count = 0;
  let clipped = 0;
  for (let y = top; y < bottom; y += step) {
    for (let x = left; x < right; x += step) {
      const i = y * image.stride + x * image.channels;
      const value = luma(image.data[i], image.data[i + 1], image.data[i + 2]);
      sum += value;
      sumSquares += value * value;
      count += 1;
      if (image.data[i] === 0 || image.data[i] === 255) clipped += 1;
    }
  }
  const mean = count ? sum / count : 0;
  const variance = count ? sumSquares / count - mean * mean : 0;
  return { mean, stdDev: Math.sqrt(Math.max(0, variance)), count, clipped };
}

function percentDelta(a, b) {
  return (Math.abs(a - b) / Math.max(1e-6, (a + b) / 2)) * 100;
}

// --------------------------------------------------------------------------- //
// PNG helpers over a decoded image
// --------------------------------------------------------------------------- //

function pixel(image, x, y) {
  const i = y * image.stride + x * image.channels;
  return [image.data[i], image.data[i + 1], image.data[i + 2], image.channels === 4 ? image.data[i + 3] : 255];
}

function alphaBBox(image, threshold = 128) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[y * image.stride + x * 4 + 3] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null;
}

/** Extent / peak / mass of nonzero alpha outside the declared body box. */
function alphaProfile(image, body) {
  const { x0, y0, x1, y1 } = body;
  const outside = (x, y) => x < x0 || x > x1 || y < y0 || y > y1;
  const alpha = (x, y) => image.data[y * image.stride + x * 4 + 3] / 255;
  const extent = { left: 0, top: 0, right: 0, bottom: 0 };
  const peak = { left: 0, top: 0, right: 0, bottom: 0 };
  const mass = { left: 0, top: 0, right: 0, bottom: 0 };
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (!outside(x, y)) continue;
      const value = alpha(x, y);
      if (value <= 2 / 255) continue;
      const inColumn = y >= y0 && y <= y1;
      const inRow = x >= x0 && x <= x1;
      const sides = [];
      if (x > x1) sides.push('right');
      if (x < x0) sides.push('left');
      if (y > y1) sides.push('bottom');
      if (y < y0) sides.push('top');
      for (const side of sides) {
        if (side === 'right') extent.right = Math.max(extent.right, x - x1);
        if (side === 'left') extent.left = Math.max(extent.left, x0 - x);
        if (side === 'bottom') extent.bottom = Math.max(extent.bottom, y - y1);
        if (side === 'top') extent.top = Math.max(extent.top, y0 - y);
        const corner = (side === 'left' || side === 'right') ? !inColumn : !inRow;
        if (!corner) {
          peak[side] = Math.max(peak[side], value);
          mass[side] += value;
        }
      }
    }
  }
  for (const side of Object.keys(mass)) mass[side] = Number(mass[side].toFixed(3));
  for (const side of Object.keys(peak)) peak[side] = Number(peak[side].toFixed(4));
  return { extent, peak, mass };
}

function nearestBorderAlpha(image) {
  let max = 0;
  for (let x = 0; x < image.width; x += 1) {
    max = Math.max(max, pixel(image, x, 0)[3], pixel(image, x, image.height - 1)[3]);
  }
  for (let y = 0; y < image.height; y += 1) {
    max = Math.max(max, pixel(image, 0, y)[3], pixel(image, image.width - 1, y)[3]);
  }
  return max;
}

function meanOpaqueRgb(image) {
  let sum = [0, 0, 0];
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const [r, g, b, a] = pixel(image, x, y);
      if (a < 250) continue;
      sum[0] += r;
      sum[1] += g;
      sum[2] += b;
      count += 1;
    }
  }
  return count ? sum.map((value) => value / count) : [0, 0, 0];
}

/** 2x2 box downsample of an RGBA image in premultiplied space. */
function downsample2x(image) {
  const width = image.width / 2;
  const height = image.height / 2;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = [0, 0, 0];
      let alphaSum = 0;
      for (let dy = 0; dy < 2; dy += 1) {
        for (let dx = 0; dx < 2; dx += 1) {
          const [r, g, b, a] = pixel(image, x * 2 + dx, y * 2 + dy);
          const alpha = a / 255;
          sum[0] += r * alpha;
          sum[1] += g * alpha;
          sum[2] += b * alpha;
          alphaSum += alpha;
        }
      }
      const target = (y * width + x) * 4;
      const outAlpha = alphaSum / 4;
      for (let channel = 0; channel < 3; channel += 1) {
        data[target + channel] = Math.round(sum[channel] / Math.max(1e-6, alphaSum));
      }
      data[target + 3] = Math.round(outAlpha * 255);
    }
  }
  return { width, height, data, channels: 4, stride: width * 4 };
}

// --------------------------------------------------------------------------- //
// Spec checks
// --------------------------------------------------------------------------- //

function checkShellSpec(spec) {
  check(spec.version === 1, 'shell-spec.json version is 1');  const ids = spec.shells.map((shell) => shell.id);
  check(
    ids.length === CANONICAL_SHELL_IDS.length && new Set(ids).size === ids.length,
    `shell catalogue has ${ids.length} unique shells`,
  );
  for (const id of CANONICAL_SHELL_IDS) {
    check(ids.includes(id), `catalogue contains ${id}`);
  }
  check(spec.tile.bevel.width === 0.055, `bevel width is 0.055 (${spec.tile.bevel.width})`);
  check(spec.tile.bevel.segments === 6, `bevel segments is 6 (${spec.tile.bevel.segments})`);
  check(
    spec.tile.faceInset === spec.tile.bevel.width,
    `faceInset matches the bevel (${spec.tile.faceInset})`,
  );
  check(
    spec.tile.backEdgeFraction > 0 && spec.tile.backEdgeFraction < 1,
    `backEdgeFraction is inside (0, 1) (${spec.tile.backEdgeFraction})`,
  );
  check(
    spec.blender.requiredVersion === '4.5.9',
    `Blender is pinned to 4.5.9 (${spec.blender.requiredVersion})`,
  );
  check(spec.outputs.manifest.endsWith('shells.json'), 'manifest output is shells.json');
  check(spec.bakeImplemented === true, 'bakeImplemented is true (Phase 1 owns the bake)');
  const pads = spec.bake.padding1x;
  check(
    pads.right >= 10 && pads.right <= 20 && pads.bottom >= 10 && pads.bottom <= 20,
    `padding1x right/bottom hold the diffuse 10-16 px shadow (${pads.right}/${pads.bottom})`,
  );
  check(
    pads.left >= 1 && pads.left <= 2 && pads.top >= 1 && pads.top <= 2,
    `padding1x left/top are 1-2 px (${pads.left}/${pads.top})`,
  );
  check(
    spec.bake.shadow.peakAlpha >= 0.08 && spec.bake.shadow.peakAlpha <= 0.16,
    `shadow peak is diffuse and subtle (${spec.bake.shadow.peakAlpha})`,
  );
  check(
    spec.bake.shadow.blurPx2x >= 4,
    `shadow blur is at least 4 px @1x (${spec.bake.shadow.blurPx2x})`,
  );
  check(
    typeof spec.bake.shadowContract?.note === 'string' && spec.bake.shadowContract.note.includes('diffuse'),
    'the Phase 1c shadow decision is documented',
  );
  check(
    spec.tile.stack?.count === 2,
    `a wall column is a ${spec.tile.stack?.count}-tile stack`,
  );
  check(spec.bake.pixelRatio === 2, `bake.pixelRatio is 2 (${spec.bake.pixelRatio})`);
  // The baker derives the box from the jansou ratio; the manifest's faceQuad
  // and gridStepPx are checked against the same derivation.
  const proportions = spec.tile.proportionsMm;
  spec.tile.height = spec.tile.heightUnits;
  spec.tile.width = (spec.tile.heightUnits * proportions.width) / proportions.height;
  spec.tile.thickness = (spec.tile.heightUnits * proportions.thickness) / proportions.height;
  check(
    Math.abs(spec.tile.width - 0.75) <= 1e-9 && Math.abs(spec.tile.height - 1) <= 1e-9,
    `tile box is ${spec.tile.width.toFixed(3)} x ${spec.tile.height.toFixed(3)} x ${spec.tile.thickness.toFixed(3)} units`,
  );
}

function checkFeltSpec(spec) {
  check(spec.version === 1, 'felt-spec.json version is 1');
  check(spec.colorType === 'rgb8', `felt colour type is rgb8 (${spec.colorType})`);
  check(spec.width > 0 && spec.height > 0, `felt size is ${spec.width}x${spec.height}`);
  check(spec.noise.length >= 1, `felt noise has ${spec.noise.length} octave(s)`);
  check(
    spec.vignette.outerRadius > spec.vignette.innerRadius,
    'vignette outer radius is greater than the inner radius',
  );
}

function checkFelt(spec) {
  const feltPath = resolve(renderDir, spec.output);
  check(existsSync(feltPath), `felt raster exists (${feltPath})`);
  if (!existsSync(feltPath)) return;

  const image = readPng(feltPath);
  check(
    image.colorType === 2 && image.channels === 3,
    `felt is RGB with no alpha (colour type ${image.colorType})`,
  );
  check(
    image.width === spec.width && image.height === spec.height,
    `felt decodes at ${image.width}x${image.height} (spec ${spec.width}x${spec.height})`,
  );
  const budget = spec.budgets.bytes;
  check(image.bytes <= budget, `felt is ${image.bytes} B (budget ${budget} B)`);

  const bandX = Math.max(1, Math.round(image.width / 20));
  const bandY = Math.max(1, Math.round(image.height / 20));
  const cx = Math.round(image.width / 2);
  const cy = Math.round(image.height / 2);
  const centre = regionStats(image, cx - bandX, cy - bandY, cx + bandX, cy + bandY, 2);
  const left = regionStats(image, 0, cy - bandY, bandX, cy + bandY, 2);
  const right = regionStats(image, image.width - bandX, cy - bandY, image.width, cy + bandY, 2);
  const top = regionStats(image, cx - bandX, 0, cx + bandX, bandY, 2);
  const bottom = regionStats(
    image,
    cx - bandX,
    image.height - bandY,
    cx + bandX,
    image.height,
    2,
  );
  const corners = [
    regionStats(image, 0, 0, bandX, bandY, 2),
    regionStats(image, image.width - bandX, 0, image.width, bandY, 2),
    regionStats(image, 0, image.height - bandY, bandX, image.height, 2),
    regionStats(image, image.width - bandX, image.height - bandY, image.width, image.height, 2),
  ];
  const cornerMean = corners.reduce((sum, corner) => sum + corner.mean, 0) / corners.length;
  const ratio = centre.mean / Math.max(1e-6, cornerMean);
  console.log(
    `INFO felt luma centre ${centre.mean.toFixed(2)}, corners ${cornerMean.toFixed(2)}, ` +
      `ratio ${ratio.toFixed(3)}, stdDev ${centre.stdDev.toFixed(2)}`,
  );
  console.log(
    `INFO felt edges L/R ${left.mean.toFixed(2)}/${right.mean.toFixed(2)} ` +
      `T/B ${top.mean.toFixed(2)}/${bottom.mean.toFixed(2)}`,
  );
  check(ratio >= 1.5, `vignette centre/corner luma ratio is ${ratio.toFixed(3)} (>= 1.5)`);
  check(centre.mean > top.mean && centre.mean > bottom.mean, 'vignette darkens top and bottom edges');
  check(centre.mean > left.mean && centre.mean > right.mean, 'vignette darkens left and right edges');
  // The vignette is geometrically symmetric, but the mottled felt noise is not
  // mirrored. These bands are therefore a coarse asymmetry check (a broken or
  // off-centre vignette is off by tens of percent), not a pixel-equality test.
  check(
    percentDelta(left.mean, right.mean) <= 6,
    `left/right edge symmetry is ${percentDelta(left.mean, right.mean).toFixed(3)}% (<= 6%)`,
  );
  check(
    percentDelta(top.mean, bottom.mean) <= 6,
    `top/bottom edge symmetry is ${percentDelta(top.mean, bottom.mean).toFixed(3)}% (<= 6%)`,
  );
  // A flat colour is stdDev 0; anything above this is real cloth mottling. The
  // amount is a low-contrast look decision for the user, not a pass/fail fact.
  check(centre.stdDev >= 0.25, `felt centre is mottled (stdDev ${centre.stdDev.toFixed(2)} >= 0.25)`);
  check(
    centre.clipped === 0,
    `felt centre has no clipped samples (${centre.clipped} px)`,
  );
  check(
    image.data.length === image.width * image.height * 3,
    'felt decoded buffer length matches its dimensions',
  );
}

// --------------------------------------------------------------------------- //
// shells.json checks
// --------------------------------------------------------------------------- //

function checkRig(manifest, spec) {
  const rig = manifest.rig;
  check(Boolean(rig), 'shells.json carries rig metadata');
  if (!rig) return;
  check(rig.blender.startsWith(spec.blender.requiredVersion), `rig Blender is ${rig.blender}`);
  check(rig.engine === spec.scene.engine, `rig engine is ${rig.engine}`);
  check(rig.device === 'CPU', `rig device is CPU (${rig.device})`);
  check(rig.samples === spec.scene.samples, `rig samples is ${rig.samples}`);
  check(rig.seed === 0, `rig seed is 0 (${rig.seed})`);
  check(
    rig.colorManagement?.viewTransform === spec.scene.colorManagement.viewTransform,
    `rig view transform is ${rig.colorManagement?.viewTransform}`,
  );
  const direction = rig.key?.screenDirection ?? [];
  const length = Math.hypot(...direction);
  check(
    direction.length === 3 && Math.abs(length - 1) <= 0.01,
    `rig key screen direction is a unit vector (length ${length.toFixed(4)})`,
  );
  check(
    direction[0] < 0 && direction[1] > 0 && direction[2] > 0,
    `rig key is top-left-front in screen space (${direction.join(', ')})`,
  );
  check(
    typeof rig.determinism === 'string' && rig.determinism.includes('sha256'),
    'rig determinism records the decoded-RGBA sha256 contract',
  );
  check(
    typeof manifest.coordinateSpace === 'string' && manifest.coordinateSpace.includes('top-left'),
    'shells.json documents its coordinate space',
  );
  check(
    rig.stack?.count === spec.tile.stack.count,
    `rig records the ${rig.stack?.count}-tile wall stack`,
  );
  check(
    rig.shadowContract?.phase === spec.bake.shadowContract.phase,
    `rig records the ${rig.shadowContract?.phase} shadow contract`,
  );
}

function checkShellsManifest(spec) {
  const manifestPath = resolve(renderDir, spec.outputs.manifest);
  const manifestBudget = spec.budgets.manifestBytes;
  if (!existsSync(manifestPath)) {
    note(`shells.json not present yet (${manifestPath}); run bake-shells.sh`);
    return;
  }
  const manifestBytes = statSync(manifestPath).size;
  check(
    manifestBytes <= manifestBudget,
    `shells.json is ${manifestBytes} B (budget ${manifestBudget} B)`,
  );
  const manifest = readJson(manifestPath);
  check(manifest.version === 1, 'shells.json version is 1');
  check(
    manifest.pixelRatio === spec.bake.pixelRatio,
    `shells.json pixelRatio is ${manifest.pixelRatio}`,
  );
  check(manifest.shells && typeof manifest.shells === 'object', 'shells.json has a shells map');
  checkRig(manifest, spec);

  const ids = Object.keys(manifest.shells ?? {});
  check(
    ids.length === CANONICAL_SHELL_IDS.length,
    `shells.json has ${ids.length} shells (${CANONICAL_SHELL_IDS.length})`,
  );
  const specRotation = new Map(spec.shells.map((shell) => [shell.id, shell.faceRotationDeg]));
  const pads = spec.bake.padding1x;
  let totalBytes = 0;

  for (const id of CANONICAL_SHELL_IDS) {
    const shell = manifest.shells?.[id];
    check(Boolean(shell), `shells.json contains ${id}`);
    if (!shell) continue;
    check(
      typeof shell.textureFile === 'string' &&
        shell.textureFile.startsWith('shells/') &&
        shell.textureFile.endsWith('.png'),
      `${id} textureFile is a PNG under shells/ (${shell.textureFile})`,
    );
    check(
      typeof shell.textureFile2x === 'string' &&
        shell.textureFile2x.startsWith('shells/') &&
        shell.textureFile2x.endsWith('.png'),
      `${id} textureFile2x is a PNG under shells/ (${shell.textureFile2x})`,
    );
    check(
      shell.faceRotationDeg === specRotation.get(id),
      `${id} faceRotationDeg is ${shell.faceRotationDeg} (spec ${specRotation.get(id)})`,
    );
    const texturePath = resolve(dirname(manifestPath), shell.textureFile ?? '');
    const texture2xPath = resolve(dirname(manifestPath), shell.textureFile2x ?? '');
    check(existsSync(texturePath), `${id} texture exists (${shell.textureFile})`);
    check(existsSync(texture2xPath), `${id} @2x texture exists (${shell.textureFile2x})`);
    if (!existsSync(texturePath) || !existsSync(texture2xPath)) continue;

    const image = readPng(texturePath);
    const image2x = readPng(texture2xPath);
    const bytes = image.bytes + image2x.bytes;
    totalBytes += bytes;
    check(
      image.channels === 4 && image2x.channels === 4,
      `${id} textures are RGBA (colour types ${image.colorType}/${image2x.colorType})`,
    );
    check(
      image.width === shell.texWidth && image.height === shell.texHeight,
      `${id} texture is ${image.width}x${image.height} (declared ${shell.texWidth}x${shell.texHeight})`,
    );
    check(
      image2x.width === shell.texWidth * manifest.pixelRatio &&
        image2x.height === shell.texHeight * manifest.pixelRatio,
      `${id} @2x texture is ${image2x.width}x${image2x.height} ` +
        `(declared ${shell.texWidth * manifest.pixelRatio}x${shell.texHeight * manifest.pixelRatio})`,
    );
    check(bytes <= spec.budgets.shellBytes, `${id} is ${bytes} B (budget ${spec.budgets.shellBytes} B)`);

    const padding = shell.padding ?? {};
    check(
      padding.left === pads.left && padding.top === pads.top && padding.right === pads.right && padding.bottom === pads.bottom,
      `${id} padding matches the spec (${padding.left}/${padding.top}/${padding.right}/${padding.bottom})`,
    );
    check(shell.anchorX === padding.left, `${id} anchorX ${shell.anchorX} equals left padding ${padding.left}`);
    check(shell.anchorY === padding.top, `${id} anchorY ${shell.anchorY} equals top padding ${padding.top}`);
    check(
      shell.anchorX + shell.advanceWidth + padding.right === shell.texWidth,
      `${id} anchorX + advanceWidth + right padding equals texWidth`,
    );
    check(
      shell.anchorY + shell.advanceHeight + padding.bottom === shell.texHeight,
      `${id} anchorY + advanceHeight + bottom padding equals texHeight`,
    );
    check(shell.advanceWidth > 0 && shell.advanceHeight > 0, `${id} advance box is non-empty`);

    const body = {
      x0: shell.anchorX,
      y0: shell.anchorY,
      x1: shell.anchorX + shell.advanceWidth - 1,
      y1: shell.anchorY + shell.advanceHeight - 1,
    };

    // The declared body includes a one-pixel anti-aliased edge ledge, so the
    // measured opaque silhouette must sit exactly one pixel inside it.
    const solid = alphaBBox(image);
    const inset = solid
      ? [solid.x0 - body.x0, solid.y0 - body.y0, body.x1 - solid.x1, body.y1 - solid.y1]
      : [];
    check(
      Boolean(solid) && inset.every((value) => value === 1),
      `${id} opaque body is inset 1 px inside the declared body (${inset.join('/')})`,
    );

    const quad = shell.faceQuad;
    check(Array.isArray(quad) && quad.length === 4, `${id} faceQuad has four corners`);
    check(
      shell.faceQuadOrder === 'face-local [top-left, top-right, bottom-right, bottom-left]',
      `${id} faceQuad declares its corner order`,
    );
    if (Array.isArray(quad) && quad.length === 4) {
      const inside = quad.every(
        ([x, y]) =>
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= body.x0 &&
          x <= body.x1 + 1 &&
          y >= body.y0 &&
          y <= body.y1 + 1,
      );
      check(inside, `${id} faceQuad lies inside the opaque body`);
      const cross = (a, b, c) =>
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      const signs = [0, 1, 2, 3].map((i) =>
        Math.sign(cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4])),
      );
      check(
        signs.every((sign) => sign !== 0 && sign === signs[0]),
        `${id} faceQuad is convex`,
      );
      let area = 0;
      for (let i = 0; i < 4; i += 1) {
        const [x0, y0] = quad[i];
        const [x1, y1] = quad[(i + 1) % 4];
        area += x0 * y1 - x1 * y0;
      }
      check(Math.abs(area) / 2 > 100, `${id} faceQuad has a real area (${(Math.abs(area) / 2).toFixed(1)} px²)`);
      // A projected rectangle is a parallelogram: both diagonals share a midpoint.
      const first = [(quad[0][0] + quad[2][0]) / 2, (quad[0][1] + quad[2][1]) / 2];
      const second = [(quad[1][0] + quad[3][0]) / 2, (quad[1][1] + quad[3][1]) / 2];
      const diagonalError = Math.hypot(first[0] - second[0], first[1] - second[1]);
      check(
        diagonalError <= 1,
        `${id} faceQuad is a projected rectangle (diagonal midpoint error ${diagonalError.toFixed(2)} px)`,
      );
      const width = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
      const height = Math.hypot(quad[2][0] - quad[1][0], quad[2][1] - quad[1][1]);
      const ratio = width / height;
      // A 45-degree camera legitimately foreshortens the face closer to square
      // or wider than tall, so this is the oblique plausibility range.
      check(
        ratio >= 0.3 && ratio <= 3.5,
        `${id} faceQuad is face-shaped (${width.toFixed(1)} x ${height.toFixed(1)} px, ratio ${ratio.toFixed(2)})`,
      );

      // gridStepPx is the physical per-tile step: the inset face edges grown
      // back to the full tile width/height. It must follow from faceQuad.
      const inset = spec.tile.faceInset;
      const scaleX = spec.tile.width / (spec.tile.width - 2 * inset);
      const scaleY = spec.tile.height / (spec.tile.height - 2 * inset);
      const expected = {
        x: [ (quad[1][0] - quad[0][0]) * scaleX, (quad[1][1] - quad[0][1]) * scaleX ],
        y: [ (quad[0][0] - quad[3][0]) * scaleY, (quad[0][1] - quad[3][1]) * scaleY ],
      };
      const orient = (axis) => {
        const vertical = Math.abs(axis[1]) >= Math.abs(axis[0]);
        if (vertical) return axis[1] < 0 ? [-axis[0], -axis[1]] : axis;
        return axis[0] < 0 ? [-axis[0], -axis[1]] : axis;
      };
      expected.x = orient(expected.x);
      expected.y = orient(expected.y);
      const step = shell.gridStepPx ?? {};
      const close = (a, b) => Math.abs((a ?? 1e9) - b) <= 0.25;
      check(
        close(step.x?.[0], expected.x[0]) && close(step.x?.[1], expected.x[1]) &&
          close(step.y?.[0], expected.y[0]) && close(step.y?.[1], expected.y[1]),
        `${id} gridStepPx follows from faceQuad ` +
          `(x ${step.x?.join(',')}, y ${step.y?.join(',')})`,
      );
      const axisX = Math.hypot(step.x?.[0] ?? 0, step.x?.[1] ?? 0);
      const axisY = Math.hypot(step.y?.[0] ?? 0, step.y?.[1] ?? 0);
      check(
        axisX > 8 && axisY > 8,
        `${id} grid steps are usable (|x| ${axisX.toFixed(1)} px, |y| ${axisY.toFixed(1)} px)`,
      );
    }

    // Wall shells publish the projected thickness that separates the two tiers.
    if (WALL.has(id)) {
      const step = shell.stackStepPx;
      check(shell.stackCount === 2, `${id} declares a 2-tile stack (${shell.stackCount})`);
      check(
        Array.isArray(step) && step.length === 2 && Math.abs(step[0]) <= 1.5 && step[1] < 0,
        `${id} stackStepPx points straight up (${JSON.stringify(step)})`,
      );
      const ppu1x = (shell.camera.pixelsPerUnit2x ?? 0) / manifest.pixelRatio;
      const rise = spec.tile.thickness * Math.cos((shell.camera.elevationDeg * Math.PI) / 180) * ppu1x;
      check(
        Math.abs((step?.[1] ?? 0) + rise) <= 1.5,
        `${id} stackStepPx is the projected thickness ` +
          `(${step?.[1]} vs ${(-rise).toFixed(2)} px)`,
      );
    } else {
      check(shell.stackStepPx === undefined, `${id} is not a wall shell and has no stackStepPx`);
    }

    const profile = alphaProfile(image, body);
    const floor = 2 / 255 + 5 / 255;
    const border = nearestBorderAlpha(image);
    check(
      border <= floor * 255,
      `${id} outer texture ring is transparent (max alpha ${border}/255 <= ${Math.round(floor * 255)})`,
    );
    for (const side of ['right', 'bottom', 'left', 'top']) {
      const [min, max] = SHADOW_EXTENT[side];
      check(
        profile.extent[side] >= min && profile.extent[side] <= max,
        `${id} ${side === 'right' || side === 'bottom' ? 'shadow' : 'AO'} reaches ` +
          `${profile.extent[side]} px ${side} (contract ${min}-${max})`,
      );
      const [peakMin, peakMax] = SHADOW_PEAK[side];
      check(
        profile.peak[side] >= peakMin && profile.peak[side] <= peakMax,
        `${id} ${side} ${side === 'right' || side === 'bottom' ? 'shadow' : 'AO'} peaks at alpha ` +
          `${profile.peak[side].toFixed(3)} (${peakMin}-${peakMax})`,
      );
    }
    check(
      profile.extent.right > profile.extent.left && profile.extent.bottom > profile.extent.top,
      `${id} shadow points down-right (extents R${profile.extent.right}/B${profile.extent.bottom} > ` +
        `L${profile.extent.left}/T${profile.extent.top})`,
    );
    note(
      `${id} margin mass L${profile.mass.left.toFixed(2)} T${profile.mass.top.toFixed(2)} ` +
        `R${profile.mass.right.toFixed(2)} B${profile.mass.bottom.toFixed(2)}`,
    );

    const measured = shell.measured ?? {};
    const sameExtent = (side) => measured.alphaExtent1x?.[side] === profile.extent[side];
    check(
      ['left', 'top', 'right', 'bottom'].every(sameExtent),
      `${id} manifest alpha extents match the texture ` +
        `(${JSON.stringify(measured.alphaExtent1x)} vs ${JSON.stringify(profile.extent)})`,
    );
    const samePeak = (side) => Math.abs((measured.alphaPeak1x?.[side] ?? -1) - profile.peak[side]) <= 0.01;
    check(
      ['left', 'top', 'right', 'bottom'].every(samePeak),
      `${id} manifest alpha peaks match the texture`,
    );

    // Light from the top-left. The flat tiles carry the two invariants: the far
    // top bevel is brighter than the near bottom edge, and the near thickness
    // strip is cool (blue >= green >= red). The standing hand is a front
    // elevation whose top edge is the dark blue resin sliver, so it is checked
    // by its own sliver assertion instead; the oblique side walls' top edge is
    // a foreshortened far side, so they only carry the shadow-direction check.
    const edges = measured.edgeSamplesRgb ?? {};
    const oblique = shell.projection === 'fixed-oblique';
    const flat = [
      'shell_flat_upright',
      'shell_flat_sideways',
      'shell_wall_horizontal',
      'shell_wall_horizontal_faceup',
    ].includes(id);
    if (edges.top && edges.bottom && !oblique && flat) {
      check(
        luma(...edges.top) > luma(...edges.bottom),
        `${id} top edge is brighter than the bottom edge ` +
          `(${luma(...edges.top).toFixed(1)} > ${luma(...edges.bottom).toFixed(1)})`,
      );
      check(
        edges.bottom[2] >= edges.bottom[1] &&
          edges.bottom[1] >= edges.bottom[0] &&
          luma(...edges.bottom) < luma(...edges.top),
        `${id} bottom thickness strip is cool and darker than the top ` +
          `(${edges.bottom.join(',')}, luma ${luma(...edges.bottom).toFixed(1)} < ` +
          `${luma(...edges.top).toFixed(1)})`,
      );
    }
    const face = measured.faceSampleRgb ?? [0, 0, 0];
    if (FACE_UP.has(id)) {
      // Ivory vs blue resin is a hue fact. The el-28 standing hand's vertical
      // face is more grazing under the single screen-locked key, so it is
      // dimmer than a pond face; that is the lighting trade-off recorded in §9.
      check(
        face[0] >= face[2] - 20 && luma(...face) >= 80,
        `${id} face is ivory, not blue resin (${face.join(',')}, luma ${luma(...face).toFixed(1)})`,
      );
    }
    if (FACE_DOWN.has(id)) {
      check(
        face[2] - face[0] >= 80 && face[2] - face[1] >= 50,
        `${id} face is blue resin (${face.join(',')})`,
      );
    }
    if (id === 'shell_hand_standing' && edges.top) {
      check(
        edges.top[2] - edges.top[0] >= 60 && edges.top[2] - edges.top[1] >= 40,
        `${id} top edge carries the blue resin sliver (${edges.top.join(',')})`,
      );
    }
    if (id === 'shell_flat_upright' && edges.top) {
      check(luma(...edges.top) >= 120, `${id} top edge is the white plate (luma ${luma(...edges.top).toFixed(1)})`);
    }

    // Both scales must be the same bake: the @2x downsampled 2x2 must match the
    // @1x inside the opaque body, and its opaque bbox must line up.
    const small = downsample2x(image2x);
    let difference = 0;
    let samples = 0;
    for (let y = body.y0 + 2; y <= body.y1 - 2; y += 1) {
      for (let x = body.x0 + 2; x <= body.x1 - 2; x += 1) {
        const [r1, g1, b1, a1] = pixel(image, x, y);
        const [r2, g2, b2, a2] = pixel(small, x, y);
        if (a1 < 250 || a2 < 250) continue;
        difference += Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
        samples += 3;
      }
    }
    const meanDifference = samples ? difference / samples : 255;
    check(
      meanDifference <= 8,
      `${id} @1x and @2x agree (mean channel delta ${meanDifference.toFixed(2)} <= 8)`,
    );
    const solid2x = alphaBBox(image2x);
    check(
      Boolean(solid2x) &&
        Math.abs(solid2x.x0 - solid.x0 * 2) <= 2 &&
        Math.abs(solid2x.y0 - solid.y0 * 2) <= 2,
      `${id} @2x opaque body lines up with @1x`,
    );

    const hashes = shell.sha256 ?? {};
    check(
      hashes.decodedRgba1x === sha256(image.data) && hashes.decodedRgba2x === sha256(image2x.data),
      `${id} decoded-RGBA sha256 matches the committed PNGs`,
    );
    check(
      measured.bytes1x === image.bytes && measured.bytes2x === image2x.bytes,
      `${id} manifest byte counts match the files (${image.bytes} + ${image2x.bytes})`,
    );
  }
  check(
    totalBytes <= spec.budgets.totalShellBytes,
    `shell textures total ${totalBytes} B (budget ${spec.budgets.totalShellBytes} B)`,
  );
  note(`shell textures total ${totalBytes} B across ${ids.length} shells and 2 scales`);
}

// --------------------------------------------------------------------------- //
// Phase 1b: base scale and the audition candidate matrix
// --------------------------------------------------------------------------- //

function checkBaseScale(spec) {
  const bake = spec.bake;
  check(
    bake.baseScale?.previousTargetLongAxisPx1x === 52,
    `Phase 1 base long axis is recorded as 52 px (${bake.baseScale?.previousTargetLongAxisPx1x})`,
  );
  check(
    bake.targetLongAxisPx1x === 104,
    `base long axis is 104 px @1x (${bake.targetLongAxisPx1x})`,
  );
  check(
    bake.targetLongAxisPx1x === 2 * bake.baseScale.previousTargetLongAxisPx1x,
    'the new base is the Phase 1 @2x size, so the board coordinate space doubles',
  );
  check(
    typeof bake.baseScale.note === 'string' && bake.baseScale.note.includes('@2x'),
    'the base-scale decision is documented in shell-spec.json',
  );
  // The committed manifest must be at the spec's base once the catalogue is
  // baked, so a spec edit without a rebake fails loudly.
  const committedPath = resolve(renderDir, spec.outputs.manifest);
  if (existsSync(committedPath)) {
    const committed = readJson(committedPath);
    check(
      committed.rig?.targetLongAxisPx1x === bake.targetLongAxisPx1x,
      `committed bake is at the spec base (${committed.rig?.targetLongAxisPx1x} px @1x)`,
    );
  }
}

function checkCandidateRecord(context) {
  const {
    record,
    baseId,
    label,
    spec,
    manifest,
    reviewDir,
  } = context;
  const target = spec.bake.targetLongAxisPx1x;
  const texturePath = resolve(reviewDir, record.textureFile ?? '');
  const texture2xPath = resolve(reviewDir, record.textureFile2x ?? '');
  check(existsSync(texturePath), `${label} texture exists (${record.textureFile})`);
  check(existsSync(texture2xPath), `${label} @2x texture exists (${record.textureFile2x})`);
  if (!existsSync(texturePath) || !existsSync(texture2xPath)) return 0;

  const image = readPng(texturePath);
  const image2x = readPng(texture2xPath);
  const bytes = image.bytes + image2x.bytes;
  check(
    image.channels === 4 && image2x.channels === 4,
    `${label} textures are RGBA (colour types ${image.colorType}/${image2x.colorType})`,
  );
  check(
    image.width === record.texWidth && image.height === record.texHeight,
    `${label} texture is ${image.width}x${image.height} (declared ${record.texWidth}x${record.texHeight})`,
  );
  check(
    image2x.width === record.texWidth * manifest.pixelRatio &&
      image2x.height === record.texHeight * manifest.pixelRatio,
    `${label} @2x texture is ${image2x.width}x${image2x.height} ` +
      `(declared ${record.texWidth * manifest.pixelRatio}x${record.texHeight * manifest.pixelRatio})`,
  );
  check(bytes <= spec.budgets.shellBytes, `${label} is ${bytes} B (budget ${spec.budgets.shellBytes} B)`);

  const padding = record.padding ?? {};
  check(
    padding.left === spec.bake.padding1x.left &&
      padding.top === spec.bake.padding1x.top &&
      padding.right === spec.bake.padding1x.right &&
      padding.bottom === spec.bake.padding1x.bottom,
    `${label} padding matches the 1-2 / 10-16 px shadow contract (${padding.left}/${padding.top}/${padding.right}/${padding.bottom})`,
  );
  check(record.anchorX === padding.left, `${label} anchorX ${record.anchorX} equals left padding ${padding.left}`);
  check(record.anchorY === padding.top, `${label} anchorY ${record.anchorY} equals top padding ${padding.top}`);
  check(
    record.anchorX + record.advanceWidth + padding.right === record.texWidth,
    `${label} anchorX + advanceWidth + right padding equals texWidth`,
  );
  check(
    record.anchorY + record.advanceHeight + padding.bottom === record.texHeight,
    `${label} anchorY + advanceHeight + bottom padding equals texHeight`,
  );

  // The base: the projected silhouette's long axis is the spec's 104 px @1x
  // target (the Phase 1 @2x size).
  const longAxis = Math.max(record.advanceWidth, record.advanceHeight);
  check(
    longAxis >= target - 4 && longAxis <= target + 4,
    `${label} body long axis is ${longAxis} px @1x (target ${target} +/- 4 for the alpha crop)`,
  );

  const body = {
    x0: record.anchorX,
    y0: record.anchorY,
    x1: record.anchorX + record.advanceWidth - 1,
    y1: record.anchorY + record.advanceHeight - 1,
  };
  const solid = alphaBBox(image);
  const inset = solid
    ? [solid.x0 - body.x0, solid.y0 - body.y0, body.x1 - solid.x1, body.y1 - solid.y1]
    : [];
  check(
    Boolean(solid) && inset.every((value) => value === 1),
    `${label} opaque body is inset 1 px inside the declared body (${inset.join('/')})`,
  );

  const quad = record.faceQuad;
  check(Array.isArray(quad) && quad.length === 4, `${label} faceQuad has four corners`);
  if (Array.isArray(quad) && quad.length === 4) {
    const inside = quad.every(
      ([x, y]) =>
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= body.x0 &&
        x <= body.x1 + 1 &&
        y >= body.y0 &&
        y <= body.y1 + 1,
    );
    check(inside, `${label} faceQuad lies inside the opaque body`);
    const cross = (a, b, c) =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const signs = [0, 1, 2, 3].map((i) =>
      Math.sign(cross(quad[i], quad[(i + 1) % 4], quad[(i + 2) % 4])),
    );
    check(signs.every((sign) => sign !== 0 && sign === signs[0]), `${label} faceQuad is convex`);
    let area = 0;
    for (let i = 0; i < 4; i += 1) {
      const [x0, y0] = quad[i];
      const [x1, y1] = quad[(i + 1) % 4];
      area += x0 * y1 - x1 * y0;
    }
    check(Math.abs(area) / 2 > 400, `${label} faceQuad has a real area (${(Math.abs(area) / 2).toFixed(1)} px²)`);
    const first = [(quad[0][0] + quad[2][0]) / 2, (quad[0][1] + quad[2][1]) / 2];
    const second = [(quad[1][0] + quad[3][0]) / 2, (quad[1][1] + quad[3][1]) / 2];
    const diagonalError = Math.hypot(first[0] - second[0], first[1] - second[1]);
    check(
      diagonalError <= 1,
      `${label} faceQuad is a projected rectangle (diagonal midpoint error ${diagonalError.toFixed(2)} px)`,
    );
    // A low camera foreshortens the face: a candidate can legitimately be
    // wider than tall on screen, so this is a plausibility bound, not the
    // near-top-down 0.5-1.1 shape check the committed bake uses.
    const width = Math.hypot(quad[1][0] - quad[0][0], quad[1][1] - quad[0][1]);
    const height = Math.hypot(quad[2][0] - quad[1][0], quad[2][1] - quad[1][1]);
    const ratio = width / height;
    check(
      ratio >= 0.3 && ratio <= 3.5,
      `${label} faceQuad aspect is ${ratio.toFixed(2)} (0.3-3.5 at oblique elevations)`,
    );
    const measuredQuad = record.measured?.faceQuadPx ?? {};
    check(
      Math.abs((measuredQuad.width ?? -1) - width) <= 0.5 &&
        Math.abs((measuredQuad.height ?? -1) - height) <= 0.5,
      `${label} measured faceQuadPx matches the recorded quad ` +
        `(${measuredQuad.width}x${measuredQuad.height} vs ${width.toFixed(2)}x${height.toFixed(2)})`,
    );

    const insetPx = spec.tile.faceInset;
    const scaleX = spec.tile.width / (spec.tile.width - 2 * insetPx);
    const scaleY = spec.tile.height / (spec.tile.height - 2 * insetPx);
    const expected = {
      x: [(quad[1][0] - quad[0][0]) * scaleX, (quad[1][1] - quad[0][1]) * scaleX],
      y: [(quad[0][0] - quad[3][0]) * scaleY, (quad[0][1] - quad[3][1]) * scaleY],
    };
    const orient = (axis) => {
      const vertical = Math.abs(axis[1]) >= Math.abs(axis[0]);
      if (vertical) return axis[1] < 0 ? [-axis[0], -axis[1]] : axis;
      return axis[0] < 0 ? [-axis[0], -axis[1]] : axis;
    };
    expected.x = orient(expected.x);
    expected.y = orient(expected.y);
    const step = record.gridStepPx ?? {};
    const close = (a, b) => Math.abs((a ?? 1e9) - b) <= 0.25;
    check(
      close(step.x?.[0], expected.x[0]) &&
        close(step.x?.[1], expected.x[1]) &&
        close(step.y?.[0], expected.y[0]) &&
        close(step.y?.[1], expected.y[1]),
      `${label} gridStepPx follows from faceQuad (x ${step.x?.join(',')}, y ${step.y?.join(',')})`,
    );
  }

  if (WALL.has(baseId)) {
    const step = record.stackStepPx;
    check(
      record.stackCount === 2 && Array.isArray(step) && step[1] < 0 && Math.abs(step[0]) <= 1.5,
      `${label} publishes an upward 2-tile stackStepPx (${JSON.stringify(step)})`,
    );
  } else {
    check(record.stackStepPx === undefined, `${label} is not a wall shell and has no stackStepPx`);
  }

  const profile = alphaProfile(image, body);
  const floor = 2 / 255 + 5 / 255;
  const border = nearestBorderAlpha(image);
  check(
    border <= floor * 255,
    `${label} outer texture ring is transparent (max alpha ${border}/255 <= ${Math.round(floor * 255)})`,
  );
  for (const side of ['right', 'bottom', 'left', 'top']) {
    const [min, max] = SHADOW_EXTENT[side];
    check(
      profile.extent[side] >= min && profile.extent[side] <= max,
      `${label} ${side === 'right' || side === 'bottom' ? 'shadow' : 'AO'} reaches ` +
        `${profile.extent[side]} px ${side} (contract ${min}-${max})`,
    );
    const [peakMin, peakMax] = SHADOW_PEAK[side];
    check(
      profile.peak[side] >= peakMin && profile.peak[side] <= peakMax,
      `${label} ${side} ${side === 'right' || side === 'bottom' ? 'shadow' : 'AO'} peaks at alpha ` +
        `${profile.peak[side].toFixed(3)} (${peakMin}-${peakMax})`,
    );
  }
  check(
    profile.extent.right > profile.extent.left && profile.extent.bottom > profile.extent.top,
    `${label} shadow points down-right (R${profile.extent.right}/B${profile.extent.bottom} > ` +
      `L${profile.extent.left}/T${profile.extent.top})`,
  );

  const measured = record.measured ?? {};
  const sameExtent = (side) => measured.alphaExtent1x?.[side] === profile.extent[side];
  check(
    ['left', 'top', 'right', 'bottom'].every(sameExtent),
    `${label} manifest alpha extents match the texture`,
  );
  const samePeak = (side) => Math.abs((measured.alphaPeak1x?.[side] ?? -1) - profile.peak[side]) <= 0.01;
  check(['left', 'top', 'right', 'bottom'].every(samePeak), `${label} manifest alpha peaks match the texture`);

  const edges = measured.edgeSamplesRgb ?? {};
  const flat = baseId.startsWith('shell_flat') || baseId === 'shell_wall_horizontal';
  if (edges.top && edges.bottom && flat) {
    check(
      luma(...edges.top) > luma(...edges.bottom),
      `${label} top edge is brighter than the bottom edge ` +
        `(${luma(...edges.top).toFixed(1)} > ${luma(...edges.bottom).toFixed(1)})`,
    );
    check(
      edges.bottom[2] >= edges.bottom[1] &&
        edges.bottom[1] >= edges.bottom[0] &&
        luma(...edges.bottom) < luma(...edges.top),
      `${label} bottom face is the cool, darker thickness ` +
        `(${edges.bottom.join(',')}, luma ${luma(...edges.bottom).toFixed(1)} vs top ${luma(...edges.top).toFixed(1)})`,
    );
  }
  const face = measured.faceSampleRgb ?? [0, 0, 0];
  if (FACE_UP.has(baseId)) {
    // Ivory vs blue resin is a hue fact, not a brightness one: a higher camera
    // elevation makes the standing hand's vertical face more grazing under the
    // single screen-locked key, which is a lighting trade-off the user weighs.
    check(
      face[0] >= face[2] - 20 && luma(...face) >= 80,
      `${label} face is ivory, not blue resin (${face.join(',')}, luma ${luma(...face).toFixed(1)})`,
    );
  }
  if (FACE_DOWN.has(baseId)) {
    check(
      face[2] - face[0] >= 80 && face[2] - face[1] >= 50,
      `${label} face is blue resin (${face.join(',')})`,
    );
  }
  note(`${label} face luma ${luma(...face).toFixed(1)} (${face.join(',')})`);
  if (baseId === 'shell_hand_standing' && edges.top) {
    note(
      `${label} standing top edge rgb ${edges.top.join(',')} (blue resin sliver; perspective-dependent)`,
    );
  }

  const small = downsample2x(image2x);
  let difference = 0;
  let samples = 0;
  for (let y = body.y0 + 2; y <= body.y1 - 2; y += 1) {
    for (let x = body.x0 + 2; x <= body.x1 - 2; x += 1) {
      const [r1, g1, b1, a1] = pixel(image, x, y);
      const [r2, g2, b2, a2] = pixel(small, x, y);
      if (a1 < 250 || a2 < 250) continue;
      difference += Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);
      samples += 3;
    }
  }
  const meanDifference = samples ? difference / samples : 255;
  check(
    meanDifference <= 8,
    `${label} @1x and @2x agree (mean channel delta ${meanDifference.toFixed(2)} <= 8)`,
  );

  const hashes = record.sha256 ?? {};
  check(
    hashes.decodedRgba1x === sha256(image.data) && hashes.decodedRgba2x === sha256(image2x.data),
    `${label} decoded-RGBA sha256 matches the candidate PNGs`,
  );
  check(
    measured.bytes1x === image.bytes && measured.bytes2x === image2x.bytes,
    `${label} manifest byte counts match the files (${image.bytes} + ${image2x.bytes})`,
  );
  return bytes;
}

function checkAudition(spec) {
  const audition = spec.audition;
  check(Boolean(audition), 'shell-spec.json declares the candidate matrix');
  if (!audition) return;
  check(
    typeof audition.status === 'string' && audition.status.toLowerCase().includes('proposal'),
    'the audition block is marked as proposals, not committed assets',
  );
  const shells = audition.shells ?? {};
  const auditionIds = Object.keys(shells);
  check(auditionIds.length >= 1, `the audition block covers ${auditionIds.length} shell(s)`);
  check(
    auditionIds.every((id) => CANONICAL_SHELL_IDS.includes(id)),
    `the audition block names only catalogue shells (${auditionIds.join(', ')})`,
  );
  for (const id of auditionIds) {
    const candidates = shells[id]?.candidates ?? [];
    check(
      candidates.length >= 3 && candidates.length <= 5,
      `${id} audition has ${candidates.length} candidates (3-5)`,
    );
    check(
      new Set(candidates.map((candidate) => candidate.candidateId)).size === candidates.length,
      `${id} audition candidate ids are unique`,
    );
    check(
      typeof shells[id]?.question === 'string' && shells[id].question.length > 20,
      `${id} audition carries the question the sheet asks the user`,
    );
  }
  const faceVariants = spec.faceVariants;
  check(Boolean(faceVariants), 'shell-spec.json records the Phase 2 face-variant plan');
  if (faceVariants) {
    check(
      faceVariants.atlasKey === '(shellType, faceVariant, tileFace)',
      `the atlas is keyed by (shellType, faceVariant, tileFace) (${faceVariants.atlasKey})`,
    );
    check(
      [...FACE_UP].every((id) => (faceVariants.faceUpShells?.[id] ?? []).length >= 1),
      'every face-up shell has at least one face variant',
    );
    check(
      [...FACE_DOWN].every((id) => (faceVariants.faceDownShells?.[id] ?? []).join(',') === 'bare'),
      'every face-down wall shell is bare (no face glyph)',
    );
  }

  const manifestPath = resolve(renderDir, audition.manifest);
  if (!existsSync(manifestPath)) {
    note(`candidate manifest not present yet (${manifestPath}); run bake-shells.sh --audition`);
    return;
  }
  const manifest = readJson(manifestPath);
  const partial = manifest.partial === true;
  const target = spec.bake.targetLongAxisPx1x;
  check(manifest.version === 1, 'shell-candidates.json version is 1');
  if (partial) {
    note('candidate manifest is a partial development bake (--only): completeness is not asserted');
  }
  check(
    manifest.generatedBy === 'tools/render/bake_shells.py --audition',
    `candidate manifest is generated by the audition mode (${manifest.generatedBy})`,
  );
  check(
    manifest.base?.targetLongAxisPx1x === target &&
      manifest.base?.targetLongAxisPx2x === target * spec.bake.pixelRatio &&
      manifest.base?.previousTargetLongAxisPx1x === spec.bake.baseScale.previousTargetLongAxisPx1x,
    `candidate base is ${manifest.base?.targetLongAxisPx1x}/${manifest.base?.targetLongAxisPx2x} px ` +
      `@1x/@2x (was ${manifest.base?.previousTargetLongAxisPx1x})`,
  );
  check(
    manifest.pixelRatio === spec.bake.pixelRatio,
    `candidate pixelRatio is ${manifest.pixelRatio}`,
  );
  check(
    JSON.stringify(manifest.padding1x) === JSON.stringify(spec.bake.padding1x),
    `candidate padding is the spec padding1x (${JSON.stringify(manifest.padding1x)})`,
  );
  checkRig(manifest, spec);
  check(manifest.rig?.targetLongAxisPx1x === target, 'candidate rig records the new base long axis');

  const reviewDir = dirname(manifestPath);
  const manifestShells = manifest.shells ?? {};
  const manifestIds = Object.keys(manifestShells);
  check(
    partial || manifestIds.length === Object.keys(shells).length,
    `shell-candidates.json covers the ${Object.keys(shells).length} audition shells (${manifestIds.length})`,
  );
  check(
    manifestIds.every((id) => shells[id]), 'the candidate manifest names only auditioned shells',
  );
  let totalBytes = 0;
  let count = 0;
  for (const baseId of manifestIds) {
    const entry = manifestShells[baseId] ?? {};
    const candidates = entry.candidates ?? [];
    check(
      candidates.length === (shells[baseId]?.candidates ?? []).length,
      `${baseId} candidate count matches the spec (${candidates.length})`,
    );
    check(
      typeof entry.question === 'string' && entry.question === shells[baseId]?.question,
      `${baseId} candidate sheet reuses the spec's question`,
    );
    check(
      entry.reference?.source === 'frontend/public/table/shells.json' &&
        entry.reference?.shellId === baseId,
      `${baseId} candidate entry points at the committed shell as its reference`,
    );
    for (const record of candidates) {
      const label = `${baseId}/${record.candidate?.candidateId ?? '?'}`;
      check(
        record.candidate?.sourceShellId === baseId && typeof record.candidate?.label === 'string',
        `${label} carries its candidate id and label`,
      );
      totalBytes += checkCandidateRecord({
        record,
        baseId,
        label,
        spec,
        manifest,
        reviewDir,
      });
      count += 1;
    }
  }
  check(partial || count >= 6, `${count} candidate textures validated (>= 6)`);
  check(
    totalBytes <= spec.budgets.totalShellBytes * 2,
    `candidate textures total ${totalBytes} B (review-only budget ${spec.budgets.totalShellBytes * 2} B)`,
  );
  note(`candidate textures total ${totalBytes} B across ${count} candidates and 2 scales`);

  checkCandidateSheets(audition, manifest, shells, manifestIds);
}

function checkCandidateSheets(audition, manifest, shells, manifestIds) {
  const sheetDir = resolve(renderDir, audition.sheetDir);
  const feltSpec = readJson(feltSpecPath);
  const [baseR, baseG, baseB] = feltSpec.baseColor;
  // The sheets are drawn with a dependency-free bitmap font whose colours are
  // exact (no anti-aliasing), so counting those pixels is a deterministic check
  // that the labels were really rendered rather than a look at the image.
  const TITLE = [244, 238, 220];
  const LABEL = [204, 214, 200];
  const STRIP = [10, 22, 17];
  for (const baseId of manifestIds) {
    const path = join(sheetDir, `shell-candidates-${baseId}.png`);
    check(existsSync(path), `${baseId} candidate sheet exists (${path})`);
    if (!existsSync(path)) continue;
    const image = readPng(path);
    check(image.channels === 4, `${baseId} candidate sheet decodes as RGBA`);
    check(
      image.width >= 700 && image.height >= 500,
      `${baseId} candidate sheet is ${image.width}x${image.height} (readable sheet)`,
    );
    const corner = pixel(image, 2, 2);
    check(
      corner[0] === baseR && corner[1] === baseG && corner[2] === baseB && corner[3] === 255,
      `${baseId} candidate sheet background is the felt base colour (${corner.slice(0, 3).join(',')})`,
    );
    let title = 0;
    let label = 0;
    let strip = 0;
    let tile = 0;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const [r, g, b, a] = pixel(image, x, y);
        if (r === TITLE[0] && g === TITLE[1] && b === TITLE[2]) title += 1;
        else if (r === LABEL[0] && g === LABEL[1] && b === LABEL[2]) label += 1;
        else if (r === STRIP[0] && g === STRIP[1] && b === STRIP[2]) strip += 1;
        else if (a === 255 && !(r === baseR && g === baseG && b === baseB)) tile += 1;
      }
    }
    check(title >= 300, `${baseId} candidate sheet renders its title text (${title} px)`);
    check(label >= 3000, `${baseId} candidate sheet renders candidate labels (${label} px)`);
    check(strip >= 5000, `${baseId} candidate sheet paints its label strips (${strip} px)`);
    check(
      tile >= 20000,
      `${baseId} candidate sheet composites its tiles over the felt (${tile} px)`,
    );
    const expectedRows = (manifest.shells[baseId]?.candidates ?? []).length + 1;
    check(
      expectedRows === (shells[baseId]?.candidates ?? []).length + 1,
      `${baseId} candidate sheet lays out ${expectedRows} rows (candidates + reference)`,
    );
  }
}

// --------------------------------------------------------------------------- //

try {
  const shellSpec = readJson(shellSpecPath);
  const feltSpec = readJson(feltSpecPath);
  const auditionMode = process.argv.includes('--audition');
  checkShellSpec(shellSpec);
  checkBaseScale(shellSpec);
  checkFeltSpec(feltSpec);
  checkFelt(feltSpec);
  checkShellsManifest(shellSpec);
  if (auditionMode) checkAudition(shellSpec);
} catch (error) {
  failures.push(error instanceof Error ? error.message : String(error));
}

console.log('');
if (failures.length) {
  console.error(`FAILED ${failures.length} of ${checks} checks`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`OK ${checks} checks passed`);
