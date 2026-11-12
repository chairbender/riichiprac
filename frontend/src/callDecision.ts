import { formatMortalTileForDisplay } from './display';
import type { AiActionEvaluation, AiEvaluation } from './types/ai';
import type { GameState } from './types/game';

/** Call families, matching `ActionKind` in the Rust payload. */
const CALL_TYPES = new Set(['chi', 'pon', 'kan']);

/**
 * Whether this state offers the Kan call as something the player can submit.
 *
 * The hand dock only shows the Call Kan toggle on a Kan lesson, and the action
 * bar only shows it when the payload carries the action. A hand that merely
 * happens to hold four copies is not asking about the quad, so Mortal's kan
 * probability must not be reported as a call decision.
 */
function offersKan(state: GameState): boolean {
  if (state.target_action === 'Kan' || state.call_offer?.action === 'Kan') {
    return true;
  }
  // The AI drill renders every legal action, including a self-turn ankan.
  return (
    state.ai_decision?.actions.some((action) => action.type === 'kan') ?? false
  );
}

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
  state: GameState,
): CallDecision | null {
  if (!evaluation) return null;

  const calls = evaluation.evaluations.filter(
    (action) =>
      CALL_TYPES.has(action.type) &&
      (action.type !== 'kan' || offersKan(state)),
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
    label: action.label || fallbackActionLabel(action.action),
    probability: action.probability,
    declines: action.type === 'pass',
  };
}

function fallbackActionLabel(action: string): string {
  if (action.startsWith('Discard_')) {
    return `Discard ${formatMortalTileForDisplay(
      action.slice('Discard_'.length),
    )}`;
  }
  return action.replace(/_/g, ' ');
}
