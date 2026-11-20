#!/usr/bin/env python3
"""Agent-assisted mechanical review of a curated replay pack queue.

Reads a `reviews/<pack>/review-queue.jsonl`, applies the mechanical review
rules for a stable-book pack, prints a machine-readable summary, and exits 1
when any selected candidate must be rejected.

This is not the human review. It removes ambiguous, out-of-scope, duplicate,
spoiling or mechanically broken candidates so the human queue is only the
positions that can teach.

The rules are chapter-scoped (`--chapter`):

* `ch8` (default, Q2/Q2r2) — the ch. 8 defense lessons, and a ready hand is
  rejected because it is an offense drill, not a defense drill.
* `ch7` (Q3) — the riichi/dama declaration lessons. Those decisions are tenpai
  by definition, so the ready-hand rule does not apply.

For a large queue (Q2r2), `--verdicts-out FILE` writes one
`riichiprac.review-verdicts` document that
`mine_replays review --verdicts FILE` applies in a single run, instead of
passing thousands of ids on the command line.
"""
import argparse
import collections
import json
import sys

CH8_LESSONS = {
    "fold_to_riichi",
    "defense_safety_chart",
    "suji_kabe_safety",
    "kabe_no_chance",
    "kabe_one_chance",
    "kabe_double_one_chance",
    "kabe_suji_defense",
    "defense_stuck_heuristic",
    "defense_multi_threat",
    "push_or_fold",
}
CH7_LESSONS = {
    "riichi_judgement",
    "chiitoitsu_riichi_vs_dama",
    "dama_bad_wait",
    "dama_genbutsu_wait",
    "dama_expensive_hand",
    "dama_improving_hand",
}

SCOPES = {
    "ch7": {
        "prefix": "ch7.",
        "lessons": CH7_LESSONS,
        "reject_ready_hand": False,
        "note": (
            "q3 mechanical review: stable ch7 book label, legal answer, "
            "unique visible state, clean walk"
        ),
    },
    "ch8": {
        "prefix": "ch8.",
        "lessons": CH8_LESSONS,
        "reject_ready_hand": True,
        "note": (
            "q2r2 mechanical review: stable ch8 book label, legal answer, "
            "unique visible state, clean walk"
        ),
    },
}


def main(path, verdicts_out=None, note=None, chapter="ch8"):
    scope = SCOPES[chapter]
    lessons_allowed = scope["lessons"]
    section_prefix = scope["prefix"]
    reject_ready_hand = scope["reject_ready_hand"]

    items = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
    selected = [item for item in items if not item.get("held_out")]
    held_out = [item for item in items if item.get("held_out")]

    reasons = collections.Counter()
    verdicts = []
    seen_exact = set()
    seen_visible = set()
    sections = collections.Counter()
    lessons = collections.Counter()
    families = collections.Counter()
    kinds = collections.Counter()

    for item in selected:
        problems = []
        review = item.get("review") or {}
        table = review.get("table") or {}
        decision = review.get("decision") or {}
        verdict = decision.get("verdict") or {}
        lesson = item.get("lesson")
        section = item.get("book_section") or ""
        if section and not section.startswith(section_prefix):
            problems.append("out_of_scope_section")
        if not section:
            problems.append("missing_book_section")
        if lesson not in lessons_allowed:
            problems.append("out_of_scope_lesson")
        if item.get("label_kind") != "book":
            problems.append("not_book_label")
        if item.get("label_stability") != "stable":
            problems.append("contested_label")
        if table.get("category") != lesson:
            problems.append("report_lesson_mismatch")
        if not verdict.get("is_correct"):
            problems.append("report_answer_not_legal")
        if (
            reject_ready_hand
            and table.get("shanten") is not None
            and table.get("shanten") == 0
        ):
            # A ready hand is an offense/riichi drill, not a defense drill.
            problems.append("ready_hand")
        if item.get("exact_hash") in seen_exact:
            problems.append("duplicate_exact")
        if item.get("visible_fingerprint") in seen_visible:
            problems.append("duplicate_visible")
        if (item.get("signals") or {}).get("realism", 1.0) < 1.0:
            problems.append("walk_warning")
        seen_exact.add(item.get("exact_hash"))
        seen_visible.add(item.get("visible_fingerprint"))

        sections[section] += 1
        lessons[lesson] += 1
        families[item.get("replay_family")] += 1
        kinds[item.get("decision_kind")] += 1
        for problem in problems:
            reasons[problem] += 1
        verdicts.append(
            {
                "queue_id": item.get("queue_id"),
                "accepted": not problems,
                "problems": problems,
            }
        )

    summary = {
        "queue": path,
        "chapter": chapter,
        "items": len(items),
        "selected": len(selected),
        "held_out": len(held_out),
        "accepted": sum(1 for v in verdicts if v["accepted"]),
        "rejected": sum(1 for v in verdicts if not v["accepted"]),
        "rejection_reasons": dict(reasons),
        "sections": dict(sorted(sections.items())),
        "lessons": dict(sorted(lessons.items())),
        "replay_families": dict(sorted(families.items())),
        "decision_kinds": dict(sorted(kinds.items())),
        "verdicts": verdicts,
    }
    json.dump(summary, sys.stdout, indent=2)
    sys.stdout.write("\n")
    if verdicts_out:
        document = {
            "schema": "riichiprac.review-verdicts",
            "version": 1,
            "note": note or scope["note"],
            "verdicts": [
                {
                    "queue_id": verdict["queue_id"],
                    "verdict": "accepted" if verdict["accepted"] else "rejected",
                    **(
                        {"reason": ", ".join(verdict["problems"])}
                        if verdict["problems"]
                        else {}
                    ),
                }
                for verdict in verdicts
            ],
        }
        with open(verdicts_out, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
    return 0 if summary["rejected"] == 0 else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("queue")
    parser.add_argument("--verdicts-out", help="write a bulk review-verdicts document")
    parser.add_argument("--note", default=None, help="run-wide disposition note")
    parser.add_argument(
        "--chapter",
        choices=sorted(SCOPES),
        default="ch8",
        help="chapter scope for the mechanical rules (default: ch8)",
    )
    args = parser.parse_args()
    sys.exit(main(args.queue, args.verdicts_out, args.note, args.chapter))
