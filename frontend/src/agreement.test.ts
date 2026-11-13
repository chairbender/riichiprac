import { describe, expect, it } from 'vitest';
import { AGREEMENT_OPTIONS, formatAgreementNotice, parseAgreementPayload } from './agreement';
import type { MortalAgreementReport } from './types/agreement';

function report(overrides: Partial<MortalAgreementReport> = {}): MortalAgreementReport {
  return {
    max_candidates: 40,
    attempts: 1,
    evaluations: 1,
    generation_failures: 0,
    accepted: true,
    recommended_action: 'Discard_4p',
    rejected: { action: 0, tile: 0, incomparable: 0, evaluation_failed: 0 },
    ...overrides,
  };
}

const table = {
  category: 'ryanmen_protorun',
  players: [{ seat: 0 }],
  correct_action: { type: 'dama', discard: '4p' },
};

describe('parseAgreementPayload', () => {
  it('splits the table from the report and keeps the table JSON intact', () => {
    const parsed = parseAgreementPayload(
      JSON.stringify({ state: table, agreement: report() }),
    );

    expect(JSON.parse(parsed.stateJson)).toEqual(table);
    expect(parsed.report?.accepted).toBe(true);
    expect(parsed.report?.recommended_action).toBe('Discard_4p');
  });

  it('accepts a payload without a report', () => {
    const parsed = parseAgreementPayload(JSON.stringify({ state: table }));

    expect(JSON.parse(parsed.stateJson)).toEqual(table);
    expect(parsed.report).toBeNull();
  });

  it('drops a report that does not match the Rust shape', () => {
    const parsed = parseAgreementPayload(
      JSON.stringify({
        state: table,
        agreement: { accepted: true, attempts: 'many' },
      }),
    );

    expect(parsed.report).toBeNull();
  });

  it('keeps the pinned situation and rejects a non-string one', () => {
    const withSituation = parseAgreementPayload(
      JSON.stringify({
        state: table,
        agreement: report({ situation: 'riichi: dealer only' }),
      }),
    );
    expect(withSituation.report?.situation).toBe('riichi: dealer only');

    const badSituation = parseAgreementPayload(
      JSON.stringify({
        state: table,
        agreement: { ...report(), situation: 7 },
      }),
    );
    expect(badSituation.report).toBeNull();
  });

  it('surfaces the engine error instead of a table', () => {
    expect(() =>
      parseAgreementPayload(
        JSON.stringify({ error: 'no ryanmen_protorun candidate matched Mortal' }),
      ),
    ).toThrow('no ryanmen_protorun candidate matched Mortal');
  });

  it('rejects a payload with no table', () => {
    expect(() => parseAgreementPayload('{"agreement":{}}')).toThrow(
      'without a table',
    );
    expect(() => parseAgreementPayload('not json')).toThrow('invalid agreement payload');
  });
});

describe('formatAgreementNotice', () => {
  it('reports a scenario that matched on the first attempt', () => {
    expect(formatAgreementNotice(report())).toBe(
      'Took 1 attempt to generate a scenario where Mortal agrees with the book answer.',
    );
  });

  it('lists why earlier scenarios were rejected', () => {
    const notice = formatAgreementNotice(
      report({
        attempts: 5,
        evaluations: 5,
        rejected: { action: 0, tile: 3, incomparable: 1, evaluation_failed: 0 },
      }),
    );

    expect(notice).toBe(
      'Took 5 attempts to generate a scenario where Mortal agrees with the book answer ' +
        '(4 scenarios rejected: 3 tile mismatches, 1 incomparable answer).',
    );
  });

  it('mentions generation failures separately from rejections', () => {
    const notice = formatAgreementNotice(
      report({ attempts: 3, evaluations: 1, generation_failures: 2 }),
    );

    expect(notice).toBe(
      'Took 3 attempts to generate a scenario where Mortal agrees with the book answer ' +
        '(2 generation failures).',
    );
  });

  it('names the pinned situation when the report carries one', () => {
    expect(
      formatAgreementNotice(
        report({ attempts: 5, evaluations: 5, situation: 'riichi: good wait only' }),
      ),
    ).toBe(
      'Took 5 attempts to generate a scenario where Mortal agrees with the book answer. ' +
        'Situation: riichi: good wait only.',
    );
  });

  it('says "at least one" when the scenario accepts several book answers', () => {
    expect(formatAgreementNotice(report(), true)).toBe(
      'Took 1 attempt to generate a scenario where Mortal agrees with at least one of the book answers.',
    );

    expect(
      formatAgreementNotice(
        report({
          attempts: 4,
          evaluations: 4,
          rejected: { action: 2, tile: 1, incomparable: 0, evaluation_failed: 0 },
        }),
        true,
      ),
    ).toBe(
      'Took 4 attempts to generate a scenario where Mortal agrees with at least one of the book answers ' +
        '(3 scenarios rejected: 2 action mismatches, 1 tile mismatch).',
    );
  });

  it('never shows the generator\'s word for a rejected roll', () => {
    expect(formatAgreementNotice(report({ attempts: 2, evaluations: 2 }))).not.toContain(
      'candidate',
    );
  });
});

describe('AGREEMENT_OPTIONS', () => {
  it('asks for the enabled filter with a bounded candidate count', () => {
    expect(AGREEMENT_OPTIONS.enabled).toBe(true);
    expect(AGREEMENT_OPTIONS.max_candidates).toBeGreaterThan(0);
  });
});
