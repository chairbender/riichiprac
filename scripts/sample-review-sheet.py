#!/usr/bin/env python3
"""Build a deterministic, stratified review sheet from a miner review queue (Q2r2).

One-at-a-time app review does not scale past roughly a thousand candidates. This
script turns a 2,000-candidate queue into a compact sheet a human can review:

* every rare lesson is included in full (`--include-all-below`), so the small
  teaching families are never under-checked;
* each lesson and each source replay family gets at least its configured number
  of rows, then the rest is filled by a seeded random sample;
* every row carries the answer-bearing fields only (hand, answer, section,
  round/scores, riichi count, source family), so the sheet stays readable while
  the full report stays in the queue.

It is a review aid, not a gate. Dispositions still go through
`mine_replays review`; pipe this script's `--out-json` summary into the run
report to record what was reviewed.

    python3 scripts/sample-review-sheet.py <review-queue.jsonl> \
        --sample 160 --out-json testdata/reports/q2-scale-2k/review-sample.json
"""
import argparse
import json
import random
import sys
from collections import Counter, defaultdict


def answer_text(correct):
    if not isinstance(correct, dict):
        return str(correct)
    kind = correct.get("type") or correct.get("action") or "?"
    tile = correct.get("discard") or correct.get("tile")
    return f"{kind} {tile}" if tile else str(kind)


def riichi_players(table):
    names = []
    for player in table.get("players") or []:
        if player.get("is_riichi"):
            name = player.get("name") if player.get("is_human") else player.get("wind")
            names.append(name or "?")
    return ",".join(names) if names else "-"


def score_line(table):
    players = table.get("players") or []
    scores = []
    for player in players:
        name = "You" if player.get("is_human") else (player.get("wind") or "?")
        scores.append(f"{name} {player.get('score', 0) // 100}")
    human = next((player for player in players if player.get("is_human")), {})
    delta = (human.get("score", 25000) - 25000) // 100
    return f"{', '.join(scores)} ({delta:+d})"


def context(item):
    table = item.get("review", {}).get("table", {})
    round_label = f"{table.get('round_wind', '?')}{table.get('hand_number', '?')}"
    if table.get("honba"):
        round_label += f" h{table['honba']}"
    dora = "".join(table.get("dora_indicators") or [])
    return (
        f"{round_label}; {score_line(table)}; "
        f"dora `{dora or '-'}`; riichi {riichi_players(table)}; "
        f"shanten {table.get('shanten', '?')}"
    )


def rationale(item):
    table = item.get("review", {}).get("table", {})
    book = table.get("book_rationale") or {}
    summary = book.get("summary") or ""
    return summary.replace("|", "/").strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("queue")
    parser.add_argument("--sample", type=int, default=160,
                        help="minimum rows after the guarantees; rare lessons can add more")
    parser.add_argument("--per-lesson", type=int, default=20)
    parser.add_argument("--per-family", type=int, default=15)
    parser.add_argument("--include-all-below", type=int, default=30,
                        help="include every item of a lesson with at most this many; 0 disables")
    parser.add_argument("--seed", default="q2r2-sample")
    parser.add_argument("--out-json", help="write the sample summary and ids as JSON")
    args = parser.parse_args()

    items = [json.loads(line) for line in open(args.queue, encoding="utf-8") if line.strip()]
    selected = [item for item in items if not item.get("held_out")]
    pool = {item["queue_id"]: item for item in selected}
    rng = random.Random(args.seed)

    lesson_pool = defaultdict(list)
    family_pool = defaultdict(list)
    for item in selected:
        lesson_pool[item.get("lesson") or "none"].append(item)
        family_pool[item.get("replay_family") or "none"].append(item)

    chosen = {}

    def add(item, why):
        chosen.setdefault(item["queue_id"], why)

    if args.include_all_below > 0:
        for lesson, rows in sorted(lesson_pool.items()):
            if len(rows) <= args.include_all_below:
                for item in rows:
                    add(item, f"rare_lesson:{lesson}")

    for lesson, rows in sorted(lesson_pool.items()):
        rows = sorted(rows, key=lambda item: item["queue_id"])
        for item in rng.sample(rows, min(args.per_lesson, len(rows))):
            add(item, f"lesson_guarantee:{lesson}")

    for family, rows in sorted(family_pool.items()):
        rows = sorted(rows, key=lambda item: item["queue_id"])
        for item in rng.sample(rows, min(args.per_family, len(rows))):
            add(item, f"family_guarantee:{family}")

    remaining = [item for item in selected if item["queue_id"] not in chosen]
    remaining.sort(key=lambda item: item["queue_id"])
    target = min(args.sample, len(selected))
    fill = max(0, target - len(chosen))
    for item in rng.sample(remaining, min(fill, len(remaining))):
        add(item, "random_fill")

    sample = [pool[queue_id] for queue_id in sorted(chosen)]
    lessons = Counter(item.get("lesson") or "none" for item in selected)
    sections = Counter(item.get("book_section") or "-" for item in selected)
    families = Counter(item.get("replay_family") or "none" for item in selected)
    sample_lessons = Counter(item.get("lesson") or "none" for item in sample)
    sample_families = Counter(item.get("replay_family") or "none" for item in sample)

    print("# Q2r2 sampled review sheet")
    print()
    print(
        f"Queue `{args.queue}`: {len(selected)} selected bases "
        f"({len(items) - len(selected)} held out). "
        f"Sampled **{len(sample)}** with seed `{args.seed}`."
    )
    print()
    print("| lesson | in queue | sampled |")
    print("| --- | ---: | ---: |")
    for lesson in sorted(lessons):
        print(f"| {lesson} | {lessons[lesson]} | {sample_lessons.get(lesson, 0)} |")
    print()
    print("| section | in queue |")
    print("| --- | ---: |")
    for section in sorted(sections):
        print(f"| {section} | {sections[section]} |")
    print()
    print("| source family | in queue | sampled |")
    print("| --- | ---: | ---: |")
    for family in sorted(families):
        print(f"| {family} | {families[family]} | {sample_families.get(family, 0)} |")
    print()
    print("## Positions")
    print()
    print("| queue id | lesson | section | hand | answer | context | why |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    for item in sample:
        table = item.get("review", {}).get("table", {})
        print(
            f"| {item['queue_id']} | {item.get('lesson') or '-'} | "
            f"{item.get('book_section') or '-'} | `{table.get('hand_string', '?')}` | "
            f"{answer_text(table.get('correct_action', {}))} | {context(item)} | "
            f"{chosen[item['queue_id']]} |"
        )
    print()
    print("## Book rationale")
    print()
    for item in sample:
        text = rationale(item)
        if text:
            print(f"- **{item['queue_id']}** ({item.get('lesson') or '-'}): {text}")
    print()

    summary = {
        "schema": "riichiprac.q2r2-review-sample",
        "version": 1,
        "queue": args.queue,
        "seed": args.seed,
        "items": len(items),
        "selected": len(selected),
        "held_out": len(items) - len(selected),
        "sampled": len(sample),
        "lessons": dict(sorted(lessons.items())),
        "sampled_lessons": dict(sorted(sample_lessons.items())),
        "sections": dict(sorted(sections.items())),
        "replay_families": dict(sorted(families.items())),
        "sampled_replay_families": dict(sorted(sample_families.items())),
        "ids": [{"queue_id": item["queue_id"], "why": chosen[item["queue_id"]]} for item in sample],
    }
    if args.out_json:
        with open(args.out_json, "w", encoding="utf-8") as handle:
            json.dump(summary, handle, indent=2, sort_keys=True)
            handle.write("\n")
    print(
        f"{len(sample)} row(s) shown; {len(selected)} selected base(s) in the queue. "
        "Dispositions: `mine_replays review --pack <id> --accept/--reject`, or "
        "`--verdicts <file>` for a bulk mechanical pass.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
