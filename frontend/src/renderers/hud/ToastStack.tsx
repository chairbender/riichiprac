/**
 * The HUD toast stack (3D-H3).
 *
 * One transient surface per status/error message, stacked under the top bar
 * (`3d_hud.md` §2). Errors are `role="alert"`, status lines `role="status"`, and
 * a toast with a dismiss control takes pointer events on its own box only — the
 * layer root stays click-through (`Hud.css`).
 *
 * The stack never takes focus (§6.5.10): a message is announced once by its live
 * role, and the Dismiss button is reachable only when the user chooses to Tab.
 */

import type { HudToast } from './toastModel';
import { HUD_TOAST_LIMIT } from './toastModel';

export interface HudToastStackProps {
  readonly toasts: readonly HudToast[];
}

export function HudToastStack({ toasts }: HudToastStackProps) {
  return (
    <>
      {toasts.slice(0, HUD_TOAST_LIMIT).map((toast) => (
        <div
          key={toast.id}
          className={`hud-toast hud-toast--${toast.tone}`}
          data-toast={toast.id}
          role={toast.tone === 'error' ? 'alert' : 'status'}
        >
          <span className="hud-toast-text">{toast.text}</span>
          {toast.onDismiss && (
            <button
              type="button"
              className="hud-toast-dismiss"
              onClick={toast.onDismiss}
              aria-label={toast.dismissLabel ?? 'Dismiss'}
            >
              Dismiss
            </button>
          )}
        </div>
      ))}
    </>
  );
}
