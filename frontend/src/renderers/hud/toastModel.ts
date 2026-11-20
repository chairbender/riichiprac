/**
 * Status and error messages as HUD toasts (3D-H3).
 *
 * `3d_hud.md` §2/§4: the stacked view's inline `role="status"` / `role="alert"`
 * blocks become a transient stack under the top bar, because in 3D they would
 * either shift the scene (a Y-flow sibling) or cover the hand. The stack is a
 * HUD rect like any other, so the collision gate keeps it off the board.
 *
 * The model lives here, apart from the component, so the ordering and the cap
 * are unit-testable without a DOM:
 *
 * - an **error** is an `alert` and persists until the next deal;
 * - a status line (`statusMessage`) persists while it is true;
 * - a file notice is dismissible; a file error is an alert;
 * - at most three are shown, newest first. There is no insertion clock — the
 *   list below *is* the priority order, so the most consequential message is the
 *   one that survives the cap.
 *
 * Pure data: no React, no DOM.
 */

/** How a toast reads: a plain status, an error, or a dismissible notice. */
export type HudToastTone = 'status' | 'error' | 'notice';

export interface HudToast {
  /** Stable key, also the test hook. */
  readonly id: string;
  readonly tone: HudToastTone;
  readonly text: string;
  /** The dismiss control's accessible name, when it has one. */
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

/** The stack's cap (§2: "at most three"). */
export const HUD_TOAST_LIMIT = 3;

export interface HudToastInput {
  /** A load in progress ("Loading table…"); persists while true. */
  readonly statusMessage?: string | null;
  /** The store's deal error; persists until the next deal. */
  readonly error?: string | null;
  /** An import/export error. */
  readonly fileError?: string | null;
  /** An import/export notice. */
  readonly fileNotice?: string | null;
  /**
   * The imported position's description. The setup sheet (3D-H4) owns the full
   * text; here it is the first line, dismissible, so an imported note is never
   * silently dropped in 3D.
   */
  readonly positionDescription?: string | null;
  readonly onDismissNotice?: () => void;
  readonly onDismissDescription?: () => void;
}

/** The first line of a possibly multi-line note, trimmed. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? '';
  return line.length > 0 ? line : text.trim();
}

/**
 * The toasts for one app state, in priority order, capped at three.
 *
 * Deterministic: the same inputs always produce the same ordered list, so the
 * stack does not reshuffle on an unrelated re-render.
 */
export function buildHudToasts(input: HudToastInput): HudToast[] {
  const toasts: HudToast[] = [];

  if (input.error) {
    toasts.push({ id: 'error', tone: 'error', text: input.error });
  }
  if (input.fileError) {
    toasts.push({ id: 'file-error', tone: 'error', text: input.fileError });
  }
  if (input.positionDescription) {
    toasts.push({
      id: 'position-description',
      tone: 'notice',
      text: firstLine(input.positionDescription),
      dismissLabel: 'Dismiss position description',
      onDismiss: input.onDismissDescription,
    });
  }
  if (input.fileNotice) {
    toasts.push({
      id: 'file-notice',
      tone: 'notice',
      text: input.fileNotice,
      dismissLabel: 'Dismiss notice',
      onDismiss: input.onDismissNotice,
    });
  }
  if (input.statusMessage) {
    toasts.push({ id: 'status', tone: 'status', text: input.statusMessage });
  }

  return toasts.slice(0, HUD_TOAST_LIMIT);
}
