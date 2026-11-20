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

/** The hand panel's heights: §5's table, in CSS px. */
export const HUD_PANEL_HINT_ONLY = 40;
export const HUD_PANEL_ACTIONS_ONE_ROW = 84;
export const HUD_PANEL_ACTIONS_TWO_ROWS = 128;
export const HUD_PANEL_RESULT = 104;
/** The panel's width cap: `36rem`. */
export const HUD_PANEL_MAX_WIDTH = 576;

/**
 * The panel's inner geometry (§5, §8): the surface's padding, the hint row and
 * the action row(s). These are the numbers the rows are positioned by, and they
 * are what makes the panel's heights add up:
 *
 *   hint-only        8 + 24        (≤ 40)
 *   one action row   8 + 24 + 4 + 44 (80 ≤ 84)
 *   two action rows  8 + 24 + 4 + 44 + 4 + 44  (128 exactly)
 *
 * The row rects are the HUD's own (the collision gate checks them
 * individually), so they live here rather than only in CSS.
 */
export const HUD_PANEL_PAD = 8;
export const HUD_PANEL_SIDE_PAD = 12;
export const HUD_HAND_RAIL_HEIGHT = 24;
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
 * What the HUD is showing above the hand: nothing, the hint row alone, both
 * rows, or the result card.
 *
 * `hint` is H3's addition: a plain discard lesson with no Riichi, Kan or call
 * shows the hint alone, and the panel keeps the 40 px hint-only shape (§5)
 * instead of reserving an empty action row.
 */
export type HudSlot = 'none' | 'hint' | 'actions' | 'result';

/** The panel content actually mounted this frame. */
export type HudPanelSlot = 'none' | 'hint' | 'actions' | 'result';

/** Which side of the hand band the panel ended up on. */
export type HudPanelAnchor = 'none' | 'above' | 'below';

/** The few bits of state the layout depends on. */
export interface HudState {
  readonly slot: HudSlot;
  /** The action row's real content height: one row, or two when it wraps (H3). */
  readonly actionRows?: 1 | 2;
  /** A sheet is open: the panel collapses to its hint row (§5). */
  readonly sheet: boolean;
  /** How many toasts the stack shows (0–3, §2). */
  readonly toasts: number;
}

/** Everything `HudLayer` positions, plus the panel's anchor and clearances. */
export interface HudLayout {
  /** Full width, `44 + 6 + max(6, safeTop)` tall (§7.3). */
  readonly topBar: HudRect;
  /** The bar's padding, after the safe insets: `top = max(6, safeTop)`. */
  readonly topBarPadding: HudInsets;
  /** The one hand panel, or null when there is nothing to show (§7.3). */
  readonly panel: HudRect | null;
  /** What the panel should mount: hint only, both rows, or the result card. */
  readonly panelSlot: HudPanelSlot;
  readonly panelAnchor: HudPanelAnchor;
  /**
   * The hand rail (the hint row) inside the panel, or null with no panel or a
   * result card. H3's rect: the live region's own box, checked by the gate.
   */
  readonly handRail: HudRect | null;
  /**
   * The action rail's rows inside the panel (one, or two when it wraps), and
   * empty whenever the panel is the hint row alone or the result card.
   */
  readonly actionRail: readonly HudRect[];
  /**
   * The result card's content box inside the panel (H5), or null unless the
   * panel is the result card. The card's outcome row and picks line are fixed
   * by the panel's 104 px shape.
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
  /** Compass bottom edge → the panel's top edge (negative is illegal). */
  readonly panelCompassClearance: number | null;
  /** The gap between the panel and the hand band's nearest edge. */
  readonly panelHandClearance: number | null;
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
    HUD_TOP_BAR_CONTROL + HUD_TOP_BAR_PAD + Math.max(HUD_TOP_BAR_PAD, insets.top)
  );
}

/** The compass plate's DOM square, or null when the scene has no compass. */
export function compassSquare(compass: CompassRect | null): HudRect | null {
  if (!compass || !(compass.width > 0) || !(compass.height > 0)) return null;
  return compassBox(compass);
}

/** The panel's height for the content it mounts. */
function panelHeight(
  slot: HudPanelSlot,
  actionRows: 1 | 2,
): number {
  if (slot === 'result') return HUD_PANEL_RESULT;
  if (slot === 'actions') {
    return actionRows === 2 ? HUD_PANEL_ACTIONS_TWO_ROWS : HUD_PANEL_ACTIONS_ONE_ROW;
  }
  return HUD_PANEL_HINT_ONLY;
}

/**
 * The panel's top edge and anchor for a given height.
 *
 * The primary anchor is `handBand.top − 8 − height`. When that would reach the
 * compass (or the bar), the panel docks **below** the hand band at
 * `handBand.bottom + 8` — the phone fallback of §5, one rule rather than a
 * second layout.
 */
function anchorPanel(
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
 * The panel's inner rows (H3, extended by H5), in stage coordinates.
 *
 * The row heights and gaps are the committed §5 table; the horizontal inset is
 * the surface's own padding, so a row's box is exactly where its text and
 * controls are drawn. A hint-only panel has no action rail — that is the
 * "unmounted, not reserved" rule. A result card instead has one content box and
 * its Details trigger, positioned from the card's fixed shape:
 *
 *   outcome row  8 → 8 + 44 (the tap-sized trigger)
 *   picks line   8 + 44 + 4 → + 18
 *   (the 104 px panel leaves the card centred in its own box)
 */
export function hudPanelRows(
  panel: HudRect,
  slot: HudPanelSlot,
  actionRows: 1 | 2,
): {
  handRail: HudRect | null;
  actionRail: HudRect[];
  resultCard: HudRect | null;
  sheetTrigger: HudRect | null;
} {
  if (slot === 'none') {
    return { handRail: null, actionRail: [], resultCard: null, sheetTrigger: null };
  }

  const left = panel.left + HUD_PANEL_SIDE_PAD;
  const width = Math.max(0, panel.width - 2 * HUD_PANEL_SIDE_PAD);
  if (slot === 'result') {
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
    return { handRail: null, actionRail: [], resultCard, sheetTrigger };
  }

  const handRail = rect(left, panel.top + HUD_PANEL_PAD, width, HUD_HAND_RAIL_HEIGHT);
  if (slot !== 'actions') {
    return { handRail, actionRail: [], resultCard: null, sheetTrigger: null };
  }

  const first = panel.top + HUD_PANEL_PAD + HUD_HAND_RAIL_HEIGHT + HUD_RAIL_GAP;
  const actionRail: HudRect[] = [];
  for (let row = 0; row < actionRows; row += 1) {
    actionRail.push(
      rect(
        left,
        first + row * (HUD_ACTION_RAIL_HEIGHT + HUD_RAIL_GAP),
        width,
        HUD_ACTION_RAIL_HEIGHT,
      ),
    );
  }
  return { handRail, actionRail, resultCard: null, sheetTrigger: null };
}

/**
 * Every rect the HUD draws for one stage, one projection and one state.
 *
 * Nothing here reads the DOM, the renderer or the clock, and nothing is cached:
 * the caller recomputes on resize, on a new snapshot and on a sheet/toggle
 * change, which is exactly the set of events that can move a rect.
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

  const band =
    anchors.handBand && anchors.handBand.width > 0 && anchors.handBand.height > 0
      ? anchors.handBand
      : null;
  const compass = compassSquare(anchors.compass);
  const compassBottom = compass ? compass.top + compass.height : null;

  // A sheet collapses the panel to its hint row; with nothing mounted at all the
  // 40 px band is still reserved, because it is the sheet's bottom bound (§5).
  const panelSlot: HudPanelSlot =
    state.slot === 'none' ? 'none' : state.sheet ? 'hint' : state.slot;
  const actionRows = state.actionRows === 2 ? 2 : 1;

  let panel: HudRect | null = null;
  let panelAnchor: HudPanelAnchor = 'none';
  let sheet: HudRect | null = null;
  let handRail: HudRect | null = null;
  let actionRail: HudRect[] = [];
  let resultCard: HudRect | null = null;
  let sheetTrigger: HudRect | null = null;
  let panelCompassClearance: number | null = null;
  let panelHandClearance: number | null = null;

  if (band) {
    // The sheet is bounded by the collapsed (hint-only) panel's top, whatever
    // the panel is actually showing while the sheet is open.
    const collapsed = anchorPanel(band, compassBottom, HUD_PANEL_HINT_ONLY);

    if (panelSlot !== 'none') {
      const panelHeightPx = panelHeight(panelSlot, actionRows);
      const anchored = anchorPanel(band, compassBottom, panelHeightPx);
      const top = anchored.top;
      // Above the hand the panel is the §5 width, centred; docked below the hand
      // it takes the full width minus the gutters.
      const panelWidth =
        anchored.anchor === 'above'
          ? Math.min(HUD_PANEL_MAX_WIDTH, width - 2 * HUD_GAP)
          : width - 2 * HUD_GAP;
      const left = anchored.anchor === 'above' ? (width - panelWidth) / 2 : HUD_GAP;
      panel = rect(left, top, panelWidth, panelHeightPx);
      panelAnchor = anchored.anchor;
      ({ handRail, actionRail, resultCard, sheetTrigger } = hudPanelRows(
        panel,
        panelSlot,
        actionRows,
      ));
      panelHandClearance =
        anchored.anchor === 'above'
          ? band.top - (top + panelHeightPx)
          : top - (band.top + band.height);
      panelCompassClearance =
        anchored.anchor === 'above' && compassBottom !== null
          ? top - compassBottom
          : null;
    }

    const sheetTop = barHeight + HUD_GAP;
    const sheetBottom = Math.min(
      collapsed.top - HUD_GAP,
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
    panel,
    panelSlot,
    panelAnchor,
    handRail,
    actionRail,
    resultCard,
    sheetTrigger,
    toasts,
    sheet,
    panelCompassClearance,
    panelHandClearance,
  };
}

/**
 * Every at-rest rect the HUD can cover with: the top bar, the panel **and each
 * of its rows or the result card**, and the toasts.
 *
 * The rows are listed individually as well as the panel that contains them
 * (H3): the hint row and each action row are the boxes the controls are drawn
 * in, so a violation names the row — "action rail 2" — rather than only the
 * surface around it. H5 adds the result card and its Details trigger, so a card
 * that ever reaches the hand or the compass fails with the control's own name.
 */
export function hudAtRestRects(layout: HudLayout): HudNamedRect[] {
  const rects: HudNamedRect[] = [{ name: 'top bar', rect: layout.topBar }];
  if (layout.panel) rects.push({ name: 'hand panel', rect: layout.panel });
  if (layout.handRail) rects.push({ name: 'hand rail', rect: layout.handRail });
  layout.actionRail.forEach((row, index) => {
    rects.push({
      name:
        layout.actionRail.length > 1 ? `action rail ${index + 1}` : 'action rail',
      rect: row,
    });
  });
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
