#!/usr/bin/env node
/**
 * Publish the 2.5D rig reference (Task 2 of 2_5d_implementation_plan.md).
 *
 *   bash tools/render/bake-table-reference.sh --rig   # render, publish, check
 *
 * Reads the transient bake (`tools/render/build/reference/rig/rig-bake.json`
 * plus `rig-1920.png`), recomputes the acceptance geometry from the recorded
 * camera and placements, measures the lighting probes on the rendered pixels,
 * then commits `tools/render/reference/rig-1x.png`, `rig.json` and `rig.html`.
 *
 * Calibration only: nothing under frontend/public is written and the runtime
 * never reads the rig.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng } from './png.mjs';
import { cameraFromCandidate, rigLightingSamples, rigMetrics } from './table-camera.mjs';
import { alphaAt, alphaCoverage, measureRigSamples } from './table-rig-samples.mjs';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(join(renderDir, 'table-reference-spec.json'), 'utf8'));
const shellSpec = JSON.parse(readFileSync(join(renderDir, 'shell-spec.json'), 'utf8'));
const rig = spec.rig;
if (!rig) throw new Error('table-rig: table-reference-spec.json has no rig block');

const bakePath = join(renderDir, rig.output.bakePath);
if (!existsSync(bakePath)) {
  throw new Error(`table-rig: no bake at ${bakePath}; run bake-table-reference.sh --rig first`);
}
const bake = JSON.parse(readFileSync(bakePath, 'utf8'));
const resolution = rig.output.resolution;
if (bake.mode !== 'rig') throw new Error(`table-rig: ${bakePath} is not a rig bake`);
if (bake.resolution[0] !== resolution[0] || bake.resolution[1] !== resolution[1]) {
  throw new Error(
    `table-rig: the bake is ${bake.resolution.join('x')}, but the committed rig is ` +
      `${resolution.join('x')}; a tuning render is never published`,
  );
}

if (bake.render.samples !== rig.render.samples) {
  throw new Error(
    `table-rig: the bake used ${bake.render.samples} samples, the committed rig uses ` +
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

const renderPath = join(renderDir, 'build', 'reference', 'rig', `rig-${resolution[0]}.png`);
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
const samples = rigLightingSamples(camera, tiles, spec, shellSpec);
const measured = measureRigSamples(image, samples);
const coverage = alphaCoverage(image);

const outDir = join(renderDir, 'reference');
const committedPath = join(outDir, rig.output.file);
copyFileSync(renderPath, committedPath);
const bytes = statSync(committedPath).size;
const digest = createHash('sha256')
  .update(`${image.width}x${image.height}x${image.channels}:`)
  .update(image.data)
  .digest('hex');

const luma = (name) => measured[name]?.luma ?? null;
const facts = {
  faceLuma: luma('face'),
  blueLuma: luma('blue'),
  blueMinusRed: measured.blue ? Number((measured.blue.rgb[2] - measured.blue.rgb[0]).toFixed(1)) : null,
  handFaceLuma: luma('handFace'),
  sideFaceLuma: {
    left: luma('sideLeft'),
    right: luma('sideRight'),
    min: Math.min(...[luma('sideLeft'), luma('sideRight')].filter((value) => value !== null)),
  },
  matLuma: luma('mat'),
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
  blender: bake.blender,
  resolution,
  camera,
  projectionDeltaPx: bake.projectionDeltaPx,
  visibility: bake.visibility,
  render: bake.render,
  lighting: bake.lighting,
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
  },
  renders: {
    file: rig.output.file,
    width: image.width,
    height: image.height,
    channels: image.channels,
    bytes,
    sha256: digest,
  },
  note: rig.status,
};
writeFileSync(join(outDir, rig.output.manifest), `${JSON.stringify(manifest, null, 1)}\n`);

const row = (label, value) => `<tr><th>${label}</th><td>${value}</td></tr>`;
const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>riichiprac 2.5D rig reference</title>
<style>
  body { margin: 0 auto; max-width: 1180px; padding: 24px; background: #10171b; color: #dbe6e9;
         font: 15px/1.45 system-ui, sans-serif; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  p { color: #9fb2b8; max-width: 78ch; }
  img { max-width: 100%; display: block; border-radius: 4px; background: #0b1114; }
  table { border-collapse: collapse; margin: 18px 0 26px; font-size: 14px; }
  th, td { text-align: left; padding: 4px 14px 4px 0; border-bottom: 1px solid #23343a; }
  th { color: #9fb2b8; font-weight: 500; }
  code { color: #cbe3c6; }
</style>
<h1>2.5D perspective camera + lighting rig</h1>
<p>Task 2 of <code>2_5d_implementation_plan.md</code>. Calibration only: one Blender
scene, one medium-telephoto perspective camera with a negative vertical lens shift,
a large soft overhead area key plus three low fills, film transparent. The
published PNG is RGBA. Numbers below are recomputed by
<code>scripts/check-table-rig.mjs</code> from the camera and placements, and
measured on the rendered pixels.</p>
<figure>
  <a href="${rig.output.file}"><img src="${rig.output.file}" alt="2.5D rig reference"></a>
  <figcaption>${image.width}×${image.height} RGBA · ${bytes.toLocaleString()} B ·
  ${rig.camera.lensMm} mm · pitch ${rig.camera.elevationDeg}° · distance ${rig.camera.distanceUnits} ·
  Shift Y ${rig.camera.shiftY}</figcaption>
</figure>
<table>
${row('camera eye', `[${camera.eye.map((value) => value.toFixed(3)).join(', ')}]`)}
${row('vanishing point of the side-wall runs', `(${metrics.vanishingPoint.x.toFixed(1)}, ${metrics.vanishingPoint.y.toFixed(1)}) px — above the frame`)}
${row('run convergence error', `${metrics.runConvergenceDeltaPx.toFixed(2)} px`)}
${row('side-wall inner face width (left / right)', `${metrics.wallInnerFaceMinPx.left} / ${metrics.wallInnerFaceMinPx.right} px (min over the run)`)}
${row('hand side sliver, outer / centre', `${metrics.hand.rows[0].sideSliverPx} / ${metrics.hand.rows[6].sideSliverPx} px`)}
${row('hand plate vertical lean, outward min / max', `${Math.min(...metrics.hand.rows.flatMap((entry) => [entry.outwardLeanLeftPx, entry.outwardLeanRightPx])).toFixed(2)} / ${Math.max(...metrics.hand.rows.flatMap((entry) => [entry.outwardLeanLeftPx, entry.outwardLeanRightPx])).toFixed(2)} px`)}
${row('frame margins: rim left / right / top / bottom', `${metrics.rim.marginsPx.left} / ${metrics.rim.marginsPx.right} / ${metrics.rim.marginsPx.top} / ${metrics.rim.marginsPx.bottom}`)}
${row('player hand bottom margin', `${metrics.hand.bottomMarginPx} px`)}
${row('lit face luma (pond 5z)', `${facts.faceLuma} (shipped shell 223,220,216)`)}
${row('blue back luma', `${facts.blueLuma} (blue − red ${facts.blueMinusRed})`)}
${row('blank hand face luma', `${facts.handFaceLuma}`)}
${row('side-wall inner face luma (left / right)', `${facts.sideFaceLuma.left} / ${facts.sideFaceLuma.right}`)}
${row('felt luma', `${facts.matLuma}`)}
${row('transparent / opaque pixels', `${coverage.transparentPct}% / ${coverage.opaquePct}%`)}
</table>
<p><code>rig.json</code> holds the full record: camera, light rig, every tile
placement, every acceptance number and every measured probe.</p>
`;
writeFileSync(join(outDir, 'rig.html'), html);

console.log(
  `[table-rig] ${resolution.join('x')} · ${rig.camera.lensMm} mm · ` +
    `pitch ${rig.camera.elevationDeg}° · d ${rig.camera.distanceUnits} · Shift Y ${rig.camera.shiftY}`,
);
console.log(
  `[table-rig] vanishing point (${metrics.vanishingPoint.x.toFixed(1)}, ` +
    `${metrics.vanishingPoint.y.toFixed(0)}) px above the frame · ` +
    `run convergence ${metrics.runConvergenceDeltaPx} px · ` +
    `inner faces ${metrics.wallInnerFaceMinPx.left}/${metrics.wallInnerFaceMinPx.right} px`,
);
console.log(
  `[table-rig] hand sliver outer ${metrics.hand.rows[0].sideSliverPx} px / ` +
    `centre ${metrics.hand.rows[6].sideSliverPx} px · ` +
    `hand bottom margin ${metrics.hand.bottomMarginPx} px · ` +
    `rim margins ${metrics.rim.marginsPx.left}/${metrics.rim.marginsPx.right}/${metrics.rim.marginsPx.top}`,
);
console.log(
  `[table-rig] face ${facts.faceLuma} · blue ${facts.blueLuma} · ` +
    `hand ${facts.handFaceLuma} · sides ${facts.sideFaceLuma.left}/${facts.sideFaceLuma.right} · ` +
    `felt ${facts.matLuma} · transparent ${coverage.transparentPct}%`,
);
console.log(`[table-rig] published ${committedPath} and reference/${rig.output.manifest}`);
