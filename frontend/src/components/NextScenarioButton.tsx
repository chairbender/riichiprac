interface NextScenarioButtonProps {
  onClick: () => void;
  /** True while a puzzle is being generated. */
  disabled?: boolean;
  /**
   * `header` is the compact control in the app header; `dock` is the
   * full-width control pinned with the hand dock after answering.
   */
  variant?: 'header' | 'dock';
}

/**
 * Loads the next scenario. Shared by the header and the post-answer control at
 * the bottom of the screen so both stay in sync (same handler, same disabled
 * state) instead of drifting apart.
 */
export function NextScenarioButton({
  onClick,
  disabled = false,
  variant = 'header',
}: NextScenarioButtonProps) {
  return (
    <button
      type="button"
      className={`new-hand-button${
        variant === 'dock' ? ' new-hand-button--dock' : ''
      }`}
      onClick={onClick}
      disabled={disabled}
      aria-label="Next scenario"
    >
      Next Scenario
    </button>
  );
}
