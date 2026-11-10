import type { GameState } from '../types/game';
import { ActionRanking } from './ActionRanking';

interface AiDecisionExplanationProps {
  state: GameState;
}

/**
 * Post-answer explanation for an AI scenario. The answer is the model's top
 * legal action; the full ranking is shown so the player can compare every
 * option the model considered.
 */
export function AiDecisionExplanation({ state }: AiDecisionExplanationProps) {
  const ai = state.ai_decision;
  if (!ai) return null;

  const reasoning = ai.reasoning?.trim();
  const title = reasoning || `Best answer per ${ai.model}`;

  const riichiAnswer =
    state.correct_action.type === 'best' &&
    state.correct_action.action === 'Riichi'
      ? state.correct_action.tile
      : null;

  return (
    <section className="ai-explanation" aria-label="AI answer explanation">
      <h2 className="ai-explanation-title">{title}</h2>
      <p className="ai-explanation-detail">
        Expected value {ai.expected_value.toFixed(2)} · {ai.model}
      </p>

      {riichiAnswer && (
        <p className="ai-explanation-riichi">
          Declare Riichi and discard <strong>{riichiAnswer}</strong> (best
          non-Riichi discard).
        </p>
      )}

      <ActionRanking
        evaluations={ai.evaluations}
        recommendedAction={ai.recommended_action}
      />

      <p className="ai-explanation-note">
        This scenario uses the model's top action as the answer. It is not a
        hand-written lesson and may disagree with human heuristics. AI
        recommendation, not ground truth.
      </p>
    </section>
  );
}
