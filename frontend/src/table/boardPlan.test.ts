import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { GameState } from '../types/game';
import {
  buildBoardPlan,
  handFaces,
  meldFaces,
  zoneVisualBounds,
} from './boardPlan';
import type { BoardPlan, BoardZone } from './boardPlan';
import { parseShellsManifest } from './shellManifest';
import type { ShellsManifest } from './shellManifest';
import { checkBoardPlan, failedChecks } from './boardChecks';

const tableDir = join(process.cwd(), 'public', 'table');
const manifest: ShellsManifest = parseShellsManifest(
  JSON.parse(readFileSync(join(tableDir, 'shells.json'), 'utf8')),
);

const scenariosDir = join(process.cwd(), 'public', 'scenarios');
const packManifest = JSON.parse(
  readFileSync(join(scenariosDir, 'manifest.json'), 'utf8'),
) as { packs: Array<{ path: string }> };
const pack = JSON.parse(
  gunzipSync(
    readFileSync(join(scenariosDir, packManifest.packs[0].path)),
  ).toString('utf8'),
) as { scenarios: Array<{ lesson_id: string; state: GameState }> };
const fixture = pack.scenarios.find(
  (scenario) => scenario.lesson_id === 'ryanmen_protorun',
);
if (!fixture) throw new Error('fixture pack is missing ryanmen_protorun');
const state = fixture.state;

const zoneById = (plan: BoardPlan, id: string): BoardZone => {
  const entry = plan.zones.find((candidate) => candidate.zone.id === id);
  if (!entry) throw new Error(`no zone ${id}`);
  return entry;
};

/** The zone's placed rect: bodies plus their hard shadows, no blur tail. */
const rect = (entry: BoardZone) => ({
  left: entry.x,
  top: entry.y,
  right: entry.x + entry.zone.width,
  bottom: entry.y + entry.zone.height,
});

/** The placed rect plus the Gaussian tail, i.e. what the canvas must reserve. */
const edges = (entry: BoardZone) => {
  const bounds = zoneVisualBounds(entry.zone);
  return {
    left: entry.x + bounds.left,
    top: entry.y + bounds.top,
    right: entry.x + bounds.right,
    bottom: entry.y + bounds.bottom,
  };
};

const player = (game: GameState, seat: number) => {
  const found = game.players.find((candidate) => candidate.seat === seat);
  if (!found) throw new Error(`no player in seat ${seat}`);
  return found;
};

describe('buildBoardPlan', () => {
  const plan = buildBoardPlan(state, manifest);

  it('places the four walls, four ponds and all four hands', () => {
    const ids = plan.zones.map((entry) => entry.zone.id);
    for (const id of [
      'wall-back',
      'wall-front',
      'wall-side-left',
      'wall-side-right',
      'pond-bottom',
      'pond-right',
      'pond-top',
      'pond-left',
      'hand-bottom',
      'hand-top',
      'hand-left',
      'hand-right',
    ]) {
      expect(ids, id).toContain(id);
    }
    // The human's one open meld is a zone of its own.
    expect(ids.filter((id) => id.startsWith('melds-bottom'))).toHaveLength(1);
  });

  it('returns zones in Task 4.1 painter order with the human hand last', () => {
    for (let index = 1; index < plan.zones.length; index += 1) {
      expect(
        plan.zones[index].zone.layer,
        plan.zones[index].zone.id,
      ).toBeGreaterThanOrEqual(plan.zones[index - 1].zone.layer);
    }
    const last = plan.zones[plan.zones.length - 1];
    expect(last.zone.id).toBe('hand-bottom');
    expect(last.zone.layer).toBe(6);
  });

  it('rings the ponds with the walls and the hands outside them', () => {
    const centre = plan.centreGapPx;
    const bottomPond = zoneById(plan, 'pond-bottom');
    const topPond = zoneById(plan, 'pond-top');
    const leftPond = zoneById(plan, 'pond-left');
    const rightPond = zoneById(plan, 'pond-right');
    const frontWall = zoneById(plan, 'wall-front');
    const backWall = zoneById(plan, 'wall-back');
    const leftWall = zoneById(plan, 'wall-side-left');
    const rightWall = zoneById(plan, 'wall-side-right');
    const bottomHand = zoneById(plan, 'hand-bottom');
    const topHand = zoneById(plan, 'hand-top');

    // Pond inner edges sit on the centre well. The board is normalised, so the
    // absolute centre is derived: the horizontal and vertical midpoints of the
    // four inner edges must agree, and each pair is one well apart.
    const bottomEdge = rect(bottomPond).top;
    const topEdge = rect(topPond).bottom;
    const leftEdge = rect(leftPond).right;
    const rightEdge = rect(rightPond).left;
    expect((bottomEdge - topEdge) / 2).toBeCloseTo(centre, 6);
    expect((rightEdge - leftEdge) / 2).toBeCloseTo(centre, 6);
    // The published table centre is the well the compass sits in.
    expect(bottomEdge).toBeCloseTo(plan.centreY + centre, 6);
    expect(topEdge).toBeCloseTo(plan.centreY - centre, 6);
    expect(rightEdge).toBeCloseTo(plan.centreX + centre, 6);
    expect(leftEdge).toBeCloseTo(plan.centreX - centre, 6);

    // Far to near: pond, wall, hand.
    expect(rect(frontWall).top).toBeGreaterThan(rect(bottomPond).bottom);
    expect(rect(frontWall).bottom).toBeLessThan(rect(bottomHand).top);
    expect(rect(backWall).bottom).toBeLessThan(rect(topPond).top);
    expect(rect(backWall).top).toBeGreaterThan(rect(topHand).bottom);

    // Left to right: hand, wall, pond (mirrored on the right).
    expect(rect(leftWall).right).toBeLessThan(rect(leftPond).left);
    expect(rect(zoneById(plan, 'hand-left')).left).toBeLessThan(
      rect(leftWall).left,
    );
    expect(rect(rightWall).left).toBeGreaterThan(rect(rightPond).right);
    expect(rect(zoneById(plan, 'hand-right')).right).toBeGreaterThan(
      rect(rightWall).right,
    );
  });

  it('keeps every placed zone clear of every other one', () => {
    const bounds = plan.zones.map((entry) => ({
      id: entry.zone.id,
      ...rect(entry),
    }));
    for (let first = 0; first < bounds.length; first += 1) {
      for (let second = first + 1; second < bounds.length; second += 1) {
        const left = bounds[first];
        const right = bounds[second];
        const overlapX =
          Math.min(left.right, right.right) - Math.max(left.left, right.left);
        const overlapY =
          Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
        expect(
          overlapX > 0.5 && overlapY > 0.5,
          `${left.id} overlaps ${right.id}: ${overlapX.toFixed(1)} x ${overlapY.toFixed(1)}`,
        ).toBe(false);
      }
    }
  });

  it('normalises the board to a positive origin and contains every zone', () => {
    expect(plan.width).toBeGreaterThan(0);
    expect(plan.height).toBeGreaterThan(0);
    for (const entry of plan.zones) {
      const bounds = edges(entry);
      expect(bounds.left, entry.zone.id).toBeGreaterThanOrEqual(-0.001);
      expect(bounds.top, entry.zone.id).toBeGreaterThanOrEqual(-0.001);
      expect(bounds.right, entry.zone.id).toBeLessThanOrEqual(plan.width + 0.001);
      expect(bounds.bottom, entry.zone.id).toBeLessThanOrEqual(
        plan.height + 0.001,
      );
    }
  });

  it('draws the human hand row plus its drawn tile', () => {
    const human = player(state, 0);
    const hand = zoneById(plan, 'hand-bottom');
    expect(hand.zone.bodies).toHaveLength(human.hand.length + 1);
    expect(human.draw).not.toBeNull();
    const drawn = hand.zone.bodies.find(
      (body) => body.shell === 'shell_hand_slot_draw',
    );
    expect(drawn?.face).toBe(human.draw);
  });

  it('gives opponents blue backs, not faces', () => {
    for (const id of ['hand-top', 'hand-left', 'hand-right']) {
      const zone = zoneById(plan, id).zone;
      expect(zone.bodies.every((body) => body.face === null), id).toBe(true);
    }
  });

  it('puts each discard in its seat pond and turns a riichi tile', () => {
    const bottoms = zoneById(plan, 'pond-bottom').zone;
    const human = player(state, 0);
    expect(bottoms.bodies).toHaveLength(human.discards.length);
    const riichiIndex = human.discards.findIndex((discard) => discard.is_riichi);
    const turned = bottoms.bodies.filter((body) => body.riichi);
    expect(turned).toHaveLength(riichiIndex >= 0 ? 1 : 0);
    if (riichiIndex >= 0) {
      expect(turned[0].shell).toBe('shell_flat_sideways');
    }
  });

  it('lays the human meld with its called tile sideways', () => {
    const human = player(state, 0);
    const meld = human.melds[0];
    const called = meldFaces(meld, human.seat).calledIndex;
    const zone = zoneById(plan, 'melds-bottom-0').zone;
    expect(zone.bodies).toHaveLength(meld.tiles.length);
    const sideways = zone.bodies.filter(
      (body) => body.shell === 'shell_flat_sideways',
    );
    expect(sideways).toHaveLength(called === null ? 0 : 1);
  });

  it('passes every scripted board check', () => {
    expect(failedChecks(checkBoardPlan(plan, state))).toEqual([]);
  });
});

describe('handFaces', () => {
  it('maps a red five to the red face and keeps the draw separate', () => {
    const custom = structuredClone(state);
    const human = player(custom, 0);
    human.hand = ['5m', '1m', '2m', '3m', '4m', '6m', '7m', '8m', '9m', '1p'];
    human.draw = '5p';
    human.red_fives = ['5m', '5p'];

    const { faces, draw } = handFaces(human);
    expect(faces).toContain('5mr');
    expect(draw).toBe('5pr');
  });

  it('centres a 13-tile hand with no draw', () => {
    const custom = structuredClone(state);
    const human = player(custom, 0);
    human.hand = Array.from({ length: 13 }, () => '1m');
    human.draw = null;
    human.red_fives = [];
    expect(handFaces(human)).toEqual({
      faces: Array.from({ length: 13 }, () => '1m'),
      draw: null,
    });
  });
});
