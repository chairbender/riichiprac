import { parse_scenario_report } from 'riichiprac';
import { isCorrectAction } from './actions';
import type { GameState } from './types/game';
import type { ParsedReport, ReportErrorPayload } from './types/report';
import { REPORT_SCHEMA } from './types/report';

/** Largest position file the importer accepts (2 MiB). */
export const MAX_STATE_BYTES = 2 * 1024 * 1024;

export interface ExportedState {
  filename: string;
  json: string;
}

export interface ImportedState {
  table: GameState;
  /** Exact JSON to feed into `loadFromJson`. */
  json: string;
  /** True when the file was an older scenario-report rather than a bare state. */
  fromReport: boolean;
}

/**
 * Serialize the current table as a generic, self-contained position file.
 *
 * The payload is the complete `GameState` the engine returned: board, hands,
 * rivers, melds, dora, expected action, and rationale. It is deliberately not a
 * report: there is no answer, reason, or note attached.
 */
export function serializeState(
  state: GameState,
  now: Date = new Date(),
): ExportedState {
  return {
    filename: stateFilename(state, now),
    json: JSON.stringify(state, null, 2),
  };
}

export function stateFilename(state: GameState, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const category = state.category.replace(/[^a-zA-Z0-9_-]/g, '-') || 'state';
  return `riichiprac-state-${category}-${stamp}.json`;
}

/**
 * Parse a position file.
 *
 * Bare `GameState` JSON is the normal format. Files from the older
 * scenario-report flow are still accepted: their embedded `table` is loaded as
 * a plain position, without the report review UI.
 */
export function parseStateFile(text: string): ImportedState {
  if (text.length > MAX_STATE_BYTES) {
    throw new Error(
      `That file is too large (limit ${Math.floor(MAX_STATE_BYTES / 1024)} KiB).`,
    );
  }

  const value = parseJson<unknown>(text);

  if (isRecord(value) && value.schema === REPORT_SCHEMA) {
    const parsed = parseJson<ParsedReport | ReportErrorPayload>(
      parse_scenario_report(text),
    );
    if ('error' in parsed && parsed.error) {
      throw new Error(parsed.error);
    }
    const table = (parsed as ParsedReport).report?.table;
    validateTable(table);
    return {
      table,
      json: JSON.stringify(table, null, 2),
      fromReport: true,
    };
  }

  validateTable(value);
  return { table: value, json: text, fromReport: false };
}

export async function readStateFile(file: File): Promise<string> {
  if (file.size > MAX_STATE_BYTES) {
    throw new Error(
      `That file is too large (limit ${Math.floor(MAX_STATE_BYTES / 1024)} KiB).`,
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

function validateTable(value: unknown): asserts value is GameState {
  if (!isRecord(value)) {
    throw new Error('That file is not a saved position.');
  }

  const table = value as Record<string, unknown>;
  if (!Array.isArray(table.players) || table.players.length !== 4) {
    throw new Error('That position does not have four players.');
  }
  if (
    !table.players.some(
      (player) => isRecord(player) && player.is_human === true,
    )
  ) {
    throw new Error('That position does not have a human player.');
  }
  if (!isCorrectAction(table.correct_action)) {
    throw new Error('That position has no valid expected answer.');
  }
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
