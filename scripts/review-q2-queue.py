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
* `ch5` (Q4) — the hand-building/value lessons. None of the shipped shapes is a
  tenpai decision (`honitsu_decision` needs 1-2 shanten and refuses a discard
  into tenpai, `chiitoi_vs_toitoi` is exactly 1-away, `pinfu_head` needs >= 2
  shanten), so a ready hand is out of shape and rejected. `sanshoku_pursuit`
  is the one ch. 5 tenpai lesson, but it is far below the coverage floor and is
  not in the pack's lesson scope.
* `ch9` (Q5) — the seating and kan/call lessons. The ready-hand rule is
  **lesson-scoped** here, because these are not offense or defense drills:
  `wind_discard_order` is the only slow-hand shape (its recogniser requires a
  closed hand at 1-shanten or worse), so a ready hand is out of shape. The four
  kan/call lessons keep ready hands: `daiminkan_decision`'s book situations are
  explicitly "ready on a good wait" or "ready but outside the three
  situations", `shouminkan_decision` (kakan) is 1-away **or better**, and
  `ankan_decision`/`meld_or_not` are block-shape and cheap-and-slow rules where
  the hand's distance from tenpai is the argument, not a reason to reject it.
* `ch34` (Q6) — the crossed ch. 3 tile-efficiency / shape lessons and the ch. 4
  ryanmen rule, spanning three book sections (`ch3.2`, `ch3.3`, `ch4.1`), so the
  section scope is a prefix **list**. The ready-hand rule is lesson-scoped from
  each recogniser:
  - `protorun_priority` (ch. 3, ch3:205/230), `pair_count` (ch3:336/343),
    `skipping_block` (ch3:713) and `protorun_plus_one` (ch3:574) are slower-shape
    discards — their recognisers require exactly 1-shanten
    (`protorun_priority`, `protorun_plus_one`) or 2-shanten (`pair_count`,
    `skipping_block`), so a ready hand is out of shape and rejected;
  - `nakabukure_ready` (ch3:690/702, ch4:694/725) and `ryanmen_protorun` (ch. 4
    ryanmen rule) are **tenpai cells by construction**: the nakabukure lesson
    has an explicit ready-hand cell (`shanten == 0`) beside its two 1-away
    cells, and `ryanmen_protorun` recognises a ready hand that partitions into
    three sets, a pair and a side-wait protorun. Their ready hands are in shape
    and kept.

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
CH5_LESSONS = {
    "honitsu_decision",
    "pinfu_head",
    "chiitoi_vs_toitoi",
    "sanshoku_pursuit",
}
CH9_LESSONS = {
    "meld_or_not",
    "daiminkan_decision",
    "ankan_decision",
    "shouminkan_decision",
    "wind_discard_order",
}
CH34_LESSONS = {
    "protorun_priority",
    "pair_count",
    "skipping_block",
    "protorun_plus_one",
    "nakabukure_ready",
    "ryanmen_protorun",
}
# The tenpai-by-construction lessons; the rest of the ch34 scope is 1/2-away.
CH34_READY_LESSONS = CH34_LESSONS - {"nakabukure_ready", "ryanmen_protorun"}

SCOPES = {
    "ch5": {
        "prefix": "ch5.",
        "lessons": CH5_LESSONS,
        # Every shipped ch5 shape is 1-away or slower.
        "ready_hand_lessons": CH5_LESSONS,
        "note": (
            "q4 mechanical review: stable ch5 book label, legal answer, "
            "unique visible state, clean walk; ready hands are out of shape"
        ),
    },
    "ch7": {
        "prefix": "ch7.",
        "lessons": CH7_LESSONS,
        # A riichi/dama decision is tenpai by definition.
        "ready_hand_lessons": set(),
        "note": (
            "q3 mechanical review: stable ch7 book label, legal answer, "
            "unique visible state, clean walk"
        ),
    },
    "ch8": {
        "prefix": "ch8.",
        "lessons": CH8_LESSONS,
        "ready_hand_lessons": CH8_LESSONS,
        "note": (
            "q2r2 mechanical review: stable ch8 book label, legal answer, "
            "unique visible state, clean walk"
        ),
    },
    "ch9": {
        "prefix": "ch9.",
        "lessons": CH9_LESSONS,
        # Only the seating lesson is a slow-hand discard. The kan/call lessons
        # are reactions where tenpai is intrinsic (a daiminkan's book situation
        # is "ready on a good wait"; kakan is 1-away or better), so their ready
        # hands are in shape.
        "ready_hand_lessons": {"wind_discard_order"},
        "note": (
            "q5 mechanical review: stable ch9 book label, legal answer, "
            "unique visible state, clean walk; a ready hand is out of shape "
            "for wind_discard_order only"
        ),
    },
    "ch34": {
        # Q6 spans ch3.2, ch3.3 and ch4.1, so the scope is a prefix list and
        # the lesson set is explicit. The four shipped ch3.2/ch3.3. discards
        # are 1/2-shanten by construction; nakabukure_ready has a ready cell
        # and ryanmen_protorun is a tenpai decision, so their ready hands stay.
        "prefixes": ("ch3.", "ch4.1"),
        "lessons": CH34_LESSONS,
        "ready_hand_lessons": CH34_READY_LESSONS,
        "note": (
            "q6 mechanical review: stable ch3/ch4 shape book label, legal "
            "answer, unique visible state, clean walk; a ready hand is out of "
            "shape for the 1/2-away shape lessons only"
        ),
    },
}


def section_in_scope(section, prefixes):
    """A section matches when it is a prefix or a dotted child of one.

    `"ch3."` matches `ch3.2` and `ch3.3`; `"ch4.1"` matches itself and any
    `ch4.1.<n>` child. Used by the single-prefix scopes and the Q6 list.
    """
    for prefix in prefixes:
        if prefix.endswith("."):
            if section.startswith(prefix):
                return True
        elif section == prefix or section.startswith(prefix + "."):
            return True
    return False


def main(path, verdicts_out=None, note=None, chapter="ch8"):
    scope = SCOPES[chapter]
    lessons_allowed = scope["lessons"]
    section_prefixes = scope.get("prefixes") or (scope["prefix"],)
    ready_hand_lessons = scope["ready_hand_lessons"]

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
        if section and not section_in_scope(section, section_prefixes):
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
            lesson in ready_hand_lessons
            and table.get("shanten") is not None
            and table.get("shanten") == 0
        ):
            # A ready hand is an offense/riichi drill, not this lesson's shape.
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
