#!/usr/bin/env node
/**
 * Publish one 2.5D rig variant (Task 2 of 2_5d_implementation_plan.md).
 *
 *   bash tools/render/bake-table-reference.sh --rig --variant v2-compact
 *
 * Reads the transient bake (`tools/render/build/reference/rig/<variant>/`),
 * recomputes the acceptance geometry from the recorded camera and placements,
 * measures the lighting probes on the rendered pixels, then commits
 * `tools/render/reference/rig/<variant>-1x.png`, `<variant>.json`, and rebuilds
 * the A/B `index.html` from every committed variant.
 *
 * Calibration only: nothing under frontend/public is written and the runtime
 * never reads the rig.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import { cameraFromCandidate, rigLightingSamples, rigMetrics, tileBoxCorners } from './table-camera.mjs';
import { alphaAt, alphaCoverage, measureRigSamples } from './table-rig-samples.mjs';
import { orderedVariants, resolveRigVariant } from './table-rig-spec.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(renderDir, 'table-reference-spec.json'), 'utf8'));
const shellSpec = JSON.parse(readFileSync(join(renderDir, 'shell-spec.json'), 'utf8'));
if (!spec.rig) throw new Error('table-rig: table-reference-spec.json has no rig block');

let requested = null;
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === '--variant') {
    requested = process.argv[index + 1];
    index += 1;
  } else {
    throw new Error(`table-rig: unknown option ${arg}`);
  }
}
const { id, variant, rig, table } = resolveRigVariant(spec, requested);
const resolution = rig.output.resolution;

const bakeDir = join(renderDir, 'build', 'reference', rig.output.bakeDirectory.replace('{variant}', id));
const bakePath = join(bakeDir, rig.output.bakeFile);
if (!existsSync(bakePath)) {
  throw new Error(`table-rig: no bake at ${bakePath}; run bake-table-reference.sh --rig --variant ${id} first`);
}
const bake = JSON.parse(readFileSync(bakePath, 'utf8'));
if (bake.mode !== 'rig' || bake.variant !== id) {
  throw new Error(`table-rig: ${bakePath} is not a ${id} rig bake`);
}
if (bake.resolution[0] !== resolution[0] || bake.resolution[1] !== resolution[1]) {
  throw new Error(
    `table-rig: the bake is ${bake.resolution.join('x')}, but the variant is ` +
      `${resolution.join('x')}; a tuning render is never published`,
  );
}
if (bake.render.samples !== rig.render.samples) {
  throw new Error(
    `table-rig: the bake used ${bake.render.samples} samples, the variant uses ` +
      `${rig.render.samples}; a tuning render is never published`,
  );
}

const camera = cameraFromCandidate(rig.camera, resolution);
for (const key of ['eye', 'target']) {
  for (const axis of [0, 1, 2]) {
    if (Math.abs(camera[key][axis] - bake.camera[key][axis]) > 1e-4) {
      throw new Error(`table-rig: the bake camera ${key}[${axis}] disagrees with the spec`);
    }
  }
}

const renderPath = join(bakeDir, rig.output.renderPattern.replace('{width}', String(resolution[0])));
if (!existsSync(renderPath)) throw new Error(`table-rig: no render at ${renderPath}`);
const image = readPng(renderPath);
if (image.width !== resolution[0] || image.height !== resolution[1]) {
  throw new Error(`table-rig: the render is ${image.width}x${image.height}`);
}
if (image.channels !== 4) {
  throw new Error(`table-rig: the rig render must be RGBA (film transparent), got ${image.channels} channels`);
}

const tiles = bake.scene.tiles;
const metrics = rigMetrics(camera, tiles, spec, shellSpec);
const samples = rigLightingSamples(camera, tiles, spec, shellSpec, rig);
const measured = measureRigSamples(image, samples);
const coverage = alphaCoverage(image);

const outDir = join(renderDir, 'reference', rig.output.directory);
const committedPath = join(outDir, rig.output.imagePattern.replace('{variant}', id));
copyFileSync(renderPath, committedPath);
const bytes = statSync(committedPath).size;
const digest = createHash('sha256')
  .update(`${image.width}x${image.height}x${image.channels}:`)
  .update(image.data)
  .digest('hex');

const luma = (name) => measured[name]?.luma ?? null;
const wallLumas = Object.keys(measured)
  .filter((name) => name.startsWith('wallFace'))
  .sort((a, b) => Number(a.slice('wallFace'.length)) - Number(b.slice('wallFace'.length)))
  .map((name) => measured[name]?.luma ?? null);
const wallMid = Math.floor(wallLumas.length / 2);
const wallDip = wallLumas.length >= 3
  ? Number(Math.abs(wallLumas[wallMid] - (wallLumas[0] + wallLumas[wallLumas.length - 1]) / 2).toFixed(1))
  : null;

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
const otherBases = ['top', 'right', 'left'].map((seat) => handBases[seat]).filter(Number.isFinite);
const playerHandBackOffset = handBases.bottom !== undefined && otherBases.length
  ? Number((handBases.bottom - otherBases.reduce((sum, value) => sum + value, 0) / otherBases.length).toFixed(4))
  : null;

const shadowKeys = Object.keys(measured)
  .filter((name) => name.startsWith('handShadow'))
  .sort((a, b) => Number(a.slice('handShadow'.length)) - Number(b.slice('handShadow'.length)));
const shadowLumas = shadowKeys.map((name) => measured[name]?.luma ?? null);
const shadowReference = shadowLumas.length ? shadowLumas[shadowLumas.length - 1] : null;
const shadowFactors = shadowReference
  ? shadowLumas.map((value) => (value === null ? null : Number((value / shadowReference).toFixed(3))))
  : [];

const manifestShadowGroups = (entry) => entry?.groups ?? [];

const facts = {
  faceLuma: luma('face'),
  blueLuma: luma('blue'),
  blueMinusRed: measured.blue ? Number((measured.blue.rgb[2] - measured.blue.rgb[0]).toFixed(1)) : null,
  handFaceLuma: luma('handFace'),
  handToDiscardLumaRatio: measured.handFace && measured.face
    ? Number((measured.handFace.luma / measured.face.luma).toFixed(3))
    : null,
  sideFaceLuma: {
    left: luma('sideLeft'),
    right: luma('sideRight'),
    min: Math.min(...[luma('sideLeft'), luma('sideRight')].filter((value) => value !== null)),
  },
  matLuma: luma('mat'),
  wallFaceLumas: wallLumas,
  wallFaceDip: wallDip,
  handShadowLumas: shadowLumas,
  handShadowLumaFactors: shadowFactors,
  handShadowMinLumaFactor: shadowFactors.length
    ? Math.min(...shadowFactors.filter((value) => value !== null))
    : null,
  shadowMargins: Object.fromEntries(
    (manifestShadowGroups(bake.handShadowCheat)).map((group, index) => [index === 0 ? 'hand' : 'drawn', {
      leftUnits: Number((group.tileX0 - group.x0).toFixed(4)),
      rightUnits: Number((group.x1 - group.tileX1).toFixed(4)),
      centreOffsetUnits: Number((((group.x0 + group.x1) / 2) - ((group.tileX0 + group.tileX1) / 2)).toFixed(4)),
    }]),
  ),
  handWrapLumaFactors: {
    left: measured.handWrapLeft && measured.handWrapLeftRef
      ? Number((measured.handWrapLeft.luma / measured.handWrapLeftRef.luma).toFixed(3))
      : null,
    right: measured.handWrapRight && measured.handWrapRightRef
      ? Number((measured.handWrapRight.luma / measured.handWrapRightRef.luma).toFixed(3))
      : null,
  },
  handWrapNorthLumaFactors: {
    left: measured.handWrapLeftNorth && measured.handWrapLeftRef
      ? Number((measured.handWrapLeftNorth.luma / measured.handWrapLeftRef.luma).toFixed(3))
      : null,
    right: measured.handWrapRightNorth && measured.handWrapRightRef
      ? Number((measured.handWrapRightNorth.luma / measured.handWrapRightRef.luma).toFixed(3))
      : null,
  },
  handBaseRadiusUnits: handBases,
  playerHandBackOffsetUnits: playerHandBackOffset,
  sideOverMat: Number(
    (
      Math.min(...[luma('sideLeft'), luma('sideRight')].filter((value) => value !== null)) -
      (luma('mat') ?? 0)
    ).toFixed(1),
  ),
};

const manifest = {
  version: 1,
  generatedBy: 'tools/render/scripts/table-rig.mjs',
  rig: rig.id,
  variant: id,
  variantLabel: variant.label,
  variantNote: variant.note,
  variantDate: variant.date,
  variantOrder: variant.order ?? 0,
  variantChosen: Boolean(variant.chosen),
  variantChosenDate: variant.chosenDate ?? null,
  variantChosenNote: variant.chosenNote ?? null,
  strictScene: Boolean(variant.strictScene),
  blender: bake.blender,
  resolution,
  camera,
  projectionDeltaPx: bake.projectionDeltaPx,
  visibility: bake.visibility,
  render: bake.render,
  lighting: bake.lighting,
  handLightingCheat: bake.handLightingCheat ?? null,
  handShadow: bake.handShadowCheat ?? null,
  variantExtends: variant.extends ?? null,
  layout: {
    hand: table.hand,
    meld: table.meld,
    wall: {
      radiusUnits: table.wall.radiusUnits,
      stacksPerRun: table.wall.stacksPerRun,
      tiers: table.wall.tiers,
    },
    pond: {
      rows: table.pond.rows,
      columns: table.pond.columns,
      rowRadiiUnits: table.pond.rowRadiiUnits,
    },
  },
  scene: {
    dimensions: bake.scene.dimensions,
    innerFacePlate: bake.scene.innerFacePlate,
    tiles,
  },
  metrics,
  samples: Object.fromEntries(
    Object.entries(samples).map(([name, sample]) => [name, { ...sample, measured: measured[name] }]),
  ),
  facts,
  alpha: {
    ...coverage,
    corners: [
      alphaAt(image, [0.5, 0.5]),
      alphaAt(image, [image.width - 0.5, 0.5]),
      alphaAt(image, [0.5, image.height - 0.5]),
      alphaAt(image, [image.width - 0.5, image.height - 0.5]),
    ],
    mat: measured.mat ? alphaAt(image, samples.mat.pixel) : null,
  },
  rigSpec: {
    camera: rig.camera,
    output: rig.output,
    lighting: rig.lighting,
    render: rig.render,
    samples: rig.samples,
    checks: rig.checks,
    lightingCheat: rig.lightingCheat ?? null,
    handShadow: rig.handShadow ?? null,
    table: {
      hand: table.hand,
      meld: table.meld,
    },
  },
  renders: {
    file: rig.output.imagePattern.replace('{variant}', id),
    width: image.width,
    height: image.height,
    channels: image.channels,
    bytes,
    sha256: digest,
  },
  note: rig.status,
};
writeFileSync(join(outDir, rig.output.manifestPattern.replace('{variant}', id)), `${JSON.stringify(manifest, null, 1)}\n`);

// --------------------------------------------------------------------------- //
// The A/B page: every committed variant, newest settings included.
// --------------------------------------------------------------------------- //
const manifests = readdirSync(outDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(join(outDir, name), 'utf8')))
  .filter((entry) => entry.version === 1 && entry.variant)
  .sort((a, b) => a.variantOrder - b.variantOrder || a.variant.localeCompare(b.variant));
const settingsRows = (entry) => {
  const hand = entry.layout?.hand ?? {};
  const cam = entry.camera;
  return `
      ${entry.variantChosen ? `<tr><th>status</th><td><strong>CHOSEN ${entry.variantChosenDate ?? ''}</strong> — ${entry.variantChosenNote ?? ''}</td></tr>` : ''}
      <tr><th>camera</th><td>${cam.lensMm} mm · pitch ${cam.elevationDeg}° · ${cam.distanceUnits.toFixed(3)} units · Shift Y ${cam.shiftY}</td></tr>
      <tr><th>hand / meld radius</th><td>${hand.backRadiusUnits ?? '?'} / ${entry.layout?.meld?.rowRadiusUnits ?? '?'} units${hand.backRadiusUnitsBySeat?.bottom && hand.backRadiusUnitsBySeat.bottom !== hand.backRadiusUnits ? ` (player hand ${hand.backRadiusUnitsBySeat.bottom})` : ''}</td></tr>
      <tr><th>hand tilt</th><td>${hand.tiltDeg ?? '?'}°${entry.handLightingCheat ? ` (shaded as ${entry.handLightingCheat.physicalTiltDeg}°)` : ''}</td></tr>
      <tr><th>hand shadow</th><td>${entry.handShadow
        ? (entry.handShadow.mode === 'gradientDecal'
          ? `gradient decal (${entry.handShadow.strips} strips, max alpha ${entry.handShadow.maxAlpha}, ${entry.handShadow.lengthUnits} units)`
          : `physical-pose caster (${entry.handShadow.casters} casters)`)
        : 'real'}</td></tr>
      <tr><th>wall behind the hand (dip)</th><td>${entry.facts?.wallFaceDip ?? '?'} luma</td></tr>
      <tr><th>under-hand shadow (darkest / fade)</th><td>${entry.facts?.handShadowMinLumaFactor ?? '?'} × felt · ${entry.facts?.handShadowLumaFactors?.join(' → ') ?? ''}</td></tr>
      <tr><th>shadow margins (L / R / centre)</th><td>${Object.entries(entry.facts?.shadowMargins ?? {}).map(([group, value]) => `${group}: ${value.leftUnits} / ${value.rightUnits} / ${value.centreOffsetUnits}`).join(' · ') || '—'}</td></tr>
      <tr><th>light key</th><td>${entry.lighting?.lights?.[0]?.energyW ?? '?'} W</td></tr>
      <tr><th>tile size (hand face width)</th><td>${entry.metrics?.hand?.rows?.[6]?.topWidthPx ?? '?'} px</td></tr>
      <tr><th>hand face / discard luma</th><td>${entry.facts?.handFaceLuma} / ${entry.facts?.faceLuma}</td></tr>
      <tr><th>hand bottom margin</th><td>${entry.metrics?.hand?.bottomMarginPx} px</td></tr>`;
};
const sections = manifests.map((entry) => `
  <section>
    <h2>${entry.variant} — ${entry.variantLabel ?? ''}</h2>
    <p>${entry.variantNote ?? ''}</p>
    <figure>
      <a href="${entry.renders.file}"><img src="${entry.renders.file}" alt="${entry.variant}"></a>
      <figcaption>${entry.renders.width}×${entry.renders.height} RGBA · ${entry.renders.bytes.toLocaleString()} B ·
      ${entry.variantDate ?? ''}</figcaption>
    </figure>
    <table>${settingsRows(entry)}
      <tr><th>side inner face / hand sliver</th><td>${entry.metrics?.wallInnerFaceMinPx?.left} / ${entry.metrics?.hand?.rows?.[0]?.sideSliverPx} px</td></tr>
      <tr><th>transparent pixels</th><td>${entry.alpha?.transparentPct}%</td></tr>
    </table>
  </section>`).join('\n');

const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>riichiprac 2.5D rig A/B</title>
<style>
  body { margin: 0 auto; max-width: 1180px; padding: 24px; background: #10171b; color: #dbe6e9;
         font: 15px/1.45 system-ui, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  h2 { font-size: 17px; margin: 0 0 4px; }
  p { color: #9fb2b8; max-width: 78ch; }
  img { max-width: 100%; display: block; border-radius: 4px; background: #0b1114; }
  figure { margin: 0 0 12px; }
  figcaption { color: #9fb2b8; font-size: 13px; padding-top: 6px; }
  table { border-collapse: collapse; margin: 6px 0 22px; font-size: 14px; }
  th, td { text-align: left; padding: 3px 14px 3px 0; border-bottom: 1px solid #23343a; }
  th { color: #9fb2b8; font-weight: 500; }
  code { color: #cbe3c6; }
  section { border-top: 1px solid #23343a; padding-top: 18px; margin-top: 22px; }
</style>
<h1>2.5D rig variants — A/B</h1>
<p>Task 2 of <code>2_5d_implementation_plan.md</code>, variant by variant. Every
variant is the same Blender scene and the same 269 placements, rebuilt with its
own layout overrides, camera and lights. The committed record of each is its
<code>.json</code>; the numbers are recomputed by
<code>scripts/check-table-rig.mjs</code> from the camera and placements and
measured on the rendered pixels. Calibration only.</p>
${sections}
`;
writeFileSync(join(outDir, rig.output.index), html);

console.log(
  `[table-rig] ${id} · ${resolution.join('x')} · ${rig.camera.lensMm} mm · ` +
    `pitch ${rig.camera.elevationDeg}° · d ${rig.camera.distanceUnits} · Shift Y ${rig.camera.shiftY}`,
);
console.log(
  `[table-rig] vanishing point (${metrics.vanishingPoint.x.toFixed(1)}, ` +
    `${metrics.vanishingPoint.y.toFixed(0)}) px above the frame · ` +
    `hand sliver outer ${metrics.hand.rows[0].sideSliverPx} px / centre ${metrics.hand.rows[6].sideSliverPx} px · ` +
    `hand bottom ${metrics.hand.bottomMarginPx} px`,
);
console.log(
  `[table-rig] face ${facts.faceLuma} · blue ${facts.blueLuma} · hand ${facts.handFaceLuma} ` +
    `(ratio ${facts.handToDiscardLumaRatio}) · sides ${facts.sideFaceLuma.left}/${facts.sideFaceLuma.right} · ` +
    `felt ${facts.matLuma} · transparent ${coverage.transparentPct}%`,
);
console.log(`[table-rig] published ${committedPath}, reference/${rig.output.directory}/${rig.output.manifestPattern.replace('{variant}', id)} and the A/B ${rig.output.index}`);
