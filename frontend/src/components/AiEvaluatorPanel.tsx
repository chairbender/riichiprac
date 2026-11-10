import type {
  AiActionEvaluation,
  AiEvaluation,
  AiStatus,
} from '../types/ai';
import { formatProbability, tileCodeFromIndex } from '../types/ai';

interface AiEvaluatorPanelProps {
  status: AiStatus;
  error: string | null;
  isEvaluating: boolean;
  evaluation: AiEvaluation | null;
  onEvaluate: () => void;
  onClear: () => void;
  onRetry: () => void;
}

/** How many ranked actions the drawer lists before collapsing the tail. */
const MAX_ROWS = 6;

function actionLabel(action: AiActionEvaluation): string {
  if (action.type === 'discard') {
    const tile = tileCodeFromIndex(action.tile_index);
    const red = action.action.endsWith('r') ? ' (red)' : '';
    return tile ? `Discard ${tile}${red}` : action.action;
  }
  if (action.type === 'agari') return 'Win (agari)';
  if (action.type === 'ryukyoku') return 'Draw (ryukyoku)';
  return action.action.replace('_', ' ');
}

/**
 * Mortal evaluation drawer: lazily loaded weights, an "Evaluate with AI"
 * button, and the ranked action probabilities for the current position.
 */
export function AiEvaluatorPanel({
  status,
  error,
  isEvaluating,
  evaluation,
  onEvaluate,
  onClear,
  onRetry,
}: AiEvaluatorPanelProps) {
  if (status === 'idle' || status === 'loading') {
    return (
      <div className="ai-panel ai-panel--loading" role="status">
        <span className="ai-spinner" aria-hidden="true" />
        <span>Loading Mortal AI weights…</span>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="ai-panel ai-panel--error" role="alert">
        <div className="ai-panel-text">
          <span className="ai-panel-title">AI unavailable</span>
          <span className="ai-panel-detail">{error}</span>
        </div>
        <button className="ai-button" type="button" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  const topActions = evaluation?.evaluations.slice(0, MAX_ROWS) ?? [];
  const recommendation = topActions[0] ?? null;

  return (
    <section className="ai-panel" aria-label="AI evaluation">
      <div className="ai-panel-header">
        <div className="ai-panel-text">
          <span className="ai-panel-title">Mortal AI</span>
          <span className="ai-panel-detail">
            {evaluation
              ? `Expected value ${evaluation.expected_value.toFixed(2)}`
              : 'Compare this decision with the Mortal v4 network'}
          </span>
        </div>

        {evaluation ? (
          <button
            className="ai-button ai-button--ghost"
            type="button"
            onClick={onClear}
          >
            Hide
          </button>
        ) : (
          <button
            className="ai-button"
            type="button"
            onClick={onEvaluate}
            disabled={isEvaluating}
          >
            {isEvaluating ? 'Evaluating…' : 'Evaluate with AI'}
          </button>
        )}
      </div>

      {evaluation && recommendation && (
        <div className="ai-results">
          <p className="ai-recommendation">
            Recommended: <strong>{actionLabel(recommendation)}</strong>
          </p>
          <ol className="ai-action-list">
            {topActions.map((action) => (
              <li
                key={action.action}
                className={`ai-action${
                  action.action === evaluation.recommended_action
                    ? ' ai-action--top'
                    : ''
                }`}
              >
                <span className="ai-action-label">{actionLabel(action)}</span>
                <span className="ai-action-bar" aria-hidden="true">
                  <span
                    style={{
                      width: `${Math.max(action.probability * 100, 1)}%`,
                    }}
                  />
                </span>
                <span className="ai-action-probability">
                  {formatProbability(action.probability)}
                </span>
              </li>
            ))}
          </ol>
          {evaluation.evaluations.length > topActions.length && (
            <p className="ai-more">
              +{evaluation.evaluations.length - topActions.length} more legal
              actions
            </p>
          )}
        </div>
      )}
    </section>
  );
}
