/**
 * The HUD's geometry and collision contract (3D-H2, 3d_hud.md §5 and §7).
 *
 * Every number here is the real projection: `layoutBoard(boardFixture(...))`,
 * `frameForAspect()`, `hitRects()`, `handBandRect()` and `compassBox()`, exactly
 * as `scripts/check-3d-layout.mjs` measures them. The gate covered by this file
 * is
 *
 *   seven gate aspects x six hand states x answered/unanswered x three panel
 *   slots, at rest and with a sheet open,
 *
 * and the rule is §7.2: an at-rest HUD rect may not come within 8 px of the
 * hand band or the compass. A violation prints the aspect, the hand, the two
 * rects and the overlap, so a failure is a number, not an opinion.
 *
 * The golden block pins the composition §5/§7.4 published (16:9's panel at
 * `822`, the result card at `802`, the sheet to `858`), so a change to the
 * model cannot silently move the HUD the user signed off.
 */

import { describe, expect, it } from 'vitest';
import { compassBox } from '../compassOverlay';
import type { BandRect } from '../contract';
import { boardFixture } from '../three/boardFixture';
import type { FixtureOptions } from '../three/boardFixture';
import { frameForAspect, layoutBoard } from '../three/boardLayout';
import { compassPlateRect, handBandRect, hitRects } from '../three/hitTest';
import {
  HUD_ACTION_RAIL_HEIGHT,
  HUD_TOP_BAR_BRAND,
  HUD_TOP_BAR_BRAND_GAP,
  HUD_GAP,
  HUD_HAND_RAIL_HEIGHT,
  HUD_PANEL_ACTIONS_ONE_ROW,
  HUD_PANEL_ACTIONS_TWO_ROWS,
  HUD_PANEL_HINT_ONLY,
  HUD_PANEL_PAD,
  HUD_PANEL_RESULT,
  HUD_RAIL_GAP,
  HUD_RESULT_PICKS_HEIGHT,
  HUD_RESULT_TRIGGER_HEIGHT,
  HUD_RESULT_TRIGGER_WIDTH,
  HUD_SETUP_TRIGGER_HEIGHT,
  HUD_SETUP_TRIGGER_WIDTH,
  HUD_SHEET_MAX_HEIGHT,
  HUD_SHEET_MAX_WIDTH,
  HUD_TOP_BAR_CONTROL,
  NO_INSETS,
  hudAtRestRects,
  hudCollisions,
  hudLayout,
  hudPanelRows,
  rectsIntersect,
} from './hudLayout';
import type {
  HudAnchors,
  HudRect,
  HudSlot,
  HudState,
  StageSize,
} from './hudLayout';

/** The gate's aspect list (3d_hud.md §5), plus the two phone compatibility rows. */
const GATE_STAGES: readonly (StageSize & { readonly label: string })[] = [
  { label: '21:9', width: 2520, height: 1080 },
  { label: '16:9', width: 1920, height: 1080 },
  { label: '3:2', width: 1440, height: 960 },
  { label: '4:3', width: 1280, height: 960 },
  { label: '1:1', width: 1000, height: 1000 },
  { label: '3:4', width: 900, height: 1200 },
  { label: '9:16', width: 810, height: 1440 },
  { label: 'phone 390x844', width: 390, height: 844 },
  { label: 'phone 320x568', width: 320, height: 568 },
];

/** The six hand states §7.4 measured, from the layout's own fixture. */
const HAND_STATES: readonly {
  readonly label: string;
  readonly options: FixtureOptions;
}[] = [
  { label: 'no melds', options: { meldCounts: [0, 0, 0, 0] } },
  { label: 'one meld', options: {} },
  { label: 'two melds', options: { meldCounts: [2, 2, 2, 2] } },
  { label: 'three melds', options: { meldCounts: [3, 3, 3, 3] } },
  { label: 'four melds', options: { meldCounts: [4, 4, 4, 4] } },
  {
    label: 'four melds + kan',
    options: { meldCounts: [4, 4, 4, 4], kan: true },
  },
];

interface Scene {
  readonly anchors: HudAnchors;
  readonly targets: readonly HudRect[];
  readonly compassBox: HudRect | null;
}

/** One hand at one stage size, projected exactly as the renderer projects it. */
const SCENES = new Map<string, Scene>();

function sceneFor(stage: StageSize, options: FixtureOptions): Scene {
  // The matrix asks the same 54 boards for every slot and lock state; the
  // projection is a pure function of (fixture, stage), so measure it once.
  const key = `${stage.width}x${stage.height}|${JSON.stringify(options)}`;
  const cached = SCENES.get(key);
  if (cached) return cached;

  const board = layoutBoard(boardFixture(options));
  const frame = frameForAspect(stage.width / stage.height, board);
  const viewport = { widthPx: stage.width, heightPx: stage.height };
  const compass = compassPlateRect(frame, viewport);
  const scene: Scene = {
    anchors: {
      handBand: handBandRect(board, frame, viewport),
      compass,
    },
    targets: hitRects(board, frame, viewport),
    compassBox: compass ? compassBox(compass) : null,
  };
  SCENES.set(key, scene);
  return scene;
}

function layoutFor(
  stage: StageSize,
  scene: Scene,
  state: HudState,
  insets = NO_INSETS,
) {
  return hudLayout(stage, scene.anchors, state, insets);
}

/** Format one violation the way §7.5 asks the gate to report it. */
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

const SLOTS: readonly { readonly slot: HudSlot; readonly actionRows: 1 | 2 }[] = [
  { slot: 'none', actionRows: 1 },
  // H3: a plain discard lesson shows the hint row alone (40 px).
  { slot: 'hint', actionRows: 1 },
  { slot: 'actions', actionRows: 1 },
  // H3: the rail wrapped to two rows, which is the 128 px panel.
  { slot: 'actions', actionRows: 2 },
  { slot: 'result', actionRows: 1 },
];

describe('HUD layout: the collision matrix (3d_hud.md §7.5)', () => {
  for (const stage of GATE_STAGES) {
    for (const hand of HAND_STATES) {
      for (const locked of [false, true]) {
        for (const { slot, actionRows } of SLOTS) {
          const label = `${stage.label} · ${hand.label} · ${slot}${
            slot === 'actions' ? ` x${actionRows}` : ''
          } · ${locked ? 'answered' : 'unanswered'}`;
          it(label, () => {
            const scene = sceneFor(stage, hand.options);
            const layout = layoutFor(stage, scene, {
              slot,
              actionRows,
              sheet: false,
              toasts: 2,
            });

            // The panel anchors to the hand (or is absent with nothing to show).
            if (slot === 'none') {
              expect(layout.panel).toBeNull();
            } else {
              expect(layout.panel).not.toBeNull();
            }

            const violations = hudCollisions(hudAtRestRects(layout), {
              handBand: scene.anchors.handBand,
              compassBox: scene.compassBox,
              hitRects: scene.targets,
            });
            expect(violations, `${label}: ${describeViolations(violations)}`).toEqual(
              [],
            );

            // The panel keeps the 8 px gap to the hand and sits inside the stage.
            if (layout.panel) {
              expect(layout.panelHandClearance ?? -1).toBeGreaterThanOrEqual(
                HUD_GAP - 0.02,
              );
              expect(layout.panel.top).toBeGreaterThanOrEqual(GATE_STAGES[0] && 0);
              expect(layout.panel.left).toBeGreaterThanOrEqual(0);
              expect(layout.panel.left + layout.panel.width).toBeLessThanOrEqual(
                stage.width + 0.01,
              );
              expect(layout.panel.top + layout.panel.height).toBeLessThanOrEqual(
                stage.height + 0.01,
              );
            }
            // The top bar and the toast stack never reach the compass.
            if (scene.compassBox) {
              expect(
                rectsIntersect(layout.topBar, scene.compassBox),
                `${label}: bar over the compass`,
              ).toBe(false);
              if (layout.toasts) {
                expect(
                  rectsIntersect(layout.toasts, scene.compassBox),
                  `${label}: toasts over the compass`,
                ).toBe(false);
              }
            }
          });
        }
      }
    }
  }

  it('puts the wrapped action row below the hand where it cannot fit above', () => {
    // §7.4's exception, which is the fallback doing its job: at 9:16 a four-meld
    // kan hand leaves no room for a two-row rail above, so the panel docks below
    // the hand instead of overlapping the compass.
    const stage = { width: 810, height: 1440 };
    const scene = sceneFor(stage, HAND_STATES[5].options);
    const layout = layoutFor(stage, scene, {
      slot: 'actions',
      actionRows: 2,
      sheet: false,
      toasts: 0,
    });
    expect(layout.panelAnchor).toBe('below');
    expect(layout.panel?.top).toBeCloseTo(
      (scene.anchors.handBand?.top ?? 0) +
        (scene.anchors.handBand?.height ?? 0) +
        HUD_GAP,
      1,
    );
    expect(layout.panelHandClearance ?? -1).toBeGreaterThanOrEqual(HUD_GAP - 0.02);
    expect(
      hudCollisions(hudAtRestRects(layout), {
        handBand: scene.anchors.handBand,
        compassBox: scene.compassBox,
        hitRects: scene.targets,
      }),
    ).toEqual([]);
  });
});

describe('HUD layout: the published composition (§5, §7.4)', () => {
  /*
   * The reference hand (one meld per seat), CSS px, DPR 1. These are the values
   * in 3d_hud.md: the panel's and the result card's top edges, where the sheet
   * reaches, and the compass clearance that was signed off.
   */
  const GOLDEN = [
    { stage: GATE_STAGES[0], panel: 826, result: 806, sheetBottom: 862, clearance: 171 },
    { stage: GATE_STAGES[1], panel: 822, result: 802, sheetBottom: 858, clearance: 179 },
    { stage: GATE_STAGES[2], panel: 718, result: 698, sheetBottom: 754, clearance: 154 },
    { stage: GATE_STAGES[3], panel: 713, result: 693, sheetBottom: 749, clearance: 134 },
    { stage: GATE_STAGES[4], panel: 662, result: 642, sheetBottom: 698, clearance: 84 },
    { stage: GATE_STAGES[5], panel: 782, result: 762, sheetBottom: 818, clearance: 100 },
    // 9:16: the brand line made the bar taller, so the sheet's bottom is now
    // the collapsed hint panel's top (910) rather than the 832 px cap.
    { stage: GATE_STAGES[6], panel: 874, result: 854, sheetBottom: 910, clearance: 81 },
  ] as const;

  for (const golden of GOLDEN) {
    it(`reproduces ${golden.stage.label}'s panel, result card, sheet and clearance`, () => {
      const scene = sceneFor(golden.stage, {});
      const actions = layoutFor(golden.stage, scene, {
        slot: 'actions',
        sheet: false,
        toasts: 0,
      });
      const result = layoutFor(golden.stage, scene, {
        slot: 'result',
        sheet: false,
        toasts: 0,
      });
      // The document's table is whole pixels; the projection is sub-pixel, so
      // compare the drawn edges at the pixel.
      expect(Math.round(actions.panel?.top ?? -1)).toBe(golden.panel);
      expect(actions.panel?.height).toBe(HUD_PANEL_ACTIONS_ONE_ROW);
      expect(result.panel?.top).toBeCloseTo((actions.panel?.top ?? 0) - 20, 6);
      expect(Math.round(result.panel?.top ?? -1)).toBe(golden.result);
      expect(result.panel?.height).toBe(HUD_PANEL_RESULT);
      // Published as whole pixels; ±2 is the rounding of two sub-pixel edges.
      expect(actions.panelCompassClearance ?? 0).toBeGreaterThanOrEqual(
        golden.clearance - 2,
      );
      expect(actions.panelCompassClearance ?? 0).toBeLessThanOrEqual(
        golden.clearance + 2,
      );
      expect(
        Math.round(
          (actions.sheet?.top ?? 0) + (actions.sheet?.height ?? 0),
        ),
      ).toBe(golden.sheetBottom);
    });
  }

  it('docks the panel below the hand on both phone rows (§5)', () => {
    const cases = [
      { stage: GATE_STAGES[7], top: 574 },
      { stage: GATE_STAGES[8], top: 410 },
    ] as const;
    for (const { stage, top } of cases) {
      const scene = sceneFor(stage, {});
      const layout = layoutFor(stage, scene, {
        slot: 'actions',
        sheet: false,
        toasts: 0,
      });
      expect(layout.panelAnchor, stage.label).toBe('below');
      expect(layout.panel?.top, stage.label).toBeCloseTo(top, 0);
    }
  });

  it('keeps the compass clearance at its worst gate value (9:16, four melds + kan)', () => {
    const stage = GATE_STAGES[6];
    const scene = sceneFor(stage, HAND_STATES[5].options);
    const actions = layoutFor(stage, scene, { slot: 'actions', sheet: false, toasts: 0 });
    const result = layoutFor(stage, scene, { slot: 'result', sheet: false, toasts: 0 });
    expect(actions.panelCompassClearance ?? 0).toBeGreaterThanOrEqual(32 - 1);
    expect(result.panelCompassClearance ?? 0).toBeGreaterThanOrEqual(12 - 1);
  });

  it('collapses the panel to its hint row while a sheet is open (§5)', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const open = layoutFor(stage, scene, {
      slot: 'result',
      sheet: true,
      toasts: 0,
    });
    expect(open.panelSlot).toBe('hint');
    expect(open.panel?.height).toBe(HUD_PANEL_HINT_ONLY);
    // The sheet's bottom edge is 8 px above the collapsed panel's top.
    expect(
      (open.sheet?.top ?? 0) + (open.sheet?.height ?? 0),
    ).toBeCloseTo((open.panel?.top ?? 0) - HUD_GAP, 1);
  });

  it('uses the stage height cap for the sheet on a tall stage (§5)', () => {
    const stage = { width: 810, height: 1600 };
    const scene = sceneFor(stage, {});
    const layout = layoutFor(stage, scene, { slot: 'actions', sheet: true, toasts: 0 });
    // 0.78 x 1600 = 1248, capped at 832: the cap is what binds, not the panel.
    expect(layout.sheet?.height).toBeCloseTo(832, 1);
  });
});

describe('HUD layout: the panel rows (3d_hud.md §5, 3D-H3)', () => {
  it('places the hint row and one action row inside the 84 px panel', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const layout = layoutFor(stage, scene, {
      slot: 'actions',
      actionRows: 1,
      sheet: false,
      toasts: 0,
    });
    const panel = layout.panel;
    if (!panel) throw new Error('no panel');
    expect(layout.panelSlot).toBe('actions');
    expect(layout.handRail).not.toBeNull();
    expect(layout.actionRail).toHaveLength(1);
    // The rows are the panel's own arithmetic: inside it, in order, and with
    // the committed 24/4/44 heights.
    expect(layout.handRail!.height).toBe(HUD_HAND_RAIL_HEIGHT);
    expect(layout.actionRail[0].height).toBe(HUD_ACTION_RAIL_HEIGHT);
    expect(layout.actionRail[0].top).toBe(
      layout.handRail!.top + HUD_HAND_RAIL_HEIGHT + HUD_RAIL_GAP,
    );
    for (const row of [layout.handRail!, ...layout.actionRail]) {
      expect(row.left).toBeGreaterThanOrEqual(panel.left);
      expect(row.left + row.width).toBeLessThanOrEqual(
        panel.left + panel.width + 0.01,
      );
      expect(row.top).toBeGreaterThanOrEqual(panel.top);
      expect(row.top + row.height).toBeLessThanOrEqual(
        panel.top + panel.height + 0.01,
      );
    }
  });

  it('fits the wrapped rail inside the 128 px panel and leaves the hint alone', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const layout = layoutFor(stage, scene, {
      slot: 'actions',
      actionRows: 2,
      sheet: false,
      toasts: 0,
    });
    expect(layout.panel?.height).toBe(HUD_PANEL_ACTIONS_TWO_ROWS);
    expect(layout.actionRail).toHaveLength(2);
    const [first, second] = layout.actionRail;
    expect(second.top).toBe(first.top + HUD_ACTION_RAIL_HEIGHT + HUD_RAIL_GAP);
    expect(
      second.top + second.height,
    ).toBeLessThanOrEqual((layout.panel?.top ?? 0) + HUD_PANEL_ACTIONS_TWO_ROWS + 0.01);
    // The one-row panel keeps the same hint row position within the panel:
    // only the rail's row count and the panel's height change.
    const one = layoutFor(stage, scene, {
      slot: 'actions',
      actionRows: 1,
      sheet: false,
      toasts: 0,
    });
    expect((one.handRail?.top ?? 0) - (one.panel?.top ?? 0)).toBe(
      (layout.handRail?.top ?? 0) - (layout.panel?.top ?? 0),
    );
    expect(one.handRail?.width).toBe(layout.handRail?.width);
  });

  it('gives the hint-only slot no action rail at all', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const layout = layoutFor(stage, scene, {
      slot: 'hint',
      sheet: false,
      toasts: 0,
    });
    expect(layout.panel?.height).toBe(HUD_PANEL_HINT_ONLY);
    expect(layout.panelSlot).toBe('hint');
    expect(layout.handRail).not.toBeNull();
    expect(layout.actionRail).toEqual([]);
  });

  it('has no rows for a result card, and names each row in the at-rest set', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const result = layoutFor(stage, scene, {
      slot: 'result',
      sheet: false,
      toasts: 0,
    });
    expect(result.panel?.height).toBe(HUD_PANEL_RESULT);
    expect(result.handRail).toBeNull();
    expect(result.actionRail).toEqual([]);

    const actions = layoutFor(stage, scene, {
      slot: 'actions',
      actionRows: 2,
      sheet: false,
      toasts: 0,
    });
    const names = hudAtRestRects(actions).map((entry) => entry.name);
    expect(names).toEqual([
      'top bar',
      'setup trigger',
      'hand panel',
      'hand rail',
      'action rail 1',
      'action rail 2',
    ]);
    // The single-row panel uses the unnumbered name.
    expect(
      hudAtRestRects(
        layoutFor(stage, scene, {
          slot: 'actions',
          actionRows: 1,
          sheet: false,
          toasts: 0,
        }),
      ).map((entry) => entry.name),
    ).toContain('action rail');
  });

  it('derives the same rows from any panel rect, with no side effects', () => {
    const panel = { left: 100, top: 200, width: 576, height: 128 };
    const railRows = hudPanelRows(panel, 'actions', 2);
    expect(railRows).toEqual({
      handRail: {
        left: 112,
        top: 208,
        width: 552,
        height: HUD_HAND_RAIL_HEIGHT,
      },
      actionRail: [
        { left: 112, top: 236, width: 552, height: HUD_ACTION_RAIL_HEIGHT },
        { left: 112, top: 284, width: 552, height: HUD_ACTION_RAIL_HEIGHT },
      ],
      resultCard: null,
      sheetTrigger: null,
    });

    // H5: the result card fills the padded content box and the trigger sits in
    // its top-right corner at tap height, both inside the fixed 104 px panel.
    const result = hudPanelRows(
      { left: 100, top: 200, width: 576, height: HUD_PANEL_RESULT },
      'result',
      1,
    );
    expect(result.handRail).toBeNull();
    expect(result.actionRail).toEqual([]);
    expect(result.resultCard).toEqual({
      left: 112,
      top: 208,
      width: 552,
      height: HUD_PANEL_RESULT - 2 * HUD_PANEL_PAD,
    });
    expect(result.sheetTrigger).toEqual({
      left: 112 + 552 - HUD_RESULT_TRIGGER_WIDTH,
      top: 208,
      width: HUD_RESULT_TRIGGER_WIDTH,
      height: HUD_RESULT_TRIGGER_HEIGHT,
    });
  });

  it('keeps the hint-only panel’s compass clearance unchanged at the worst aspect', () => {
    // H2 measured 32 px for the one-row rail at 9:16 with a four-meld kan hand;
    // the 40 px hint-only panel is shorter, so it cannot be worse.
    const stage = GATE_STAGES[6];
    const scene = sceneFor(stage, HAND_STATES[5].options);
    const hint = layoutFor(stage, scene, {
      slot: 'hint',
      sheet: false,
      toasts: 0,
    });
    const actions = layoutFor(stage, scene, {
      slot: 'actions',
      actionRows: 1,
      sheet: false,
      toasts: 0,
    });
    expect(hint.panelCompassClearance ?? 0).toBeGreaterThan(
      actions.panelCompassClearance ?? 0,
    );
    expect(hint.panelCompassClearance ?? 0).toBeGreaterThanOrEqual(HUD_GAP);
  });
});

describe('HUD layout: safe areas, anchors and empty states (§6.3, §7.3)', () => {
  it('grows the top bar by the safe-area top inset, never below 6 px', () => {
    const stage = { width: 1920, height: 1080 };
    const scene = sceneFor(stage, {});
    const plain = layoutFor(stage, scene, { slot: 'none', sheet: false, toasts: 0 });
    expect(plain.topBar.height).toBe(
      HUD_TOP_BAR_BRAND + HUD_TOP_BAR_BRAND_GAP + HUD_TOP_BAR_CONTROL + 2 * 6,
    );
    expect(plain.topBarPadding).toEqual({ top: 6, right: 6, bottom: 6, left: 6 });

    const notched = layoutFor(
      stage,
      scene,
      { slot: 'none', sheet: false, toasts: 0 },
      { top: 44, right: 20, bottom: 34, left: 12 },
    );
    // 44 control + 6 bottom + max(6, 44) top.
    expect(notched.topBar.height).toBe(
      HUD_TOP_BAR_BRAND + HUD_TOP_BAR_BRAND_GAP + HUD_TOP_BAR_CONTROL + 6 + 44,
    );
    expect(notched.topBarPadding.top).toBe(44);
    expect(notched.topBarPadding.right).toBe(20);
    expect(notched.topBarPadding.bottom).toBe(6);
    expect(notched.topBarPadding.left).toBe(12);
    // The panel does not move: the top bar is the only edge a notch touches.
    expect(notched.panel?.top).toBe(plain.panel?.top);
  });

  it('mounts no hand panel without an anchor, but keeps the top bar and toasts', () => {
    const stage = { width: 1280, height: 800 };
    const layout = hudLayout(
      stage,
      { handBand: null, compass: null },
      { slot: 'actions', sheet: false, toasts: 1 },
    );
    expect(layout.panel).toBeNull();
    expect(layout.topBar.width).toBe(stage.width);
    expect(layout.toasts).not.toBeNull();
  });

  it('still places a sheet when the board has not projected yet', () => {
    const stage = { width: 1280, height: 800 };
    const layout = hudLayout(
      stage,
      { handBand: null, compass: null },
      { slot: 'none', sheet: true, toasts: 0 },
    );
    expect(layout.sheet).not.toBeNull();
    expect(layout.sheet!.top).toBe(layout.topBar.height + HUD_GAP);
    expect(layout.sheet!.top + layout.sheet!.height).toBeLessThanOrEqual(
      stage.height,
    );
  });

  it('places a toast stack under the top bar and never over the hand', () => {
    const stage = { width: 1920, height: 1080 };
    const scene = sceneFor(stage, {});
    const none = layoutFor(stage, scene, { slot: 'none', sheet: false, toasts: 0 });
    expect(none.toasts).toBeNull();
    const three = layoutFor(stage, scene, { slot: 'none', sheet: false, toasts: 3 });
    expect(three.toasts?.top).toBe(three.topBar.height + HUD_GAP);
    expect(three.toasts?.width).toBe(512);
    // Three rows is taller than one; the cap is three (§2).
    const five = layoutFor(stage, scene, { slot: 'none', sheet: false, toasts: 5 });
    expect(five.toasts?.height).toBe(three.toasts?.height);
  });

  it('widens the below-hand panel but keeps the above-hand panel at 36rem', () => {
    const wide = { width: 2520, height: 1080 };
    const scene = sceneFor(wide, {});
    const above = layoutFor(wide, scene, { slot: 'actions', sheet: false, toasts: 0 });
    expect(above.panelAnchor).toBe('above');
    expect(above.panel?.width).toBe(576);
    expect(above.panel?.left).toBe((2520 - 576) / 2);
  });

  it('clamps a degenerate stage instead of producing NaN', () => {
    const layout = hudLayout(
      { width: 0, height: 0 },
      { handBand: null, compass: null },
      { slot: 'actions', sheet: true, toasts: 1 },
    );
    expect(layout.topBar.width).toBe(0);
    expect(layout.panel).toBeNull();
    expect(layout.sheet).toBeNull();
    expect(layout.toasts).toBeNull();
    expect(Number.isFinite(layout.topBar.height)).toBe(true);
  });
});

describe('HUD layout: the result card and its sheet trigger (3D-H5)', () => {
  it('fits the outcome row and picks line inside the fixed 104 px card', () => {
    // The card's own rows are what keeps it from growing with its text: the
    // 44 px trigger row, a 4 px gap and the 18 px picks line, inside the
    // 88 px content box. A change that overflows this is a broken §7.4 number.
    expect(
      HUD_RESULT_TRIGGER_HEIGHT + HUD_RAIL_GAP + HUD_RESULT_PICKS_HEIGHT,
    ).toBeLessThanOrEqual(HUD_PANEL_RESULT - 2 * HUD_PANEL_PAD);
  });

  it('names the result card and the Details trigger in the at-rest set', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const result = layoutFor(stage, scene, {
      slot: 'result',
      sheet: false,
      toasts: 0,
    });

    expect(result.resultCard).not.toBeNull();
    expect(result.sheetTrigger).not.toBeNull();
    const names = hudAtRestRects(result).map((entry) => entry.name);
    expect(names).toEqual([
      'top bar',
      'setup trigger',
      'hand panel',
      'result card',
      'sheet trigger',
    ]);

    // Both rects live inside the panel, and the trigger inside the card, at a
    // tap-height and hard against the card's trailing edge.
    for (const rect of [result.resultCard!, result.sheetTrigger!]) {
      expect(rect.left).toBeGreaterThanOrEqual(result.panel!.left);
      expect(rect.left + rect.width).toBeLessThanOrEqual(
        result.panel!.left + result.panel!.width + 0.01,
      );
      expect(rect.top).toBeGreaterThanOrEqual(result.panel!.top);
      expect(rect.top + rect.height).toBeLessThanOrEqual(
        result.panel!.top + result.panel!.height + 0.01,
      );
    }
    expect(result.sheetTrigger!.height).toBe(HUD_ACTION_RAIL_HEIGHT);
    expect(result.sheetTrigger!.top).toBe(result.resultCard!.top);
    expect(
      result.sheetTrigger!.left + result.sheetTrigger!.width,
    ).toBeCloseTo(result.resultCard!.left + result.resultCard!.width, 6);
  });

  it('checks the card and trigger against the hand and the compass at every aspect', () => {
    for (const stage of GATE_STAGES) {
      const scene = sceneFor(stage, {});
      const layout = layoutFor(stage, scene, {
        slot: 'result',
        sheet: false,
        toasts: 2,
      });
      const violations = hudCollisions(hudAtRestRects(layout), {
        handBand: scene.anchors.handBand,
        compassBox: scene.compassBox,
        hitRects: scene.targets,
      });
      expect(
        violations,
        `${stage.label}: ${describeViolations(violations)}`,
      ).toEqual([]);
      // The card is anchored inside the stage, not off an edge.
      expect(layout.resultCard!.top).toBeGreaterThanOrEqual(0);
      expect(
        layout.resultCard!.left + layout.resultCard!.width,
      ).toBeLessThanOrEqual(stage.width + 0.01);
      expect(
        layout.resultCard!.top + layout.resultCard!.height,
      ).toBeLessThanOrEqual(stage.height + 0.01);
    }
  });

  it('hides the card and trigger while the sheet is open (the panel collapses)', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const open = layoutFor(stage, scene, {
      slot: 'result',
      sheet: true,
      toasts: 0,
    });
    expect(open.panelSlot).toBe('hint');
    expect(open.resultCard).toBeNull();
    expect(open.sheetTrigger).toBeNull();
    expect(hudAtRestRects(open).map((entry) => entry.name)).not.toContain(
      'sheet trigger',
    );
  });
});

describe('HUD layout: the setup trigger and the open sheet (3D-H4)', () => {
  it('reserves the setup trigger at the bar’s start, at tap height', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const layout = layoutFor(stage, scene, {
      slot: 'hint',
      sheet: false,
      toasts: 0,
    });
    expect(layout.setupTrigger).toEqual({
      left: layout.topBarPadding.left,
      // Under the brand line: the very top-left is the app's name, not a
      // control (user request 2026-11-20).
      top: layout.topBarPadding.top + HUD_TOP_BAR_BRAND + HUD_TOP_BAR_BRAND_GAP,
      width: HUD_SETUP_TRIGGER_WIDTH,
      height: HUD_SETUP_TRIGGER_HEIGHT,
    });
    expect(HUD_SETUP_TRIGGER_HEIGHT).toBe(HUD_TOP_BAR_CONTROL);
    // Inside the bar it belongs to, on its leading edge.
    expect(layout.setupTrigger.top).toBeGreaterThanOrEqual(layout.topBar.top);
    expect(
      layout.setupTrigger.top + layout.setupTrigger.height,
    ).toBeLessThanOrEqual(layout.topBar.top + layout.topBar.height + 0.01);
    expect(layout.setupTrigger.left).toBeGreaterThanOrEqual(layout.topBar.left);
  });

  it('moves the trigger with the safe-area inset, like the bar it sits in', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const notched = hudLayout(
      stage,
      scene.anchors,
      { slot: 'none', sheet: false, toasts: 0 },
      { top: 44, right: 20, bottom: 34, left: 12 },
    );
    expect(notched.setupTrigger.left).toBe(12);
    expect(notched.setupTrigger.top).toBe(
      44 + HUD_TOP_BAR_BRAND + HUD_TOP_BAR_BRAND_GAP,
    );
    expect(notched.setupTrigger.height).toBe(HUD_TOP_BAR_CONTROL);
  });

  it('names the trigger in the at-rest set and keeps it clear of the board', () => {
    for (const stage of GATE_STAGES) {
      for (const hand of HAND_STATES) {
        const scene = sceneFor(stage, hand.options);
        const layout = layoutFor(stage, scene, {
          slot: 'actions',
          sheet: false,
          toasts: 2,
        });
        expect(hudAtRestRects(layout).map((entry) => entry.name)).toContain(
          'setup trigger',
        );
        const violations = hudCollisions(hudAtRestRects(layout), {
          handBand: scene.anchors.handBand,
          compassBox: scene.compassBox,
          hitRects: scene.targets,
        });
        expect(
          violations,
          `${stage.label} · ${hand.label}: ${describeViolations(violations)}`,
        ).toEqual([]);
      }
    }
  });

  it('bounds the open sheet by the collapsed panel at every aspect', () => {
    for (const stage of GATE_STAGES) {
      for (const hand of HAND_STATES) {
        const scene = sceneFor(stage, hand.options);
        const open = layoutFor(stage, scene, {
          slot: 'result',
          sheet: true,
          toasts: 0,
        });
        const collapsed = layoutFor(stage, scene, {
          slot: 'hint',
          sheet: false,
          toasts: 0,
        });
        // The sheet is a modal over the board but never over the hand panel's
        // reserved hint band: its bottom is 8 px above the collapsed panel.
        const bottom = (open.sheet?.top ?? 0) + (open.sheet?.height ?? 0);
        expect(bottom, stage.label).toBeLessThanOrEqual(
          (collapsed.panel?.top ?? 0) - HUD_GAP + 0.01,
        );
        // And inside the stage, within the committed width and height caps.
        expect(open.sheet?.width ?? 0).toBeLessThanOrEqual(HUD_SHEET_MAX_WIDTH);
        expect(open.sheet?.height ?? 0).toBeLessThanOrEqual(HUD_SHEET_MAX_HEIGHT);
        expect(open.sheet?.left ?? -1).toBeGreaterThanOrEqual(0);
        expect(bottom).toBeLessThanOrEqual(stage.height + 0.01);
      }
    }
  });
});

describe('HUD collision helper', () => {
  const band: BandRect = { left: 600, top: 900, width: 700, height: 100 };

  it('allows a rect exactly 8 px away and flags one that crosses', () => {
    const legal = { left: 600, top: 900 - HUD_GAP - 40, width: 700, height: 40 };
    const illegal = { left: 600, top: 900 - HUD_GAP - 39, width: 700, height: 40 };
    const exclusion = { handBand: band, compassBox: null };
    expect(
      hudCollisions([{ name: 'panel', rect: legal }], exclusion),
    ).toEqual([]);
    const violations = hudCollisions([{ name: 'panel', rect: illegal }], exclusion);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ rect: 'panel', against: 'hand band' });
    expect(violations[0].overlap.height).toBeCloseTo(1, 6);
  });

  it('checks the compass and each individual hand target too', () => {
    const compass = { left: 800, top: 400, width: 300, height: 300 };
    const target = { left: 610, top: 950, width: 44, height: 44 };
    const violations = hudCollisions(
      [{ name: 'panel', rect: { left: 700, top: 690, width: 200, height: 40 } }],
      { handBand: null, compassBox: compass, hitRects: [target] },
    );
    // The rect's bottom sits inside the compass's 8 px gutter: one violation
    // against the compass, none against the target below it.
    expect(violations.map((violation) => violation.against)).toEqual(['compass']);
  });
});
