import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { parseShellsManifest } from './shellManifest';
import { layoutPond, layoutWall, layoutSideWall, layoutHand, layoutSideHand, layoutTopHand } from './zoneLayout';
import type { TileFaceId } from './tiles';

it('sizes', () => {
  const m = parseShellsManifest(JSON.parse(readFileSync(join(process.cwd(), 'public/table/shells.json'), 'utf8')));
  const faces: TileFaceId[] = ['1m','2m','3m','4m','5m','6m','7m','8m','9m','1p','2p','3p','4p','5p','6p','7p','8p','9p'];
  for (const side of ['bottom','right','top','left'] as const) {
    const z = layoutPond(m, { discards: faces.map((face, i) => ({ face, riichi: i === 5 })), side });
    console.log('pond', side, z.width, z.height);
  }
  console.log('wallFront', layoutWall(m, { wall: 'front' }).width, layoutWall(m, { wall: 'front' }).height);
  console.log('wallBack', layoutWall(m, { wall: 'back' }).width, layoutWall(m, { wall: 'back' }).height);
  console.log('wallLeft', layoutSideWall(m, { side: 'left' }).width, layoutSideWall(m, { side: 'left' }).height);
  console.log('hand', layoutHand(m, { faces: faces.slice(0,13), draw: '5p' }).width, layoutHand(m, { faces: faces.slice(0,13), draw: '5p' }).height);
  console.log('tophand', layoutTopHand(m, { faces: faces.slice(0,13) }).width, layoutTopHand(m, { faces: faces.slice(0,13) }).height);
  console.log('sidehand', layoutSideHand(m, { side: 'left' }).width, layoutSideHand(m, { side: 'left' }).height);
});
