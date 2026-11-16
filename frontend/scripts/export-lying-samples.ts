/**
 * Build-only sample definitions for the lying-family catch experiment.
 *
 *   cd frontend && npm run lying:samples
 *
 * Writes tools/render/build/lying-samples.json:
 *   - bottom pond: target 6p at row 2 col 2, with the below (3s) and left (5p)
 *     casters present;
 *   - front wall: target lower slot 08, with its own upper and the adjacent
 *     uppers (slots 07/09) present.
 *
 * The draw positions come from the real layout; the Blender sample script
 * places the target at the origin and each caster at the listed 3D offset.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShellsManifest } from '../src/table/shellManifest';
import type { ShellsManifest } from '../src/table/shellManifest';
import { layoutPond, layoutWall } from '../src/table/zoneLayout';
import type { LayoutZone, PondDiscard } from '../src/table/zoneLayout';
import type { TileFaceId } from '../src/table/tiles';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tableDir = resolve(scriptDir, '../public/table');
const renderDir = resolve(scriptDir, '../../tools/render');
const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const spec = JSON.parse(readFileSync(join(renderDir, 'shell-spec.json'), 'utf8'));
const thickness =
  (spec.tile.heightUnits * spec.tile.proportionsMm.thickness) / spec.tile.proportionsMm.height;

const FACES: TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s',
];
const POND_DISCARDS: PondDiscard[] = FACES.map((face, index) => ({
  face,
  riichi: index === 16,
}));
const pond = layoutPond(manifest, { discards: POND_DISCARDS, side: 'bottom' });
const pondBody = (face: TileFaceId) => {
  const body = pond.bodies.find((tile) => tile.face === face);
  if (!body) throw new Error(`bottom pond has no ${face}`);
  return body;
};
const targetPond = pondBody('6p');
const belowPond = pondBody('3s');
const leftPond = pondBody('5p');

const wall = layoutWall(manifest, { wall: 'front', doraIndex: 12 });
const wallBodies = (shell: string) => wall.bodies.filter((tile) => tile.shell === shell);
const wallLower = (shell: string) => wallBodies(shell)[0];
const wallUpper = (shell: string) => wallBodies(shell)[1];
const targetWall = wallLower('shell_wall_front_slot_08');
const ownUpper = wallUpper('shell_wall_front_slot_08');
const leftUpper = wallUpper('shell_wall_front_slot_07');
const rightUpper = wallUpper('shell_wall_front_slot_09');
if (!targetWall || !ownUpper || !leftUpper || !rightUpper) {
  throw new Error('front wall sample could not find slots 07/08/09');
}

const drawOf = (tile: { drawX: number; drawY: number }) => [tile.drawX, tile.drawY];
const sample = {
  generatedBy: 'frontend/scripts/export-lying-samples.ts',
  thickness,
  samples: [
    {
      id: 'pond-bottom-6p',
      kind: 'pond',
      zone: 'pond-bottom',
      description: 'bottom pond, target 6p row 2 col 2, below 3s and left 5p',
      target: {
        shell: targetPond.shell,
        face: targetPond.face,
        draw: drawOf(targetPond),
      },
      casters: [
        {
          shell: belowPond.shell,
          face: belowPond.face,
          draw: drawOf(belowPond),
          offset3D: [0, -1, 0],
          contact: 'up',
        },
        {
          shell: leftPond.shell,
          face: leftPond.face,
          draw: drawOf(leftPond),
          offset3D: [-0.75, 0, 0],
          contact: 'right',
        },
      ],
    },
    {
      id: 'wall-front-08-lower',
      kind: 'wall',
      zone: 'wall-front',
      description: 'front wall lower slot 08 with its upper and adjacent uppers 07/09',
      target: {
        shell: targetWall.shell,
        face: targetWall.face,
        draw: drawOf(targetWall),
      },
      casters: [
        {
          shell: ownUpper.shell,
          face: ownUpper.face,
          draw: drawOf(ownUpper),
          offset3D: [0, 0, thickness],
          contact: 'down',
        },
        {
          shell: leftUpper.shell,
          face: leftUpper.face,
          draw: drawOf(leftUpper),
          offset3D: [-0.75, 0, thickness],
          contact: 'right',
        },
        {
          shell: rightUpper.shell,
          face: rightUpper.face,
          draw: drawOf(rightUpper),
          offset3D: [0.75, 0, thickness],
          contact: 'left',
        },
      ],
    },
  ] satisfies Array<{
    id: string;
    kind: string;
    zone: string;
    description: string;
    target: { shell: string; face: TileFaceId | null; draw: number[] };
    casters: Array<{
      shell: string;
      face: TileFaceId | null;
      draw: number[];
      offset3D: number[];
      contact: string;
    }>;
  }>,
};
mkdirSync(resolve(renderDir, 'build'), { recursive: true });
const out = resolve(renderDir, 'build/lying-samples.json');
writeFileSync(out, `${JSON.stringify(sample, null, 2)}\n`);
console.log(`wrote ${out}`);
for (const entry of sample.samples) {
  console.log(
    `  ${entry.id}: target ${entry.target.shell} at ${entry.target.draw.join(',')}, ` +
      `${entry.casters.length} casters`,
  );
}
void (wall as LayoutZone);
