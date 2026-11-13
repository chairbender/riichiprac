import type { AiActionInfo } from '../types/ai';

interface DecisionPopupProps {
  /** Options to offer, normally the engine's call offer plus Pass. */
  actions: AiActionInfo[];
  /** Short heading, e.g. "Call or pass?". */
  title: string;
  disabled?: boolean;
  onAction: (action: AiActionInfo) => void;
}

/**
 * The isometric view's floating decision panel.
 *
 * The stacked shell puts non-discard choices in an action strip below the
 * table; the isometric stage has no strip, so it anchors a compact panel over
 * the top-right of the human's hand area instead. Only the Call/Pass case is
 * wired up in this part, but the component takes any action list and submits it
 * through the same store action, so the riichi/dama and push/fold popups can
 * reuse it without a second control.
 */
export function DecisionPopup({
  actions,
  title,
  disabled = false,
  onAction,
}: DecisionPopupProps) {
  if (actions.length === 0) return null;

  return (
    <section
      className="iso-decision-popup"
      aria-label={title}
      role="group"
    >
      <span className="iso-decision-popup-title">{title}</span>
      <div className="iso-decision-actions">
        {actions.map((action) => (
          <button
            key={action.action}
            type="button"
            className={`iso-decision-button${
              action.type === 'pass' ? ' iso-decision-button--pass' : ''
            }`}
            onClick={() => onAction(action)}
            disabled={disabled}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}
