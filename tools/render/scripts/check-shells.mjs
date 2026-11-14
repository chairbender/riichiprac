#!/usr/bin/env node
/**
 * Integrity check for the 2.5D rendered-view assets.
 *
 *   node tools/render/scripts/check-shells.mjs
 *
 * Dependency-free on purpose: it runs in CI and on any machine with Node, and
 * it never needs Blender. It validates facts, not looks:
 *
 *   - the shell spec still catalogs exactly the six canonical shells, with the
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
  'shell_wall_side_left',
  'shell_wall_side_right',
];

const FACE_UP = new Set(['shell_hand_standing', 'shell_flat_upright', 'shell_flat_sideways']);
const FACE_DOWN = new Set(['shell_wall_horizontal', 'shell_wall_side_left', 'shell_wall_side_right']);

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
  check(spec.version === 1, 'shell-spec.json version is 1');
  const ids = spec.shells.map((shell) => shell.id);
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
    pads.right >= 3 && pads.right <= 4 && pads.bottom >= 3 && pads.bottom <= 4,
    `padding1x right/bottom are 3-4 px (${pads.right}/${pads.bottom})`,
  );
  check(
    pads.left >= 1 && pads.left <= 2 && pads.top >= 1 && pads.top <= 2,
    `padding1x left/top are 1-2 px (${pads.left}/${pads.top})`,
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
      check(
        ratio >= 0.5 && ratio <= 1.1,
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

    const profile = alphaProfile(image, body);
    const floor = 2 / 255 + 5 / 255;
    const border = nearestBorderAlpha(image);
    check(
      border <= floor * 255,
      `${id} outer texture ring is transparent (max alpha ${border}/255 <= ${Math.round(floor * 255)})`,
    );
    check(
      profile.extent.right >= 3 && profile.extent.right <= 4,
      `${id} shadow reaches ${profile.extent.right} px right (contract 3-4)`,
    );
    check(
      profile.extent.bottom >= 3 && profile.extent.bottom <= 4,
      `${id} shadow reaches ${profile.extent.bottom} px down (contract 3-4)`,
    );
    check(
      profile.extent.left >= 1 && profile.extent.left <= 2,
      `${id} AO reaches ${profile.extent.left} px left (contract 1-2)`,
    );
    check(
      profile.extent.top >= 1 && profile.extent.top <= 2,
      `${id} AO reaches ${profile.extent.top} px up (contract 1-2)`,
    );
    check(
      profile.peak.right >= 0.24 && profile.peak.right <= 0.36,
      `${id} right shadow peaks at alpha ${profile.peak.right.toFixed(3)} (0.24-0.36)`,
    );
    check(
      profile.peak.bottom >= 0.24 && profile.peak.bottom <= 0.36,
      `${id} bottom shadow peaks at alpha ${profile.peak.bottom.toFixed(3)} (0.24-0.36)`,
    );
    check(
      profile.peak.left >= 0.2 && profile.peak.left <= 0.32,
      `${id} left AO peaks at alpha ${profile.peak.left.toFixed(3)} (0.20-0.32)`,
    );
    check(
      profile.peak.top >= 0.2 && profile.peak.top <= 0.32,
      `${id} top AO peaks at alpha ${profile.peak.top.toFixed(3)} (0.20-0.32)`,
    );
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

    // Light from the top-left: the top edge is brighter than the bottom edge,
    // and the bottom thickness strip is cool (blue >= green >= red). The
    // oblique side-wall silhouette's top edge is a foreshortened far side, so
    // only the axis-aligned projections carry the top-brighter invariant.
    const edges = measured.edgeSamplesRgb ?? {};
    const oblique = shell.projection === 'fixed-oblique';
    if (edges.top && edges.bottom && !oblique) {
      check(
        luma(...edges.top) > luma(...edges.bottom),
        `${id} top edge is brighter than the bottom edge ` +
          `(${luma(...edges.top).toFixed(1)} > ${luma(...edges.bottom).toFixed(1)})`,
      );
    }
    if (edges.top && edges.bottom) {
      check(
        edges.bottom[2] >= edges.bottom[1] && edges.bottom[1] >= edges.bottom[0] && luma(...edges.bottom) <= 90,
        `${id} bottom thickness strip is cool and dark ` +
          `(${edges.bottom.join(',')}, luma ${luma(...edges.bottom).toFixed(1)})`,
      );
    }
    const face = measured.faceSampleRgb ?? [0, 0, 0];
    if (FACE_UP.has(id)) {
      check(luma(...face) >= 150, `${id} face is ivory (luma ${luma(...face).toFixed(1)} >= 150)`);
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
  note(`shell textures total ${totalBytes} B across 6 shells and 2 scales`);
}

// --------------------------------------------------------------------------- //

try {
  const shellSpec = readJson(shellSpecPath);
  const feltSpec = readJson(feltSpecPath);
  checkShellSpec(shellSpec);
  checkFeltSpec(feltSpec);
  checkFelt(feltSpec);
  checkShellsManifest(shellSpec);
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
