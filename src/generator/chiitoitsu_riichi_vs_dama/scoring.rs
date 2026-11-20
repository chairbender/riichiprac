use agari::context::{GameContext, WinType};
use agari::hand::{HandStructure, decompose_hand};
use agari::parse::to_counts;
use agari::scoring::{ScoreLevel, calculate_score};
use agari::tile::Tile;
use agari::yaku::{Yaku, detect_yaku_with_context};

use crate::generator::support::analysis::wind_to_honor;
use crate::state::Wind;

/// Scores a completed chiitoitsu hand without Riichi.
pub(crate) fn score_level(
    winning_tiles: &[Tile],
    wait_tile: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicators: &[Tile],
    aka_count: u8,
) -> Option<ScoreLevel> {
    let counts = to_counts(winning_tiles);
    let chiitoitsu = decompose_hand(&counts)
        .into_iter()
        .find(|structure| matches!(structure, HandStructure::Chiitoitsu { .. }))?;

    let context = GameContext::new(
        WinType::Ron,
        wind_to_honor(round_wind),
        wind_to_honor(seat_wind),
    )
    .with_winning_tile(wait_tile)
    .with_dora(dora_indicators.to_vec())
    .with_aka(aka_count);

    let yaku = detect_yaku_with_context(&chiitoitsu, &counts, &context);
    if !yaku.yaku_list.contains(&Yaku::Chiitoitsu) {
        return None;
    }

    Some(calculate_score(&chiitoitsu, &yaku, &context).score_level)
}

/// Scores a completed chiitoitsu hand without Riichi and reports whether it
/// stays below Mangan.
pub(crate) fn scores_below_mangan(
    winning_tiles: &[Tile],
    wait_tile: Tile,
    round_wind: Wind,
    seat_wind: Wind,
    dora_indicator: Tile,
    aka_count: u8,
) -> bool {
    score_level(
        winning_tiles,
        wait_tile,
        round_wind,
        seat_wind,
        &[dora_indicator],
        aka_count,
    ) == Some(ScoreLevel::Normal)
}

/// True when the complete chiitoitsu hand is a one-suit shape: honitsu (one
/// suit plus honours) or chinitsu (one suit only).
///
/// Riichi Book 1, ch. 7.2 (ch7:359): "the only two cases where you should go
/// dama are (a) when you are a non-dealer and you are waiting for 4,5,6, and
/// (b) you have honitsu or chinitsu chiitoitsu." The all-honours hand is the
/// book's footnote exception — "I would riichi" — so it is **not** flush here.
pub(crate) fn is_flush(winning_tiles: &[Tile]) -> bool {
    let mut suits = winning_tiles.iter().filter_map(Tile::suit);
    let Some(first) = suits.next() else {
        // No suited tile at all: the all-honours hand, which the book declares.
        return false;
    };
    suits.all(|suit| suit == first)
}
