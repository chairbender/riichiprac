/**
 * Whether this mount should use the phone layout
 * (`3d_phone_layout_plan.md` §4).
 *
 * One answer, read by both the HUD (which lays the hand strip out) and the
 * renderer host (which stops drawing the human's hand), so the two can never
 * disagree about who owns the hand. A phone is a **coarse pointer on a stage
 * whose short side is at most {@link HUD_PHONE_MIN_STAGE_SIDE}**: a 932 × 430
 * landscape phone and a 412 × 915 portrait one both qualify, while a tablet
 * (min 768) and every desktop window do not.
 *
 * It re-reads on resize and orientation change for the same reason the HUD
 * does: the browser's own rotation is the only reliable way orientation changes
 * on the platforms that cannot lock it (iPhone, §5).
 */

import { useEffect, useState } from 'react';
import { HUD_PHONE_MIN_STAGE_SIDE, isPhoneStage } from './hudLayout';

function readPhoneStage(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse =
    typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
  return isPhoneStage(
    { width: window.innerWidth, height: window.innerHeight },
    coarse,
  );
}

export function usePhoneStage(): boolean {
  const [phone, setPhone] = useState<boolean>(readPhoneStage);

  useEffect(() => {
    const update = () => setPhone(readPhoneStage());
    update();
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return phone;
}

/** The short side a stage must not exceed to count as a phone. */
export { HUD_PHONE_MIN_STAGE_SIDE };
