#!/usr/bin/env node
/**
 * Acceptance gate for the Task 3 runtime table layout. No Blender.
 *
 *   node tools/render/scripts/check-table-layout.mjs
 *
 * Validates facts, not looks (AGENTS.md 6):
 *
 *   - the spec contract: the layout block names the SlotAnchors collection, the
 *     rig's 1920 x 1080 reference frame, a reference slot and explicit,
 *     ascending bucket boundaries with one name per interval;
 *   - the committed layout is the default variant's and its camera is exactly
 *     the committed rig variant's camera (eye, target, lens, shift, resolution);
 *   - every SlotAnchors id is present exactly once, sorted, with the name-derived
 *     zone/seat/row/col and no duplicate; the four zone counts match the anchor
 *     reference;
 *   - every slot: in-frame normalized anchor, positive depth, scale equal to
 *     reference.depth / depth (with the reference slot at 1.0), a bucket that
 *     matches a recomputation from the spec boundaries and the projected face
 *     quad's own sideways test, and a convex, positive-area face quad in the
 *     published TL, TR, BR, BL order whose corners stay in frame;
 *   - every bucket name the spec declares is used (Task 4 bakes exactly one
 *     blank per name), and the catalogue's counts, representatives and families
 *     agree with the slots;
 *   - the 1 px claim is re-measured from the committed probe render without
 *     Blender: one alpha-weighted marker centroid per slot, one-to-one match,
 *     every delta within the spec's threshold, and the committed proof record
 *     reproduces those numbers;
 *   - the committed overlay is 1920 x 1080 RGBA and marks every exported anchor.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import {
  bucketFor,
  declaredBuckets,
  familyFor,
  matchProbes,
  measureProbes,
} from './table-layout.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(renderDir, '..', '..');

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
const near = (label, left, right, tolerance) =>
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

// Small vector helpers for the Task 3A basis/lighting checks.
const vec3 = (value) =>
  Array.isArray(value) && value.length === 3 && value.every((item) => Number.isFinite(item));
const length3 = (value) => Math.hypot(value[0], value[1], value[2]);
const dot3 = (left, right) =>
  left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
const cross3 = (left, right) => [
  left[1] * right[2] - left[2] * right[1],
  left[2] * right[0] - left[0] * right[2],
  left[0] * right[1] - left[1] * right[0],
];
const add3 = (left, right) => [
  left[0] + right[0],
  left[1] + right[1],
  left[2] + right[2],
];
const sub3 = (left, right) => [
  left[0] - right[0],
  left[1] - right[1],
  left[2] - right[2],
];
const scale3 = (value, factor) => [value[0] * factor, value[1] * factor, value[2] * factor];
const normalise3 = (value) => scale3(value, 1 / length3(value));
const srgbToLinear = (value) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const hexLinear = (hex) => {
  const body = hex.replace('#', '');
  return [0, 2, 4].map((offset) =>
    srgbToLinear(Number.parseInt(body.slice(offset, offset + 2), 16) / 255),
  );
};

const spec = load(join(renderDir, 'table-reference-spec.json'), 'table-reference-spec.json');
const shellSpec = load(join(renderDir, 'shell-spec.json'), 'shell-spec.json');
const anchorsDoc = load(join(renderDir, 'reference', 'slot-anchors.json'), 'slot-anchors.json');
if (!spec || !shellSpec || !anchorsDoc) process.exit(1);
const layoutSpec = spec.layout;
if (!check(Boolean(layoutSpec), 'spec publishes the layout block')) process.exit(1);

const layoutPath = join(root, layoutSpec.output);
const layout = load(layoutPath, 'table_layout.json');
if (!layout) process.exit(1);
const [width, height] = [layoutSpec.referenceResolution[0], layoutSpec.referenceResolution[1]];
const proofSpec = layoutSpec.proof;

// --------------------------------------------------------------------------- //
// Spec contract
// --------------------------------------------------------------------------- //
checkEqual('layout.collection is the anchor collection', layoutSpec.collection, spec.anchors.collection);
checkEqual('layout reference resolution', [width, height], [1920, 1080]);
checkEqual('layout output is the runtime table', layoutSpec.output, 'frontend/public/table/table_layout.json');
const familyIds = new Set();
const declaredNames = new Set();
for (const family of layoutSpec.buckets) {
  check(!familyIds.has(family.id), `duplicate bucket family ${family.id}`);
  familyIds.add(family.id);
  check(Array.isArray(family.zones) && family.zones.length > 0, `family ${family.id} has zones`);
  check(['x', 'y'].includes(family.representativeAxis ?? 'x'), `${family.id} representativeAxis`);
  if (family.seats && !Array.isArray(family.seats)) {
    for (const [seat, name] of Object.entries(family.seats)) {
      check(Boolean(seat), `${family.id} seat has a name`);
      check(!declaredNames.has(name), `duplicate bucket name ${name}`);
      declaredNames.add(name);
    }
    continue;
  }
  const boundaries = family.boundaries;
  const names = family.names;
  check(Array.isArray(boundaries) && Array.isArray(names), `${family.id} has boundaries and names`);
  if (!check(names.length === boundaries.length + 1, `${family.id} names match intervals`)) continue;
  for (let index = 1; index < boundaries.length; index += 1) {
    check(boundaries[index] > boundaries[index - 1], `${family.id} boundaries ascend at ${index}`);
  }
  for (const boundary of boundaries) {
    check(boundary > 0 && boundary < 1, `${family.id} boundary ${boundary} is normalized`);
  }
  for (const name of names) {
    check(!declaredNames.has(name), `duplicate bucket name ${name}`);
    declaredNames.add(name);
    if (family.rotatedSuffix) {
      check(
        !declaredNames.has(name + family.rotatedSuffix),
        `duplicate rotated bucket name ${name + family.rotatedSuffix}`,
      );
      declaredNames.add(name + family.rotatedSuffix);
    }
  }
}

// --------------------------------------------------------------------------- //
// Layout header
// --------------------------------------------------------------------------- //
checkEqual('layout version', layout.version, 1);
checkEqual('layout generator', layout.generatedBy, 'tools/render/bake_table_layout.py');
checkEqual('layout rig', layout.rig, layoutSpec.rigId);
checkEqual('layout is the default variant', layout.variant, spec.rig.defaultVariant);
checkEqual('layout reference width', layout.referenceResolution.width, width);
checkEqual('layout reference height', layout.referenceResolution.height, height);
check(
  Number.isFinite(layout.projectionDeltaPx) && layout.projectionDeltaPx <= 0.05,
  `layout projection delta ${layout.projectionDeltaPx} px is within 0.05`,
);

const rigManifest = load(
  join(renderDir, 'reference', spec.rig.output.directory, spec.rig.output.manifestPattern.replace('{variant}', layout.variant)),
  `${layout.variant}.json`,
);
if (rigManifest) {
  const expected = rigManifest.camera;
  for (const key of ['mode', 'sensorFit']) {
    checkEqual(`layout camera.${key} vs rig`, layout.camera[key], expected[key]);
  }
  for (const key of ['lensMm', 'sensorWidthMm', 'shiftX', 'shiftY', 'elevationDeg', 'distanceUnits']) {
    near(`layout camera.${key} vs rig`, layout.camera[key], expected[key], 1e-5);
  }
  for (let axis = 0; axis < 3; axis += 1) {
    near(`layout camera.eye[${axis}]`, layout.camera.eye[axis], expected.eye[axis], 1e-5);
    near(`layout camera.target[${axis}]`, layout.camera.target[axis], expected.target[axis], 1e-5);
  }
  checkEqual('layout camera resolution', layout.camera.resolution, [width, height]);
  checkEqual('layout resolution is the rig resolution', [width, height], rigManifest.resolution);
}

// --------------------------------------------------------------------------- //
// Slots
// --------------------------------------------------------------------------- //
const patterns = {
  wall: /^wall_(south|east|north|west)_(\d{2})_([01])$/,
  river: /^river_(south|east|north|west)_([0-2])_(\d{1,2})$/,
  meld: /^meld_(south|east|north|west)_([0-3])$/,
  hand: /^hand_(south|east|north|west)_(\d{2})$/,
};
const zoneCounts = { wall: 0, river: 0, meld: 0, hand: 0 };
const seatCounts = {};
const ids = new Set();
const usedBuckets = new Map();
const rounding = 10 ** (layoutSpec.rounding ?? 6);
const isRounded = (value) =>
  Number.isFinite(value) && Math.abs(value * rounding - Math.round(value * rounding)) < 1e-4;
let previousId = '';
let faceAreaMinPx = Infinity;
let faceAreaMaxPx = -Infinity;
for (const slot of layout.slots) {
  const label = slot.id;
  check(!ids.has(label), `duplicate slot id ${label}`);
  ids.add(label);
  check(label > previousId, `slots sorted: ${label} after ${previousId || '(start)'}`);
  previousId = label;
  for (const key of ['id', 'zone', 'seat', 'row', 'col', 'anchor', 'depth', 'bucket', 'faceQuad', 'scale']) {
    check(key in slot, `${label} publishes ${key}`);
  }
  const zone = slot.zone;
  check(zone in patterns, `${label} has a known zone`);
  const match = patterns[zone]?.exec(label);
  if (!check(Boolean(match), `${label} matches the ${zone} naming scheme`)) continue;
  checkEqual(`${label} seat`, slot.seat, match[1]);
  if (zone === 'wall') {
    checkEqual(`${label} col`, slot.col, Number(match[2]));
    checkEqual(`${label} row`, slot.row, Number(match[3]));
  } else if (zone === 'river') {
    checkEqual(`${label} row`, slot.row, Number(match[2]));
    checkEqual(`${label} col`, slot.col, Number(match[3]));
  } else {
    checkEqual(`${label} row`, slot.row, 0);
    checkEqual(`${label} col`, slot.col, Number(match[2]));
  }
  zoneCounts[zone] += 1;
  const seatKey = `${zone}/${slot.seat}`;
  seatCounts[seatKey] = (seatCounts[seatKey] ?? 0) + 1;

  check(isRounded(slot.anchor.x) && isRounded(slot.anchor.y), `${label} anchor is rounded`);
  check(slot.anchor.x > 0 && slot.anchor.x < 1, `${label} anchor x in frame`);
  check(slot.anchor.y > 0 && slot.anchor.y < 1, `${label} anchor y in frame`);
  check(Number.isFinite(slot.depth) && slot.depth > 0, `${label} depth is positive`);
  check(isRounded(slot.depth) && isRounded(slot.scale), `${label} depth/scale are rounded`);
  near(
    `${label} scale`,
    slot.scale,
    layout.reference.depth / slot.depth,
    3e-6,
  );
  check(slot.scale > 0, `${label} scale is positive`);

  if (!check(Array.isArray(slot.faceQuad) && slot.faceQuad.length === 4, `${label} faceQuad has 4 corners`)) {
    continue;
  }
  const quad = slot.faceQuad;
  for (const corner of quad) {
    check(
      isRounded(corner.x) && isRounded(corner.y),
      `${label} faceQuad corner is rounded`,
    );
    const x = slot.anchor.x + corner.x;
    const y = slot.anchor.y + corner.y;
    check(x >= 0 && x <= 1 && y >= 0 && y <= 1, `${label} faceQuad corner stays in frame`);
  }
  let area = 0;
  let convex = true;
  let crossSign = 0;
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    area += quad[index].x * quad[next].y - quad[next].x * quad[index].y;
    const after = (index + 2) % 4;
    const ax = quad[next].x - quad[index].x;
    const ay = quad[next].y - quad[index].y;
    const bx = quad[after].x - quad[next].x;
    const by = quad[after].y - quad[next].y;
    const cross = ax * by - ay * bx;
    if (Math.abs(cross) < 1e-12) convex = false;
    if (crossSign === 0) crossSign = Math.sign(cross);
    else if (Math.sign(cross) !== crossSign) convex = false;
  }
  area /= 2;
  // The face frame is TL,TR,BR,BL in tile-local space; a 180-degree seat
  // projects that same order counter-clockwise, so only |area| and convexity
  // are invariants, not the screen-space sign.
  check(Math.abs(area) > 0 && convex, `${label} faceQuad is a convex TL,TR,BR,BL quad`);
  const areaPx = Math.abs(area) * width * height;
  check(areaPx > 100 && areaPx < 20000, `${label} face quad area ${areaPx.toFixed(1)} px^2 is plausible`);
  faceAreaMinPx = Math.min(faceAreaMinPx, areaPx);
  faceAreaMaxPx = Math.max(faceAreaMaxPx, areaPx);
  for (let edge = 0; edge < 4; edge += 1) {
    const next = (edge + 1) % 4;
    const length = Math.hypot(
      (quad[next].x - quad[edge].x) * width,
      (quad[next].y - quad[edge].y) * height,
    );
    check(length > 2, `${label} face quad edge ${edge} is ${length.toFixed(2)} px`);
  }

  let expectedBucket;
  try {
    expectedBucket = bucketFor(zone, slot.seat, slot.anchor.x, quad, layoutSpec, [width, height]);
  } catch (error) {
    fail(`${label} bucket: ${error.message}`);
  }
  checkEqual(`${label} bucket`, slot.bucket, expectedBucket);
  if (!usedBuckets.has(slot.bucket)) usedBuckets.set(slot.bucket, []);
  usedBuckets.get(slot.bucket).push(slot);
}

for (const [zone, expected] of Object.entries(spec.anchors.counts)) {
  if (zone === 'total') continue;
  checkEqual(`layout ${zone} count`, zoneCounts[zone], expected);
}
checkEqual('layout total slots', layout.slots.length, spec.anchors.counts.total);
const anchorIds = new Set(anchorsDoc.anchors.map((anchor) => anchor.name));
checkEqual('layout id set is the SlotAnchors bank', layout.slots.length, anchorIds.size);
for (const id of anchorIds) {
  if (!ids.has(id)) fail(`layout is missing anchor ${id}`);
}
for (const id of ids) {
  if (!anchorIds.has(id)) fail(`layout publishes unknown anchor ${id}`);
}
checkEqual('layout south hand slots', seatCounts['hand/south'], 14);
for (const seat of ['north', 'east', 'west']) {
  checkEqual(`layout ${seat} hand slots`, seatCounts[`hand/${seat}`], 13);
}

// --------------------------------------------------------------------------- //
// Reference slot
// --------------------------------------------------------------------------- //
const referenceSlot = layout.slots.find((slot) => slot.id === layout.reference.slot);
if (check(Boolean(referenceSlot), `reference slot ${layout.reference.slot} exists`)) {
  near('reference slot depth', referenceSlot.depth, layout.reference.depth, 1e-6);
  near('reference slot scale', referenceSlot.scale, 1.0, 1e-6);
  checkEqual('reference mode', layout.reference.mode, 'nearest-slot');
  checkEqual('reference point', layout.reference.point, layoutSpec.reference.point);
}

// --------------------------------------------------------------------------- //
// Task 3A: surface basis and scene lighting
// --------------------------------------------------------------------------- //
const basisSpec = layoutSpec.basis;
check(Boolean(basisSpec), 'spec publishes the basis convention');
const vectorTolerance = 1e-5;
// The tangent/bitangent must point along the published screen quad edges. The
// measured worst is the perspective chord-vs-tangent difference (~0.5 deg).
const screenEdgeMinCos = 0.999;

const lighting = layout.lighting;
if (check(Boolean(lighting), 'layout publishes the lighting block')) {
  const lightingVectors = ['keyLightDir', 'keyLightColor', 'ambientColor', 'cameraPos'];
  const vectorsOk = lightingVectors.every((key) => {
    check(vec3(lighting[key]), `lighting.${key} is a 3-vector`);
    return vec3(lighting[key]);
  });
  const fills = Array.isArray(lighting.fills) ? lighting.fills : [];
  check(Array.isArray(lighting.fills), 'lighting.fills is an array');
  if (vectorsOk) {
    near('lighting keyLightDir is unit length', length3(lighting.keyLightDir), 1, vectorTolerance);
    for (let axis = 0; axis < 3; axis += 1) {
      near(
        `lighting cameraPos[${axis}] is the layout camera eye`,
        lighting.cameraPos[axis],
        layout.camera.eye[axis],
        1e-5,
      );
      check(
        lighting.keyLightColor[axis] >= 0 && lighting.keyLightColor[axis] <= 1,
        `lighting keyLightColor[${axis}] ${lighting.keyLightColor[axis]} is linear RGB`,
      );
      check(
        lighting.ambientColor[axis] >= 0 && lighting.ambientColor[axis] <= 1,
        `lighting ambientColor[${axis}] ${lighting.ambientColor[axis]} is linear RGB`,
      );
    }
  }
  checkEqual('lighting space is the basis space', lighting.space, basisSpec.space);
  checkEqual(
    'lighting key light is the rig key',
    lighting.keyLightId,
    spec.rig.lighting.key.id,
  );
  if (rigManifest?.lighting) {
    const keyRecord = rigManifest.lighting.lights.find(
      (record) => record.id === lighting.keyLightId,
    );
    if (
      vectorsOk &&
      check(Boolean(keyRecord), `lighting key ${lighting.keyLightId} is in the rig manifest`)
    ) {
      for (let axis = 0; axis < 3; axis += 1) {
        near(
          `lighting keyLightDir[${axis}] vs the rig's key toLight`,
          lighting.keyLightDir[axis],
          keyRecord.toLight[axis],
          1e-5,
        );
        near(
          `lighting keyLightColor[${axis}] vs the rig's key hex`,
          lighting.keyLightColor[axis],
          hexLinear(keyRecord.hex)[axis],
          1e-6,
        );
      }
      near('lighting keyLightEnergyW vs the rig', lighting.keyLightEnergyW, keyRecord.energyW, 1e-6);
    }
    checkEqual(
      'lighting fills are the rig fills',
      fills.map((fill) => fill.id).sort(),
      rigManifest.lighting.lights
        .map((record) => record.id)
        .filter((id) => id !== lighting.keyLightId)
        .sort(),
    );
    for (const fill of fills) {
      const record = rigManifest.lighting.lights.find((entry) => entry.id === fill.id);
      if (!check(Boolean(record), `lighting fill ${fill.id} is in the rig manifest`)) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        near(
          `lighting fill ${fill.id} dir[${axis}] vs the rig's toLight`,
          fill.dir[axis],
          record.toLight[axis],
          1e-5,
        );
        near(
          `lighting fill ${fill.id} color[${axis}] vs the rig's hex`,
          fill.color[axis],
          hexLinear(record.hex)[axis],
          1e-6,
        );
      }
      near(`lighting fill ${fill.id} energy`, fill.energyW, record.energyW, 1e-6);
    }
    for (let axis = 0; axis < 3; axis += 1) {
      near(
        `lighting ambientColor[${axis}] vs the rig's world hex`,
        lighting.ambientColor[axis],
        hexLinear(rigManifest.lighting.world.hex)[axis],
        1e-6,
      );
    }
    near(
      'lighting ambientStrength vs the rig',
      lighting.ambientStrength,
      rigManifest.lighting.world.strength,
      1e-6,
    );
  }
}

const convention = layout.basisConvention;
if (check(Boolean(convention), 'layout publishes the basis convention')) {
  for (const key of ['tangent', 'bitangent', 'normal', 'handedness', 'space']) {
    check(typeof convention[key] === 'string' && convention[key].length > 0, `basisConvention.${key} is documented`);
    checkEqual(`basisConvention.${key} is the spec's`, convention[key], basisSpec[key]);
  }
}

// Recover the anchor's world point from the published normalized anchor and
// depth, then check that each slot's T/B really travels along its own
// published TL->TR / TL->BL screen edges. This ties the world basis, the screen
// quad, the camera and the depth together in one measurement.
const cameraForward = normalise3(sub3(layout.camera.target, layout.camera.eye));
const cameraRight = normalise3(cross3(cameraForward, [0, 0, 1]));
const cameraUp = cross3(cameraRight, cameraForward);
const projectWorld = (point) => {
  const value = sub3(point, layout.camera.eye);
  const depth = dot3(value, cameraForward);
  const focal = layout.camera.focalPixels;
  return [
    width / 2 + layout.camera.shiftX * width + (focal * dot3(value, cameraRight)) / depth,
    height / 2 + layout.camera.shiftY * width - (focal * dot3(value, cameraUp)) / depth,
  ];
};
const worldOfAnchor = (slot) => {
  const lateral =
    ((slot.anchor.x * width - width / 2 - layout.camera.shiftX * width) * slot.depth) /
    layout.camera.focalPixels;
  const vertical =
    ((height / 2 + layout.camera.shiftY * width - slot.anchor.y * height) * slot.depth) /
    layout.camera.focalPixels;
  return add3(
    layout.camera.eye,
    add3(
      scale3(cameraForward, slot.depth),
      add3(scale3(cameraRight, lateral), scale3(cameraUp, vertical)),
    ),
  );
};

let worstEdgeCos = 1;
let worstEdgeSlot = '';
const basisFamilies = new Map();
for (const slot of layout.slots) {
  const basis = slot.basis;
  if (!check(Boolean(basis), `${slot.id} publishes a basis`)) continue;
  const vectors = { tangent: basis.tangent, bitangent: basis.bitangent, normal: basis.normal };
  let wellFormed = true;
  for (const [key, value] of Object.entries(vectors)) {
    if (!check(vec3(value), `${slot.id} basis.${key} is a 3-vector`)) wellFormed = false;
  }
  if (!wellFormed) continue;
  for (const [key, value] of Object.entries(vectors)) {
    near(`${slot.id} basis.${key} is unit length`, length3(value), 1, vectorTolerance);
  }
  for (const [left, right] of [
    ['tangent', 'bitangent'],
    ['tangent', 'normal'],
    ['bitangent', 'normal'],
  ]) {
    near(
      `${slot.id} basis ${left}.${right} is orthogonal`,
      dot3(vectors[left], vectors[right]),
      0,
      vectorTolerance,
    );
  }
  // The published convention: N is the outward B x T side, so N.(T x B) = -1.
  near(
    `${slot.id} basis normal is the outward B x T side`,
    dot3(vectors.normal, cross3(vectors.tangent, vectors.bitangent)),
    -1,
    vectorTolerance,
  );

  const point = worldOfAnchor(slot);
  const delta = 0.05;
  const origin = projectWorld(point);
  const alongTangent = projectWorld(add3(point, scale3(vectors.tangent, delta)));
  const alongBitangent = projectWorld(add3(point, scale3(vectors.bitangent, delta)));
  const [first, second, , fourth] = slot.faceQuad;
  const edgeT = [(second.x - first.x) * width, (second.y - first.y) * height];
  const edgeB = [(fourth.x - first.x) * width, (fourth.y - first.y) * height];
  const cosBetween = (left, right) => {
    const [ax, ay] = left;
    const [bx, by] = right;
    return (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
  };
  const cosT = cosBetween(
    [alongTangent[0] - origin[0], alongTangent[1] - origin[1]],
    edgeT,
  );
  const cosB = cosBetween(
    [alongBitangent[0] - origin[0], alongBitangent[1] - origin[1]],
    edgeB,
  );
  check(
    cosT >= screenEdgeMinCos,
    `${slot.id} tangent projects along TL->TR (cos ${cosT.toFixed(6)})`,
  );
  check(
    cosB >= screenEdgeMinCos,
    `${slot.id} bitangent projects along TL->BL (cos ${cosB.toFixed(6)})`,
  );
  if (cosT < worstEdgeCos) {
    worstEdgeCos = cosT;
    worstEdgeSlot = `${slot.id} tangent`;
  }
  if (cosB < worstEdgeCos) {
    worstEdgeCos = cosB;
    worstEdgeSlot = `${slot.id} bitangent`;
  }

  // A lying tile (wall, pond, meld) is horizontal whatever its in-plane turn:
  // the whole tangent frame is level apart from the face's up/down normal.
  if (['wall', 'river', 'meld'].includes(slot.zone)) {
    near(`${slot.id} lying tangent is level`, vectors.tangent[2], 0, 1e-6);
    near(`${slot.id} lying bitangent is level`, vectors.bitangent[2], 0, 1e-6);
    near(`${slot.id} lying normal is vertical`, Math.abs(vectors.normal[2]), 1, 1e-6);
    check(
      Math.abs(Math.abs(vectors.tangent[0]) + Math.abs(vectors.tangent[1]) - 1) <= 1e-6,
      `${slot.id} lying tangent is axis aligned`,
    );
    if (slot.zone !== 'wall') {
      check(vectors.normal[2] > 0.999999, `${slot.id} pond/meld face is up`);
    }
  }
  // A standing tile keeps a horizontal glyph-right edge at any recline.
  if (slot.zone === 'hand') {
    near(`${slot.id} hand tangent is level`, vectors.tangent[2], 0, 1e-6);
    check(
      Math.abs(Math.abs(vectors.tangent[0]) + Math.abs(vectors.tangent[1]) - 1) <= 1e-6,
      `${slot.id} hand tangent is axis aligned`,
    );
  }
  if (slot.zone === 'hand' && slot.seat === 'south') {
    // The player's hand is reposed for readability; the published basis carries
    // the pose the geometry actually has, so its tilt is the rig's hand tilt.
    const tiltDeg = (Math.atan2(vectors.normal[2], -vectors.normal[1]) * 180) / Math.PI;
    if (rigManifest?.layout?.hand) {
      near(
        `${slot.id} hand tilt vs the rig's hand tilt`,
        tiltDeg,
        rigManifest.layout.hand.tiltDeg,
        1e-3,
      );
    }
    check(tiltDeg > 0 && tiltDeg < 90, `${slot.id} hand leans toward the camera (${tiltDeg.toFixed(2)} deg)`);
  }
  // Every distinct rotation family the board actually poses, for the report.
  const family = `${slot.zone}/${slot.seat}: T ${vectors.tangent.map((value) => value.toFixed(3)).join(',')}`;
  basisFamilies.set(family, (basisFamilies.get(family) ?? 0) + 1);
}

checkEqual('layout hand lighting cheat is the rig cheat', layout.handLightingCheat?.mode, rigManifest?.handLightingCheat?.mode);
if (layout.handLightingCheat && rigManifest?.handLightingCheat) {
  near(
    'layout hand cheat delta vs the rig',
    layout.handLightingCheat.deltaDeg,
    rigManifest.handLightingCheat.deltaDeg,
    1e-6,
  );
}

// --------------------------------------------------------------------------- //
// Bucket catalogue
// --------------------------------------------------------------------------- //
const catalogue = layout.bucketCatalogue;
checkEqual('catalogue keys are the used buckets', Object.keys(catalogue).sort(), [...usedBuckets.keys()].sort());
for (const [bucket, record] of Object.entries(catalogue)) {
  const members = usedBuckets.get(bucket) ?? [];
  checkEqual(`${bucket} catalogue count`, record.count, members.length);
  check(members.every((slot) => slot.bucket === bucket), `${bucket} members carry the bucket`);
  const representative = layout.slots.find((slot) => slot.id === record.representative);
  if (check(Boolean(representative), `${bucket} representative exists`)) {
    checkEqual(`${bucket} representative bucket`, representative.bucket, bucket);
  }
  const family = tryFamily(members[0], layoutSpec);
  if (family) {
    checkEqual(`${bucket} family`, record.family, family.id);
    checkEqual(`${bucket} representative axis`, record.axis, family.representativeAxis ?? 'x');
  }
}
for (const declared of declaredBuckets(layoutSpec)) {
  check(
    usedBuckets.has(declared.name),
    `declared bucket ${declared.name} (${declared.family}) is used by at least one slot`,
  );
}

// --------------------------------------------------------------------------- //
// Probe proof (1 px acceptance)
// --------------------------------------------------------------------------- //
const probePath = join(renderDir, proofSpec.directory, proofSpec.probes);
const overlayPath = join(renderDir, proofSpec.directory, proofSpec.overlay);
const zoomPath = join(renderDir, proofSpec.directory, proofSpec.zoom);
const proofPath = join(renderDir, proofSpec.directory, proofSpec.record);
const proof = load(proofPath, 'layout-proof.json');
check(existsSync(probePath), `probe render exists at ${probePath}`);
check(existsSync(overlayPath), `overlay exists at ${overlayPath}`);
check(existsSync(zoomPath), `zoom sheet exists at ${zoomPath}`);
if (proof && existsSync(probePath) && existsSync(overlayPath) && existsSync(zoomPath)) {
  checkEqual('proof variant', proof.variant, layout.variant);
  checkEqual('proof layout', proof.layout, layoutSpec.output);
  checkEqual('proof reference width', proof.referenceResolution.width, width);
  checkEqual('proof reference height', proof.referenceResolution.height, height);
  checkEqual('proof threshold', proof.thresholdPx, proofSpec.thresholdPx);
  checkEqual('proof markers', proof.probe.markers, layout.slots.length);
  checkEqual('proof slot count', proof.slots.length, layout.slots.length);

  const probe = readPng(probePath);
  checkEqual('probe dimensions', [probe.width, probe.height], [width, height]);
  checkEqual('probe channels', probe.channels, 4);
  const components = measureProbes(probe, proofSpec.alphaThreshold);
  let measured = null;
  try {
    measured = matchProbes(components, layout.slots, width, height, proofSpec.matchRadiusPx);
  } catch (error) {
    fail(error.message);
  }
  if (measured) {
    checkEqual('probe marker count', components.length, layout.slots.length);
    check(
      measured.maxDelta <= proofSpec.thresholdPx,
      `worst probe delta ${measured.maxDelta.toFixed(3)} px is within ${proofSpec.thresholdPx} px`,
    );
    near('proof maxDeltaPx reproduces', proof.maxDeltaPx, round(measured.maxDelta), 2e-6);
    near('proof meanDeltaPx reproduces', proof.meanDeltaPx, round(measured.meanDelta), 2e-6);
    near('proof p95DeltaPx reproduces', proof.p95DeltaPx, measured.p95, 2e-6);
    checkEqual('proof slot ids', proof.slots.map((slot) => slot.id).sort(), layout.slots.map((slot) => slot.id).sort());
    for (const record of proof.slots) {
      const recomputed = measured.records.get(record.id);
      if (!check(Boolean(recomputed), `proof record ${record.id} has a marker`)) continue;
      near(`${record.id} probe x`, record.probePx[0], recomputed.probePx[0], 2e-6);
      near(`${record.id} probe y`, record.probePx[1], recomputed.probePx[1], 2e-6);
      near(`${record.id} delta`, record.deltaPx, recomputed.deltaPx, 2e-6);
    }
  }

  const overlayPng = readPng(overlayPath);
  checkEqual('overlay dimensions', [overlayPng.width, overlayPng.height], [width, height]);
  checkEqual('overlay channels', overlayPng.channels, 4);
  let magenta = 0;
  let cyan = 0;
  for (let index = 0; index < overlayPng.width * overlayPng.height; index += 1) {
    const offset = index * 4;
    const [r, g, b] = [overlayPng.data[offset], overlayPng.data[offset + 1], overlayPng.data[offset + 2]];
    if (r > 200 && g < 60 && b > 150) magenta += 1;
    if (r < 140 && g > 150 && b > 180) cyan += 1;
  }
  check(magenta >= layout.slots.length, `overlay draws a cross per slot (${magenta} magenta px)`);
  check(cyan > 1000, `overlay draws the face quads (${cyan} cyan px)`);
  let unmarked = 0;
  for (const slot of layout.slots) {
    const x = Math.round(slot.anchor.x * width);
    const y = Math.round(slot.anchor.y * height);
    let marked = false;
    for (let dy = -3; dy <= 3 && !marked; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        const px = x + dx;
        const py = y + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        const offset = (py * width + px) * 4;
        if (
          overlayPng.data[offset] > 240 &&
          overlayPng.data[offset + 1] < 40 &&
          overlayPng.data[offset + 2] > 150
        ) {
          marked = true;
          break;
        }
      }
    }
    if (!marked) unmarked += 1;
  }
  checkEqual('overlay marks every anchor', unmarked, 0);

  const zoomPng = readPng(zoomPath);
  const size = proofSpec.zoomSize;
  const factor = proofSpec.zoomFactor;
  const cellWidth = size * factor + 24;
  const labelHeight = 44;
  const zoomCount =
    new Set(
      Object.values(layout.bucketCatalogue)
        .map((record) => record.representative)
        .concat(['hand_south_13']),
    ).size;
  const columns = 4;
  const rows = Math.ceil(zoomCount / columns);
  checkEqual('zoom sheet dimensions', [zoomPng.width, zoomPng.height], [
    columns * cellWidth,
    rows * (size * factor + labelHeight),
  ]);

  const layoutBytes = statSync(layoutPath).size;
  check(layoutBytes > 10000 && layoutBytes < 400000, `layout size ${layoutBytes} B is plausible`);
}

function tryFamily(slot, layoutSpecValue) {
  if (!slot) return null;
  try {
    return familyFor(slot.zone, slot.seat, layoutSpecValue);
  } catch (error) {
    fail(error.message);
    return null;
  }
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

console.log(
  `table-layout: ${layout.slots.length} slots, ${Object.keys(catalogue).length} buckets, ` +
    `face area ${faceAreaMinPx.toFixed(0)}-${faceAreaMaxPx.toFixed(0)} px^2, ` +
    `probe max ${proof?.maxDeltaPx ?? '?'} px, ` +
    `basis ${basisFamilies.size} zone/seat tangents (worst screen-edge cos ` +
    `${worstEdgeCos.toFixed(6)} at ${worstEdgeSlot}), ` +
    `key ${
      (
        (Math.acos(Math.min(1, layout.lighting?.keyLightDir?.[2] ?? 1)) * 180) /
        Math.PI
      ).toFixed(1)
    } deg off vertical`,
);
if (failures) {
  console.error(`table-layout: ${failures} failure(s) in ${checks} checks`);
  process.exit(1);
}
console.log(`table-layout: OK (${checks} checks)`);
