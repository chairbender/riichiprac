/**
 * The HUD's geometry and collision contract (3D-H2, 3d_hud.md §5 and §7).
 *
 * Every number here is the real projection: `layoutBoard(boardFixture(...))`,
 * `frameForAspect()`, `hitRects()`, `handBandRect()` and `compassBox()`, exactly
 * as `scripts/check-3d-layout.mjs` measures them. The gate covered by this file
 * is
 *
 *   nine gate aspects x six hand states x answered/unanswered x three states,
 *   at rest and with a sheet open,
 *
 * and the rule is §7.2: an at-rest HUD rect may not come within 8 px of the
 * hand band or the compass. A violation prints the aspect, the hand, the two
 * rects and the overlap, so a failure is a number, not an opinion.
 *
 * The user's 2026-11-21 change removed the pre-answer panel: before an answer
 * the HUD shows only the isolated, right-aligned call row above the hand, and
 * the one panel is the post-answer result card. The golden block pins those
 * two rects and the sheet's new bottom edge.
 */

import { describe, expect, it } from 'vitest';
import { compassBox } from '../compassOverlay';
import type { BandRect } from '../contract';
import { boardFixture } from '../three/boardFixture';
import type { FixtureOptions } from '../three/boardFixture';
import {
  frameForAspect,
  layoutBoard,
  placeHandBand,
  withoutHandBandTiles,
} from '../three/boardLayout';
import type { LayoutProfile } from '../layoutConstants';
import { compassPlateRect, handBandRect, hitRects } from '../three/hitTest';
import {
  HUD_ACTION_RAIL_HEIGHT,
  HUD_TOP_BAR_BRAND,
  HUD_TOP_BAR_BRAND_GAP,
  HUD_GAP,
  HUD_PANEL_PAD,
  HUD_PANEL_RESULT,
  HUD_RESULT_PICKS_HEIGHT,
  HUD_RESULT_TRIGGER_HEIGHT,
  HUD_RESULT_TRIGGER_WIDTH,
  HUD_SETUP_TRIGGER_HEIGHT,
  HUD_SETUP_TRIGGER_WIDTH,
  HUD_SHEET_MAX_HEIGHT,
  HUD_SHEET_MAX_WIDTH,
  HUD_SHEET_STAGE_FRACTION,
  HUD_TOP_BAR_CONTROL,
  NO_INSETS,
  callBarHeight,
  hudAtRestRects,
  hudCollisions,
  hudLayout,
  hudPanelRows,
  rectsIntersect,
  topBarHeight,
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

function sceneFor(
  stage: StageSize,
  options: FixtureOptions,
  profile: LayoutProfile = 'desktop',
): Scene {
  // The matrix asks the same boards for every state; the projection is a pure
  // function of (fixture, stage, profile), so measure it once.
  const key = `${stage.width}x${stage.height}|${JSON.stringify(options)}|${profile}`;
  const cached = SCENES.get(key);
  if (cached) return cached;

  const mobile = profile === 'mobile';
  const board = layoutBoard(boardFixture(options), profile);
  const viewport = { widthPx: stage.width, heightPx: stage.height };
  /*
   * Desktop is the committed board: the hand is on the mat and the camera
   * frames it. Mobile solves the frame for the table without the hand, then
   * places the hand in its screen-space band — which is where the HUD's own
   * anchor and the hand buttons come from.
   */
  const frame = mobile
    ? frameForAspect(stage.width / stage.height, withoutHandBandTiles(board))
    : frameForAspect(stage.width / stage.height, board);
  const placed = mobile ? placeHandBand(board, frame, viewport) : board;
  const compass = compassPlateRect(frame, viewport, profile);
  const scene: Scene = {
    anchors: {
      handBand: handBandRect(placed, frame, viewport),
      compass,
    },
    targets: hitRects(placed, frame, viewport),
    compassBox: compass ? compassBox(compass, profile) : null,
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
  // The isolated call row: one control row, or two when it wraps.
  { slot: 'actions', actionRows: 1 },
  { slot: 'actions', actionRows: 2 },
  // The one panel, after an answer.
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

            // Pre-answer is a bare call row; the panel only exists for a result.
            if (slot === 'none') {
              expect(layout.callBar).toBeNull();
              expect(layout.panel).toBeNull();
            } else if (slot === 'actions') {
              expect(layout.callBar).not.toBeNull();
              expect(layout.callBar?.height).toBe(callBarHeight(actionRows));
              expect(layout.panel).toBeNull();
            } else {
              expect(layout.panel).not.toBeNull();
              expect(layout.callBar).toBeNull();
            }

            const violations = hudCollisions(hudAtRestRects(layout), {
              handBand: scene.anchors.handBand,
              compassBox: scene.compassBox,
              hitRects: scene.targets,
            });
            expect(violations, `${label}: ${describeViolations(violations)}`).toEqual(
              [],
            );

            // Anything that anchors to the hand keeps the 8 px gap and stays
            // inside the stage.
            const anchored = [layout.callBar, layout.panel].filter(
              (rect): rect is HudRect => rect !== null,
            );
            for (const rect of anchored) {
              expect(rect.top).toBeGreaterThanOrEqual(0);
              expect(rect.left).toBeGreaterThanOrEqual(0);
              expect(rect.left + rect.width).toBeLessThanOrEqual(
                stage.width + 0.01,
              );
              expect(rect.top + rect.height).toBeLessThanOrEqual(
                stage.height + 0.01,
              );
            }
            if (layout.callBar) {
              expect(layout.callBarHandClearance ?? -1).toBeGreaterThanOrEqual(
                HUD_GAP - 0.02,
              );
            }
            if (layout.panel) {
              expect(layout.panelHandClearance ?? -1).toBeGreaterThanOrEqual(
                HUD_GAP - 0.02,
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

  it('docks the call row below the hand when above would reach the compass', () => {
    // A hand near the bottom and a compass low enough that the 44 px row cannot
    // fit above it: the one fallback, not a second layout.
    const stage = { width: 400, height: 600 };
    const scene: Scene = {
      anchors: {
        handBand: { left: 100, top: 500, width: 200, height: 60 },
        compass: {
          left: 150,
          top: 350,
          width: 100,
          height: 100,
          centreX: 200,
          centreY: 400,
        },
      },
      targets: [],
      compassBox: { left: 150, top: 350, width: 100, height: 100 },
    };
    const layout = layoutFor(stage, scene, {
      slot: 'actions',
      actionRows: 1,
      sheet: false,
      toasts: 0,
    });
    expect(layout.callBarAnchor).toBe('below');
    expect(layout.callBar?.top).toBeCloseTo(500 + 60 + HUD_GAP, 6);
    expect(layout.callBarHandClearance ?? -1).toBeGreaterThanOrEqual(
      HUD_GAP - 0.02,
    );
    expect(
      hudCollisions(hudAtRestRects(layout), {
        handBand: scene.anchors.handBand,
        compassBox: scene.compassBox,
      }),
    ).toEqual([]);
  });
});

describe('HUD layout: the published composition (§5, §7.4)', () => {
  /*
   * The reference hand (one meld per seat), CSS px, DPR 1, on the **mobile**
   * board. These are the values in 3d_hud.md after the 2026-11-21 change,
   * re-measured after task 261120-2225 brought the board and hand band closer
   * and after the smaller compass moved the readout: the right-aligned call
   * row's top, the post-answer panel and result card, where the sheet now
   * reaches, and the compass clearance the gate measures.
   */
  const GOLDEN = [
    { stage: GATE_STAGES[0], callBar: 836, result: 776, sheetBottom: 880, clearance: 154 },
    { stage: GATE_STAGES[1], callBar: 876, result: 816, sheetBottom: 918, clearance: 205 },
    { stage: GATE_STAGES[2], callBar: 790, result: 730, sheetBottom: 834, clearance: 203 },
    { stage: GATE_STAGES[3], callBar: 801, result: 741, sheetBottom: 835, clearance: 225 },
    { stage: GATE_STAGES[4], callBar: 859, result: 799, sheetBottom: 866, clearance: 284 },
    { stage: GATE_STAGES[5], callBar: 1061, result: 1001, sheetBottom: 918, clearance: 384 },
    // 9:16: the stage-height cap binds the sheet; the hand is the closest bound.
    { stage: GATE_STAGES[6], callBar: 1301, result: 1241, sheetBottom: 918, clearance: 512 },
  ] as const;

  for (const golden of GOLDEN) {
    it(`reproduces ${golden.stage.label}'s call row, result card, sheet and clearance`, () => {
      // The published composition is the mobile one: the screen-space hand is
      // a phone-only change, so these are the numbers that ship on a phone.
      const scene = sceneFor(golden.stage, {}, 'mobile');
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
      expect(Math.round(actions.callBar?.top ?? -1)).toBe(golden.callBar);
      expect(actions.callBar?.height).toBe(HUD_ACTION_RAIL_HEIGHT);
      // The call row's right edge is the hand band's right edge.
      const band = scene.anchors.handBand;
      expect(actions.callBar?.left).toBeCloseTo(band?.left ?? 0, 1);
      expect((actions.callBar?.left ?? 0) + (actions.callBar?.width ?? 0)).toBeCloseTo(
        (band?.left ?? 0) + (band?.width ?? 0),
        1,
      );
      expect(Math.round(result.panel?.top ?? -1)).toBe(golden.result);
      expect(result.panel?.height).toBe(HUD_PANEL_RESULT);
      // Published as whole pixels; ±2 is the rounding of two sub-pixel edges.
      expect(actions.callBarCompassClearance ?? 0).toBeGreaterThanOrEqual(
        golden.clearance - 2,
      );
      expect(actions.callBarCompassClearance ?? 0).toBeLessThanOrEqual(
        golden.clearance + 2,
      );
      expect(
        Math.round(
          (actions.sheet?.top ?? 0) + (actions.sheet?.height ?? 0),
        ),
      ).toBe(golden.sheetBottom);
    });
  }

  it('keeps the compass clearance at its worst gate value (9:16, four melds + kan)', () => {
    const stage = GATE_STAGES[6];
    const scene = sceneFor(stage, HAND_STATES[5].options);
    const actions = layoutFor(stage, scene, { slot: 'actions', sheet: false, toasts: 0 });
    const result = layoutFor(stage, scene, { slot: 'result', sheet: false, toasts: 0 });
    // Re-measured after 261120-2225 (123/63); the old H2 floor was 32/12.
    expect(actions.callBarCompassClearance ?? 0).toBeGreaterThanOrEqual(123 - 1);
    expect(result.panelCompassClearance ?? 0).toBeGreaterThanOrEqual(63 - 1);
  });

  it('hides the call row behind an open sheet and bounds the sheet by the hand or the cap', () => {
    /*
     * The sheet's bottom edge is the smaller of "8 px above the hand band" and
     * "the stage-height cap". Since the hand moved into its screen-space band
     * (2026-11-21) it sits at the bottom of the frame, so the cap is what binds
     * on every gate aspect — the hand is checked here anyway, because that is
     * the rule, and a future hand shape must not be allowed to cross the sheet.
     */
    for (const stage of GATE_STAGES) {
      const scene = sceneFor(stage, {});
      const open = layoutFor(stage, scene, {
        slot: 'actions',
        sheet: true,
        toasts: 0,
      });
      expect(open.callBar, stage.label).toBeNull();
      expect(open.panel, stage.label).toBeNull();
      const handBound = (scene.anchors.handBand?.top ?? 0) - HUD_GAP;
      const capBound =
        topBarHeight() +
        HUD_GAP +
        Math.min(
          HUD_SHEET_STAGE_FRACTION * stage.height,
          HUD_SHEET_MAX_HEIGHT,
        );
      expect(
        (open.sheet?.top ?? 0) + (open.sheet?.height ?? 0),
        stage.label,
      ).toBeCloseTo(Math.min(handBound, capBound), 1);
    }
  });

  it('uses the stage height cap for the sheet on a tall stage (§5)', () => {
    const stage = { width: 810, height: 1600 };
    const scene = sceneFor(stage, {});
    const layout = layoutFor(stage, scene, { slot: 'actions', sheet: true, toasts: 0 });
    // 0.78 x 1600 = 1248, capped at 832: the cap is what binds, not the hand.
    expect(layout.sheet?.height).toBeCloseTo(832, 1);
  });
});

describe('HUD layout: the result card (3D-H5)', () => {
  it('fits the outcome row and picks line inside the fixed 104 px card', () => {
    // The card's own rows are what keeps it from growing with its text: the
    // 44 px trigger row, a 4 px gap and the 18 px picks line, inside the
    // 88 px content box. A change that overflows this is a broken §7.4 number.
    expect(
      HUD_RESULT_TRIGGER_HEIGHT + 4 + HUD_RESULT_PICKS_HEIGHT,
    ).toBeLessThanOrEqual(HUD_PANEL_RESULT - 2 * HUD_PANEL_PAD);
  });

  it('derives the card from any panel rect, with no side effects', () => {
    const result = hudPanelRows({
      left: 100,
      top: 200,
      width: 576,
      height: HUD_PANEL_RESULT,
    });
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

  it('names the panel, the card and the Details trigger in the at-rest set', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const result = layoutFor(stage, scene, {
      slot: 'result',
      sheet: false,
      toasts: 0,
    });

    expect(result.resultCard).not.toBeNull();
    expect(result.sheetTrigger).not.toBeNull();
    expect(hudAtRestRects(result).map((entry) => entry.name)).toEqual([
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

  it('hides the card and trigger while the sheet is open', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const open = layoutFor(stage, scene, {
      slot: 'result',
      sheet: true,
      toasts: 0,
    });
    expect(open.panelSlot).toBe('none');
    expect(open.resultCard).toBeNull();
    expect(open.sheetTrigger).toBeNull();
    expect(hudAtRestRects(open).map((entry) => entry.name)).not.toContain(
      'sheet trigger',
    );
  });
});

describe('HUD layout: the call row (user change 2026-11-21)', () => {
  it('is one or two bare rows at the hand’s right edge, with no panel', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    for (const rows of [1, 2] as const) {
      const layout = layoutFor(stage, scene, {
        slot: 'actions',
        actionRows: rows,
        sheet: false,
        toasts: 0,
      });
      expect(layout.panel).toBeNull();
      expect(layout.callBar?.height).toBe(callBarHeight(rows));
      const band = scene.anchors.handBand;
      expect(layout.callBar?.left).toBeCloseTo(band?.left ?? 0, 1);
      expect(
        (layout.callBar?.left ?? 0) + (layout.callBar?.width ?? 0),
      ).toBeCloseTo((band?.left ?? 0) + (band?.width ?? 0), 1);
      expect(hudAtRestRects(layout).map((entry) => entry.name)).toEqual([
        'top bar',
        'setup trigger',
        'call bar',
      ]);
    }
  });

  it('keeps an empty state empty, and has no call row without a projection', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const none = layoutFor(stage, scene, {
      slot: 'none',
      sheet: false,
      toasts: 0,
    });
    expect(none.callBar).toBeNull();
    expect(none.panel).toBeNull();
    expect(hudAtRestRects(none).map((entry) => entry.name)).toEqual([
      'top bar',
      'setup trigger',
    ]);

    const unprojected = hudLayout(
      stage,
      { handBand: null, compass: null },
      { slot: 'actions', actionRows: 1, sheet: false, toasts: 0 },
    );
    expect(unprojected.callBar).toBeNull();
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
  });

  it('does not move the call row for a notch: the bar is the only edge it touches', () => {
    const stage = { width: 1920, height: 1080 };
    const scene = sceneFor(stage, {});
    const plain = layoutFor(stage, scene, { slot: 'actions', sheet: false, toasts: 0 });
    const notched = layoutFor(
      stage,
      scene,
      { slot: 'actions', sheet: false, toasts: 0 },
      { top: 44, right: 20, bottom: 34, left: 12 },
    );
    expect(notched.callBar?.top).toBe(plain.callBar?.top);
    expect(notched.callBar?.left).toBe(plain.callBar?.left);
  });

  it('mounts no hand chrome without an anchor, but keeps the top bar and toasts', () => {
    const stage = { width: 1280, height: 800 };
    const layout = hudLayout(
      stage,
      { handBand: null, compass: null },
      { slot: 'actions', sheet: false, toasts: 1 },
    );
    expect(layout.callBar).toBeNull();
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

  it('keeps the result panel at 36rem when it fits above the hand', () => {
    const wide = { width: 2520, height: 1080 };
    const scene = sceneFor(wide, {});
    const above = layoutFor(wide, scene, { slot: 'result', sheet: false, toasts: 0 });
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
    expect(layout.callBar).toBeNull();
    expect(layout.panel).toBeNull();
    expect(layout.sheet).toBeNull();
    expect(layout.toasts).toBeNull();
    expect(Number.isFinite(layout.topBar.height)).toBe(true);
  });
});

describe('HUD layout: the setup trigger and the open sheet (3D-H4)', () => {
  it('reserves the setup trigger at the bar’s start, at tap height', () => {
    const stage = GATE_STAGES[1];
    const scene = sceneFor(stage, {});
    const layout = layoutFor(stage, scene, {
      slot: 'none',
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

  it('bounds the open sheet by the hand at every aspect', () => {
    for (const stage of GATE_STAGES) {
      for (const hand of HAND_STATES) {
        const scene = sceneFor(stage, hand.options);
        const open = layoutFor(stage, scene, {
          slot: 'actions',
          sheet: true,
          toasts: 0,
        });
        const band = scene.anchors.handBand;
        // The sheet is a modal over the board but never over the hand.
        const bottom = (open.sheet?.top ?? 0) + (open.sheet?.height ?? 0);
        expect(bottom, stage.label).toBeLessThanOrEqual(
          (band?.top ?? 0) - HUD_GAP + 0.01,
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
