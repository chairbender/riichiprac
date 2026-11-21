import type { AiActionInfo, AiEvaluation } from '../types/ai';
import { formatProbability } from '../types/ai';

interface ActionBarProps {
  actions: AiActionInfo[];
  disabled: boolean;
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
  onAction: (action: AiActionInfo) => void;
}

/**
 * The AI drill's remaining non-discard actions.
 *
 * Calls (Chi/Pon/Kan/Riichi/Pass) are not listed here: they belong to the
 * shared `CallControls` bar, whose click-then-pick flow needs the hand tiles.
 * This strip is what is left once those are removed — a Tsumo or a
 * nine-terminals draw — and every entry is the whole action, so one click
 * submits it.
 */
export function ActionBar({
  actions,
  disabled,
  evaluation,
  revealMortal = false,
  showProbability = true,
  onAction,
}: ActionBarProps) {
  const visible = actions.filter((action) => action.type !== 'discard');
  if (visible.length === 0) return null;

  return (
    <section className="action-bar" aria-label="Available actions">
      {visible.map((action) => {
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
            className="action-button"
            onClick={() => onAction(action)}
            disabled={disabled}
          >
            <span className="action-button-label">{action.label}</span>
            {probability !== undefined && (
              <span className="action-button-probability">
                {formatProbability(probability)}
              </span>
            )}
          </button>
        );
      })}
    </section>
  );
}
