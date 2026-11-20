import { describe, expect, it } from "vitest";

import {
  DISPOSITION_SCHEMA,
  QUEUE_SCHEMA,
  VERDICTS_SCHEMA,
  answerText,
  buildVerdictsDocument,
  contextLine,
  dispositionFor,
  dispositionsJsonl,
  filterItems,
  latestVerdicts,
  mortalRanking,
  parseDispositions,
  parseQueue,
  sampleItems,
  sampleKey,
  statusOf,
  summarize,
  utcStamp,
} from "./review-core.mjs";
import { makeItem, makeQueue } from "./review-fixtures.mjs";

const accept = (item, note = "", reviewed_at = "20261119-120000") => ({
  schema: DISPOSITION_SCHEMA,
  version: 1,
  queue_id: item.queue_id,
  decision_id: item.decision_id,
  verdict: "accepted",
  ...(note ? { note } : {}),
  reviewed_at,
});
const reject = (item, note = "", reviewed_at = "20261119-120100") => ({
  ...accept(item, note, reviewed_at),
  verdict: "rejected",
});

describe("queue parsing", () => {
  it("reads one item per non-empty line", () => {
    const items = makeQueue();
    const text = `${items.map((item) => JSON.stringify(item)).join("\n")}\n\n`;
    const parsed = parseQueue(text);
    expect(parsed.map((item) => item.queue_id)).toEqual(["q-001", "q-002", "q-003"]);
  });

  it("names the line of a malformed or foreign document", () => {
    expect(() => parseQueue(`${JSON.stringify(makeItem())}\n{oops}\n`)).toThrow(/queue line 2/);
    const wrong = { ...makeItem(), schema: "something.else" };
    expect(() => parseQueue(JSON.stringify(wrong))).toThrow(new RegExp(QUEUE_SCHEMA));
    expect(() => parseQueue(JSON.stringify({ ...makeItem(), version: 99 }))).toThrow(/newer than/);
  });

  it("treats an empty disposition log as empty and rejects a foreign schema", () => {
    expect(parseDispositions("")).toEqual([]);
    const item = makeItem();
    expect(parseDispositions(JSON.stringify(accept(item)))).toHaveLength(1);
    expect(() => parseDispositions(JSON.stringify({ ...accept(item), schema: "x" }))).toThrow(
      /disposition line 1/,
    );
  });
});

describe("dispositions", () => {
  const items = makeQueue();

  it("folds append-only lines with the latest entry winning", () => {
    const latest = latestVerdicts([accept(items[0], "first"), reject(items[0], "second")]);
    expect(latest.get("q-001").verdict).toBe("rejected");
    expect(statusOf(items[0], latest)).toBe("rejected");
    expect(statusOf(items[1], latest)).toBe("pending");
  });

  it("counts progress over the whole queue, not the filtered view", () => {
    const latest = latestVerdicts([accept(items[0]), reject(items[1])]);
    const summary = summarize(items, latest);
    expect(summary).toMatchObject({ total: 3, accepted: 1, rejected: 1, pending: 1 });
    expect(summary.byLesson).toEqual({ fold_to_riichi: 2, kabe_one_chance: 1 });
    expect(summary.byTurn).toEqual({ mid: 2, late: 1 });
    expect(summarize([], new Map()).total).toBe(0);
  });
});

describe("filters", () => {
  const items = makeQueue();

  it("narrows by lesson, section prefix, source, turn and status", () => {
    const ids = (filter, latest = new Map()) =>
      filterItems(items, latest, filter).map((item) => item.queue_id);

    expect(ids({ lessons: ["fold_to_riichi"] })).toEqual(["q-001", "q-003"]);
    expect(ids({ sections: ["ch8"] })).toEqual(["q-001", "q-002", "q-003"]);
    expect(ids({ sections: ["ch8.3"] })).toEqual(["q-002"]);
    expect(ids({ sections: ["ch8.30"] })).toEqual([]);
    expect(ids({ families: ["akochan_tactics"] })).toEqual(["q-002"]);
    expect(ids({ turns: ["late"] })).toEqual(["q-003"]);
    expect(ids({ turns: ["9"] })).toEqual(["q-002"]);
    expect(ids({ turns: ["11"] })).toEqual([]);
    expect(ids({})).toEqual(["q-001", "q-002", "q-003"]);

    const latest = latestVerdicts([accept(items[0])]);
    expect(ids({ statuses: ["pending"] }, latest)).toEqual(["q-002", "q-003"]);
    expect(ids({ statuses: ["accepted"] }, latest)).toEqual(["q-001"]);
    expect(ids({ lessons: ["fold_to_riichi"], statuses: ["accepted"] }, latest)).toEqual(["q-001"]);
  });
});

describe("deterministic sampling", () => {
  it("draws the same sample for the same seed and keeps queue order", () => {
    const items = makeQueue();
    const first = sampleItems(items, 2, "q2r2-test").map((item) => item.queue_id);
    const again = sampleItems(items, 2, "q2r2-test").map((item) => item.queue_id);
    expect(first).toEqual(again);
    expect(first).toHaveLength(2);
    expect([...first].sort()).toEqual(first);
  });

  it("treats zero as nothing and an oversized sample as the whole filtered pool", () => {
    const items = makeQueue();
    expect(sampleItems(items, 0, "q2r2")).toEqual([]);
    expect(sampleItems(items, -3, "q2r2")).toEqual([]);
    expect(sampleItems(items, 99, "q2r2")).toEqual(items);
  });

  it("samples the filtered pool, never a hidden item", () => {
    const items = makeQueue();
    const pool = filterItems(items, new Map(), { lessons: ["fold_to_riichi"] });
    const sampled = sampleItems(pool, 1, "q2r2");
    expect(sampled).toHaveLength(1);
    expect(["q-001", "q-003"]).toContain(sampled[0].queue_id);
  });

  it("uses the same order key as the Rust CLI, pinned by value", () => {
    // These vectors are pinned in `src/miner/select/review.rs` too. If either
    // implementation changes, the CLI and the browser draw different samples.
    expect(sampleKey("q2r2", "q-001")).toBe(548070798376218475n);
    expect(sampleKey("q2r2", "q-002")).toBe(6933946166570799882n);
    const items = makeQueue();
    expect(sampleItems(items, 2, "q2r2").map((item) => item.queue_id)).toEqual(["q-001", "q-002"]);
  });
});

describe("report reading", () => {
  it("renders the graded answer across every action shape", () => {
    expect(answerText({ type: "fold", discard: "3m" })).toBe("fold 3m");
    expect(answerText({ type: "riichi", discard: "5s" })).toBe("riichi 5s");
    expect(answerText({ type: "dama", discard: "1p" })).toBe("dama 1p");
    expect(answerText({ type: "kan", tile: "7s" })).toBe("kan 7s");
    expect(answerText({ type: "discard", tile: "9m" })).toBe("discard 9m");
    expect(answerText({ type: "pass" })).toBe("pass");
    expect(answerText({ type: "best", action: "Pon" })).toBe("best Pon");
    expect(answerText({ type: "best", label: "Chi 2m 3m on 4m" })).toBe("best Chi 2m 3m on 4m");
    expect(answerText(null)).toBe("?");
  });

  it("summarizes the table context the list shows", () => {
    const item = makeItem();
    const context = contextLine(item.review.table);
    expect(context).toContain("East1");
    expect(context).toContain("You 134");
    expect(context).toContain("dora 5s");
    expect(context).toContain("riichi South");
    expect(context).toContain("shanten 1");
    expect(contextLine(undefined)).toBe("");
  });

  it("sorts the Mortal ranking and caps it", () => {
    const item = makeItem();
    item.review.ai.evaluation.evaluations.push({
      action: "Riichi",
      label: "Riichi",
      type: "riichi",
      probability: 0.9,
    });
    expect(mortalRanking(item)[0]).toEqual({ label: "Riichi", action: "Riichi", probability: 0.9 });
    expect(mortalRanking(item)).toHaveLength(3);
    expect(mortalRanking(item, 1)).toHaveLength(1);
    const withoutAi = makeItem();
    delete withoutAi.review.ai;
    expect(mortalRanking(withoutAi)).toEqual([]);
  });
});

describe("exports", () => {
  const items = makeQueue();

  it("exports only the latest entry per item as a verdicts document", () => {
    const entries = [accept(items[0], "first"), reject(items[1], "bad hand"), reject(items[0], "override")];
    const document = buildVerdictsDocument(entries, "sampled review");
    expect(document.schema).toBe(VERDICTS_SCHEMA);
    expect(document.version).toBe(1);
    expect(document.note).toBe("sampled review");
    expect(document.verdicts).toEqual([
      { queue_id: "q-001", verdict: "rejected", reason: "override" },
      { queue_id: "q-002", verdict: "rejected", reason: "bad hand" },
    ]);
    expect(buildVerdictsDocument([]).verdicts).toEqual([]);
    expect(buildVerdictsDocument([], "  ")).not.toHaveProperty("note");
  });

  it("exports the append-only log verbatim as JSONL", () => {
    const entries = [accept(items[0]), reject(items[0])];
    const lines = dispositionsJsonl(entries).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0].verdict).toBe("accepted");
    expect(lines[1].verdict).toBe("rejected");
    expect(dispositionsJsonl([])).toBe("");
  });

  it("stamps a disposition in the miner's UTC format", () => {
    const entry = dispositionFor(makeItem(), "accepted", "  good drill  ", new Date("2026-11-19T21:34:56Z"));
    expect(entry).toEqual({
      schema: DISPOSITION_SCHEMA,
      version: 1,
      queue_id: "replay.ch8-defense.2026-11-001",
      decision_id: "decision-replay.ch8-defense.2026-11-001",
      verdict: "accepted",
      note: "good drill",
      reviewed_at: "20261119-213456",
    });
    expect(utcStamp(new Date("2026-01-02T03:04:05Z"))).toBe("20260102-030405");
    expect(dispositionFor(makeItem(), "rejected", "   ")).not.toHaveProperty("note");
  });
});
