/**
 * The hand rail's pre-answer Mortal chip (3D-H3), as data.
 *
 * The rail states Mortal's condition in two words because the full line and the
 * Peek/Retry controls live in the verdict sheet (3D-H5), which turns this chip
 * into the sheet's trigger. Keeping the state machine here (rather than in the
 * component) is what lets it be asserted directly, and keeps the component file
 * a component for Fast Refresh.
 *
 * Pure data: no React, no DOM.
 */

import type { AiStatus } from '../../types/ai';

/** Mortal's pre-answer condition, as the chip words it. */
export interface MortalChip {
  /** A stable hook for tests and styling, independent of the wording. */
  readonly state: 'loading' | 'thinking' | 'unavailable' | 'ready' | 'revealed';
  readonly text: string;
  readonly tone: 'loading' | 'ready' | 'bad';
}

export interface MortalChipInput {
  readonly aiStatus: AiStatus;
  readonly isEvaluating: boolean;
  /** Whether a Mortal evaluation exists for this hand. */
  readonly hasEvaluation: boolean;
  /** Mortal's line was revealed before answering. */
  readonly peeked: boolean;
  /** The hand is answered: the result card owns the marks (H5). */
  readonly answered: boolean;
}

/**
 * The chip's state for one Mortal condition, or null when there is nothing to
 * say.
 *
 * Order matters: an error wins, then an in-flight forward pass, then the model
 * still loading, then the evaluation's own state. Post-answer the result card
 * carries Mortal's marks, so the chip is gone.
 */
export function mortalChip({
  aiStatus,
  isEvaluating,
  hasEvaluation,
  peeked,
  answered,
}: MortalChipInput): MortalChip | null {
  if (answered) return null;
  if (aiStatus === 'error') {
    return { state: 'unavailable', text: 'Mortal unavailable', tone: 'bad' };
  }
  if (isEvaluating) {
    return { state: 'thinking', text: 'Mortal thinking…', tone: 'loading' };
  }
  if (aiStatus === 'idle' || aiStatus === 'loading') {
    return { state: 'loading', text: 'Mortal loading…', tone: 'loading' };
  }
  if (peeked) {
    return { state: 'revealed', text: 'Mortal revealed', tone: 'ready' };
  }
  if (hasEvaluation) {
    return { state: 'ready', text: 'Mortal ready', tone: 'ready' };
  }
  return { state: 'loading', text: 'Mortal waiting', tone: 'loading' };
}
