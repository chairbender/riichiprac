/**
 * Review-queue fixtures shared by the tool's tests.
 *
 * The shape mirrors one `riichiprac.review-item` v1 line from a real
 * `review-queue.jsonl`: the selection metadata a reviewer filters on plus an
 * embedded `riichiprac.scenario-report` with the table, answer and Mortal
 * ranking.
 */

export function makeReport(overrides = {}) {
  const table = {
    category: overrides.category ?? "fold_to_riichi",
    target_action: "fold",
    correct_action: overrides.correct_action ?? { type: "fold", discard: "3m" },
    decision: { kind: "self_turn" },
    scenario_note: overrides.scenario_note,
    hand_string: overrides.hand_string ?? "234m1334556p4678s",
    tiles: ["2m", "3m", "4m", "1p", "4p"],
    shanten: overrides.shanten ?? 1,
    ukeire_tiles: [],
    ukeire_total: 0,
    round_wind: "East",
    hand_number: 1,
    honba: 0,
    riichi_sticks: 0,
    dora_indicators: ["5s"],
    tiles_remaining: 40,
    current_turn: 0,
    players: [
      {
        seat: 0,
        name: "You",
        is_human: true,
        wind: "East",
        score: 13400,
        hand: ["2m", "3m", "4m"],
        draw: "4s",
        discards: [{ tile: "9m" }],
        melds: [],
        is_riichi: false,
      },
      {
        seat: 1,
        name: "Shimocha",
        is_human: false,
        wind: "South",
        score: 36600,
        hand: [],
        draw: null,
        discards: [{ tile: "2p" }, { tile: "5p" }],
        melds: [],
        is_riichi: true,
      },
    ],
  };
  return {
    schema: "riichiprac.scenario-report",
    version: 1,
    report_id: overrides.report_id ?? "11111111-2222-3333-4444-555555555555",
    created_at: "2026-11-18T08:00:00.000Z",
    app: { app_version: "0.1.0", commit: "abc1234", build_time: "2026-11-18T07:00:00Z" },
    scenario: {
      id: overrides.queue_id ?? "replay.ch8-defense.2026-11-001",
      label: "Fold to riichi",
      description: "Pick the safe tile",
      category: overrides.category ?? "fold_to_riichi",
      tags: [],
    },
    decision: {
      prompt: "Which tile do you discard?",
      reason: "other",
      answer: { type: "fold", tile: "3m" },
      verdict: {
        is_correct: true,
        is_action_correct: true,
        is_tile_correct: true,
        expected_action: "fold",
        expected_tile: "3m",
        outcome: "correct",
        mode: "book",
      },
    },
    table,
    ai: overrides.ai ?? {
      model: "mortal_298k.safetensors",
      evaluated_at: "2026-11-18T07:30:00Z",
      evaluation: {
        model: "mortal_298k.safetensors",
        expected_value: 0.1,
        recommended_action: "Discard_3m",
        evaluations: [
          { action: "Discard_3m", label: "Discard 3m", type: "discard", probability: 0.41 },
          { action: "Discard_4s", label: "Discard 4s", type: "discard", probability: 0.22 },
        ],
      },
    },
    human_readable: [],
  };
}

export function makeItem(overrides = {}) {
  const queueId = overrides.queue_id ?? "replay.ch8-defense.2026-11-001";
  return {
    schema: "riichiprac.review-item",
    version: 1,
    queue_id: queueId,
    pack_id: overrides.pack_id ?? "replay.ch8-defense.2026-11",
    decision_id: overrides.decision_id ?? `decision-${queueId}`,
    replay_id: overrides.replay_id ?? "replay-001",
    replay_family: overrides.replay_family ?? "mortal_mirror",
    family: "book",
    families: ["book"],
    rank: 1,
    score: 0.9,
    signals: {},
    held_out: false,
    selection_reason: overrides.selection_reason ?? "family=book;section=ch8.2;kind=self_turn;turn=mid",
    lesson: overrides.lesson ?? "fold_to_riichi",
    book_section: overrides.book_section ?? "ch8.2",
    label_kind: "book",
    label_stability: "stable",
    label_model: "mortal_298k",
    decision_kind: "self_turn",
    event_index: overrides.event_index ?? 12,
    turn: overrides.turn ?? 7,
    turn_bucket: overrides.turn_bucket ?? "mid",
    exact_hash: "exact",
    visible_fingerprint: "visible",
    review: makeReport({ ...overrides, queue_id: queueId }),
  };
}

/** A three-item queue with distinct lessons, sections, sources and turns. */
export function makeQueue() {
  return [
    makeItem({ queue_id: "q-001", lesson: "fold_to_riichi", book_section: "ch8.2" }),
    makeItem({
      queue_id: "q-002",
      lesson: "kabe_one_chance",
      book_section: "ch8.3",
      replay_family: "akochan_tactics",
      turn: 9,
      turn_bucket: "mid",
    }),
    makeItem({
      queue_id: "q-003",
      lesson: "fold_to_riichi",
      book_section: "ch8.1",
      replay_family: "heterogeneous_table",
      turn: 15,
      turn_bucket: "late",
    }),
  ];
}
