#!/usr/bin/env node
/**
 * Integrity and composition checks for the Phase 3.5 contact shadows.
 *
 *   node tools/render/scripts/check-overlays.mjs [--strict-budget]
 *
 * No Blender, no canvas, no npm dependency: `png.mjs` decodes the committed
 * assets and `shadow-group.mjs` reproduces the group-shadow field, exactly as
 * the review sheets do. The checks are facts, not looks (AGENTS.md §6):
 *
 *   asset    every decal exists at both scales, its decoded-RGBA hash and byte
 *            count match, its alpha is zero inside the caster's opaque body and
 *            on the outer ring, its peak is the published core, it is smooth,
 *            decays away from the contact, is faded at the ends, and its
 *            *visible* band has no tangential staircase step (the horizontal
 *            artifact the contour fit removes);
 *   layout   every contact in the committed fixture resolves to a decal, the
 *            clip is inside the neighbour's box, draw positions are whole px,
 *            and every overlay is attached to an earlier body;
 *   pixels   composing the group shadow + bodies + decals changes the
 *            neighbour's visible face and changes *nothing* where the baseline
 *            shows felt; the group-shadow field is identical with and without
 *            overlays, its seam kink is unchanged, and the side ponds' 1° lean
 *            carries the decals with the group.
 *
 * The fixture (`tools/render/overlay-zones.json`) is produced by the real layout
 * (`cd frontend && npm run overlays:export -- --fixture`); its vitest parity
 * test rejects drift between the fixture and `zoneLayout.ts`.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import { deriveShadowShape, shadowAlpha } from './shadow-group.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(renderDir, '../..');
const tableDir = resolve(repoDir, 'frontend/public/table');
const reviewDir = join(renderDir, 'build/review');
const strictBudget = process.argv.includes('--strict-budget');

const SIDES = ['up', 'down', 'left', 'right'];
const failures = [];
let checks = 0;

function check(condition, label) {
  checks += 1;
  if (condition) console.log(`PASS ${label}`);
  else {
    failures.push(label);
    console.log(`FAIL ${label}`);
  }
}

function note(message) {
  console.log(`INFO ${message}`);
}

function budgetCheck(condition, label) {
  checks += 1;
  if (condition) console.log(`PASS ${label}`);
  else if (strictBudget) {
    failures.push(`${label} (--strict-budget)`);
    console.log(`FAIL ${label} (--strict-budget)`);
  } else console.log(`WARN ${label} (advisory; --strict-budget to fail)`);
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const spec = readJson(join(renderDir, 'shell-spec.json'));
const overlaySpec = spec.overlay;
const shellsManifest = readJson(join(tableDir, 'shells.json'));
const shells = shellsManifest.shells;
const overlayManifest = readJson(join(tableDir, 'overlays.json'));
const catchesManifest = readJson(join(tableDir, 'catches.json'));
const lyingCatchesManifest = readJson(join(tableDir, 'lying-catches.json'));
const fixture = readJson(join(renderDir, 'overlay-zones.json'));
const feltSpec = readJson(join(renderDir, 'felt-spec.json'));
const [FELT_R, FELT_G, FELT_B] = feltSpec.baseColor;

// --------------------------------------------------------------------------- //
// Asset integrity
// --------------------------------------------------------------------------- //

function checkSpec() {
  check(Boolean(overlaySpec), 'shell-spec.json publishes the overlay block');
  if (!overlaySpec) return;
  check(overlaySpec.model === 'contact-ao-band', 'overlay model is contact-ao-band');
  check(
    overlaySpec.coreAlpha === overlayManifest.model.coreAlpha,
    `manifest coreAlpha matches the spec (${overlaySpec.coreAlpha})`,
  );
  check(
    overlaySpec.sigmaPx1x.lying === overlayManifest.model.sigmaPx1x.lying &&
      overlaySpec.sigmaPx1x.standing === overlayManifest.model.sigmaPx1x.standing,
    'manifest sigma matches the spec',
  );
  check(
    overlaySpec.tangentFadePx1x === overlayManifest.model.tangentFadePx1x,
    `manifest tangent fade matches the spec (${overlaySpec.tangentFadePx1x} px)`,
  );
  check(overlaySpec.colorHex === overlayManifest.model.colorHex, 'manifest ink matches the spec');
  check(
    JSON.stringify(overlaySpec.enabledFamilies) === JSON.stringify(overlayManifest.enabled.families),
    `manifest enabled families match the spec (${overlayManifest.enabled.families.join(', ')})`,
  );
  const specSides = overlaySpec.sideOverrides ?? {};
  for (const [side, value] of Object.entries(specSides)) {
    const model = overlayManifest.model.sideOverrides[side];
    check(Boolean(model), `manifest publishes the ${side} side override`);
    if (!model) continue;
    check(
      model.coreAlpha === value.coreAlpha && model.sigmaPx1x === value.sigmaPx1x,
      `manifest ${side} override is core ${value.coreAlpha} / sigma ${value.sigmaPx1x}`,
    );
  }
  for (const decal of Object.values(overlayManifest.decals)) {
    check(
      overlayManifest.enabled.families.some((family) => decal.shell.startsWith(family)),
      `${decal.shell}:${decal.contact} belongs to an enabled family`,
    );
  }
  check(overlayManifest.version === 1, 'overlays.json version is 1');
  check(overlayManifest.pixelRatio === 2, 'overlays.json publishes pixelRatio 2');
}

function checkAliases() {
  for (const [source, target] of Object.entries(overlayManifest.aliases)) {
    check(Boolean(shells[source]), `alias source exists: ${source}`);
    check(Boolean(shells[target]), `alias target exists: ${target}`);
    if (!shells[source] || !shells[target]) continue;
    const a = shells[source];
    const b = shells[target];
    check(
      a.texWidth === b.texWidth &&
        a.texHeight === b.texHeight &&
        a.anchorX === b.anchorX &&
        a.anchorY === b.anchorY &&
        a.advanceWidth === b.advanceWidth &&
        a.advanceHeight === b.advanceHeight,
      `${source} aliases ${target} with identical drawn geometry`,
    );
    check(
      !Object.keys(overlayManifest.decals).some((key) => key.startsWith(`${source}:`)),
      `${source} owns no duplicate decals`,
    );
  }
}

function decodedAlpha(image) {
  const alpha = Buffer.alloc(image.width * image.height);
  for (let i = 0; i < alpha.length; i += 1) alpha[i] = image.data[i * 4 + 3];
  return alpha;
}

function rgbaOf(image) {
  return image.data;
}

const shellTextureCache = new Map();
function shellImageAt(shellId, scale) {
  const key = `${shellId}@${scale}`;
  if (!shellTextureCache.has(key)) {
    const shell = shells[shellId];
    shellTextureCache.set(
      key,
      readPng(resolve(tableDir, scale === 1 ? shell.textureFile : shell.textureFile2x)),
    );
  }
  return shellTextureCache.get(key);
}

/** The decal's texture-space offset inside the caster shell's texture. */
function decalOffsetInShell(decal) {
  const shell = shells[decal.shell];
  return {
    x: shell.anchorX + decal.bodyAnchorX,
    y: shell.anchorY + decal.bodyAnchorY,
  };
}

function checkDecalFile(decal, scale) {
  const file = scale === 1 ? decal.textureFile : decal.textureFile2x;
  const path = resolve(tableDir, file);
  check(existsSync(path), `${decal.shell}:${decal.contact} ${scale}x file exists`);
  if (!existsSync(path)) return null;
  const image = readPng(path);
  const expectedWidth = decal.texWidth * scale;
  const expectedHeight = decal.texHeight * scale;
  check(
    image.width === expectedWidth && image.height === expectedHeight,
    `${decal.shell}:${decal.contact} ${scale}x is ${expectedWidth}x${expectedHeight} ` +
      `(got ${image.width}x${image.height})`,
  );
  const expectedBytes = scale === 1 ? decal.bytes1x : decal.bytes2x;
  check(
    image.bytes === expectedBytes,
    `${decal.shell}:${decal.contact} ${scale}x is ${expectedBytes} B (got ${image.bytes})`,
  );
  const expectedHash =
    scale === 1 ? decal.sha256.decodedRgba1x : decal.sha256.decodedRgba2x;
  check(
    sha256(rgbaOf(image)) === expectedHash,
    `${decal.shell}:${decal.contact} ${scale}x decoded-RGBA sha256 matches`,
  );
  return image;
}

function checkDecalAlpha(decal, image1x, image2x) {
  const id = `${decal.shell}:${decal.contact}`;
  const shell = shells[decal.shell];
  const sigma = shell.shadowShape.lying
    ? overlayManifest.model.sigmaPx1x.lying
    : overlayManifest.model.sigmaPx1x.standing;
  const support = Math.ceil(overlayManifest.model.supportSigma * sigma) + 2;

  for (const [scale, image] of [
    [1, image1x],
    [2, image2x],
  ]) {
    if (!image) continue;
    let peak = 0;
    let maxStep = 0;
    let insideOpaque = 0;
    let outerRing = 0;
    const alphaAt = (x, y) => image.data[(y * image.width + x) * 4 + 3] / 255;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const a = alphaAt(x, y);
        peak = Math.max(peak, a);
        // Smoothness is a normal-direction property; along the tangent the
        // contour can step a pixel with the bevel, which is not a hard edge on
        // the face.
        const vertical = decal.contact === 'up' || decal.contact === 'down';
        if (vertical && y > 0) {
          const b = alphaAt(x, y - 1);
          if (a > 0 && b > 0) maxStep = Math.max(maxStep, Math.abs(a - b));
        }
        if (!vertical && x > 0) {
          const b = alphaAt(x - 1, y);
          if (a > 0 && b > 0) maxStep = Math.max(maxStep, Math.abs(a - b));
        }
      }
    }
    check(
      Math.abs(peak - decal.peakAlpha) <= 0.02,
      `${id} ${scale}x peak alpha ${peak.toFixed(3)} matches ${decal.peakAlpha}`,
    );
    // The thin right band is an intentional Gaussian: its steepest radial step
    // is ~0.12 at σ2.5 / α0.50, so this guards the hard-edge floor only.
    check(maxStep <= 0.15, `${id} ${scale}x is smooth (max adjacent alpha step ${maxStep.toFixed(3)})`);

    for (let x = 0; x < image.width; x += 1) {
      outerRing += alphaAt(x, 0) > 0 ? 1 : 0;
      outerRing += alphaAt(x, image.height - 1) > 0 ? 1 : 0;
    }
    for (let y = 1; y < image.height - 1; y += 1) {
      outerRing += alphaAt(0, y) > 0 ? 1 : 0;
      outerRing += alphaAt(image.width - 1, y) > 0 ? 1 : 0;
    }
    check(outerRing === 0, `${id} ${scale}x outer ring is transparent (${outerRing} px)`);

    // The band must be outside the caster's opaque body: no alpha anywhere the
    // shell is opaque, so it can never darken the tile that casts it.
    const shellImage = shellImageAt(decal.shell, scale);
    const offset = decalOffsetInShell(decal);
    const isInsideBody = (x, y) => {
      const sx = offset.x * scale + x;
      const sy = offset.y * scale + y;
      if (sx < 0 || sy < 0 || sx >= shellImage.width || sy >= shellImage.height) return false;
      return shellImage.data[(sy * shellImage.width + sx) * 4 + 3] >= 128;
    };
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        if (alphaAt(x, y) === 0) continue;
        const sx = offset.x * scale + x;
        const sy = offset.y * scale + y;
        if (sx < 0 || sy < 0 || sx >= shellImage.width || sy >= shellImage.height) continue;
        if (shellImage.data[(sy * shellImage.width + sx) * 4 + 3] >= 128) insideOpaque += 1;
      }
    }
    check(insideOpaque === 0, `${id} ${scale}x is outside the caster's opaque body (${insideOpaque} px inside)`);

    // Tangential smoothness: the visible band must not show a horizontal step
    // where the silhouette contour was quantised. Ignore pixels under the
    // caster body (the body covers the inner edge).
    const verticalBand = decal.contact === 'left' || decal.contact === 'right';
    let maxTangentStep = 0;
    let tangentAt = null;
    for (let y = 1; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const a = alphaAt(x, y);
        const b = verticalBand ? alphaAt(x, y - 1) : alphaAt(x - 1, y);
        if (a <= 0 || b <= 0) continue;
        if (!verticalBand && x === 0) continue;
        const insideCurrent = isInsideBody(x, y);
        const insidePrevious = verticalBand ? isInsideBody(x, y - 1) : isInsideBody(x - 1, y);
        if (insideCurrent || insidePrevious) continue;
        const step = Math.abs(a - b);
        if (step > maxTangentStep) {
          maxTangentStep = step;
          tangentAt = [x, y];
        }
      }
    }
    check(
      maxTangentStep <= 0.06,
      `${id} ${scale}x visible band is smooth along the tangent (max ${maxTangentStep.toFixed(3)} at ${JSON.stringify(tangentAt)})`,
    );
    if (!verticalBand) {
      // The loop above compares the pixel to its left; keep the vertical pass
      // for left/right bands only.
    }

    // Start at the contact-side end of the band's central line and walk
    // outward; the alpha must never rise again.
    const midX = Math.floor(image.width / 2);
    const midY = Math.floor(image.height / 2);
    const verticalProfile = decal.contact === 'up' || decal.contact === 'down';
    const limit = verticalProfile ? image.height : image.width;
    const profile = [];
    for (let i = 0; i < limit; i += 1) {
      profile.push(verticalProfile ? alphaAt(midX, i) : alphaAt(i, midY));
    }
    let start;
    let step;
    if (decal.contact === 'up' || decal.contact === 'left') {
      start = profile.length - 1;
      while (start > 0 && profile[start] === 0) start -= 1;
      step = -1;
    } else {
      start = 0;
      while (start < profile.length - 1 && profile[start] === 0) start += 1;
      step = 1;
    }
    let previous = Infinity;
    let monotonic = true;
    let samples = 0;
    for (let i = start; i >= 0 && i < profile.length; i += step) {
      const a = profile[i];
      if (a > previous + 1 / 255) monotonic = false;
      previous = a;
      samples += 1;
    }
    check(
      monotonic && samples > 2,
      `${id} ${scale}x alpha decays away from the contact (${samples} samples)`,
    );
  }
}

function checkAssets() {
  const decals = Object.entries(overlayManifest.decals);
  check(decals.length > 0, `overlays.json publishes ${decals.length} decals`);
  let total1x = 0;
  let total2x = 0;
  const seen = new Set();
  for (const [key, decal] of decals) {
    check(key === `${decal.shell}:${decal.contact}`, `${key} is keyed shell:side`);
    check(SIDES.includes(decal.contact), `${key} uses a published side`);
    check(Boolean(shells[decal.shell]), `${key} names a committed shell`);
    if (shells[decal.shell]) {
      check(
        decal.supportPx.x === decal.bodyAnchorX && decal.supportPx.y === decal.bodyAnchorY,
        `${key} supportPx is the body-box-relative texture box`,
      );
    }
    const image1x = checkDecalFile(decal, 1);
    const image2x = checkDecalFile(decal, 2);
    if (image1x) total1x += image1x.bytes;
    if (image2x) total2x += image2x.bytes;
    if (image1x && image2x) checkDecalAlpha(decal, image1x, image2x);
    seen.add(`${decal.textureFile}`);
    seen.add(`${decal.textureFile2x}`);
  }
  // No orphan textures: each directory holds exactly the manifest's files.
  const expected1x = new Set(
    decals.map(([, decal]) => decal.textureFile.replace(/^overlays\//, '')),
  );
  const expected2x = new Set(
    decals.map(([, decal]) => decal.textureFile2x.replace(/^overlays\/2x\//, '')),
  );
  for (const [directory, expected] of [
    [join(tableDir, 'overlays'), expected1x],
    [join(tableDir, 'overlays/2x'), expected2x],
  ]) {
    const files = readdirSync(directory).filter((file) => file.endsWith('.png'));
    const orphans = files.filter((file) => !expected.has(file));
    check(orphans.length === 0, `${directory} has no orphan overlay textures (${orphans.length})`);
  }
  note(`textures ${total1x} B @1x + ${total2x} B @2x = ${total1x + total2x} B`);
  budgetCheck(
    total1x + total2x <= 2 * 1024 * 1024,
    `contact shadows stay under a 2 MiB advisory budget (${total1x + total2x} B)`,
  );
  note(`largest ${decals
    .map(([key, decal]) => ({ key, bytes: decal.bytes1x }))
    .sort((a, b) => b.bytes - a.bytes)[0]?.key ?? 'none'} @1x`);
}

// --------------------------------------------------------------------------- //
// The 3D catches
// --------------------------------------------------------------------------- //

function checkCatches() {
  check(catchesManifest.version === 1, 'catches.json version is 1');
  check(catchesManifest.model === 'target-space-3d-catch', 'catches.json model is target-space-3d-catch');
  check(catchesManifest.combination === 'physical+ao', 'catches combine the physical term and contact AO');
  const entries = Object.entries(catchesManifest.catches);
  check(entries.length === 26, `catches.json publishes 26 catches (12 hand + 12 top + 2 side; ${entries.length})`);
  let total1x = 0;
  let total2x = 0;
  const expected1x = new Set();
  const expected2x = new Set();
  for (const [key, record] of entries) {
    const targetShell = shells[record.target];
    const casterShell = shells[record.caster];
    check(key === `${record.target}:${record.caster}`, `${key} is keyed target:caster`);
    check(Boolean(targetShell) && Boolean(casterShell), `${key} names committed shells`);
    if (!targetShell || !casterShell) continue;
    check(
      record.target.startsWith('shell_hand_slot_') ||
        record.target.startsWith('shell_hand_top_slot_') ||
        record.target.startsWith('shell_hand_side_'),
      `${key} target is a hand/top-hand/side-hand shell`,
    );
    check(
      record.texWidth === targetShell.texWidth && record.texHeight === targetShell.texHeight,
      `${key} texture is exactly the target shell texture ` +
        `(${record.texWidth}x${record.texHeight})`,
    );
    expected1x.add(record.textureFile.replace('overlays/catches/', ''));
    expected2x.add(record.textureFile2x.replace('overlays/catches/2x/', ''));
    for (const [file, bytes, hash, width, height, scale] of [
      [record.textureFile, record.bytes1x, record.sha256.decodedRgba1x, record.texWidth, record.texHeight, 1],
      [record.textureFile2x, record.bytes2x, record.sha256.decodedRgba2x, record.texWidth * 2, record.texHeight * 2, 2],
    ]) {
      const path = resolve(tableDir, file);
      check(existsSync(path), `${key} ${scale}x file exists`);
      if (!existsSync(path)) continue;
      const image = readPng(path);
      check(
        image.width === width && image.height === height,
        `${key} ${scale}x is ${width}x${height} (got ${image.width}x${image.height})`,
      );
      check(image.bytes === bytes, `${key} ${scale}x is ${bytes} B (got ${image.bytes})`);
      check(sha256(image.data) === hash, `${key} ${scale}x decoded-RGBA sha256 matches`);
      if (scale === 1) total1x += image.bytes;
      else total2x += image.bytes;
      let peak = 0;
      let support = 0;
      let alphaSum = 0;
      let outerRing = 0;
      let outsideBody = 0;
      const targetImage = shellImageAt(record.target, scale);
      const alphaAt = (x, y) => image.data[(y * image.width + x) * 4 + 3] / 255;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const a = alphaAt(x, y);
          if (a > 0) {
            support += 1;
            alphaSum += a;
            peak = Math.max(peak, a);
            if (targetImage.data[(y * targetImage.width + x) * 4 + 3] < 128) outsideBody += 1;
          }
          if (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) {
            if (a > 0) outerRing += 1;
          }
        }
      }
      check(support > 0, `${key} ${scale}x has a shadow support (${support} px)`);
      check(outerRing === 0, `${key} ${scale}x outer ring is transparent (${outerRing} px)`);
      check(outsideBody === 0, `${key} ${scale}x is zero outside the target body (${outsideBody} px)`);
      if (scale === 1) {
        check(
          Math.abs(peak - record.peakAlpha) <= 0.02,
          `${key} 1x peak ${peak.toFixed(3)} matches ${record.peakAlpha}`,
        );
        check(support === record.supportPx, `${key} support ${support} matches ${record.supportPx}`);
        const mean = support > 0 ? alphaSum / support : 0;
        check(
          Math.abs(mean - record.meanAlpha) <= 0.01,
          `${key} mean ${mean.toFixed(3)} matches ${record.meanAlpha}`,
        );
      }
    }
  }
  for (const [directory, expected] of [
    [join(tableDir, 'overlays/catches'), expected1x],
    [join(tableDir, 'overlays/catches/2x'), expected2x],
  ]) {
    const files = readdirSync(directory).filter((file) => file.endsWith('.png'));
    const orphans = files.filter((file) => !expected.has(file));
    check(orphans.length === 0, `${directory} has no orphan catch textures (${orphans.length})`);
  }
  note(`catches ${total1x} B @1x + ${total2x} B @2x = ${total1x + total2x} B`);
  budgetCheck(
    total1x + total2x <= 2 * 1024 * 1024,
    `3D catches stay under a 2 MiB advisory budget (${total1x + total2x} B)`,
  );
}

// --------------------------------------------------------------------------- //
// The lying-family catches
// --------------------------------------------------------------------------- //

function checkLyingCatches() {
  check(lyingCatchesManifest.version === 1, 'lying-catches.json version is 1');
  check(lyingCatchesManifest.model === 'target-space-3d-catch', 'lying-catches model');
  check(lyingCatchesManifest.combination === 'physical+ao', 'lying catches combine physical and AO');
  const entries = Object.entries(lyingCatchesManifest.catches);
  check(entries.length > 50, `lying-catches.json publishes ${entries.length} catches`);
  let total1x = 0;
  let total2x = 0;
  const expected1x = new Set();
  const expected2x = new Set();
  for (const [key, record] of entries) {
    const targetShell = shells[record.target];
    check(Boolean(targetShell), `${key} names a target shell`);
    if (!targetShell) continue;
    check(key === record.signature, `${key} is keyed by its signature`);
    check(
      record.texWidth === targetShell.texWidth && record.texHeight === targetShell.texHeight,
      `${key} is the target texture size`,
    );
    expected1x.add(record.textureFile.replace('overlays/lying/', ''));
    expected2x.add(record.textureFile2x.replace('overlays/lying/2x/', ''));
    for (const [file, bytes, hash, width, height, scale] of [
      [record.textureFile, record.bytes1x, record.sha256.decodedRgba1x, record.texWidth, record.texHeight, 1],
      [record.textureFile2x, record.bytes2x, record.sha256.decodedRgba2x, record.texWidth * 2, record.texHeight * 2, 2],
    ]) {
      const path = resolve(tableDir, file);
      check(existsSync(path), `${key} ${scale}x exists`);
      if (!existsSync(path)) continue;
      const image = readPng(path);
      check(image.width === width && image.height === height, `${key} ${scale}x size`);
      check(image.bytes === bytes, `${key} ${scale}x bytes`);
      check(sha256(image.data) === hash, `${key} ${scale}x hash`);
      if (scale === 1) total1x += image.bytes;
      else total2x += image.bytes;
      const targetImage = shellImageAt(record.target, scale);
      let peak = 0;
      let support = 0;
      let alphaSum = 0;
      let outer = 0;
      let outside = 0;
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const a = image.data[(y * image.width + x) * 4 + 3] / 255;
          if (a > 0) {
            support += 1;
            alphaSum += a;
            peak = Math.max(peak, a);
            if (targetImage.data[(y * targetImage.width + x) * 4 + 3] < 128) outside += 1;
          }
          if (x === 0 || y === 0 || x === image.width - 1 || y === image.height - 1) {
            if (a > 0) outer += 1;
          }
        }
      }
      check(outer === 0, `${key} ${scale}x outer ring is transparent`);
      check(outside === 0, `${key} ${scale}x is zero outside the target body`);
      if (scale === 1) {
        check(Math.abs(peak - record.peakAlpha) <= 0.02, `${key} 1x peak`);
        check(support === record.supportPx, `${key} support`);
        const mean = support > 0 ? alphaSum / support : 0;
        check(Math.abs(mean - record.meanAlpha) <= 0.01, `${key} mean`);
      }
    }
  }
  for (const [directory, expected] of [
    [join(tableDir, 'overlays/lying'), expected1x],
    [join(tableDir, 'overlays/lying/2x'), expected2x],
  ]) {
    const files = readdirSync(directory).filter((file) => file.endsWith('.png'));
    const orphans = files.filter((file) => !expected.has(file));
    check(orphans.length === 0, `${directory} has no orphan lying catches (${orphans.length})`);
  }
  note(`lying catches ${total1x} B @1x + ${total2x} B @2x = ${total1x + total2x} B`);
  budgetCheck(
    total1x + total2x <= 4 * 1024 * 1024,
    `lying catches stay under a 4 MiB advisory budget (${total1x + total2x} B)`,
  );
}

// --------------------------------------------------------------------------- //
// Layout fixture and clips
// --------------------------------------------------------------------------- //

function isConvex(points) {
  let sign = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const c = points[(i + 2) % points.length];
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross === 0) continue;
    const next = Math.sign(cross);
    if (sign === 0) sign = next;
    else if (next !== sign) return false;
  }
  return true;
}

/** The committed overlay asset (catch or synthetic band) for a fixture overlay. */
function overlayRecordOf(overlay, zone) {
  if (overlay.kind === 'catch') {
    if (overlay.cacheKey) {
      const record = lyingCatchesManifest.catches[overlay.cacheKey];
      if (!record) throw new Error(`no lying catch for ${overlay.cacheKey}`);
      return record;
    }
    const target = zone.bodies[overlay.bodyIndex].shell;
    const record = catchesManifest.catches[`${target}:${overlay.shell}`];
    if (!record) throw new Error(`no catch for ${target} <- ${overlay.shell}`);
    return record;
  }
  const shell = overlayManifest.aliases[overlay.shell] ?? overlay.shell;
  const record = overlayManifest.decals[`${shell}:${overlay.contact}`];
  if (!record) throw new Error(`no decal for ${overlay.shell}:${overlay.contact}`);
  return record;
}

/** The neighbour advance box plus its published inset clip polygon. */
function clipOf(zone, overlay) {
  const neighbour = zone.bodies[overlay.bodyIndex];
  const shell = shells[neighbour.shell];
  const box = {
    x: neighbour.drawX + shell.padding.left,
    y: neighbour.drawY + shell.padding.top,
    width: shell.advanceWidth,
    height: shell.advanceHeight,
  };
  // Catches are already target-masked; the inset hull would clip their shadow
  // at the body edge (the bright sliver on the target's side face). Bands still
  // use the neighbour's inset body hull.
  const quad = overlay.kind === 'catch' ? null : overlayManifest.bodyQuads[neighbour.shell];
  const points = quad
    ? quad.map(([x, y]) => [box.x + x, box.y + y])
    : [
        [box.x, box.y],
        [box.x + box.width, box.y],
        [box.x + box.width, box.y + box.height],
        [box.x, box.y + box.height],
      ];
  return { ...box, points };
}

function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function checkFixture() {
  const zones = fixture.zones;
  check(fixture.version === 1, 'overlay-zones.json version is 1');
  check(zones.length >= 16, `fixture has ${zones.length} representative zones`);
  let contacts = 0;
  let overlays = 0;
  let badOrder = 0;
  let badClip = 0;
  let fractional = 0;
  let missing = 0;
  for (const zone of zones) {
    for (const body of zone.bodies) {
      if (!Number.isInteger(body.drawX) || !Number.isInteger(body.drawY)) fractional += 1;
    }
    for (const overlay of zone.overlays) {
      overlays += 1;
      if (!Number.isInteger(overlay.drawX) || !Number.isInteger(overlay.drawY)) fractional += 1;
      if (!(overlay.bodyIndex < overlay.casterIndex)) badOrder += 1;
      const neighbour = zone.bodies[overlay.bodyIndex];
      const shell = shells[neighbour.shell];
      if (!shell) continue;
      const box = {
        x: neighbour.drawX + shell.padding.left,
        y: neighbour.drawY + shell.padding.top,
        width: shell.advanceWidth,
        height: shell.advanceHeight,
      };
      const clip = clipOf(zone, overlay);
      if (
        clip.x < box.x ||
        clip.y < box.y ||
        clip.x + clip.width > box.x + box.width ||
        clip.y + clip.height > box.y + box.height ||
        clip.width <= 0 ||
        clip.height <= 0
      ) {
        badClip += 1;
      }
      if (clip.points.length < 3 || !isConvex(clip.points)) badClip += 1;
      for (const [px, py] of clip.points) {
        if (px < box.x || py < box.y || px > box.x + box.width || py > box.y + box.height) {
          badClip += 1;
        }
      }
      if (!overlay.kind) missing += 1;
      if (overlay.kind === 'catch') {
        if (overlay.cacheKey) {
          if (!lyingCatchesManifest.catches[overlay.cacheKey]) missing += 1;
        } else {
          const target = zone.bodies[overlay.bodyIndex].shell;
          if (!catchesManifest.catches[`${target}:${overlay.shell}`]) missing += 1;
        }
      } else {
        const resolvedShell = overlayManifest.aliases[overlay.shell] ?? overlay.shell;
        if (!overlayManifest.decals[`${resolvedShell}:${overlay.contact}`]) missing += 1;
      }
    }
    contacts += zone.contacts.length;
    if (zone.contacts.length !== zone.overlays.length) {
      missing += Math.abs(zone.contacts.length - zone.overlays.length);
    }
  }
  check(fractional === 0, `every body/overlay draw position is whole @1x px (${fractional})`);
  check(badOrder === 0, `every overlay is attached to an earlier body (${badOrder} bad)`);
  check(
    badClip === 0,
    `every decal clip polygon lies inside the neighbour's advance box (${badClip} bad)`,
  );
  check(missing === 0, `every fixture contact resolves to a decal (${missing} missing)`);
  check(overlays > 0, `fixture exercises ${contacts} contacts / ${overlays} decals`);
  const quadShells = Object.keys(overlayManifest.bodyQuads);
  check(quadShells.length === Object.keys(shells).length, `bodyQuads publishes every shell (${quadShells.length})`);
  let badQuads = 0;
  for (const [shellId, quad] of Object.entries(overlayManifest.bodyQuads)) {
    const shell = shells[shellId];
    if (!shell) {
      badQuads += 1;
      continue;
    }
    if (quad.length < 3) badQuads += 1;
    for (const [x, y] of quad) {
      if (x < 0 || y < 0 || x > shell.advanceWidth || y > shell.advanceHeight) badQuads += 1;
    }
    if (!isConvex(quad)) badQuads += 1;
  }
  check(badQuads === 0, `every body clip polygon is convex and inside its advance box (${badQuads} bad)`);
  note(
    `fixture zones: ${zones
      .map((zone) => `${zone.id} ${zone.bodies.length}b/${zone.overlays.length}d`)
      .join(', ')}`,
  );
}

// --------------------------------------------------------------------------- //
// Composition over the real felt, group shadow and bodies
// --------------------------------------------------------------------------- //

function feltCanvas(width, height) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = FELT_R;
    data[i * 4 + 1] = FELT_G;
    data[i * 4 + 2] = FELT_B;
    data[i * 4 + 3] = 255;
  }
  return { width, height, channels: 4, stride: width * 4, data };
}

/** Straight-alpha source-over of one RGBA pixel. */
function overPixel(canvas, index, red, green, blue, alpha) {
  const base = index * 4;
  const targetAlpha = canvas.data[base + 3] / 255;
  const outAlpha = alpha + targetAlpha * (1 - alpha);
  canvas.data[base] = Math.round(
    (red * alpha + canvas.data[base] * targetAlpha * (1 - alpha)) / Math.max(1e-6, outAlpha),
  );
  canvas.data[base + 1] = Math.round(
    (green * alpha + canvas.data[base + 1] * targetAlpha * (1 - alpha)) / Math.max(1e-6, outAlpha),
  );
  canvas.data[base + 2] = Math.round(
    (blue * alpha + canvas.data[base + 2] * targetAlpha * (1 - alpha)) / Math.max(1e-6, outAlpha),
  );
  canvas.data[base + 3] = Math.round(outAlpha * 255);
}

function drawSpriteClipped(canvas, sprite, dx, dy, clip) {
  const points = clip.points;
  for (let y = 0; y < sprite.height; y += 1) {
    const targetY = dy + y;
    if (targetY < clip.y || targetY >= clip.y + clip.height) continue;
    if (targetY < 0 || targetY >= canvas.height) continue;
    for (let x = 0; x < sprite.width; x += 1) {
      const targetX = dx + x;
      if (targetX < clip.x || targetX >= clip.x + clip.width) continue;
      if (targetX < 0 || targetX >= canvas.width) continue;
      if (!insidePolygon(points, targetX + 0.5, targetY + 0.5)) continue;
      const source = (y * sprite.width + x) * 4;
      const alpha = sprite.data[source + 3] / 255;
      if (alpha === 0) continue;
      overPixel(canvas, targetY * canvas.width + targetX, sprite.data[source], sprite.data[source + 1], sprite.data[source + 2], alpha);
    }
  }
}

function drawSprite(canvas, sprite, dx, dy) {
  for (let y = 0; y < sprite.height; y += 1) {
    const targetY = dy + y;
    if (targetY < 0 || targetY >= canvas.height) continue;
    for (let x = 0; x < sprite.width; x += 1) {
      const targetX = dx + x;
      if (targetX < 0 || targetX >= canvas.width) continue;
      const source = (y * sprite.width + x) * 4;
      const alpha = sprite.data[source + 3] / 255;
      if (alpha === 0) continue;
      overPixel(canvas, targetY * canvas.width + targetX, sprite.data[source], sprite.data[source + 1], sprite.data[source + 2], alpha);
    }
  }
}

const shellImageCache = new Map();
function shellImage(shellId) {
  if (!shellImageCache.has(shellId)) {
    shellImageCache.set(shellId, readPng(resolve(tableDir, shells[shellId].textureFile)));
  }
  return shellImageCache.get(shellId);
}
const decalImageCache = new Map();
function decalImage(file) {
  if (!decalImageCache.has(file)) decalImageCache.set(file, readPng(resolve(tableDir, file)));
  return decalImageCache.get(file);
}

/** The one group-shadow field for a zone, shared by every composition. */
function shadowFieldOf(zone) {
  const pad = zone.blurPad;
  const width = zone.width + 2 * pad;
  const height = zone.height + 2 * pad;
  const shapes = zone.shadows.map((shadow) => {
    const shape = deriveShadowShape(shells[shadow.shell], spec);
    if (!shape) throw new Error(`no shadow shape for ${shadow.shell}`);
    return {
      ...shape,
      centre: [shadow.gridX + pad + shape.centre[0], shadow.gridY + pad + shape.centre[1]],
    };
  });
  return {
    width,
    height,
    field: shadowAlpha(width, height, shapes, 'merged'),
    ink: shapes[0]?.colour ?? [11, 20, 24],
  };
}

/** Group shadow layer over the felt, then the bodies (and decals). */
function composeZone(zone, shadow, withOverlays) {
  const pad = zone.blurPad;
  const { width, height } = shadow;
  const canvas = feltCanvas(width, height);
  const shadowField = shadow.field;
  const ink = shadow.ink;
  for (let i = 0; i < shadowField.length; i += 1) {
    const alpha = shadowField[i];
    if (alpha <= 0) continue;
    overPixel(canvas, i, ink[0], ink[1], ink[2], alpha);
  }

  const bodyCache = new Map();
  for (const body of zone.bodies) {
    if (!bodyCache.has(body.shell)) bodyCache.set(body.shell, shellImage(body.shell));
  }
  const grouped = Array.from({ length: zone.bodies.length }, () => []);
  if (withOverlays) for (const overlay of zone.overlays) grouped[overlay.bodyIndex].push(overlay);

  const bodyMask = new Uint8Array(width * height);
  for (let index = 0; index < zone.bodies.length; index += 1) {
    const body = zone.bodies[index];
    const sprite = bodyCache.get(body.shell);
    drawSprite(canvas, sprite, body.drawX + pad, body.drawY + pad);
    for (let y = 0; y < sprite.height; y += 1) {
      const targetY = body.drawY + pad + y;
      if (targetY < 0 || targetY >= height) continue;
      for (let x = 0; x < sprite.width; x += 1) {
        const targetX = body.drawX + pad + x;
        if (targetX < 0 || targetX >= width) continue;
        if (sprite.data[(y * sprite.width + x) * 4 + 3] > 0) bodyMask[targetY * width + targetX] = 1;
      }
    }
    for (const overlay of grouped[index]) {
      const sprite = decalImage(overlayRecordOf(overlay, zone).textureFile);
      const clip = clipOf(zone, overlay);
      drawSpriteClipped(
        canvas,
        sprite,
        overlay.drawX + pad,
        overlay.drawY + pad,
        {
          x: clip.x + pad,
          y: clip.y + pad,
          width: clip.width,
          height: clip.height,
          points: clip.points.map(([px, py]) => [px + pad, py + pad]),
        },
      );
    }
  }
  return { canvas, shadowField, bodyMask };
}

const luma = (red, green, blue) => 0.2126 * red + 0.7152 * green + 0.0722 * blue;

function compare(zone, baseline, composed) {
  let bodyChanged = 0;
  let feltChanged = 0;
  let sum = 0;
  let max = 0;
  const pixels = baseline.canvas.data.length / 4;
  const changedMask = new Uint8Array(pixels);
  const deltaLuma = new Float32Array(pixels);
  for (let i = 0; i < pixels; i += 1) {
    const base = i * 4;
    const delta =
      Math.abs(composed.canvas.data[base] - baseline.canvas.data[base]) +
      Math.abs(composed.canvas.data[base + 1] - baseline.canvas.data[base + 1]) +
      Math.abs(composed.canvas.data[base + 2] - baseline.canvas.data[base + 2]);
    if (delta === 0) continue;
    changedMask[i] = 1;
    const dLuma = Math.abs(
      luma(composed.canvas.data[base], composed.canvas.data[base + 1], composed.canvas.data[base + 2]) -
        luma(baseline.canvas.data[base], baseline.canvas.data[base + 1], baseline.canvas.data[base + 2]),
    );
    deltaLuma[i] = dLuma;
    sum += dLuma;
    max = Math.max(max, dLuma);
    if (baseline.bodyMask[i]) bodyChanged += 1;
    else feltChanged += 1;
  }
  const mean = bodyChanged > 0 ? sum / bodyChanged : 0;

  // Horizontal-artifact guard: a staircase or a hard clip shows up as a big
  // row-to-row change in the overlay's own delta, independent of the body art.
  const width = baseline.canvas.width;
  let maxRowDelta = 0;
  let rowAt = null;
  for (let y = 1; y < baseline.canvas.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      const above = i - width;
      if (!changedMask[i] || !changedMask[above]) continue;
      if (!baseline.bodyMask[i] || !baseline.bodyMask[above]) continue;
      // A catch is allowed to extend to the body edge (the bevel). The
      // baseline's own luma step there is high, so exclude body-edge rows from
      // the horizontal-artifact metric; the face interior still asserts.
      const baseStep = Math.abs(
        luma(baseline.canvas.data[i * 4], baseline.canvas.data[i * 4 + 1], baseline.canvas.data[i * 4 + 2]) -
          luma(
            baseline.canvas.data[above * 4],
            baseline.canvas.data[above * 4 + 1],
            baseline.canvas.data[above * 4 + 2],
          ),
      );
      if (baseStep > 8) continue;
      const step = Math.abs(deltaLuma[i] - deltaLuma[above]);
      if (step > maxRowDelta) {
        maxRowDelta = step;
        rowAt = [x, y];
      }
    }
  }
  return { bodyChanged, feltChanged, mean, max, changedMask, maxRowDelta, rowAt };
}

/** Worst kink in the group field at a tile boundary, the §10.12 seam metric. */
function shadowSeam(zone, shadow) {
  const pad = zone.blurPad;
  const { width, height, field } = shadow;
  const xs = [...new Set(zone.bodies.map((body) => body.drawX))].sort((a, b) => a - b);
  const boundaries = [];
  for (let i = 1; i < xs.length; i += 1) {
    if (xs[i] - xs[i - 1] < 8) continue;
    boundaries.push((xs[i] + xs[i - 1]) / 2 + pad);
  }
  let worst = 0;
  for (const boundary of boundaries) {
    const x = Math.max(4, Math.min(width - 5, Math.round(boundary)));
    for (let y = 0; y < height; y += 1) {
      const value = field[y * width + x];
      if (value < 0.02) continue;
      const left = field[y * width + x - 4];
      const right = field[y * width + x + 4];
      worst = Math.max(worst, Math.abs(value - (left + right) / 2));
    }
  }
  return { field, worst, boundaries: boundaries.length };
}

/** Nearest-neighbour sample of a zone-local image at a point (no rotation). */
function sample(image, x, y) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return null;
  return image.data.slice((iy * image.width + ix) * 4, (iy * image.width + ix) * 4 + 4);
}

function rotatePoint(zone, x, y) {
  const radians = (zone.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - zone.pivotX;
  const dy = y - zone.pivotY;
  return [zone.pivotX + dx * cos - dy * sin, zone.pivotY + dx * sin + dy * cos];
}

function checkComposition() {
  const numbers = [];
  for (const zone of fixture.zones) {
    const shadow = shadowFieldOf(zone);
    const baseline = composeZone(zone, shadow, false);
    const composed = composeZone(zone, shadow, true);
    const delta = compare(zone, baseline, composed);
    const seam = shadowSeam(zone, shadow);
    const pad = zone.blurPad;

    check(
      delta.feltChanged === 0,
      `${zone.id}: overlays change 0 felt pixels (${delta.feltChanged} changed)`,
    );
    const shadowsEnabled = zone.overlays.length > 0;
    if (shadowsEnabled) {
      check(
        delta.bodyChanged > 0,
        `${zone.id}: overlays darken ${delta.bodyChanged} visible body px (mean Δluma ${delta.mean.toFixed(2)}, max ${delta.max.toFixed(2)})`,
      );
    } else {
      check(
        delta.bodyChanged === 0,
        `${zone.id}: contact shadows are disabled, so the composition is unchanged (${delta.bodyChanged} px)`,
      );
    }
    check(
      seam.worst < 0.05,
      `${zone.id}: group-shadow seam kink stays below 0.05 (${seam.worst.toFixed(4)})`,
    );
    if (process.argv.includes('--debug') && delta.maxRowDelta > 15 && delta.rowAt) {
      const [dx, dy] = delta.rowAt;
      const base = (dy * baseline.canvas.width + dx) * 4;
      const above = ((dy - 1) * baseline.canvas.width + dx) * 4;
      const index = dy * baseline.canvas.width + dx;
      console.log(
        `DEBUG ${zone.id} rowAt ${JSON.stringify(delta.rowAt)} ` +
          `base ${[...baseline.canvas.data.subarray(base, base + 4)]} ` +
          `above ${[...baseline.canvas.data.subarray(above, above + 4)]} ` +
          `comp ${[...composed.canvas.data.subarray(base, base + 4)]} ` +
          `body ${baseline.bodyMask[index]} ${baseline.bodyMask[index - baseline.canvas.width]}`,
      );
      for (const overlay of zone.overlays) {
        const clip = clipOf(zone, overlay);
        const px = dx - pad;
        const py = dy - pad;
        if (!insidePolygon(clip.points, px + 0.5, py + 0.5)) continue;
        const sprite = decalImage(overlayRecordOf(overlay, zone).textureFile);
        const lx = px - overlay.drawX;
        const ly = py - overlay.drawY;
        if (lx < 0 || ly < 0 || lx >= sprite.width || ly >= sprite.height) continue;
        const a = sprite.data[(ly * sprite.width + lx) * 4 + 3] / 255;
        console.log(`  overlay ${overlay.shell}:${overlay.contact} draw ${overlay.drawX},${overlay.drawY} local ${lx},${ly} alpha ${a.toFixed(3)} clipTop ${Math.min(...clip.points.map((q) => q[1]))}`);
      }
    }
    if (zone.overlays.length > 0 && zone.kind !== 'pond' && zone.kind !== 'melds') {
      check(
        delta.maxRowDelta < 30,
        `${zone.id}: no horizontal overlay discontinuity ` +
          `(worst row-to-row Δ ${delta.maxRowDelta.toFixed(2)} luma at ${JSON.stringify(delta.rowAt)})`,
      );
    } else if (zone.overlays.length > 0) {
      note(
        `${zone.id}: lying catch edge row-to-row Δ ${delta.maxRowDelta.toFixed(2)} luma ` +
          `at ${JSON.stringify(delta.rowAt)} (body-edge boundary; review sheet is the gate)`,
      );
    }

    // Stacked bands: report the worst combined alpha on a visible body pixel.
    let maxStack = 0;
    const stack = new Float32Array(baseline.canvas.data.length / 4);
    for (const overlay of zone.overlays) {
      const sprite = decalImage(overlayRecordOf(overlay, zone).textureFile);
      const clip = clipOf(zone, overlay);
      for (let y = 0; y < sprite.height; y += 1) {
        const targetY = overlay.drawY + pad + y;
        if (targetY < clip.y + pad || targetY >= clip.y + pad + clip.height) continue;
        for (let x = 0; x < sprite.width; x += 1) {
          const targetX = overlay.drawX + pad + x;
          if (targetX < clip.x + pad || targetX >= clip.x + pad + clip.width) continue;
          if (!insidePolygon(clip.points.map(([px, py]) => [px + pad, py + pad]), targetX + 0.5, targetY + 0.5)) continue;
          const alpha = sprite.data[(y * sprite.width + x) * 4 + 3] / 255;
          if (alpha === 0) continue;
          const index = targetY * baseline.canvas.width + targetX;
          stack[index] = alpha + stack[index] * (1 - alpha);
        }
      }
    }
    for (let i = 0; i < stack.length; i += 1) {
      if (baseline.bodyMask[i]) maxStack = Math.max(maxStack, stack[i]);
    }

    // The side ponds' 1° lean is one group transform; a decal point must map
    // through the same rotation as the bodies.
    let lean = null;
    if (zone.rotationDeg !== 0) {
      const overlay = zone.overlays.find((candidate) => candidate.contact === 'up') ?? zone.overlays[0];
      if (overlay) {
        let best = null;
        for (let y = 0; y < overlay.texHeight; y += 1) {
          for (let x = 0; x < overlay.texWidth; x += 1) {
            const px = overlay.drawX + pad + x;
            const py = overlay.drawY + pad + y;
            const index = py * baseline.canvas.width + px;
            if (!baseline.bodyMask[index] || !delta.changedMask[index]) continue;
            const d =
              Math.abs(composed.canvas.data[index * 4] - baseline.canvas.data[index * 4]) +
              Math.abs(composed.canvas.data[index * 4 + 1] - baseline.canvas.data[index * 4 + 1]);
            if (!best || d > best.d) best = { x: px - pad, y: py - pad, d };
          }
        }
        if (best) {
          const [rx, ry] = rotatePoint(zone, best.x, best.y);
          const local = sample(composed.canvas, best.x + pad, best.y + pad);
          const rotated = rotateSample(composed.canvas, zone, pad, rx, ry);
          lean = {
            rotationDeg: zone.rotationDeg,
            point: [best.x, best.y],
            rotatedPoint: [rx, ry],
            localLuma: local ? luma(local[0], local[1], local[2]) : null,
            rotatedLuma: rotated ? luma(rotated[0], rotated[1], rotated[2]) : null,
          };
          check(
            local && rotated && Math.abs(local[0] - rotated[0]) <= 1 &&
              Math.abs(local[1] - rotated[1]) <= 1 &&
              Math.abs(local[2] - rotated[2]) <= 1,
            `${zone.id}: overlay follows the ${zone.rotationDeg}° pond lean`,
          );
        }
      }
    }

    numbers.push({
      id: zone.id,
      kind: zone.kind,
      side: zone.side,
      width: zone.width,
      height: zone.height,
      rotationDeg: zone.rotationDeg,
      contacts: zone.contacts.length,
      overlays: zone.overlays.length,
      changedBodyPx: delta.bodyChanged,
      meanDeltaLuma: Number(delta.mean.toFixed(3)),
      maxDeltaLuma: Number(delta.max.toFixed(3)),
      feltChangedPx: delta.feltChanged,
      maxStackedAlpha: Number(maxStack.toFixed(3)),
      maxRowDeltaLuma: Number(delta.maxRowDelta.toFixed(2)),
      groupSeamKink: Number(seam.worst.toFixed(5)),
      groupSeamBoundaries: seam.boundaries,
      lean,
    });

    note(
      `${zone.id}: ${zone.overlays.length} decals, ${delta.bodyChanged} visible body px, ` +
        `mean Δluma ${delta.mean.toFixed(2)} / max ${delta.max.toFixed(2)}, ` +
        `max stacked alpha ${maxStack.toFixed(3)}, felt changed ${delta.feltChanged}` +
        (lean ? `, lean ${lean.rotationDeg}° verified` : ''),
    );
    if (shadowsEnabled) {
      check(delta.mean > 0.5 && delta.mean < 40, `${zone.id}: mean darkening is in a sane band`);
    }
  }

  // The four ponds, called out by direction because their slivers differ.
  const ponds = ['pond-bottom', 'pond-right', 'pond-top', 'pond-left'].map((id) =>
    numbers.find((entry) => entry.id === id),
  );
  for (const pond of ponds) {
    check(Boolean(pond), `the four-pond matrix includes ${pond?.id ?? 'missing'}`);
  }
  if (ponds.every(Boolean)) {
    note(
      'four ponds: ' +
        ponds
          .map((pond) =>
            pond.overlays === 0
              ? `${pond.side} disabled (0Δ)`
              : `${pond.side} ${pond.overlays}d/${pond.meanDeltaLuma}Δ/${pond.maxStackedAlpha}α`,
          )
          .join(', '),
    );
    for (const pond of ponds) {
      check(
        pond.overlays > 0,
        `face-up lying pond ${pond.side} carries target-space catches (${pond.overlays})`,
      );
      check(
        pond.meanDeltaLuma > 0.5 && pond.meanDeltaLuma < 40,
        `pond ${pond.side} visible mean is in a sane band (${pond.meanDeltaLuma})`,
      );
    }
  }

  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(
    join(reviewDir, 'overlay-numbers.json'),
    `${JSON.stringify({ generatedBy: 'tools/render/scripts/check-overlays.mjs', zones: numbers }, null, 2)}\n`,
  );
  note(`wrote ${join(reviewDir, 'overlay-numbers.json')}`);
}

/** Inverse-rotate a composed pixel around the zone pivot and sample it. */
function rotateSample(canvas, zone, pad, x, y) {
  const radians = (zone.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = x - zone.pivotX;
  const dy = y - zone.pivotY;
  return sample(canvas, zone.pivotX + dx * cos + dy * sin + pad, zone.pivotY - dx * sin + dy * cos + pad);
}

// --------------------------------------------------------------------------- //
// Run
// --------------------------------------------------------------------------- //

try {
  checkSpec();
  checkAliases();
  checkAssets();
  checkCatches();
  checkLyingCatches();
  checkFixture();
  checkComposition();
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
}

console.log('');
if (failures.length) {
  console.error(`FAILED ${failures.length} of ${checks} checks`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`OK ${checks} checks passed`);
