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
 * The floating decision panel for a full-screen table stage.
 *
 * The stacked shell puts non-discard choices in an action strip below the
 * table; a full-screen stage has no strip, so it anchors a compact panel over
 * the top-right of the human's hand area instead. Only the Call/Pass case is
 * wired up in this part, but the component takes any action list and submits it
 * through the same store action, so the riichi/dama and push/fold popups can
 * reuse it without a second control.
 *
 * The offline rendered table reuses it with `TableStage` (Task 4); until then
 * the app's two views answer through the action strip, so nothing mounts it.
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
      className="stage-decision-popup"
      aria-label={title}
      role="group"
    >
      <span className="stage-decision-popup-title">{title}</span>
      <div className="stage-decision-actions">
        {actions.map((action) => (
          <button
            key={action.action}
            type="button"
            className={`stage-decision-button${
              action.type === 'pass' ? ' stage-decision-button--pass' : ''
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
