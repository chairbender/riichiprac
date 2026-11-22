/**
 * The About panel: what the app is, the honesty caveat, and the attribution.
 *
 * One content block is shared by both shells so the words cannot drift:
 * `AboutContent` is the body, the 2D view opens it in `AboutDialog`, and the 3D
 * HUD hosts the same body in its one `Sheet` (the modal primitive that already
 * owns dialog semantics, focus return, Escape and the scroll lock).
 *
 * The book acknowledgement is the point of this panel: Riichi Book 1 by Daina
 * Chiba is the app's main inspiration and is licensed CC BY-NC 3.0. Neither the
 * panel nor the README may suggest that the author reviewed or endorsed the
 * app, and the book's licence is stated separately from the app's own
 * AGPL-3.0-or-later code licence.
 */

import { useEffect, useId, useRef } from "react";
import type { RefObject } from "react";

/** The book's licence text, as required by its attribution terms. */
export const BOOK_LICENSE_URL = "https://creativecommons.org/licenses/by-nc/3.0/";
/** The app's own licence and source, so its AGPL note reads alongside the book's. */
export const APP_LICENSE_URL =
  "https://github.com/chairbender/riichiprac/blob/main/LICENSE";
export const APP_SOURCE_URL = "https://github.com/chairbender/riichiprac";

export interface AboutButtonProps {
  readonly onOpen: () => void;
  /** Whether the panel this button opens is currently open. */
  readonly expanded?: boolean;
  readonly buttonRef?: RefObject<HTMLButtonElement>;
}

/**
 * The top-right "?" control. Its accessible name is the full phrase; the glyph
 * itself is decorative, so a screen reader does not announce a bare "?".
 */
export function AboutButton({
  onOpen,
  expanded = false,
  buttonRef,
}: AboutButtonProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="about-button"
      onClick={(event) => {
        // Keep the opener focused so the modal (the HUD's `Sheet` included)
        // can return focus here when it closes.
        event.currentTarget.focus();
        onOpen();
      }}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label="About riichiprac"
      title="About riichiprac"
    >
      <span aria-hidden="true">?</span>
    </button>
  );
}

/**
 * The About text. Paragraphs 1 and 2 are fixed copy (a verbatim product
 * statement and the author's honesty caveat); the attribution and licence
 * paragraphs follow them in that order.
 */
export function AboutContent() {
  return (
    <div className="about-content">
      <p>
        Practice the strategies in Riichi Book I through randomized scenarios.
        Replay scenarios are generated from a large corpus of AI self-play
        matches for realism. Generated scenarios are built procedurally, but may
        lack realism.
      </p>
      <p>
        I am not a riichi expert. I have not reviewed every single scenario,
        there may be bad suggestions. Riichi strategy is all exceptions and
        exceptions to exceptions, take these scenarios with a grain of salt.
      </p>
      <p>
        <strong>Riichi Book 1</strong> by <strong>Daina Chiba</strong> is the
        main inspiration for this app and the source of the strategies it
        practises. The book is distributed under the{" "}
        <a href={BOOK_LICENSE_URL} target="_blank" rel="noopener noreferrer">
          Creative Commons Attribution-NonCommercial 3.0 Unported License
        </a>
        . This project is an independent, non-commercial study aid; it is not
        affiliated with the book, and its author has not reviewed or endorsed
        it.
      </p>
      <p>
        riichiprac&apos;s own code is licensed{" "}
        <a href={APP_LICENSE_URL} target="_blank" rel="noopener noreferrer">
          AGPL-3.0-or-later
        </a>
        ; the book&apos;s licence above is separate and covers the book, not this
        app. The source is at{" "}
        <a href={APP_SOURCE_URL} target="_blank" rel="noopener noreferrer">
          github.com/chairbender/riichiprac
        </a>
        .
      </p>
    </div>
  );
}

/** The focusable descendants of a dialog, in DOM order. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter((element) => element.getAttribute("aria-hidden") !== "true");
}

export interface AboutDialogProps {
  readonly onClose: () => void;
  /**
   * The "?" control, so focus goes back to it when the panel closes even if the
   * browser had moved focus while it was open.
   */
  readonly returnFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * The 2D About modal.
 *
 * It keeps the same contract as the HUD's `Sheet`: `role="dialog"` with
 * `aria-modal`, labelled by its heading; focus moves to the heading on open and
 * returns to the opener on close; Escape and a scrim tap close; Tab and
 * Shift+Tab stay inside; the page does not scroll behind it. Mounted only while
 * open, so neither the table nor the deal is involved.
 */
export function AboutDialog({ onClose, returnFocusRef }: AboutDialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Open: remember the opener and move focus to the heading (announced, and it
  // cannot accidentally activate a control). Close: put focus back on it.
  useEffect(() => {
    const active = document.activeElement;
    const opener =
      returnFocusRef?.current ??
      (active instanceof HTMLElement &&
      active !== document.body &&
      active !== document.documentElement &&
      active.isConnected
        ? active
        : null);
    headingRef.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [returnFocusRef]);

  // The page does not scroll while the panel is open; the body is the only
  // scroll container.
  useEffect(() => {
    const body = document.body;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    return () => {
      body.style.overflow = previous;
    };
  }, []);

  // Escape closes; Tab and Shift+Tab cycle inside; focus that escapes the panel
  // is pulled back in.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" || event.key === "Esc") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusables = focusableIn(panel);
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

    const onFocusIn = (event: FocusEvent) => {
      const panel = panelRef.current;
      if (!panel) return;
      const target = event.target;
      if (target instanceof Node && panel.contains(target)) return;
      const [first] = focusableIn(panel);
      (first ?? headingRef.current ?? panel).focus();
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, []);

  return (
    <div
      className="about-backdrop"
      role="presentation"
      onClick={(event) => {
        // A tap on the backdrop itself closes; a tap on the panel does not.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="about-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="about-panel-head">
          <h2
            id={titleId}
            ref={headingRef}
            className="about-panel-title"
            tabIndex={-1}
          >
            About riichiprac
          </h2>
          <button type="button" className="about-panel-close" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="about-panel-body">
          <AboutContent />
        </div>
      </div>
    </div>
  );
}
