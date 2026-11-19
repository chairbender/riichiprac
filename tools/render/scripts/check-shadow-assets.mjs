#!/usr/bin/env node
/**
 * Acceptance gate for the Task 4A decoupled shadow assets. No Blender.
 *
 *   node tools/render/scripts/check-shadow-assets.mjs
 *
 * Validates facts, not looks (AGENTS.md §6). Every assertion is a decoded
 * pixel fact, a geometry identity, or a manifest cross-reference:
 *
 *   - the shadow manifest and the crevice manifest are the default rig
 *     variant's, at the blanks' frame, camera and layout hash;
 *   - every sprite bucket has exactly one mat shadow and the join is one-to-one
 *     with the blanks' buckets (no orphan sprite, no missing bucket);
 *   - each mat shadow PNG is RGBA at its recorded size, all-black ink with the
 *     occlusion in alpha, transparent in its padding border, and its decoded
 *     hash matches the manifest;
 *   - its crop + pivot lands on the same anchor its blank is drawn at, or - for
 *     a wall bucket whose representative is a top-tier tile - on that stack's
 *     bottom-tier anchor, and the wall's blank anchor is the top-tier one (so
 *     the two are provably different aggregates of one stack);
 *   - it has a real darkening core, a support area, contact pixels inside the
 *     body footprint, and a cast penumbra outside it on at least two sides;
 *   - every wall seat has a stack decal whose alpha is masked to the bottom
 *     body's silhouette (a decal that leaked onto the felt fails), drawn at
 *     that stack's bottom-tier anchor with a contact core inside the body;
 *   - the four crevice masks are black ink in normalized UV, peak at about 35 %
 *     on the outer bevel edge, fall monotonically to zero, stay constant along
 *     their edge, and reach zero between 8 % and 12 % of the tile width - and
 *     their resolution is at least twice the largest face quad in pixels, so no
 *     mask is ever upscaled onto a tile;
 *   - the manifest records the same numbers the pixels give, so a hand-edited
 *     PNG fails instead of silently shipping.
 */
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tableDir = resolve(renderDir, '..', '..', 'frontend', 'public', 'table');

const spec = JSON.parse(readFileSync(resolve(renderDir, 'board-assets-spec.json'), 'utf8'));
const layout = JSON.parse(readFileSync(resolve(tableDir, 'table_layout.json'), 'utf8'));
const blanks = JSON.parse(readFileSync(resolve(tableDir, 'blanks.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(tableDir, shadowsFile()), 'utf8'));
const seams = JSON.parse(readFileSync(resolve(tableDir, seamFile()), 'utf8'));

function shadowsFile() {
  const specValue = spec.shadows.manifest;
  return specValue.split('/').pop();
}
function seamFile() {
  const specValue = spec.shadows.crevices.manifest;
  return specValue.split('/').pop();
}

let checks = 0;
let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  FAIL ${message}`);
};
const check = (condition, message) => {
  checks += 1;
  if (!condition) fail(message);
  return condition;
};
const checkEqual = (label, left, right) => {
  checks += 1;
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`${label}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
  }
};
const close = (left, right, tolerance = 1e-6) => Math.abs(left - right) <= tolerance;
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
/** Anchor equality is judged in pixels, where the manifest rounds to 1e-6. */
const checkAnchor = (label, actual, expected) => {
  checks += 1;
  if (!close(actual.x, expected.x, 0.01 / 1) || !close(actual.y, expected.y, 0.01 / 1)) {
    fail(`${label}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
};
const checkAlpha = (label, actual, expected) => {
  checks += 1;
  if (!close(actual, expected, 1 / 255)) fail(`${label}: ${actual} != ${expected}`);
};
const readPngSafe = (path) => {
  try {
    return readPng(path);
  } catch {
    return null;
  }
};

function alphaOf(image) {
  const out = Buffer.alloc(image.width * image.height);
  for (let i = 0; i < out.length; i += 1) out[i] = image.data[i * 4 + 3];
  return out;
}

function measure(image) {
  const alpha = alphaOf(image);
  let peak = 0;
  let support = 0;
  let inkRgb = 0;
  for (let i = 0; i < alpha.length; i += 1) {
    if (alpha[i] > peak) peak = alpha[i];
    if (alpha[i] > 0) support += 1;
    if (
      image.data[i * 4] !== 0 ||
      image.data[i * 4 + 1] !== 0 ||
      image.data[i * 4 + 2] !== 0
    ) {
      inkRgb += 1;
    }
  }
  return { alpha, peak, support, inkRgb };
}

function borderMax(alpha, width, height) {
  let max = 0;
  for (let x = 0; x < width; x += 1) {
    max = Math.max(max, alpha[x], alpha[(height - 1) * width + x]);
  }
  for (let y = 0; y < height; y += 1) {
    max = Math.max(max, alpha[y * width], alpha[y * width + width - 1]);
  }
  return max;
}

// ------------------------------------------------------------------ contract
const pixelRatio = Number(spec.blanks.pixelRatio);
checkEqual('shadow manifest version', manifest.version, 1);
checkEqual('shadow generatedBy', manifest.generatedBy, 'tools/render/bake_shadow_assets.py');
checkEqual('shadow task', manifest.task, '4A');
checkEqual('shadow variant', manifest.variant, layout.variant);
checkEqual('shadow variant matches blanks', manifest.variant, blanks.variant);
checkEqual('shadow layout file', manifest.layout.file, 'table_layout.json');
checkEqual(
  'shadow layout sha256',
  manifest.layout.sha256,
  sha256(readFileSync(resolve(tableDir, 'table_layout.json'))),
);
checkEqual('shadow layout sha256 matches blanks', manifest.layout.sha256, blanks.layout.sha256);
checkEqual('shadow referenceResolution', manifest.referenceResolution, layout.referenceResolution);
checkEqual('shadow pixelRatio', manifest.pixelRatio, pixelRatio);
checkEqual('shadow frame', manifest.frame, blanks.frame);
checkEqual('shadow camera', manifest.camera, blanks.camera);
checkEqual('shadow composite model', manifest.composite.model, 'multiply');

const catalogue = layout.bucketCatalogue;
const buckets = Object.keys(catalogue).sort();
const slots = new Map(layout.slots.map((slot) => [slot.id, slot]));
const frameWidth = manifest.frame.width;
const frameHeight = manifest.frame.height;
const padding = Number(spec.shadows.paddingPx);
const checksSpec = spec.shadows.checks;

checkEqual('mat shadow buckets', Object.keys(manifest.matShadows).sort(), buckets);
checkEqual('blank buckets', Object.keys(blanks.blanks).sort(), buckets);

const anchorOf = (record) => ({
  x: (record.crop.left + record.pivot.x) / frameWidth,
  y: (record.crop.top + record.pivot.y) / frameHeight,
});
const alphaBBoxOf = (record) => ({
  left: record.crop.left + padding,
  top: record.crop.top + padding,
  right: record.crop.left + record.width - 1 - padding,
  bottom: record.crop.top + record.height - 1 - padding,
});

// ------------------------------------------------------------- mat shadows
for (const bucket of buckets) {
  const record = manifest.matShadows[bucket];
  const entry = catalogue[bucket];
  const blank = blanks.blanks[bucket];
  const label = `mat:${bucket}`;
  if (!check(Boolean(record), `${label} is missing from the manifest`)) continue;

  checkEqual(`${label} family`, record.family, entry.family);
  checkEqual(`${label} representative`, record.representative, entry.representative);
  checkEqual(`${label} slotCount`, record.slotCount, entry.count);
  checkEqual(`${label} pixelRatio`, record.pixelRatio, pixelRatio);
  checkEqual(`${label} blank texture`, record.blank.textureFile, `blanks/${bucket}.png`);
  checkEqual(`${label} blank anchor`, record.blank.anchor, blank.anchor);
  checkEqual(`${label} blank pivot`, record.blank.pivot, blank.pivot);

  const slot = slots.get(record.representative);
  if (!check(Boolean(slot), `${label} representative is not in the layout`)) continue;
  const topTier = slot.zone === 'wall' && Number(slot.row) === 1;
  checkEqual(`${label} grounded`, record.grounded, topTier);
  if (topTier) {
    // The wall blank is the top-tier body; the mat shadow is the same body
    // dropped onto the mat, which projects to the bottom tier's anchor.
    const bottom = slots.get(record.representative.replace(/_1$/, '_0'));
    if (check(Boolean(bottom), `${label} has no bottom-tier sibling`)) {
      check(
        close(record.groundDropUnits, 0.6, 1e-3),
        `${label} ground drop ${record.groundDropUnits} is not the wall tier step`,
      );
      checkAnchor(`${label} anchor is the bottom tier's`, anchorOf(record), bottom.anchor);
      check(
        !close(anchorOf(record).y, blank.anchor.y, 1e-5),
        `${label} shadow anchor equals its top-tier blank's; it must be the grounded one`,
      );
    }
  } else {
    checkEqual(`${label} groundDropUnits`, record.groundDropUnits, 0);
    checkAnchor(`${label} anchor is the blank's`, anchorOf(record), blank.anchor);
  }

  const path = resolve(tableDir, record.textureFile);
  checkEqual(`${label} bytes`, record.bytes, statSync(path).size);
  const image = readPngSafe(path);
  if (!check(image !== null, `${label} is a readable PNG`)) continue;
  checkEqual(`${label} size`, [image.width, image.height], [record.width, record.height]);
  checkEqual(`${label} channels`, image.channels, 4);
  const measured = measure(image);
  checkEqual(`${label} sha256`, sha256(image.data), record.sha256.decodedRgba);
  check(measured.inkRgb === 0, `${label} is not black ink (${measured.inkRgb} tinted pixels)`);
  checkAlpha(`${label} peakAlpha`, measured.peak / 255, record.alpha.peakAlpha);
  checkEqual(`${label} supportPx`, measured.support, record.alpha.supportPx);
  check(
    record.pivot.x >= 0 &&
      record.pivot.x < image.width &&
      record.pivot.y >= 0 &&
      record.pivot.y < image.height,
    `${label} pivot ${record.pivot.x},${record.pivot.y} is outside the sprite`,
  );
  checkEqual(
    `${label} padding border`,
    borderMax(measured.alpha, image.width, image.height),
    0,
  );

  check(
    record.alpha.peakAlpha >= Number(checksSpec.minMatPeakAlpha),
    `${label} peak alpha ${record.alpha.peakAlpha} is below ${checksSpec.minMatPeakAlpha}`,
  );
  check(
    record.alpha.supportPx >= Number(checksSpec.minMatSupportPx),
    `${label} support ${record.alpha.supportPx} is below ${checksSpec.minMatSupportPx}`,
  );

  // Contact: the darkest pixels must sit inside the body footprint (a shadow
  // that misses the tile is not a cast shadow), and the cast penumbra must
  // reach outside it on at least minMatPenumbraSides sides.
  const body = record.bodyBBox;
  const shade = alphaBBoxOf(record);
  let contact = 0;
  for (let y = Math.max(shade.top, body.top); y <= Math.min(shade.bottom, body.bottom); y += 1) {
    for (let x = Math.max(shade.left, body.left); x <= Math.min(shade.right, body.right); x += 1) {
      const i = (y - record.crop.top) * image.width + (x - record.crop.left);
      if (measured.alpha[i] > 200) contact += 1;
    }
  }
  check(contact > 0, `${label} has no contact darkening inside the body footprint`);
  const out = {
    left: body.left - shade.left,
    top: body.top - shade.top,
    right: shade.right - body.right,
    bottom: shade.bottom - body.bottom,
  };
  const sides = Object.values(out).filter(
    (value) => value >= Number(checksSpec.minMatPenumbraPx),
  ).length;
  check(
    sides >= Number(checksSpec.minMatPenumbraSides),
    `${label} casts no penumbra past the body (${JSON.stringify(out)})`,
  );
  console.log(
    `[mat] ${bucket.padEnd(20)} ${image.width}x${image.height} ` +
      `pivot ${record.pivot.x.toFixed(1)},${record.pivot.y.toFixed(1)} ` +
      `anchor ${anchorOf(record).x.toFixed(5)},${anchorOf(record).y.toFixed(5)} ` +
      `peak ${record.alpha.peakAlpha.toFixed(3)} support ${measured.support} ` +
      `penumbra L${out.left} T${out.top} R${out.right} B${out.bottom}`,
  );
}

// -------------------------------------------------------------- wall stacks
const stack = manifest.wallStack;
check(Boolean(stack), 'wallStack is missing from the manifest');
const stackSeats = ['north', 'south', 'east', 'west'];
checkEqual('wall stack seats', Object.keys(stack.seats).sort(), stackSeats.slice().sort());
check(
  stack.perSeat === true,
  'wallStack.perSeat must be true: the seats do not share one decal',
);
check(
  stack.seatAgreement.worst > 0.2,
  `the seats supposedly agree (worst ${stack.seatAgreement.worst}); one shared decal would be valid`,
);
for (const seat of stackSeats) {
  const record = stack.seats[seat];
  const label = `stack:${seat}`;
  const lowSlot = slots.get(record.layer0);
  if (!check(Boolean(lowSlot), `${label} layer0 ${record.layer0} is not in the layout`)) continue;
  checkEqual(`${label} is the bottom tier`, Number(lowSlot.row), 0);
  checkEqual(`${label} bucket`, record.bucket, lowSlot.bucket);
  checkAnchor(`${label} anchor is the layer-0 anchor`, anchorOf(record), lowSlot.anchor);

  const path = resolve(tableDir, record.textureFile);
  checkEqual(`${label} bytes`, record.bytes, statSync(path).size);
  const image = readPngSafe(path);
  if (!check(image !== null, `${label} is a readable PNG`)) continue;
  checkEqual(`${label} size`, [image.width, image.height], [record.width, record.height]);
  const measured = measure(image);
  checkEqual(`${label} sha256`, sha256(image.data), record.sha256.decodedRgba);
  check(measured.inkRgb === 0, `${label} is not black ink (${measured.inkRgb} tinted pixels)`);
  checkAlpha(`${label} peakAlpha`, measured.peak / 255, record.alpha.peakAlpha);
  checkEqual(`${label} supportPx`, measured.support, record.alpha.supportPx);
  check(
    record.pivot.x >= 0 &&
      record.pivot.x < image.width &&
      record.pivot.y >= 0 &&
      record.pivot.y < image.height,
    `${label} pivot is outside the sprite`,
  );
  checkEqual(`${label} padding border`, borderMax(measured.alpha, image.width, image.height), 0);
  check(
    record.alpha.peakAlpha >= Number(checksSpec.minStackPeakAlpha),
    `${label} peak alpha ${record.alpha.peakAlpha} is below ${checksSpec.minStackPeakAlpha}`,
  );
  check(
    record.alpha.supportPx >= Number(checksSpec.minStackSupportPx),
    `${label} support ${record.alpha.supportPx} is below ${checksSpec.minStackSupportPx}`,
  );

  // The decal must be masked to the bottom body: not one alpha sample may land
  // outside the projected footprint, or it would darken the felt.
  const body = record.bodyBBox;
  let leaked = 0;
  for (let y = 0; y < image.height; y += 1) {
    const frameY = record.crop.top + y;
    for (let x = 0; x < image.width; x += 1) {
      const frameX = record.crop.left + x;
      if (measured.alpha[y * image.width + x] === 0) continue;
      if (frameX < body.left || frameX > body.right || frameY < body.top || frameY > body.bottom) {
        leaked += 1;
      }
    }
  }
  check(leaked === 0, `${label} leaks ${leaked} alpha samples outside the bottom body`);
  console.log(
    `[stack] ${seat.padEnd(6)} ${image.width}x${image.height} ` +
      `anchor ${anchorOf(record).x.toFixed(5)},${anchorOf(record).y.toFixed(5)} ` +
      `peak ${record.alpha.peakAlpha.toFixed(3)} mean ${record.alpha.meanAlpha.toFixed(3)} ` +
      `support ${measured.support} leaked ${leaked}`,
  );
}

// ---------------------------------------------------------------- crevices
const tile = seams.tile;
checkEqual('seam task', seams.task, '4A');
checkEqual('seam generatedBy', seams.generatedBy, 'tools/render/scripts/bake-shadow-seams.mjs');
checkEqual('seam resolution', seams.resolution.width, Number(spec.shadows.crevices.size));
checkEqual('seam resolution y', seams.resolution.height, Number(spec.shadows.crevices.size));
checkEqual('seam profile', seams.profile, spec.shadows.crevices.profile);
checkEqual('seam peak', seams.peakAlpha, Number(spec.shadows.crevices.peakAlpha));
checkEqual('seam edges', Object.keys(seams.seams).sort(), spec.shadows.crevices.edges.slice().sort());

// The mask is mapped onto a faceQuad, so it must carry at least as many pixels
// as the largest quad it will ever be stretched across (2x, so it is never
// upscaled) - including the farthest north river row, which is the smallest.
let largestQuadSide = 0;
for (const bucket of Object.keys(blanks.blanks)) {
  const quad = blanks.blanks[bucket].faceQuad;
  for (let i = 0; i < quad.length; i += 1) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    largestQuadSide = Math.max(largestQuadSide, Math.hypot(a.x - b.x, a.y - b.y));
  }
}
const seamSize = Number(spec.shadows.crevices.size);
check(
  seamSize >= 2 * largestQuadSide,
  `seam masks are ${seamSize} px but the largest face quad side is ${largestQuadSide.toFixed(1)} px; a mask would be upscaled`,
);

const fadeRange = checksSpec.seamFadeFractionOfTileWidth.map(Number);
for (const edge of spec.shadows.crevices.edges) {
  const record = seams.seams[edge];
  const label = `seam:${edge}`;
  if (!check(Boolean(record), `${label} is missing from the manifest`)) continue;
  const path = resolve(tableDir, record.textureFile);
  checkEqual(`${label} bytes`, record.bytes, statSync(path).size);
  const image = readPngSafe(path);
  if (!check(image !== null, `${label} is a readable PNG`)) continue;
  checkEqual(`${label} size`, [image.width, image.height], [seams.resolution.width, seams.resolution.height]);
  checkEqual(`${label} channels`, image.channels, 4);
  const measured = measure(image);
  checkEqual(`${label} sha256`, sha256(image.data), record.sha256.decodedRgba);
  check(measured.inkRgb === 0, `${label} is not black ink (${measured.inkRgb} tinted pixels)`);
  checkEqual(`${label} border`, borderMax(measured.alpha, image.width, image.height) > 0 ? 'ink' : 'empty', 'ink');

  const axis = record.axis === 'u' ? 'x' : 'y';
  const reversed = record.side === 'high';
  const mid = Math.floor((axis === 'x' ? image.height : image.width) / 2);
  const samples = [];
  const length = axis === 'x' ? image.width : image.height;
  for (let i = 0; i < length; i += 1) {
    const x = axis === 'x' ? i : mid;
    const y = axis === 'x' ? mid : i;
    samples.push(measured.alpha[y * image.width + x] / 255);
  }
  if (reversed) samples.reverse();
  const edgeAlpha = Math.max(...samples.slice(0, 2));
  const fadeIndex = samples.findIndex((value) => value === 0);
  const fadeAxis = fadeIndex / length;
  const fadeOfWidth = fadeAxis * (record.axis === 'u' ? 1 : tile.heightMm / tile.widthMm);
  check(
    close(edgeAlpha, Number(seams.peakAlpha), Number(checksSpec.seamPeakAlphaTolerance)),
    `${label} peak at the outer bevel edge is ${edgeAlpha.toFixed(3)}, not ${seams.peakAlpha}`,
  );
  check(fadeIndex > 0, `${label} has no fade: it is zero at the outer edge`);
  check(
    fadeOfWidth >= fadeRange[0] && fadeOfWidth <= fadeRange[1],
    `${label} fades to zero over ${(fadeOfWidth * 100).toFixed(1)}% of the tile width, outside ${fadeRange[0] * 100}-${fadeRange[1] * 100}%`,
  );
  let monotonic = true;
  for (let i = 1; i < samples.length; i += 1) {
    if (samples[i] > samples[i - 1] + Number(checksSpec.seamFadeMonotonicTolerance)) monotonic = false;
  }
  check(monotonic, `${label} is not monotonic from the outer edge inward`);
  let beyond = 0;
  for (let i = fadeIndex; i < samples.length; i += 1) if (samples[i] > 0) beyond += 1;
  check(beyond === 0, `${label} has ${beyond} non-zero samples past its fade`);

  // Constant along the edge: the fade profile down the middle of the span must
  // be the same at five points along the edge, so the mask reads as a band and
  // not as a corner blob.
  const profiles = [];
  for (let step = 1; step <= 5; step += 1) {
    const along = Math.floor((length * step) / 6);
    const probe = [];
    for (let i = 0; i < Math.max(1, fadeIndex); i += 1) {
      const x = axis === 'x' ? i : along;
      const y = axis === 'x' ? along : i;
      probe.push(measured.alpha[y * image.width + x] / 255);
    }
    profiles.push(probe);
  }
  let spread = 0;
  for (let i = 0; i < profiles[0].length; i += 1) {
    const column = profiles.map((probe) => probe[i]);
    spread = Math.max(spread, Math.max(...column) - Math.min(...column));
  }
  check(
    spread <= Number(checksSpec.seamEdgeSymmetryTolerance),
    `${label} is not constant along its edge (spread ${spread.toFixed(4)})`,
  );
  checkEqual(`${label} fadeFractionOfTileWidth`, record.measured.fadeFractionOfTileWidth, round(fadeOfWidth, 4));
  console.log(
    `[seam] ${edge.padEnd(6)} ${image.width}x${image.height} ` +
      `edge ${edgeAlpha.toFixed(3)} fade ${(fadeAxis * 100).toFixed(1)}% of ${
        record.axis === 'u' ? 'width' : 'height'
      } = ${(fadeOfWidth * 100).toFixed(1)}% of tile width`,
  );
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

// --------------------------------------------------------------------- report
console.log(`\n${checks} checks, ${failures} failures`);
if (failures > 0) {
  process.exitCode = 1;
}
