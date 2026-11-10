import type { AiActionEvaluation } from '../types/ai';
import { actionLabel, formatProbability } from '../types/ai';

interface ActionRankingProps {
  evaluations: AiActionEvaluation[];
  /** Action name to mark as the top/recommended row. */
  recommendedAction?: string | null;
  /** Maximum rows to show; all rows when omitted. */
  limit?: number;
  /** Whether to show the "+N more" footer when truncated. */
  showOverflow?: boolean;
}

/** Ranked probability rows shared by the AI drawer and the explanation. */
export function ActionRanking({
  evaluations,
  recommendedAction,
  limit,
  showOverflow = false,
}: ActionRankingProps) {
  const rows =
    limit === undefined ? evaluations : evaluations.slice(0, Math.max(limit, 0));

  return (
    <>
      <ol className="ai-action-list">
        {rows.map((action) => {
          const isTop =
            action.action === recommendedAction ||
            (recommendedAction == null && action === evaluations[0]);
          return (
            <li
              key={action.action}
              className={`ai-action${isTop ? ' ai-action--top' : ''}`}
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
          );
        })}
      </ol>
      {showOverflow && evaluations.length > rows.length && (
        <p className="ai-more">
          +{evaluations.length - rows.length} more legal actions
        </p>
      )}
    </>
  );
}
