import type { AiActionInfo } from '../types/ai';

interface ActionBarProps {
  actions: AiActionInfo[];
  disabled: boolean;
  riichiArmed: boolean;
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
            {isRiichi && (
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
