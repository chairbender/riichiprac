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
 *   - when Phase 1 has produced `frontend/public/table/shells.json`, every
 *     shell's texture exists at the declared size, the body anchor + advance +
 *     padding equals the texture, every `faceQuad` lies inside the body, and
 *     the shell bytes are inside the per-shell and total budgets.
 *
 * Visual quality is the user's call (AGENTS.md §6). This script only prints
 * numbers and pass/fail.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

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

// --------------------------------------------------------------------------- //
// Minimal PNG reader (8-bit, non-interlaced, RGB or RGBA)
// --------------------------------------------------------------------------- //

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function readPng(path) {
  const bytes = readFileSync(path);
  const signature = '89504e470d0a1a0a';
  if (bytes.subarray(0, 8).toString('hex') !== signature) {
    throw new Error(`${path} is not a PNG`);
  }
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const kind = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (kind === 'IHDR') {
      header = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8],
        colorType: body[9],
        compression: body[10],
        filter: body[11],
        interlace: body[12],
      };
    } else if (kind === 'IDAT') {
      idat.push(body);
    } else if (kind === 'IEND') {
      break;
    }
  }
  if (!header) throw new Error(`${path} has no IHDR`);
  if (header.bitDepth !== 8 || header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new Error(
      `${path} is not an 8-bit non-interlaced PNG ` +
        `(bitDepth ${header.bitDepth}, interlace ${header.interlace})`,
    );
  }
  const channels = header.colorType === 2 ? 3 : header.colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`${path} has unsupported colour type ${header.colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = header.width * channels;
  const data = Buffer.alloc(stride * header.height);
  let previous = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const row = data.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[pos + x];
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let predictor;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = left;
          break;
        case 2:
          predictor = up;
          break;
        case 3:
          predictor = (left + up) >> 1;
          break;
        case 4:
          predictor = paeth(left, up, upLeft);
          break;
        default:
          throw new Error(`${path} uses unsupported PNG filter ${filter}`);
      }
      row[x] = (value + predictor) & 0xff;
    }
    pos += stride;
    previous = row;
  }
  return { ...header, channels, data, stride, bytes: bytes.length };
}

function luma(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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
// Spec checks
// --------------------------------------------------------------------------- //

function checkShellSpec(spec) {
  check(spec.version === 1, `shell-spec.json version is 1`);
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
  check(spec.outputs.manifest.endsWith('shells.json'), `manifest output is shells.json`);
}

function checkFeltSpec(spec) {
  check(spec.version === 1, `felt-spec.json version is 1`);
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
// shells.json checks (absent until Phase 1)
// --------------------------------------------------------------------------- //

function checkShellsManifest(spec) {
  const manifestPath = resolve(renderDir, spec.outputs.manifest);
  const manifestBudget = spec.budgets.manifestBytes;
  if (!existsSync(manifestPath)) {
    note(`shells.json not present yet (${manifestPath}); Phase 1 owns the six-shell bake`);
    return;
  }
  const manifestBytes = statSync(manifestPath).size;
  check(
    manifestBytes <= manifestBudget,
    `shells.json is ${manifestBytes} B (budget ${manifestBudget} B)`,
  );
  const manifest = readJson(manifestPath);
  check(manifest.version === 1, `shells.json version is 1`);
  check(manifest.shells && typeof manifest.shells === 'object', 'shells.json has a shells map');
  const ids = Object.keys(manifest.shells ?? {});
  check(
    ids.length === CANONICAL_SHELL_IDS.length,
    `shells.json has ${ids.length} shells (${CANONICAL_SHELL_IDS.length})`,
  );
  let totalBytes = 0;
  const specRotation = new Map(spec.shells.map((shell) => [shell.id, shell.faceRotationDeg]));
  for (const id of CANONICAL_SHELL_IDS) {
    const shell = manifest.shells?.[id];
    check(Boolean(shell), `shells.json contains ${id}`);
    if (!shell) continue;
    check(
      typeof shell.textureFile === 'string' && shell.textureFile.startsWith('shells/') && shell.textureFile.endsWith('.png'),
      `${id} textureFile is a PNG under shells/ (${shell.textureFile})`,
    );
    check(
      shell.faceRotationDeg === specRotation.get(id),
      `${id} faceRotationDeg is ${shell.faceRotationDeg} (spec ${specRotation.get(id)})`,
    );
    const texturePath = resolve(dirname(manifestPath), shell.textureFile ?? '');
    check(existsSync(texturePath), `${id} texture exists (${shell.textureFile})`);
    if (!existsSync(texturePath)) continue;
    const image = readPng(texturePath);
    const bytes = image.bytes;
    totalBytes += bytes;
    check(
      image.channels === 4,
      `${id} texture is RGBA (colour type ${image.colorType})`,
    );
    check(
      image.width === shell.texWidth && image.height === shell.texHeight,
      `${id} texture is ${image.width}x${image.height} (declared ${shell.texWidth}x${shell.texHeight})`,
    );
    check(bytes <= spec.budgets.shellBytes, `${id} is ${bytes} B (budget ${spec.budgets.shellBytes} B)`);
    const padding = shell.padding ?? {};
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
    const quad = shell.faceQuad;
    check(Array.isArray(quad) && quad.length === 4, `${id} faceQuad has four corners`);
    if (!Array.isArray(quad) || quad.length !== 4) continue;
    const inside = quad.every(
      ([x, y]) =>
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        x >= shell.anchorX &&
        x <= shell.anchorX + shell.advanceWidth &&
        y >= shell.anchorY &&
        y <= shell.anchorY + shell.advanceHeight,
    );
    check(inside, `${id} faceQuad lies inside the opaque body`);
    let area = 0;
    for (let i = 0; i < 4; i += 1) {
      const [x0, y0] = quad[i];
      const [x1, y1] = quad[(i + 1) % 4];
      area += x0 * y1 - x1 * y0;
    }
    check(Math.abs(area) / 2 > 0, `${id} faceQuad has non-zero area (${Math.abs(area) / 2})`);
  }
  check(
    totalBytes <= spec.budgets.totalShellBytes,
    `shell textures total ${totalBytes} B (budget ${spec.budgets.totalShellBytes} B)`,
  );
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
