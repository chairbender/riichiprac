#!/usr/bin/env python3
"""Convert Agari Riichi Mahjong replay JSON logs to tenhou.net/6 JSON format."""

from __future__ import annotations

import argparse
from collections import Counter
import json
import re
import sys
import urllib.parse
from pathlib import Path
from typing import Any

SEAT_TO_OFFSET = {"east": 0, "south": 1, "west": 2, "north": 3}
WIND_TO_BASE_KYOKU = {"east": 0, "south": 4, "west": 8, "north": 12}

SUIT_BASE = {"Man": 10, "Pin": 20, "Sou": 30}
AKA_CODE = {"Man": 51, "Pin": 52, "Sou": 53}
HONOR_CODE = {
    "East": 41,
    "South": 42,
    "West": 43,
    "North": 44,
    "White": 45,
    "Green": 46,
    "Red": 47,
}

HONOR_JP = {
    "East": "東",
    "South": "南",
    "West": "西",
    "North": "北",
    "White": "白",
    "Green": "發",
    "Red": "中",
    "Ton": "東",
    "Nan": "南",
    "Sha": "西",
    "Pei": "北",
    "Haku": "白",
    "Hatsu": "發",
    "Chun": "中",
}

# (Japanese name, closed_han, open_han) -- 0 indicates Yakuman
YAKU_MAP: dict[str, tuple[str, int, int]] = {
    "MenzenTsumo": ("門前清自摸和", 1, 0),
    "Riichi": ("立直", 1, 0),
    "DoubleRiichi": ("両立直", 2, 0),
    "Ippatsu": ("一発", 1, 0),
    "Tanyao": ("断幺九", 1, 1),
    "Pinfu": ("平和", 1, 0),
    "Iipeikou": ("一盃口", 1, 0),
    "Ryanpeikou": ("二盃口", 3, 0),
    "Haitei": ("海底摸月", 1, 1),
    "Houtei": ("河底撈魚", 1, 1),
    "Rinshan": ("嶺上開花", 1, 1),
    "Chankan": ("槍槓", 1, 1),
    "YakuhaiEast": ("役牌 東", 1, 1),
    "YakuhaiSouth": ("役牌 南", 1, 1),
    "YakuhaiWest": ("役牌 西", 1, 1),
    "YakuhaiNorth": ("役牌 北", 1, 1),
    "YakuhaiWhite": ("役牌 白", 1, 1),
    "YakuhaiGreen": ("役牌 發", 1, 1),
    "YakuhaiRed": ("役牌 中", 1, 1),
    "YakuhaiTon": ("役牌 東", 1, 1),
    "YakuhaiNan": ("役牌 南", 1, 1),
    "YakuhaiSha": ("役牌 西", 1, 1),
    "YakuhaiPei": ("役牌 北", 1, 1),
    "YakuhaiHaku": ("役牌 白", 1, 1),
    "YakuhaiHatsu": ("役牌 發", 1, 1),
    "YakuhaiChun": ("役牌 中", 1, 1),
    "Toitoi": ("対々和", 2, 2),
    "Sanankou": ("三暗刻", 2, 2),
    "Sankantsu": ("三槓子", 2, 2),
    "SanshokuDoujun": ("三色同順", 2, 1),
    "SanshokuDoukou": ("三色同刻", 2, 2),
    "Ittsu": ("一気通貫", 2, 1),
    "Chanta": ("混全帯幺九", 2, 1),
    "Junchan": ("純全帯幺九", 3, 2),
    "Chiitoitsu": ("七対子", 2, 0),
    "Honroutou": ("混老頭", 2, 2),
    "Shousangen": ("小三元", 2, 2),
    "Honitsu": ("混一色", 3, 2),
    "Chinitsu": ("清一色", 6, 5),
    "KokushiMusou": ("国士無双", 0, 0),
    "KokushiMusou13Wait": ("国士無双１３面待ち", 0, 0),
    "Suuankou": ("四暗刻", 0, 0),
    "SuuankouTanki": ("四暗刻単騎", 0, 0),
    "Daisangen": ("大三元", 0, 0),
    "Shousuushii": ("小四喜", 0, 0),
    "Daisuushii": ("大四喜", 0, 0),
    "Tsuuiisou": ("字一色", 0, 0),
    "Chinroutou": ("清老頭", 0, 0),
    "Ryuuiisou": ("緑一色", 0, 0),
    "ChuurenPoutou": ("九蓮宝燈", 0, 0),
    "JunseiChuurenPoutou": ("純正九蓮宝燈", 0, 0),
    "Suukantsu": ("四槓子", 0, 0),
    "Tenhou": ("天和", 0, 0),
    "Chiihou": ("地和", 0, 0),
}


def snake_to_pascal(name: str) -> str:
    """Convert snake_case identifiers to PascalCase if needed."""
    if "_" not in name:
        return name
    return "".join(part.capitalize() for part in name.split("_") if part)


def tile_obj_to_t6(tile_obj: dict[str, Any]) -> int:
    """Convert an Agari tile dictionary to a tenhou.net/6 integer tile code."""
    tile = tile_obj["tile"] if "tile" in tile_obj else tile_obj
    if "Honor" in tile:
        return HONOR_CODE[tile["Honor"]]
    suited = tile["Suited"]
    suit = suited["suit"]
    value = suited["value"]
    if tile_obj.get("is_aka") and value == 5:
        return AKA_CODE[suit]
    return SUIT_BASE[suit] + value


def tile_id_fallback_to_t6(tile_id: int, aka_count: int = 3) -> int:
    """Fallback conversion from 0..135 tile ID to tenhou.net/6 tile code."""
    if aka_count > 0:
        if tile_id == 16:
            return 51
        if tile_id == 52:
            return 52
        if tile_id == 88:
            return 53
    tile_34 = tile_id // 4
    if tile_34 < 9:
        return 11 + tile_34
    if tile_34 < 18:
        return 21 + (tile_34 - 9)
    if tile_34 < 27:
        return 31 + (tile_34 - 18)
    return 41 + (tile_34 - 27)


def build_id_map(round_data: dict[str, Any], aka_count: int) -> dict[int, int]:
    """Build a complete 0..135 tile ID -> tenhou.net/6 code table from round data."""
    id_map = {tid: tile_id_fallback_to_t6(tid, aka_count) for tid in range(136)}

    def ingest_list(items: list[dict[str, Any]]) -> None:
        for item in items:
            if isinstance(item, dict) and "id" in item and "tile" in item:
                id_map[item["id"]] = tile_obj_to_t6(item)

    for hand in round_data.get("starting_hands", []):
        ingest_list(hand)
    ingest_list(round_data.get("dora_indicators", []))
    ingest_list(round_data.get("wall_tiles", []))
    ingest_list(round_data.get("dead_wall_ura", []))
    ingest_list(round_data.get("dead_wall_kan_draws", []))
    return id_map


def t6_sort_key(code: int) -> tuple[int, int, int]:
    """Sort Tenhou/6 tile codes in standard display order (non-aka before aka)."""
    if code == 51:
        return (1, 5, 51)
    if code == 52:
        return (2, 5, 52)
    if code == 53:
        return (3, 5, 53)
    return (code // 10, code % 10, code)


def normalize_t6_base(code: int) -> int:
    """Map red-five Tenhou/6 codes (51, 52, 53) to their base 5 codes (15, 25, 35)."""
    if code == 51:
        return 15
    if code == 52:
        return 25
    if code == 53:
        return 35
    return code


def rotate_list(items: list[Any], offset: int) -> list[Any]:
    """Rotate a 4-element list so Agari index `offset` becomes Tenhou index 0."""
    n = len(items)
    offset %= n
    return [items[(offset + i) % n] for i in range(n)]


def get_kyoku(round_data: dict[str, Any]) -> int:
    """Compute Tenhou/6 kyoku index (0=East 1, 4=South 1, 8=West 1)."""
    wind = round_data.get("round_wind", "East").lower()
    wind_base = WIND_TO_BASE_KYOKU.get(wind, 0)
    raw_rn = round_data["round_number"]
    return raw_rn if raw_rn >= wind_base else wind_base + raw_rn


def seat_to_tenhou_idx(seat: str, kyoku: int) -> int:
    """Map Agari seat wind in `kyoku` to Tenhou player index (0..3)."""
    seat_offset = SEAT_TO_OFFSET[seat.lower()]
    return (kyoku + seat_offset) % 4


def format_pon_call(
    called_t6: int, hand_t6s: list[int], caller: int, discarder: int
) -> tuple[str, int]:
    """Format a Tenhou/6 Pon string with 'p' positioned before the called tile."""
    rel = (discarder - caller) % 4
    h0, h1 = sorted(hand_t6s, key=t6_sort_key)
    if rel == 3:  # Kamicha (left) -> pos 0
        return f"p{called_t6:02d}{h0:02d}{h1:02d}", 0
    if rel == 2:  # Toimen (across) -> pos 1
        return f"{h0:02d}p{called_t6:02d}{h1:02d}", 1
    # Shimocha (right, rel == 1) -> pos 2
    return f"{h0:02d}{h1:02d}p{called_t6:02d}", 2


def format_daiminkan_call(
    called_t6: int, hand_t6s: list[int], caller: int, discarder: int
) -> str:
    """Format a Tenhou/6 Daiminkan string with 'm' positioned before the called tile."""
    rel = (discarder - caller) % 4
    h0, h1, h2 = sorted(hand_t6s, key=t6_sort_key)
    if rel == 3:  # Kamicha -> pos 0
        return f"m{called_t6:02d}{h0:02d}{h1:02d}{h2:02d}"
    if rel == 2:  # Toimen -> pos 1
        return f"{h0:02d}m{called_t6:02d}{h1:02d}{h2:02d}"
    # Shimocha -> pos 3
    return f"{h0:02d}{h1:02d}{h2:02d}m{called_t6:02d}"


def format_kakan_call(added_t6: int, pon_str: str, called_slot: int) -> str:
    """Upgrade an existing Tenhou/6 Pon string into a Kakan string with 'k' before added."""
    codes = [int(x) for x in re.findall(r"\d{2}", pon_str)]
    if called_slot == 0:
        return f"k{added_t6:02d}{codes[0]:02d}{codes[1]:02d}{codes[2]:02d}"
    if called_slot == 1:
        return f"{codes[0]:02d}k{added_t6:02d}{codes[1]:02d}{codes[2]:02d}"
    return f"{codes[0]:02d}{codes[1]:02d}k{added_t6:02d}{codes[2]:02d}"


def format_ankan_call(kan_t6s: list[int]) -> str:
    """Format a Tenhou/6 Ankan string ('t0t1t2at3')."""
    t0, t1, t2, t3 = sorted(kan_t6s, key=t6_sort_key)
    return f"{t0:02d}{t1:02d}{t2:02d}a{t3:02d}"


def format_score_string(score: dict[str, Any], is_tsumo: bool) -> str:
    """Build Tenhou's Japanese score summary string (e.g., '30符3飜3900点')."""
    fu = score["fu"]["total"]
    han = score["han"]
    level = score.get("score_level", "Normal")
    payment = score["payment"]
    total = payment["total"]

    if is_tsumo:
        if score.get("is_dealer"):
            amt_str = f"{payment['from_non_dealer']}点∀"
        else:
            amt_str = f"{payment['from_non_dealer']}-{payment['from_dealer']}点"
    else:
        amt_str = f"{total}点"

    if isinstance(level, dict):
        if "Yakuman" in level:
            mult = level["Yakuman"]
            prefix = "役満" if mult == 1 else f"{mult}倍役満"
            return f"{prefix}{amt_str}"
        level = next(iter(level.keys()), "Normal")

    level_names = {
        "Mangan": "満貫",
        "Haneman": "跳満",
        "Baiman": "倍満",
        "Sanbaiman": "三倍満",
        "Yakuman": "役満",
        "KazoeYakuman": "役満",
        "CountedYakuman": "役満",
    }
    if isinstance(level, str) and level in level_names:
        return f"{level_names[level]}{amt_str}"

    if score.get("is_counted_yakuman") or han >= 13:
        return f"役満{amt_str}"

    return f"{fu}符{han}飜{amt_str}"


def format_yaku_entry(yaku: str | dict[str, Any], is_open: bool) -> str | None:
    """Normalize a string or serde-tagged dict Yaku entry into Tenhou/6 format."""
    if isinstance(yaku, str):
        key = snake_to_pascal(yaku)
        if key in ("Dora", "AkaDora", "UraDora"):
            return None
        if key in YAKU_MAP:
            jp_name, closed_han, open_han = YAKU_MAP[key]
            han = open_han if is_open else closed_han
            return f"{jp_name}(役満)" if han == 0 else f"{jp_name}({han}飜)"
        return f"{key}(1飜)"

    if isinstance(yaku, dict) and yaku:
        raw_variant, payload = next(iter(yaku.items()))
        variant = snake_to_pascal(raw_variant)
        if variant in ("Dora", "AkaDora", "UraDora"):
            return None

        inner: Any = payload
        if isinstance(payload, dict):
            for key in ("Honor", "Wind", "Dragon", "wind", "dragon", "honor", "name"):
                if key in payload:
                    inner = payload[key]
                    break
            else:
                if len(payload) == 1:
                    inner = next(iter(payload.values()))

        inner_norm = snake_to_pascal(inner) if isinstance(inner, str) else inner

        if variant in (
            "Yakuhai",
            "SeatWind",
            "PrevalentWind",
            "RoundWind",
            "Dragon",
            "ValueHonor",
            "Jikaze",
            "Bakaze",
            "Sangenpai",
        ):
            if isinstance(inner_norm, str) and inner_norm in HONOR_JP:
                return f"役牌 {HONOR_JP[inner_norm]}(1飜)"

        if variant in ("DoubleWind", "Renpuuhai"):
            if isinstance(inner_norm, str) and inner_norm in HONOR_JP:
                return f"役牌 {HONOR_JP[inner_norm]}(2飜)"

        if variant in YAKU_MAP:
            jp_name, closed_han, open_han = YAKU_MAP[variant]
            han = open_han if is_open else closed_han
            return f"{jp_name}(役満)" if han == 0 else f"{jp_name}({han}飜)"

        return f"{variant}(1飜)"

    return f"{yaku}(1飜)"


def format_yaku_list(details: dict[str, Any]) -> list[str]:
    """Convert Agari yaku_list and dora counts to Tenhou/6 Japanese yaku entries."""
    is_open = details.get("is_open", False)
    result: list[str] = []
    for y in details.get("yaku_list", []):
        entry = format_yaku_entry(y, is_open)
        if entry is not None:
            result.append(entry)

    dora = details.get("dora_count", 0)
    aka = details.get("aka_dora_count", 0)
    ura = details.get("ura_dora_count", 0)
    if dora > 0:
        result.append(f"ドラ({dora}飜)")
    if aka > 0:
        result.append(f"赤ドラ({aka}飜)")
    if ura > 0:
        result.append(f"裏ドラ({ura}飜)")

    return result


def classify_exhaustive_draw(
    outcome: Any, tenpai_payments_t6: list[int], dealer_repeats: bool
) -> str:
    """Return Tenhou/6's exact exhaustive draw label: '流局', '全員不聴', or '全員聴牌'."""
    if any(x != 0 for x in tenpai_payments_t6):
        return "流局"

    if isinstance(outcome, dict):
        ryu = outcome.get("ryukyoku") or outcome.get("exhaustive_draw")
        if isinstance(ryu, dict):
            for key in ("tenpai_players", "tenpai", "tenpai_seats"):
                val = ryu.get(key)
                if isinstance(val, list):
                    count = (
                        sum(1 for x in val if x)
                        if all(isinstance(x, bool) for x in val)
                        else len(val)
                    )
                    if count == 4:
                        return "全員聴牌"
                    if count == 0:
                        return "全員不聴"
            for key in ("tenpai_count", "num_tenpai"):
                val = ryu.get(key)
                if isinstance(val, int):
                    if val == 4:
                        return "全員聴牌"
                    if val == 0:
                        return "全員不聴"

    return "全員聴牌" if dealer_repeats else "全員不聴"


def build_round_result(
    round_data: dict[str, Any],
    kyoku: int,
    dealer_offset: int,
    starting_pts_t6: list[int],
) -> list[Any]:
    """Construct the 17th element (round outcome) of a tenhou.net/6 round entry."""
    res_block = round_data["result"]
    outcome = res_block["result"]

    pre_pts_t6 = rotate_list(res_block["pre_points"], dealer_offset)
    deltas_agari_t6 = rotate_list(res_block["point_deltas"], dealer_offset)
    end_pts_t6 = [pre_pts_t6[i] + deltas_agari_t6[i] for i in range(4)]
    total_deltas = [end_pts_t6[i] - starting_pts_t6[i] for i in range(4)]

    if isinstance(outcome, dict) and ("ron" in outcome or "multi_ron" in outcome):
        ron_val = outcome.get("ron", outcome.get("multi_ron"))
        rons = ron_val if isinstance(ron_val, list) else [ron_val]
        entries: list[Any] = ["和了"]

        if len(rons) == 1:
            ron = rons[0]
            winner = seat_to_tenhou_idx(ron["winner"], kyoku)
            loser = seat_to_tenhou_idx(ron["loser"], kyoku)
            details = ron["details"]
            pao_seat = details.get("pao_liable")
            pao = seat_to_tenhou_idx(pao_seat, kyoku) if pao_seat else winner
            score_str = format_score_string(details["score"], is_tsumo=False)
            yaku_entries = format_yaku_list(details)
            entries.extend([total_deltas, [winner, loser, pao, score_str, *yaku_entries]])
            return entries

        riichi_bets = [pre_pts_t6[i] - starting_pts_t6[i] for i in range(4)]
        remaining_riichi_pot = -sum(riichi_bets) + round_data.get("riichi_sticks", 0) * 1000
        remaining_honba_bonus = round_data.get("honba", 0) * 300
        claimed_riichi = [False] * 4

        for idx, ron in enumerate(rons):
            winner = seat_to_tenhou_idx(ron["winner"], kyoku)
            loser = seat_to_tenhou_idx(ron["loser"], kyoku)
            details = ron["details"]
            pay = details["score"]["payment"]["total"]
            sub_deltas = [0, 0, 0, 0]
            sub_deltas[winner] += pay
            sub_deltas[loser] -= pay
            if idx == 0:
                sub_deltas[winner] += remaining_riichi_pot + remaining_honba_bonus
                sub_deltas[loser] -= remaining_honba_bonus
            for p in range(4):
                if not claimed_riichi[p] and riichi_bets[p] != 0:
                    sub_deltas[p] += riichi_bets[p]
                    claimed_riichi[p] = True

            pao_seat = details.get("pao_liable")
            pao = seat_to_tenhou_idx(pao_seat, kyoku) if pao_seat else winner
            score_str = format_score_string(details["score"], is_tsumo=False)
            yaku_entries = format_yaku_list(details)
            entries.extend([sub_deltas, [winner, loser, pao, score_str, *yaku_entries]])
        return entries

    if isinstance(outcome, dict) and "tsumo" in outcome:
        tsumo = outcome["tsumo"]
        winner = seat_to_tenhou_idx(tsumo["winner"], kyoku)
        details = tsumo["details"]
        pao_seat = details.get("pao_liable")
        pao = seat_to_tenhou_idx(pao_seat, kyoku) if pao_seat else winner
        score_str = format_score_string(details["score"], is_tsumo=True)
        yaku_entries = format_yaku_list(details)
        return ["和了", total_deltas, [winner, winner, pao, score_str, *yaku_entries]]

    abortive_labels = {
        "four_winds": "四風連打",
        "suufon_renda": "四風連打",
        "nine_terminals": "九種九牌",
        "kyuushu_kyuuhai": "九種九牌",
        "four_riichi": "四家立直",
        "suucha_riichi": "四家立直",
        "four_kans": "四開槓",
        "suukaikan": "四開槓",
        "triple_ron": "三家和了",
        "sanchahou": "三家和了",
        "nagashi_mangan": "流し満貫",
    }
    if isinstance(outcome, str) and outcome.lower() in abortive_labels:
        return [abortive_labels[outcome.lower()], total_deltas]
    if isinstance(outcome, dict):
        for key, label in abortive_labels.items():
            if key in outcome:
                return [label, total_deltas]

    label = classify_exhaustive_draw(
        outcome, deltas_agari_t6, bool(res_block.get("dealer_repeats", False))
    )
    return [label, total_deltas]


def _resolve_self_kan_t34(
    action: Any, hand: list[int], open_pons: dict[int, tuple[str, int]], id_to_t6: dict[int, int]
) -> int | None:
    """Determine the 0..33 tile type for an Ankan or Kakan action."""
    if isinstance(action, dict):
        for key in ("ankan", "kakan", "kan"):
            val = action.get(key)
            if isinstance(val, int):
                return val // 4
            if isinstance(val, list) and val:
                first = val[0]
                return first // 4 if isinstance(first, int) else first["id"] // 4
            if isinstance(val, dict):
                if "id" in val:
                    return val["id"] // 4
                if "tile_id" in val:
                    return val["tile_id"] // 4
                if "Honor" in val or "Suited" in val or "tile" in val:
                    target_t6 = tile_obj_to_t6(val)
                    return next(
                        (tid // 4 for tid in hand if id_to_t6[tid] == target_t6),
                        None,
                    )

    for tid in hand:
        t34 = tid // 4
        if sum(1 for x in hand if x // 4 == t34) == 4 or t34 in open_pons:
            return t34
    return None


def convert_round(
    round_data: dict[str, Any], dealer_offset: int, aka_count: int
) -> list[Any]:
    """Convert a single Agari round object into a 17-element tenhou.net/6 round list."""
    kyoku = get_kyoku(round_data)
    honba = round_data["honba"]
    riichi_sticks = round_data["riichi_sticks"]

    id_to_t6 = build_id_map(round_data, aka_count)
    starting_pts = rotate_list(round_data["starting_points"], dealer_offset)
    starting_hands_raw = rotate_list(round_data["starting_hands"], dealer_offset)

    hands: list[list[int]] = [[t["id"] for t in h] for h in starting_hands_raw]
    haipai: list[list[int]] = [
        sorted((id_to_t6[tid] for tid in h), key=t6_sort_key) for h in hands
    ]
    draws: list[list[int | str]] = [[] for _ in range(4)]
    discards: list[list[int | str]] = [[] for _ in range(4)]
    open_pons: list[dict[int, tuple[str, int]]] = [{} for _ in range(4)]

    wall_ids = [t["id"] for t in round_data.get("wall_tiles", [])]
    kan_draw_ids = [t["id"] for t in round_data.get("dead_wall_kan_draws", [])]
    wall_idx = 0
    kan_idx = 0
    num_kans = 0

    needs_draw = True
    pending_kan_draw_for: int | None = None
    last_drawn_id: int | None = None
    last_discard_id: int | None = None
    last_discarder: int | None = None

    def flush_pending_kan_draw() -> None:
        nonlocal kan_idx, pending_kan_draw_for, last_drawn_id, needs_draw
        if pending_kan_draw_for is not None:
            rep_id = kan_draw_ids[kan_idx]
            kan_idx += 1
            hands[pending_kan_draw_for].append(rep_id)
            draws[pending_kan_draw_for].append(id_to_t6[rep_id])
            last_drawn_id = rep_id
            needs_draw = False
            pending_kan_draw_for = None

    draw_before_terminal = {"tsumo", "kyuushu_kyuuhai", "nine_terminals"}
    terminal_actions = {
        "ron",
        "tsumo",
        "ryukyoku",
        "exhaustive_draw",
        "abortive_draw",
        "kyuushu_kyuuhai",
        "nine_terminals",
        "draw",
    }

    for step in round_data.get("actions", []):
        action = step.get("action")
        if isinstance(action, str) and action.lower() in terminal_actions:
            if action.lower() in draw_before_terminal and step.get("seat"):
                flush_pending_kan_draw()
                actor = seat_to_tenhou_idx(step["seat"], kyoku)
                if needs_draw and wall_idx < len(wall_ids):
                    drawn_id = wall_ids[wall_idx]
                    wall_idx += 1
                    hands[actor].append(drawn_id)
                    draws[actor].append(id_to_t6[drawn_id])
            break

        if isinstance(action, dict) and any(k.lower() in terminal_actions for k in action):
            break

        seat = step.get("seat")
        if not seat:
            continue
        actor = seat_to_tenhou_idx(seat, kyoku)

        flush_pending_kan_draw()

        if action == "pon":
            assert last_discard_id is not None and last_discarder is not None
            target_t34 = last_discard_id // 4
            matching = [tid for tid in hands[actor] if tid // 4 == target_t34][:2]
            for tid in matching:
                hands[actor].remove(tid)
            pon_str, slot = format_pon_call(
                id_to_t6[last_discard_id],
                [id_to_t6[tid] for tid in matching],
                actor,
                last_discarder,
            )
            draws[actor].append(pon_str)
            open_pons[actor][target_t34] = (pon_str, slot)
            needs_draw = False
            last_drawn_id = None
            continue

        if isinstance(action, dict) and "chi" in action:
            assert last_discard_id is not None
            used_ids = [t["id"] for t in action["chi"]["hand_tiles"]]
            for tid in used_ids:
                hands[actor].remove(tid)
            hand_t6s = sorted((id_to_t6[tid] for tid in used_ids), key=t6_sort_key)
            called_t6 = id_to_t6[last_discard_id]
            chi_str = f"c{called_t6:02d}{hand_t6s[0]:02d}{hand_t6s[1]:02d}"
            draws[actor].append(chi_str)
            needs_draw = False
            last_drawn_id = None
            continue

        if isinstance(action, dict) and ("discard" in action or "riichi" in action):
            is_riichi = "riichi" in action
            tile_id = action["riichi"] if is_riichi else action["discard"]

            if needs_draw:
                drawn_id = wall_ids[wall_idx]
                wall_idx += 1
                hands[actor].append(drawn_id)
                draws[actor].append(id_to_t6[drawn_id])
                last_drawn_id = drawn_id

            is_tsumogiri = tile_id == last_drawn_id
            disc_val = 60 if is_tsumogiri else id_to_t6[tile_id]
            disc_entry: int | str = f"r{disc_val}" if is_riichi else disc_val
            discards[actor].append(disc_entry)

            hands[actor].remove(tile_id)
            last_discard_id = tile_id
            last_discarder = actor
            needs_draw = True
            last_drawn_id = None
            continue

        # Kan handling (daiminkan, ankan, kakan)
        if action == "kan" or (
            isinstance(action