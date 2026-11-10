import {
  build_scenario_report,
  parse_scenario_report,
} from 'riichiprac';
import { isCorrectAction } from './actions';
import type { AiEvaluation } from './types/ai';
import type {
  BuildReportRequest,
  ParsedReport,
  ReportErrorPayload,
  ReportReason,
  ReportVerdict,
  ReportedAction,
  ScenarioReport,
} from './types/report';
import {
  MAX_REPORT_BYTES,
  REPORT_SCHEMA,
} from './types/report';
import type { CorrectAction, GameState } from './types/game';

export interface ReportInput {
  table: GameState;
  answer: ReportedAction;
  reason: ReportReason;
  note: string;
  evaluation: AiEvaluation | null;
  modelId: string;
}

export type ImportedState =
  | { kind: 'report'; parsed: ParsedReport }
  | { kind: 'bare'; table: GameState; json: string };

export const REPORT_REASON_OPTIONS: Array<{
  value: ReportReason;
  label: string;
}> = [
  {
    value: 'expected_action_wrong',
    label: 'The app chose the wrong action (e.g. Riichi vs Dama)',
  },
  {
    value: 'expected_tile_wrong',
    label: 'The app chose the wrong discard tile',
  },
  {
    value: 'explanation_wrong',
    label: 'The answer is right, but the explanation is wrong',
  },
  {
    value: 'ai_evaluation_wrong',
    label: 'The AI evaluation looks wrong',
  },
  { value: 'other', label: 'Something else' },
];

/** Build and serialize a report through the Rust/WASM formatter. */
export function createScenarioReport(input: ReportInput): {
  report: ScenarioReport;
  json: string;
} {
  const request: BuildReportRequest = {
    table: input.table,
    answer: input.answer,
    reason: input.reason,
    note: input.note.trim() || undefined,
    created_at: new Date().toISOString(),
    report_id: newReportId(),
    commit: __BUILD_COMMIT__,
    build_time: __BUILD_TIME__,
  };

  if (input.evaluation) {
    request.ai = {
      model: input.modelId,
      evaluated_at: new Date().toISOString(),
      evaluation: input.evaluation,
    };
  }

  const json = build_scenario_report(JSON.stringify(request));
  const parsed = parseJson<ScenarioReport | ReportErrorPayload>(json);

  if ('error' in parsed && parsed.error) {
    throw new Error(parsed.error);
  }

  return { report: parsed as ScenarioReport, json };
}

/**
 * Parse either a report envelope or a bare `GameState`.
 *
 * Bare states are accepted as a debugging convenience: they load the table but
 * have no reported answer.
 */
export function parseImportedState(text: string): ImportedState {
  if (text.length > MAX_REPORT_BYTES) {
    throw new Error(
      `That file is too large (limit ${Math.floor(MAX_REPORT_BYTES / 1024)} KiB).`,
    );
  }

  const value = parseJson<unknown>(text);
  if (!isRecord(value)) {
    throw new Error('That file is not a Riichi Trainer report.');
  }

  if (value.schema === REPORT_SCHEMA) {
    const parsed = parseJson<ParsedReport | ReportErrorPayload>(
      parse_scenario_report(text),
    );
    if ('error' in parsed && parsed.error) {
      throw new Error(parsed.error);
    }
    validateParsedReport(parsed as ParsedReport);
    return { kind: 'report', parsed: parsed as ParsedReport };
  }

  if (Array.isArray(value.players) && isCorrectAction(value.correct_action)) {
    const table = value as unknown as GameState;
    if (table.players.length !== 4) {
      throw new Error('That game state does not have four players.');
    }
    if (!table.players.some((player) => player.is_human)) {
      throw new Error('That game state does not have a human player.');
    }
    return { kind: 'bare', table, json: text };
  }

  throw new Error(
    'That file is not a Riichi Trainer report. Export one with "Report bad answer" first.',
  );
}

export async function readReportFile(file: File): Promise<string> {
  if (file.size > MAX_REPORT_BYTES) {
    throw new Error(
      `That file is too large (limit ${Math.floor(MAX_REPORT_BYTES / 1024)} KiB).`,
    );
  }
  return file.text();
}

/** Trigger a browser download for a JSON artifact. */
export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function reportFilename(report: ScenarioReport): string {
  const stamp = report.created_at.replace(/[:.]/g, '-').replace('Z', '');
  const id =
    report.report_id.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 8) || 'report';
  const scenario =
    report.scenario.id.replace(/[^a-zA-Z0-9_-]/g, '-') || 'scenario';
  return `riichiprac-report-${scenario}-${stamp}-${id}.json`;
}

/** Mortal action name for the app's expected answer. */
export function mortalActionForCorrect(action: CorrectAction): string {
  switch (action.type) {
    case 'riichi':
      return 'Riichi';
    case 'dama':
      return `Discard_${action.discard}`;
    case 'kan':
      return 'Kan';
    case 'discard':
      return `Discard_${action.tile}`;
    case 'best':
      return action.action;
  }
}

/** Mortal action name for the reporter's answer. */
export function mortalActionForReported(answer: ReportedAction): string {
  switch (answer.action) {
    case 'riichi':
      return 'Riichi';
    case 'dama':
      return `Discard_${answer.tile}`;
    case 'kan':
      return 'Kan';
    case 'discard':
      return `Discard_${answer.tile}`;
    case 'best':
      return answer.action_name ?? `Discard_${answer.tile}`;
  }
}

/**
 * Probability of an action, summing the regular and red variants of a five
 * (Mortal predicts `Discard_5mr` separately from `Discard_5m`).
 */
export function probabilityForAction(
  evaluation: AiEvaluation | null,
  action: string,
): number {
  if (!evaluation) return 0;

  const redVariant = isFiveDiscard(action) ? `${action}r` : null;
  const total = evaluation.evaluations.reduce((sum, scored) => {
    if (scored.action === action) return sum + scored.probability;
    if (redVariant && scored.action === redVariant) {
      return sum + scored.probability;
    }
    return sum;
  }, 0);

  return Number.isFinite(total) ? total : 0;
}

/** Human label for a Mortal action name (`Discard_3p` -> `Discard 3p`). */
export function mortalActionDisplayName(action: string): string {
  if (action.startsWith('Discard_')) {
    const tile = action.slice('Discard_'.length);
    return tile.endsWith('r')
      ? `Discard ${tile.slice(0, -1)} (red)`
      : `Discard ${tile}`;
  }
  if (action === 'Agari') return 'Win (agari)';
  if (action === 'Ryukyoku') return 'Draw (ryukyoku)';
  return action.replace('_', ' ');
}

export function describeCorrectAction(action: CorrectAction): string {
  switch (action.type) {
    case 'riichi':
      return `Riichi, discarding ${action.discard}`;
    case 'dama':
      return `Dama, discarding ${action.discard}`;
    case 'kan':
      return `Added Kan on ${action.tile}`;
    case 'discard':
      return `Pass on the Kan and discard ${action.tile}`;
    case 'best':
      return action.label;
  }
}

export function describeReportedAction(answer: ReportedAction): string {
  switch (answer.action) {
    case 'riichi':
      return `Riichi, discarding ${answer.tile}`;
    case 'dama':
      return `Dama, discarding ${answer.tile}`;
    case 'kan':
      return `Added Kan on ${answer.tile}`;
    case 'discard':
      return `Pass on the Kan and discard ${answer.tile}`;
    case 'best':
      return answer.action_name ?? `Discard ${answer.tile}`;
  }
}

export function verdictLabel(verdict: ReportVerdict): string {
  if (verdict.is_correct) return 'Correct';
  if (!verdict.is_action_correct && !verdict.is_tile_correct) {
    return 'Wrong action and discard';
  }
  if (!verdict.is_action_correct) return 'Wrong action';
  return 'Wrong discard';
}

export function reportReasonLabel(reason: ReportReason): string {
  return (
    REPORT_REASON_OPTIONS.find((option) => option.value === reason)?.label ??
    reason
  );
}

function validateParsedReport(parsed: ParsedReport): void {
  if (!parsed.report || !parsed.verdict) {
    throw new Error('That report is missing its table or verdict.');
  }
  const table = parsed.report.table;
  if (!table || !Array.isArray(table.players) || table.players.length !== 4) {
    throw new Error('That report does not contain four players.');
  }
  if (!isCorrectAction(table.correct_action)) {
    throw new Error('That report has an invalid expected action.');
  }
  if (!table.players.some((player) => player.is_human)) {
    throw new Error('That report does not contain a human player.');
  }
}

function newReportId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function isFiveDiscard(action: string): boolean {
  if (!action.startsWith('Discard_')) return false;
  const tile = action.slice('Discard_'.length);
  return tile.length === 2 && tile[0] === '5' && 'mps'.includes(tile[1]);
}

function parseJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('That file is not valid JSON.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
