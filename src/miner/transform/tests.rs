//! Tests for the permutation engine.
//!
//! The suite covers the V1 acceptance criteria from
//! `replay-implementation-plan.md` §5.3 and the §4.8 tests that belong to the
//! engine rather than the label-preservation gate:
//!
//! - inverse round-trip for each transform and for a composed chain;
//! - complete field coverage on a synthetic state with every field populated;
//! - the tile ledger conserved, with no fifth copy and red fives moving with
//!   their tile;
//! - no panic on the awkward shapes (kans, red fives, ura dora, calls, riichi);
//! - answer and model-label inverse mapping;
//! - real replay states from the R2 walker, still reachable after a suit or
//!   rank relabel;
//! - fail-closed cases: a chi that stops coming from kamicha, a red-five answer,
//!   a malformed chain.

use crate::ai::wasm_bridge::ActionEvaluation;
use crate::decision::{ActionInfo, ActionKind, AiDecision};
use crate::generator::validate_reachable_state;
use crate::miner::provenance::ReplayId;
use crate::replay::fixtures;
use crate::replay::mjai::ReplayReader;
use crate::replay::walk::walk_replay;
use crate::state::{
    CallOffer, CalledMeld, CorrectAction, DecisionContext, DiscardTile, GameState, MeldType,
    PlayerState, TargetAction, Wind,
};

use super::TransformError;
use super::chain::{TRANSFORM_SCHEMA, Transform, TransformChain};
use super::ledger::TileLedger;
use super::seat::SeatPerm;
use super::tiles::{Suit, SuitMap, TILE_KINDS};

/// A table with every field populated, including the awkward ones: a red five,
/// a chi, a pon, a riichi river, ura indicators, a call offer, a model payload
/// and free text that names tiles.
///
/// It is not a *reachable* position (the rivers are not a legal turn order), and
/// it is not meant to be: this is the field-coverage fixture. The replay test
/// below covers real reachable states.
pub(crate) fn synthetic_state() -> GameState {
    let player = |seat: usize,
                  wind: Wind,
                  score: i32,
                  hand: &[&str],
                  draw: Option<&str>,
                  red_fives: &[&str],
                  discards: &[&str],
                  melds: Vec<CalledMeld>,
                  is_riichi: bool,
                  riichi_discard_index: Option<usize>| {
        PlayerState {
            seat,
            name: ["You", "Shimocha", "Toimen", "Kamicha"][seat].to_string(),
            is_human: seat == 0,
            wind,
            score,
            hand: hand.iter().map(|tile| (*tile).to_string()).collect(),
            draw: draw.map(str::to_string),
            red_fives: red_fives.iter().map(|tile| (*tile).to_string()).collect(),
            discards: discards
                .iter()
                .map(|tile| DiscardTile::new(*tile))
                .collect(),
            melds,
            is_riichi,
            riichi_discard_index,
        }
    };

    let mut kamicha = player(
        3,
        Wind::North,
        25_000,
        &["1m", "4m", "6m", "7m", "2p", "4p", "4p", "9s", "1z", "5z"],
        None,
        &[],
        &["9s", "2m", "7p"],
        vec![CalledMeld {
            meld_type: MeldType::Chi,
            tiles: vec!["3s".to_string(), "4s".to_string(), "5s".to_string()],
            called_from: Some(2),
        }],
        true,
        Some(1),
    );
    kamicha.discards[1].is_riichi = true;

    let red_river = DiscardTile::new("5p").with_red(true);

    GameState {
        category: "replay_call".to_string(),
        target_action: TargetAction::Call,
        correct_action: CorrectAction::best(
            "Discard_6p",
            Some("6p".to_string()),
            Vec::new(),
            "Discard 6p",
        ),
        equivalent_tiles: vec!["1m".to_string()],
        decision: DecisionContext::ReactToDiscard {
            from: 1,
            tile: "5z".to_string(),
        },
        scenario_note: Some(
            "Shimocha discarded Wh. You hold a 5z pair, the E wind and a 3m.".to_string(),
        ),
        call_offer: Some(CallOffer {
            action: "Pon".to_string(),
            label: "Pon Wh".to_string(),
            tile: "5z".to_string(),
            tiles: Vec::new(),
        }),
        ai_decision: Some(AiDecision {
            model: "mortal_298k.safetensors".to_string(),
            reasoning: Some("keeps 3m and the 1z".to_string()),
            expected_value: 0.25,
            recommended_action: "Riichi".to_string(),
            riichi_discard: Some("3m".to_string()),
            evaluations: vec![ActionEvaluation {
                info: ActionInfo {
                    action: "Discard_3m".to_string(),
                    label: "Discard 3m".to_string(),
                    kind: ActionKind::Discard,
                    tile_index: Some(2),
                    tile: Some("3m".to_string()),
                    tiles: Vec::new(),
                    kan_kind: None,
                },
                probability: 0.5,
                q_value: Some(1.0),
            }],
            actions: Vec::new(),
        }),
        riichi_triggers: Vec::new(),
        dama_reasons: Vec::new(),
        shouminkan_triggers: Vec::new(),
        book_rationale: None,
        can_riichi: true,
        hand_string: "123355m46p789s155z".to_string(),
        tiles: [
            "1m", "2m", "3m", "3m", "5m", "5m", "4p", "6p", "7s", "8s", "9s", "1z", "5z", "5z",
        ]
        .into_iter()
        .map(str::to_string)
        .collect(),
        shanten: 1,
        is_agari: false,
        decompositions_count: 2,
        ukeire_tiles: vec!["4m".to_string(), "6m".to_string()],
        ukeire_total: 7,
        round_wind: Wind::East,
        hand_number: 2,
        honba: 1,
        riichi_sticks: 1,
        dora_indicators: vec!["3m".to_string()],
        ura_dora_indicators: vec!["1z".to_string()],
        tiles_remaining: 42,
        current_turn: 1,
        players: vec![
            {
                let mut human = player(
                    0,
                    Wind::East,
                    25_000,
                    &[
                        "1m", "2m", "3m", "5m", "5m", "4p", "6p", "7s", "8s", "9s", "5z", "5z",
                        "1z",
                    ],
                    Some("3m"),
                    &["5m"],
                    &["2s", "8p"],
                    Vec::new(),
                    false,
                    None,
                );
                human.discards[1] = red_river;
                human
            },
            player(
                1,
                Wind::South,
                26_000,
                &[
                    "1p", "2p", "3p", "6m", "7m", "8m", "2s", "3s", "4s", "7z", "7z", "1s", "9s",
                ],
                None,
                &[],
                &["6z", "9p", "5z"],
                Vec::new(),
                false,
                None,
            ),
            player(
                2,
                Wind::West,
                24_000,
                &["2m", "2m", "4m", "4m", "6p", "6p", "8p", "8p", "1z", "2z"],
                None,
                &[],
                &["3p", "4s", "9m"],
                vec![CalledMeld {
                    meld_type: MeldType::Pon,
                    tiles: vec!["6z".to_string(); 3],
                    called_from: Some(1),
                }],
                false,
                None,
            ),
            kamicha,
        ],
    }
}

fn suit_chain() -> TransformChain {
    TransformChain::new("0x51").with(Transform::SuitPerm {
        map: SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection"),
    })
}

fn mirror_chain() -> TransformChain {
    TransformChain::new("0x52").with(Transform::RankMirror {})
}

fn wind_chain() -> TransformChain {
    TransformChain::new("0x53").with(Transform::WindRelabel { steps: 1 })
}

fn seat_chain() -> TransformChain {
    TransformChain::new("0x54").with(Transform::SeatPerm {
        order: SeatPerm::new([2, 3, 1]).expect("permutation"),
    })
}

fn red_five_chain() -> TransformChain {
    TransformChain::new("0x55").with(Transform::Red5Normalize {})
}

/// Every catalogue chain, each with the base state it is applicable to.
fn catalogue() -> Vec<(&'static str, TransformChain)> {
    vec![
        ("seat_perm", seat_chain()),
        ("suit_perm", suit_chain()),
        ("rank_mirror", mirror_chain()),
        ("wind_relabel", wind_chain()),
        ("red5_normalize", red_five_chain()),
    ]
}

#[test]
fn every_transform_round_trips_on_a_fully_populated_state() {
    let base = synthetic_state();
    for (name, chain) in catalogue() {
        let applied = chain
            .apply(&base)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_ne!(applied.state, base, "{name} must change the table");
        let restored = applied
            .inverse()
            .apply(&applied.state)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(restored, base, "{name} did not round-trip");
    }
}

#[test]
fn a_chain_of_every_transform_round_trips() {
    let base = synthetic_state();
    let chain = seat_chain()
        .with(Transform::SuitPerm {
            map: SuitMap::new(Suit::Sou, Suit::Man, Suit::Pin).expect("bijection"),
        })
        .with(Transform::RankMirror {})
        .with(Transform::WindRelabel { steps: 3 })
        .with(Transform::Red5Normalize {});
    let applied = chain.apply(&base).expect("the chain applies");
    let restored = applied.inverse().apply(&applied.state).expect("inverts");
    assert_eq!(restored, base);
}

#[test]
fn a_suit_permutation_relabels_every_tile_bearing_field() {
    let base = synthetic_state();
    let applied = suit_chain().apply(&base).expect("applies");
    let state = &applied.state;

    // Hands, draws, rivers, melds and the red-five list move with their kind.
    assert_eq!(state.players[0].hand[0], "1p");
    assert_eq!(state.players[0].draw.as_deref(), Some("3p"));
    assert_eq!(state.players[0].red_fives, vec!["5p"]);
    assert_eq!(state.players[0].discards[0].tile, "2m");
    assert_eq!(state.players[1].hand[0], "1s");
    assert_eq!(state.players[2].melds[0].tiles, vec!["6z"; 3]);
    assert_eq!(
        state.players[3].melds[0].tiles,
        vec!["3m", "4m", "5m"],
        "a chi of sou moves to man"
    );
    // The red five in the river keeps its aka flag as its kind moves.
    assert_eq!(state.players[0].discards[1].tile, "5s");
    assert!(state.players[0].discards[1].is_red);

    // Indicators, the derived hand payload and the answer vocabulary.
    assert_eq!(state.dora_indicators, vec!["3p"]);
    assert_eq!(state.ura_dora_indicators, vec!["1z"]);
    assert_eq!(state.hand_string, "789m123355p46s155z");
    assert_eq!(base.tiles.len(), state.tiles.len());
    assert_eq!(state.tiles[0], "7m");
    assert_eq!(state.ukeire_tiles, vec!["4p", "6p"]);
    assert_eq!(state.equivalent_tiles, vec!["1p"]);
    assert_eq!(state.correct_action.tile(), Some("6s"));
    assert_eq!(
        state.call_offer.as_ref().expect("offer").tile,
        "5z",
        "an honour is not a suit"
    );
    assert_eq!(
        state.call_offer.as_ref().expect("offer").label,
        "Pon Wh",
        "an honour label keeps its display name"
    );
    match &state.decision {
        DecisionContext::ReactToDiscard { tile, .. } => assert_eq!(tile, "5z"),
        other => panic!("the decision changed shape: {other:?}"),
    }

    // Free text and the model payload.
    assert_eq!(
        state.scenario_note.as_deref(),
        Some("Shimocha discarded Wh. You hold a 5z pair, the E wind and a 3p.")
    );
    let ai = state.ai_decision.as_ref().expect("model payload");
    assert_eq!(ai.recommended_action, "Riichi");
    assert_eq!(ai.riichi_discard.as_deref(), Some("3p"));
    assert_eq!(ai.evaluations[0].info.action, "Discard_3p");
    assert_eq!(ai.evaluations[0].info.label, "Discard 3p");
    assert_eq!(ai.evaluations[0].info.tile.as_deref(), Some("3p"));
    assert_eq!(ai.evaluations[0].info.tile_index, Some(11));
    assert_eq!(
        ai.reasoning.as_deref(),
        Some("keeps 3p and the 1z"),
        "the model's reasoning is copy, and its tile token moves"
    );

    // Board state that must not move.
    assert_eq!(state.current_turn, base.current_turn);
    assert_eq!(state.round_wind, base.round_wind);
    assert_eq!(state.hand_number, base.hand_number);
    assert_eq!(state.honba, base.honba);
    assert_eq!(state.riichi_sticks, base.riichi_sticks);
    assert_eq!(state.tiles_remaining, base.tiles_remaining);
    assert_eq!(state.shanten, base.shanten);
    assert_eq!(state.ukeire_total, base.ukeire_total);
    for (before, after) in base.players.iter().zip(&state.players) {
        assert_eq!(before.score, after.score);
        assert_eq!(before.wind, after.wind);
        assert_eq!(before.is_riichi, after.is_riichi);
        assert_eq!(before.riichi_discard_index, after.riichi_discard_index);
    }
}

#[test]
fn a_seat_permutation_moves_whole_players_and_their_seat_references() {
    let base = synthetic_state();
    let applied = seat_chain().apply(&base).expect("applies");
    let state = &applied.state;

    // New seats 1, 2, 3 held old seats 2, 3, 1.
    let order = [2usize, 3, 1];
    for (new_seat, old_seat) in order.iter().enumerate() {
        let new_seat = new_seat + 1;
        assert_eq!(state.players[new_seat].score, base.players[*old_seat].score);
        assert_eq!(state.players[new_seat].hand, base.players[*old_seat].hand);
        assert_eq!(state.players[new_seat].melds, {
            let mut melds = base.players[*old_seat].melds.clone();
            for meld in &mut melds {
                meld.called_from = meld
                    .called_from
                    .map(|from| SeatPerm::new([2, 3, 1]).expect("permutation").dest(from));
            }
            melds
        });
    }
    assert_eq!(state.players[0], base.players[0], "the actor does not move");
    assert_eq!(
        state.players[1].wind,
        Wind::South,
        "a seat wind belongs to the seat, so the wind labels stay put"
    );
    for (index, player) in state.players.iter().enumerate() {
        assert_eq!(player.wind, state.players[0].wind.next(index));
        assert_eq!(player.seat, index);
        assert_eq!(player.name, ["You", "Shimocha", "Toimen", "Kamicha"][index]);
        assert_eq!(player.is_human, index == 0);
    }
    assert_eq!(state.current_turn, 3);
    match &state.decision {
        DecisionContext::ReactToDiscard { from, tile } => {
            assert_eq!(*from, 3);
            assert_eq!(tile, "5z");
        }
        other => panic!("the decision changed shape: {other:?}"),
    }

    // The tile payload and the actor's hand do not change.
    assert_eq!(state.hand_string, base.hand_string);
    assert_eq!(state.correct_action, base.correct_action);
    assert_eq!(state.call_offer, base.call_offer);
}

#[test]
fn a_rank_mirror_relabels_ranks_and_swaps_the_chi_endpoints() {
    let base = synthetic_state();
    let applied = mirror_chain().apply(&base).expect("applies");
    let state = &applied.state;

    assert_eq!(state.players[0].hand[0], "9m");
    assert_eq!(state.players[0].draw.as_deref(), Some("7m"));
    assert_eq!(state.players[3].melds[0].tiles, vec!["7s", "6s", "5s"]);
    assert_eq!(state.dora_indicators, vec!["7m"]);
    assert_eq!(state.ura_dora_indicators, vec!["1z"]);
    assert!(state.players[0].discards[1].is_red, "5p is its own mirror");
    assert_eq!(state.hand_string, "557789m46p123s155z");
    assert_eq!(
        applied.chain.map_action_name("Chi_Low").unwrap(),
        "Chi_High"
    );
    assert_eq!(
        applied.chain.map_action_name("Chi_High").unwrap().as_str(),
        "Chi_Low"
    );
    assert_eq!(applied.chain.map_action_name("Chi_Mid").unwrap(), "Chi_Mid");
}

#[test]
fn a_wind_relabel_rotates_seat_winds_honours_and_the_round_wind() {
    let base = synthetic_state();
    let applied = wind_chain().apply(&base).expect("applies");
    let state = &applied.state;

    assert_eq!(state.round_wind, Wind::South);
    assert_eq!(
        state.players.iter().map(|p| p.wind).collect::<Vec<_>>(),
        vec![Wind::South, Wind::West, Wind::North, Wind::East]
    );
    assert_eq!(state.players[0].hand[12], "2z", "1z becomes 2z");
    assert_eq!(
        state.players[0].red_fives,
        vec!["5m"],
        "a five is not a wind"
    );
    assert_eq!(state.ura_dora_indicators, vec!["2z"]);
    assert_eq!(
        state.call_offer.as_ref().expect("offer").label,
        "Pon Wh",
        "Wh is the white dragon, not a wind, so it does not move"
    );
    assert_eq!(
        state.scenario_note.as_deref(),
        Some("Shimocha discarded Wh. You hold a 5z pair, the S wind and a 3m."),
        "the wind display name rotates; the dragon's does not"
    );
    assert_eq!(
        state.dealer_seat(),
        3,
        "the dealer follows the rotated labels"
    );
}

#[test]
fn red_five_normalisation_clears_the_flags_and_records_the_copies() {
    let base = synthetic_state();
    let applied = red_five_chain().apply(&base).expect("applies");
    let state = &applied.state;

    assert!(state.players.iter().all(|p| p.red_fives.is_empty()));
    assert!(state.players[0].discards.iter().all(|d| !d.is_red));
    assert_eq!(state.hand_string, base.hand_string, "kinds do not change");
    assert_eq!(state.players[0].hand, base.players[0].hand);
    let slots = applied.chain.red_fives.as_ref().expect("recorded");
    assert_eq!(slots.len(), 2, "the hand copy and the river copy");

    assert_eq!(applied.inverse().apply(state).expect("inverts"), base);
}

#[test]
fn the_tile_ledger_is_permuted_and_never_grows_a_copy() {
    let base = synthetic_state();
    let base_ledger = TileLedger::of(&base).expect("the fixture is a possible table");

    for (name, chain) in catalogue() {
        let applied = chain
            .apply(&base)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let after = TileLedger::of(&applied.state)
            .unwrap_or_else(|error| panic!("{name} broke the ledger: {error}"));
        assert_eq!(
            after.total(),
            base_ledger.total(),
            "{name} added or lost a tile"
        );

        let kinds = chain.transforms[0].mapping().kinds;
        for kind in 0..TILE_KINDS {
            assert_eq!(
                after.count_kind(kinds.kind(kind)),
                base_ledger.count_kind(kind),
                "{name} lost a copy of kind {kind}"
            );
        }
        for suit in Suit::ALL {
            let mapped = kinds.kind(suit.base() + 4);
            let mapped_suit = if mapped < 27 {
                Suit::ALL[mapped / 9]
            } else {
                suit
            };
            let expects_red = base_ledger.red(suit)
                && !matches!(chain.transforms[0], Transform::Red5Normalize {});
            assert_eq!(
                after.red(mapped_suit),
                expects_red,
                "{name} moved a red five"
            );
        }
    }
}

#[test]
fn a_composed_chain_conserves_tiles_through_every_step() {
    let base = synthetic_state();
    let chain = suit_chain()
        .with(Transform::RankMirror {})
        .with(Transform::WindRelabel { steps: 2 });
    let base_ledger = TileLedger::of(&base).expect("possible");
    let applied = chain.apply(&base).expect("applies");
    let after = TileLedger::of(&applied.state).expect("still possible");

    let mut composed = super::tiles::KindMap::identity();
    for transform in &chain.transforms {
        let step = transform.mapping().kinds;
        composed = super::tiles::KindMap::from_fn(|kind| step.kind(composed.kind(kind)));
    }
    for kind in 0..TILE_KINDS {
        assert_eq!(
            after.count_kind(composed.kind(kind)),
            base_ledger.count_kind(kind)
        );
    }
}

#[test]
fn answers_and_model_labels_inverse_map() {
    let base = synthetic_state();
    let applied = suit_chain().apply(&base).expect("applies");
    let inverse = applied.inverse();

    // A book answer.
    let answer = CorrectAction::Dama {
        discard: "1m".to_string(),
    };
    let mapped = applied.chain.map_correct_action(&answer).expect("maps");
    assert_eq!(
        mapped,
        CorrectAction::Dama {
            discard: "1p".to_string()
        }
    );
    assert_eq!(
        inverse.map_correct_action(&mapped).expect("inverts"),
        answer
    );

    // A model's top action, as stored on a label.
    let top = ActionInfo {
        action: "Discard_3m".to_string(),
        label: "Discard 3m".to_string(),
        kind: ActionKind::Discard,
        tile_index: Some(2),
        tile: Some("3m".to_string()),
        tiles: Vec::new(),
        kan_kind: None,
    };
    let mapped_top = applied.chain.map_action_info(&top).expect("maps");
    assert_eq!(mapped_top.action, "Discard_3p");
    assert_eq!(mapped_top.tile.as_deref(), Some("3p"));
    assert_eq!(mapped_top.tile_index, Some(11));
    assert_eq!(inverse.map_action_info(&mapped_top).expect("inverts"), top);

    // A chi's rank-relative name.
    let mirror = mirror_chain().apply(&base).expect("applies");
    let inverse = mirror.inverse();
    let high = ActionInfo {
        action: "Chi_High".to_string(),
        label: "Chi 4m 5m on 3m".to_string(),
        kind: ActionKind::Chi,
        tile_index: None,
        tile: Some("3m".to_string()),
        tiles: vec!["4m".to_string(), "5m".to_string()],
        kan_kind: None,
    };
    let mapped = mirror.chain.map_action_info(&high).expect("maps");
    assert_eq!(mapped.action, "Chi_Low");
    assert_eq!(inverse.map_action_info(&mapped).expect("inverts"), high);
}

#[test]
fn a_chi_only_survives_a_seat_permutation_that_keeps_its_kamicha() {
    let base = synthetic_state();
    // Old seat 3's chi claims old seat 2. This permutation sends 3 to 2 and 2 to
    // 1, which is still the previous seat.
    assert!(
        super::apply::check_chi_seats(&base, SeatPerm::new([2, 3, 1]).expect("permutation"))
            .is_ok()
    );
    // This one sends 3 to 1 and 2 to 2: the chi would claim across the table.
    let broken = SeatPerm::new([1, 3, 2]).expect("permutation");
    assert!(matches!(
        super::apply::check_chi_seats(&base, broken),
        Err(TransformError::ChiNotFromPreviousSeat { .. })
    ));
    let chain = TransformChain::new("0x56").with(Transform::SeatPerm { order: broken });
    assert!(matches!(
        chain.apply(&base),
        Err(TransformError::ChiNotFromPreviousSeat { .. })
    ));
}

#[test]
fn a_chi_offer_must_still_come_from_kamicha() {
    let mut base = synthetic_state();
    base.call_offer = Some(CallOffer {
        action: "Chi".to_string(),
        label: "Chi 4m 5m on 3m".to_string(),
        tile: "3m".to_string(),
        tiles: vec!["4m".to_string(), "5m".to_string()],
    });
    base.decision = DecisionContext::ReactToDiscard {
        from: 3,
        tile: "3m".to_string(),
    };
    base.players[3].melds.clear();
    base.players[3].hand = vec!["1m".to_string(); 13];

    assert!(
        super::apply::check_chi_seats(&base, SeatPerm::new([2, 1, 3]).expect("permutation"))
            .is_ok(),
        "seat 3 stays kamicha"
    );
    let broken = SeatPerm::new([2, 3, 1]).expect("permutation");
    assert!(matches!(
        super::apply::check_chi_seats(&base, broken),
        Err(TransformError::ChiOfferNotFromKamicha { .. })
    ));
}

#[test]
fn a_red_five_answer_makes_the_normalisation_inapplicable() {
    let mut base = synthetic_state();
    base.correct_action = CorrectAction::best(
        "Discard_5mr",
        Some("5m".to_string()),
        Vec::new(),
        "Discard R5m",
    );
    assert!(matches!(
        red_five_chain().apply(&base),
        Err(TransformError::RedFiveAction { .. })
    ));

    // The same red name inside the model payload is refused too.
    let mut base = synthetic_state();
    if let Some(ai) = base.ai_decision.as_mut() {
        ai.evaluations[0].info.action = "Discard_5mr".to_string();
    }
    assert!(matches!(
        red_five_chain().apply(&base),
        Err(TransformError::RedFiveAction { .. })
    ));
}

#[test]
fn a_malformed_table_or_chain_fails_closed() {
    let mut base = synthetic_state();
    base.players.pop();
    assert!(matches!(
        suit_chain().apply(&base),
        Err(TransformError::TableShape { .. })
    ));

    let mut base = synthetic_state();
    base.players[0].hand[0] = "0m".to_string();
    assert!(matches!(
        suit_chain().apply(&base),
        Err(TransformError::InvalidTile { .. })
    ));

    let mut base = synthetic_state();
    base.current_turn = 9;
    assert!(matches!(
        seat_chain().apply(&base),
        Err(TransformError::InvalidSeat { .. })
    ));

    let base = synthetic_state();
    let chain = TransformChain::new("0x57")
        .with(Transform::SeatPerm {
            order: SeatPerm::new([2, 3, 1]).expect("permutation"),
        })
        .with(Transform::WindRelabel { steps: 4 });
    assert!(matches!(
        chain.apply(&base),
        Err(TransformError::InvalidWindSteps { .. })
    ));

    let foreign: TransformChain = serde_json::from_value(serde_json::json!({
        "schema": "riichiprac.other-schema",
        "version": 1,
        "transforms": []
    }))
    .expect("parses structurally");
    assert!(matches!(
        foreign.apply(&base),
        Err(TransformError::Schema { .. })
    ));

    let mut inverse = suit_chain().apply(&base).expect("applies").inverse();
    inverse.version = 99;
    assert!(matches!(
        inverse.apply(&base),
        Err(TransformError::Version { .. })
    ));
}

#[test]
fn the_book_rationale_is_never_rewritten() {
    use crate::rationale::{BookRationale, BookRule, Citation};

    let mut base = synthetic_state();
    let rationale = BookRationale {
        summary: "Discard 3m to keep the 1z pair".to_string(),
        rules: vec![BookRule {
            id: "good_wait".to_string(),
            rule: "Keep the wait".to_string(),
            quote: "Your hand has a good wait.".to_string(),
            citation: Citation {
                book: "Riichi Book 1".to_string(),
                chapter: 7,
                chapter_title: "Riichi".to_string(),
                section: "Good wait".to_string(),
                source_file: "ch7.tex".to_string(),
                source_line: 1,
                source_needle: "good wait".to_string(),
            },
            applies: "The wait is 3m and 1z".to_string(),
        }],
        absent: Vec::new(),
        source: Citation {
            book: "Riichi Book 1".to_string(),
            chapter: 7,
            chapter_title: "Riichi".to_string(),
            section: "Riichi judgement".to_string(),
            source_file: "ch7.tex".to_string(),
            source_line: 2,
            source_needle: "riichi".to_string(),
        },
        caveats: Vec::new(),
    };
    base.book_rationale = Some(rationale.clone());

    for (name, chain) in catalogue() {
        let applied = chain
            .apply(&base)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            applied.state.book_rationale.as_ref(),
            Some(&rationale),
            "{name} must leave the rationale for the gate to recompute"
        );
    }
}

#[test]
fn a_minimal_table_does_not_panic() {
    let mut base = synthetic_state();
    for player in &mut base.players {
        player.hand.clear();
        player.draw = None;
        player.red_fives.clear();
        player.discards.clear();
        player.melds.clear();
        player.is_riichi = false;
        player.riichi_discard_index = None;
    }
    base.tiles.clear();
    base.ukeire_tiles.clear();
    base.hand_string = String::new();
    base.equivalent_tiles.clear();
    base.call_offer = None;
    base.ai_decision = None;
    base.dora_indicators.clear();
    base.ura_dora_indicators.clear();
    base.decision = DecisionContext::SelfTurn;
    base.current_turn = 0;

    for (name, chain) in catalogue() {
        let applied = chain
            .apply(&base)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(
            applied.inverse().apply(&applied.state).expect("inverts"),
            base
        );
    }
}

#[test]
fn the_hand_string_stays_the_compact_form_of_the_hand() {
    let base = synthetic_state();
    for (name, chain) in catalogue() {
        let applied = chain
            .apply(&base)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let state = &applied.state;
        let mut sorted = state.tiles.clone();
        sorted.sort_by_key(|code| crate::ai::encoder::tile_index(code).expect("a code"));
        assert_eq!(sorted, state.tiles, "{name} left the hand unsorted");
        assert_eq!(
            state.hand_string,
            compact(&state.players[0].hand, state.players[0].draw.as_deref()),
            "{name} left the hand string stale"
        );
    }
}

/// The compact form of a hand, computed independently of the engine.
fn compact(hand: &[String], draw: Option<&str>) -> String {
    let mut tiles: Vec<String> = hand.to_vec();
    if let Some(draw) = draw {
        tiles.push(draw.to_string());
    }
    let mut groups: [Vec<u8>; 4] = Default::default();
    for code in tiles {
        let index = crate::ai::encoder::tile_index(&code).expect("a code");
        let (group, rank) = if index < 27 {
            (index / 9, index % 9 + 1)
        } else {
            (3, index - 26)
        };
        groups[group].push(rank as u8);
    }
    let mut out = String::new();
    for (group, ranks) in groups.iter_mut().enumerate() {
        if ranks.is_empty() {
            continue;
        }
        ranks.sort_unstable();
        for rank in ranks.iter() {
            out.push(char::from(b'0' + rank));
        }
        out.push(['m', 'p', 's', 'z'][group]);
    }
    out
}

#[test]
fn walked_replay_states_stay_reachable_after_a_suit_or_rank_relabel() {
    let text = fixtures::to_jsonl(&fixtures::all_events_game());
    let bytes = fixtures::gzip(&text);
    let file = ReplayReader::read_gzip(&bytes).expect("the fixture parses");
    let walk = walk_replay(&file, ReplayId::from_bytes(&bytes)).expect("the fixture validates");
    assert!(!walk.decisions.is_empty());

    for chain in [suit_chain(), mirror_chain()] {
        for decision in &walk.decisions {
            let applied = chain
                .apply(&decision.state)
                .unwrap_or_else(|error| panic!("{}: {error}", decision.decision_id));
            validate_reachable_state(&applied.state).unwrap_or_else(|error| {
                panic!(
                    "{} after {:?}: {error}",
                    decision.decision_id, chain.transforms[0]
                )
            });
            assert_eq!(
                applied.inverse().apply(&applied.state).expect("inverts"),
                decision.state,
                "{}",
                decision.decision_id
            );
            let base = TileLedger::of(&decision.state).expect("a walked state is possible");
            let after = TileLedger::of(&applied.state).expect("a transformed state is possible");
            assert_eq!(base.total(), after.total(), "{}", decision.decision_id);
        }
    }

    // A wind relabel moves the dealer seat with the labels, so it is the gate's
    // job to re-check reachability; the engine's contract is the round trip and
    // the ledger.
    for decision in &walk.decisions {
        let applied = wind_chain()
            .apply(&decision.state)
            .unwrap_or_else(|error| panic!("{}: {error}", decision.decision_id));
        assert_eq!(
            applied.inverse().apply(&applied.state).expect("inverts"),
            decision.state,
            "{}",
            decision.decision_id
        );
        let base = TileLedger::of(&decision.state).expect("a walked state is possible");
        let after = TileLedger::of(&applied.state).expect("a transformed state is possible");
        assert_eq!(base.total(), after.total(), "{}", decision.decision_id);
    }
}

#[test]
fn walked_replay_states_round_trip_through_every_catalogue_transform() {
    let text = fixtures::to_jsonl(&fixtures::all_events_game());
    let bytes = fixtures::gzip(&text);
    let file = ReplayReader::read_gzip(&bytes).expect("the fixture parses");
    let walk = walk_replay(&file, ReplayId::from_bytes(&bytes)).expect("the fixture validates");

    for (name, chain) in catalogue() {
        for decision in &walk.decisions {
            let Ok(applied) = chain.apply(&decision.state) else {
                // A seat permutation that breaks a chi's seating, or an answer
                // that names a red five, is a documented rejection.
                continue;
            };
            assert_eq!(
                applied.inverse().apply(&applied.state).expect("inverts"),
                decision.state,
                "{name} did not round-trip {}",
                decision.decision_id
            );
            TileLedger::of(&applied.state).unwrap_or_else(|error| {
                panic!(
                    "{name} broke the ledger at {}: {error}",
                    decision.decision_id
                )
            });
        }
    }
}

#[test]
fn the_inverse_document_round_trips_through_json() {
    let base = synthetic_state();
    let applied = seat_chain()
        .with(Transform::SuitPerm {
            map: SuitMap::new(Suit::Sou, Suit::Pin, Suit::Man).expect("bijection"),
        })
        .with(Transform::RankMirror {})
        .with(Transform::WindRelabel { steps: 2 })
        .with(Transform::Red5Normalize {})
        .apply(&base)
        .expect("applies");
    let inverse = applied.inverse();
    let json = serde_json::to_value(&inverse).expect("serialises");
    assert_eq!(json["schema"], TRANSFORM_SCHEMA);
    assert_eq!(json["steps"].as_array().expect("steps").len(), 5);
    let parsed: super::chain::InverseChain = serde_json::from_value(json).expect("parses");
    assert_eq!(parsed, inverse);
    assert_eq!(parsed.apply(&applied.state).expect("inverts"), base);
}

#[test]
fn the_chain_document_is_the_variant_provenance() {
    let base = synthetic_state();
    let chain = suit_chain().with(Transform::Red5Normalize {});
    let applied = chain.apply(&base).expect("applies");
    let document = serde_json::to_value(&applied.chain).expect("serialises");

    assert_eq!(document["schema"], TRANSFORM_SCHEMA);
    assert_eq!(document["transform_seed"], "0x51");
    assert_eq!(document["transforms"][0]["kind"], "suit_perm");
    assert_eq!(document["transforms"][1]["kind"], "red5_normalize");
    assert!(
        document["red_fives"].is_array(),
        "the applied chain records the copies it normalised"
    );
    assert_eq!(
        serde_json::from_value::<TransformChain>(document).expect("parses"),
        applied.chain
    );
}

#[test]
fn two_chains_can_produce_the_same_state() {
    // §4.8's dedupe case: the chain fingerprint is not a state hash. A rank
    // mirror applied twice restores the base table, so two *different* chains
    // collide on the state and must be deduped by the state hash, not by the
    // transform document.
    let base = synthetic_state();
    let twice = TransformChain::new("0x60")
        .with(Transform::RankMirror {})
        .with(Transform::RankMirror {});
    let applied = twice.apply(&base).expect("applies");
    assert_eq!(applied.state, base);
    assert_ne!(
        twice.fingerprint(),
        TransformChain::new("0x61").fingerprint(),
        "the chain fingerprint describes the operations, not the resulting state"
    );
}

#[test]
fn the_kind_maps_leave_the_seat_game_untouched() {
    let base = synthetic_state();
    for (name, chain) in [
        ("suit_perm", suit_chain()),
        ("rank_mirror", mirror_chain()),
        ("wind_relabel", wind_chain()),
        ("red5_normalize", red_five_chain()),
    ] {
        let applied = chain
            .apply(&base)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert_eq!(applied.state.current_turn, base.current_turn, "{name}");
        assert_eq!(applied.state.players[0].seat, 0, "{name}");
        assert_eq!(
            applied
                .state
                .players
                .iter()
                .map(|p| p.seat)
                .collect::<Vec<_>>(),
            vec![0, 1, 2, 3],
            "{name}"
        );
        assert_eq!(
            applied
                .state
                .players
                .iter()
                .map(|p| p.is_riichi)
                .collect::<Vec<_>>(),
            vec![false, false, false, true],
            "{name}"
        );
    }
}
