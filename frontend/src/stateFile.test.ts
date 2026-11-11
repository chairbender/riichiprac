import { describe, expect, it, vi } from 'vitest';

// `stateFile.ts` imports the WASM bridge for the legacy report path. Mock it so
// the serializers can be tested without loading the module in Node.
const parseScenarioReportMock = vi.fn();

vi.mock('riichiprac', () => ({
  parse_scenario_report: (text: string) => parseScenarioReportMock(text),
}));

import {
  MAX_DESCRIPTION_CHARS,
  POSITION_SCHEMA,
  parseStateFile,
  serializeState,
} from './stateFile';
import type { GameState } from './types/game';

/** Smallest table `parseStateFile` accepts: four players, one human, an answer. */
function makeTable(category = 'test_scenario'): GameState {
  return {
    category,
    players: [
      { seat: 0, is_human: true },
      { seat: 1, is_human: false },
      { seat: 2, is_human: false },
      { seat: 3, is_human: false },
    ],
    correct_action: { type: 'discard', tile: '1m', discard: '1m' },
  } as unknown as GameState;
}

describe('serializeState / parseStateFile', () => {
  it('round-trips a position with a description', () => {
    const table = makeTable();
    const exported = serializeState(
      table,
      '  Mortal disagrees here: 4m looks safer.  ',
      new Date('2026-11-11T12:00:00Z'),
    );

    const raw = JSON.parse(exported.json) as Record<string, unknown>;
    expect(raw.schema).toBe(POSITION_SCHEMA);
    expect(raw.description).toBe('Mortal disagrees here: 4m looks safer.');

    const imported = parseStateFile(exported.json);
    expect(imported.table).toEqual(table);
    expect(imported.fromReport).toBe(false);
    expect(imported.description).toBe('Mortal disagrees here: 4m looks safer.');
    // The engine only ever sees the bare table.
    expect(JSON.parse(imported.json)).toEqual(table);
  });

  it('omits an absent description from the file and reports none on import', () => {
    const table = makeTable();
    const exported = serializeState(table);

    const raw = JSON.parse(exported.json) as Record<string, unknown>;
    expect(raw).not.toHaveProperty('description');
    expect(raw.table).toEqual(table);

    const imported = parseStateFile(exported.json);
    expect(imported.table).toEqual(table);
    expect(imported.description).toBeNull();
  });

  it('treats a blank description as absent', () => {
    const exported = serializeState(makeTable(), '   \n  ');
    expect(JSON.parse(exported.json)).not.toHaveProperty('description');
    expect(parseStateFile(exported.json).description).toBeNull();
  });

  it('still imports a bare GameState file with no description', () => {
    const table = makeTable('legacy_bare_state');
    const imported = parseStateFile(JSON.stringify(table));

    expect(imported.table).toEqual(table);
    expect(imported.json).toBe(JSON.stringify(table));
    expect(imported.fromReport).toBe(false);
    expect(imported.description).toBeNull();
  });

  it('uses the report note as the description for an old scenario report', () => {
    const table = makeTable('old_report');
    parseScenarioReportMock.mockReturnValue(
      JSON.stringify({
        report: { table, decision: { note: 'The expected answer looks wrong.' } },
      }),
    );

    const imported = parseStateFile(
      JSON.stringify({ schema: 'riichiprac.scenario-report', report: {} }),
    );

    expect(imported.fromReport).toBe(true);
    expect(imported.table).toEqual(table);
    expect(imported.description).toBe('The expected answer looks wrong.');
  });

  it('imports an old scenario report without a note and shows no description', () => {
    parseScenarioReportMock.mockReturnValue(
      JSON.stringify({ report: { table: makeTable('old_report_quiet') } }),
    );

    const imported = parseStateFile(
      JSON.stringify({ schema: 'riichiprac.scenario-report', report: {} }),
    );

    expect(imported.fromReport).toBe(true);
    expect(imported.description).toBeNull();
  });

  it('caps an over-long description and ignores a non-string one', () => {
    const long = 'x'.repeat(MAX_DESCRIPTION_CHARS + 10);
    const raw = JSON.parse(serializeState(makeTable(), long).json) as {
      description: string;
    };
    expect(raw.description).toHaveLength(MAX_DESCRIPTION_CHARS);

    const parsed = parseStateFile(
      JSON.stringify({
        schema: POSITION_SCHEMA,
        version: 1,
        description: 42,
        table: makeTable(),
      }),
    );
    expect(parsed.description).toBeNull();
  });
});
