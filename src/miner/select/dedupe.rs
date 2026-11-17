//! Exact and visible-info dedupe keys (implementation unit S2).
//!
//! Replay-strategy §7.1 gate 7 rejects a candidate whose **exact state hash**
//! and **near-duplicate fingerprint** are not new to the pack. The two keys
//! answer different questions:
//!
//! - [`exact_state_hash`] is the SHA-256 of the v4 observation: exactly the
//!   position the model sees. Two decisions with the same observation are the
//!   same drill.
//! - [`visible_info_fingerprint`] is a SHA-256 of the *literal visible table*
//!   only: the actor's hand, every meld and river, the dora indicators, the
//!   scores, the round and the decision context. Opponent concealed hands are
//!   excluded, because a trainee cannot see them. Two states that differ only in
//!   the hidden hands are therefore near-duplicates: the player faces the same
//!   board.
//!
//! # Transforms must not collide by accident
//!
//! The fingerprint hashes **literal tile codes**. It never canonicalises suits,
//! seats or ranks. A suit-permuted variant therefore has a different
//! fingerprint, which is required: permutation (V1) records an explicit
//! `variant_of` lineage and V2 caps variants per base. If this module collapsed
//! isomorphic hands, every variant would look like a duplicate of its base and
//! two unrelated scenarios that happened to share a shape would collapse into
//! one. Dedupe is about the literal state a trainee sees, not about isomorphism.
//!
//! The exact hash deliberately reuses [`crate::miner::label::state_hash`], the
//! L1 cache key, so the selector and the labeler always agree on what "the same
//! position" means.

use std::collections::BTreeMap;

use crate::miner::label::state_hash;
use crate::miner::provenance::sha256_hex;
use crate::replay::walk::DecisionSnapshot;
use crate::state::{DecisionContext, GameState};

use super::gate::{GateFailure, GateKind};

/// Version of the visible-info fingerprint format.
///
/// A change to the fields or their order is a breaking change: increment it so
/// an old queue's fingerprints can be told apart.
pub const VISIBLE_FINGERPRINT_VERSION: &str = "v1";

/// The model-visible exact hash of one position.
#[must_use]
pub fn exact_state_hash(state: &GameState) -> String {
    state_hash(state)
}

/// A SHA-256 over the literal, human-visible table of one decision.
///
/// The input is a canonical text form, so it is stable across runs and hosts:
/// hands are sorted (hand order is not information), rivers keep their order
/// (turn order is information), and every tile is written as its literal code.
#[must_use]
pub fn visible_info_fingerprint(snapshot: &DecisionSnapshot) -> String {
    let mut text = String::new();
    text.push_str("riichiprac.visible-info.");
    text.push_str(VISIBLE_FINGERPRINT_VERSION);
    text.push('\n');

    let state = &snapshot.state;
    text.push_str(&format!(
        "round={:?}/{}/{}/{}/{}\n",
        state.round_wind,
        state.hand_number,
        state.honba,
        state.riichi_sticks,
        state.tiles_remaining
    ));
    let mut dora = state.dora_indicators.clone();
    dora.sort();
    text.push_str(&format!("dora={}\n", dora.join("")));

    for (index, player) in state.players.iter().enumerate() {
        text.push_str(&format!(
            "seat={index};wind={:?};score={};riichi={};riichi_at={}\n",
            player.wind,
            player.score,
            player.is_riichi,
            player
                .riichi_discard_index
                .map_or_else(|| "-".to_string(), |value| value.to_string())
        ));
        if index == 0 {
            let mut hand = player.hand.clone();
            hand.sort();
            text.push_str(&format!(
                "hand={};draw={}\n",
                hand.join(""),
                player.draw.as_deref().unwrap_or("-")
            ));
        }
        let mut melds: Vec<String> = player
            .melds
            .iter()
            .map(|meld| {
                let mut tiles = meld.tiles.clone();
                tiles.sort();
                format!(
                    "{:?}:{}:{}",
                    meld.meld_type,
                    tiles.join(""),
                    meld.called_from
                        .map_or_else(|| "-".to_string(), |from| from.to_string())
                )
            })
            .collect();
        melds.sort();
        text.push_str(&format!("melds={}\n", melds.join(",")));
        let river: Vec<String> = player
            .discards
            .iter()
            .map(|discard| {
                format!(
                    "{}{}{}{}",
                    discard.tile,
                    if discard.is_riichi { "R" } else { "" },
                    if discard.is_tsumogiri { "T" } else { "" },
                    if discard.is_red { "r" } else { "" }
                )
            })
            .collect();
        text.push_str(&format!("river={}\n", river.join(",")));
    }

    match &snapshot.state.decision {
        DecisionContext::SelfTurn => text.push_str("decision=self_turn\n"),
        DecisionContext::ReactToDiscard { from, tile } => {
            text.push_str(&format!("decision=react_discard:{from}:{tile}\n"));
        }
        DecisionContext::ReactToKan { from, tile } => {
            text.push_str(&format!("decision=react_kan:{from}:{tile}\n"));
        }
    }
    text.push_str(&format!("kind={}\n", snapshot.kind.as_str()));

    sha256_hex(text.as_bytes())
}

/// Every key the pack already contains.
///
/// Both maps point at the decision that owns the key, so a rejection can name
/// which earlier scenario caused it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DedupeSet {
    exact: BTreeMap<String, String>,
    visible: BTreeMap<String, String>,
}

impl DedupeSet {
    /// An empty set.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of decision keys held.
    #[must_use]
    pub fn len(&self) -> usize {
        self.exact.len()
    }

    /// True when nothing has been inserted.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.exact.is_empty()
    }

    /// Check a candidate's keys without inserting them.
    #[must_use]
    pub fn check(&self, exact: &str, visible: &str) -> Option<GateFailure> {
        if let Some(owner) = self.exact.get(exact) {
            return Some(GateFailure::new(
                GateKind::Duplicate,
                "duplicate_exact",
                format!("same model-visible state as {owner}"),
            ));
        }
        if let Some(owner) = self.visible.get(visible) {
            return Some(GateFailure::new(
                GateKind::Duplicate,
                "duplicate_near",
                format!("same visible table as {owner}"),
            ));
        }
        None
    }

    /// Check and insert in one step. The first owner of a key wins.
    pub fn insert(&mut self, exact: String, visible: String, owner: &str) -> Option<GateFailure> {
        if let Some(failure) = self.check(&exact, &visible) {
            return Some(failure);
        }
        self.exact.insert(exact, owner.to_string());
        self.visible.insert(visible, owner.to_string());
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::miner::provenance::ReplayId;

    use crate::miner::select::tests::fixture;

    #[test]
    fn the_fingerprint_ignores_hidden_hands_only() {
        let mut snapshot = fixture::snapshot();
        let base = visible_info_fingerprint(&snapshot);
        let hidden_before = snapshot.state.players[1].hand.clone();

        snapshot.state.players[1].hand = vec!["1z".to_string(); hidden_before.len()];
        assert_eq!(
            visible_info_fingerprint(&snapshot),
            base,
            "opponent concealed tiles are not visible information"
        );
        assert_eq!(
            exact_state_hash(&snapshot.state),
            exact_state_hash(&fixture::snapshot().state),
            "the model-visible hash ignores opponent concealed tiles too"
        );

        snapshot.state.players[0].hand[0] = "9p".to_string();
        assert_ne!(
            visible_info_fingerprint(&snapshot),
            base,
            "the actor's own hand is visible"
        );
    }

    #[test]
    fn hand_order_is_not_information_but_river_order_is() {
        let first = fixture::snapshot();
        let mut reordered = first.clone();
        reordered.state.players[0].hand.reverse();
        assert_eq!(
            visible_info_fingerprint(&first),
            visible_info_fingerprint(&reordered)
        );

        let mut river = first.clone();
        river.state.players[3].discards.swap(0, 1);
        assert_ne!(
            visible_info_fingerprint(&first),
            visible_info_fingerprint(&river),
            "a river's order is the turn order"
        );
    }

    #[test]
    fn a_suit_permutation_does_not_collide_with_its_base() {
        let base = fixture::snapshot();
        let mut permuted = base.clone();
        let map = |tile: &str| -> String {
            let (rank, suit) = tile.split_at(tile.len() - 1);
            let suit = match suit {
                "m" => "p",
                "p" => "s",
                _ => "m",
            };
            format!("{rank}{suit}")
        };
        for player in &mut permuted.state.players {
            for tile in &mut player.hand {
                *tile = map(tile);
            }
            for tile in &mut player.discards {
                tile.tile = map(&tile.tile);
            }
        }
        assert_ne!(
            visible_info_fingerprint(&base),
            visible_info_fingerprint(&permuted),
            "a literal-tile fingerprint must not canonicalise suits"
        );
        assert_ne!(
            exact_state_hash(&base.state),
            exact_state_hash(&permuted.state)
        );
    }

    #[test]
    fn the_decision_context_is_part_of_the_key() {
        let mut self_turn = fixture::snapshot();
        let mut reaction = self_turn.clone();
        reaction.kind = crate::replay::walk::DecisionKind::ReactToDiscard;
        self_turn.kind = crate::replay::walk::DecisionKind::ReactToDiscard;
        reaction.state.decision = DecisionContext::ReactToDiscard {
            from: 1,
            tile: "4z".to_string(),
        };
        assert_ne!(
            visible_info_fingerprint(&self_turn),
            visible_info_fingerprint(&reaction)
        );

        self_turn.state.decision = DecisionContext::ReactToDiscard {
            from: 1,
            tile: "4z".to_string(),
        };
        assert_eq!(
            visible_info_fingerprint(&self_turn),
            visible_info_fingerprint(&reaction)
        );
        let _ = ReplayId::from_bytes(b"dedupe-fixture");
    }

    #[test]
    fn the_set_rejects_both_keys_and_names_the_owner() {
        let mut set = DedupeSet::new();
        assert!(set.is_empty());
        assert!(
            set.insert("exact-a".to_string(), "visible-a".to_string(), "first")
                .is_none()
        );
        assert_eq!(set.len(), 1);

        let exact = set
            .check("exact-a", "visible-b")
            .expect("the exact key is taken");
        assert_eq!(exact.code, "duplicate_exact");
        assert!(exact.detail.contains("first"));

        let near = set
            .check("exact-b", "visible-a")
            .expect("the visible key is taken");
        assert_eq!(near.code, "duplicate_near");

        assert!(set.check("exact-b", "visible-b").is_none());
        assert!(
            set.insert("exact-c".to_string(), "visible-a".to_string(), "second")
                .is_some(),
            "a rejected insert leaves the set unchanged"
        );
        assert_eq!(set.len(), 1);
    }
}
