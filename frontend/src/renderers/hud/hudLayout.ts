/**
 * The floating 3D HUD's geometry (3D-H2), and the collision rule that keeps it
 * off the board.
 *
 * `3d_hud.md` (§5, §7) fixes the composition as numbers: the top bar's height,
 * the one hand panel above the hand, the toast stack under the bar, the sheet
 * over the scene. This module is that arithmetic, as a **pure** function of the
 * stage size, the scene's two anchors and a tiny state — no DOM reads, no
 * renderer calls, no clock. `HudLayer` reads the live projection and the safe
 * insets and calls it; the tests (and 3D-15) call it with the real
 * `hitRects()`/`compassPlateRect()` output at every supported aspect.
 *
 * The exclusion rule (§7.2): an at-rest HUD rect is legal iff it does not
 * intersect `expand(e, 8)` for every `e` in `handBand ∪ compassBox` (and, in the
 * test, every individual hand target — the band is their union, so covering one
 * means covering the band). The open sheet and its scrim are exempt by design
 * (§7.6): they may cover the board, which is what a modal is for.
 */

import type { BandRect, CompassRect } from '../contract';
import { compassBox } from '../compassOverlay';

/** The HUD gutter: a panel may sit exactly this close to the hand and no closer. */
export const HUD_GAP = 8;

/** The top bar's control height (`--hud-tap`); §5's `44 px`. */
export const HUD_TOP_BAR_CONTROL = 44;
/** The bar's padding above and below the control; §5's `6 px`. */
export const HUD_TOP_BAR_PAD = 6;

/**
 * The brand line's height and the gap under it (user request 2026-11-20).
 *
 * The top bar's start cluster is a column: "riichiprac" on the very top-left,
 * the setup trigger under it. The line height is fixed in `Hud.css`
 * (`18px`, `--hud-text-md`) and pinned by `hudCss.test.ts`, so the bar's height
 * and the trigger's rect below it are the boxes the browser paints.
 */
export const HUD_TOP_BAR_BRAND = 18;
export const HUD_TOP_BAR_BRAND_GAP = 4;

/**
 * The setup trigger's reserved box (3D-H4): the bar's start control. One
 * tap-height button at the bar's leading padding, reserved at `96 px` — the
 * width its label ("Setup") and the shared button padding need — and pinned in
 * `Hud.css` as the control's `min-width`, so the rect the collision gate checks
 * and the button the browser paints are the same box.
 */
export const HUD_SETUP_TRIGGER_WIDTH = 96;
export const HUD_SETUP_TRIGGER_HEIGHT = HUD_TOP_BAR_CONTROL;

/**
 * The result card's panel height, in CSS px. The panel is now only the
 * post-answer result card (user change 2026-11-21): before an answer there is no
 * panel at all, just the isolated call row over the hand.
 */
export const HUD_PANEL_RESULT = 104;
/** The panel's width cap: `36rem`. */
export const HUD_PANEL_MAX_WIDTH = 576;

/**
 * The panel's inner geometry (§8): the surface's padding. The result card is
 * the only panel content, so these are its numbers; the call row is outside
 * the panel and uses {@link HUD_ACTION_RAIL_HEIGHT} directly.
 */
export const HUD_PANEL_PAD = 8;
export const HUD_PANEL_SIDE_PAD = 12;
export const HUD_RAIL_GAP = 4;
export const HUD_ACTION_RAIL_HEIGHT = 44;

/**
 * The result card's own rows (3D-H5): the outcome row carries the tap-sized
 * Details control (`--hud-tap`), and the picks line sits under it. Both are
 * inside the fixed `104 px` panel, so a longer verdict cannot grow the card
 * into the hand (`3d_hud.md` §7.4).
 */
export const HUD_RESULT_TRIGGER_WIDTH = 84;
export const HUD_RESULT_TRIGGER_HEIGHT = HUD_ACTION_RAIL_HEIGHT;
export const HUD_RESULT_PICKS_HEIGHT = 18;

/** The toast stack's width cap: `32rem`, and the height H2 reserves per toast. */
export const HUD_TOAST_MAX_WIDTH = 512;
export const HUD_TOAST_HEIGHT = 56;

/** The sheet's width/height caps (§5): `52rem` wide, `832 px` tall. */
export const HUD_SHEET_MAX_WIDTH = 832;
export const HUD_SHEET_MAX_HEIGHT = 832;
/** The sheet's share of the stage height when that is smaller than the cap. */
export const HUD_SHEET_STAGE_FRACTION = 0.78;

/** A CSS-pixel rectangle, relative to the stage's top-left corner. */
export interface HudRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The stage's size, in CSS px. */
export interface StageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * The device's safe-area insets, in CSS px (`env(safe-area-inset-*)`).
 *
 * Insets are inputs to this layout, never CSS padding on a full-window node, so
 * the numbers the test asserts are the numbers the browser uses. Tests pass
 * {@link NO_INSETS}; a device with no notch is unchanged by them.
 */
export interface HudInsets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const NO_INSETS: HudInsets = { top: 0, right: 0, bottom: 0, left: 0 };

/** The scene's projection, as the HUD receives it. */
export interface HudAnchors {
  /** The human hand + draw band, answered or not; null before a board exists. */
  readonly handBand: BandRect | null;
  /** The projected compass plate; null before a board exists (3D-09). */
  readonly compass: CompassRect | null;
}

/**
 * What the HUD shows pre-answer: nothing, or the call row. `result` is the one
 * panel, mounted only after the answer.
 */
export type HudSlot = 'none' | 'actions' | 'result';

/** The panel content actually mounted this frame. */
export type HudPanelSlot = 'none' | 'result';

/** Which side of the hand band the call row or panel ended up on. */
export type HudPanelAnchor = 'none' | 'above' | 'below';

/** The few bits of state the layout depends on. */
export interface HudState {
  readonly slot: HudSlot;
  /** The call row's real content height: one row, or two when it wraps. */
  readonly actionRows?: 1 | 2;
  /** A sheet is open: the call row is hidden behind the modal. */
  readonly sheet: boolean;
  /** How many toasts the stack shows (0–3, §2). */
  readonly toasts: number;
  /**
   * A mobile stage (2026-11-21): the compass box is the mobile rectangle, the
   * call row and result card always sit **above** the hand, the call row runs
   * to the screen's right edge, and an open sheet takes the whole stage below
   * the top bar instead of stopping at the hand. Desktop keeps the committed
   * rules.
   */
  readonly mobile?: boolean;
}

/** Everything `HudLayer` positions, plus the anchors and clearances. */
export interface HudLayout {
  /** Full width, `brand + 44 + 6 + max(6, safeTop)` tall (§7.3). */
  readonly topBar: HudRect;
  /** The bar's padding, after the safe insets: `top = max(6, safeTop)`. */
  readonly topBarPadding: HudInsets;
  /**
   * The setup trigger's rect (3D-H4): the bar's start control. It is always
   * mounted with the bar and is the front door to the one setup sheet, which is
   * why the collision gate names it (`hudAtRestRects`).
   */
  readonly setupTrigger: HudRect;
  /**
   * The isolated call row above the hand (user change 2026-11-21): the call and
   * action buttons as a bare row, right-aligned to the hand band, with no panel
   * surface. Null when there is nothing to show or a sheet is open.
   */
  readonly callBar: HudRect | null;
  readonly callBarAnchor: HudPanelAnchor;
  /** The result card's panel, or null before an answer (§7.3). */
  readonly panel: HudRect | null;
  /** The one panel is the result card after an answer. */
  readonly panelSlot: HudPanelSlot;
  readonly panelAnchor: HudPanelAnchor;
  /**
   * The result card's content box inside the panel (H5), or null unless the
   * panel is mounted. The card's outcome row and picks line are fixed by the
   * panel's 104 px shape.
   */
  readonly resultCard: HudRect | null;
  /**
   * The result card's Details affordance (H5): the sheet trigger's own rect.
   * It is inside the card, and the collision gate names it separately so a
   * failing composition points at the control rather than only the surface.
   */
  readonly sheetTrigger: HudRect | null;
  /** The toast stack under the top bar, or null when empty. */
  readonly toasts: HudRect | null;
  /** The open sheet's panel, or null when closed (or the stage is too short). */
  readonly sheet: HudRect | null;
  /** Compass bottom edge → the result panel's top edge (negative is illegal). */
  readonly panelCompassClearance: number | null;
  /** The gap between the result panel and the hand band's nearest edge. */
  readonly panelHandClearance: number | null;
  /** Compass bottom edge → the call row's top edge (negative is illegal). */
  readonly callBarCompassClearance: number | null;
  /** The gap between the call row and the hand band's nearest edge. */
  readonly callBarHandClearance: number | null;
}

/** A named rect, for the collision report. */
export interface HudNamedRect {
  readonly name: string;
  readonly rect: HudRect;
}

/** One violation: which HUD rect, which exclusion, and where they overlap. */
export interface HudViolation {
  readonly rect: string;
  readonly against: string;
  readonly overlap: HudRect;
}

/** What the HUD may never cover at rest (§7.1). */
export interface HudExclusion {
  readonly handBand: HudRect | null;
  readonly compassBox: HudRect | null;
  /** The individual hand/draw targets; optional because the band is their union. */
  readonly hitRects?: readonly HudRect[];
}

/** Keep a value in `[0, max]`. */
function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

function rect(left: number, top: number, width: number, height: number): HudRect {
  return {
    left: round(left),
    top: round(top),
    width: round(Math.max(0, width)),
    height: round(Math.max(0, height)),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The top bar's height for these safe insets (§5/§7.3). */
export function topBarHeight(insets: HudInsets = NO_INSETS): number {
  return (
    HUD_TOP_BAR_BRAND +
    HUD_TOP_BAR_BRAND_GAP +
    HUD_TOP_BAR_CONTROL +
    HUD_TOP_BAR_PAD +
    Math.max(HUD_TOP_BAR_PAD, insets.top)
  );
}

/** The compass plate's DOM square, or null when the scene has no compass. */
export function compassSquare(
  compass: CompassRect | null,
  mobile = false,
): HudRect | null {
  if (!compass || !(compass.width > 0) || !(compass.height > 0)) return null;
  return compassBox(compass, mobile ? 'mobile' : 'desktop');
}

/** The call row's height for one or two wrapped rows. */
export function callBarHeight(actionRows: 1 | 2): number {
  return (
    actionRows * HUD_ACTION_RAIL_HEIGHT + (actionRows - 1) * HUD_RAIL_GAP
  );
}

/**
 * The row's top edge and anchor for a given height.
 *
 * The primary anchor is `handBand.top − 8 − height`. When that would reach the
 * compass (or the bar), the row docks **below** the hand band at
 * `handBand.bottom + 8` — the phone fallback of §5, one rule rather than a
 * second layout.
 */
function anchorRow(
  band: BandRect,
  compassBottom: number | null,
  height: number,
): { top: number; anchor: 'above' | 'below' } {
  const above = band.top - HUD_GAP - height;
  if (compassBottom !== null && above < compassBottom + HUD_GAP) {
    return { top: band.top + band.height + HUD_GAP, anchor: 'below' };
  }
  return { top: above, anchor: 'above' };
}

/**
 * The result card's content box and its Details trigger.
 *
 * The card fills the panel's padded content box, and the trigger sits in its
 * top-right corner at tap height, both inside the fixed `104 px` panel.
 */
export function hudPanelRows(panel: HudRect): {
  resultCard: HudRect;
  sheetTrigger: HudRect;
} {
  const left = panel.left + HUD_PANEL_SIDE_PAD;
  const width = Math.max(0, panel.width - 2 * HUD_PANEL_SIDE_PAD);
  const resultCard = rect(
    left,
    panel.top + HUD_PANEL_PAD,
    width,
    panel.height - 2 * HUD_PANEL_PAD,
  );
  const sheetTrigger = rect(
    left + width - HUD_RESULT_TRIGGER_WIDTH,
    resultCard.top,
    HUD_RESULT_TRIGGER_WIDTH,
    HUD_RESULT_TRIGGER_HEIGHT,
  );
  return { resultCard, sheetTrigger };
}

/**
 * Every rect the HUD draws for one stage, one projection and one state.
 *
 * Nothing here reads the DOM, the renderer or the clock, and nothing is cached:
 * the caller recomputes on resize, on a new snapshot and on a sheet/toggle
 * change, which is exactly the set of events that can move a rect.
 *
 * Pre-answer the HUD has **no panel**: the call row is a bare rect anchored
 * above the right side of the hand (user change 2026-11-21). The one panel is
 * the result card after the answer.
 */
export function hudLayout(
  stage: StageSize,
  anchors: HudAnchors,
  state: HudState,
  insets: HudInsets = NO_INSETS,
): HudLayout {
  const width = Number.isFinite(stage.width) ? Math.max(0, stage.width) : 0;
  const height = Number.isFinite(stage.height) ? Math.max(0, stage.height) : 0;

  const barHeight = topBarHeight(insets);
  const topBar = rect(0, 0, width, barHeight);
  const topBarPadding: HudInsets = {
    top: round(Math.max(HUD_TOP_BAR_PAD, insets.top)),
    right: round(Math.max(HUD_TOP_BAR_PAD, insets.right)),
    bottom: HUD_TOP_BAR_PAD,
    left: round(Math.max(HUD_TOP_BAR_PAD, insets.left)),
  };
  /*
   * The setup trigger is the bar's first *control*, under the brand line, so it
   * starts at the leading padding plus the brand's line and gap, and keeps the
   * control row's height. It is clamped to the stage so a degenerate viewport
   * cannot produce a rect wider than the bar.
   */
  const setupTrigger = rect(
    topBarPadding.left,
    topBarPadding.top + HUD_TOP_BAR_BRAND + HUD_TOP_BAR_BRAND_GAP,
    Math.min(
      HUD_SETUP_TRIGGER_WIDTH,
      Math.max(0, width - topBarPadding.left - topBarPadding.right),
    ),
    HUD_SETUP_TRIGGER_HEIGHT,
  );

  const band =
    anchors.handBand && anchors.handBand.width > 0 && anchors.handBand.height > 0
      ? anchors.handBand
      : null;
  const mobile = state.mobile === true;
  const compass = compassSquare(anchors.compass, mobile);
  const compassBottom = compass ? compass.top + compass.height : null;

  /*
   * The one panel is the post-answer result card. A sheet over it hides both the
   * card and the pre-answer call row: the modal owns the screen.
   */
  const panelSlot: HudPanelSlot =
    state.slot === 'result' && !state.sheet ? 'result' : 'none';
  const callBarVisible = state.slot === 'actions' && !state.sheet;
  const actionRows = state.actionRows === 2 ? 2 : 1;

  let callBar: HudRect | null = null;
  let callBarAnchor: HudPanelAnchor = 'none';
  let panel: HudRect | null = null;
  let panelAnchor: HudPanelAnchor = 'none';
  let sheet: HudRect | null = null;
  let resultCard: HudRect | null = null;
  let sheetTrigger: HudRect | null = null;
  let panelCompassClearance: number | null = null;
  let panelHandClearance: number | null = null;
  let callBarCompassClearance: number | null = null;
  let callBarHandClearance: number | null = null;

  if (band) {
    if (callBarVisible) {
      const rowHeight = callBarHeight(actionRows);
      /*
       * Mobile (2026-11-21): the call controls always sit **above the hand** and
       * run out to the screen's right edge, so a melded hand (whose band is only
       * a tile or two wide) cannot squeeze them into its own width. Desktop
       * keeps the below-the-hand fallback and the band's own span.
       */
      const anchored = mobile
        ? { top: band.top - HUD_GAP - rowHeight, anchor: 'above' as const }
        : anchorRow(band, compassBottom, rowHeight);
      const left = mobile ? HUD_GAP : Math.max(HUD_GAP, band.left);
      const right = mobile
        ? width - HUD_GAP
        : Math.min(width - HUD_GAP, band.left + band.width);
      callBar = rect(left, anchored.top, Math.max(0, right - left), rowHeight);
      callBarAnchor = anchored.anchor;
      callBarHandClearance =
        anchored.anchor === 'above'
          ? band.top - (anchored.top + rowHeight)
          : anchored.top - (band.top + band.height);
      callBarCompassClearance =
        anchored.anchor === 'above' && compassBottom !== null
          ? anchored.top - compassBottom
          : null;
    }

    if (panelSlot !== 'none') {
      // Mobile: the result card is centred over the hand, never docked below it.
      const anchored = mobile
        ? { top: band.top - HUD_GAP - HUD_PANEL_RESULT, anchor: 'above' as const }
        : anchorRow(band, compassBottom, HUD_PANEL_RESULT);
      // Above the hand the panel is the §5 width, centred; docked below the hand
      // it takes the full width minus the gutters.
      const panelWidth =
        anchored.anchor === 'above'
          ? Math.min(HUD_PANEL_MAX_WIDTH, width - 2 * HUD_GAP)
          : width - 2 * HUD_GAP;
      const left =
        anchored.anchor === 'above' ? (width - panelWidth) / 2 : HUD_GAP;
      panel = rect(left, anchored.top, panelWidth, HUD_PANEL_RESULT);
      panelAnchor = anchored.anchor;
      ({ resultCard, sheetTrigger } = hudPanelRows(panel));
      panelHandClearance =
        anchored.anchor === 'above'
          ? band.top - (anchored.top + HUD_PANEL_RESULT)
          : anchored.top - (band.top + band.height);
      panelCompassClearance =
        anchored.anchor === 'above' && compassBottom !== null
          ? anchored.top - compassBottom
          : null;
    }

    const sheetTop = barHeight + HUD_GAP;
    /*
     * Mobile (2026-11-21): the sheet takes everything below the top bar. The
     * committed rule stops it at the hand so the hint stays visible, but a
     * landscape phone's 390 px stage left the settings and the verdict with a
     * 223 px body; the modal owns the screen while it is open.
     */
    const sheetBottom = mobile
      ? height - HUD_GAP
      : Math.min(
          band.top - HUD_GAP,
          sheetTop +
            Math.min(HUD_SHEET_STAGE_FRACTION * height, HUD_SHEET_MAX_HEIGHT),
        );
    const sheetWidth = Math.min(HUD_SHEET_MAX_WIDTH, width - 2 * HUD_GAP);
    const sheetHeightPx = sheetBottom - sheetTop;
    if (sheetHeightPx > 0 && sheetWidth > 0) {
      sheet = rect((width - sheetWidth) / 2, sheetTop, sheetWidth, sheetHeightPx);
    }
  }

  // No board yet: the top bar and the toast root still mount, and the sheet (if
  // one is somehow open) uses the stage instead of guessing a hand position.
  if (!band && state.sheet) {
    const sheetTop = barHeight + HUD_GAP;
    const sheetBottom = height - 2 * HUD_GAP;
    const sheetWidth = Math.min(HUD_SHEET_MAX_WIDTH, width - 2 * HUD_GAP);
    if (sheetBottom - sheetTop > 0 && sheetWidth > 0) {
      sheet = rect((width - sheetWidth) / 2, sheetTop, sheetWidth, sheetBottom - sheetTop);
    }
  }

  const toastCount = clamp(Math.trunc(state.toasts) || 0, 3);
  const toastWidth = Math.min(HUD_TOAST_MAX_WIDTH, width - 2 * HUD_GAP);
  const toasts =
    toastCount > 0 && toastWidth > 0
      ? rect(
          (width - toastWidth) / 2,
          barHeight + HUD_GAP,
          toastWidth,
          toastCount * HUD_TOAST_HEIGHT + (toastCount - 1) * HUD_GAP,
        )
      : null;

  return {
    topBar,
    topBarPadding,
    setupTrigger,
    callBar,
    callBarAnchor,
    panel,
    panelSlot,
    panelAnchor,
    resultCard,
    sheetTrigger,
    toasts,
    sheet,
    panelCompassClearance,
    panelHandClearance,
    callBarCompassClearance,
    callBarHandClearance,
  };
}

/**
 * Every at-rest rect the HUD can cover with: the top bar, the isolated call
 * row, the result panel **and its card or trigger**, and the toasts.
 *
 * The call row is named as its own rect (it has no panel surface around it),
 * and H5's result card and Details trigger are named too, so a failing
 * composition points at the control rather than only the surface.
 */
export function hudAtRestRects(layout: HudLayout): HudNamedRect[] {
  const rects: HudNamedRect[] = [
    { name: 'top bar', rect: layout.topBar },
    // H4: the setup trigger is always in the bar and is the sheet's front door,
    // so the gate checks it by name rather than trusting the bar's rect alone.
    { name: 'setup trigger', rect: layout.setupTrigger },
  ];
  if (layout.callBar) rects.push({ name: 'call bar', rect: layout.callBar });
  if (layout.panel) rects.push({ name: 'hand panel', rect: layout.panel });
  if (layout.resultCard) {
    rects.push({ name: 'result card', rect: layout.resultCard });
  }
  if (layout.sheetTrigger) {
    rects.push({ name: 'sheet trigger', rect: layout.sheetTrigger });
  }
  if (layout.toasts) rects.push({ name: 'toast stack', rect: layout.toasts });
  return rects;
}

/** Grow a rect by `gutter` on every side. */
export function expandRect(target: HudRect, gutter: number = HUD_GAP): HudRect {
  return {
    left: target.left - gutter,
    top: target.top - gutter,
    width: target.width + 2 * gutter,
    height: target.height + 2 * gutter,
  };
}

/** True when the two rects share a positive-area region. */
export function rectsIntersect(a: HudRect, b: HudRect): boolean {
  const overlapWidth =
    Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const overlapHeight =
    Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return overlapWidth > 0 && overlapHeight > 0;
}

/** The overlapping region, or null. */
export function overlapRect(a: HudRect, b: HudRect): HudRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.left + a.width, b.left + b.width);
  const bottom = Math.min(a.top + a.height, b.top + b.height);
  if (!(right > left) || !(bottom > top)) return null;
  return rect(left, top, right - left, bottom - top);
}

/** The exclusion set, with the individual hand targets named when supplied. */
function exclusionEntries(exclusion: HudExclusion): HudNamedRect[] {
  const entries: HudNamedRect[] = [];
  if (exclusion.handBand) {
    entries.push({ name: 'hand band', rect: exclusion.handBand });
  }
  if (exclusion.compassBox) {
    entries.push({ name: 'compass', rect: exclusion.compassBox });
  }
  (exclusion.hitRects ?? []).forEach((target, index) => {
    entries.push({ name: `hand target ${index}`, rect: target });
  });
  return entries;
}

/**
 * Every at-rest rect that comes within `gutter` of an excluded one.
 *
 * Empty is legal. Each entry names the HUD rect, the board rect it violates and
 * the overlap, so a failing gate prints the pair and the pixels rather than a
 * verdict — the report 3d_hud.md §7.5 asks for. The open sheet and its scrim are
 * deliberately not passed here (§7.6).
 */
export function hudCollisions(
  owned: readonly HudNamedRect[],
  exclusion: HudExclusion,
  gutter: number = HUD_GAP,
): HudViolation[] {
  const violations: HudViolation[] = [];
  const excluded = exclusionEntries(exclusion).map((entry) => ({
    name: entry.name,
    expanded: expandRect(entry.rect, gutter),
  }));
  for (const own of owned) {
    for (const target of excluded) {
      const overlap = overlapRect(own.rect, target.expanded);
      if (overlap) {
        violations.push({
          rect: own.name,
          against: target.name,
          overlap,
        });
      }
    }
  }
  return violations;
}
