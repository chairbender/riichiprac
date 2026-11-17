#!/usr/bin/env node
/**
 * Acceptance gate for the 2.5D rig reference (Task 2 of
 * 2_5d_implementation_plan.md). No Blender.
 *
 *   node tools/render/scripts/check-table-rig.mjs
 *
 * Validates facts, not looks (AGENTS.md 6):
 *
 *   - the spec's rig contract: perspective, 75 mm in the 65-85 range, pitch in
 *     48-52 deg, camera on X = 0 behind the south edge, a negative Shift Y,
 *     16:9, film transparent with the floor hidden, one large soft overhead
 *     AREA key slightly forward of centre plus low fills, Cycles GI for contact
 *     occlusion;
 *   - the manifest camera matches the spec and the recorded bake, with no roll
 *     (the camera right vector is world +X) and a distance that matches the eye;
 *   - the acceptance geometry recomputed from the camera and the recorded
 *     placements: the +Y vanishing point the side-wall runs converge on is above
 *     the frame, both runs' inner-face lines meet it within 1 px, both side
 *     walls' inner vertical faces are visible slivers, the centre of the south
 *     hand is straight-on while the outer slots show their inner thickness, the
 *     south hand's plate edges never lean inward and the table width and hand
 *     are framed as specified;
 *   - the rig scene is Task 1's scene: every tile id/origin/rotation matches the
 *     published placement reference, and the only face override is the rig's
 *     blank hand probe;
 *   - the committed PNG is RGBA at 1920x1080 with the recorded bytes and
 *     decoded-RGBA sha256, a transparent surround and an opaque table;
 *   - the lighting probes, measured on the rendered pixels: a lit ivory face,
 *     a blue wall back, a readable blank hand face, side-wall inner faces that
 *     are measurably brighter than the felt.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import { cameraFromCandidate, rigLightingSamples, rigMetrics } from './table-camera.mjs';
import { alphaAt, alphaCoverage, measureRigSamples } from './table-rig-samples.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
const near = (left, right, tolerance, label) =>
  check(
    Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance,
    `${label}: ${left} != ${right} (tol ${tolerance})`,
  );
const load = (path, label) => {
  if (!existsSync(path)) {
    fail(`${label} missing at ${path}`);
    return null;
  }
  return JSON.parse(readFileSync(path, 'utf8'));
};

const spec = load(join(renderDir, 'table-reference-spec.json'), 'table-reference-spec.json');
const shellSpec = load(join(renderDir, 'shell-spec.json'), 'shell-spec.json');
const placement = load(join(renderDir, 'reference', 'table-reference.json'), 'table-reference.json');
if (!spec || !shellSpec || !placement) process.exit(1);
const rig = spec.rig;
if (!check(Boolean(rig), 'the spec has a rig block')) process.exit(1);
const manifest = load(join(renderDir, 'reference', rig.output.manifest), rig.output.manifest);
if (!manifest) process.exit(1);

const limits = rig.checks;
const resolution = rig.output.resolution;
const cameraSpec = rig.camera;

// --------------------------------------------------------------------------- //
// The rig contract
// --------------------------------------------------------------------------- //
check(cameraSpec.mode === 'perspective', `camera is perspective (${cameraSpec.mode})`);
check(
  cameraSpec.lensMm >= limits.lensMmRange[0] && cameraSpec.lensMm <= limits.lensMmRange[1],
  `lens ${cameraSpec.lensMm} mm in [${limits.lensMmRange}]`,
);
check(
  cameraSpec.elevationDeg >= limits.elevationDegRange[0] &&
    cameraSpec.elevationDeg <= limits.elevationDegRange[1],
  `pitch ${cameraSpec.elevationDeg} deg in [${limits.elevationDegRange}]`,
);
check(cameraSpec.shiftX === 0, `Shift X is 0 (${cameraSpec.shiftX})`);
check(cameraSpec.shiftY < 0, `Shift Y is negative (${cameraSpec.shiftY})`);
near(cameraSpec.eye[0], 0, 1e-9, 'the camera is centred on X = 0');
check(cameraSpec.eye[1] < 0, `the camera is behind the south edge (eye y ${cameraSpec.eye[1]})`);
check(resolution[0] === 1920 && resolution[1] === 1080, `reference resolution is 1920x1080`);
check(resolution[0] * 9 === resolution[1] * 16, 'the reference frame is 16:9');
check(rig.render.filmTransparent === true, 'Film > Transparent is enabled');
check(rig.render.hideFloor === true, 'the room floor is hidden for the RGBA reference');
check(rig.render.colorMode === 'RGBA', 'the render colour mode is RGBA');
check(rig.render.engine === 'CYCLES' && rig.render.device === 'CPU', 'Cycles on CPU');

const lighting = rig.lighting;
const key = lighting.key;
check(key.type === 'AREA', `the key is an AREA light (${key.type})`);
check(
  Math.min(key.sizeUnits, key.sizeYUnits) >= 10,
  `the key is large (${key.sizeUnits} x ${key.sizeYUnits} units)`,
);
check(key.location[1] < 0, `the key sits forward of centre (y ${key.location[1]})`);
check(key.location[2] > 15, `the key is overhead (z ${key.location[2]})`);
check(lighting.fills.length >= 2, `${lighting.fills.length} fill lights`);
for (const fill of lighting.fills) {
  check(fill.type === 'AREA', `fill ${fill.id} is an AREA light`);
  check(fill.energyW < key.energyW, `fill ${fill.id} (${fill.energyW} W) is low against the key (${key.energyW} W)`);
}
check(lighting.world.strength <= 0.5, `ambient world strength ${lighting.world.strength} is low`);
check(lighting.ambientOcclusion.mode === 'cycles-gi', 'contact occlusion is path-traced (Cycles GI)');

// --------------------------------------------------------------------------- //
// Camera and the bake record
// --------------------------------------------------------------------------- //
const camera = cameraFromCandidate(cameraSpec, resolution);
check(manifest.rig === rig.id, `manifest rig id is ${rig.id}`);
check(manifest.blender === '4.5.9 LTS', `Blender ${manifest.blender}`);
for (const axis of [0, 1, 2]) {
  near(manifest.camera.eye[axis], camera.eye[axis], 1e-4, `manifest camera eye[${axis}]`);
  near(manifest.camera.target[axis], camera.target[axis], 1e-6, `manifest camera target[${axis}]`);
}
near(
  Math.hypot(...[0, 1, 2].map((axis) => camera.eye[axis] - camera.target[axis])),
  cameraSpec.distanceUnits,
  1e-3,
  'the stored distance is the eye-to-target distance',
);
near(manifest.camera.lensMm, cameraSpec.lensMm, 1e-9, 'manifest camera lens');
near(manifest.camera.shiftY, cameraSpec.shiftY, 1e-9, 'manifest camera Shift Y');
check(manifest.projectionDeltaPx >= 0 && manifest.projectionDeltaPx <= 0.01,
  `the pinhole matches Blender (${manifest.projectionDeltaPx} px)`);
checkEqual('visibility probes are not occluded', manifest.visibility.occluded, 0);
check(manifest.visibility.samples >= 700, `visibility samples ${manifest.visibility.samples} >= 700`);
checkEqual('bake samples', manifest.render.samples, rig.render.samples);
check(manifest.render.filmTransparent === true, 'the bake rendered with film transparent');
check(manifest.render.floorHidden === true, 'the bake hid the room floor');
check(manifest.render.colorMode === 'RGBA', 'the bake wrote RGBA');

// No roll is asserted through the camera basis below (`metrics.camera.right`).

// --------------------------------------------------------------------------- //
// The scene is Task 1's scene
// --------------------------------------------------------------------------- //
const tiles = manifest.scene?.tiles;
if (!check(Array.isArray(tiles) && tiles.length === 269, `the rig scene has 269 tiles`)) process.exit(1);
const placementTiles = new Map(placement.scene.tiles.map((tile) => [tile.id, tile]));
const differences = [];
for (const tile of tiles) {
  const source = placementTiles.get(tile.id);
  if (!check(Boolean(source), `tile ${tile.id} exists in the placement reference`)) continue;
  if (tile.face !== source.face) differences.push({ id: tile.id, face: tile.face, placementFace: source.face });
  for (const axis of [0, 1, 2]) {
    near(tile.origin[axis], source.origin[axis], 1e-6, `tile ${tile.id} origin[${axis}]`);
    near(tile.rotation[axis * 3], source.rotation[axis * 3], 1e-9, `tile ${tile.id} rotation`);
    near(tile.rotation[axis * 3 + 1], source.rotation[axis * 3 + 1], 1e-9, `tile ${tile.id} rotation`);
    near(tile.rotation[axis * 3 + 2], source.rotation[axis * 3 + 2], 1e-9, `tile ${tile.id} rotation`);
  }
}
checkEqual(
  'the only face override in the rig scene is its blank hand probe',
  differences,
  [{ id: rig.samples.handFaceTileId, face: rig.samples.handFace, placementFace: placementTiles.get(rig.samples.handFaceTileId)?.face }],
);
checkEqual('the tile dimensions are the shell body', manifest.scene.dimensions, placement.scene.dimensions);

// --------------------------------------------------------------------------- //
// Acceptance geometry
// --------------------------------------------------------------------------- //
const metrics = rigMetrics(camera, tiles, spec, shellSpec);
const recorded = manifest.metrics;
const compareMetric = (label, actual, expected) =>
  near(actual, expected, 1e-3, `metric ${label}`);
compareMetric('vanishingPoint.x', recorded.vanishingPoint.x, metrics.vanishingPoint.x);
compareMetric('vanishingPoint.y', recorded.vanishingPoint.y, metrics.vanishingPoint.y);
compareMetric('runConvergenceDeltaPx', recorded.runConvergenceDeltaPx, metrics.runConvergenceDeltaPx);
compareMetric('hand.bottomMarginPx', recorded.hand.bottomMarginPx, metrics.hand.bottomMarginPx);
compareMetric('wallInnerFaceMinPx.left', recorded.wallInnerFaceMinPx.left, metrics.wallInnerFaceMinPx.left);
compareMetric('wallInnerFaceMinPx.right', recorded.wallInnerFaceMinPx.right, metrics.wallInnerFaceMinPx.right);
for (const [index, row] of metrics.hand.rows.entries()) {
  const other = recorded.hand.rows[index];
  compareMetric(`hand.rows[${index}].sideSliverPx`, other.sideSliverPx, row.sideSliverPx);
  compareMetric(`hand.rows[${index}].outwardLeanLeftPx`, other.outwardLeanLeftPx, row.outwardLeanLeftPx);
  compareMetric(`hand.rows[${index}].outwardLeanRightPx`, other.outwardLeanRightPx, row.outwardLeanRightPx);
}

checkEqual('camera mode', metrics.camera.mode, 'perspective');
near(metrics.camera.right[0], 1, 1e-9, 'camera right is world +X (no roll)');
near(metrics.camera.right[1], 0, 1e-9, 'camera right has no Y component');
near(metrics.camera.right[2], 0, 1e-9, 'camera right has no Z component');
near(metrics.camera.shiftX, 0, 0, 'Shift X stays 0');
check(metrics.camera.shiftY < 0, 'Shift Y stays negative');
near(metrics.camera.eye[0], 0, 1e-9, 'the eye stays on X = 0');

// The side-wall runs converge above the frame.
check(
  metrics.vanishingPoint.y < 0,
  `the +Y vanishing point (${metrics.vanishingPoint.y.toFixed(1)} px) is above the top of the frame`,
);
near(metrics.vanishingPoint.x, resolution[0] / 2, 1, 'the vanishing point sits on the frame centre line');
check(
  metrics.runConvergenceDeltaPx !== null && metrics.runConvergenceDeltaPx <= 1,
  `both side-wall runs meet that vanishing point (${metrics.runConvergenceDeltaPx} px)`,
);
for (const side of ['left', 'right']) {
  check(
    metrics.wallInnerFaceMinPx[side] >= limits.wallInnerFaceMinPx,
    `wall ${side} inner faces are at least ${limits.wallInnerFaceMinPx} px wide ` +
      `(min ${metrics.wallInnerFaceMinPx[side]})`,
  );
  const faces = metrics.wallInnerFaces.filter((entry) => entry.seat === side);
  check(
    faces.every((entry) => entry.normalDotView > 0),
    `every wall ${side} inner face points at the camera`,
  );
  check(
    faces.every((entry) => entry.normalDotInward > 0.6),
    `every wall ${side} inner face points toward the table centre`,
  );
}

// The south hand: straight-on centre, slivers on the outside, no inward lean.
const handRows = metrics.hand.rows;
const centre = handRows.find((entry) => entry.slot === 6);
check(Boolean(centre), 'the south hand has a centre slot 06');
if (centre) {
  check(
    centre.sideSliverPx <= limits.centreSideSliverMaxPx,
    `the centre hand tile is straight-on (inner side ${centre.sideSliverPx} px ` +
      `<= ${limits.centreSideSliverMaxPx})`,
  );
}
for (const slot of [0, 12]) {
  const row = handRows.find((entry) => entry.slot === slot);
  check(Boolean(row), `the south hand has outer slot ${String(slot).padStart(2, '0')}`);
  if (!row) continue;
  check(
    row.sideSliverPx >= limits.outerSideSliverMinPx,
    `hand slot ${slot} shows its inner thickness (${row.sideSliverPx} px ` +
      `>= ${limits.outerSideSliverMinPx})`,
  );
  check(
    row.innerFaceNormal[0] * Math.sign(centre.centreX - row.centreX) > 0.9,
    `hand slot ${slot}'s visible side face points toward the centre`,
  );
}
const leftSlivers = handRows.filter((entry) => entry.slot < 6).map((entry) => entry.sideSliverPx);
const rightSlivers = handRows.filter((entry) => entry.slot > 6).map((entry) => entry.sideSliverPx);
check(
  leftSlivers.every((value, index) => index === 0 || value <= leftSlivers[index - 1] + 1e-6),
  `the left hand's sliver grows outward (${leftSlivers.join(', ')})`,
);
check(
  rightSlivers.every((value, index) => index === 0 || value >= rightSlivers[index - 1] - 1e-6),
  `the right hand's sliver grows outward (${rightSlivers.join(', ')})`,
);
const leans = handRows.flatMap((entry) => [entry.outwardLeanLeftPx, entry.outwardLeanRightPx]);
const minLean = Math.min(...leans);
const maxLean = Math.max(...leans);
check(
  minLean >= -0.25,
  `no south-hand plate edge leans inward (minimum outward lean ${minLean.toFixed(2)} px)`,
);
check(
  maxLean <= limits.maxOutwardLeanPx,
  `the outward lean stays <= ${limits.maxOutwardLeanPx} px (max ${maxLean.toFixed(2)} px)`,
);
check(
  handRows.every((entry) => entry.topWidthPx > 0 && entry.bottomWidthPx > 0),
  'every south-hand plate has a positive width',
);

// Framing: full table width with margin, hand near the bottom, every tile inside.
for (const side of ['left', 'right']) {
  check(
    metrics.rim.marginsPx[side] >= limits.minWidthMarginPx,
    `the table width leaves ${metrics.rim.marginsPx[side]} px of ${side} margin ` +
      `(>= ${limits.minWidthMarginPx})`,
  );
}
check(
  metrics.rim.marginsPx.top >= 0,
  `the far rim is inside the frame (${metrics.rim.marginsPx.top} px)`,
);
check(
  metrics.rim.marginsPx.bottom >= -120,
  `the near rim crop is bounded (${metrics.rim.marginsPx.bottom} px)`,
);
check(
  metrics.hand.bottomMarginPx >= limits.handBottomMarginPx[0] &&
    metrics.hand.bottomMarginPx <= limits.handBottomMarginPx[1],
  `the player's hand sits ${metrics.hand.bottomMarginPx} px above the bottom edge ` +
    `(inside [${limits.handBottomMarginPx}])`,
);
for (const [side, value] of Object.entries(metrics.tileMarginsPx)) {
  check(value >= 0, `every tile is inside the frame (${side} margin ${value} px)`);
}

// --------------------------------------------------------------------------- //
// The committed render
// --------------------------------------------------------------------------- //
const imagePath = join(renderDir, 'reference', rig.output.file);
if (!check(existsSync(imagePath), `the committed render exists (${rig.output.file})`)) process.exit(1);
const image = readPng(imagePath);
const record = manifest.renders;
check(image.width === resolution[0] && image.height === resolution[1],
  `${image.width}x${image.height} is the reference resolution`);
check(image.width === record.width && image.height === record.height, 'the recorded size matches the file');
check(image.channels === 4, `the render is RGBA (${image.channels} channels)`);
checkEqual('channels', record.channels, 4);
checkEqual('bytes', record.bytes, statSync(imagePath).size);
checkEqual(
  'decoded sha256',
  record.sha256,
  createHash('sha256').update(`${image.width}x${image.height}x${image.channels}:`).update(image.data).digest('hex'),
);

const coverage = alphaCoverage(image);
check(coverage.transparentPct >= 5 && coverage.transparentPct <= 60,
  `film transparent leaves ${coverage.transparentPct}% transparent pixels`);
check(coverage.opaquePct >= 30, `the table and tiles are opaque (${coverage.opaquePct}%)`);
checkEqual('corner alphas are 0', manifest.alpha.corners, [0, 0, 0, 0]);
for (const [index, pixel] of [
  [0, 0],
  [image.width - 1, 0],
  [0, image.height - 1],
  [image.width - 1, image.height - 1],
].entries()) {
  checkEqual(`corner ${index} alpha on the file`, alphaAt(image, pixel), 0);
}

// --------------------------------------------------------------------------- //
// Lighting probes
// --------------------------------------------------------------------------- //
const samples = rigLightingSamples(camera, tiles, spec, shellSpec);
const measured = measureRigSamples(image, samples);
for (const [name, sample] of Object.entries(samples)) {
  const recordedSample = manifest.samples?.[name];
  if (!check(Boolean(recordedSample), `manifest records the ${name} probe`)) continue;
  if (sample.kind === 'point') {
    near(recordedSample.pixel[0], sample.pixel[0], 1e-3, `${name} probe x`);
    near(recordedSample.pixel[1], sample.pixel[1], 1e-3, `${name} probe y`);
  } else {
    for (const [index, point] of sample.polygon.entries()) {
      near(recordedSample.polygon[index][0], point[0], 1e-3, `${name} polygon[${index}] x`);
      near(recordedSample.polygon[index][1], point[1], 1e-3, `${name} polygon[${index}] y`);
    }
  }
  const value = measured[name];
  if (!check(Boolean(value), `${name} probe lands on the image`)) continue;
  if (!check(Boolean(recordedSample.measured), `manifest records the measured ${name} probe`)) continue;
  check(value.pixels >= (sample.kind === 'polygon' ? 20 : 1), `${name} probe covers ${value.pixels} px`);
  near(recordedSample.measured.luma, value.luma, 0.11, `${name} measured luma matches the manifest`);
  near(recordedSample.measured.alpha, 255, 0.11, `${name} probe is on opaque geometry`);
}
checkEqual('the mat probe alpha on the file', alphaAt(image, samples.mat.pixel), 255);

const face = measured.face;
const blue = measured.blue;
const handFace = measured.handFace;
const mat = measured.mat;
const sides = [measured.sideLeft, measured.sideRight];
check(
  face.luma >= limits.minFaceLuma,
  `the blank pond face is lit ivory (luma ${face.luma} >= ${limits.minFaceLuma})`,
);
check(
  Math.max(...face.rgb) - Math.min(...face.rgb) <= limits.maxFaceChannelSpread,
  `the ivory face is near-neutral (channel spread ${(Math.max(...face.rgb) - Math.min(...face.rgb)).toFixed(1)})`,
);
check(
  blue.rgb[2] - blue.rgb[0] >= limits.minBlueMinusRed,
  `the face-down wall back reads blue (b-r ${(blue.rgb[2] - blue.rgb[0]).toFixed(1)})`,
);
check(
  handFace.luma >= limits.minHandFaceLuma,
  `the blank hand face is readable (luma ${handFace.luma} >= ${limits.minHandFaceLuma})`,
);
for (const [index, side] of sides.entries()) {
  check(
    side.luma >= limits.minSideFaceLuma,
    `side-wall inner face ${index} is lit (luma ${side.luma} >= ${limits.minSideFaceLuma})`,
  );
  check(
    side.luma - mat.luma >= 25,
    `side-wall inner face ${index} stands off the felt (${side.luma} vs ${mat.luma})`,
  );
}
near(manifest.facts.faceLuma, face.luma, 0.11, 'manifest face luma');
near(manifest.facts.sideFaceLuma.left, measured.sideLeft.luma, 0.11, 'manifest left side luma');
near(manifest.facts.sideFaceLuma.right, measured.sideRight.luma, 0.11, 'manifest right side luma');
near(manifest.facts.matLuma, mat.luma, 0.11, 'manifest felt luma');
near(manifest.alpha.transparentPct, coverage.transparentPct, 0.01, 'manifest transparency');

// --------------------------------------------------------------------------- //
// Summary
// --------------------------------------------------------------------------- //
console.log(
  `[table-rig] ${resolution.join('x')} · ${cameraSpec.lensMm} mm · ` +
    `pitch ${cameraSpec.elevationDeg}° · d ${cameraSpec.distanceUnits} · Shift Y ${cameraSpec.shiftY} · ` +
    `VP (${metrics.vanishingPoint.x.toFixed(0)}, ${metrics.vanishingPoint.y.toFixed(0)}) px`,
);
console.log(
  `[table-rig] side inner faces ${metrics.wallInnerFaceMinPx.left}/${metrics.wallInnerFaceMinPx.right} px · ` +
    `hand sliver ${metrics.hand.rows[0].sideSliverPx}/${metrics.hand.rows[6].sideSliverPx} px · ` +
    `lean ${minLean.toFixed(2)}..${maxLean.toFixed(2)} px · ` +
    `hand bottom ${metrics.hand.bottomMarginPx} px`,
);
console.log(
  `[table-rig] face ${face.luma} · blue ${blue.luma} · hand ${handFace.luma} · ` +
    `sides ${measured.sideLeft.luma}/${measured.sideRight.luma} · felt ${mat.luma} · ` +
    `transparent ${coverage.transparentPct}%`,
);
console.log(`[table-rig] ${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}`);
if (failures > 0) process.exit(1);
