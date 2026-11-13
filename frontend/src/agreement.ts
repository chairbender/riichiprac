/**
 * Payload handling for the opt-in Mortal-agreement generation filter.
 *
 * `WasmMortalEvaluator.generate_puzzle_with_agreement` returns the table and a
 * report of how much rejection sampling it paid for:
 *
 * ```json
 * { "state": { ...GameState }, "agreement": { ...MortalAgreementReport } }
 * ```
 *
 * Everything here is pure so it can be unit-tested without the WASM module.
 * The rule itself (does Mortal's top action equal the book answer) lives in
 * Rust; this module only reads the result.
 */

import type { MortalAgreementReport } from './types/agreement';

/** Options sent to `generate_puzzle_with_agreement`. */
export const AGREEMENT_OPTIONS = {
  enabled: true,
  max_candidates: 40,
} as const;

/** A parsed agreement payload: the table, re-serialized for `loadFromJson`. */
export interface AgreementPayload {
  stateJson: string;
  report: MortalAgreementReport | null;
}

interface RawPayload {
  error?: unknown;
  state?: unknown;
  agreement?: unknown;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isReport(value: unknown): value is MortalAgreementReport {
  if (typeof value !== 'object' || value === null) return false;
  const report = value as Partial<MortalAgreementReport>;
  const rejected = report.rejected as Partial<
    MortalAgreementReport['rejected']
  > | null;
  return (
    isCount(report.max_candidates) &&
    isCount(report.attempts) &&
    isCount(report.evaluations) &&
    isCount(report.generation_failures) &&
    (report.situation === undefined || typeof report.situation === 'string') &&
    typeof report.accepted === 'boolean' &&
    (report.recommended_action === undefined ||
      typeof report.recommended_action === 'string') &&
    typeof rejected === 'object' &&
    rejected !== null &&
    isCount(rejected.action) &&
    isCount(rejected.tile) &&
    isCount(rejected.incomparable) &&
    isCount(rejected.evaluation_failed)
  );
}

/**
 * Split the WASM envelope into the table JSON and the report.
 *
 * Throws with the engine's own error message when the payload is an error, the
 * same way `loadFromJson` surfaces `{"error": "..."}`.
 */
export function parseAgreementPayload(json: string): AgreementPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('WASM returned an invalid agreement payload');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('WASM returned an invalid agreement payload');
  }

  const payload = parsed as RawPayload;
  if (typeof payload.error === 'string') {
    throw new Error(payload.error);
  }
  if (typeof payload.state !== 'object' || payload.state === null) {
    throw new Error('WASM returned an agreement payload without a table');
  }

  return {
    stateJson: JSON.stringify(payload.state),
    report: isReport(payload.agreement) ? payload.agreement : null,
  };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * One sentence describing what the filter did, shown under the table.
 *
 * The sentence is written for a player, never for the generator: "candidate"
 * is the sampling loop's word for one generated roll, and there is no reason
 * for it to reach the screen. The cost is instead reported as attempts taken
 * to generate a scenario, which is what actually happened.
 *
 * `multipleBookAnswers` marks a scenario whose accepted set holds more than the
 * canonical answer (`GameState.equivalent_tiles` is non-empty). Mortal then
 * only has to match one of them, so the notice must not claim it matched "the"
 * book answer.
 *
 * When the generated state carries a pinned situation, its parameter list is
 * appended so the player can see which condition the hand was deliberately
 * built to isolate — the whole point of drawing the situation before the tiles.
 * The engine writes that string from table facts only; it never names the
 * recommended action, since this notice is on screen before the player answers.
 */
export function formatAgreementNotice(
  report: MortalAgreementReport,
  multipleBookAnswers = false,
): string {
  return withSituation(describeAgreement(report, multipleBookAnswers), report);
}

/**
 * Appends the pinned parameter set when the report carries one.
 *
 * The string is drawn from the table's own facts (`extra han, bad wait,
 * non-dealer`, `one or two live simple winning tiles`) and never names the
 * answer, because the note sits above the answer buttons.
 */
function withSituation(
  notice: string,
  report: MortalAgreementReport,
): string {
  return report.situation ? `${notice} Situation: ${report.situation}.` : notice;
}

function describeAgreement(
  report: MortalAgreementReport,
  multipleBookAnswers: boolean,
): string {
  const book = multipleBookAnswers
    ? 'at least one of the book answers'
    : 'the book answer';
  const head = `Took ${plural(
    report.attempts,
    'attempt',
    'attempts',
  )} to generate a scenario where Mortal agrees with ${book}`;

  if (report.attempts <= 1) {
    return `${head}.`;
  }

  const { rejected } = report;
  const reasons: string[] = [];
  if (rejected.action > 0) {
    reasons.push(plural(rejected.action, 'action mismatch', 'action mismatches'));
  }
  if (rejected.tile > 0) {
    reasons.push(plural(rejected.tile, 'tile mismatch', 'tile mismatches'));
  }
  if (rejected.incomparable > 0) {
    reasons.push(
      plural(rejected.incomparable, 'incomparable answer', 'incomparable answers'),
    );
  }
  if (rejected.evaluation_failed > 0) {
    reasons.push(
      plural(rejected.evaluation_failed, 'evaluation failure', 'evaluation failures'),
    );
  }

  const totalRejected =
    rejected.action +
    rejected.tile +
    rejected.incomparable +
    rejected.evaluation_failed;

  const notes: string[] = [];
  if (totalRejected > 0) {
    notes.push(
      `${plural(totalRejected, 'scenario', 'scenarios')} rejected: ${reasons.join(', ')}`,
    );
  }
  if (report.generation_failures > 0) {
    notes.push(
      plural(report.generation_failures, 'generation failure', 'generation failures'),
    );
  }
  const detail = notes.length > 0 ? ` (${notes.join('; ')})` : '';

  return `${head}${detail}.`;
}
