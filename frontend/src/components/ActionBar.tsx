import type { AiActionInfo, AiEvaluation } from '../types/ai';
import { formatProbability } from '../types/ai';

interface ActionBarProps {
  actions: AiActionInfo[];
  disabled: boolean;
  riichiArmed: boolean;
  /** Latest Mortal evaluation for the table, if one exists. */
  evaluation?: AiEvaluation | null;
  /** Whether Mortal's probabilities may be shown. */
  revealMortal?: boolean;
  /**
   * Whether the probability badges are drawn. §5 hides them on square and
   * portrait stages (the verdict sheet still carries them); the button's label
   * is unchanged either way.
   */
  showProbability?: boolean;
  /**
   * Whether the Riichi ON/OFF word is drawn. §5's portrait band draws labels
   * only; `aria-pressed` still carries the state.
   */
  showState?: boolean;
  onToggleRiichi: () => void;
  onAction: (action: AiActionInfo) => void;
}

/**
 * Call/win/pass controls for an AI scenario. Plain discards stay on the hand
 * tiles; this bar exposes every other legal action.
 */
export function ActionBar({
  actions,
  disabled,
  riichiArmed,
  evaluation,
  revealMortal = false,
  showProbability = true,
  showState = true,
  onToggleRiichi,
  onAction,
}: ActionBarProps) {
  const visible = actions.filter((action) => action.type !== 'discard');
  if (visible.length === 0) return null;

  return (
    <section className="action-bar" aria-label="Available actions">
      {visible.map((action) => {
        const isRiichi = action.action === 'Riichi';
        const active = isRiichi && riichiArmed;
        const probability =
          showProbability && revealMortal
            ? evaluation?.evaluations.find(
                (scored) => scored.action === action.action,
              )?.probability
            : undefined;
        return (
          <button
            key={action.action}
            type="button"
            className={`action-button${
              active ? ' action-button--active' : ''
            }`}
            onClick={() =>
              isRiichi ? onToggleRiichi() : onAction(action)
            }
            disabled={disabled}
            aria-pressed={isRiichi ? riichiArmed : undefined}
          >
            <span className="action-button-label">{action.label}</span>
            {probability !== undefined && (
              <span className="action-button-probability">
                {formatProbability(probability)}
              </span>
            )}
            {isRiichi && showState && (
              <span className="action-button-state">
                {riichiArmed ? 'ON' : 'OFF'}
              </span>
            )}
          </button>
        );
      })}
    </section>
  );
}
