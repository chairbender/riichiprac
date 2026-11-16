/**
 * Export the layout inputs the Phase 3.5 contact-shadow bake and checks need.
 *
 *   cd frontend && npm run overlays:export -- --sides    # before the bake
 *   cd frontend && npm run overlays:export -- --fixture  # after the bake
 *
 * `--sides` runs the real layout over every composition the engine supports and
 * writes `tools/render/build/overlays-sides.json`: the exact set of
 * `(caster shell, screen side)` pairs the baker must produce. The bake consumes
 * it, so the asset set cannot drift from `zoneLayout.ts`.
 *
 * `--fixture` writes the committed `tools/render/overlay-zones.json`, the
 * representative zones with their resolved contact edges and decals. It is the
 * dependency-free checker's input; `contactOverlays.test.ts` re-runs the layout
 * and rejects any drift between the fixture and the code.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contactEdges, resolveContactOverlays } from '../src/table/contactOverlays';
import type { ContactEdge, ContactOverlay } from '../src/table/contactOverlays';
import { parseCatchesManifest } from '../src/table/catchManifest';
import type { CatchesManifest } from '../src/table/catchManifest';
import { parseOverlayManifest } from '../src/table/overlayManifest';
import type { OverlayManifest } from '../src/table/overlayManifest';
import { parseShellsManifest } from '../src/table/shellManifest';
import type { ShellsManifest } from '../src/table/shellManifest';
import type { TileFaceId } from '../src/table/tiles';
import {
  layoutHand,
  layoutMeld,
  layoutPond,
  layoutSideHand,
  layoutSideWall,
  layoutTopHand,
  layoutWall,
} from '../src/table/zoneLayout';
import type { LayoutZone, PondDiscard } from '../src/table/zoneLayout';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, '../..');
const tableDir = resolve(repoDir, 'frontend/public/table');
const renderDir = resolve(repoDir, 'tools/render');
const buildDir = resolve(renderDir, 'build');

const manifestPath = join(tableDir, 'shells.json');
const overlaysPath = join(tableDir, 'overlays.json');
const catchesPath = join(tableDir, 'catches.json');
const shellSpec = JSON.parse(readFileSync(join(renderDir, 'shell-spec.json'), 'utf8'));
const enabledFamilies: string[] = shellSpec.overlay?.enabledFamilies ?? [];
if (enabledFamilies.length === 0) {
  throw new Error('shell-spec.json overlay.enabledFamilies is empty');
}
const overlayEnabled = (shell: string): boolean =>
  enabledFamilies.some((family) => shell.startsWith(family));

const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(manifestPath, 'utf8')),
);

const FACES: TileFaceId[] = [
  '1m',
  '2m',
  '3m',
  '4m',
  '5m',
  '6m',
  '7m',
  '8m',
  '9m',
  '1p',
  '2p',
  '3p',
  '4p',
  '5p',
  '6p',
  '7p',
  '8p',
  '9p',
  '1s',
  '2s',
  '3s',
  '4s',
  '5s',
  '6s',
];

const SIDES = ['bottom', 'right', 'top', 'left'] as const;

type SideKey = `${string}:${string}`;

interface SidesReport {
  readonly generatedBy: string;
  readonly zones: number;
  readonly contacts: number;
  readonly sides: Readonly<Record<SideKey, number>>;
}

/** Every composition the seven layout builders can produce. */
function stressZones(): LayoutZone[] {
  const zones: LayoutZone[] = [];

  // Ponds: every length, every Riichi position, all four seats.
  for (const side of SIDES) {
    for (let count = 0; count <= FACES.length; count += 1) {
      for (let riichi = -1; riichi < count; riichi += 1) {
        const discards: PondDiscard[] = FACES.slice(0, count).map((face, index) => ({
          face,
          riichi: index === riichi,
        }));
        zones.push(layoutPond(manifest, { discards, side }));
      }
    }
  }

  // Human hand: every length, plus the drawn tile.
  for (let count = 1; count <= 13; count += 1) {
    zones.push(layoutHand(manifest, { faces: FACES.slice(0, count) }));
  }
  zones.push(layoutHand(manifest, { faces: FACES.slice(0, 13), draw: '5p' }));

  // Top hand: every length.
  for (let count = 1; count <= 13; count += 1) {
    zones.push(layoutTopHand(manifest, { faces: FACES.slice(0, count) }));
  }

  // Side hands: every length on both sides.
  for (const side of ['left', 'right'] as const) {
    for (let count = 1; count <= 13; count += 1) {
      zones.push(layoutSideHand(manifest, { side, count }));
    }
  }

  // Melds: 3 and 4 tiles, every called position, all four seats.
  for (const side of SIDES) {
    for (const length of [3, 4]) {
      for (let calledIndex = -1; calledIndex < length; calledIndex += 1) {
        zones.push(
          layoutMeld(manifest, {
            faces: FACES.slice(0, length),
            side,
            calledIndex: calledIndex < 0 ? null : calledIndex,
          }),
        );
      }
    }
  }

  // Walls: every remaining run from every start, every dora position.
  for (const wall of ['front', 'back'] as const) {
    for (let count = 1; count <= 17; count += 1) {
      for (let startIndex = 0; startIndex + count <= 17; startIndex += 1) {
        for (let dora = -1; dora < count; dora += 1) {
          zones.push(
            layoutWall(manifest, {
              wall,
              count,
              startIndex,
              doraIndex: dora < 0 ? null : startIndex + dora,
            }),
          );
        }
      }
    }
  }

  // Side walls: the same run/dora matrix.
  for (const side of ['left', 'right'] as const) {
    for (let count = 1; count <= 17; count += 1) {
      for (let startIndex = 0; startIndex + count <= 17; startIndex += 1) {
        for (let dora = -1; dora < count; dora += 1) {
          zones.push(
            layoutSideWall(manifest, {
              side,
              count,
              startIndex,
              doraIndex: dora < 0 ? null : startIndex + dora,
            }),
          );
        }
      }
    }
  }

  return zones;
}

function writeSides(): void {
  const zones = stressZones();
  const sides = new Map<SideKey, number>();
  let contacts = 0;
  for (const zone of zones) {
    for (const edge of contactEdges(manifest, zone)) {
      const shell = zone.bodies[edge.casterIndex].shell;
      if (!overlayEnabled(shell)) continue;
      contacts += 1;
      const key: SideKey = `${shell}:${edge.side}`;
      sides.set(key, (sides.get(key) ?? 0) + 1);
    }
  }
  const report: SidesReport = {
    generatedBy: 'frontend/scripts/export-overlays.ts --sides',
    zones: zones.length,
    contacts,
    sides: Object.fromEntries([...sides.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };
  mkdirSync(buildDir, { recursive: true });
  const out = join(buildDir, 'overlays-sides.json');
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `overlay sides: ${zones.length} stress zones, ${contacts} contacts, ` +
      `${Object.keys(report.sides).length} decals to bake`,
  );
  const byShell = new Map<string, string[]>();
  for (const key of Object.keys(report.sides)) {
    const [shell, side] = key.split(':');
    byShell.set(shell, [...(byShell.get(shell) ?? []), side]);
  }
  for (const [shell, list] of [...byShell.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${shell.padEnd(34)} ${list.join(', ')}`);
  }
  console.log(`wrote ${out}`);
}

// --------------------------------------------------------------------------- //
// The committed fixture: representative zones with resolved decals.
// --------------------------------------------------------------------------- //

const POND_SEATS = ['bottom', 'right', 'top', 'left'] as const;
const pondDiscards: PondDiscard[] = FACES.map((face, index) => ({
  face,
  riichi: index === 16,
}));

interface FixtureBody {
  readonly shell: string;
  readonly drawX: number;
  readonly drawY: number;
}

interface FixtureZone {
  readonly id: string;
  readonly kind: string;
  readonly side: string | null;
  readonly layer: number;
  readonly width: number;
  readonly height: number;
  readonly sigmaPx1x: number;
  readonly blurPad: number;
  readonly rotationDeg: number;
  readonly pivotX: number;
  readonly pivotY: number;
  readonly bodies: readonly FixtureBody[];
  readonly shadows: readonly { readonly shell: string; readonly gridX: number; readonly gridY: number }[];
  readonly contacts: readonly Pick<ContactEdge, 'bodyIndex' | 'casterIndex' | 'side'>[];
  readonly overlays: readonly Pick<
    ContactOverlay,
    | 'bodyIndex'
    | 'casterIndex'
    | 'shell'
    | 'contact'
    | 'kind'
    | 'drawX'
    | 'drawY'
    | 'texWidth'
    | 'texHeight'
  >[];
}

function fixtureOf(zone: LayoutZone, overlays: OverlayManifest, catches: CatchesManifest): FixtureZone {
  return {
    id: zone.id,
    kind: zone.kind,
    side: zone.side,
    layer: zone.layer,
    width: zone.width,
    height: zone.height,
    sigmaPx1x: zone.sigmaPx1x,
    blurPad: zone.blurPad,
    rotationDeg: zone.rotationDeg,
    pivotX: zone.pivotX,
    pivotY: zone.pivotY,
    bodies: zone.bodies.map((tile) => ({
      shell: tile.shell,
      drawX: tile.drawX,
      drawY: tile.drawY,
    })),
    shadows: zone.shadows.map((tile) => ({
      shell: tile.shell,
      gridX: tile.gridX,
      gridY: tile.gridY,
    })),
    // The clip polygon is derived from `overlays.bodyQuads` at check time, so
    // the fixture stays small and cannot disagree with the committed assets.
    contacts: (() => {
      const resolved = resolveContactOverlays(manifest, overlays, zone, catches);
      const active = new Set(
        resolved.map((overlay) => `${overlay.bodyIndex}:${overlay.casterIndex}:${overlay.contact}`),
      );
      return contactEdges(manifest, zone)
        .filter((edge) => active.has(`${edge.bodyIndex}:${edge.casterIndex}:${edge.side}`))
        .map((edge) => ({
          bodyIndex: edge.bodyIndex,
          casterIndex: edge.casterIndex,
          side: edge.side,
        }));
    })(),
    overlays: resolveContactOverlays(manifest, overlays, zone, catches).map((overlay) => ({
      bodyIndex: overlay.bodyIndex,
      casterIndex: overlay.casterIndex,
      shell: overlay.shell,
      contact: overlay.contact,
      kind: overlay.kind,
      drawX: overlay.drawX,
      drawY: overlay.drawY,
      texWidth: overlay.texWidth,
      texHeight: overlay.texHeight,
    })),
  };
}

function writeFixture(): void {
  const overlays = parseOverlayManifest(JSON.parse(readFileSync(overlaysPath, 'utf8')));
  const catches = parseCatchesManifest(JSON.parse(readFileSync(catchesPath, 'utf8')));
  const zones: LayoutZone[] = [
    ...POND_SEATS.map((side) => layoutPond(manifest, { discards: pondDiscards, side })),
    { ...layoutPond(manifest, { discards: pondDiscards.slice(0, 6), side: 'bottom' }), id: 'pond-bottom-6' },
    layoutHand(manifest, { faces: FACES.slice(0, 13) }),
    layoutHand(manifest, { faces: FACES.slice(0, 13), draw: '5p', id: 'hand-bottom-draw' }),
    layoutTopHand(manifest, { faces: FACES.slice(0, 13) }),
    layoutSideHand(manifest, { side: 'left' }),
    layoutSideHand(manifest, { side: 'right' }),
    layoutMeld(manifest, { faces: FACES.slice(0, 3), side: 'bottom', calledIndex: 1 }),
    layoutMeld(manifest, { faces: FACES.slice(0, 4), side: 'right', calledIndex: 2 }),
    layoutWall(manifest, { wall: 'front', doraIndex: 12 }),
    layoutWall(manifest, { wall: 'back', doraIndex: 12 }),
    layoutSideWall(manifest, { side: 'left', doraIndex: 5 }),
    layoutSideWall(manifest, { side: 'right', doraIndex: 5 }),
  ];
  const fixture = {
    version: 1,
    generatedBy: 'frontend/scripts/export-overlays.ts --fixture',
    zones: zones.map((zone) => fixtureOf(zone, overlays, catches)),
  };
  const out = join(renderDir, 'overlay-zones.json');
  writeFileSync(out, `${JSON.stringify(fixture, null, 1)}\n`);
  let contacts = 0;
  let decalCount = 0;
  let missing = 0;
  for (const zone of fixture.zones) {
    contacts += zone.contacts.length;
    decalCount += zone.overlays.length;
    missing += zone.contacts.length - zone.overlays.length;
  }
  console.log(
    `overlay fixture: ${zones.length} zones, ${contacts} contacts, ` +
      `${decalCount} resolved decals, ${missing} missing`,
  );
  for (const zone of fixture.zones) {
    console.log(
      `  ${zone.id.padEnd(16)} ${String(zone.bodies.length).padStart(3)} bodies ` +
        `${String(zone.contacts.length).padStart(3)} contacts ` +
        `${String(zone.overlays.length).padStart(3)} decals` +
        (zone.rotationDeg === 0 ? '' : ` lean ${zone.rotationDeg}°`),
    );
  }
  console.log(`wrote ${out}`);
  if (missing > 0) {
    throw new Error(`${missing} contact(s) have no published decal; run the bake`);
  }
}

const args = process.argv.slice(2);
const sidesMode = args.includes('--sides');
const fixtureMode = args.includes('--fixture');
if (!sidesMode && !fixtureMode) {
  console.error('usage: export-overlays.ts --sides | --fixture');
  process.exit(2);
}
if (sidesMode) writeSides();
if (fixtureMode) writeFixture();
