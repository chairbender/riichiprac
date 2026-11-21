/**
 * The floating 3D HUD shell (3D-H2). Composition and contract: `3d_hud.md`.
 *
 * This is the layer every later HUD unit mounts into. It is mounted by `App`
 * **only** for the 3D table view, as a sibling of the stage, and it is
 * `position: fixed; inset: 0` with `pointer-events: none`: it never sits in the
 * document flow, never shrinks the canvas and never captures a tap outside its
 * own controls (`Hud.css`; the structural test asserts the rules).
 *
 * What it owns:
 *
 * - the top bar: the app's name ("riichiprac") on the very top-left with the
 *   setup trigger under it (3D-H4), and next hand + full screen on the right.
 *   Never a scenario or lesson name (user decision 2026-11-19, §1.1): a visible
 *   lesson name is an answer hint;
 * - the **isolated call row** above the hand (user change 2026-11-21): the
 *   call/action buttons as a bare row, right-aligned to the hand band, with no
 *   panel surface, no hint line and no Mortal chip. It is the only pre-answer
 *   chrome over the board;
 * - the one **result panel**, mounted only after an answer (H5);
 * - the toast root (H3) and the sheet root + `Sheet` primitive (H4/H5);
 * - the layout: `hudLayout()` from the live `handBandRect()`/`compassRect()`
 *   projection and the safe-area insets, recomputed on resize, orientation
 *   change, full-screen change and every new projection;
 * - §5's aspect band: `hudLayout()` returns `wide`/`square`/`portrait`, the root
 *   carries it as `data-band`, and `hud/hudBand.ts`'s context hands it to the
 *   controls `App` builds (the setup trigger and the call row);
 * - the full-screen toggle, targeting the **shell** so the HUD travels with the
 *   scene.
 *
 * Every rect comes from the same pure function, so a new row is a height in
 * `hudLayout()` and a node in a slot — never a second layout path.
 */

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { FullscreenButton } from '../../components/FullscreenButton';
import { NextScenarioButton } from '../../components/NextScenarioButton';
import { usePrefersReducedMotion } from '../motionPreference';
import { readSafeAreaInsets, readStageSize } from './domMetrics';
import { HudBandContext } from './hudBand';
import { useHudAnchors } from './hudAnchors';
import { hudBand, hudLayout, NO_INSETS } from './hudLayout';
import type { HudBand, HudLayout, HudRect, HudSlot, StageSize } from './hudLayout';
import { Sheet } from './Sheet';
import './tokens.css';
import './Hud.css';

/** One sheet's content: the title H4/H5 supply, the body and header actions. */
export interface HudSheetContent {
  readonly title: string;
  readonly body: ReactNode;
  /** Optional controls beside the heading (H5's deterministic Next hand). */
  readonly actions?: ReactNode;
}

export interface HudLayerProps {
  /**
   * The app shell — the element the full-screen toggle promotes, so the HUD
   * travels with the scene (plan §2.1).
   */
  readonly shellRef: RefObject<HTMLElement>;
  /** The fixed 3D stage, made `inert` while a sheet is open (3D-08's overlay). */
  readonly stageRef?: RefObject<HTMLElement> | null;
  /** The one next-hand control's handler (App's `handleNextScenario`). */
  readonly onNextScenario: () => void;
  /** True while the next hand is being generated; the control stays visible. */
  readonly nextDisabled?: boolean;
  /**
   * H4: the setup trigger, mounted at the bar's start. It is the one front door
   * to the setup sheet; the top bar holds no other app chrome (§1.1).
   */
  readonly setupTrigger?: ReactNode;
  /** The call row's real height: two when it wraps. */
  readonly actionRows?: 1 | 2;
  /**
   * The pre-answer call row: the shared call bar (and any remaining drill
   * action). It is mounted bare — no panel, no hint line — above the right side
   * of the hand. Absent (or null) and the HUD shows no pre-answer controls.
   */
  readonly callBar?: ReactNode;
  /** H5: the result card; the one panel, mounted after an answer. */
  readonly resultCard?: ReactNode;
  /**
   * H5: the result panel's tone (`outcomeTone`). The tone surface and its
   * green/amber/red outline are the **panel's**, not an inner box's, so the
   * card's buttons keep the panel's padding between them and the edge.
   */
  readonly resultTone?: 'correct' | 'contested' | 'incorrect' | 'neutral';
  /** H3: the toast stack's contents. */
  readonly toasts?: ReactNode;
  /** How many toasts the stack holds (1–3); defaults from `toasts`. */
  readonly toastCount?: number;
  /** H4/H5: the one open sheet, or null. */
  readonly sheet?: HudSheetContent | null;
  /** Close the sheet (Escape, scrim tap, Close button). */
  readonly onCloseSheet?: () => void;
  /**
   * H5: the result's text for the layer's one persistent live region.
   *
   * It is mounted for the life of the HUD and only its text changes, so a
   * result is announced once when the answer lands. Opening or closing the
   * verdict sheet remounts the result card but not this node, so the same
   * answer is never announced twice (`3d_hud.md` §6.5.10).
   */
  readonly announcement?: string;
  /**
   * A mobile stage (2026-11-21): the HUD uses the mobile compass box, keeps the
   * call row and result card above the hand, runs the call row to the screen's
   * right edge and gives an open sheet the whole stage below the top bar.
   */
  readonly mobile?: boolean;
}

interface HudMetrics {
  readonly stage: StageSize;
  readonly insets: typeof NO_INSETS;
}

const EMPTY_METRICS: HudMetrics = {
  stage: { width: 0, height: 0 },
  insets: NO_INSETS,
};

function sameMetrics(left: HudMetrics, right: HudMetrics): boolean {
  return (
    left.stage.width === right.stage.width &&
    left.stage.height === right.stage.height &&
    left.insets.top === right.insets.top &&
    left.insets.right === right.insets.right &&
    left.insets.bottom === right.insets.bottom &&
    left.insets.left === right.insets.left
  );
}

function rectStyle(rect: HudRect) {
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
}

/**
 * The HUD layer for the 3D table.
 *
 * The root stays mounted for the life of the 3D view; the top bar mounts as
 * soon as the stage has a size, and everything anchored to the hand waits for
 * the scene to publish a projection (`3d_hud.md` §7.3: the HUD never guesses a
 * hand position, so nothing jumps on first paint).
 */
export function HudLayer({
  shellRef,
  stageRef = null,
  onNextScenario,
  nextDisabled = false,
  setupTrigger,
  actionRows = 1,
  callBar,
  resultCard,
  resultTone,
  toasts,
  toastCount,
  sheet = null,
  onCloseSheet,
  announcement = '',
  mobile = false,
}: HudLayerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const callBarRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const toastRef = useRef<HTMLDivElement>(null);

  const anchors = useHudAnchors();
  const reducedMotion = usePrefersReducedMotion();
  const [metrics, setMetrics] = useState<HudMetrics>(EMPTY_METRICS);

  /*
   * One measurement pass, and one set of listeners for everything that can move
   * the stage: a resize, an orientation change, a full-screen change (§6.3) and
   * the `dvh` change mobile browser chrome causes. The ResizeObserver covers the
   * root's own box; the events cover browsers without it and the cases where
   * the box's size does not change but the insets do.
   */
  const measure = useCallback(() => {
    const next: HudMetrics = {
      stage: readStageSize(rootRef.current),
      insets: readSafeAreaInsets(probeRef.current),
    };
    setMetrics((previous) => (sameMetrics(previous, next) ? previous : next));
  }, []);

  useLayoutEffect(() => {
    measure();
    const onChange = () => measure();
    window.addEventListener('resize', onChange);
    window.addEventListener('orientationchange', onChange);
    document.addEventListener('fullscreenchange', onChange);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function' && rootRef.current) {
      observer = new ResizeObserver(onChange);
      observer.observe(rootRef.current);
    }
    return () => {
      window.removeEventListener('resize', onChange);
      window.removeEventListener('orientationchange', onChange);
      document.removeEventListener('fullscreenchange', onChange);
      observer?.disconnect();
    };
  }, [measure]);

  const sheetOpen = sheet !== null;
  const hasCallBar = callBar !== undefined && callBar !== null;
  /*
   * The call row is the only pre-answer content; the one panel exists only for
   * the post-answer result card. An absent node is unmounted, not reserved, so
   * the HUD never paints an empty surface over the board (`3d_hud.md` §7.1).
   */
  const slot: HudSlot =
    resultCard !== undefined ? 'result' : hasCallBar ? 'actions' : 'none';
  const layout: HudLayout | null =
    metrics.stage.width > 0 && metrics.stage.height > 0
      ? hudLayout(
          metrics.stage,
          anchors,
          {
            slot,
            actionRows,
            sheet: sheetOpen,
            toasts: toastCount ?? (toasts !== undefined ? 1 : 0),
            mobile,
          },
          metrics.insets,
        )
      : null;

  const showResult = layout?.panelSlot === 'result' && resultCard !== undefined;
  const showCallBar =
    layout?.callBar !== null &&
    layout?.callBar !== undefined &&
    hasCallBar &&
    !sheetOpen;

  // The fallback for §6.5.5: when the opener is gone, focus goes to the top
  // bar's Next hand. `Sheet` focuses the first control inside this container.
  const fallbackFocus = topBarRef;
  const band: HudBand = layout?.band ?? hudBand(metrics.stage);

  return (
    <div
      ref={rootRef}
      className="hud-root"
      data-reduced-motion={reducedMotion ? 'true' : 'false'}
      data-sheet-open={sheetOpen ? 'true' : 'false'}
      /*
       * §5's aspect band is published once here: the top bar's and the call
       * row's controls read it from context, so no component re-derives the
       * aspect. The attribute is also the CSS hook for the collapsed forms whose
       * size is a layout number (`Hud.css`).
       */
      data-band={band}
    >
      <HudBandContext.Provider value={band}>
        {/* The only element that reads env(safe-area-inset-*); it never paints. */}
        <span ref={probeRef} className="hud-inset-probe" aria-hidden="true" />

        {/*
         * H5: the HUD's one result live region. It stays mounted while the card
         * comes and goes with the verdict sheet, so its text changes exactly once
         * per answer (§6.5.10).
         */}
        <p
          className="hud-announcer hud-visually-hidden"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {announcement}
        </p>

        {layout && (
          <div
            ref={topBarRef}
            className="hud-top-bar"
            style={{
              height: `${layout.topBar.height}px`,
              paddingTop: `${layout.topBarPadding.top}px`,
              paddingRight: `${layout.topBarPadding.right}px`,
              paddingBottom: `${layout.topBarPadding.bottom}px`,
              paddingLeft: `${layout.topBarPadding.left}px`,
            }}
          >
            {/*
              * The identity is the app's name only, on the very top-left with the
              * setup trigger beneath it (user request 2026-11-20). Never the
              * scenario or lesson: a visible lesson name is an answer hint (§1.1).
              */}
            <div className="hud-top-bar__start">
              <h1 className="hud-top-bar__brand">riichiprac</h1>
              {setupTrigger}
            </div>
            <div className="hud-top-bar__end">
              <NextScenarioButton onClick={onNextScenario} disabled={nextDisabled} />
              <FullscreenButton target={shellRef} />
            </div>
          </div>
        )}

        {/*
         * The pre-answer call row: isolated buttons, no panel. The rect is the
         * hand band's right-aligned box, so the controls grow towards the left as
         * calls are added (user change 2026-11-21).
         */}
        {showCallBar && layout?.callBar && (
          <div
            ref={callBarRef}
            className="hud-call-bar"
            data-anchor={layout.callBarAnchor}
            style={rectStyle(layout.callBar)}
          >
            {callBar}
          </div>
        )}

        {showResult && layout?.panel && (
          <div
            ref={panelRef}
            className="hud-panel"
            data-slot="result"
            data-tone={resultTone}
            style={rectStyle(layout.panel)}
          >
            <div className="hud-result-card">{resultCard}</div>
          </div>
        )}

        {layout?.toasts && (
          <div ref={toastRef} className="hud-toast-root" style={rectStyle(layout.toasts)}>
            {toasts}
          </div>
        )}

        <div className="hud-sheet-root">
          <Sheet
            open={sheetOpen}
            title={sheet?.title ?? ''}
            actions={sheet?.actions}
            onClose={() => onCloseSheet?.()}
            rect={layout?.sheet ?? null}
            inertTargets={[topBarRef, callBarRef, panelRef, toastRef, stageRef]}
            fallbackFocus={fallbackFocus}
            reducedMotion={reducedMotion}
          >
            {sheet?.body}
          </Sheet>
        </div>
      </HudBandContext.Provider>
    </div>
  );
}
