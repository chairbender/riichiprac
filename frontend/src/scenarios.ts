/** Scenario categories understood by the WASM `generate_puzzle` dispatcher. */
export type ScenarioId =
  | 'ryanmen_protorun'
  | 'chiitoitsu_riichi_vs_dama'
  | 'shouminkan_decision';

export type ScenarioSelection = 'all' | ScenarioId;

export interface ScenarioOption {
  id: ScenarioId;
  label: string;
  description: string;
}

export const SCENARIOS: ScenarioOption[] = [
  {
    id: 'ryanmen_protorun',
    label: 'Ryanmen Protorun',
    description: 'Block theory: choose the discard that keeps the ryanmen wait.',
  },
  {
    id: 'chiitoitsu_riichi_vs_dama',
    label: 'Chiitoitsu Riichi vs Dama',
    description: 'Seven pairs: decide whether to declare Riichi or stay dama.',
  },
  {
    id: 'shouminkan_decision',
    label: 'Added Kan Decision',
    description:
      'Open Pon, fourth tile drawn: decide whether to upgrade to an Added Kan.',
  },
];

const SCENARIO_BY_ID = new Map(SCENARIOS.map((scenario) => [scenario.id, scenario]));

export function scenarioLabel(category: string): string {
  return SCENARIO_BY_ID.get(category as ScenarioId)?.label ?? category;
}

/** Pick one real scenario at random for the "All scenarios" option. */
export function pickRandomScenario(): ScenarioId {
  return SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)].id;
}
