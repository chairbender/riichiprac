#!/usr/bin/env python3
"""Convert Agari Riichi Mahjong replay JSON logs to tenhou.net/6 JSON format."""

from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
from pathlib import Path
from typing import Any

SEAT_TO_OFFSET = {"east": 0, "south": 1, "west": 2, "north": 3}

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


def t6_sort_key(code: int) -> tuple[int, int]:
    """Sort Tenhou/6 tile codes in standard display order (1m..0m..9m, p, s, z)."""
    if code == 51:
        return (1, 5)
    if code == 52:
        return (2, 5)
    if code == 53:
        return (3, 5)
    return (code // 10, code % 10)


def rotate_list(items: list[Any], offset: int) -> list[Any]:
    """Rotate a 4-element list so Agari index `offset` becomes Tenhou index 0."""
    n = len(items)
    offset %= n
    return [items[(offset + i) % n] for i in range(n)]


def seat_to_tenhou_idx(seat: str, round_number: int) -> int:
    """Map Agari seat wind in `round_number` to Tenhou player index (0..3)."""
    seat_offset = SEAT_TO_OFFSET[seat.lower()]
    return (round_number + seat_offset) % 4


def format_pon_call(called_t6: int, hand_t6s: list[int], caller: int, discarder: int) -> str:
    """Format a Tenhou/6 Pon string ('p...') with the called tile positioned by seat."""
    rel = (discarder - caller) % 4
    h0, h1 = sorted(hand_t6s, key=t6_sort_key)
    if rel == 3:  # Kamicha (left)
        tiles = [called_t6, h0, h1]
    elif rel == 2:  # Toimen (across)
        tiles = [h0, called_t6, h1]
    else:  # Shimocha (right, rel == 1)
        tiles = [h0, h1, called_t6]
    return "p" + "".join(f"{t:02d}" for t in tiles)


def format_daiminkan_call(
    called_t6: int, hand_t6s: list[int], caller: int, discarder: int
) -> str:
    """Format a Tenhou/6 Daiminkan string ('m...')."""
    rel = (discarder - caller) % 4
    h0, h1, h2 = sorted(hand_t6s, key=t6_sort_key)
    if rel == 3:
        tiles = [called_t6, h0, h1, h2]
    elif rel == 2:
        tiles = [h0, called_t6, h1, h2]
    else:
        tiles = [h0, h1, h2, called_t6]
    return "m" + "".join(f"{t:02d}" for t in tiles)


def format_kakan_call(added_t6: int, pon_str: str) -> str:
    """Upgrade an existing Tenhou/6 Pon string ('p...') into a Kakan string ('k...')."""
    t0, t1, t2 = int(pon_str[1:3]), int(pon_str[3:5]), int(pon_str[5:7])
    if t0 in (51, 52, 53) and t1 not in (51, 52, 53):
        tiles = [added_t6, t0, t1, t2]
    elif t2 in (51, 52, 53) and t1 not in (51, 52, 53):
        tiles = [t0, t1, added_t6, t2]
    else:
        tiles = [t0, added_t6, t1, t2]
    return "k" + "".join(f"{t:02d}" for t in tiles)


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
    }
    if isinstance(level, str) and level in level_names:
        return f"{level_names[level]}{amt_str}"

    return f"{fu}符{han}飜{amt_str}"


def format_yaku_entry(yaku: str | dict[str, Any], is_open: bool) -> str:
    """Normalize a string or serde-tagged dict Yaku entry into Tenhou/6 format."""
    if isinstance(yaku, str):
        if yaku in YAKU_MAP:
            jp_name, closed_han, open_han = YAKU_MAP[yaku]
            han = open_han if is_open else closed_han
            return f"{jp_name}(役満)" if han == 0 else f"{jp_name}({han}飜)"
        return f"{yaku}(1飜)"

    if isinstance(yaku, dict) and yaku:
        variant, payload = next(iter(yaku.items()))
        inner: Any = payload
        if isinstance(payload, dict):
            for key in ("Honor", "Wind", "Dragon", "name"):
                if key in payload:
                    inner = payload[key]
                    break
            else:
                if len(payload) == 1:
                    inner = next(iter(payload.values()))

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
            if isinstance(inner, str) and inner in HONOR_JP:
                return f"役牌 {HONOR_JP[inner]}(1飜)"

        if variant in ("DoubleWind", "Renpuuhai"):
            if isinstance(inner, str) and inner in HONOR_JP:
                return f"役牌 {HONOR_JP[inner]}(2飜)"

        if variant in ("Dora", "AkaDora", "UraDora") and isinstance(inner, int):
            jp = {"Dora": "ドラ", "AkaDora": "赤ドラ", "UraDora": "裏ドラ"}[variant]
            return f"{jp}({inner}飜)"

        if variant in YAKU_MAP:
            jp_name, closed_han, open_han = YAKU_MAP[variant]
            han = open_han if is_open else closed_han
            return f"{jp_name}(役満)" if han == 0 else f"{jp_name}({han}飜)"

        return f"{variant}(1飜)"

    return f"{yaku}(1飜)"


def format_yaku_list(details: dict[str, Any]) -> list[str]:
    """Convert Agari yaku_list and dora counts to Tenhou/6 Japanese yaku entries."""
    is_open = details.get("is_open", False)
    result = [format_yaku_entry(y, is_open) for y in details.get("yaku_list", [])]

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


def build_round_result(
    round_data: dict[str, Any],
    round_number: int,
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

    if isinstance(outcome, dict) and "ron" in outcome:
        ron_val = outcome["ron"]
        rons = ron_val if isinstance(ron_val, list) else [ron_val]
        entries: list[Any] = ["和了"]
        for ron in rons:
            winner = seat_to_tenhou_idx(ron["winner"], round_number)
            loser = seat_to_tenhou_idx(ron["loser"], round_number)
            details = ron["details"]
            pao_seat = details.get("pao_liable")
            pao = seat_to_tenhou_idx(pao_seat, round_number) if pao_seat else winner
            score_str = format_score_string(details["score"], is_tsumo=False)
            yaku_entries = format_yaku_list(details)
            entries.extend([total_deltas, [winner, loser, pao, score_str, *yaku_entries]])
        return entries

    if isinstance(outcome, dict) and "tsumo" in outcome:
        tsumo = outcome["tsumo"]
        winner = seat_to_tenhou_idx(tsumo["winner"], round_number)
        details = tsumo["details"]
        pao_seat = details.get("pao_liable")
        pao = seat_to_tenhou_idx(pao_seat, round_number) if pao_seat else winner
        score_str = format_score_string(details["score"], is_tsumo=True)
        yaku_entries = format_yaku_list(details)
        return ["和了", total_deltas, [winner, winner, pao, score_str, *yaku_entries]]

    if isinstance(outcome, dict) and "multi_ron" in outcome:
        entries = ["和了"]
        for ron in outcome["multi_ron"]:
            winner = seat_to_tenhou_idx(ron["winner"], round_number)
            loser = seat_to_tenhou_idx(ron["loser"], round_number)
            details = ron["details"]
            pao_seat = details.get("pao_liable")
            pao = seat_to_tenhou_idx(pao_seat, round_number) if pao_seat else winner
            score_str = format_score_string(details["score"], is_tsumo=False)
            yaku_entries = format_yaku_list(details)
            entries.extend([total_deltas, [winner, loser, pao, score_str, *yaku_entries]])
        return entries

    draw_labels = {
        "four_winds": "四風連打",
        "nine_terminals": "九種九牌",
        "four_riichi": "四家立直",
        "four_kans": "四開槓",
        "triple_ron": "三家和了",
        "nagashi_mangan": "流し満貫",
    }
    if isinstance(outcome, str) and outcome in draw_labels:
        return [draw_labels[outcome], total_deltas]
    if isinstance(outcome, dict):
        for key, label in draw_labels.items():
            if key in outcome:
                return [label, total_deltas]

    return ["流局", total_deltas]


def convert_round(
    round_data: dict[str, Any], dealer_offset: int, aka_count: int
) -> list[Any]:
    """Convert a single Agari round object into a 17-element tenhou.net/6 round list."""
    round_number = round_data["round_number"]
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
    open_pons: list[dict[int, str]] = [{} for _ in range(4)]

    wall_ids = [t["id"] for t in round_data.get("wall_tiles", [])]
    kan_draw_ids = [t["id"] for t in round_data.get("dead_wall_kan_draws", [])]
    wall_idx = 0
    kan_idx = 0
    num_kans = 0

    needs_draw = True
    last_drawn_id: int | None = None
    last_discard_id: int | None = None
    last_discarder: int | None = None

    for step in round_data.get("actions", []):
        actor = seat_to_tenhou_idx(step["seat"], round_number)
        action = step["action"]

        if action == "ron":
            break

        if action == "tsumo":
            if needs_draw and wall_idx < len(wall_ids):
                drawn_id = wall_ids[wall_idx]
                wall_idx += 1
                hands[actor].append(drawn_id)
                draws[actor].append(id_to_t6[drawn_id])
            break

        if action == "pon":
            assert last_discard_id is not None and last_discarder is not None
            target_t34 = last_discard_id // 4
            matching = [tid for tid in hands[actor] if tid // 4 == target_t34][:2]
            for tid in matching:
                hands[actor].remove(tid)
            pon_str = format_pon_call(
                id_to_t6[last_discard_id],
                [id_to_t6[tid] for tid in matching],
                actor,
                last_discarder,
            )
            draws[actor].append(pon_str)
            open_pons[actor][target_t34] = pon_str
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
            isinstance(action, dict)
            and any(k in action for k in ("kan", "ankan", "kakan", "daiminkan"))
        ):
            if not needs_draw:
                assert last_discard_id is not None and last_discarder is not None
                target_t34 = last_discard_id // 4
                matching = [tid for tid in hands[actor] if tid // 4 == target_t34][:3]
                for tid in matching:
                    hands[actor].remove(tid)
                kan_str = format_daiminkan_call(
                    id_to_t6[last_discard_id],
                    [id_to_t6[tid] for tid in matching],
                    actor,
                    last_discarder,
                )
                draws[actor].append(kan_str)
            else:
                drawn_id = wall_ids[wall_idx]
                wall_idx += 1
                hands[actor].append(drawn_id)
                draws[actor].append(id_to_t6[drawn_id])

                target_t34 = None
                if isinstance(action, dict):
                    for key in ("ankan", "kakan", "kan"):
                        val = action.get(key)
                        if isinstance(val, int):
                            target_t34 = val // 4
                        elif isinstance(val, dict):
                            if "id" in val:
                                target_t34 = val["id"] // 4
                            elif "tile_id" in val:
                                target_t34 = val["tile_id"] // 4
                            elif "Honor" in val or "Suited" in val or "tile" in val:
                                target_t6 = tile_obj_to_t6(val)
                                target_t34 = next(
                                    (tid // 4 for tid in hands[actor] if id_to_t6[tid] == target_t6),
                                    None,
                                )

                if target_t34 is None:
                    for tid in hands[actor]:
                        if sum(1 for x in hands[actor] if x // 4 == tid // 4) == 4:
                            target_t34 = tid // 4
                            break
                        if (tid // 4) in open_pons[actor]:
                            target_t34 = tid // 4
                            break

                assert target_t34 is not None
                if target_t34 in open_pons[actor]:
                    added_id = next(tid for tid in hands[actor] if tid // 4 == target_t34)
                    hands[actor].remove(added_id)
                    kakan_str = format_kakan_call(
                        id_to_t6[added_id], open_pons[actor].pop(target_t34)
                    )
                    discards[actor].append(kakan_str)
                else:
                    kan_ids = [tid for tid in hands[actor] if tid // 4 == target_t34][:4]
                    for tid in kan_ids:
                        hands[actor].remove(tid)
                    t6s = sorted((id_to_t6[tid] for tid in kan_ids), key=t6_sort_key)
                    discards[actor].append("a" + "".join(f"{t:02d}" for t in t6s))

            num_kans += 1
            rep_id = kan_draw_ids[kan_idx]
            kan_idx += 1
            hands[actor].append(rep_id)
            draws[actor].append(id_to_t6[rep_id])
            last_drawn_id = rep_id
            needs_draw = False

    all_dora = [tile_obj_to_t6(d) for d in round_data.get("dora_indicators", [])]
    revealed_dora = all_dora[: 1 + num_kans]

    outcome = round_data["result"]["result"]
    has_ura = False
    if isinstance(outcome, dict):
        for key in ("ron", "tsumo", "multi_ron"):
            if key not in outcome:
                continue
            items = outcome[key] if isinstance(outcome[key], list) else [outcome[key]]
            if any(item["details"].get("ura_dora_indicators") for item in items):
                has_ura = True

    all_ura = [tile_obj_to_t6(u) for u in round_data.get("dead_wall_ura", [])]
    revealed_ura = all_ura[: 1 + num_kans] if has_ura else []

    result_entry = build_round_result(
        round_data, round_number, dealer_offset, starting_pts
    )

    return [
        [round_number, honba, riichi_sticks],
        starting_pts,
        revealed_dora,
        revealed_ura,
        haipai[0],
        draws[0],
        discards[0],
        haipai[1],
        draws[1],
        discards[1],
        haipai[2],
        draws[2],
        discards[2],
        haipai[3],
        draws[3],
        discards[3],
        result_entry,
    ]


def convert_agari_to_tenhou6(agari_data: dict[str, Any]) -> dict[str, Any]:
    """Convert an entire Agari match replay dictionary into tenhou.net/6 JSON format."""
    config = agari_data.get("match_config", {})
    dealer_offset = agari_data.get("dealer_offset", 0)
    aka_count = config.get("aka_dora_count", 3)
    match_type = config.get("match_type", "Hanchan")

    names_t6 = rotate_list(agari_data["player_names"], dealer_offset)
    rounds = agari_data.get("rounds", [])
    tenhou_logs = [convert_round(r, dealer_offset, aka_count) for r in rounds]

    if rounds:
        last_res = rounds[-1]["result"]
        pre_t6 = rotate_list(last_res["pre_points"], dealer_offset)
        delta_t6 = rotate_list(last_res["point_deltas"], dealer_offset)
        raw_end = [pre_t6[i] + delta_t6[i] for i in range(4)]
    else:
        raw_end = [25000, 25000, 25000, 25000]

    final_scores_raw = agari_data.get("final_scores")
    if final_scores_raw and len(final_scores_raw) == 4:
        final_t6 = rotate_list(final_scores_raw, dealer_offset)
        return_target = sum(final_t6) // 4
        uma_deltas = [round((final_t6[i] - return_target) / 1000.0, 1) for i in range(4)]
    else:
        uma_deltas = [round((raw_end[i] - 25000) / 1000.0, 1) for i in range(4)]

    sc: list[int | float] = []
    for i in range(4):
        sc.extend([raw_end[i], uma_deltas[i]])

    is_hanchan = match_type.lower() == "hanchan"
    rule_disp = ("般南" if is_hanchan else "般東") + "喰" + ("赤" if aka_count > 0 else "")

    return {
        "ver": 2.3,
        "ref": "",
        "log": tenhou_logs,
        "ratingc": "PF4",
        "rule": {
            "disp": rule_disp,
            "aka": 1 if aka_count > 0 else 0,
            "aka51": 1 if aka_count >= 1 else 0,
            "aka52": 1 if aka_count >= 2 else 0,
            "aka53": 1 if aka_count >= 3 else 0,
        },
        "lobby": 0,
        "dan": ["新人", "新人", "新人", "新人"],
        "rate": [1500, 1500, 1500, 1500],
        "sx": ["M", "M", "M", "M"],
        "name": names_t6,
        "sc": sc,
        "title": ["Agari Replay", agari_data.get("timestamp", "")],
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert Agari Riichi replay JSON to tenhou.net/6 JSON format."
    )
    parser.add_argument("input", type=Path, help="Path to Agari replay JSON file")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="Output tenhou.net/6 JSON path (default: <input>_tenhou6.json)",
    )
    parser.add_argument(
        "--compact",
        action="store_true",
        help="Write minified JSON without indentation",
    )
    parser.add_argument(
        "--url",
        action="store_true",
        help="Print a direct https://tenhou.net/6/#json=... viewer URL to stdout",
    )
    args = parser.parse_args()

    with args.input.open("r", encoding="utf-8") as f:
        agari_data = json.load(f)

    tenhou_data = convert_agari_to_tenhou6(agari_data)
    out_path = args.output or args.input.with_name(f"{args.input.stem}_tenhou6.json")

    indent = None if args.compact else 2
    separators = (",", ":") if args.compact else (", ", ": ")

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(tenhou_data, f, ensure_ascii=False, indent=indent, separators=separators)

    print(f"Converted log saved to: {out_path}", file=sys.stderr)

    if args.url:
        compact_json = json.dumps(tenhou_data, ensure_ascii=False, separators=(",", ":"))
        print(f"https://tenhou.net/6/#json={urllib.parse.quote(compact_json)}")


if __name__ == "__main__":
    main()