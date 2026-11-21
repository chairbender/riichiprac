import { NextScenarioButton } from './NextScenarioButton';

interface PostAnswerControlsProps {
  /** Deal the next hand. */
  onNext: () => void;
  /**
   * Return the same hand to its unanswered state, with no re-deal (`resetAnswer`
   * in the game store).
   */
  onReset: () => void;
  /** Disables Next while the next hand is being generated. */
  nextDisabled?: boolean;
  /**
   * `dock` is the 2D hand dock's full-width pair; `card` is the 3D result card's
   * compact pair. Both labels and both handlers stay identical.
   */
  variant?: 'dock' | 'card';
}

/**
 * The two controls a finished hand offers: Reset, and on to the next hand.
 *
 * One component for both views so the 2D dock and the 3D result card cannot
 * drift apart on labels, ordering or disabled state. Reset is always the
 * secondary control: Next keeps the primary styling and the larger tap area.
 */
export function PostAnswerControls({
  onNext,
  onReset,
  nextDisabled = false,
  variant = 'card',
}: PostAnswerControlsProps) {
  return (
    <div className={`post-answer-controls post-answer-controls--${variant}`}>
      <button
        type="button"
        className={`reset-answer-button${
          variant === 'dock' ? ' reset-answer-button--dock' : ''
        }`}
        onClick={onReset}
        aria-label="Reset this answer"
      >
        Reset
      </button>
      <NextScenarioButton
        onClick={onNext}
        disabled={nextDisabled}
        variant={variant === 'dock' ? 'dock' : 'header'}
      />
    </div>
  );
}
