import type { DamaReason, GameState, RiichiTrigger } from '../types/game';

const RIICHI_LABELS: Record<RiichiTrigger, string> = {
  dealer: 'Dealer — the hand is worth more.',
  tanyao: 'Tanyao — every pair and the wait are simples.',
  red_five_wait:
    'Red-five wait — holding the red five means the wait is the regular five.',
  suji_trap:
    "Suji trap — the river contains the wait's suji, making the wait look safer.",
  wait_outside_456: 'Wait outside 4-5-6 — a harder-to-read wait.',
  score_below_mangan: 'Score below Mangan — Riichi adds enough value.',
};

const DAMA_LABELS: Record<DamaReason, string> = {
  not_dealer: 'Not the dealer, so Riichi adds less value.',
  no_tanyao: 'A terminal or honor pair rules out Tanyao.',
  middle_wait: 'The wait is a middle tile (4, 5, or 6).',
  no_red_five_wait: 'The wait is not a red five.',
  no_suji_trap: 'The river contains no suji of the wait.',
  mangan: 'The hand is already Mangan or better without Riichi.',
};

interface ScenarioExplanationProps {
  state: GameState;
}

/** Shows why the scenario's Riichi or Dama answer is correct. */
export function ScenarioExplanation({ state }: ScenarioExplanationProps) {
  const isRiichi = state.correct_action.type === 'riichi';
  const title = isRiichi ? 'Why Riichi?' : 'Why Dama?';

  if (isRiichi) {
    if (state.riichi_triggers.length === 0) return null;
  } else if (state.dama_reasons.length === 0) {
    return null;
  }

  return (
    <section
      className={`scenario-explanation ${
        isRiichi
          ? 'scenario-explanation--riichi'
          : 'scenario-explanation--dama'
      }`}
      aria-label={title}
    >
      <h2 className="scenario-explanation-title">{title}</h2>
      <ul className="scenario-explanation-list">
        {isRiichi
          ? state.riichi_triggers.map((reason) => (
              <li key={reason}>{RIICHI_LABELS[reason]}</li>
            ))
          : state.dama_reasons.map((reason) => (
              <li key={reason}>{DAMA_LABELS[reason]}</li>
            ))}
      </ul>
    </section>
  );
}
