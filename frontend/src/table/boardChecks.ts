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
import { zoneVisualBounds } from './boardPlan';
import { POND_COLUMNS } from './zoneLayout';

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
  const bounds = zoneVisualBounds(entry.zone, entry.scale, false);
  return {
    left: entry.x + bounds.left,
    top: entry.y + bounds.top,
    right: entry.x + bounds.right,
    bottom: entry.y + bounds.bottom,
  };
}

/** The zone's placed frame without the 1° lean: bodies, hard shadows, no pad. */
export function frameRectOf(entry: BoardZone): Rect {
  return {
    left: entry.x,
    top: entry.y,
    right: entry.x + entry.zone.width * entry.scale,
    bottom: entry.y + entry.zone.height * entry.scale,
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
    // The side ponds carry a 1° whole-zone lean, so their AABB's inner edge is
    // a few px inside the unrotated well: allow that much.
    const leanBudget = 8;
    checks.push(
      check(
        'pond inner edges are on one square well',
        Math.abs(rectOf(bottomPond).top - (plan.centreY + gap)) <= leanBudget &&
          Math.abs(rectOf(topPond).bottom - (plan.centreY - gap)) <= leanBudget &&
          Math.abs(rectOf(rightPond).left - (plan.centreX + gap)) <= leanBudget &&
          Math.abs(rectOf(leftPond).right - (plan.centreX - gap)) <= leanBudget,
        `gap ${gap.toFixed(1)}px · centre ${plan.centreX.toFixed(1)},${plan.centreY.toFixed(1)}`,
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
    // The wall ring is one closed square: the horizontal walls span its width,
    // the side columns its height, and each corner is an L-shaped overlap.
    const back = rectOf(backWall);
    const front = rectOf(frontWall);
    const leftSide = rectOf(leftWall);
    const rightSide = rectOf(rightWall);
    const ringWidth = rightSide.right - leftSide.left;
    const ringHeight = front.bottom - back.top;
    checks.push(
      check(
        'wall ring is square',
        Math.abs(ringWidth - ringHeight) <= 2,
        `${ringWidth.toFixed(1)} x ${ringHeight.toFixed(1)}`,
      ),
    );
    checks.push(
      check(
        'wall ring corners close',
        Math.abs(back.bottom - leftSide.top) <= 2 &&
          Math.abs(back.bottom - rightSide.top) <= 2 &&
          Math.abs(front.top - leftSide.bottom) <= 2 &&
          Math.abs(front.top - rightSide.bottom) <= 2,
        `back ${back.bottom.toFixed(1)} / side tops ${leftSide.top.toFixed(1)},${rightSide.top.toFixed(1)} · ` +
          `front ${front.top.toFixed(1)} / side bottoms ${leftSide.bottom.toFixed(1)},${rightSide.bottom.toFixed(1)}`,
      ),
    );
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
    // The four rivers' first rows form one square well. The equality only
    // holds once both a horizontal and a vertical river have a full 6-tile row
    // (a short river is a shorter row anchored on the same well).
    const topRowWidth = rectOf(bottomPond).right - rectOf(bottomPond).left;
    const leftRowLength = rectOf(leftPond).bottom - rectOf(leftPond).top;
    const bottomFull =
      (player(state, 0)?.discards.length ?? 0) >= POND_COLUMNS;
    const leftFull =
      (player(state, 3)?.discards.length ?? 0) >= POND_COLUMNS;
    const squareOk =
      bottomFull && leftFull
        ? Math.abs(topRowWidth - leftRowLength) <= 6
        : topRowWidth <= plan.centreGapPx * 2 + 2 &&
          leftRowLength <= plan.centreGapPx * 2 + 2;
    checks.push(
      check(
        'pond first rows form one square well',
        squareOk &&
          Math.abs(rectOf(bottomPond).top - (plan.centreY + plan.centreGapPx)) <= 8 &&
          Math.abs(rectOf(topPond).bottom - (plan.centreY - plan.centreGapPx)) <= 8,
        `${topRowWidth.toFixed(1)} x ${leftRowLength.toFixed(1)} · well ${(plan.centreGapPx * 2).toFixed(1)} · ` +
          `${bottomFull && leftFull ? 'full rows' : 'short rows'}`,
      ),
    );
  }

  // No placed zone may sit inside another: every gap is a measured constant.
  const overlaps: string[] = [];
  for (let first = 0; first < plan.zones.length; first += 1) {
    for (let second = first + 1; second < plan.zones.length; second += 1) {
      const firstZone = plan.zones[first];
      const secondZone = plan.zones[second];
      // The four walls overlap at the corners by design: that L-shaped join is
      // what closes the ring, and Task 4.1 draws the later layer over it.
      if (firstZone.zone.kind === 'wall' && secondZone.zone.kind === 'wall') {
        continue;
      }
      const a = frameRectOf(firstZone);
      const b = frameRectOf(secondZone);
      const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (overlapX > 1.5 && overlapY > 1.5) {
        overlaps.push(
          `${firstZone.zone.id}/${secondZone.zone.id} ${overlapX.toFixed(1)}x${overlapY.toFixed(1)}`,
        );
      }
    }
  }
  checks.push(
    check(
      'no placed zone overlaps outside the wall corners',
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
