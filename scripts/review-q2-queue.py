#!/usr/bin/env python3
"""Agent-assisted review of the Q2 ch. 8 defense queue.

Reads a `reviews/<pack>/review-queue.jsonl`, applies the mechanical review
rules for a stable-book ch. 8 pack, prints a machine-readable summary, and
exits 1 when any candidate must be rejected.

This is not the human review (Q2r). It removes ambiguous, out-of-scope,
duplicate, spoiling or mechanically broken candidates so the human queue is
only the 100 positions that can teach.
"""
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
    "push_or_fold",
}


def main(path):
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
        if section and not section.startswith("ch8."):
            problems.append("out_of_scope_section")
        if not section:
            problems.append("missing_book_section")
        if lesson not in CH8_LESSONS:
            problems.append("out_of_scope_lesson")
        if item.get("label_kind") != "book":
            problems.append("not_book_label")
        if item.get("label_stability") != "stable":
            problems.append("contested_label")
        if table.get("category") != lesson:
            problems.append("report_lesson_mismatch")
        if not verdict.get("is_correct"):
            problems.append("report_answer_not_legal")
        if table.get("shanten") is not None and table.get("shanten") == 0:
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
    return 0 if summary["rejected"] == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: review_q2.py <review-queue.jsonl>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
