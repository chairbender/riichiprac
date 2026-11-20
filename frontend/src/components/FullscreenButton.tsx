/**
 * Full-screen toggle for the full-window 3D table (3D-02).
 *
 * The 3D view already fills the browser window; this removes the browser
 * chrome as well. The fullscreen element is the app shell the caller owns (not
 * the canvas), because the unit's recorded guidance is that the app's UI is an
 * overlay on top of the scene: full-screening only the canvas would hide the
 * controls.
 *
 * Where the Fullscreen API is unavailable (jsdom, older browsers, a
 * document without the API) the button renders nothing, so the view never
 * offers a control that cannot work.
 *
 * The button is mounted by the 3D HUD's top bar (3D-H2), in front of the
 * full-window stage. Leaving full screen on a view switch does not wait for it:
 * `fullscreen.ts` owns that, and App calls it (3D-14).
 */

import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { exitFullscreenIfActive } from '../fullscreen';

export interface FullscreenButtonProps {
  /** The element to full-screen, normally the app shell. */
  readonly target: RefObject<HTMLElement>;
}

function fullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    typeof document.documentElement?.requestFullscreen === 'function'
  );
}

export function FullscreenButton({ target }: FullscreenButtonProps) {
  const supported = fullscreenSupported();
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!supported) return;

    // Only our own target counts: another element being fullscreen must not
    // relabel this button "Exit full screen".
    const sync = () => setActive(document.fullscreenElement === target.current);
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, [supported, target]);

  if (!supported) return null;

  const toggle = () => {
    if (document.fullscreenElement) {
      exitFullscreenIfActive();
      return;
    }
    const element = target.current;
    if (!element) return;
    void element.requestFullscreen().catch(() => undefined);
  };

  return (
    <button
      type="button"
      className="fullscreen-button"
      onClick={toggle}
      title={
        active
          ? 'Leave full screen (the 3D table already fills the window)'
          : 'Fill the whole screen with the table'
      }
    >
      {active ? 'Exit full screen' : 'Full screen'}
    </button>
  );
}
