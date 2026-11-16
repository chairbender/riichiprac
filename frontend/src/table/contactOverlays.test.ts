import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isOverlayEnabled, parseOverlayManifest } from './overlayManifest';
import type { OverlayManifest } from './overlayManifest';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest } from './shellManifest';
import {
  contactEdges,
  resolveContactOverlays,
  validateOverlayCoverage,
} from './contactOverlays';
import {
  layoutHand,
  layoutMeld,
  layoutPond,
  layoutSideHand,
  layoutSideWall,
  layoutTopHand,
  layoutWall,
} from './zoneLayout';
import type { LayoutZone, PondDiscard } from './zoneLayout';
import type { TileFaceId } from './tiles';

const tableDir = fileURLToPath(new URL('../../public/table/', import.meta.url));
const renderDir = fileURLToPath(new URL('../../../tools/render/', import.meta.url));
const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);
const overlays: OverlayManifest = parseOverlayManifest(
  JSON.parse(readFileSync(join(tableDir, 'overlays.json'), 'utf8')),
);
const fixture = JSON.parse(readFileSync(join(renderDir, 'overlay-zones.json'), 'utf8'));

const FACES: TileFaceId[] = [
  '1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m',
  '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p',
  '1s', '2s', '3s', '4s', '5s', '6s',
];
const SIDES = ['bottom', 'right', 'top', 'left'] as const;
const POND_DISCARDS: PondDiscard[] = FACES.map((face, index) => ({
  face,
  riichi: index === 16,
}));

const fixtureZones = (): LayoutZone[] => [
  ...SIDES.map((side) => layoutPond(manifest, { discards: POND_DISCARDS, side })),
  { ...layoutPond(manifest, { discards: POND_DISCARDS.slice(0, 6) }), id: 'pond-bottom-6' },
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

const shapeOf = (zone: LayoutZone) => ({
  id: zone.id,
  bodies: zone.bodies.map((body) => ({
    shell: body.shell,
    drawX: body.drawX,
    drawY: body.drawY,
  })),
  contacts: contactEdges(manifest, zone)
    .filter((edge) => isOverlayEnabled(overlays, zone.bodies[edge.casterIndex].shell))
    .map((edge) => ({
      bodyIndex: edge.bodyIndex,
      casterIndex: edge.casterIndex,
      side: edge.side,
    })),
  overlays: resolveContactOverlays(manifest, overlays, zone).map((overlay) => ({
    bodyIndex: overlay.bodyIndex,
    casterIndex: overlay.casterIndex,
    shell: overlay.shell,
    contact: overlay.contact,
    drawX: overlay.drawX,
    drawY: overlay.drawY,
    texWidth: overlay.texWidth,
    texHeight: overlay.texHeight,
  })),
});

describe('overlay manifest', () => {
  it('publishes every shell and every decal shell a clip polygon', () => {
    expect(Object.keys(overlays.bodyQuads).sort()).toEqual(
      Object.keys(manifest.shells).sort(),
    );
    for (const decal of Object.values(overlays.decals)) {
      expect(overlays.bodyQuads[decal.shell], decal.shell).toBeDefined();
      expect(overlays.bodyQuads[decal.shell].length).toBeGreaterThanOrEqual(3);
    }
  });

  it('enables only the human hand fan and publishes the right-side override', () => {
    expect(overlays.enabled.families).toContain('shell_hand_slot_');
    expect(overlays.model.sideOverrides.right).toEqual({ coreAlpha: 0.5, sigmaPx1x: 2.5 });
    for (const decal of Object.values(overlays.decals)) {
      expect(decal.shell.startsWith('shell_hand_slot_')).toBe(true);
      const expected = decal.contact === 'right' ? 0.5 : 0.35;
      expect(decal.peakAlpha).toBeGreaterThan(expected - 0.02);
      expect(decal.peakAlpha).toBeLessThanOrEqual(expected + 0.001);
    }
  });

  it('resolves the _faceup wall aliases to their face-down twin', () => {
    expect(overlays.aliases.shell_wall_front_slot_08_faceup).toBe(
      'shell_wall_front_slot_08',
    );
    expect(overlays.aliases.shell_wall_side_left_faceup).toBe('shell_wall_side_left');
  });

  it('rejects a document with a missing clip or a bad side', () => {
    const broken = structuredClone(overlays) as unknown as Record<string, unknown>;
    delete (broken.bodyQuads as Record<string, unknown>).shell_hand_slot_06;
    expect(() => parseOverlayManifest(broken)).toThrow(/bodyQuads/);

    const side = structuredClone(overlays) as unknown as {
      decals: Record<string, { contact: string; shell: string }>;
      [key: string]: unknown;
    };
    const first = Object.values(side.decals)[0];
    first.contact = 'sideways';
    expect(() => parseOverlayManifest(side)).toThrow(/contact/);
  });
});

describe('contact edges', () => {
  it('matches the committed fixture exactly', () => {
    type FixtureZone = {
      id: string;
      bodies: Array<{ shell: string; drawX: number; drawY: number }>;
      contacts: unknown;
      overlays: unknown;
    };
    const expected = (fixture.zones as FixtureZone[]).map((zone) => ({
      id: zone.id,
      bodies: zone.bodies.map((body) => ({
        shell: body.shell,
        drawX: body.drawX,
        drawY: body.drawY,
      })),
      contacts: zone.contacts,
      overlays: zone.overlays,
    }));
    const actual = fixtureZones().map(shapeOf);
    expect(actual.map((zone) => zone.id)).toEqual(expected.map((zone) => zone.id));
    for (let index = 0; index < expected.length; index += 1) {
      expect(actual[index]).toEqual(expected[index]);
    }
  });

  it('uses a whole-pixel decal position and attaches it to an earlier body', () => {
    for (const zone of fixtureZones()) {
      for (const overlay of resolveContactOverlays(manifest, overlays, zone)) {
        expect(Number.isInteger(overlay.drawX)).toBe(true);
        expect(Number.isInteger(overlay.drawY)).toBe(true);
        expect(overlay.bodyIndex).toBeLessThan(overlay.casterIndex);
        expect(overlay.texWidth).toBeGreaterThan(0);
        expect(overlay.texHeight).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every clip polygon inside the neighbour advance box', () => {
    for (const zone of fixtureZones()) {
      for (const overlay of resolveContactOverlays(manifest, overlays, zone)) {
        const neighbour = zone.bodies[overlay.bodyIndex];
        const shell = manifest.shells[neighbour.shell];
        const left = neighbour.drawX + shell.padding.left;
        const top = neighbour.drawY + shell.padding.top;
        for (const [x, y] of overlay.clip.points) {
          expect(x).toBeGreaterThanOrEqual(left);
          expect(x).toBeLessThanOrEqual(left + shell.advanceWidth);
          expect(y).toBeGreaterThanOrEqual(top);
          expect(y).toBeLessThanOrEqual(top + shell.advanceHeight);
        }
      }
    }
  });

  it('does not invent a contact for a single tile', () => {
    const zone = layoutPond(manifest, { discards: [{ face: '1m' }] });
    expect(contactEdges(manifest, zone)).toEqual([]);
    expect(resolveContactOverlays(manifest, overlays, zone)).toEqual([]);
  });

  it('keeps the disabled families unshadowed and enables the hand', () => {
    const pond = layoutPond(manifest, { discards: POND_DISCARDS });
    const wall = layoutWall(manifest, { wall: 'front', doraIndex: 12 });
    expect(resolveContactOverlays(manifest, overlays, pond)).toEqual([]);
    expect(resolveContactOverlays(manifest, overlays, wall)).toEqual([]);
    const hand = layoutHand(manifest, { faces: FACES.slice(0, 13), draw: '5p' });
    expect(resolveContactOverlays(manifest, overlays, hand).length).toBeGreaterThan(0);
  });

  it('derives the side hand L-shaped sliver as two contact sides', () => {
    const zone = layoutSideHand(manifest, { side: 'left' });
    const contacts = contactEdges(manifest, zone);
    const sides = new Set(contacts.map((edge) => edge.side));
    expect(sides.has('up')).toBe(true);
    expect(contacts.length).toBeGreaterThan(0);
  });

  it('covers every contact in the supported stress matrix', () => {
    const zones: LayoutZone[] = [];
    for (const side of SIDES) {
      for (let count = 0; count <= FACES.length; count += 1) {
        for (let riichi = -1; riichi < count; riichi += 1) {
          zones.push(
            layoutPond(manifest, {
              discards: FACES.slice(0, count).map((face, index) => ({
                face,
                riichi: index === riichi,
              })),
              side,
            }),
          );
        }
      }
    }
    for (let count = 1; count <= 13; count += 1) {
      zones.push(layoutHand(manifest, { faces: FACES.slice(0, count) }));
      zones.push(layoutTopHand(manifest, { faces: FACES.slice(0, count) }));
      zones.push(layoutSideHand(manifest, { side: 'left', count }));
      zones.push(layoutSideHand(manifest, { side: 'right', count }));
    }
    zones.push(layoutHand(manifest, { faces: FACES.slice(0, 13), draw: '5p' }));
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
    expect(validateOverlayCoverage(manifest, overlays, zones)).toEqual([]);
  }, 30_000);
});
