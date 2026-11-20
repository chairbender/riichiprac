#!/usr/bin/env python3
"""Per-lesson book-label yield from the miner database.

The label cache/report (`mine_replays label --json`) counts stable/contested
labels per run, but a run is one replay family. The pack plan needs the same
split per *lesson* across every family, so this script reads the saved labels
back out of the `decisions` table:

    scripts/label-yield-report.py --db ~/riichiprac-data/<corpus>/db/miner.sqlite

`label_json` is the `riichiprac.model-label` document; its `book.lesson` names
the classifier that produced the label and its `stability` is `stable`,
`contested` or `unresolved`. Unresolved labels (a book conflict the model could
not settle) are reported separately because they are not shippable.

The output is JSON on stdout and a short table on stderr, so it can be committed
as a report and read by a human without a second tool.
"""

import argparse
import json
import sqlite3
import sys

QUERY = """
SELECT
    json_extract(label_json, '$.book.lesson') AS lesson,
    json_extract(label_json, '$.stability') AS stability,
    family,
    count(*) AS labels
FROM decisions
WHERE label_json IS NOT NULL
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="path to miner.sqlite")
    parser.add_argument(
        "--classifier-version",
        help="refuse labels from another classifier generation when set",
    )
    parser.add_argument("--out", help="write the JSON report here instead of stdout")
    args = parser.parse_args()

    connection = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    try:
        if args.classifier_version:
            versions = {
                row[0]
                for row in connection.execute(
                    "SELECT DISTINCT classifier_version FROM decisions "
                    "WHERE label_json IS NOT NULL"
                )
            }
            if versions != {args.classifier_version}:
                sys.exit(
                    f"database holds classifier versions {sorted(v or '' for v in versions)}, "
                    f"expected {args.classifier_version}"
                )
        rows = connection.execute(QUERY).fetchall()
    finally:
        connection.close()

    lessons: dict[str, dict[str, int]] = {}
    families: dict[str, dict[str, int]] = {}
    for lesson, stability, family, count in rows:
        if lesson is None:
            continue
        bucket = lessons.setdefault(
            lesson, {"stable": 0, "contested": 0, "unresolved": 0}
        )
        if stability in bucket:
            bucket[stability] += count
        family_bucket = families.setdefault(
            family, {"stable": 0, "contested": 0, "unresolved": 0}
        )
        if stability in family_bucket:
            family_bucket[stability] += count

    report = {
        "schema": "riichiprac.label-yield",
        "version": 1,
        "classifier_version": args.classifier_version,
        "lessons": {
            lesson: {**counts, "total": sum(counts.values())}
            for lesson, counts in sorted(lessons.items())
        },
        "families": {
            family: {**counts, "total": sum(counts.values())}
            for family, counts in sorted(families.items())
        },
    }

    text = json.dumps(report, indent=2) + "\n"
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text)
    else:
        sys.stdout.write(text)

    print(
        f"{'lesson':32} {'stable':>7} {'contested':>10} {'unresolved':>11}",
        file=sys.stderr,
    )
    for lesson, counts in report["lessons"].items():
        print(
            f"{lesson:32} {counts['stable']:>7} {counts['contested']:>10} "
            f"{counts['unresolved']:>11}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
