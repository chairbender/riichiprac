#!/usr/bin/env node
/**
 * Verify the baked rendered-table batch: manifest, sprites, and budget.
 *
 * This is the CI-friendly check from rendered-table-plan.md §12.13. It needs no
 * Blender, no network, and no dependencies: it reads the committed manifest,
 * confirms every referenced file exists, confirms each file's real pixel size
 * matches the rect the manifest publishes, checks that every slot rect sits
 * inside the scene and every face/decal quad inside its body sprite, re-applies
 * each `faceMatrix` to the decal rect, and enforces the asset budget.
 *
 *   node tools/render/scripts/check-assets.mjs [frontend/public/table]
 *
 * A regeneration already runs the same checks inside Blender (which fails the
 * bake), so this exists to catch a hand-edited or stale manifest in CI.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dir = resolve(process.argv[2] ?? 'frontend/public/table');
const problems = [];
const notes = [];

const fail = (message) => problems.push(message);

const readManifest = () => {
  const path = join(dir, 'manifest.json');
  if (!existsSync(path)) {
    fail(`missing manifest: ${path}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`manifest is not valid JSON: ${error.message}`);
    return null;
  }
};

/** Read an image's intrinsic pixel size from a PNG or WebP header. */
const imageSize = (file) => {
  const buffer = readFileSync(file);
  const ascii = (start, end) => buffer.toString('ascii', start, end);

  if (buffer.length > 24 && ascii(1, 4) === 'PNG') {
    return { format: 'png', width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16);
    if (chunk === 'VP8X') {
      // 4 bytes of flags/reserved, then 24-bit (value - 1) width and height.
      return {
        format: 'webp',
        width: buffer.readUIntLE(24, 3) + 1,
        height: buffer.readUIntLE(27, 3) + 1,
      };
    }
    if (chunk === 'VP8 ') {
      // Frame tag (3 bytes), sync code (0x9d 0x01 0x2a), then 14-bit sizes.
      return {
        format: 'webp',
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return {
        format: 'webp',
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    fail(`${file}: unsupported WebP chunk ${JSON.stringify(chunk)}`);
    return null;
  }
  fail(`${file}: not a PNG or WebP file`);
  return null;
};

const checkImage = (label, file, expectedWidth, expectedHeight) => {
  if (!existsSync(file)) {
    fail(`${label}: missing file ${file}`);
    return null;
  }
  const size = imageSize(file);
  if (!size) return null;
  if (size.width !== expectedWidth || size.height !== expectedHeight) {
    fail(
      `${label}: ${file} is ${size.width}x${size.height}, manifest says ` +
        `${expectedWidth}x${expectedHeight}`,
    );
  }
  return statSync(file).size;
};

/** Parse a CSS matrix3d() into column-major numbers. */
const parseMatrix3d = (value) => {
  const match = /^matrix3d\(([^)]+)\)$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const numbers = match[1].split(',').map((part) => Number(part.trim()));
  if (numbers.length !== 16 || numbers.some((number) => !Number.isFinite(number))) {
    return null;
  }
  return numbers;
};

const applyMatrix3d = (m, x, y) => {
  // Column-major: m[0..3] is the first column. z = 0, w = 1.
  const denominator = m[3] * x + m[7] * y + m[15];
  return [
    (m[0] * x + m[4] * y + m[12]) / denominator,
    (m[1] * x + m[5] * y + m[13]) / denominator,
  ];
};

const inside = (rect, x, y, tolerance = 0.5) =>
  x >= rect.x - tolerance &&
  y >= rect.y - tolerance &&
  x <= rect.x + rect.width + tolerance &&
  y <= rect.y + rect.height + tolerance;

const manifest = readManifest();
if (manifest) {
  const scene = manifest.scene ?? {};
  const width = scene.widthDevicePx;
  const height = scene.heightDevicePx;
  if (!(width > 0 && height > 0)) fail('scene has no valid device-pixel size');

  if (manifest.version !== 2) {
    fail(`manifest version ${manifest.version} is not 2`);
  }

  const decalPixels = manifest.decals?.pixels;
  if (!Array.isArray(decalPixels) || decalPixels.length !== 2) {
    fail('manifest.decals.pixels is missing');
  }

  // Background ----------------------------------------------------------- //
  // The spike/review batch has no background (it is a single-tile study), so a
  // null background is allowed and simply skips the background checks.
  let backgroundBytes = 0;
  if (!manifest.background) {
    notes.push('no background: review batch, background checks skipped');
  } else {
    const expected = manifest.backgroundPixels ?? [];
    const bytes = checkImage(
      'background',
      join(dir, manifest.background),
      expected[0],
      expected[1],
    );
    backgroundBytes = bytes ?? 0;
    if (expected[0] !== scene.width || expected[1] !== scene.height) {
      fail(
        `background is ${expected[0]}x${expected[1]}, scene is ` +
          `${scene.width}x${scene.height} CSS px`,
      );
    }
  }

  // Slots ---------------------------------------------------------------- //
  const slots = Array.isArray(manifest.slots) ? manifest.slots : [];
  if (slots.length === 0) fail('manifest has no slots');

  const orientations = new Set(['upright', 'flat-upright', 'left', 'right', 'opposite']);
  const ids = new Set();
  const orders = new Set();
  let bodyBytes = 0;
  let faceChecks = 0;

  for (const slot of slots) {
    const label = `slot ${slot.id}`;
    if (ids.has(slot.id)) fail(`${label}: duplicate id`);
    ids.add(slot.id);
    if (orders.has(slot.drawOrder)) fail(`${label}: duplicate drawOrder ${slot.drawOrder}`);
    orders.add(slot.drawOrder);
    if (!orientations.has(slot.orientation)) {
      fail(`${label}: unknown orientation ${JSON.stringify(slot.orientation)}`);
    }

    const rect = { x: slot.x, y: slot.y, width: slot.width, height: slot.height };
    if (
      !Number.isFinite(slot.x) ||
      !Number.isFinite(slot.y) ||
      !(slot.width > 0) ||
      !(slot.height > 0)
    ) {
      fail(`${label}: invalid rect ${JSON.stringify(rect)}`);
      continue;
    }
    if (slot.x < 0 || slot.y < 0 || slot.x + slot.width > width || slot.y + slot.height > height) {
      fail(
        `${label}: rect (${slot.x}, ${slot.y}, ${slot.width}x${slot.height}) ` +
          `is outside the ${width}x${height} scene`,
      );
    }

    bodyBytes +=
      checkImage(`${label} body`, join(dir, slot.body ?? ''), slot.width, slot.height) ?? 0;

    if (slot.back) {
      const back = slot.back;
      bodyBytes +=
        checkImage(`${label} back`, join(dir, back.body ?? ''), back.width, back.height) ?? 0;
      if (
        back.x < 0 ||
        back.y < 0 ||
        back.x + back.width > width ||
        back.y + back.height > height
      ) {
        fail(`${label}: back rect is outside the scene`);
      }
    }

    // Face and decal quads must sit inside the body sprite they composite onto.
    const quads = [
      ['faceQuad', slot.faceQuad],
      ['decalQuad', slot.decalQuad],
    ];
    for (const [name, quad] of quads) {
      if (!Array.isArray(quad) || quad.length !== 4) {
        fail(`${label}: ${name} must have four corners`);
        continue;
      }
      for (const corner of quad) {
        if (!Array.isArray(corner) || corner.length !== 2) {
          fail(`${label}: ${name} has a malformed corner`);
          continue;
        }
        if (!inside(rect, corner[0], corner[1])) {
          fail(
            `${label}: ${name} corner (${corner[0]}, ${corner[1]}) is outside ` +
              `its body rect (${slot.x}, ${slot.y}, ${slot.width}x${slot.height})`,
          );
        }
      }
      faceChecks += 1;
    }

    // The matrix the runtime applies must reproduce the published quad from the
    // decal's own pixel rect.
    const matrix = parseMatrix3d(slot.faceMatrix);
    if (!matrix) {
      fail(`${label}: faceMatrix is not a 16-number matrix3d()`);
      continue;
    }
    if (Array.isArray(slot.decalQuad) && slot.decalQuad.length === 4 && decalPixels) {
      const [decalWidth, decalHeight] = decalPixels;
      const corners = [
        [0, 0],
        [decalWidth, 0],
        [decalWidth, decalHeight],
        [0, decalHeight],
      ];
      corners.forEach(([x, y], index) => {
        const [mappedX, mappedY] = applyMatrix3d(matrix, x, y);
        const expected = slot.decalQuad[index];
        const drift = Math.max(Math.abs(mappedX - expected[0]), Math.abs(mappedY - expected[1]));
        if (drift > 0.5) {
          fail(
            `${label}: faceMatrix maps decal corner ${index} to ` +
              `(${mappedX.toFixed(2)}, ${mappedY.toFixed(2)}), ` +
              `decalQuad says (${expected[0]}, ${expected[1]})`,
          );
        }
      });
    }
  }

  // Budget --------------------------------------------------------------- //
  const budget = manifest.assets?.budgetBytes ?? {};
  const compiledDir = join(dir, 'bodies');
  const compiled = existsSync(compiledDir)
    ? readdirSync(compiledDir).reduce(
        (total, name) => total + statSync(join(compiledDir, name)).size,
        0,
      )
    : bodyBytes;
  const manifestBytes = statSync(join(dir, 'manifest.json')).size;
  // `totalBytes` in the manifest covers sprites + background, so it can be
  // compared with the bake's own arithmetic; the manifest's own budget is
  // enforced separately below.
  const totalBytes = compiled + backgroundBytes;

  if (typeof budget.total === 'number' && totalBytes + manifestBytes > budget.total) {
    fail(`batch is ${totalBytes + manifestBytes} bytes, over the ${budget.total} byte budget`);
  }
  if (typeof budget.manifest === 'number' && manifestBytes > budget.manifest) {
    fail(`manifest is ${manifestBytes} bytes, over the ${budget.manifest} byte budget`);
  }
  if (typeof budget.bodies === 'number' && compiled > budget.bodies) {
    fail(`body sprites are ${compiled} bytes, over the ${budget.bodies} byte budget`);
  }
  if (typeof budget.background === 'number' && backgroundBytes > budget.background) {
    fail(`background is ${backgroundBytes} bytes, over the ${budget.background} byte budget`);
  }

  notes.push(`${slots.length} slots, ${faceChecks} quads, ${compiled} bytes of body sprites`);
  notes.push(
    `bytes: bodies ${compiled}, background ${backgroundBytes}, manifest ${manifestBytes}, ` +
      `sprites+background ${totalBytes} (budget ${budget.total ?? 'n/a'} for the lot)`,
  );
}

for (const note of notes) console.log(`[check] ${note}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(`[check] ${problem}`);
  console.error(`[check] FAILED with ${problems.length} problem(s)`);
  process.exit(1);
}
console.log('[check] manifest, sprites, and budget all valid');
