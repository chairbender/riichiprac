import { parse_scenario_report } from 'riichiprac';
import { isCorrectAction } from './actions';
import type { GameState } from './types/game';
import type { ParsedReport, ReportErrorPayload } from './types/report';
import { REPORT_SCHEMA } from './types/report';

/** Largest position file the importer accepts (2 MiB). */
export const MAX_STATE_BYTES = 2 * 1024 * 1024;

/** Schema tag for the current generic position file. */
export const POSITION_SCHEMA = 'riichiprac.position';
export const POSITION_VERSION = 1;
/**
 * Longest description we keep. Matches the old report note limit so a note from
 * a scenario-report file survives import untruncated.
 */
export const MAX_DESCRIPTION_CHARS = 4000;

/**
 * A saved position: the engine's `GameState` plus optional free-text context.
 * `description` is absent when the exporter had nothing to say.
 */
export interface PositionFile {
  schema: string;
  version: number;
  description?: string;
  table: GameState;
}

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
  /**
   * Trimmed free-text context from the file, or null when it carried none.
   * Older scenario reports contribute their report note.
   */
  description: string | null;
}

/**
 * Serialize the current table as a generic, self-contained position file.
 *
 * The payload is the complete `GameState` the engine returned: board, hands,
 * rivers, melds, dora, expected action, and rationale, wrapped in a small
 * envelope so it can also carry an optional description. It is deliberately not
 * a report: there is no submitted answer or reason attached.
 *
 * A blank description is omitted entirely, so an undescribed export carries no
 * context field.
 */
export function serializeState(
  state: GameState,
  description?: string | null,
  now: Date = new Date(),
): ExportedState {
  const file: PositionFile = {
    schema: POSITION_SCHEMA,
    version: POSITION_VERSION,
    table: state,
  };
  const trimmed = normalizeDescription(description);
  if (trimmed) {
    file.description = trimmed;
  }

  return {
    filename: stateFilename(state, now),
    json: JSON.stringify(file, null, 2),
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
 * The normal format is a `riichiprac.position` envelope with the table and an
 * optional description. Bare `GameState` JSON (files from before the
 * description existed) is still accepted. Files from the older
 * scenario-report flow too: their embedded `table` is loaded as a plain
 * position, without the report review UI, and the report note becomes the
 * description.
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
    const report = (parsed as ParsedReport).report;
    const table = report?.table;
    validateTable(table);
    return {
      table,
      json: JSON.stringify(table, null, 2),
      fromReport: true,
      description: normalizeDescription(report?.decision?.note),
    };
  }

  if (isRecord(value) && value.schema === POSITION_SCHEMA) {
    validateTable(value.table);
    return {
      table: value.table,
      json: JSON.stringify(value.table, null, 2),
      fromReport: false,
      description: normalizeDescription(value.description),
    };
  }

  validateTable(value);
  return { table: value, json: text, fromReport: false, description: null };
}

/**
 * Trim a description to plain text and cap its length. Returns null for
 * anything that is not a non-blank string.
 *
 * The UI renders the result as text, so React escapes it; this only has to keep
 * the payload small and free of surrounding whitespace.
 */
export function normalizeDescription(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Count code points so a cap never splits a surrogate pair.
  const chars = Array.from(trimmed);
  return chars.length > MAX_DESCRIPTION_CHARS
    ? chars.slice(0, MAX_DESCRIPTION_CHARS).join('')
    : trimmed;
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
