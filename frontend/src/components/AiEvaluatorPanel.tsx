import type { AiEvaluation, AiStatus } from '../types/ai';
import { actionLabel } from '../types/ai';
import { ActionRanking } from './ActionRanking';

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

  const recommendation = evaluation?.evaluations[0] ?? null;

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
          <ActionRanking
            evaluations={evaluation.evaluations}
            recommendedAction={evaluation.recommended_action}
            limit={MAX_ROWS}
            showOverflow
          />
        </div>
      )}
    </section>
  );
}
