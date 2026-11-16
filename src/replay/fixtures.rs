//! Test-only fixture writer.
//!
//! The writer emits canonical mjai JSONL from [`EventKind`] values, gzips the
//! text and builds a few complete, structurally legal games:
//!
//! - [`all_events_game`] is the hand-scripted one-kyoku game committed as
//!   `testdata/replays/one_kyoku_hora.jsonl`. It reaches every supported event
//!   kind except `ryukyoku`: chi, pon, daiminkan, ankan, kakan, three kan dora,
//!   a riichi declaration/acceptance and a ron with ura markers.
//! - [`exhaustive_game`] plays a shuffled 70-draw kyoku with tsumogiri discards
//!   and ends in an exhaustive draw; committed as
//!   `testdata/replays/one_kyoku_ryukyoku.jsonl` for its first seed.
//! - [`two_kyoku_game`] chains two draws through the score/round ledger.
//! - [`synthetic_games`] produces `n` one-kyoku games with random chi/pon calls,
//!   used by the "100 synthetic games parse" acceptance test.
//!
//! Nothing here ships: the module is `#[cfg(test)]`.

use std::io::Write;

use flate2::Compression;
use flate2::write::GzEncoder;

use super::mjai::EventKind;
use super::tile::Tile;

/// Serialise events as mjai JSONL (one object per line, trailing newline).
pub(crate) fn to_jsonl(events: &[EventKind]) -> String {
    let mut out = String::new();
    for event in events {
        out.push_str(&serde_json::to_string(event).expect("fixture event must serialise"));
        out.push('\n');
    }
    out
}

/// Gzip a fixture the same way the corpus writer does.
pub(crate) fn gzip(text: &str) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(text.as_bytes())
        .expect("in-memory gzip writer must accept bytes");
    encoder.finish().expect("in-memory gzip writer must finish")
}

fn t(code: &str) -> Tile {
    Tile::parse(code).unwrap_or_else(|err| panic!("fixture tile `{code}`: {err}"))
}

fn tiles<const N: usize>(codes: &[&str]) -> [Tile; N] {
    let parsed: Vec<Tile> = codes.iter().map(|code| t(code)).collect();
    parsed
        .try_into()
        .unwrap_or_else(|_| panic!("expected {N} fixture tiles, got {}", codes.len()))
}

fn hand(codes: &[&str]) -> [Tile; 13] {
    tiles::<13>(codes)
}

pub(crate) fn start_game() -> EventKind {
    EventKind::StartGame {
        names: vec![
            "s0".to_string(),
            "s1".to_string(),
            "s2".to_string(),
            "s3".to_string(),
        ],
        seed: Some([7, 11]),
    }
}

#[allow(clippy::too_many_arguments)]
fn start_kyoku(
    bakaze: &str,
    dora: &str,
    kyoku: u8,
    honba: u8,
    kyotaku: u8,
    oya: u8,
    scores: [i32; 4],
    tehais: [[Tile; 13]; 4],
) -> EventKind {
    EventKind::StartKyoku {
        bakaze: t(bakaze),
        dora_marker: t(dora),
        kyoku,
        honba,
        kyotaku,
        oya,
        scores,
        tehais,
    }
}

fn tsumo(actor: u8, pai: &str) -> EventKind {
    EventKind::Tsumo { actor, pai: t(pai) }
}

fn dahai(actor: u8, pai: &str, tsumogiri: bool) -> EventKind {
    EventKind::Dahai {
        actor,
        pai: t(pai),
        tsumogiri,
    }
}

fn all_events_hands() -> [[Tile; 13]; 4] {
    [
        hand(&[
            "1m", "2m", "3m", "4m", "5mr", "6m", "7p", "8p", "9p", "1s", "1s", "5s", "5s",
        ]),
        hand(&[
            "7m", "8m", "2p", "2p", "3p", "3p", "1p", "6s", "7s", "9s", "N", "N", "C",
        ]),
        hand(&[
            "E", "E", "6p", "7p", "8p", "1m", "1m", "9s", "9s", "3s", "4s", "5s", "6s",
        ]),
        hand(&[
            "4p", "4p", "4p", "8s", "8s", "8s", "8s", "2m", "2m", "6m", "7m", "9m", "E",
        ]),
    ]
}

/// The hand-scripted one-kyoku game with every supported event except a draw.
///
/// The trace was selected so that each hand-size invariant holds and the
/// three kans consume the only extra dora slots:
///
/// - seat 3's ankan of 8s, then a rinshan draw and a discard of E;
/// - seat 2 pons that E, later draws the fourth E and kakans;
/// - seat 3 daiminkans the 4p seat 2 discards;
/// - seat 0 riichis on a 4m discard and rons seat 3's 1s.
pub(crate) fn all_events_game() -> Vec<EventKind> {
    vec![
        start_game(),
        start_kyoku("E", "P", 1, 0, 0, 0, [25_000; 4], all_events_hands()),
        tsumo(0, "9m"),
        dahai(0, "9m", true),
        EventKind::Chi {
            actor: 1,
            target: 0,
            pai: t("9m"),
            consumed: tiles::<2>(&["7m", "8m"]),
        },
        dahai(1, "C", false),
        tsumo(2, "3m"),
        dahai(2, "3m", true),
        tsumo(3, "5s"),
        EventKind::Ankan {
            actor: 3,
            consumed: tiles::<4>(&["8s", "8s", "8s", "8s"]),
        },
        EventKind::Dora {
            dora_marker: t("F"),
        },
        tsumo(3, "2p"),
        dahai(3, "E", false),
        EventKind::Pon {
            actor: 2,
            target: 3,
            pai: t("E"),
            consumed: tiles::<2>(&["E", "E"]),
        },
        dahai(2, "3s", false),
        // The pon moved the draw to seat 3, so the turn order is now 3, 0, 1,
        // 2 until the next call.
        tsumo(3, "7p"),
        dahai(3, "7p", true),
        tsumo(0, "7s"),
        dahai(0, "7s", true),
        tsumo(1, "4s"),
        dahai(1, "4s", true),
        tsumo(2, "4p"),
        dahai(2, "4p", true),
        EventKind::Daiminkan {
            actor: 3,
            target: 2,
            pai: t("4p"),
            consumed: tiles::<3>(&["4p", "4p", "4p"]),
        },
        tsumo(3, "6s"),
        EventKind::Dora {
            dora_marker: t("C"),
        },
        dahai(3, "6s", true),
        tsumo(0, "3m"),
        dahai(0, "3m", true),
        tsumo(1, "5p"),
        dahai(1, "5p", true),
        tsumo(2, "E"),
        EventKind::Kakan {
            actor: 2,
            pai: t("E"),
            consumed: tiles::<3>(&["E", "E", "E"]),
        },
        EventKind::Dora {
            dora_marker: t("W"),
        },
        tsumo(2, "3p"),
        dahai(2, "3p", true),
        tsumo(3, "2s"),
        dahai(3, "2s", true),
        tsumo(0, "9s"),
        dahai(0, "9s", true),
        tsumo(1, "6p"),
        dahai(1, "6p", true),
        tsumo(2, "8m"),
        dahai(2, "8m", true),
        tsumo(3, "9m"),
        dahai(3, "9m", true),
        tsumo(0, "4m"),
        EventKind::Reach { actor: 0 },
        dahai(0, "4m", true),
        EventKind::ReachAccepted { actor: 0 },
        tsumo(1, "2s"),
        dahai(1, "2s", true),
        tsumo(2, "9p"),
        dahai(2, "9p", true),
        tsumo(3, "1s"),
        dahai(3, "1s", true),
        EventKind::Hora {
            actor: 0,
            target: 3,
            pai: Some(t("1s")),
            deltas: Some([9_000, 0, 0, -8_000]),
            scores: Some([33_000, 25_000, 25_000, 17_000]),
            // 1 + three kans.
            ura_markers: Some(vec![t("S"), t("S"), t("S"), t("S")]),
        },
        EventKind::EndKyoku,
        EventKind::EndGame,
    ]
}

/// One exhaustive-draw kyoku, with random chi/pon calls.
///
/// The 136 tiles are shuffled from `seed`; the first 52 become the four hands,
/// the next 14 the dead wall (only one dora is revealed because this game has
/// no kans) and the last 70 the live wall. Play is tsumogiri unless a seat can
/// and elects to chi the next seat's discard or pon any discard.
pub(crate) fn exhaustive_kyoku(seed: u64, header: (u8, u8, u8, [i32; 4])) -> Vec<EventKind> {
    let (oya, kyoku, honba, scores) = header;
    let mut rng = Rng::new(seed);
    let mut deck = shuffled_deck(&mut rng);
    let mut hands: [Vec<Tile>; 4] = std::array::from_fn(|_| Vec::with_capacity(13));
    for (index, tile) in deck.drain(..52).enumerate() {
        hands[index % 4].push(tile);
    }
    let dead: Vec<Tile> = deck.drain(..14).collect();
    let mut live = deck;
    let dora = dead[0];

    let mut events = vec![start_kyoku(
        "E",
        &dora.mjai_name(),
        kyoku,
        honba,
        0,
        oya,
        scores,
        std::array::from_fn(|seat| {
            let mut hand: [Tile; 13] = hands[seat]
                .as_slice()
                .try_into()
                .expect("13 dealt tiles per seat");
            hand.sort_unstable();
            hand
        }),
    )];
    let mut next_draw = oya;
    let mut draws = 0_u16;

    while draws < 70 {
        let actor = next_draw;
        let tile = live.pop().expect("the live wall has 70 tiles");
        events.push(tsumo(actor, &tile.mjai_name()));
        hands[usize::from(actor)].push(tile);
        draws += 1;

        let discarded = hands[usize::from(actor)]
            .pop()
            .expect("a hand is never empty");
        events.push(dahai(actor, &discarded.mjai_name(), true));

        let mut from = actor;
        let mut open = discarded;
        // The last draw's discard cannot be called: the wall is empty, so no
        // hand continues past it. The app's `legal_actions` refuses the call, so
        // a synthetic game must not contain one either.
        if draws < 70 {
            while let Some((caller, consumed)) = choose_call(&mut rng, &hands, from, open) {
                let claim = match consumed.len() {
                    2 if caller == (from + 1) % 4 && is_run_tiles(open, &consumed) => {
                        EventKind::Chi {
                            actor: caller,
                            target: from,
                            pai: open,
                            consumed: [consumed[0], consumed[1]],
                        }
                    }
                    2 => EventKind::Pon {
                        actor: caller,
                        target: from,
                        pai: open,
                        consumed: [consumed[0], consumed[1]],
                    },
                    _ => unreachable!("the fixture only builds chi and pon"),
                };
                remove_from_hand(&mut hands[usize::from(caller)], &consumed);
                events.push(claim);
                let discard = hands[usize::from(caller)]
                    .pop()
                    .expect("a calling hand still has a tile to discard");
                events.push(dahai(caller, &discard.mjai_name(), false));
                from = caller;
                open = discard;
            }
        }
        next_draw = (from + 1) % 4;
    }

    events.push(EventKind::Ryukyoku {
        reason: Some("exhaustive_draw".to_string()),
        deltas: Some([0; 4]),
        scores: Some(scores),
        tehais: None,
        ura_markers: None,
    });
    events.push(EventKind::EndKyoku);
    events
}

/// One complete exhaustive-draw game.
pub(crate) fn exhaustive_game(seed: u64) -> Vec<EventKind> {
    let mut events = vec![start_game()];
    events.extend(exhaustive_kyoku(seed, (0, 1, 0, [25_000; 4])));
    events.push(EventKind::EndGame);
    events
}

/// One kyoku that ends in a chankan.
///
/// Seat 2 holds two 5s, pons seat 0's third and draws the fourth copy, so the
/// added kan offers the tile to seat 1, whose `3s 4s` ryanmen wait plus the
/// chun triplet already holds a yaku. The ron is the only event that can end
/// this hand, which is what the walker's `ReactToKan` snapshot needs.
pub(crate) fn chankan_game() -> Vec<EventKind> {
    let hands = [
        hand(&[
            "5s", "1m", "1m", "1m", "9p", "9p", "2s", "6s", "7s", "E", "E", "S", "S",
        ]),
        hand(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "C", "C", "C", "3s", "4s", "N", "N",
        ]),
        hand(&[
            "5s", "5s", "2m", "2m", "8p", "8p", "9s", "9s", "W", "W", "P", "P", "F",
        ]),
        hand(&[
            "7m", "8m", "1p", "2p", "2p", "3p", "3p", "6m", "9m", "9m", "F", "N", "S",
        ]),
    ];
    vec![
        start_game(),
        start_kyoku("E", "8s", 1, 0, 0, 0, [25_000; 4], hands),
        tsumo(0, "1s"),
        dahai(0, "5s", false),
        EventKind::Pon {
            actor: 2,
            target: 0,
            pai: t("5s"),
            consumed: tiles::<2>(&["5s", "5s"]),
        },
        dahai(2, "F", false),
        tsumo(3, "S"),
        dahai(3, "S", true),
        tsumo(0, "6m"),
        dahai(0, "6m", true),
        tsumo(1, "7p"),
        dahai(1, "7p", true),
        tsumo(2, "5s"),
        EventKind::Kakan {
            actor: 2,
            pai: t("5s"),
            consumed: tiles::<3>(&["5s", "5s", "5s"]),
        },
        EventKind::Hora {
            actor: 1,
            target: 2,
            pai: Some(t("5s")),
            deltas: Some([0, 8_000, -8_000, 0]),
            scores: None,
            ura_markers: None,
        },
        EventKind::EndKyoku,
        EventKind::EndGame,
    ]
}

/// One kyoku that ends in a chankan on an **ankan** (the kokushi robbery).
///
/// Seat 2 is dealt all four `P`, declares a closed quad on its first turn, and
/// seat 1 robs it with a thirteen-orphans wait on `P`. The app's reachability
/// validator only accepts an open four-tile kan as a chankan source, so this
/// game exercises the walker's triage path: the decision must be recorded as a
/// skip with the validator's reason, never emitted.
pub(crate) fn ankan_chankan_game() -> Vec<EventKind> {
    let hands = [
        hand(&[
            "3s", "4s", "5s", "6s", "7s", "8s", "2s", "4p", "5p", "6p", "7p", "8p", "C",
        ]),
        hand(&[
            "1m", "9m", "1p", "9p", "1s", "9s", "E", "S", "W", "N", "F", "C", "C",
        ]),
        hand(&[
            "P", "P", "P", "P", "2m", "3m", "4m", "5m", "6m", "7m", "8m", "2p", "3p",
        ]),
        hand(&[
            "1m", "9m", "1p", "9p", "1s", "9s", "E", "S", "W", "N", "F", "C", "2p",
        ]),
    ];
    vec![
        start_game(),
        start_kyoku("E", "F", 1, 0, 0, 0, [25_000; 4], hands),
        tsumo(0, "3m"),
        dahai(0, "3m", true),
        tsumo(1, "S"),
        dahai(1, "S", true),
        tsumo(2, "9p"),
        EventKind::Ankan {
            actor: 2,
            consumed: tiles::<4>(&["P", "P", "P", "P"]),
        },
        EventKind::Hora {
            actor: 1,
            target: 2,
            pai: Some(t("P")),
            deltas: Some([0, 8_000, -8_000, 0]),
            scores: None,
            ura_markers: None,
        },
        EventKind::EndKyoku,
        EventKind::EndGame,
    ]
}

/// One kyoku whose ron is impossible: the winner is in furiten.
///
/// Seat 1 is in tenpai on `2s 5s`, discards its own `5s` early (which makes it
/// permanently furiten), and is then recorded as ronning seat 0's second `5s`.
/// No legal game contains that ron, and `GameState` has no furiten field, so the
/// walker must triage the decision instead of reconstructing it.
pub(crate) fn furiten_ron_game() -> Vec<EventKind> {
    let hands = [
        hand(&[
            "5s", "5s", "7m", "8m", "9m", "1p", "2p", "3p", "7p", "8p", "9p", "6s", "7s",
        ]),
        hand(&[
            "1m", "2m", "3m", "4p", "5p", "6p", "C", "C", "C", "3s", "4s", "N", "N",
        ]),
        hand(&[
            "2m", "2m", "6m", "7m", "8m", "1s", "2s", "3s", "4s", "6s", "7s", "8s", "9s",
        ]),
        hand(&[
            "1m", "3m", "9p", "1p", "2p", "4p", "6p", "8p", "E", "E", "S", "S", "W",
        ]),
    ];
    vec![
        start_game(),
        start_kyoku("E", "F", 1, 0, 0, 0, [25_000; 4], hands),
        tsumo(0, "9m"),
        dahai(0, "5s", false),
        tsumo(1, "5s"),
        dahai(1, "5s", true),
        tsumo(2, "9s"),
        dahai(2, "9s", true),
        tsumo(3, "W"),
        dahai(3, "W", true),
        tsumo(0, "1p"),
        dahai(0, "5s", false),
        EventKind::Hora {
            actor: 1,
            target: 0,
            pai: Some(t("5s")),
            deltas: Some([-8_000, 8_000, 0, 0]),
            scores: None,
            ura_markers: None,
        },
        EventKind::EndKyoku,
        EventKind::EndGame,
    ]
}

pub(crate) fn two_kyoku_game() -> Vec<EventKind> {
    let mut events = vec![start_game()];
    events.extend(exhaustive_kyoku(1, (0, 1, 0, [25_000; 4])));
    events.extend(exhaustive_kyoku(2, (1, 2, 1, [25_000; 4])));
    events.push(EventKind::EndGame);
    events
}

/// `count` one-kyoku games, seeds `0..count`.
pub(crate) fn synthetic_games(count: u64) -> Vec<Vec<EventKind>> {
    (0..count).map(exhaustive_game).collect()
}

// --- Random play ----------------------------------------------------------

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn chance(&mut self, numerator: u64, denominator: u64) -> bool {
        self.next() % denominator < numerator
    }
}

fn shuffled_deck(rng: &mut Rng) -> Vec<Tile> {
    let mut deck = Vec::with_capacity(136);
    for kind in 0..34 {
        for copy in 0..4 {
            // The first copy of each five is the red five, exactly like the
            // one-aka-per-suit Tenhou set.
            let aka = copy == 0 && matches!(kind, 4 | 13 | 22);
            deck.push(Tile::new(kind, aka).expect("a physical tile"));
        }
    }
    for index in (1..deck.len()).rev() {
        let swap = (rng.next() % (index as u64 + 1)) as usize;
        deck.swap(index, swap);
    }
    deck
}

/// Pick a chi or pon for `open`, if a seat holds the tiles and the coin says
/// yes. Chi is only offered to the seat on the discarder's left.
fn choose_call(
    rng: &mut Rng,
    hands: &[Vec<Tile>; 4],
    from: u8,
    open: Tile,
) -> Option<(u8, Vec<Tile>)> {
    let next = (from + 1) % 4;
    if rng.chance(1, 2)
        && let Some(consumed) = find_chi(&hands[usize::from(next)], open)
    {
        return Some((next, consumed));
    }
    for offset in 1..4 {
        let seat = (from + offset) % 4;
        if rng.chance(1, 4)
            && let Some(consumed) = find_pon(&hands[usize::from(seat)], open)
        {
            return Some((seat, consumed));
        }
    }
    None
}

fn find_chi(hand: &[Tile], open: Tile) -> Option<Vec<Tile>> {
    if open.is_honor() {
        return None;
    }
    let suit = open.kind() / 9;
    let rank = (open.kind() % 9) as i32;
    for (low, high) in [
        (rank - 2, rank - 1),
        (rank - 1, rank + 1),
        (rank + 1, rank + 2),
    ] {
        if low < 0 || high > 8 {
            continue;
        }
        let low_kind = suit * 9 + low as usize;
        let high_kind = suit * 9 + high as usize;
        let low_tile = hand.iter().copied().find(|tile| tile.kind() == low_kind);
        let high_tile = hand.iter().copied().find(|tile| tile.kind() == high_kind);
        if let (Some(a), Some(b)) = (low_tile, high_tile) {
            return Some(vec![a, b]);
        }
    }
    None
}

fn find_pon(hand: &[Tile], open: Tile) -> Option<Vec<Tile>> {
    let matching: Vec<Tile> = hand
        .iter()
        .copied()
        .filter(|tile| tile.same_kind(open))
        .collect();
    (matching.len() >= 2).then(|| vec![matching[0], matching[1]])
}

fn is_run_tiles(open: Tile, consumed: &[Tile]) -> bool {
    let mut kinds = vec![open.kind()];
    kinds.extend(consumed.iter().map(|tile| tile.kind()));
    kinds.sort_unstable();
    kinds[0] + 1 == kinds[1] && kinds[1] + 1 == kinds[2]
}

fn remove_from_hand(hand: &mut Vec<Tile>, tiles: &[Tile]) {
    for tile in tiles {
        let position = hand
            .iter()
            .position(|held| held == tile)
            .expect("the fixture only removes held tiles");
        hand.remove(position);
    }
}
