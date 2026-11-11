import type { AiActionEvaluation, AiEvaluation } from './types/ai';

/** Call families, matching `ActionKind` in the Rust payload. */
const CALL_TYPES = new Set(['chi', 'pon', 'kan']);

export interface CallOption {
  /** Mortal action name, or `__decline` for the aggregate no-call option. */
  action: string;
  label: string;
  probability: number;
  /** True for the option that declines the call. */
  declines: boolean;
}

export interface CallDecision {
  /** Short heading, e.g. `Kan decision`. */
  title: string;
  /** The call actions plus the option that declines them. */
  options: CallOption[];
  /** Call action names to keep visible in the full ranking. */
  focusActions: string[];
}

/**
 * Mortal's read on the call the state asks about.
 *
 * A call decision is not a discard decision: the meaningful comparison is the
 * call itself against declining it (keeping the Pon, or passing on the tile).
 * The full ranking usually buries a low-probability call under every discard,
 * so the verdict panel and toast render this side report for any state that
 * offers a chi, pon, or kan.
 */
export function callDecisionFor(
  evaluation: AiEvaluation | null,
): CallDecision | null {
  if (!evaluation) return null;

  const calls = evaluation.evaluations.filter((action) =>
    CALL_TYPES.has(action.type),
  );
  if (calls.length === 0) return null;

  const explicitPass = evaluation.evaluations.find(
    (action) => action.action === 'Pass',
  );
  const kanOnly = calls.every((action) => action.type === 'kan');

  if (explicitPass) {
    return {
      title: kanOnly ? 'Kan decision' : 'Call decision',
      options: [...calls.map(optionFor), optionFor(explicitPass)],
      focusActions: calls.map((action) => action.action),
    };
  }

  // Self-turn calls (added or closed kan) have no Pass action: declining means
  // keeping the hand as it is and discarding, so the no-call probability is
  // every non-call legal action.
  const decline = evaluation.evaluations
    .filter((action) => !CALL_TYPES.has(action.type))
    .reduce((sum, action) => sum + action.probability, 0);

  return {
    title: kanOnly ? 'Kan decision' : 'Call decision',
    options: [
      ...calls.map(optionFor),
      {
        action: '__decline',
        label: kanOnly ? 'No Kan' : 'No call',
        probability: decline,
        declines: true,
      },
    ],
    focusActions: calls.map((action) => action.action),
  };
}

function optionFor(action: AiActionEvaluation): CallOption {
  return {
    action: action.action,
    label: action.label || action.action.replace(/_/g, ' '),
    probability: action.probability,
    declines: action.type === 'pass',
  };
}
