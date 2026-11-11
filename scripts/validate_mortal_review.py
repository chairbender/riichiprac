#!/usr/bin/env python3
"""Compare mjai.ekyu.moe's Mortal review with our own evaluation.

The reviewer at <https://mjai.ekyu.moe> cannot be submitted to headlessly (its
form is behind a Cloudflare Turnstile), so the workflow is:

1. ``cargo run --release --bin export_tenhou6 -- --scenario <id> --out log.json \
       --evaluate --evaluation-out ours.json``
2. Upload ``log.json`` at <https://mjai.ekyu.moe>:
   * "Custom log (tenhou.net/6 JSON)"
   * target player = the ``player-id`` the exporter printed
   * engine "Mortal", the network the local checkpoint was trained as
   * advanced options: temperature ``1.00`` (so the displayed
     ``pi(a|s)`` is directly comparable with our softmax)
3. ``scripts/validate_mortal_review.py --report <report-url> --evaluation ours.json``

The report page is public, so only the upload itself needs a browser. Pass the
report URL, a saved copy of the page, or `-` to paste the HTML in:

    scripts/validate_mortal_review.py --report https://mjai.ekyu.moe/... \
        --evaluation ours.json
    scripts/validate_mortal_review.py --report page.html --evaluation ours.json
    pbpaste | scripts/validate_mortal_review.py --report - --evaluation ours.json

Both report layouts are understood: the default (KillerDucky) one keeps the
exact values in `title` attributes, and the classic one renders five-decimal
spans, so the classic path compares at ~1e-5 precision.

The comparison focuses on the last decision in the review, which is the
snapshot our log was built to reach:

* ``top_action``  – does Mortal pick the same action we do?
* ``max_probability_delta`` – over the actions both sides list, after both are
  temperature-adjusted to the same ``tau``. A tiny delta means the same
  network on the same observation; a large one means either different weights
  or a different observation.
* ``mask`` – actions one side lists and the other does not. A wrong legal mask
  is the most likely wiring bug, so it is reported separately.

Exit codes: 0 when the top action matches, 1 when it does not, 2 on usage or
parsing errors.
"""

from __future__ import annotations

import argparse
import html
import json
import math
import re
import sys
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

# --- Names -----------------------------------------------------------------

# riichi-mahjong-tiles SVG ids -> our tile codes.
TILE_NAMES = {
    "e": "1z",
    "s": "2z",
    "w": "3z",
    "n": "4z",
    "p": "5z",
    "f": "6z",
    "c": "7z",
}

# Action labels the reviewer prints -> the family we compare on.
# Action words both report layouts print, mapped to our action families. The
# classic layout prints a chi's tiles *before* the word, so the word is looked
# up anywhere in the fragment, and "chii"/"skip" are the classic spellings.
ACTION_WORDS = [
    ("discard", "discard"),
    ("riichi", "riichi"),
    ("pon", "pon"),
    ("chii", "chi"),
    ("chi", "chi"),
    ("kan", "kan"),
    ("ron", "agari"),
    ("tsumo", "agari"),
    ("pass", "pass"),
    ("skip", "pass"),
    ("ryuukyoku", "ryukyoku"),
]

ENTRY_SPLIT = '<details class="collapse entry"'
TAG_RE = re.compile(r"<[^>]+>")
TILE_RE = re.compile(r"#pai-([a-z0-9]+)")
NUMBER = r"-?[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?"
# The KillerDucky layout (the site default) puts the exact values in `title`
# attributes; the classic layout renders `-0.` + `06974` as two spans and no
# title, so it needs its own pattern.
TITLE_ROW_RE = re.compile(
    r"<tr><td>(?P<action>.*?)<td><span title=(?P<q>" + NUMBER + r")>"
    r".*?<td><span title=(?P<prob>" + NUMBER + r")>"
)
CLASSIC_ROW_RE = re.compile(
    r"<tr>\s*<td>\s*(?P<action>.*?)\s*</td>\s*"
    r'<td>\s*<span class="?int"?>(?P<qint>[^<]*)</span>'
    r'<span class="?frac"?>(?P<qfrac>[^<]*)</span>\s*</td>\s*'
    r'<td>\s*<span class="?int"?>(?P<pint>[^<]*)</span>'
    r'<span class="?frac"?>(?P<pfrac>[^<]*)</span>',
    re.DOTALL,
)
SUMMARY_RE = re.compile(r"<summary>(?P<label>[^<]*)")
TEMPERATURE_RE = re.compile(r"temperature[^0-9]*([0-9.]+)", re.IGNORECASE | re.DOTALL)


@dataclass
class Scored:
    action: str
    q: float
    prob: float


@dataclass
class Entry:
    label: str
    player: str
    mortal: str
    details: list[Scored] = field(default_factory=list)


# --- Parsing ---------------------------------------------------------------


def fetch_report(location: str) -> str:
    if location == "-":
        # Let the operator paste the saved page straight into the terminal.
        return sys.stdin.read()
    if location.startswith(("http://", "https://")):
        request = urllib.request.Request(
            location,
            headers={"User-Agent": "riichiprac-mortal-validator/0.1"},
        )
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.read().decode("utf-8", "replace")
    return Path(location).read_text(encoding="utf-8")


def tile_code(svg_id: str) -> str:
    """`3s` -> `3s`, `5mr` -> `5mr`, `e` -> `1z`."""
    if svg_id in TILE_NAMES:
        return TILE_NAMES[svg_id]
    return svg_id


def classify(fragment: str) -> tuple[str, list[str]]:
    """Which action family a rendered action shows, and its tile ids."""
    text = " ".join(html.unescape(TAG_RE.sub(" ", fragment)).lower().split())
    tiles = [tile_code(match) for match in TILE_RE.findall(fragment)]
    for word, family in ACTION_WORDS:
        if re.search(rf"\b{word}\b", text):
            return family, tiles
    return "?", tiles


def action_name(fragment: str) -> str:
    """Turn a rendered action (`Discard <svg…#pai-3s>`, `Chii`, `Skip`) into a name."""
    family, tiles = classify(fragment)
    if family == "discard":
        return f"Discard_{tiles[0]}" if tiles else "Discard_?"
    return {
        "riichi": "Riichi",
        "pon": "Pon",
        "chi": "Chi",
        "kan": "Kan",
        "agari": "Agari",
        "pass": "Pass",
        "ryukyoku": "Ryukyoku",
    }.get(family, "?")


def parse_rows(body: str) -> list[Scored]:
    rows = [
        Scored(
            action=action_name(match.group("action")),
            q=float(match.group("q")),
            prob=float(match.group("prob")),
        )
        for match in TITLE_ROW_RE.finditer(body)
    ]
    if rows:
        return rows
    for match in CLASSIC_ROW_RE.finditer(body):
        q = (match.group("qint") + match.group("qfrac")).replace(" ", "")
        prob = (match.group("pint") + match.group("pfrac")).replace(" ", "")
        try:
            rows.append(
                Scored(
                    action=action_name(match.group("action")),
                    q=float(q),
                    prob=float(prob),
                )
            )
        except ValueError:
            continue
    return rows


def parse_entries(page: str) -> list[Entry]:
    entries: list[Entry] = []
    chunks = page.split(ENTRY_SPLIT)[1:]
    for chunk in chunks:
        end = chunk.find("</details></details>")
        body = chunk if end < 0 else chunk[:end]
        # The classic layout quotes its class attributes; the default one does
        # not. Normalise both before looking for the role labels.
        body = body.replace('class="role"', "class=role")
        summary = SUMMARY_RE.search(body)
        label = summary.group("label").strip() if summary else "?"
        player = ""
        mortal = ""
        player_at = body.find("class=role>Player:")
        mortal_at = body.find("class=role>Mortal:")
        if player_at >= 0:
            player = action_name(
                body[player_at : mortal_at if mortal_at > player_at else None]
            )
        if mortal_at >= 0:
            mortal = action_name(body[mortal_at : body.find("<details>", mortal_at)])
        entries.append(
            Entry(label=label, player=player, mortal=mortal, details=parse_rows(body))
        )
    return entries


def same_family(left: str, right: str) -> bool:
    """Chi_Low/Chi_Mid/Chi_High all print as "Chi" in the report."""
    if left == right:
        return True
    return left.startswith("Chi") and right.startswith("Chi")


def resolve_temperature(page: str, override: float | None) -> tuple[float, str]:
    """The temperature the review ran at, and where that answer came from."""
    if override is not None:
        return override, "--temperature"
    found = find_temperature(page)
    if found is not None:
        return found, "the report"
    # mjai-reviewer's own default; guessing 1.0 here would silently compare
    # two different distributions.
    return 0.1, "the reviewer default (the page does not say)"


def find_temperature(page: str) -> float | None:
    for match in TEMPERATURE_RE.finditer(TAG_RE.sub(" ", page)):
        try:
            return float(match.group(1))
        except ValueError:
            continue
    return None


# --- Comparison ------------------------------------------------------------


def retemperature(
    probabilities: list[float], source_tau: float, target_tau: float
) -> list[float]:
    """Rescale a softmax from `source_tau` to `target_tau` without the logits.

    ``log p = q / tau_s - logsumexp(q / tau_s)``, so ``softmax(q / tau_t)`` is
    ``softmax(log p * tau_s / tau_t)``.
    """
    if not probabilities:
        return []
    scale = source_tau / target_tau
    scaled = [
        (math.log(p) * scale) if p > 0 else -math.inf for p in probabilities
    ]
    top = max(scaled)
    weights = [math.exp(value - top) if math.isfinite(value) else 0.0 for value in scaled]
    total = sum(weights)
    return [weight / total for weight in weights] if total else weights


def compare(ours: dict, entry: Entry, tau: float) -> dict:
    our_actions = [item["action"] for item in ours["evaluations"]]
    our_probs = retemperature(
        [float(item["probability"]) for item in ours["evaluations"]],
        float(ours.get("temperature", 1.0)),
        tau,
    )
    their_probs = {detail.action: detail.prob / 100.0 for detail in entry.details}
    theirs = [detail.action for detail in entry.details]

    our_top = ours["recommended_action"]
    their_top = theirs[0] if theirs else ""
    deltas = [
        abs(their_probs[action] - prob)
        for action, prob in zip(our_actions, our_probs)
        if action in their_probs
    ]
    listed_by_them_only = [
        action for action in theirs if not any(same_family(action, other) for other in our_actions)
    ]
    listed_by_us_only = [
        action for action in our_actions if not any(same_family(action, other) for other in theirs)
    ]
    return {
        "temperature": tau,
        "our_temperature": float(ours.get("temperature", 1.0)),
        "our_top_action": our_top,
        "their_top_action": their_top,
        "top_action_matches": same_family(our_top, their_top),
        "their_player_action": entry.player,
        "our_top_probability": our_probs[0] if our_probs else None,
        "their_top_probability": their_probs.get(theirs[0]) if theirs else None,
        "max_probability_delta": max(deltas) if deltas else None,
        "only_in_report": listed_by_them_only,
        "missing_from_report": listed_by_us_only,
        "their_actions": [
            {"action": detail.action, "q": detail.q, "prob": detail.prob / 100.0}
            for detail in entry.details
        ],
        "our_actions": [
            {"action": action, "prob": prob}
            for action, prob in zip(our_actions, our_probs)
        ],
    }


def print_report(result: dict) -> None:
    print(f"temperature (tau)      {result['temperature']:.2f}")
    print(f"their player action    {result['their_player_action']}")
    print(f"our top action         {result['our_top_action']}")
    print(f"their top action       {result['their_top_action']}")
    print(
        "top action match       "
        + ("yes" if result["top_action_matches"] else "NO")
    )
    if result["max_probability_delta"] is not None:
        print(f"max |dP| (all rows)    {result['max_probability_delta']:.4f}")
    if result["only_in_report"]:
        print(f"only in report         {result['only_in_report']}")
    if result["missing_from_report"]:
        print(f"missing from report    {result['missing_from_report']}")
    print()
    print(f"{'action':<18}{'ours':>10}{'reviewer':>12}")
    theirs = {item["action"]: item for item in result["their_actions"]}
    seen = set()
    for item in result["our_actions"]:
        match = next((key for key in theirs if same_family(item["action"], key)), None)
        prob = theirs[match]["prob"] if match else float("nan")
        if match:
            seen.add(match)
        print(f"{item['action']:<18}{item['prob']:>10.4f}{prob:>12.4f}")
    for item in result["their_actions"]:
        if item["action"] not in seen:
            print(f"{item['action']:<18}{'—':>10}{item['prob']:>12.4f}")


# --- Self-test ------------------------------------------------------------

SVG_NAMES = {code: key for key, code in TILE_NAMES.items()}


def svg_name(action: str) -> str:
    if not action.startswith("Discard_"):
        return ""
    tile = action[len("Discard_"):]
    if tile.endswith("r") and tile[:-1] in ("5m", "5p", "5s"):
        return tile
    return SVG_NAMES.get(tile, tile)


def render_synthetic_report(ours: dict, tau: float) -> str:
    """A report page in the reviewer's shape, built from our own evaluation."""
    source = float(ours.get("temperature", 1.0))
    probs = retemperature(
        [float(item["probability"]) for item in ours["evaluations"]], source, tau
    )
    top = ours["recommended_action"]

    def render(action: str) -> str:
        svg = svg_name(action)
        if svg:
            return (
                f'Discard <svg class=tile><use class=face href=#pai-{svg}></use></svg>'
            )
        return action

    rows = "".join(
        f"<tr><td>{render(item['action'])}<td><span title={index * -0.01}>"
        f"<span class=int>-0.</span><span class=frac>010</span></span>"
        f"<td><span title={prob * 100}><span class=int>{prob * 100:.0f}.</span>"
        f"<span class=frac>000</span></span>"
        for index, (item, prob) in enumerate(zip(ours["evaluations"], probs))
    )
    return (
        "<html><body>"
        f"<dd>softmax temperature (&tau;)<dd>{tau:.2f}"
        f'<details class="collapse entry"><summary>Turn 1 (&times;40) </summary>'
        "<ul class=tehai-state><li><svg class=tile><use class=face href=#pai-1m>"
        '</use></svg></ul><span> <span class=role>Player: </span>Discard '
        '<svg class=tile><use class=face href=#pai-1m></use></svg></span> <br> '
        f'<span class=role>Mortal: </span>{render(top)}'
        "<details><table border=1><thead><tr><th>Action<th>Q<th>prob<tbody>"
        f"{rows}</table></details></details>"
        "</body></html>"
    )


def render_synthetic_classic_report(ours: dict, tau: float) -> str:
    """The same decision in the classic layout: quoted classes, no titles."""
    source = float(ours.get("temperature", 1.0))
    probs = retemperature(
        [float(item["probability"]) for item in ours["evaluations"]], source, tau
    )

    def render(action: str) -> str:
        svg = svg_name(action)
        if svg:
            return (
                'Discard <svg class="tile"><use class="face" '
                f'href="#pai-{svg}"></use></svg>'
            )
        return action

    def decimal(value: float) -> str:
        whole, _, fraction = f"{value:.5f}".partition(".")
        return (
            f'<span class="int">{whole}.</span>'
            f'<span class="frac">{fraction}</span>'
        )

    rows = "".join(
        f"<tr><td>{render(item['action'])}</td>"
        f"<td>{decimal(index * -0.01)}</td><td>{decimal(prob * 100)}</td></tr>"
        for index, (item, prob) in enumerate(zip(ours["evaluations"], probs))
    )
    return (
        "<html><body>"
        f"<dt>softmax temperature (&tau;)<dd>{tau:.2f}"
        '<details class="collapse entry" data-mark-red>'
        "<summary>Turn 3 (60) <span class=\"turn-info\">tenpai</span></summary>"
        '<ul class="tehai-state"><li><svg class="tile"><use class="face" '
        'href="#pai-1m"></use></svg></ul>'
        '<span><span class="role">Player: </span>'
        '<span class="role">Discard <svg class="tile"><use class="face" '
        'href="#pai-1m"></use></svg></span></span><br>'
        f'<span class="role">Mortal: </span>{render(ours["recommended_action"])}'
        '<details><table border="1" class="data"><thead><tr><th>Action</th>'
        "<th>Q</th><th>prob</th></tr></thead><tbody>"
        f"{rows}</tbody></table></details></details>"
        "</body></html>"
    )


def selftest() -> int:
    ours = {
        "scenario": "selftest",
        "temperature": 1.0,
        "recommended_action": "Discard_3s",
        "evaluations": [
            {"action": "Discard_3s", "probability": 0.7},
            {"action": "Discard_1z", "probability": 0.2},
            {"action": "Discard_5mr", "probability": 0.1},
        ],
    }
    for tau in (1.0, 0.1):
        entries = parse_entries(render_synthetic_report(ours, tau))
        assert len(entries) == 1, entries
        result = compare(ours, entries[0], tau)
        assert result["top_action_matches"], result
        assert result["max_probability_delta"] < 1e-6, result
        assert not result["only_in_report"] and not result["missing_from_report"], result
        assert entries[0].details[0].action == "Discard_3s", entries[0].details
        assert entries[0].details[2].action == "Discard_5mr", entries[0].details
        assert entries[0].mortal == "Discard_3s", entries[0].mortal

        # The classic layout prints the same decision with quoted classes and
        # five-digit decimals instead of exact titles.
        entries = parse_entries(render_synthetic_classic_report(ours, tau))
        assert len(entries) == 1, entries
        assert entries[0].player == "Discard_1m", entries[0].player
        assert entries[0].mortal == "Discard_3s", entries[0].mortal
        assert [row.action for row in entries[0].details] == [
            "Discard_3s",
            "Discard_1z",
            "Discard_5mr",
        ], entries[0].details
        classic = compare(ours, entries[0], tau)
        assert classic["top_action_matches"], classic
        assert classic["max_probability_delta"] < 1e-4, classic

    # The classic layout prints a chi's tiles before the word, and spells it
    # with two i's; both must land on our single "Chi" family.
    assert action_name('2m 3m <svg><use href="#pai-4m"></use></svg> Chii') == "Chi"
    assert action_name("Skip") == "Pass"
    assert action_name("Ron") == "Agari"
    assert same_family("Chi_Low", "Chi")
    print("selftest ok")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Compare an mjai.ekyu.moe Mortal report with our evaluation."
    )
    parser.add_argument("--report",
                        help="report URL, a saved HTML file, or '-' to read a pasted page from stdin")
    parser.add_argument("--evaluation",
                        help="the JSON written by `export_tenhou6 --evaluate`")
    parser.add_argument("--temperature", type=float, default=None,
                        help="temperature the review ran at (default: read it from the page, "
                             "falling back to the reviewer's own 0.1)")
    parser.add_argument("--entry", type=int, default=-1,
                        help="which decision to compare, counted from the end (default: last)")
    parser.add_argument("--json", action="store_true", help="print the result as JSON")
    parser.add_argument("--save-html", type=Path, help="also save the fetched page here")
    parser.add_argument("--selftest", action="store_true",
                        help="check the parser against a synthetic report and exit")
    args = parser.parse_args()
    if args.selftest:
        return selftest()
    if not args.report or not args.evaluation:
        parser.error("--report and --evaluation are required (or use --selftest)")

    ours = json.loads(Path(args.evaluation).read_text(encoding="utf-8"))
    page = fetch_report(args.report)
    if args.save_html:
        args.save_html.write_text(page, encoding="utf-8")

    entries = parse_entries(page)
    if not entries:
        print(
            "no review entries found: is this a Mortal report page, and did the "
            "review finish?",
            file=sys.stderr,
        )
        return 2
    entries = [entry for entry in entries if entry.details]
    if not entries:
        print("the report has no decision tables to compare", file=sys.stderr)
        return 2

    tau, tau_source = resolve_temperature(page, args.temperature)
    if tau <= 0:
        print(f"invalid temperature {tau}", file=sys.stderr)
        return 2

    entry = entries[args.entry]
    result = compare(ours, entry, tau)
    result["entry"] = entry.label
    result["entries"] = len(entries)
    result["scenario"] = ours.get("scenario")

    result["temperature_source"] = tau_source

    if args.json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(f"entry                  {entry.label} (#{len(entries) + args.entry} of {len(entries)})")
        print_report(result)
        print(f"temperature source     {tau_source}")

    if not result["top_action_matches"]:
        print(
            "\nThe top actions differ. Either the weights are not the network the "
            "review ran, or our observation does not match Mortal's for this state. "
            "Compare the printed tables action by action.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
