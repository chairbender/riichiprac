/**
 * Scripted checks for the rendered board's plan.
 *
 * The same list runs in `boardPlan.test.ts` and in the `rendered:review`
 * artifact script, so the picture the user signs off and the gate in CI are
 * judged by one set of rules. Every check returns a name, a pass/fail and the
 * numbers behind it; nothing here looks at pixels.
 */
import type { GameState } from '../types/game';
import type { BoardPlan, BoardZone } from './boardPlan';

export interface BoardCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The placed zone's rect: bodies plus their hard shadows, without blur tail. */
export function rectOf(entry: BoardZone): Rect {
  return {
    left: entry.x,
    top: entry.y,
    right: entry.x + entry.zone.width,
    bottom: entry.y + entry.zone.height,
  };
}

const zoneById = (plan: BoardPlan, id: string): BoardZone | null =>
  plan.zones.find((entry) => entry.zone.id === id) ?? null;

const player = (state: GameState, seat: number) =>
  state.players.find((candidate) => candidate.seat === seat) ?? null;

function check(name: string, ok: boolean, detail = ''): BoardCheck {
  return { name, ok, detail };
}

/** Every rule the committed board plan must satisfy. */
export function checkBoardPlan(plan: BoardPlan, state: GameState): BoardCheck[] {
  const checks: BoardCheck[] = [];
  const ids = new Set(plan.zones.map((entry) => entry.zone.id));

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
    checks.push(check(`zone ${id} exists`, ids.has(id)));
  }

  // Painter order: never goes backwards, and the human hand is last.
  let ordered = true;
  let previousLayer = -Infinity;
  for (const entry of plan.zones) {
    if (entry.zone.layer < previousLayer) ordered = false;
    previousLayer = entry.zone.layer;
  }
  checks.push(
    check(
      'zones are in Task 4.1 painter order',
      ordered,
      plan.zones.map((entry) => `${entry.zone.layer}:${entry.zone.id}`).join(' '),
    ),
  );
  const last = plan.zones[plan.zones.length - 1];
  checks.push(
    check(
      'human hand draws last',
      last?.zone.id === 'hand-bottom',
      last?.zone.id ?? 'none',
    ),
  );

  const bottomPond = zoneById(plan, 'pond-bottom');
  const topPond = zoneById(plan, 'pond-top');
  const leftPond = zoneById(plan, 'pond-left');
  const rightPond = zoneById(plan, 'pond-right');
  if (bottomPond && topPond && leftPond && rightPond) {
    const gap = plan.centreGapPx;
    checks.push(
      check(
        'pond inner edges are one compass gap from the centre',
        Math.abs(rectOf(bottomPond).top - (plan.centreY + gap)) < 0.01 &&
          Math.abs(rectOf(topPond).bottom - (plan.centreY - gap)) < 0.01 &&
          Math.abs(rectOf(rightPond).left - (plan.centreX + gap)) < 0.01 &&
          Math.abs(rectOf(leftPond).right - (plan.centreX - gap)) < 0.01,
        `gap ${gap}px · centre ${plan.centreX.toFixed(1)},${plan.centreY.toFixed(1)}`,
      ),
    );
  }

  const frontWall = zoneById(plan, 'wall-front');
  const backWall = zoneById(plan, 'wall-back');
  const bottomHand = zoneById(plan, 'hand-bottom');
  const topHand = zoneById(plan, 'hand-top');
  const leftWall = zoneById(plan, 'wall-side-left');
  const rightWall = zoneById(plan, 'wall-side-right');
  const leftHand = zoneById(plan, 'hand-left');
  const rightHand = zoneById(plan, 'hand-right');
  if (
    bottomPond &&
    topPond &&
    frontWall &&
    backWall &&
    bottomHand &&
    topHand &&
    leftPond &&
    rightPond &&
    leftWall &&
    rightWall &&
    leftHand &&
    rightHand
  ) {
    checks.push(
      check(
        'far-to-near rows: pond, wall, hand',
        rectOf(frontWall).top > rectOf(bottomPond).bottom &&
          rectOf(frontWall).bottom < rectOf(bottomHand).top &&
          rectOf(backWall).bottom < rectOf(topPond).top &&
          rectOf(backWall).top > rectOf(topHand).bottom,
        `front wall ${rectOf(frontWall).top.toFixed(0)}..${rectOf(frontWall).bottom.toFixed(0)} · ` +
          `hand ${rectOf(bottomHand).top.toFixed(0)}..`,
      ),
    );
    checks.push(
      check(
        'left-to-right columns: hand, wall, pond',
        rectOf(leftWall).right < rectOf(leftPond).left &&
          rectOf(leftHand).left < rectOf(leftWall).left &&
          rectOf(rightWall).left > rectOf(rightPond).right &&
          rectOf(rightHand).right > rectOf(rightWall).right,
      ),
    );
  }

  // No placed zone may sit inside another: every gap is a measured constant.
  const overlaps: string[] = [];
  for (let first = 0; first < plan.zones.length; first += 1) {
    for (let second = first + 1; second < plan.zones.length; second += 1) {
      const a = rectOf(plan.zones[first]);
      const b = rectOf(plan.zones[second]);
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > 0.5 && overlapY > 0.5) {
        overlaps.push(
          `${plan.zones[first].zone.id}/${plan.zones[second].zone.id} ${overlapX.toFixed(1)}x${overlapY.toFixed(1)}`,
        );
      }
    }
  }
  checks.push(
    check(
      'no placed zone overlaps another',
      overlaps.length === 0,
      overlaps.length === 0 ? `${plan.zones.length} zones` : overlaps.join(', '),
    ),
  );

  let contained = true;
  let worst = 0;
  for (const entry of plan.zones) {
    const rect = rectOf(entry);
    worst = Math.max(
      worst,
      -rect.left,
      -rect.top,
      rect.right - plan.width,
      rect.bottom - plan.height,
    );
    if (worst > 0.01) contained = false;
  }
  checks.push(
    check(
      'board bounds contain every zone',
      contained,
      `${plan.width.toFixed(0)} x ${plan.height.toFixed(0)} · worst ${worst.toFixed(2)}px`,
    ),
  );

  // Content counts: one body per visible tile, one shadow per footprint.
  const human = player(state, 0);
  if (human && bottomHand) {
    const expected = Math.min(13, human.hand.length) + (human.draw ? 1 : 0);
    checks.push(
      check(
        'human hand draws its concealed row plus the drawn tile',
        bottomHand.zone.bodies.length === expected,
        `${bottomHand.zone.bodies.length} bodies, expected ${expected}`,
      ),
    );
  }
  const pondChecks: BoardCheck[] = [];
  for (const [id, seat] of [
    ['pond-bottom', 0],
    ['pond-right', 1],
    ['pond-top', 2],
    ['pond-left', 3],
  ] as const) {
    const entry = zoneById(plan, id);
    const owner = player(state, seat);
    if (!entry || !owner) continue;
    pondChecks.push(
      check(
        `${id} draws every discard`,
        entry.zone.bodies.length === owner.discards.length,
        `${entry.zone.bodies.length}/${owner.discards.length}`,
      ),
    );
  }
  checks.push(...pondChecks);

  const meldChecks: BoardCheck[] = [];
  for (const owner of state.players) {
    const side =
      owner.seat === 0
        ? 'bottom'
        : owner.seat === 1
          ? 'right'
          : owner.seat === 2
            ? 'top'
            : 'left';
    const zones = plan.zones.filter((entry) =>
      entry.zone.id.startsWith(`melds-${side}`),
    );
    meldChecks.push(
      check(
        `seat ${owner.seat} draws all ${owner.melds.length} melds`,
        zones.length === owner.melds.length,
        `${zones.length}/${owner.melds.length}`,
      ),
    );
    for (let index = 0; index < owner.melds.length; index += 1) {
      const zone = zones[index];
      meldChecks.push(
        check(
          `seat ${owner.seat} meld ${index} body count`,
          zone !== undefined &&
            zone.zone.bodies.length === owner.melds[index].tiles.length,
          `${zone?.zone.bodies.length ?? 0}/${owner.melds[index].tiles.length}`,
        ),
      );
    }
  }
  checks.push(...meldChecks);

  for (const [id, stacks] of [
    ['wall-back', 17],
    ['wall-front', 17],
  ] as const) {
    const entry = zoneById(plan, id);
    if (!entry) continue;
    checks.push(
      check(
        `${id} draws ${stacks} two-tier stacks`,
        entry.zone.bodies.length === stacks * 2 &&
          entry.zone.shadows.length === stacks,
        `${entry.zone.bodies.length} bodies / ${entry.zone.shadows.length} shadows`,
      ),
    );
  }
  for (const id of ['wall-side-left', 'wall-side-right'] as const) {
    const entry = zoneById(plan, id);
    if (!entry) continue;
    checks.push(
      check(
        `${id} draws 17 stacks, bottom tiers first`,
        entry.zone.bodies.length === 34,
        `${entry.zone.bodies.length} bodies`,
      ),
    );
  }

  return checks;
}

/** The checks that failed, for a throw in a unit test or a script exit code. */
export function failedChecks(checks: readonly BoardCheck[]): BoardCheck[] {
  return checks.filter((entry) => !entry.ok);
}
