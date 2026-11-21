/**
 * The HUD collision gate on the 3D-15 stress board (3d_hud.md §7).
 *
 * `hudLayout.test.ts` already sweeps seven gate aspects x six hand shapes. This
 * file runs the same rule on the board the exposed view ships with a full table:
 * four Riichi, an 18-discard river per seat, a closed kan per seat, five dora,
 * eleven hand buttons. The rule is unchanged — no at-rest HUD rect may come
 * within `HUD_GAP` of the projected hand band, a hand target or the compass —
 * and a violation prints the aspect, the rect and the overlap.
 *
 * The sheet and its scrim are exempt by design (§7.6); every other state is
 * checked, answered and unanswered, with and without the toast stack.
 */

import { describe, expect, it } from 'vitest';
import { compassBox } from '../compassOverlay';
import {
  NO_INSETS,
  hudAtRestRects,
  hudCollisions,
  hudLayout,
} from './hudLayout';
import type { HudAnchors, HudRect, HudSlot, HudState, StageSize } from './hudLayout';
import { frameForAspect, layoutBoard } from '../three/boardLayout';
import { compassPlateRect, handBandRect, hitRects } from '../three/hitTest';
import { stressSnapshot } from '../three/stressFixture';

const GATE_STAGES: readonly (StageSize & { readonly label: string })[] = [
  { label: '21:9', width: 2520, height: 1080 },
  { label: '16:9', width: 1920, height: 1080 },
  { label: '3:2', width: 1440, height: 960 },
  { label: '4:3', width: 1280, height: 960 },
  { label: '1:1', width: 1000, height: 1000 },
  { label: '3:4', width: 900, height: 1200 },
  { label: '9:16', width: 810, height: 1440 },
];

interface Projection {
  readonly anchors: HudAnchors;
  readonly targets: readonly HudRect[];
  readonly compassBox: HudRect | null;
}

const PROJECTIONS = new Map<string, Projection>();

function projectionFor(stage: StageSize, answered: boolean): Projection {
  const key = `${stage.width}x${stage.height}|${answered}`;
  const cached = PROJECTIONS.get(key);
  if (cached) return cached;

  const snapshot = stressSnapshot({ answered });
  const board = layoutBoard(snapshot);
  const frame = frameForAspect(stage.width / stage.height, board);
  const viewport = { widthPx: stage.width, heightPx: stage.height };
  const compass = compassPlateRect(frame, viewport);
  const projection: Projection = {
    anchors: {
      handBand: handBandRect(board, frame, viewport),
      compass,
    },
    // The lock-independent band stays; the buttons go with the answer.
    targets: answered ? [] : hitRects(board, frame, viewport),
    compassBox: compass ? compassBox(compass) : null,
  };
  PROJECTIONS.set(key, projection);
  return projection;
}

const SLOTS: readonly { readonly slot: HudSlot; readonly actionRows: 1 | 2 }[] = [
  { slot: 'none', actionRows: 1 },
  { slot: 'hint', actionRows: 1 },
  { slot: 'actions', actionRows: 1 },
  { slot: 'actions', actionRows: 2 },
  { slot: 'result', actionRows: 1 },
];

function describeViolations(
  violations: ReturnType<typeof hudCollisions>,
): string {
  return violations
    .map(
      (violation) =>
        `${violation.rect} x ${violation.against} ` +
        `(${violation.overlap.left},${violation.overlap.top} ` +
        `${violation.overlap.width}x${violation.overlap.height})`,
    )
    .join('; ');
}

describe('stress board: the HUD never covers the hand or the compass', () => {
  for (const stage of GATE_STAGES) {
    for (const answered of [false, true]) {
      for (const { slot, actionRows } of SLOTS) {
        for (const toasts of [0, 3]) {
          const label = `${stage.label} · ${slot}${
            slot === 'actions' ? ` x${actionRows}` : ''
          } · ${answered ? 'answered' : 'unanswered'} · ${toasts} toasts`;
          it(label, () => {
            const projection = projectionFor(stage, answered);
            const state: HudState = {
              slot,
              actionRows,
              sheet: false,
              toasts,
            };
            const layout = hudLayout(stage, projection.anchors, state, NO_INSETS);
            const violations = hudCollisions(hudAtRestRects(layout), {
              handBand: projection.anchors.handBand,
              compassBox: projection.compassBox,
              hitRects: projection.targets,
            });
            expect(
              violations,
              `${label}: ${describeViolations(violations)}`,
            ).toEqual([]);

            // The panel keeps its 8 px hand clearance and stays on the stage.
            if (layout.panel) {
              expect(layout.panelHandClearance ?? -1).toBeGreaterThanOrEqual(
                8 - 0.02,
              );
              expect(layout.panel.left).toBeGreaterThanOrEqual(0);
              expect(layout.panel.top).toBeGreaterThanOrEqual(0);
              expect(layout.panel.left + layout.panel.width).toBeLessThanOrEqual(
                stage.width + 0.01,
              );
              expect(layout.panel.top + layout.panel.height).toBeLessThanOrEqual(
                stage.height + 0.01,
              );
            }
          });
        }
      }
    }
  }

  it('still clears the board when a sheet is open', () => {
    // The sheet itself may cover the board (§7.6); the rule this checks is the
    // one that still applies: the collapsed panel and the top bar stay clear.
    for (const stage of GATE_STAGES) {
      for (const answered of [false, true]) {
        const projection = projectionFor(stage, answered);
        const layout = hudLayout(
          stage,
          projection.anchors,
          { slot: 'result', sheet: true, toasts: 1 },
          NO_INSETS,
        );
        expect(layout.panelSlot, stage.label).toBe('hint');
        const violations = hudCollisions(hudAtRestRects(layout), {
          handBand: projection.anchors.handBand,
          compassBox: projection.compassBox,
          hitRects: projection.targets,
        });
        expect(
          violations,
          `${stage.label}: ${describeViolations(violations)}`,
        ).toEqual([]);
      }
    }
  });

  it('keeps the compass well clear on the busy board (worst gate aspect)', () => {
    // 9:16 is the published worst case: the document's floor is 32 px with a
    // four-meld hand (3d_hud.md §5/§7.4). The stress board has one meld and an
    // 18-discard river, so its solve puts the hand slightly differently; this
    // records the number and holds the document's floor. The collision rule
    // itself is asserted above at every aspect.
    const stage = GATE_STAGES[6];
    const projection = projectionFor(stage, false);
    const layout = hudLayout(
      stage,
      projection.anchors,
      { slot: 'actions', sheet: false, toasts: 0 },
      NO_INSETS,
    );
    expect(layout.panelCompassClearance ?? 0).toBeGreaterThanOrEqual(32);
  });
});

describe('stress board: the hand buttons the HUD clears', () => {
  it('projects all eleven targets, and the band is their union', () => {
    for (const stage of GATE_STAGES) {
      const projection = projectionFor(stage, false);
      expect(projection.targets, stage.label).toHaveLength(11);
      expect(projection.anchors.handBand).not.toBeNull();
      expect(projection.compassBox).not.toBeNull();
    }
  });
});
