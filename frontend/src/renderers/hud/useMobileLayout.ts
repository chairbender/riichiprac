/**
 * Whether this mount is a mobile stage, for the HUD.
 *
 * The same rule the board uses (`capabilities.layoutProfileFor`): a coarse
 * pointer on a stage whose short side is at most 500 px. It is read here rather
 * than passed down from the renderer because the HUD is a sibling of the scene
 * and must lay itself out before any renderer exists.
 *
 * Mobile HUD rules (2026-11-21): the compass box is the mobile rectangle, the
 * call row and the result card always sit above the hand with the call row
 * running to the screen's right edge, and an open sheet takes the whole stage
 * below the top bar. Desktop keeps the committed composition.
 */

import { useEffect, useState } from 'react';
import { MOBILE_LAYOUT_MAX_SHORT_SIDE } from '../capabilities';

function readMobileStage(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  return coarse && shortSide > 0 && shortSide <= MOBILE_LAYOUT_MAX_SHORT_SIDE;
}

export function useMobileLayout(): boolean {
  const [mobile, setMobile] = useState<boolean>(readMobileStage);

  useEffect(() => {
    const update = () => setMobile(readMobileStage());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return mobile;
}
