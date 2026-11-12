/**
 * Scenario navigation for the browser Back/Forward buttons.
 *
 * Every dealt hand becomes one history entry. The entry carries a full
 * {@link ScenarioSnapshot} in `history.state`: the table JSON, how it was drawn,
 * and the answer state (submitted answer, verdict, peek, armed toggles). The URL
 * is left alone, so this is session-level navigation rather than a shareable
 * deep link; see `scenario-history-plan.md` for why deep linking is not part of
 * this change.
 *
 * History state is structured-cloneable and has no URL length limit, which is
 * what lets the whole table plus its verdict travel in the entry. A restored
 * hand is therefore the exact hand the player saw, answer and all, with no
 * regeneration and no second Mortal forward pass.
 */

import type { ScenarioSelection } from './scenarios';
import type { SubmittedAnswer } from './store/useGameStore';
import type { AiEvaluation } from './types/ai';
import type { MortalAgreementReport } from './types/agreement';
import type { DualGrade } from './types/verdict';

/** Version of the snapshot shape written into `history.state`. */
export const SCENARIO_HISTORY_VERSION = 1;

/** Key under which the snapshot is nested in `history.state`. */
export const SCENARIO_HISTORY_KEY = 'riichiprac.scenario';

/**
 * Everything the page needs to put one dealt hand back on screen.
 *
 * `json` is the engine's own `GameState` payload, so a restored table is exactly
 * the table that was stored, not a reconstruction from a seed.
 */
export interface ScenarioSnapshot {
  version: typeof SCENARIO_HISTORY_VERSION;
  /** The `GameState` JSON this hand was loaded from. */
  json: string;
  /** The pool the hand was drawn from, so the picker agrees with it. */
  selection: ScenarioSelection;
  /** Whether the "Mortal must agree" filter was on for this deal. */
  requireAgreement: boolean;

  /** The answer already submitted for this hand, if any. */
  submittedAnswer: SubmittedAnswer | null;
  /** The verdict already shown for that answer, if any. */
  dualGrade: DualGrade | null;
  /** Whether Mortal's line was revealed before answering. */
  peekedBeforeAnswer: boolean;
  /** Armed Riichi declaration, when the player hadn't answered yet. */
  callRiichi: boolean;
  /** Armed Kan call, when the player hadn't answered yet. */
  callKan: boolean;
  /** Mortal's ranking for this table, when it had been computed. */
  evaluation: AiEvaluation | null;
  /** Agreement-filter report for a hand dealt through the filter. */
  mortalAgreement: MortalAgreementReport | null;

  /** Imported position description card, when the hand came from a file. */
  positionDescription: string | null;
  /** Text already typed into the export description box. */
  exportDescription: string;
}

/** The part of `window.history` this module needs, so tests can fake it. */
export interface HistoryLike {
  pushState(data: unknown, unused: string): void;
  replaceState(data: unknown, unused: string): void;
}

/** Wrap a snapshot as the value stored in one history entry. */
export function encodeScenarioSnapshot(
  snapshot: ScenarioSnapshot,
): Record<string, unknown> {
  return { [SCENARIO_HISTORY_KEY]: snapshot };
}

/**
 * Read a snapshot back out of `history.state`.
 *
 * Returns null for anything this app did not write: `history.state` is shared
 * with the rest of the origin (and with entries from before this app loaded), so
 * a foreign or half-valid value must not be restored. Every field is copied
 * explicitly, so an unknown extra key cannot leak through.
 */
export function readScenarioSnapshot(state: unknown): ScenarioSnapshot | null {
  if (!isRecord(state)) return null;

  const raw = state[SCENARIO_HISTORY_KEY];
  if (!isRecord(raw)) return null;
  if (raw.version !== SCENARIO_HISTORY_VERSION) return null;

  const json = raw.json;
  if (typeof json !== 'string' || json.length === 0) return null;

  const selection = readSelection(raw.selection);
  if (!selection) return null;

  const requireAgreement = raw.requireAgreement;
  if (typeof requireAgreement !== 'boolean') return null;

  const submittedAnswer = readSubmittedAnswer(raw.submittedAnswer);
  if (submittedAnswer === undefined) return null;

  const dualGrade = readObjectOrNull(raw.dualGrade);
  if (dualGrade === undefined) return null;

  const callRiichi = raw.callRiichi;
  const callKan = raw.callKan;
  const peekedBeforeAnswer = raw.peekedBeforeAnswer;
  if (
    typeof callRiichi !== 'boolean' ||
    typeof callKan !== 'boolean' ||
    typeof peekedBeforeAnswer !== 'boolean'
  ) {
    return null;
  }

  const evaluation = readObjectOrNull(raw.evaluation);
  if (evaluation === undefined) return null;

  const mortalAgreement = readObjectOrNull(raw.mortalAgreement);
  if (mortalAgreement === undefined) return null;

  const positionDescription = readStringOrNull(raw.positionDescription);
  if (positionDescription === undefined) return null;

  const exportDescription = raw.exportDescription;
  if (typeof exportDescription !== 'string') return null;

  return {
    version: SCENARIO_HISTORY_VERSION,
    json,
    selection,
    requireAgreement,
    submittedAnswer,
    dualGrade: dualGrade as DualGrade | null,
    callRiichi,
    callKan,
    peekedBeforeAnswer,
    evaluation: evaluation as AiEvaluation | null,
    mortalAgreement: mortalAgreement as MortalAgreementReport | null,
    positionDescription,
    exportDescription,
  };
}

/**
 * Writes scenario entries into the browser history.
 *
 * The entry the app was launched on is reused for the first hand: replacing it
 * means Back leaves the app instead of returning to a blank page. Every later
 * deal pushes, so Back walks back through the hands that were actually seen.
 */
export class ScenarioHistory {
  #claimed = false;
  /**
   * Table JSON recorded by the current entry's last `commit`/`adopt`. `update`
   * leaves it alone: refreshing the answer state must not make the entry look
   * like it already holds a different hand.
   */
  #committedJson: string | null = null;

  constructor(private readonly target: HistoryLike) {}

  /** True when the current entry holds a scenario this app wrote. */
  get claimed(): boolean {
    return this.#claimed;
  }

  /**
   * Record the hand now on screen as the current entry.
   *
   * Re-dealing the hand already recorded (importing the same file twice, or a
   * load that produced the identical table) updates that entry instead of
   * stacking a duplicate the Back button would have to step through.
   */
  commit(snapshot: ScenarioSnapshot): 'replaced' | 'pushed' {
    const state = encodeScenarioSnapshot(snapshot);

    if (!this.#claimed || this.#committedJson === snapshot.json) {
      this.target.replaceState(state, '');
      this.#claimed = true;
      this.#committedJson = snapshot.json;
      return 'replaced';
    }

    this.target.pushState(state, '');
    this.#committedJson = snapshot.json;
    return 'pushed';
  }

  /**
   * Keep the current entry in step with the on-screen hand.
   *
   * Called whenever the answer state changes (answer submitted, verdict arrived,
   * toggle armed, description typed), so pressing Back straight after answering
   * and then Forward again restores the answered hand rather than the fresh one.
   * A no-op before the first commit, after navigating to a foreign entry, and for
   * a snapshot of a different table: that one belongs to a deal or import that is
   * about to `commit` itself, and writing it here would overwrite the entry Back
   * has to return to.
   */
  update(snapshot: ScenarioSnapshot): void {
    if (!this.#claimed) return;
    if (snapshot.json !== this.#committedJson) return;
    this.target.replaceState(encodeScenarioSnapshot(snapshot), '');
  }

  /**
   * Take over an entry the browser has just navigated to.
   *
   * Returns the snapshot it holds, or null when the entry was not written by
   * this app; the next deal then replaces that entry instead of pushing onto it.
   */
  adopt(state: unknown): ScenarioSnapshot | null {
    const snapshot = readScenarioSnapshot(state);
    this.#claimed = snapshot !== null;
    this.#committedJson = snapshot?.json ?? null;
    return snapshot;
  }
}

function readSelection(value: unknown): ScenarioSelection | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'all') return { kind: 'all' };
  if (value.kind !== 'selected') return null;
  if (
    !Array.isArray(value.ids) ||
    !value.ids.every((id) => typeof id === 'string')
  ) {
    return null;
  }
  return { kind: 'selected', ids: [...value.ids] };
}

/** `undefined` means "not a valid answer or null"; null is valid. */
function readSubmittedAnswer(
  value: unknown,
): SubmittedAnswer | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  if (typeof value.action !== 'string' || typeof value.tile !== 'string') {
    return undefined;
  }

  const answer: SubmittedAnswer = {
    action: value.action as SubmittedAnswer['action'],
    tile: value.tile,
  };
  if (typeof value.tile_index === 'number') {
    answer.tile_index = value.tile_index;
  }
  if (typeof value.action_name === 'string') {
    answer.action_name = value.action_name;
  }
  if (typeof value.is_tsumogiri === 'boolean') {
    answer.is_tsumogiri = value.is_tsumogiri;
  }
  return answer;
}

/** `undefined` means "not an object and not null". */
function readObjectOrNull(value: unknown): object | null | undefined {
  if (value === null) return null;
  return isRecord(value) ? value : undefined;
}

/** `undefined` means "not a string and not null". */
function readStringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
