/**
 * The 3D HUD's sheet primitive (3D-H2): a modal over the scene.
 *
 * `3d_hud.md` §6.5 is the whole contract, and every clause here is asserted in
 * `Sheet.test.tsx`:
 *
 * 1. `role="dialog"`, `aria-modal="true"`, labelled by its visible heading;
 * 2. opening focuses the **heading** (announced, cannot accidentally activate
 *    a control);
 * 3. Tab and Shift+Tab cycle inside the sheet, and focus cannot escape it;
 * 4. Escape closes (a nested popover that calls `stopPropagation` consumes the
 *    first Escape — this listens in the bubble phase on purpose);
 * 5. closing returns focus to the element that opened it, or to the caller's
 *    fallback when that element is gone (the result card vanishing with a new
 *    deal is the case that needs it);
 * 6. while open, the HUD's background and the stage are `inert`, and the page
 *    does not scroll (the sheet body is the only scroll container);
 * 7. at most one sheet exists: this component renders one.
 *
 * What it deliberately does **not** do is touch the renderer. The sheet is a
 * sibling of the scene in the HUD layer, so opening or closing it cannot
 * unmount, resize or re-deal the table; the structural test pins that.
 */

import { useEffect, useId, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import type { HudRect } from './hudLayout';

/** Elements the sheet makes `inert` while it is open. */
export type InertTarget = RefObject<HTMLElement | null> | null | undefined;

export interface SheetProps {
  /** Whether the sheet is open. A closed sheet renders nothing at all. */
  readonly open: boolean;
  /** The visible heading; it is also the dialog's accessible name. */
  readonly title: string;
  /** Close by Escape, by the scrim, or by the Close button. */
  readonly onClose: () => void;
  /** The sheet's body, supplied by H4/H5. */
  readonly children?: ReactNode;
  /** The panel's rect from `hudLayout()`; omitted, CSS decides nothing. */
  readonly rect?: HudRect | null;
  /**
   * The HUD's background and the stage. Each is made `inert` while the sheet is
   * open, so neither the board nor a dead-looking panel control can be reached.
   */
  readonly inertTargets?: readonly InertTarget[];
  /** Where focus goes when the opener no longer exists (§6.5.5). */
  readonly fallbackFocus?: RefObject<HTMLElement | null>;
  /** `prefers-reduced-motion`: no fade (§6.4). */
  readonly reducedMotion?: boolean;
}

/** The focusable descendants of the sheet, in DOM order. */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * The marker a nested layer inside the sheet sets while it is open (H4's
 * scenario picker, its hotseat card). A native document-level Escape listener
 * cannot be stopped by a descendant's `stopPropagation` — both run on the same
 * node — so the opt-in is an attribute the sheet checks instead.
 */
export const NESTED_LAYER_ATTRIBUTE = 'data-hud-popover';

function nestedLayerOpen(root: HTMLElement | null): boolean {
  return Boolean(
    root?.querySelector(`[${NESTED_LAYER_ATTRIBUTE}="open"]`),
  );
}

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.getAttribute('aria-hidden') !== 'true',
  );
}

/** True when the element can take focus again (it still exists and is visible). */
function canRestoreFocus(element: HTMLElement | null): element is HTMLElement {
  return Boolean(element && element.isConnected);
}

/** Focus the first control inside `container` (the top bar's Next hand). */
function focusFirstIn(container: HTMLElement | null): boolean {
  if (!container) return false;
  const [first] = focusableIn(container);
  (first ?? container).focus();
  return true;
}

export function Sheet({
  open,
  title,
  onClose,
  children,
  rect = null,
  inertTargets = [],
  fallbackFocus,
  reducedMotion = false,
}: SheetProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** The element that opened the sheet, for §6.5.5's focus return. */
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const fallbackRef = useRef(fallbackFocus);
  fallbackRef.current = fallbackFocus;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Open: remember the opener, focus the heading. Close: restore focus, and
  // fall back to the caller's control when the opener has gone with a new deal.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = document.activeElement;
      // `<body>` is what "nothing is focused" looks like; treating it as the
      // opener would strand focus outside the HUD when the sheet closes.
      const opener =
        active instanceof HTMLElement &&
        active !== document.body &&
        active !== document.documentElement &&
        active.isConnected
          ? active
          : null;
      openerRef.current = opener;
      headingRef.current?.focus();
    } else if (!open && wasOpenRef.current) {
      const opener = openerRef.current;
      openerRef.current = null;
      if (canRestoreFocus(opener)) opener.focus();
      else focusFirstIn(fallbackRef.current?.current ?? null);
    }
    wasOpenRef.current = open;
  }, [open]);

  // The page does not scroll while a sheet is open; the body is the only
  // scroll container (its CSS is `overflow: auto; overscroll-behavior: contain`).
  useEffect(() => {
    if (!open) return;
    const body = document.body;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previous;
    };
  }, [open]);

  // The scene and the HUD's background are inert while the sheet is open, so no
  // visible control is reachable behind the scrim (§6.5.6). Re-applied on each
  // render because the top bar mounts one measure after the first paint, and a
  // target that arrives later must still be inert.
  useEffect(() => {
    if (!open) return;
    const applied: HTMLElement[] = [];
    for (const target of inertTargets) {
      const element = target?.current;
      if (element && !element.hasAttribute('inert')) {
        element.setAttribute('inert', '');
        applied.push(element);
      }
    }
    return () => {
      for (const element of applied) element.removeAttribute('inert');
    };
  }, [open, inertTargets]);

  // Escape closes the topmost layer only; Tab and Shift+Tab stay inside. Both
  // are bubble-phase document listeners, so an earlier `preventDefault` (a
  // nested handler that consumed the key) stops this one; `stopPropagation`
  // cannot, because both listeners run on `document` (see `nestedLayerOpen`).
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' || event.key === 'Esc') {
        // A nested layer inside the sheet consumes the first Escape. The
        // scenario picker and hotseat card mark themselves while open; either
        // way, the second Escape closes.
        if (nestedLayerOpen(panelRef.current)) return;
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      const focusables = focusableIn(panel);
      if (!panel) return;
      if (focusables.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
        return;
      }
      if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    // Any other route into the page behind the scrim is pulled back in.
    const onFocusIn = (event: FocusEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = event.target;
      if (target instanceof Node && panel.contains(target)) return;
      const [first] = focusableIn(panel);
      (first ?? headingRef.current ?? panel).focus();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open]);

  if (!open) return null;

  const style = rect
    ? {
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      }
    : undefined;

  return (
    <>
      <div
        className="hud-sheet-scrim"
        data-reduced-motion={reducedMotion ? 'true' : 'false'}
        aria-hidden="true"
        onClick={(event) => {
          // A tap on the scrim itself closes; a tap on the panel does not.
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <div
        ref={panelRef}
        className="hud-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-reduced-motion={reducedMotion ? 'true' : 'false'}
        style={style}
        tabIndex={-1}
      >
        <div className="hud-sheet-header">
          <h2 id={titleId} ref={headingRef} className="hud-sheet-heading" tabIndex={-1}>
            {title}
          </h2>
          <button type="button" className="hud-sheet-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="hud-sheet-body">{children}</div>
      </div>
    </>
  );
}
