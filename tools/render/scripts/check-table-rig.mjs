#!/usr/bin/env node
/**
 * Acceptance gate for every committed 2.5D rig variant (Task 2 of
 * 2_5d_implementation_plan.md). No Blender.
 *
 *   node tools/render/scripts/check-table-rig.mjs [--variant NAME]
 *
 * Validates facts, not looks (AGENTS.md 6). For each committed variant:
 *
 *   - the resolved spec contract: perspective, lens in range, pitch in 48-52,
 *     camera on X = 0 behind the south edge, negative Shift Y, 16:9, film
 *     transparent with the floor hidden, exactly one large soft AREA key
 *     slightly forward of centre plus low fills, Cycles GI for contact
 *     occlusion;
 *   - the manifest camera/lights/render match the resolved variant settings,
 *     with no roll (camera right = world +X);
 *   - the acceptance geometry recomputed from the camera and placements: the
 *     +Y vanishing point above the frame, both side-wall runs converging on it,
 *     visible inner-face slivers, a straight-on hand centre with outer slivers,
 *     no inward hand-plate lean, every tile inside the frame and the hand at the
 *     specified height;
 *   - the hand lighting cheat, when a variant declares one: it was applied to
 *     the expected objects with the expected normal delta, and the rendered hand
 *     face is measurably darker than the lit discards (the physical-pose read),
 *     which a cheated-pose lighting would fail;
 *   - the scene: strict variants must match the published placement reference
 *     id-for-id and pose-for-pose; layout variants must match ids, count and
 *     dimensions, and may only differ in the forced blank hand probe's face;
 *   - the committed PNG is RGBA at the declared resolution with the recorded
 *     bytes and decoded-RGBA sha256, and its transparent-pixel share is inside
 *     the variant's band;
 *   - the lighting probes, measured on the rendered pixels: a lit ivory face,
 *     a blue wall back, a readable hand face, side-wall inner faces brighter
 *     than the felt;
 *   - the A/B index lists every committed variant.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import { cameraFromCandidate, rigLightingSamples, rigMetrics, tileBoxCorners } from './table-camera.mjs';
import { alphaAt, alphaCoverage, measureRigSamples } from './table-rig-samples.mjs';
import { orderedVariants, resolveRigVariant } from './table-rig-spec.mjs';

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
if (!check(Boolean(spec.rig), 'the spec has a rig block')) process.exit(1);

const output = spec.rig.output;
const outDir = join(renderDir, 'reference', output.directory);
if (!check(existsSync(outDir), `the committed variant directory exists (reference/${output.directory})`)) {
  process.exit(1);
}
const manifestFiles = readdirSync(outDir).filter((name) => name.endsWith('.json'));
check(manifestFiles.length > 0, 'at least one committed variant exists');

const requested = (() => {
  const index = process.argv.indexOf('--variant');
  return index >= 0 ? process.argv[index + 1] : null;
})();

const placementTiles = new Map(placement.scene.tiles.map((tile) => [tile.id, tile]));
const checkedVariants = [];

function checkVariant(manifest, file) {
  const id = manifest.variant;
  const { variant, rig, table } = resolveRigVariant(spec, id);
  const limits = rig.checks;
  const resolution = rig.output.resolution;
  const cameraSpec = rig.camera;
  console.log(`[table-rig] variant ${id} (${file})`);

  // ------------------------------------------------------------------------- //
  // Variant identity and the rig contract
  // ------------------------------------------------------------------------- //
  checkEqual(`${id} manifest rig`, manifest.rig, rig.id);
  checkEqual(`${id} variant label`, manifest.variantLabel, variant.label);
  checkEqual(`${id} variant order`, manifest.variantOrder, variant.order ?? 0);
  checkEqual(`${id} strictScene`, manifest.strictScene, Boolean(variant.strictScene));
  check(Boolean(variantsOfSpec[id]), `${id} is declared in the spec`);
  check(cameraSpec.mode === 'perspective', `${id} camera is perspective`);
  check(
    cameraSpec.lensMm >= limits.lensMmRange[0] && cameraSpec.lensMm <= limits.lensMmRange[1],
    `${id} lens ${cameraSpec.lensMm} mm in [${limits.lensMmRange}]`,
  );
  check(
    cameraSpec.elevationDeg >= limits.elevationDegRange[0] &&
      cameraSpec.elevationDeg <= limits.elevationDegRange[1],
    `${id} pitch ${cameraSpec.elevationDeg} deg in [${limits.elevationDegRange}]`,
  );
  check(cameraSpec.shiftX === 0, `${id} Shift X is 0`);
  check(cameraSpec.shiftY < 0, `${id} Shift Y is negative (${cameraSpec.shiftY})`);
  near(cameraSpec.eye[0], 0, 1e-9, `${id} camera centred on X = 0`);
  check(cameraSpec.eye[1] < 0, `${id} camera behind the south edge`);
  check(resolution[0] === 1920 && resolution[1] === 1080, `${id} reference is 1920x1080`);
  check(rig.render.filmTransparent === true, `${id} film transparent`);
  check(rig.render.hideFloor === true, `${id} floor hidden`);
  check(rig.render.colorMode === 'RGBA', `${id} RGBA render`);

  const key = rig.lighting.key;
  check(key.type === 'AREA', `${id} key is an AREA light`);
  check(Math.min(key.sizeUnits, key.sizeYUnits) >= 10, `${id} key is large`);
  check(key.location[1] < 0, `${id} key sits forward of centre (y ${key.location[1]})`);
  check(key.location[2] > 15, `${id} key is overhead`);
  check(rig.lighting.fills.length >= 2, `${id} has ${rig.lighting.fills.length} fills`);
  for (const fill of rig.lighting.fills) {
    check(fill.type === 'AREA', `${id} fill ${fill.id} is AREA`);
    check(fill.energyW < key.energyW, `${id} fill ${fill.id} is low against the key`);
  }
  check(rig.lighting.world.strength <= 0.5, `${id} ambient world is low`);
  check(rig.lighting.ambientOcclusion.mode === 'cycles-gi', `${id} contact occlusion is path-traced`);

  // ------------------------------------------------------------------------- //
  // The bake record matches the resolved settings
  // ------------------------------------------------------------------------- //
  const camera = cameraFromCandidate(cameraSpec, resolution);
  near(manifest.camera.eye[0], camera.eye[0], 1e-4, `${id} camera eye x`);
  near(manifest.camera.eye[1], camera.eye[1], 1e-4, `${id} camera eye y`);
  near(manifest.camera.eye[2], camera.eye[2], 1e-4, `${id} camera eye z`);
  for (const axis of [0, 1, 2]) {
    near(manifest.camera.target[axis], camera.target[axis], 1e-6, `${id} camera target[${axis}]`);
  }
  near(manifest.camera.lensMm, cameraSpec.lensMm, 1e-9, `${id} camera lens`);
  near(manifest.camera.shiftY, cameraSpec.shiftY, 1e-9, `${id} camera Shift Y`);
  near(
    Math.hypot(...[0, 1, 2].map((axis) => camera.eye[axis] - camera.target[axis])),
    cameraSpec.distanceUnits,
    1e-3,
    `${id} stored distance is the eye-to-target distance`,
  );
  check(manifest.projectionDeltaPx >= 0 && manifest.projectionDeltaPx <= 0.01,
    `${id} pinhole matches Blender (${manifest.projectionDeltaPx} px)`);
  checkEqual(`${id} visibility`, manifest.visibility.occluded, 0);
  check(manifest.visibility.samples >= 700, `${id} visibility samples ${manifest.visibility.samples}`);
  checkEqual(`${id} bake samples`, manifest.render.samples, rig.render.samples);
  checkEqual(`${id} bake film`, manifest.render.filmTransparent, true);
  checkEqual(`${id} bake floor hidden`, manifest.render.floorHidden, true);
  checkEqual(`${id} bake colour mode`, manifest.render.colorMode, 'RGBA');

  const expectedLights = [key, ...rig.lighting.fills];
  checkEqual(`${id} light count`, manifest.lighting.lights.length, expectedLights.length);
  for (const [index, entry] of expectedLights.entries()) {
    const actual = manifest.lighting.lights[index];
    if (!check(Boolean(actual), `${id} light ${index} recorded`)) continue;
    checkEqual(`${id} light ${index} id`, actual.id, entry.id);
    checkEqual(`${id} light ${index} type`, actual.type, entry.type);
    checkEqual(`${id} light ${index} size`, actual.sizeUnits, entry.sizeUnits);
    checkEqual(`${id} light ${index} sizeY`, actual.sizeYUnits, entry.sizeYUnits);
    checkEqual(`${id} light ${index} energy`, actual.energyW, entry.energyW);
    checkEqual(`${id} light ${index} colour`, actual.hex, entry.hex);
    for (const axis of [0, 1, 2]) {
      near(actual.location[axis], entry.location[axis], 1e-6, `${id} light ${index} location[${axis}]`);
      near(actual.aimAt[axis], entry.aimAt[axis], 1e-6, `${id} light ${index} aim[${axis}]`);
    }
  }

  // The hand lighting cheat, when declared.
  const cheat = rig.lightingCheat;
  if (cheat) {
    const record = manifest.handLightingCheat;
    if (!check(Boolean(record), `${id} records the hand lighting cheat`)) {
      // continue with the remaining checks
    } else {
      checkEqual(`${id} cheat mode`, record.mode, cheat.mode);
      near(record.physicalTiltDeg, cheat.physicalTiltDeg, 1e-9, `${id} cheat physical tilt`);
      near(record.cheatedTiltDeg, table.hand.tiltDeg, 1e-9, `${id} cheat cheated tilt`);
      near(
        record.deltaDeg,
        table.hand.tiltDeg - cheat.physicalTiltDeg,
        1e-6,
        `${id} cheat normal rotation is the extra tilt`,
      );
      check(record.objects >= 20, `${id} cheat applied to ${record.objects} hand objects`);
      check(record.materials >= 1, `${id} cheat applied to ${record.materials} materials`);
    }
  } else {
    checkEqual(`${id} no hand lighting cheat`, manifest.handLightingCheat, null);
  }

  const shadowCheat = rig.handShadow;
  if (shadowCheat) {
    const record = manifest.handShadow;
    if (check(Boolean(record), `${id} records the hand shadow cheat`)) {
      checkEqual(`${id} shadow mode`, record.mode, shadowCheat.mode);
      near(record.cheatedTiltDeg, table.hand.tiltDeg, 1e-9, `${id} shadow cheated tilt`);
      check(record.hiddenObjects >= 26, `${id} ${record.hiddenObjects} hand objects hidden from shadows`);
      near(
        record.playerHandRadiusUnits,
        table.hand.backRadiusUnitsBySeat?.bottom ?? table.hand.backRadiusUnits,
        1e-9,
        `${id} shadow uses the player-hand radius`,
      );
      if (shadowCheat.mode === 'physicalPoseCaster') {
        near(record.physicalTiltDeg, shadowCheat.physicalTiltDeg, 1e-9, `${id} shadow physical tilt`);
        near(record.deltaDeg, table.hand.tiltDeg - shadowCheat.physicalTiltDeg, 1e-6, `${id} shadow normal delta`);
        check(record.casters >= 13, `${id} shadow casters ${record.casters} >= 13`);
        checkEqual(`${id} shadow fills`, record.fillLights, rig.lighting.fills.map((fill) => fill.id));
      } else if (shadowCheat.mode === 'gradientDecal') {
        near(record.maxAlpha, shadowCheat.maxAlpha, 1e-9, `${id} decal max alpha`);
        near(record.lengthUnits, shadowCheat.lengthUnits, 1e-9, `${id} decal length`);
        check(record.objects >= 2, `${id} decal has ${record.objects} strips`);
        check(
          record.maxAlpha <= limits.handShadowMaxDarkening,
          `${id} decal is subtle (max alpha ${record.maxAlpha} <= ${limits.handShadowMaxDarkening})`,
        );
        check(
          record.startRadiusUnits < record.frontEdgeRadiusUnits,
          `${id} decal starts under the tile (${record.startRadiusUnits} < ${record.frontEdgeRadiusUnits})`,
        );
        near(
          record.startRadiusUnits,
          record.frontEdgeRadiusUnits -
            record.edgeHeightUnits / Math.tan((cameraSpec.elevationDeg * Math.PI) / 180),
          1e-3,
          `${id} decal start is the front-edge silhouette projected onto the mat`,
        );
      } else {
        fail(`${id} unknown shadow mode ${shadowCheat.mode}`);
      }
    }
  } else {
    checkEqual(`${id} no hand shadow cheat`, manifest.handShadow, null);
  }

  // ------------------------------------------------------------------------- //
  // The scene
  // ------------------------------------------------------------------------- //
  const tiles = manifest.scene?.tiles;
  if (!check(Array.isArray(tiles) && tiles.length === 269, `${id} has 269 tiles`)) return;
  const differences = [];
  for (const tile of tiles) {
    const source = placementTiles.get(tile.id);
    if (!check(Boolean(source), `${id} tile ${tile.id} exists in the placement reference`)) continue;
    if (tile.face !== source.face) differences.push({ id: tile.id, face: tile.face, placementFace: source.face });
    if (!manifest.strictScene) continue;
    for (const axis of [0, 1, 2]) {
      near(tile.origin[axis], source.origin[axis], 1e-6, `${id} strict tile ${tile.id} origin[${axis}]`);
      near(tile.rotation[axis * 3], source.rotation[axis * 3], 1e-9, `${id} strict tile ${tile.id} rotation`);
      near(tile.rotation[axis * 3 + 1], source.rotation[axis * 3 + 1], 1e-9, `${id} strict tile ${tile.id} rotation`);
      near(tile.rotation[axis * 3 + 2], source.rotation[axis * 3 + 2], 1e-9, `${id} strict tile ${tile.id} rotation`);
    }
  }
  checkEqual(
    `${id} the only face override is the blank hand probe`,
    differences,
    [{ id: rig.samples.handFaceTileId, face: rig.samples.handFace, placementFace: placementTiles.get(rig.samples.handFaceTileId)?.face }],
  );
  checkEqual(`${id} tile dimensions`, manifest.scene.dimensions, placement.scene.dimensions);

  // ------------------------------------------------------------------------- //
  // Acceptance geometry
  // ------------------------------------------------------------------------- //
  const metrics = rigMetrics(camera, tiles, spec, shellSpec);
  const recorded = manifest.metrics;
  const compareMetric = (label, actual, expected) => near(actual, expected, 1e-3, `${id} metric ${label}`);
  compareMetric('vanishingPoint.x', recorded.vanishingPoint.x, metrics.vanishingPoint.x);
  compareMetric('vanishingPoint.y', recorded.vanishingPoint.y, metrics.vanishingPoint.y);
  compareMetric('runConvergenceDeltaPx', recorded.runConvergenceDeltaPx, metrics.runConvergenceDeltaPx);
  compareMetric('hand.bottomMarginPx', recorded.hand.bottomMarginPx, metrics.hand.bottomMarginPx);
  for (const side of ['left', 'right']) {
    compareMetric(`wallInnerFaceMinPx.${side}`, recorded.wallInnerFaceMinPx[side], metrics.wallInnerFaceMinPx[side]);
  }
  for (const [index, row] of metrics.hand.rows.entries()) {
    const other = recorded.hand.rows[index];
    compareMetric(`hand.rows[${index}].sideSliverPx`, other.sideSliverPx, row.sideSliverPx);
    compareMetric(`hand.rows[${index}].outwardLeanLeftPx`, other.outwardLeanLeftPx, row.outwardLeanLeftPx);
    compareMetric(`hand.rows[${index}].outwardLeanRightPx`, other.outwardLeanRightPx, row.outwardLeanRightPx);
  }

  checkEqual(`${id} camera mode`, metrics.camera.mode, 'perspective');
  near(metrics.camera.right[0], 1, 1e-9, `${id} camera right is world +X (no roll)`);
  near(metrics.camera.right[1], 0, 1e-9, `${id} camera right has no Y`);
  near(metrics.camera.right[2], 0, 1e-9, `${id} camera right has no Z`);
  near(metrics.camera.shiftX, 0, 0, `${id} Shift X stays 0`);
  check(metrics.camera.shiftY < 0, `${id} Shift Y stays negative`);
  check(metrics.vanishingPoint.y < 0, `${id} the +Y vanishing point is above the frame`);
  near(metrics.vanishingPoint.x, resolution[0] / 2, 1, `${id} vanishing point on the centre line`);
  check(metrics.runConvergenceDeltaPx !== null && metrics.runConvergenceDeltaPx <= 1,
    `${id} both side-wall runs meet the vanishing point (${metrics.runConvergenceDeltaPx} px)`);
  for (const side of ['left', 'right']) {
    check(
      metrics.wallInnerFaceMinPx[side] >= limits.wallInnerFaceMinPx,
      `${id} wall ${side} inner faces >= ${limits.wallInnerFaceMinPx} px ` +
        `(${metrics.wallInnerFaceMinPx[side]})`,
    );
    const faces = metrics.wallInnerFaces.filter((entry) => entry.seat === side);
    check(faces.every((entry) => entry.normalDotView > 0), `${id} every wall ${side} inner face faces the camera`);
    check(faces.every((entry) => entry.normalDotInward > 0.6), `${id} every wall ${side} inner face points inward`);
  }

  const handRows = metrics.hand.rows;
  const centre = handRows.find((entry) => entry.slot === 6);
  if (check(Boolean(centre), `${id} has a centre hand slot`)) {
    check(
      centre.sideSliverPx <= limits.centreSideSliverMaxPx,
      `${id} centre hand is straight-on (${centre.sideSliverPx} px <= ${limits.centreSideSliverMaxPx})`,
    );
  }
  for (const slot of [0, 12]) {
    const row = handRows.find((entry) => entry.slot === slot);
    if (!check(Boolean(row), `${id} has outer hand slot ${slot}`)) continue;
    check(row.sideSliverPx >= limits.outerSideSliverMinPx,
      `${id} hand slot ${slot} shows its inner thickness (${row.sideSliverPx} px)`);
    check(row.innerFaceNormal[0] * Math.sign(centre.centreX - row.centreX) > 0.9,
      `${id} hand slot ${slot} side face points toward the centre`);
  }
  const leftSlivers = handRows.filter((entry) => entry.slot < 6).map((entry) => entry.sideSliverPx);
  const rightSlivers = handRows.filter((entry) => entry.slot > 6).map((entry) => entry.sideSliverPx);
  check(leftSlivers.every((value, index) => index === 0 || value <= leftSlivers[index - 1] + 1e-6),
    `${id} left hand sliver grows outward`);
  check(rightSlivers.every((value, index) => index === 0 || value >= rightSlivers[index - 1] - 1e-6),
    `${id} right hand sliver grows outward`);
  const leans = handRows.flatMap((entry) => [entry.outwardLeanLeftPx, entry.outwardLeanRightPx]);
  const minLean = Math.min(...leans);
  const maxLean = Math.max(...leans);
  check(minLean >= -0.25, `${id} no hand plate edge leans inward (min ${minLean.toFixed(2)} px)`);
  check(maxLean <= limits.maxOutwardLeanPx, `${id} outward lean <= ${limits.maxOutwardLeanPx} px (max ${maxLean.toFixed(2)})`);

  for (const side of ['left', 'right']) {
    check(metrics.tileMarginsPx[side] >= limits.minWidthMarginPx,
      `${id} ${side} content margin ${metrics.tileMarginsPx[side]} px >= ${limits.minWidthMarginPx}`);
  }
  if (limits.requireFarRimInside) {
    check(metrics.rim.marginsPx.top >= 0, `${id} far rim inside the frame (${metrics.rim.marginsPx.top} px)`);
  }
  check(
    metrics.hand.bottomMarginPx >= limits.handBottomMarginPx[0] &&
      metrics.hand.bottomMarginPx <= limits.handBottomMarginPx[1],
    `${id} hand bottom margin ${metrics.hand.bottomMarginPx} px inside [${limits.handBottomMarginPx}]`,
  );
  for (const [side, value] of Object.entries(metrics.tileMarginsPx)) {
    check(value >= 0, `${id} every tile inside the frame (${side} ${value} px)`);
  }

  // The player's hand may sit farther back than the other seats.
  const seatRadial = {
    bottom: (corner) => -corner[1],
    top: (corner) => corner[1],
    right: (corner) => corner[0],
    left: (corner) => -corner[0],
  };
  const handBases = {};
  for (const seat of ['bottom', 'top', 'right', 'left']) {
    let minimum = Infinity;
    for (const tile of tiles.filter((entry) => (entry.kind === 'hand' || entry.kind === 'drawn') && entry.seat === seat)) {
      for (const corner of tileBoxCorners(tile)) {
        if (corner[2] >= 0.01) continue;
        minimum = Math.min(minimum, seatRadial[seat](corner));
      }
    }
    if (Number.isFinite(minimum)) handBases[seat] = Number(minimum.toFixed(4));
  }
  for (const [seat, value] of Object.entries(handBases)) {
    near(manifest.facts.handBaseRadiusUnits?.[seat], value, 1e-3, `${id} ${seat} hand base radius`);
  }
  const otherBases = ['top', 'right', 'left'].map((seat) => handBases[seat]).filter(Number.isFinite);
  const offset = handBases.bottom !== undefined && otherBases.length
    ? handBases.bottom - otherBases.reduce((sum, value) => sum + value, 0) / otherBases.length
    : null;
  near(manifest.facts.playerHandBackOffsetUnits, offset, 1e-3, `${id} player hand back offset`);
  if (Number.isFinite(limits.playerHandBackOffsetUnits)) {
    check(
      offset !== null && Math.abs(offset - limits.playerHandBackOffsetUnits) <= 0.01,
      `${id} player's hand sits ${limits.playerHandBackOffsetUnits} units farther back than the other hands ` +
        `(measured ${offset})`,
    );
  }

  // ------------------------------------------------------------------------- //
  // The committed render
  // ------------------------------------------------------------------------- //
  const imagePath = join(outDir, manifest.renders.file);
  if (!check(existsSync(imagePath), `${id} render exists (${manifest.renders.file})`)) return;
  const image = readPng(imagePath);
  const record = manifest.renders;
  check(image.width === resolution[0] && image.height === resolution[1], `${id} render resolution`);
  check(image.width === record.width && image.height === record.height, `${id} recorded size matches`);
  check(image.channels === 4, `${id} render is RGBA (${image.channels})`);
  checkEqual(`${id} channels`, record.channels, 4);
  checkEqual(`${id} bytes`, record.bytes, statSync(imagePath).size);
  checkEqual(
    `${id} decoded sha256`,
    record.sha256,
    createHash('sha256').update(`${image.width}x${image.height}x${image.channels}:`).update(image.data).digest('hex'),
  );
  const coverage = alphaCoverage(image);
  check(
    coverage.transparentPct >= limits.minTransparentPct && coverage.transparentPct <= limits.maxTransparentPct,
    `${id} transparent pixels ${coverage.transparentPct}% inside ` +
      `[${limits.minTransparentPct}, ${limits.maxTransparentPct}]`,
  );
  checkEqual(`${id} manifest transparency`, manifest.alpha.transparentPct, coverage.transparentPct);
  for (const [index, pixel] of [
    [0, 0],
    [image.width - 1, 0],
    [0, image.height - 1],
    [image.width - 1, image.height - 1],
  ].entries()) {
    const value = alphaAt(image, pixel);
    check(value === 0 || value === 255, `${id} corner ${index} alpha is 0 or 255 (${value})`);
    checkEqual(`${id} recorded corner ${index}`, manifest.alpha.corners[index], value);
  }

  // ------------------------------------------------------------------------- //
  // Lighting probes
  // ------------------------------------------------------------------------- //
  const samples = rigLightingSamples(camera, tiles, spec, shellSpec);
  const measured = measureRigSamples(image, samples);
  for (const [name, sample] of Object.entries(samples)) {
    const recordedSample = manifest.samples?.[name];
    if (!check(Boolean(recordedSample), `${id} records the ${name} probe`)) continue;
    if (sample.kind === 'point') {
      near(recordedSample.pixel[0], sample.pixel[0], 1e-3, `${id} ${name} probe x`);
      near(recordedSample.pixel[1], sample.pixel[1], 1e-3, `${id} ${name} probe y`);
    } else {
      for (const [index, point] of sample.polygon.entries()) {
        near(recordedSample.polygon[index][0], point[0], 1e-3, `${id} ${name} polygon[${index}] x`);
        near(recordedSample.polygon[index][1], point[1], 1e-3, `${id} ${name} polygon[${index}] y`);
      }
    }
    const value = measured[name];
    if (!check(Boolean(value), `${id} ${name} probe lands on the image`)) continue;
    if (!check(Boolean(recordedSample.measured), `${id} manifest records the measured ${name} probe`)) continue;
    check(value.pixels >= (sample.kind === 'polygon' ? 10 : 1), `${id} ${name} probe covers ${value.pixels} px`);
    near(recordedSample.measured.luma, value.luma, 0.11, `${id} ${name} luma matches the manifest`);
    near(recordedSample.measured.alpha, 255, 0.11, `${id} ${name} is on opaque geometry`);
  }
  const face = measured.face;
  const blue = measured.blue;
  const handFace = measured.handFace;
  const mat = measured.mat;
  check(face.luma >= limits.minFaceLuma, `${id} lit face luma ${face.luma} >= ${limits.minFaceLuma}`);
  check(
    Math.max(...face.rgb) - Math.min(...face.rgb) <= limits.maxFaceChannelSpread,
    `${id} face is near-neutral (spread ${(Math.max(...face.rgb) - Math.min(...face.rgb)).toFixed(1)})`,
  );
  check(blue.rgb[2] - blue.rgb[0] >= limits.minBlueMinusRed,
    `${id} wall back reads blue (b-r ${(blue.rgb[2] - blue.rgb[0]).toFixed(1)})`);
  check(handFace.luma >= limits.minHandFaceLuma, `${id} hand face luma ${handFace.luma} >= ${limits.minHandFaceLuma}`);
  for (const [index, side] of [measured.sideLeft, measured.sideRight].entries()) {
    check(side.luma >= limits.minSideFaceLuma, `${id} side inner face ${index} luma ${side.luma} >= ${limits.minSideFaceLuma}`);
    check(side.luma - mat.luma >= 25, `${id} side inner face ${index} stands off the felt (${side.luma} vs ${mat.luma})`);
  }
  if (Number.isFinite(limits.handToDiscardLumaRatioMax)) {
    const ratio = handFace.luma / face.luma;
    check(
      ratio <= limits.handToDiscardLumaRatioMax,
      `${id} hand face reads at the physical-pose level (hand/discard ${ratio.toFixed(3)} ` +
        `<= ${limits.handToDiscardLumaRatioMax})`,
    );
  }
  near(manifest.facts.faceLuma, face.luma, 0.11, `${id} manifest face luma`);
  near(manifest.facts.handFaceLuma, handFace.luma, 0.11, `${id} manifest hand luma`);
  near(manifest.facts.sideFaceLuma.left, measured.sideLeft.luma, 0.11, `${id} manifest left side luma`);
  near(manifest.facts.sideFaceLuma.right, measured.sideRight.luma, 0.11, `${id} manifest right side luma`);
  near(manifest.facts.matLuma, mat.luma, 0.11, `${id} manifest felt luma`);
  const wallLumas = Object.keys(measured)
    .filter((name) => name.startsWith('wallFace'))
    .sort((a, b) => Number(a.slice('wallFace'.length)) - Number(b.slice('wallFace'.length)))
    .map((name) => measured[name]?.luma ?? null);
  check(wallLumas.length >= 3, `${id} has ${wallLumas.length} wall-face probes`);
  const wallMid = Math.floor(wallLumas.length / 2);
  const wallDip = wallLumas.length >= 3
    ? Math.abs(wallLumas[wallMid] - (wallLumas[0] + wallLumas[wallLumas.length - 1]) / 2)
    : null;
  near(manifest.facts.wallFaceDip, wallDip, 0.11, `${id} manifest wall-face dip`);
  if (Number.isFinite(limits.wallShadowDipMaxLuma)) {
    check(
      wallDip !== null && wallDip <= limits.wallShadowDipMaxLuma,
      `${id} nothing is cast on the wall behind the hand (dip ${wallDip?.toFixed(1)} ` +
        `<= ${limits.wallShadowDipMaxLuma})`,
    );
  }

  const shadowLumas = Object.keys(measured)
    .filter((name) => name.startsWith('handShadow'))
    .sort((a, b) => Number(a.slice('handShadow'.length)) - Number(b.slice('handShadow'.length)))
    .map((name) => measured[name]?.luma ?? null);
  if (shadowLumas.length >= 3 && shadowLumas.every((value) => value !== null)) {
    const reference = shadowLumas[shadowLumas.length - 1];
    const factors = shadowLumas.map((value) => value / reference);
    const minFactor = Math.min(...factors);
    checkEqual(`${id} manifest shadow luma factors`, manifest.facts.handShadowLumaFactors,
      factors.map((value) => Number(value.toFixed(3))));
    checkEqual(`${id} manifest shadow luma minimum`, manifest.facts.handShadowMinLumaFactor,
      Number(minFactor.toFixed(3)));
    if (shadowCheat?.mode === 'gradientDecal') {
      check(
        factors.every((value, index) => index === 0 || value >= factors[index - 1] - 1e-6),
        `${id} the under-hand shadow fades monotonically (${factors.map((value) => value.toFixed(2)).join(' → ')})`,
      );
    }
    if (Number.isFinite(limits.handShadowMinLumaFactor)) {
      check(
        minFactor >= limits.handShadowMinLumaFactor,
        `${id} the under-hand shadow is subtle (darkest ${minFactor.toFixed(2)} x felt ` +
          `>= ${limits.handShadowMinLumaFactor})`,
      );
    }
    if (Number.isFinite(limits.handShadowFadeUnits)) {
      const probe = Object.entries(samples)
        .filter(([name]) => name.startsWith('handShadow'))
        .map(([, sample]) => sample)
        .sort((a, b) => a.offsetUnits - b.offsetUnits)
        .find((sample) => sample.offsetUnits >= limits.handShadowFadeUnits);
      if (check(Boolean(probe), `${id} has a probe at the fade distance`)) {
        const index = Object.keys(samples)
          .filter((name) => name.startsWith('handShadow'))
          .sort((a, b) => Number(a.slice('handShadow'.length)) - Number(b.slice('handShadow'.length)))
          .indexOf(Object.keys(samples).find((name) => samples[name] === probe));
        const factor = factors[index];
        check(
          factor >= limits.handShadowFadeFactor,
          `${id} the shadow is gone by ${limits.handShadowFadeUnits} units ` +
            `(${factor.toFixed(2)} >= ${limits.handShadowFadeFactor})`,
        );
      }
    }
  }

  checkedVariants.push({ id, metrics, face, blue, handFace, mat, coverage, cameraSpec, rig });
}

// --------------------------------------------------------------------------- //
// Every committed variant, then the A/B index.
// --------------------------------------------------------------------------- //
const variantsOfSpec = Object.fromEntries(
  (spec.rig.variants ? Object.entries(spec.rig.variants) : []),
);
const toCheck = manifestFiles
  .map((file) => ({ file, manifest: JSON.parse(readFileSync(join(outDir, file), 'utf8')) }))
  .filter((entry) => entry.manifest.version === 1 && entry.manifest.variant)
  .filter((entry) => !requested || entry.manifest.variant === requested);
check(toCheck.length > 0, `variants to check${requested ? ` (${requested})` : ''}`);

for (const { file, manifest } of toCheck) {
  if (variantsOfSpec[manifest.variant]) checkVariant(manifest, file);
  else fail(`committed manifest ${file} names unknown variant ${manifest.variant}`);
}

const declared = orderedVariants(spec).map((entry) => entry.id);
for (const id of declared) {
  const committed = manifestFiles.some((file) => {
    const manifest = JSON.parse(readFileSync(join(outDir, file), 'utf8'));
    return manifest.variant === id;
  });
  check(committed, `declared variant ${id} has a committed manifest`);
}

const indexPath = join(outDir, output.index);
if (check(existsSync(indexPath), `the A/B page exists (reference/${output.directory}/${output.index})`)) {
  const html = readFileSync(indexPath, 'utf8');
  for (const entry of toCheck) {
    check(html.includes(entry.manifest.variant), `the A/B page names ${entry.manifest.variant}`);
    check(html.includes(entry.manifest.renders.file), `the A/B page links ${entry.manifest.renders.file}`);
  }
}

// --------------------------------------------------------------------------- //
// Summary
// --------------------------------------------------------------------------- //
for (const entry of checkedVariants) {
  console.log(
    `[table-rig] ${entry.id}: ${entry.cameraSpec.lensMm} mm · pitch ${entry.cameraSpec.elevationDeg}° · ` +
      `d ${entry.cameraSpec.distanceUnits} · Shift Y ${entry.cameraSpec.shiftY} · ` +
      `hand sliver ${entry.metrics.hand.rows[0].sideSliverPx}/${entry.metrics.hand.rows[6].sideSliverPx} px · ` +
      `lean ${Math.min(...entry.metrics.hand.rows.flatMap((row) => [row.outwardLeanLeftPx, row.outwardLeanRightPx])).toFixed(2)}..` +
      `${Math.max(...entry.metrics.hand.rows.flatMap((row) => [row.outwardLeanLeftPx, row.outwardLeanRightPx])).toFixed(2)} px · ` +
      `hand bottom ${entry.metrics.hand.bottomMarginPx} px`,
  );
  console.log(
    `[table-rig] ${entry.id}: face ${entry.face.luma} · blue ${entry.blue.luma} · ` +
      `hand ${entry.handFace.luma} · sides ${entry.metrics.wallInnerFaceMinPx.left}/${entry.metrics.wallInnerFaceMinPx.right} px · ` +
      `felt ${entry.mat.luma} · transparent ${entry.coverage.transparentPct}%`,
  );
}
console.log(`[table-rig] ${checks} checks, ${failures} failure${failures === 1 ? '' : 's'}`);
if (failures > 0) process.exit(1);
