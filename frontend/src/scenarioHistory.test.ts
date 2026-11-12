import { describe, expect, it } from 'vitest';
import {
  SCENARIO_HISTORY_KEY,
  SCENARIO_HISTORY_VERSION,
  ScenarioHistory,
  encodeScenarioSnapshot,
  readScenarioSnapshot,
} from './scenarioHistory';
import type { HistoryLike, ScenarioSnapshot } from './scenarioHistory';

const TABLE_JSON = JSON.stringify({
  category: 'push_or_fold',
  correct_action: { type: 'fold', discard: '1z' },
});

function snapshot(overrides: Partial<ScenarioSnapshot> = {}): ScenarioSnapshot {
  return {
    version: SCENARIO_HISTORY_VERSION,
    json: TABLE_JSON,
    selection: { kind: 'all' },
    requireAgreement: true,
    submittedAnswer: null,
    dualGrade: null,
    callRiichi: false,
    callKan: false,
    peekedBeforeAnswer: false,
    evaluation: null,
    mortalAgreement: null,
    positionDescription: null,
    exportDescription: '',
    ...overrides,
  };
}

const ANSWER = {
  action: 'fold' as const,
  tile: '1z',
  tile_index: 3,
  is_tsumogiri: true,
};

const GRADE = {
  mode: 'book_and_mortal' as const,
  book: null,
  mortal: null,
  outcome: 'both_agree' as const,
};

/** A `window.history` stand-in that records what the tracker did. */
function fakeHistory(): {
  target: HistoryLike;
  ops: string[];
  state: () => unknown;
} {
  const ops: string[] = [];
  let current: unknown = null;
  return {
    ops,
    state: () => current,
    target: {
      pushState: (state) => {
        ops.push('push');
        current = state;
      },
      replaceState: (state) => {
        ops.push('replace');
        current = state;
      },
    },
  };
}

describe('readScenarioSnapshot', () => {
  it('round-trips a full snapshot, answer state included', () => {
    const original = snapshot({
      submittedAnswer: ANSWER,
      dualGrade: GRADE,
      peekedBeforeAnswer: true,
      selection: { kind: 'selected', ids: ['push_or_fold', 'riichi_judgement'] },
    });

    expect(readScenarioSnapshot(encodeScenarioSnapshot(original))).toEqual(
      original,
    );
  });

  it('keeps the toggle, agreement and description fields', () => {
    const original = snapshot({
      callRiichi: true,
      requireAgreement: false,
      mortalAgreement: {
        max_candidates: 8,
        attempts: 3,
        evaluations: 3,
        generation_failures: 0,
        accepted: true,
        rejected: {
          action: 1,
          tile: 1,
          incomparable: 0,
          evaluation_failed: 0,
        },
      },
      positionDescription: 'Imported from a file',
      exportDescription: 'Draft note',
    });

    expect(readScenarioSnapshot(encodeScenarioSnapshot(original))).toEqual(
      original,
    );
  });

  it('rejects anything this app did not write', () => {
    for (const state of [
      null,
      undefined,
      'scenario',
      42,
      {},
      { some: 'other state' },
      { [SCENARIO_HISTORY_KEY]: 'not a snapshot' },
      // A snapshot from a future version cannot be trusted to mean the same.
      { [SCENARIO_HISTORY_KEY]: { ...snapshot(), version: 2 } },
    ]) {
      expect(readScenarioSnapshot(state)).toBeNull();
    }
  });

  it('rejects a snapshot with a missing or malformed field', () => {
    const cases: Array<Partial<Record<string, unknown>>> = [
      { json: '' },
      { json: 42 },
      { selection: { kind: 'some' } },
      { selection: { kind: 'selected', ids: [1] } },
      { selection: null },
      { requireAgreement: 'yes' },
      { submittedAnswer: { action: 1, tile: '1z' } },
      { submittedAnswer: { action: 'fold' } },
      { dualGrade: 'agree' },
      { callRiichi: 1 },
      { callKan: null },
      { peekedBeforeAnswer: 'no' },
      { evaluation: [] },
      { mortalAgreement: 'report' },
      { positionDescription: 7 },
      { exportDescription: 7 },
    ];

    for (const broken of cases) {
      const raw = {
        [SCENARIO_HISTORY_KEY]: { ...snapshot(), ...broken },
      };
      expect(readScenarioSnapshot(raw), JSON.stringify(broken)).toBeNull();
    }
  });

  it('copies only the fields it knows about', () => {
    const raw = {
      [SCENARIO_HISTORY_KEY]: {
        ...snapshot(),
        json: TABLE_JSON,
        futureField: 'ignored',
        submittedAnswer: { ...ANSWER, extra: 'ignored' },
      },
    };

    const restored = readScenarioSnapshot(raw);
    expect(restored).not.toBeNull();
    expect(restored).not.toHaveProperty('futureField');
    expect(restored?.submittedAnswer).toEqual(ANSWER);
  });
});

describe('ScenarioHistory', () => {
  it('replaces the launch entry, then pushes every later hand', () => {
    const history = fakeHistory();
    const tracker = new ScenarioHistory(history.target);

    expect(tracker.commit(snapshot())).toBe('replaced');
    expect(tracker.commit(snapshot({ json: '{"hand":2}' }))).toBe('pushed');
    expect(tracker.commit(snapshot({ json: '{"hand":3}' }))).toBe('pushed');
    expect(history.ops).toEqual(['replace', 'push', 'push']);
  });

  it('does not push a duplicate entry for the same table', () => {
    const history = fakeHistory();
    const tracker = new ScenarioHistory(history.target);
    tracker.commit(snapshot());

    // Importing the identical position twice must not make Back step through
    // two entries showing the same hand.
    expect(tracker.commit(snapshot())).toBe('replaced');
    expect(history.ops).toEqual(['replace', 'replace']);
  });

  it('ignores a refresh for a different table than the entry records', () => {
    const history = fakeHistory();
    const tracker = new ScenarioHistory(history.target);
    tracker.commit(snapshot());

    // A deal or import for another hand can have its answer state refresh reach
    // the tracker before `commit`: it must not overwrite the entry Back returns
    // to, and the later commit must still push.
    tracker.update(snapshot({ json: '{"hand":2}' }));
    expect(history.ops).toEqual(['replace']);

    expect(tracker.commit(snapshot({ json: '{"hand":2}' }))).toBe('pushed');
    const stored = readScenarioSnapshot(history.state());
    expect(stored?.json).toBe('{"hand":2}');
  });

  it('keeps the current entry current with the answer state', () => {
    const history = fakeHistory();
    const tracker = new ScenarioHistory(history.target);

    // Nothing to refresh before the first hand is recorded.
    tracker.update(snapshot({ submittedAnswer: ANSWER }));
    expect(history.ops).toEqual([]);

    tracker.commit(snapshot());
    tracker.update(snapshot({ submittedAnswer: ANSWER, dualGrade: GRADE }));

    const stored = readScenarioSnapshot(history.state());
    expect(stored?.submittedAnswer).toEqual(ANSWER);
    expect(stored?.dualGrade).toEqual(GRADE);
    expect(history.ops).toEqual(['replace', 'replace']);
  });

  it('takes over an entry the browser navigated back to', () => {
    const tracker = new ScenarioHistory(fakeHistory().target);
    tracker.commit(snapshot());

    const adopted = tracker.adopt(
      encodeScenarioSnapshot(snapshot({ json: '{"hand":1}' })),
    );
    expect(adopted?.json).toBe('{"hand":1}');
    expect(tracker.claimed).toBe(true);
  });

  it('replaces a foreign entry instead of pushing on top of it', () => {
    const history = fakeHistory();
    const tracker = new ScenarioHistory(history.target);
    tracker.commit(snapshot());

    expect(tracker.adopt({ unrelated: true })).toBeNull();
    expect(tracker.claimed).toBe(false);

    expect(tracker.commit(snapshot({ json: '{"hand":2}' }))).toBe('replaced');
    expect(history.ops).toEqual(['replace', 'replace']);
  });
});
