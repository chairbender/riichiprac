#!/usr/bin/env node
/**
 * Integrity + calibration check for the whole-table reference. No Blender.
 *
 *   node tools/render/scripts/check-table-reference.mjs
 *
 * Validates facts, not looks (AGENTS.md 6):
 *
 *   - the spec is self-consistent: the chosen camera is a candidate, the crop
 *     families cover every element family exactly once, and the table plan
 *     cannot let the two-tier wall occlude the near pond row at the chosen
 *     elevation;
 *   - every committed render exists, decodes at the declared dimensions and has
 *     the recorded byte size and decoded-RGB sha256;
 *   - the recorded scene has exactly the required contents (four 17-stack
 *     two-tier walls, four 18-tile ponds, four 13-tile hands plus the human's
 *     drawn tile, one 3-tile open meld per seat), at the required poses;
 *   - every crop rectangle is exactly the projected family bounds plus the
 *     spec's 2x margin, and every tile is inside the @1x frame;
 *   - the projection metrics recomputed from the camera and the placements
 *     match the bake and pass the spec's thresholds;
 *   - the reference lighting reproduces the shipped shells' measured face and
 *     blue-back colours at the recorded sample pixels.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import {
  CROP_PLAN,
  cameraFromCandidate,
  cropRect,
  lineAngleError,
  measureScene,
  projectPoint,
  rimFrameMetrics,
  tileBoxCorners,
} from './table-camera.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = join(renderDir, 'table-reference-spec.json');
const shellSpecPath = join(renderDir, 'shell-spec.json');
const shellsPath = join(renderDir, '..', '..', 'frontend', 'public', 'table', 'shells.json');
const facesPath = join(renderDir, '..', '..', 'frontend', 'public', 'table', 'faces.json');
const referenceDir = join(renderDir, 'reference');

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

const spec = load(specPath, 'table-reference-spec.json');
if (!spec) process.exit(1);

const manifestPath = join(referenceDir, spec.renders.manifest);
const manifest = load(manifestPath, 'table-reference.json');
const shells = load(shellsPath, 'shells.json');
const faces = load(facesPath, 'faces.json');
const shellSpec = load(shellSpecPath, 'shell-spec.json');
if (!manifest || !shells || !faces || !shellSpec) process.exit(1);

const resolution1x = spec.camera.output.resolution1x;
const resolution2x = spec.camera.output.resolution2x;
const chosen = spec.camera.chosen;
const candidate = spec.camera.candidates[chosen];

// --------------------------------------------------------------------------- //
// Spec
// --------------------------------------------------------------------------- //
check(Boolean(candidate), `camera.chosen "${chosen}" is a candidate`);
check(
  spec.renders.cropFamilies.length === Object.keys(CROP_PLAN).length,
  `cropFamilies lists ${Object.keys(CROP_PLAN).length} families`,
);
const familyIds = new Set(spec.renders.cropFamilies.map((entry) => entry.id));
for (const id of Object.keys(CROP_PLAN)) check(familyIds.has(id), `spec lists crop family ${id}`);
check(resolution2x[0] === resolution1x[0] * 2 && resolution2x[1] === resolution1x[1] * 2,
  '@2x master is exactly twice the @1x board');

const proportions = shellSpec.tile.proportionsMm;
const thicknessUnits = proportions.thickness / proportions.height;
const wallHeight = spec.table.wall.tiers * thicknessUnits;
const pondOuter = Math.max(...spec.table.pond.rowRadiiUnits) + shellSpec.tile.heightUnits / 2;
const wallInner = spec.table.wall.radiusUnits - spec.table.wall.tileDepthUnits / 2;
check(pondOuter < wallInner,
  `pond outer edge ${pondOuter} is inside the wall inner edge ${wallInner}`);
const clearance = wallInner - pondOuter;
const requiredTangent = Math.tan((candidate.elevationDeg * Math.PI) / 180);
check(requiredTangent * clearance > wallHeight,
  `elevation ${candidate.elevationDeg} deg clears the wall over the near pond ` +
    `(tan ${requiredTangent.toFixed(3)} * ${clearance.toFixed(3)} > ${wallHeight.toFixed(3)})`);

// --------------------------------------------------------------------------- //
// Camera
// --------------------------------------------------------------------------- //
const camera2x = cameraFromCandidate(candidate, resolution2x);
const camera1x = cameraFromCandidate(candidate, resolution1x);
const recorded = manifest.camera;
check(recorded.mode === camera2x.mode, 'manifest camera mode matches the spec');
for (const axis of [0, 1, 2]) {
  near(recorded.eye[axis], camera2x.eye[axis], 1e-6, `camera eye[${axis}]`);
  near(recorded.target[axis], camera2x.target[axis], 1e-6, `camera target[${axis}]`);
}
if (camera2x.mode === 'perspective') {
  near(recorded.lensMm, camera2x.lensMm, 1e-9, 'camera lens');
  near(recorded.focalPixels, camera2x.focalPixels, 1e-6, 'camera focal pixels');
}
near(recorded.distanceUnits, camera2x.distanceUnits, 1e-6, 'camera distance');
near(recorded.elevationDeg, candidate.elevationDeg, 1e-9, 'camera elevation');
check(manifest.cameraCandidate === chosen, 'manifest names the committed camera candidate');
check(Array.isArray(manifest.resolution1x) && manifest.resolution1x[0] === resolution1x[0],
  'manifest records the @1x resolution');
check(manifest.projectionDeltaPx >= 0 && manifest.projectionDeltaPx <= 0.01,
  `pinhole matches Blender (${manifest.projectionDeltaPx} px)`);

// --------------------------------------------------------------------------- //
// Scene contents
// --------------------------------------------------------------------------- //
const tiles = manifest.scene?.tiles;
if (!check(Array.isArray(tiles), 'manifest has the tile placements')) process.exit(1);
const ids = new Set();
for (const tile of tiles) {
  check(!ids.has(tile.id), `duplicate tile id ${tile.id}`);
  ids.add(tile.id);
}

const groups = (kind) => tiles.filter((tile) => tile.kind === kind);
const seatOf = (seat) => (tile) => tile.seat === seat;
const walls = groups('wall');
const ponds = groups('pond');
const hands = groups('hand');
const melds = groups('meld');
const drawn = groups('drawn');
check(walls.length === 4 * 17 * 2, `wall tiles: ${walls.length} (expected 136)`);
check(ponds.length === 4 * 18, `pond tiles: ${ponds.length} (expected 72)`);
check(hands.length === 4 * 13, `hand tiles: ${hands.length} (expected 52)`);
check(melds.length === 4 * 3, `meld tiles: ${melds.length} (expected 12)`);
check(drawn.length === 1, `drawn tiles: ${drawn.length} (expected 1)`);
check(tiles.length === 136 + 72 + 52 + 12 + 1, `total tiles: ${tiles.length} (expected 273)`);

const faceSet = new Set(Object.keys(faces.faces));
for (const seat of ['bottom', 'right', 'top', 'left']) {
  const seatWalls = walls.filter(seatOf(seat));
  check(seatWalls.length === 34, `wall ${seat}: 34 tiles`);
  for (const tier of [0, 1]) {
    check(seatWalls.filter((tile) => tile.cell.tier === tier).length === 17,
      `wall ${seat} tier ${tier}: 17 stacks`);
  }
  check(seatWalls.every((tile) => tile.pose === 'lying-facedown' && tile.face === null),
    `wall ${seat}: every tile face-down and bare`);
  check(new Set(seatWalls.map((tile) => tile.cell.slot)).size === 17,
    `wall ${seat}: 17 distinct slots`);

  const seatPond = ponds.filter(seatOf(seat));
  check(seatPond.length === 18, `pond ${seat}: 18 discards`);
  check(
    new Set(seatPond.map((tile) => `${tile.cell.row}:${tile.cell.column}`)).size === 18,
    `pond ${seat}: 18 distinct cells`,
  );
  check(seatPond.every((tile) => tile.pose === 'lying-faceup' && faceSet.has(tile.face)),
    `pond ${seat}: every discard face-up with a real glyph`);

  const seatHand = hands.filter(seatOf(seat));
  check(seatHand.length === 13, `hand ${seat}: 13 concealed tiles`);
  check(new Set(seatHand.map((tile) => tile.cell.slot)).size === 13,
    `hand ${seat}: 13 distinct slots`);
  const expectedPose = seat === 'bottom' ? 'standing' : 'standing-back';
  check(seatHand.every((tile) => tile.pose === expectedPose),
    `hand ${seat}: pose ${expectedPose}`);
  check(
    seatHand.every((tile) => (seat === 'bottom' ? faceSet.has(tile.face) : tile.face === null)),
    `hand ${seat}: face state`,
  );

  const seatMelds = melds.filter(seatOf(seat));
  check(seatMelds.length === 3, `meld ${seat}: 3 tiles`);
  check(seatMelds.every((tile) => tile.pose === 'lying-faceup' && faceSet.has(tile.face)),
    `meld ${seat}: face-up with real glyphs`);
  check(seatMelds.filter((tile) => tile.cell.turned).length === 1,
    `meld ${seat}: exactly one called tile lies sideways`);
}
check(drawn[0].pose === 'standing' && faceSet.has(drawn[0].face),
  'drawn tile stands face-up with a real glyph');
check(manifest.visibility?.occluded === 0,
  `visibility: 0 of ${manifest.visibility?.samples} probes occluded`);
check(manifest.lightingSamples?.face?.tile === spec.faces.sampleTileId,
  `sample tile is ${spec.faces.sampleTileId}`);

// --------------------------------------------------------------------------- //
// Slot anchors, spacing and the table surface
// --------------------------------------------------------------------------- //
const anchorSummary = manifest.slotAnchors;
if (!check(Boolean(anchorSummary), 'manifest publishes the slot-anchor summary')) {
  process.exit(1);
}
const anchorPath = join(referenceDir, anchorSummary.file);
if (!check(existsSync(anchorPath), `slot anchors exist at ${anchorSummary.file}`)) {
  process.exit(1);
}
const anchorBytes = readFileSync(anchorPath);
checkEqual('slot anchor bytes', anchorSummary.bytes, statSync(anchorPath).size);
checkEqual(
  'slot anchor sha256',
  anchorSummary.sha256,
  createHash('sha256').update(anchorBytes).digest('hex'),
);
const anchorDoc = JSON.parse(anchorBytes.toString('utf8'));
checkEqual('slot anchor collection', anchorDoc.collection, spec.anchors.collection);
checkEqual('slot anchor total', anchorDoc.total, spec.anchors.counts.total);
checkEqual('slot anchor occupied', anchorDoc.occupied, 273);
for (const [zone, expected] of Object.entries({ wall: 136, river: 88, meld: 16, hand: 53 })) {
  checkEqual(`slot anchor ${zone} count`, anchorDoc.counts[zone], expected);
}
const anchorNames = new Set();
const anchorZones = { wall: 0, river: 0, meld: 0, hand: 0 };
const anchorOccupied = { wall: 0, river: 0, meld: 0, hand: 0 };
const patterns = {
  wall: /^wall_(south|east|north|west)_\d{2}_[01]$/,
  river: /^river_(south|east|north|west)_[0-2]_\d{1,2}$/,
  meld: /^meld_(south|east|north|west)_[0-3]$/,
  hand: /^hand_(south|east|north|west)_\d{2}$/,
};
const halfPlateX = manifest.scene.dimensions.width / 2 - shellSpec.tile.faceInset;
const halfPlateY = manifest.scene.dimensions.height / 2 - shellSpec.tile.faceInset;
const halfPlateZ = manifest.scene.dimensions.thickness / 2;
const plateLocal = [
  -halfPlateX, halfPlateY, halfPlateZ,
  halfPlateX, halfPlateY, halfPlateZ,
  halfPlateX, -halfPlateY, halfPlateZ,
  -halfPlateX, -halfPlateY, halfPlateZ,
];
for (const anchor of anchorDoc.anchors) {
  check(!anchorNames.has(anchor.name), `duplicate anchor name ${anchor.name}`);
  anchorNames.add(anchor.name);
  check(Boolean(patterns[anchor.zone]), `anchor ${anchor.name} has a known zone`);
  check(patterns[anchor.zone]?.test(anchor.name) === true,
    `anchor ${anchor.name} matches the naming scheme`);
  anchorZones[anchor.zone] += 1;
  checkEqual(`anchor ${anchor.name} quad order`, anchor.faceQuadOrder, 'TL,TR,BR,BL');
  checkEqual(`anchor ${anchor.name} local quad length`, anchor.faceQuadLocal.length, 12);
  for (let index = 0; index < 12; index += 1) {
    near(anchor.faceQuadLocal[index], plateLocal[index], 1e-6,
      `anchor ${anchor.name} faceQuadLocal[${index}]`);
  }
  for (let corner = 0; corner < 4; corner += 1) {
    for (const axis of [0, 1, 2]) {
      const world = [0, 1, 2].reduce(
        (sum, other) => sum + anchor.rotation[axis * 3 + other] * anchor.faceQuadLocal[corner * 3 + other],
        anchor.origin[axis],
      );
      near(world, anchor.faceQuadWorld[corner * 3 + axis], 1e-5,
        `anchor ${anchor.name} faceQuadWorld[${corner}][${axis}]`);
    }
  }
  if (anchor.occupied) {
    anchorOccupied[anchor.zone] += 1;
    const tile = tiles.find((entry) => entry.id === anchor.tileId);
    if (!check(Boolean(tile), `anchor ${anchor.name} tile ${anchor.tileId} exists`)) continue;
    checkEqual(`anchor ${anchor.name} tile face`, anchor.tileFace, tile.face);
    for (const axis of [0, 1, 2]) {
      near(anchor.rotation[axis], tile.rotation[axis], 1e-6, `anchor ${anchor.name} rotation`);
      const centre = tile.origin[axis] +
        tile.rotation[axis * 3 + 2] * (tile.dimensions.thickness / 2);
      near(anchor.origin[axis], centre, 1e-5, `anchor ${anchor.name} centre axis ${axis}`);
    }
  } else {
    checkEqual(`anchor ${anchor.name} empty tileId`, anchor.tileId, null);
    checkEqual(`anchor ${anchor.name} empty face`, anchor.tileFace, null);
  }
}
for (const zone of Object.keys(anchorZones)) {
  checkEqual(`anchor zone total ${zone}`, anchorZones[zone], anchorDoc.counts[zone]);
}
checkEqual('anchor occupied totals', JSON.stringify(anchorOccupied),
  JSON.stringify({ wall: 136, river: 72, meld: 12, hand: 53 }));
checkEqual('empty anchor count', anchorDoc.total - anchorDoc.occupied, 20);

const aabbOf = (tile) => {
  const corners = tileBoxCorners(tile);
  return {
    minimum: [0, 1, 2].map((axis) => Math.min(...corners.map((corner) => corner[axis]))),
    maximum: [0, 1, 2].map((axis) => Math.max(...corners.map((corner) => corner[axis]))),
  };
};
const aabbGap = (left, right) => Math.hypot(
  ...[0, 1, 2].map((axis) =>
    Math.max(0, left.minimum[axis] - right.maximum[axis],
      right.minimum[axis] - left.maximum[axis]),
  ),
);
const aabbOverlap = (left, right) => [0, 1, 2].every(
  (axis) =>
    left.minimum[axis] < right.maximum[axis] - 1e-7 &&
    right.minimum[axis] < left.maximum[axis] - 1e-7,
);
const boxes = new Map(tiles.map((tile) => [tile.id, aabbOf(tile)]));
const adjacent = [];
const pushAdjacent = (group, key) => {
  const ordered = [...group].sort((a, b) => key(a) - key(b));
  for (let index = 0; index + 1 < ordered.length; index += 1) {
    adjacent.push([ordered[index].id, ordered[index + 1].id]);
  }
};
for (const seat of ['bottom', 'right', 'top', 'left']) {
  for (const tier of [0, 1]) {
    pushAdjacent(walls.filter((tile) => tile.seat === seat && tile.cell.tier === tier),
      (tile) => tile.cell.slot);
  }
  for (let slot = 0; slot < 17; slot += 1) {
    adjacent.push([
      `wall-${seat}-slot-${String(slot).padStart(2, '0')}-t0`,
      `wall-${seat}-slot-${String(slot).padStart(2, '0')}-t1`,
    ]);
  }
  for (let row = 0; row < 3; row += 1) {
    pushAdjacent(ponds.filter((tile) => tile.seat === seat && tile.cell.row === row),
      (tile) => tile.cell.column);
  }
  for (let column = 0; column < 6; column += 1) {
    pushAdjacent(ponds.filter((tile) => tile.seat === seat && tile.cell.column === column),
      (tile) => tile.cell.row);
  }
  pushAdjacent(hands.filter((tile) => tile.seat === seat), (tile) => tile.cell.slot);
  pushAdjacent(melds.filter((tile) => tile.seat === seat), (tile) => tile.cell.column);
}
const gaps = adjacent.map(([left, right]) => aabbGap(boxes.get(left), boxes.get(right)));
const minGap = Math.min(...gaps) * 28;
const maxGap = Math.max(...gaps) * 28;
checkEqual('adjacent clearance pairs', gaps.length, 360);
check(minGap >= 0.2 - 1e-4 && maxGap <= 0.5 + 1e-4,
  `adjacent clearance ${minGap.toFixed(4)}..${maxGap.toFixed(4)} mm inside 0.2..0.5`);
near(manifest.clearance.minGapMm, minGap, 1e-3, 'manifest minimum clearance');
near(manifest.clearance.maxGapMm, maxGap, 1e-3, 'manifest maximum clearance');
let intersections = 0;
const tileIds = [...boxes.keys()];
for (let left = 0; left < tileIds.length; left += 1) {
  for (let right = left + 1; right < tileIds.length; right += 1) {
    if (aabbOverlap(boxes.get(tileIds[left]), boxes.get(tileIds[right]))) intersections += 1;
  }
}
checkEqual('tile body intersections', intersections, 0);
checkEqual('manifest clearance target', manifest.clearance.targetMm, 0.3);

// Table surface: 700 mm mat, raised rim, recessed compass well.
checkEqual('playing mat size', spec.table.playingMat.sizeUnits * 28, spec.table.playingMat.sizeMm);
check(spec.table.playingMat.sizeUnits === 25, 'playing mat is 700 mm square');
checkEqual('rim outer half', spec.table.rim.outerHalfUnits,
  spec.table.rim.innerHalfUnits + spec.table.rim.widthUnits);
check(spec.table.compassWell.plateZUnits < 0, 'compass plate is recessed below the mat');
for (const key of ['left', 'top', 'right', 'bottom']) {
  near(rimFrameMetrics(camera1x, spec).marginsPx[key],
    manifest.metrics.rimFrame.marginsPx[key], 1e-3, `rim frame margin ${key}`);
}
check(Math.min(...Object.values(rimFrameMetrics(camera1x, spec).marginsPx)) >= 0,
  'the complete mat and rim are inside the @1x frame');

// --------------------------------------------------------------------------- //
// Renders
// --------------------------------------------------------------------------- //
const hashOf = (image) =>
  createHash('sha256')
    .update(`${image.width}x${image.height}x${image.channels}:`)
    .update(image.data)
    .digest('hex');

const verifyRender = (record, path, label) => {
  if (!check(existsSync(path), `${label} exists`)) return null;
  const file = statSync(path);
  const image = readPng(path);
  check(image.width === record.width && image.height === record.height,
    `${label}: ${image.width}x${image.height} matches ${record.width}x${record.height}`);
  check(file.size === record.bytes, `${label}: ${file.size} B matches ${record.bytes} B`);
  check(hashOf(image) === record.sha256, `${label}: decoded hash matches the manifest`);
  check(image.channels === 3, `${label}: 8-bit RGB`);
  return image;
};

const board = verifyRender(
  manifest.renders.fullBoard1x,
  join(referenceDir, manifest.renders.fullBoard1x.file),
  'full-board-1x',
);
check(manifest.renders.fullBoard1x.width === resolution1x[0] &&
  manifest.renders.fullBoard1x.height === resolution1x[1],
  '@1x full board has the declared resolution');
check(manifest.renders.fullBoard1x.scale === 1, '@1x full board is the 1x scale');

const margin = spec.renders.cropMarginPx2x;
const cropRecords = manifest.renders.crops2x;
check(Object.keys(cropRecords).length === Object.keys(CROP_PLAN).length,
  `manifest has ${Object.keys(CROP_PLAN).length} family crops`);
for (const [name, [kind, seat]] of Object.entries(CROP_PLAN)) {
  const record = cropRecords[name];
  if (!check(Boolean(record), `crop ${name} exists in the manifest`)) continue;
  const expectedIds = tiles
    .filter((tile) => (kind === 'drawn' ? tile.kind === 'drawn' : tile.kind === kind && tile.seat === seat))
    .map((tile) => tile.id);
  check(
    record.tiles.length === expectedIds.length &&
      record.tiles.every((id, index) => id === expectedIds[index]),
    `crop ${name} lists its ${expectedIds.length} family tiles`,
  );
  const planned = cropRect(camera2x, tiles, expectedIds, margin);
  check(record.rect2x.x === planned.x && record.rect2x.y === planned.y,
    `crop ${name} rect origin`);
  check(record.rect2x.width === planned.width && record.rect2x.height === planned.height,
    `crop ${name} rect size`);
  check(record.width === planned.width && record.height === planned.height,
    `crop ${name} image is the planned rect`);
  check(record.rect2x.x >= 0 && record.rect2x.y >= 0 &&
    record.rect2x.x + record.rect2x.width <= resolution2x[0] &&
    record.rect2x.y + record.rect2x.height <= resolution2x[1],
    `crop ${name} is inside the master frame`);
  verifyRender(record, join(referenceDir, record.file), `crop ${name}`);
}

// --------------------------------------------------------------------------- //
// Projection metrics
// --------------------------------------------------------------------------- //
const metrics = measureScene(camera1x, tiles, spec);
const recordedMetrics = manifest.metrics;
const compareMetric = (label, actual, expected) =>
  near(actual, expected, 1e-3, `metric ${label}`);
compareMetric('scaleSpread', recordedMetrics.scaleSpread, metrics.scaleSpread);
compareMetric('frontBackRunRatio', recordedMetrics.frontBackRunRatio, metrics.frontBackRunRatio);
compareMetric('leftRightRunRatio', recordedMetrics.leftRightRunRatio, metrics.leftRightRunRatio);
compareMetric('bottomTopHandRatio', recordedMetrics.bottomTopHandRatio, metrics.bottomTopHandRatio);
compareMetric('frontOuterRevealDeg', recordedMetrics.frontOuterRevealDeg, metrics.frontOuterRevealDeg);
compareMetric('minFrameMarginPx', recordedMetrics.minFrameMarginPx, metrics.minFrameMarginPx);
for (const [index, value] of metrics.pondTileSizePx.entries()) {
  compareMetric(`pondTileSizePx[${index}]`, recordedMetrics.pondTileSizePx[index], value);
}
for (const key of ['front', 'back', 'left', 'right']) {
  compareMetric(`runAngleErrorDeg.${key}`, recordedMetrics.runAngleErrorDeg[key], metrics.runAngleErrorDeg[key]);
  near(
    metrics.runAngleErrorDeg[key],
    lineAngleError(metrics.runAnglesDeg[key], key === 'front' || key === 'back' ? 0 : 90),
    1e-6,
    `run angle error ${key} derivation`,
  );
}

for (const key of ['left', 'top', 'right', 'bottom']) {
  near(metrics.rimFrame.marginsPx[key], manifest.metrics.rimFrame.marginsPx[key], 1e-3,
    `rim frame margin ${key}`);
}

const limits = spec.camera.checks;
check(metrics.scaleSpread <= limits.maxScaleSpread,
  `scaleSpot ${metrics.scaleSpread} <= ${limits.maxScaleSpread}`);
check(metrics.frontBackRunRatio <= limits.maxRunLengthRatio,
  `front/back run ratio ${metrics.frontBackRunRatio} <= ${limits.maxRunLengthRatio}`);
check(metrics.leftRightRunRatio <= limits.maxRunLengthRatio,
  `left/right run ratio ${metrics.leftRightRunRatio} <= ${limits.maxRunLengthRatio}`);
for (const key of ['front', 'back', 'left', 'right']) {
  check(metrics.runAngleErrorDeg[key] <= limits.maxRunAngleErrorDeg,
    `run ${key} angle error ${metrics.runAngleErrorDeg[key]} deg`);
}
for (const size of metrics.pondTileSizePx) {
  check(size >= limits.tileSizePx1x.min && size <= limits.tileSizePx1x.max,
    `pond tile size ${size} px in [${limits.tileSizePx1x.min}, ${limits.tileSizePx1x.max}]`);
}
check(metrics.minFrameMarginPx >= limits.minFrameMarginPx1x,
  `frame margin ${metrics.minFrameMarginPx} >= ${limits.minFrameMarginPx1x} px`);
const bounds = metrics.tableBoundsPx;
check(
  bounds.left >= 0 && bounds.top >= 0 &&
    bounds.right <= resolution1x[0] && bounds.bottom <= resolution1x[1],
  'every tile is inside the @1x frame',
);

// --------------------------------------------------------------------------- //
// Lighting against the shipped shells
// --------------------------------------------------------------------------- //
const sampleMean = (image, x, y, radius) => {
  let totals = [0, 0, 0];
  let count = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const px = Math.round(x) + dx;
      const py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) continue;
      const offset = (py * image.width + px) * image.channels;
      for (let channel = 0; channel < 3; channel += 1) {
        totals[channel] += image.data[offset + channel];
      }
      count += 1;
    }
  }
  return totals.map((value) => value / count);
};
const luma = (rgb) => rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;

if (board) {
  for (const name of ['face', 'blue']) {
    const sample = manifest.lightingSamples?.[name];
    if (!check(Boolean(sample), `lighting sample ${name} exists`)) continue;
    const tile = tiles.find((entry) => entry.id === sample.tile);
    if (!check(Boolean(tile), `lighting sample ${name} tile ${sample.tile} exists`)) continue;
    const rotation = tile.rotation;
    const local = sample.localPoint;
    const point = [
      rotation[0] * local[0] + rotation[1] * local[1] + rotation[2] * local[2] + tile.origin[0],
      rotation[3] * local[0] + rotation[4] * local[1] + rotation[5] * local[2] + tile.origin[1],
      rotation[6] * local[0] + rotation[7] * local[1] + rotation[8] * local[2] + tile.origin[2],
    ];
    const [u, v] = projectPoint(camera1x, point);
    near(u, sample.pixel1x[0], 0.5, `lighting sample ${name} x`);
    near(v, sample.pixel1x[1], 0.5, `lighting sample ${name} y`);
    const observed = sampleMean(board, u, v, sample.sampleRadiusPx1x);
    const shell = shells.shells[sample.shell];
    check(Boolean(shell), `shell ${sample.shell} exists`);
    if (!shell) continue;
    const target = shell.measured.faceSampleRgb;
    const channelTolerance =
      name === 'face' ? limits.sampleFaceChannelTolerance : limits.sampleBlueChannelTolerance;
    const lumaTolerance =
      name === 'face' ? limits.sampleFaceLumaTolerance : limits.sampleBlueChannelTolerance;
    check(
      observed.every((value, index) => Math.abs(value - target[index]) <= channelTolerance),
      `lighting ${name} rgb [${observed.map((value) => value.toFixed(0)).join(', ')}] ` +
        `within ${channelTolerance} of the ${sample.shell} [${target.join(', ')}]`,
    );
    check(
      Math.abs(luma(observed) - luma(target)) <= lumaTolerance,
      `lighting ${name} luma ${luma(observed).toFixed(1)} within ${lumaTolerance} of ${luma(target).toFixed(1)}`,
    );
  }
}

// --------------------------------------------------------------------------- //
// Summary
// --------------------------------------------------------------------------- //
console.log(
  `[table-reference] camera ${chosen} ${candidate.elevationDeg} deg · ` +
    `scaleSpread ${metrics.scaleSpread} · run ratio ${metrics.frontBackRunRatio} · ` +
    `pond tile ${metrics.pondTileSizePx.map((v) => v.toFixed(1)).join('/')} px · ` +
    `margin ${metrics.minFrameMarginPx} px`,
);
console.log(
  `[table-reference] ${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}`,
);
if (failures > 0) process.exit(1);
