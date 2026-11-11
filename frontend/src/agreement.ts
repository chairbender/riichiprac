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
 * The accepted hand is the point of the setting, so the sentence leads with
 * that and keeps the rejection breakdown short.
 */
export function formatAgreementNotice(report: MortalAgreementReport): string {
  if (report.attempts <= 1) {
    return 'Mortal agrees with the book answer — first candidate.';
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
    notes.push(`${totalRejected} rejected: ${reasons.join(', ')}`);
  }
  if (report.generation_failures > 0) {
    notes.push(
      plural(report.generation_failures, 'generation failure', 'generation failures'),
    );
  }
  const detail = notes.length > 0 ? ` (${notes.join('; ')})` : '';

  return `Mortal agrees with the book answer — accepted on ${plural(report.attempts, 'candidate', 'candidates')}${detail}.`;
}
