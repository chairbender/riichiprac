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
  /**
   * Actions that must stay visible even when they fall outside `limit`.
   * Call decisions pin their call rows here so a low-probability kan or pon
   * cannot disappear under the discards.
   */
  pinnedActions?: string[];
}

/** Ranked probability rows shared by the AI drawer and the explanation. */
export function ActionRanking({
  evaluations,
  recommendedAction,
  limit,
  showOverflow = false,
  pinnedActions,
}: ActionRankingProps) {
  const pinned = new Set(pinnedActions ?? []);
  let rows = evaluations;
  if (limit !== undefined) {
    const visible = new Set(
      evaluations.slice(0, Math.max(limit, 0)).map((action) => action.action),
    );
    for (const action of pinned) visible.add(action);
    rows = evaluations.filter((action) => visible.has(action.action));
  }

  return (
    <>
      <ol className="ai-action-list">
        {rows.map((action) => {
          const isTop =
            action.action === recommendedAction ||
            (recommendedAction == null && action === evaluations[0]);
          const isPinned = pinned.has(action.action) && !isTop;
          return (
            <li
              key={action.action}
              className={`ai-action${isTop ? ' ai-action--top' : ''}${
                isPinned ? ' ai-action--focus' : ''
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
