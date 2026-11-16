/**
 * Enumerate the distinct lying-family catch signatures (ponds + melds) and
 * write the bake jobs for tools/render/bake_lying_catches.py.
 *
 *   cd frontend && npm run lying:export
 *
 * A signature is: target shell | zone side | the nearest primary caster per
 * contact side (shell + relative draw offset). The layout's cell metadata gives
 * the 3-D cell offset used by the bake.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShellsManifest } from '../src/table/shellManifest';
import type { ShellsManifest } from '../src/table/shellManifest';
import { lyingSignature, primaryContacts } from '../src/table/contactOverlays';
import { layoutMeld, layoutPond } from '../src/table/zoneLayout';
import type { LayoutZone, PondDiscard, TableSide } from '../src/table/zoneLayout';
import type { TileFaceId } from '../src/table/tiles';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const renderDir = resolve(scriptDir, '../../tools/render');
const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const FACES: TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s',
];
const SIDES: TableSide[] = ['bottom', 'right', 'top', 'left'];
// The table world axes for a seat: the screen axes with the flat camera's
// screen-y reversed (the camera looks from -Y with no yaw).
const RIGHT_WORLD: Record<TableSide, [number, number]> = {
  bottom: [1, 0],
  right: [0, 1],
  top: [-1, 0],
  left: [0, -1],
};
const DOWN_WORLD: Record<TableSide, [number, number]> = {
  bottom: [0, -1],
  right: [1, 0],
  top: [0, 1],
  left: [-1, 0],
};

interface JobCaster {
  shell: string;
  draw: [number, number];
  side: string;
  offset3D: [number, number, number];
}
interface Job {
  id: string;
  kind: 'pond' | 'melds';
  zoneSide: string;
  target: string;
  targetDraw: [number, number];
  casters: JobCaster[];
  signature: string;
}

const jobs = new Map<string, Job>();
const addZone = (zone: LayoutZone, limit: number): void => {
  if (zone.side === null) return;
  if (jobs.size >= limit) return;
  const right = RIGHT_WORLD[zone.side];
  const down = DOWN_WORLD[zone.side];
  for (let targetIndex = 0; targetIndex < zone.bodies.length; targetIndex += 1) {
    const target = zone.bodies[targetIndex];
    if (!target.cell) continue;
    const primaries = primaryContacts(manifest, zone, targetIndex);
    if (primaries.length === 0) continue;
    const signature = lyingSignature(zone, targetIndex, primaries);
    if (jobs.has(signature)) continue;
    const casters: JobCaster[] = [];
    for (const edge of primaries) {
      const caster = zone.bodies[edge.casterIndex];
      if (!caster.cell) continue;
      let dx = 0;
      let dy = 0;
      if (zone.kind === 'pond') {
        const columnDiff = (caster.cell.column ?? 0) - (target.cell.column ?? 0);
        const rowDiff = (caster.cell.row ?? 0) - (target.cell.row ?? 0);
        dx = columnDiff * 0.75 * right[0] + rowDiff * 1.0 * down[0];
        dy = columnDiff * 0.75 * right[1] + rowDiff * 1.0 * down[1];
      } else {
        const columnDiff = (caster.cell.column ?? 0) - (target.cell.column ?? 0);
        dx = columnDiff * 0.75 * right[0];
        dy = columnDiff * 0.75 * right[1];
      }
      casters.push({
        shell: caster.shell,
        draw: [caster.drawX, caster.drawY],
        side: edge.side,
        offset3D: [dx, dy, 0],
      });
    }
    if (casters.length !== primaries.length) continue;
    jobs.set(signature, {
      id: `lying-${String(jobs.size + 1).padStart(4, '0')}`,
      kind: zone.kind === 'pond' ? 'pond' : 'melds',
      zoneSide: zone.side,
      target: target.shell,
      targetDraw: [target.drawX, target.drawY],
      casters,
      signature,
    });
    if (jobs.size >= limit) return;
  }
};

const LIMIT = 240;
for (const side of SIDES) {
  for (let count = 0; count <= 24; count += 1) {
    for (let riichi = -1; riichi < count; riichi += 1) {
      const discards: PondDiscard[] = FACES.slice(0, count).map((face, index) => ({
        face,
        riichi: index === riichi,
      }));
      addZone(layoutPond(manifest, { discards, side }), LIMIT);
    }
  }
  for (const length of [3, 4]) {
    for (let called = -1; called < length; called += 1) {
      addZone(
        layoutMeld(manifest, {
          faces: FACES.slice(0, length),
          side,
          calledIndex: called < 0 ? null : called,
        }),
        LIMIT,
      );
    }
  }
}

const out = {
  generatedBy: 'frontend/scripts/export-lying-catches.ts',
  combination: 'physical+ao',
  count: jobs.size,
  jobs: [...jobs.values()],
};
mkdirSync(resolve(renderDir, 'build'), { recursive: true });
writeFileSync(resolve(renderDir, 'build/lying-catch-jobs.json'), `${JSON.stringify(out, null, 2)}\n`);
console.log(`lying catch jobs: ${jobs.size}`);
for (const job of jobs.values()) {
  console.log(
    `  ${job.id} ${job.kind}/${job.zoneSide} target ${job.target} ` +
      `${job.casters.length} caster(s) ${job.targetDraw.join(',')}`,
  );
}
