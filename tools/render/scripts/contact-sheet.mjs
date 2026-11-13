#!/usr/bin/env node
/**
 * Assemble the Task 1 contact sheet from the baked spike assets.
 *
 * The sheet is an SVG (images as data URIs) rasterised with the same pinned
 * resvg engine used for the face textures. It shows the body sprite, the lit
 * face decal, the homography composite, the face-down diagnostic, and a pixel
 * zoom of the top edge, with the manifest numbers spelled out so the render can
 * be reviewed without opening Blender.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const renderDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = JSON.parse(readFileSync(resolve(process.argv[2] ?? join(renderDir, 'scene-spec.json')), 'utf8'));
const outDir = resolve(process.argv[3] ?? join(renderDir, 'spike'));
const packageJson = JSON.parse(readFileSync(join(renderDir, 'package.json'), 'utf8'));
const resvgVersion = packageJson.dependencies['@resvg/resvg-js'];
const manifest = JSON.parse(readFileSync(join(outDir, spec.outputs.manifest), 'utf8'));
const slot = manifest.slots[0];
const slotIndex = slot.id.split('-').pop();
const decalCode = spec.spike.decal.code;
const orientation = spec.spike.decal.orientation;

const png = (file) => `data:image/png;base64,${readFileSync(join(outDir, file)).toString('base64')}`;

/** Read a PNG's intrinsic size from its IHDR chunk. */
const pngSize = (file) => {
  const buffer = readFileSync(join(outDir, file));
  if (buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
};

const bodyFile = slot.body;
const backFile = spec.outputs.back.replace('{index}', slotIndex);
const decalFile = manifest.faces[decalCode][orientation];
const compositeFile = spec.outputs.composite.replace('{code}', decalCode).replace('{orientation}', orientation);

const bodyHref = png(bodyFile);
const backHref = png(backFile);
const decalHref = png(decalFile);
const compositeHref = png(compositeFile);
const zoomHref = png(spec.outputs.zoom);

const escape = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SANS = 'Fira Sans, DejaVu Sans, sans-serif';
const MONO = 'Fira Mono, DejaVu Sans Mono, monospace';

const panelHeight = 608;
const bodyScale = panelHeight / slot.height;
const bodyWidth = slot.width * bodyScale;
const backSize = pngSize(backFile);
const backWidth = backSize.width * (panelHeight / backSize.height);
const decalScale = panelHeight / manifest.decals.pixels[1];
const decalWidth = manifest.decals.pixels[0] * decalScale;
const gap = 60;
const margin = 48;
const panelsTop = 150;
const zoomCrop = spec.spike.zoom;
const zoomScale = zoomCrop.scale;
const zoomWidth = zoomCrop.width * zoomScale;
const zoomHeight = zoomCrop.height * zoomScale;

const felt = (width) => `<rect x="0" y="0" width="${width}" height="${panelHeight}" fill="${spec.table.surface.hex}"/>`;
const checker = (width) => `<rect x="0" y="0" width="${width}" height="${panelHeight}" fill="url(#checker)"/>`;

const panels = [
  {
    caption: 'Body sprite (alpha, baked contact shadow)',
    href: bodyHref,
    width: bodyWidth,
    background: felt(bodyWidth),
  },
  {
    caption: 'Composite: body + decal, real slot',
    href: compositeHref,
    width: bodyWidth,
    background: felt(bodyWidth),
  },
  {
    caption: 'Face decal: carved, painted, lit (1 px gutter)',
    href: decalHref,
    width: decalWidth,
    background: checker(decalWidth),
  },
  {
    caption: 'Back pose (diagnostic): blue backing wraps every edge',
    href: backHref,
    width: backWidth,
    background: felt(backWidth),
  },
];

let cursor = margin;
for (const panel of panels) {
  panel.x = cursor;
  cursor += panel.width + gap;
}
const sheetWidth = Math.ceil(cursor - gap + margin);
const zoomTop = panelsTop + panelHeight + 78;
const statsLeft = margin + zoomWidth + 48;
const sheetHeight = Math.ceil(zoomTop + zoomHeight + 64);

const panelSvg = (panel) => `
  <text x="${panel.x}" y="136" font-family="${SANS}" font-size="16" fill="#a8c7b8">${escape(panel.caption)}</text>
  <g transform="translate(${panel.x} ${panelsTop})">
    ${panel.background}
    <image x="0" y="0" width="${panel.width}" height="${panelHeight}" href="${panel.href}"/>
    <rect x="0.5" y="0.5" width="${panel.width - 1}" height="${panelHeight - 1}" fill="none" stroke="#24382f"/>
  </g>`;

const tile = manifest.tile;
const stats = [
  `tile   ${tile.proportionsMm.height} x ${tile.proportionsMm.width} x ${tile.proportionsMm.thickness} mm (h x w x t), ${tile.material}`,
  `       = ${tile.units.height.toFixed(2)} x ${tile.units.width.toFixed(2)} x ${tile.units.thickness.toFixed(4)} units, backing ${Math.round(tile.backEdgeFraction * 100)}%`,
  `body   x=${slot.x} y=${slot.y} w=${slot.width} h=${slot.height} px (device, ${manifest.pixelRatio}x)`,
  `face   TL ${slot.faceQuad[0].join(', ')}  TR ${slot.faceQuad[1].join(', ')}`,
  `       BR ${slot.faceQuad[2].join(', ')}  BL ${slot.faceQuad[3].join(', ')}`,
  `sliver ${manifest.measurements.blueSliverMeasuredPx} px measured, ${manifest.measurements.blueSliverExpectedPx} px expected`,
  `edge   ${manifest.measurements.topEdgeProjectedPx} px top edge / ${manifest.measurements.faceHeightPx} px face`,
  `decal  ${manifest.decals.pixels[0]}x${manifest.decals.pixels[1]} px, ${manifest.decals.paddingPixels} px gutter`,
  `carve  ${manifest.decals.carve.depthUnits} units deep (${Math.round(manifest.decals.carve.depthFractionOfThickness * 1000) / 10}% of thickness), ${manifest.decals.carve.grid.join('x')} grid`,
  `       paint edge ${Math.round(manifest.decals.carve.paintThreshold * 100)}% of lip, occlusion ${manifest.decals.carve.occlusionDistance} / ${manifest.decals.carve.occlusionStrength}`,
  `orientation ${slot.orientation}   drawOrder ${slot.drawOrder}   gutter ${slot.shadowGutterPx} px`,
  `back   ${backFile} ${backSize.width}x${backSize.height} px (diagnostic only)`,
];

const matrixLines = slot.faceMatrix.match(/.{1,78}/g) ?? [];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetWidth}" height="${sheetHeight}" viewBox="0 0 ${sheetWidth} ${sheetHeight}">
  <defs>
    <pattern id="checker" width="16" height="16" patternUnits="userSpaceOnUse">
      <rect width="16" height="16" fill="#1a2c25"/>
      <rect width="8" height="8" fill="#22382e"/>
      <rect x="8" y="8" width="8" height="8" fill="#22382e"/>
    </pattern>
  </defs>

  <rect width="${sheetWidth}" height="${sheetHeight}" fill="#0d1713"/>

  <text x="${margin}" y="58" font-family="${SANS}" font-size="30" fill="#eef5f0">Rendered table spike: body sprite + lit face decal</text>
  <text x="${margin}" y="90" font-family="${SANS}" font-size="17" fill="#8fb2a4">Blender ${manifest.blender} · Cycles ${spec.scene.samples} samples · AgX · ${manifest.pixelRatio}x device pixels · slot ${slot.id} (${slot.orientation}) · ${decalCode} face</text>

  ${panels.map(panelSvg).join('')}

  <text x="${margin}" y="${zoomTop - 16}" font-family="${SANS}" font-size="16" fill="#a8c7b8">Composite top-left corner, ${zoomScale}x nearest: blue backing sliver above the white front edge, key-lit bevel</text>
  <g transform="translate(${margin} ${zoomTop})">
    <rect x="0" y="0" width="${zoomWidth}" height="${zoomHeight}" fill="${spec.table.surface.hex}"/>
    <image x="0" y="0" width="${zoomWidth}" height="${zoomHeight}" href="${zoomHref}"/>
  </g>
  <rect x="${margin + 0.5}" y="${zoomTop + 0.5}" width="${zoomWidth - 1}" height="${zoomHeight - 1}" fill="none" stroke="#24382f"/>

  <g font-family="${MONO}" font-size="14" fill="#b9d6c7">
    ${stats.map((line, index) => `<text x="${statsLeft}" y="${zoomTop + 18 + index * 22}">${escape(line)}</text>`).join('\n    ')}
    <text x="${statsLeft}" y="${zoomTop + 18 + stats.length * 22 + 14}" fill="#7fa18f">faceMatrix (decal px → scene device px):</text>
    ${matrixLines.map((line, index) => `<text x="${statsLeft}" y="${zoomTop + 18 + stats.length * 22 + 36 + index * 16}" font-size="11" fill="#7fa18f">${escape(line)}</text>`).join('\n    ')}
  </g>

  <text x="${margin}" y="${sheetHeight - 20}" font-family="${SANS}" font-size="13" fill="#5f7d6e">Generated by bash tools/render/render.sh · rasteriser @resvg/resvg-js ${resvgVersion} · never hand-edit these files</text>
</svg>
`;

const sheetPath = join(outDir, spec.outputs.contactSheet);
const resvg = new Resvg(svg, {
  font: { loadSystemFonts: true },
  fitTo: { mode: 'width', value: sheetWidth },
});
writeFileSync(sheetPath, resvg.render().asPng());
console.log(`[render] contact sheet: ${sheetPath} (${sheetWidth}x${sheetHeight})`);
