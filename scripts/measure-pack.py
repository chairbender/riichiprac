#!/usr/bin/env python3
"""Summarise a shipped scenario pack from its pipeline reports and hosted body.

    python3 scripts/measure-pack.py \
        --selection-report testdata/reports/q2-scale-2k/selection-report.json \
        --assembly-report testdata/reports/q2-scale-2k/assembly-report.json \
        --review-report testdata/reports/q2-scale-2k/review-report.json \
        --manifest frontend/public/scenarios/manifest.json \
        --pack replay.ch8-defense.2026-11 \
        --out testdata/reports/q2-scale-2k/measurements.json

Dependency-free. It reads the same files the checks read and prints the numbers
the Q2/Q2s reports cite: corpus/selection yields, review outcomes, pack bytes,
lesson mix, source replay spread, adjacency and duplicate hands. It never judges
whether a scenario teaches; that is the review sample's job.
"""
import argparse
import collections
import gzip
import hashlib
import json
import sys


def load(path):
    return json.load(open(path, encoding="utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--selection-report", required=True)
    parser.add_argument("--assembly-report", required=True)
    parser.add_argument("--review-report")
    parser.add_argument("--extract-report")
    parser.add_argument("--label-report")
    parser.add_argument("--sample-report")
    parser.add_argument("--manifest", default="frontend/public/scenarios/manifest.json")
    parser.add_argument("--pack", required=True)
    parser.add_argument("--out")
    args = parser.parse_args()

    selection = load(args.selection_report)
    assembly = load(args.assembly_report)
    review = load(args.review_report) if args.review_report else None
    extract = load(args.extract_report) if args.extract_report else None
    labels = load(args.label_report) if args.label_report else None
    sample = load(args.sample_report) if args.sample_report else None
    manifest = load(args.manifest)
    entry = next((item for item in manifest.get("packs", []) if item.get("id") == args.pack), None)
    if entry is None:
        print(f"manifest has no pack `{args.pack}`", file=sys.stderr)
        return 2
    body_path = f"{args.manifest.rsplit('/', 1)[0]}/{entry['path']}"
    with open(body_path, "rb") as handle:
        body_bytes = handle.read()
    body = json.loads(gzip.decompress(body_bytes))

    scenarios = body.get("scenarios", [])
    lessons = collections.Counter(item.get("lesson_id") for item in scenarios)
    sections = sorted({(item.get("book") or {}).get("key") for item in scenarios if item.get("book")})
    replays = [item.get("provenance", {}).get("replay_id") for item in scenarios]
    adjacent = sum(
        1
        for previous, current in zip(replays, replays[1:])
        if previous and previous == current
    )
    hands = [item.get("state", {}).get("hand_string") for item in scenarios]
    hand_counts = collections.Counter(hands)
    largest_share = max(hand_counts.values()) / len(scenarios) if scenarios else 0.0

    source = body.get("source", {})
    document = {
        "schema": "riichiprac.pack-measurements",
        "version": 1,
        "pack_id": args.pack,
        "corpus": none_or(
            extract,
            lambda value: {
                "replays_found": value.get("totals", {}).get("replays_found"),
                "replays_walked": value.get("totals", {}).get("replays_walked"),
                "replays_failed": value.get("totals", {}).get("replays_failed"),
                "decisions_seen": value.get("totals", {}).get("decisions_seen"),
                "decisions_inserted": value.get("totals", {}).get("decisions_inserted"),
                "decisions_updated": value.get("totals", {}).get("decisions_updated"),
            },
        ),
        "labels": none_or(
            labels,
            lambda value: {
                "book_labels": value.get("totals", {}).get("book_labels"),
                "stable": value.get("totals", {}).get("stable"),
                "contested": value.get("totals", {}).get("contested"),
                "cached": value.get("totals", {}).get("decisions_cached"),
                "evaluated": value.get("totals", {}).get("decisions_labelled"),
                "failed": value.get("totals", {}).get("decisions_failed"),
            },
        ),
        "selection": {
            "size_requested": selection.get("pack_size"),
            "selected": selection.get("candidates_selected"),
            "held_out": selection.get("candidates_held_out"),
            "candidates_valid": selection.get("candidates_valid"),
            "replays_walked": selection.get("replays_walked"),
            "replays_failed": selection.get("replays_failed"),
            "decisions_seen": selection.get("decisions_seen"),
            "decisions_labelled": selection.get("decisions_labelled"),
            "cap_relaxed": selection.get("cap_relaxed"),
            "relaxed_fill": selection.get("relaxed_fill"),
            "funnel": selection.get("funnel"),
            "replay_families": selection.get("replay_families"),
            "sections": selection.get("sections"),
            "lesson_counts": selection.get("families"),
            "notes": selection.get("notes"),
        },
        "review": none_or(
            review,
            lambda value: {
                "items": value.get("items"),
                "valid": value.get("valid"),
                "invalid": value.get("invalid"),
                "pending": value.get("pending"),
                "accepted": value.get("accepted"),
                "rejected": value.get("rejected"),
                "sampled": sample.get("sampled") if sample else None,
                "sample_report": args.sample_report if sample else None,
            },
        ),
        "assembly": {
            "bases": assembly.get("bases"),
            "scenarios": assembly.get("scenarios"),
            "variants": assembly.get("variants"),
            "bytes": assembly.get("bytes"),
            "sha256": assembly.get("sha256"),
            "drop_counts": assembly.get("drop_counts"),
            "review": assembly.get("review"),
            "audited": assembly.get("audited"),
            "audit_clean": assembly.get("audit_clean"),
            "max_scenarios": assembly.get("max_scenarios"),
        },
        "manifest_entry": entry,
        "body": {
            "bytes": len(body_bytes),
            "sha256": hashlib.sha256(body_bytes).hexdigest(),
            "gzip_ratio": round(len(body_bytes) / len(gzip.decompress(body_bytes)), 4),
        },
        "pack": {
            "scenarios": len(scenarios),
            "lessons": dict(sorted(lessons.items())),
            "book_sections": sections,
            "replays": len({replay for replay in replays if replay}),
            "adjacent_same_replay_bases": adjacent,
            "unique_hand_strings": len(hand_counts),
            "duplicate_hand_strings": len(scenarios) - len(hand_counts),
            "largest_hand_share": round(largest_share, 6),
            "corpus_id": source.get("corpus_id"),
            "licence": source.get("licence"),
            "data_commercial_use": source.get("data_commercial_use"),
            "agents": [agent.get("agent_id") for agent in source.get("agents", [])],
        },
    }
    text = json.dumps(document, indent=2, sort_keys=True) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
    print(text, end="")
    return 0


def none_or(value, function):
    return function(value) if value is not None else None


if __name__ == "__main__":
    sys.exit(main())
