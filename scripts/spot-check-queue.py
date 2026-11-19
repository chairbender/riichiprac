#!/usr/bin/env python3
"""Print a compact human spot-check sheet from a miner review queue.

    python3 scripts/spot-check-queue.py <review-queue.jsonl> [--sample N] [--seed TEXT]

The queue embeds one complete `riichiprac.scenario-report` per line. This
script prints the answer-bearing fields a reviewer needs to judge teachability
(lesson, hand, answer, section, source family) and keeps the full report out of
the sheet. It is a review aid, not a gate; accept/reject dispositions still go
through `mine_replays review`.
"""
import argparse
import json
import random
import sys


def answer_text(correct):
    if not isinstance(correct, dict):
        return str(correct)
    kind = correct.get("type") or correct.get("action") or "?"
    tile = correct.get("discard") or correct.get("tile")
    return f"{kind} {tile}" if tile else str(kind)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("queue")
    parser.add_argument("--sample", type=int, default=0, help="0 prints every selected item")
    parser.add_argument("--seed", default="q2-spot-check")
    args = parser.parse_args()

    items = [
        json.loads(line)
        for line in open(args.queue, encoding="utf-8")
        if line.strip()
    ]
    selected = [item for item in items if not item.get("held_out")]
    if args.sample and args.sample < len(selected):
        sample = random.Random(args.seed).sample(selected, args.sample)
        sample.sort(key=lambda item: item["queue_id"])
        selected = sample

    print("| queue id | lesson | hand | answer | section | source |")
    print("| --- | --- | --- | --- | --- | --- |")
    for item in selected:
        table = item.get("review", {}).get("table", {})
        hand = table.get("hand_string", "?")
        answer = answer_text(table.get("correct_action", {}))
        print(
            f"| {item.get('queue_id')} | {item.get('lesson')} | `{hand}` | "
            f"{answer} | {item.get('book_section') or '-'} | "
            f"{item.get('replay_family')} |"
        )
    print()
    print(
        f"{len(selected)} item(s) shown; seed `{args.seed}`. "
        "Accept/reject with `mine_replays review --pack <id> --accept/--reject`.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
