//! One relabelling step: the state and answer vocabulary it rewrites.
//!
//! Every catalogue transform is a [`Mapping`]: an optional opponent permutation,
//! a 34-kind bijection, an optional round-wind rotation, and two flags the
//! answer vocabulary needs. The chain applies one mapping per transform, so a
//! composed chain is a fold of mappings and its inverse is the fold of the
//! inverse mappings in reverse order.
//!
//! # Answer vocabulary
//!
//! A Mortal action name embeds a tile (`Discard_3m`, `Discard_5mr`) or a
//! rank-relative chi position (`Chi_Low` is "the called tile is the lowest of
//! the run"). A rank mirror reverses that relation, so `Chi_Low` becomes
//! `Chi_High`; a suit permutation only changes the embedded code.
//!
//! # Free text
//!
//! Lesson copy and action labels name tiles as codes (`5z`) or as the app's
//! display names (`Wh`, `R5m`, `3p`). [`Mapping::map_text`] rewrites whole
//! alphanumeric tokens, which is a bijection on the tokens it recognises and
//! leaves every other word alone. It deliberately never adds or removes a
//! red-five display: a note that mentions one is copy, not table state, and the
//! red-five normalisation records the physical copies instead (see
//! [`super::apply`]).

use crate::ai::encoder::{tile_index, tile_name};
use crate::decision::ActionInfo;
use crate::display::format_tile_for_display;
use crate::state::CorrectAction;

use super::TransformError;
use super::seat::SeatPerm;
use super::tiles::{FIRST_WIND, KindMap, Suit, TILE_KINDS};

/// One transform's relabelling, in the form the apply and label code share.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mapping {
    /// How the opponents move around the acting seat.
    pub seat: SeatPerm,
    /// How tile kinds are relabelled.
    pub kinds: KindMap,
    /// Rotation of the round wind, in seats.
    pub wind_steps: u8,
    /// Whether a red five keeps its aka identity.
    pub keeps_red_fives: bool,
    /// Whether the mapping reverses rank order, so a chi's low end becomes its
    /// high end.
    pub flips_chi: bool,
}

impl Mapping {
    /// The mapping that changes nothing.
    #[must_use]
    pub fn identity() -> Self {
        Self {
            seat: SeatPerm::IDENTITY,
            kinds: KindMap::identity(),
            wind_steps: 0,
            keeps_red_fives: true,
            flips_chi: false,
        }
    }

    /// Relabel one app tile code.
    pub fn map_code(&self, code: &str) -> Result<String, TransformError> {
        self.kinds.map_code(code)
    }

    /// Relabel a mutable list of app tile codes in place.
    pub fn map_codes(&self, codes: &mut [String]) -> Result<(), TransformError> {
        for code in codes {
            *code = self.map_code(code)?;
        }
        Ok(())
    }

    /// Relabel one Mortal action name.
    ///
    /// A red-five discard name cannot survive a red-five normalisation: the
    /// action means "discard the red copy", and that copy stops being red. The
    /// caller must reject the variant instead of guessing (`see
    /// [`super::Transform::check_applicable`]`).
    pub fn map_action_name(&self, action: &str) -> Result<String, TransformError> {
        if let Some(rest) = action.strip_prefix("Discard_") {
            let (code, red) = match rest.strip_suffix('r') {
                Some(base) => (base, true),
                None => (rest, false),
            };
            if red && !self.keeps_red_fives {
                return Err(TransformError::RedFiveAction {
                    action: action.to_string(),
                });
            }
            let mapped = self.map_code(code)?;
            return Ok(if red {
                format!("Discard_{mapped}r")
            } else {
                format!("Discard_{mapped}")
            });
        }

        if let Some(position) = ChiPosition::parse(action) {
            let position = if self.flips_chi {
                position.flip()
            } else {
                position
            };
            return Ok(position.name().to_string());
        }

        match action {
            "Riichi" | "Pon" | "Kan" | "Agari" | "Ryukyoku" | "Pass" => Ok(action.to_string()),
            other => Err(TransformError::UnknownAction {
                action: other.to_string(),
            }),
        }
    }

    /// Relabel every tile token in free text, leaving other words untouched.
    #[must_use]
    pub fn map_text(&self, text: &str) -> String {
        if self.kinds.is_identity() {
            return text.to_string();
        }
        let mut out = String::with_capacity(text.len());
        let mut token = String::new();
        for ch in text.chars() {
            if ch.is_ascii_alphanumeric() {
                token.push(ch);
                continue;
            }
            if !token.is_empty() {
                out.push_str(&map_token(&token, &self.kinds));
                token.clear();
            }
            out.push(ch);
        }
        if !token.is_empty() {
            out.push_str(&map_token(&token, &self.kinds));
        }
        out
    }

    /// Relabel a compact hand string (`123m456p789s11z`).
    ///
    /// The groups are parsed, relabelled and re-emitted in the canonical
    /// `m p s z` order with each group's ranks sorted, exactly as
    /// [`crate::generator::format_hand_compact`] writes them.
    pub fn map_hand_string(&self, value: &str) -> Result<String, TransformError> {
        if self.kinds.is_identity() {
            return Ok(value.to_string());
        }
        let mut groups: [Vec<u8>; 4] = Default::default();
        let mut pending: Vec<u8> = Vec::new();
        for ch in value.chars() {
            let group = match ch {
                'm' => 0,
                'p' => 1,
                's' => 2,
                'z' => 3,
                digit if digit.is_ascii_digit() => {
                    pending.push(digit as u8 - b'0');
                    continue;
                }
                _ => {
                    return Err(TransformError::InvalidHandString {
                        value: value.to_string(),
                    });
                }
            };
            if pending.is_empty() {
                return Err(TransformError::InvalidHandString {
                    value: value.to_string(),
                });
            }
            for digit in pending.drain(..) {
                let kind =
                    group_kind(group, digit).ok_or_else(|| TransformError::InvalidHandString {
                        value: value.to_string(),
                    })?;
                let mapped = self.kinds.kind(kind);
                let target = kind_group(mapped);
                groups[target].push(kind_rank(mapped));
            }
        }
        if !pending.is_empty() {
            return Err(TransformError::InvalidHandString {
                value: value.to_string(),
            });
        }

        let mut out = String::with_capacity(value.len());
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
        Ok(out)
    }

    /// Relabel one entry of the app's 34-kind indices (`ActionInfo::tile_index`).
    pub fn map_index(&self, index: usize) -> Result<usize, TransformError> {
        if index >= TILE_KINDS {
            return Err(TransformError::InvalidTileIndex { index });
        }
        Ok(self.kinds.kind(index))
    }

    /// Relabel a graded answer.
    pub fn map_correct_action(
        &self,
        action: &CorrectAction,
    ) -> Result<CorrectAction, TransformError> {
        Ok(match action {
            CorrectAction::Riichi { discard } => CorrectAction::Riichi {
                discard: self.map_code(discard)?,
            },
            CorrectAction::Dama { discard } => CorrectAction::Dama {
                discard: self.map_code(discard)?,
            },
            CorrectAction::Fold { discard } => CorrectAction::Fold {
                discard: self.map_code(discard)?,
            },
            CorrectAction::Kan { tile } => CorrectAction::Kan {
                tile: self.map_code(tile)?,
            },
            CorrectAction::Discard { tile } => CorrectAction::Discard {
                tile: self.map_code(tile)?,
            },
            CorrectAction::Pass => CorrectAction::Pass,
            CorrectAction::Best {
                action,
                tile,
                tiles,
                label,
            } => CorrectAction::Best {
                action: self.map_action_name(action)?,
                tile: tile
                    .as_deref()
                    .map(|tile| self.map_code(tile))
                    .transpose()?,
                tiles: tiles
                    .iter()
                    .map(|tile| self.map_code(tile))
                    .collect::<Result<Vec<_>, _>>()?,
                label: self.map_text(label),
            },
        })
    }

    /// Relabel one legal action (a legal-action list or a model ranking entry).
    pub fn map_action_info(&self, info: &ActionInfo) -> Result<ActionInfo, TransformError> {
        Ok(ActionInfo {
            action: self.map_action_name(&info.action)?,
            label: self.map_text(&info.label),
            kind: info.kind,
            tile_index: info
                .tile_index
                .map(|index| self.map_index(index))
                .transpose()?,
            tile: info
                .tile
                .as_deref()
                .map(|tile| self.map_code(tile))
                .transpose()?,
            tiles: info
                .tiles
                .iter()
                .map(|tile| self.map_code(tile))
                .collect::<Result<Vec<_>, _>>()?,
            kan_kind: info.kan_kind,
        })
    }
}

/// The three rank-relative chi names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChiPosition {
    Low,
    Mid,
    High,
}

impl ChiPosition {
    fn parse(action: &str) -> Option<Self> {
        match action {
            "Chi_Low" => Some(Self::Low),
            "Chi_Mid" => Some(Self::Mid),
            "Chi_High" => Some(Self::High),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Low => "Chi_Low",
            Self::Mid => "Chi_Mid",
            Self::High => "Chi_High",
        }
    }

    /// The name a rank mirror gives: low becomes high and high becomes low.
    fn flip(self) -> Self {
        match self {
            Self::Low => Self::High,
            Self::Mid => Self::Mid,
            Self::High => Self::Low,
        }
    }
}

/// Relabel one alphanumeric token when it names a tile.
fn map_token(token: &str, kinds: &KindMap) -> String {
    if let Some(index) = tile_index(token) {
        return tile_name(kinds.kind(index)).unwrap_or_else(|| token.to_string());
    }
    if let Some(index) = honor_display_index(token) {
        let mapped = tile_name(kinds.kind(index)).unwrap_or_default();
        return format_tile_for_display(&mapped, false);
    }
    if let Some(suit) = red_five_display_suit(token) {
        let mapped = kinds.kind(suit.base() + 4);
        let code = tile_name(mapped).unwrap_or_default();
        return format_tile_for_display(&code, mapped < 27);
    }
    token.to_string()
}

/// 34-kind index of the book's honour shorthand (`E`, `S`, `W`, `N`, `Wh`, `G`,
/// `R`).
fn honor_display_index(token: &str) -> Option<usize> {
    Some(
        FIRST_WIND
            + match token {
                "E" => 0,
                "S" => 1,
                "W" => 2,
                "N" => 3,
                "Wh" => 4,
                "G" => 5,
                "R" => 6,
                _ => return None,
            },
    )
}

/// The suit of a red-five display token (`R5m`).
fn red_five_display_suit(token: &str) -> Option<Suit> {
    let mut chars = token.strip_prefix("R5")?.chars();
    let suit = Suit::from_letter(chars.next()?)?;
    chars.next().is_none().then_some(suit)
}

/// 34-kind index of a digit inside a compact hand group.
fn group_kind(group: usize, digit: u8) -> Option<usize> {
    if group == 3 {
        return (1..=7)
            .contains(&digit)
            .then(|| FIRST_WIND + usize::from(digit) - 1);
    }
    let suit = Suit::ALL[group];
    (1..=9)
        .contains(&digit)
        .then(|| suit.base() + usize::from(digit) - 1)
}

/// Which compact hand group a kind belongs to (0..2 suits, 3 honours).
fn kind_group(kind: usize) -> usize {
    if kind < FIRST_WIND { kind / 9 } else { 3 }
}

/// The rank of a kind inside its group, as the digit the compact form prints.
fn kind_rank(kind: usize) -> u8 {
    if kind < FIRST_WIND {
        (kind % 9 + 1) as u8
    } else {
        (kind - FIRST_WIND + 1) as u8
    }
}

/// The kinds `ActionKind` keeps when a state is relabelled: the action family is
/// vocabulary, not tile identity, so a mapping copies it unchanged.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::miner::transform::tiles::SuitMap;

    fn suit_mapping() -> Mapping {
        Mapping {
            kinds: KindMap::suit(SuitMap::new(Suit::Pin, Suit::Sou, Suit::Man).expect("bijection")),
            ..Mapping::identity()
        }
    }

    fn mirror_mapping() -> Mapping {
        Mapping {
            kinds: KindMap::rank_mirror(),
            flips_chi: true,
            ..Mapping::identity()
        }
    }

    fn wind_mapping() -> Mapping {
        Mapping {
            kinds: KindMap::wind_rotation(1),
            wind_steps: 1,
            ..Mapping::identity()
        }
    }

    #[test]
    fn action_names_embed_the_relabelled_tile() {
        let map = suit_mapping();
        assert_eq!(map.map_action_name("Discard_3m").unwrap(), "Discard_3p");
        assert_eq!(map.map_action_name("Discard_5pr").unwrap(), "Discard_5sr");
        assert_eq!(map.map_action_name("Riichi").unwrap(), "Riichi");
        assert_eq!(map.map_action_name("Pass").unwrap(), "Pass");
        assert_eq!(map.map_action_name("Chi_Low").unwrap(), "Chi_Low");
        assert!(map.map_action_name("Teleport").is_err());
    }

    #[test]
    fn a_rank_mirror_swaps_the_chi_endpoints() {
        let map = mirror_mapping();
        assert_eq!(map.map_action_name("Chi_Low").unwrap(), "Chi_High");
        assert_eq!(map.map_action_name("Chi_High").unwrap(), "Chi_Low");
        assert_eq!(map.map_action_name("Chi_Mid").unwrap(), "Chi_Mid");
    }

    #[test]
    fn normalising_red_fives_refuses_a_red_discard_name() {
        let map = Mapping {
            keeps_red_fives: false,
            ..Mapping::identity()
        };
        assert!(matches!(
            map.map_action_name("Discard_5mr"),
            Err(TransformError::RedFiveAction { .. })
        ));
        assert_eq!(map.map_action_name("Discard_5m").unwrap(), "Discard_5m");
    }

    #[test]
    fn text_tokens_are_relabelled_and_words_are_not() {
        let map = suit_mapping();
        assert_eq!(map.map_text("Discard 3m"), "Discard 3p");
        assert_eq!(map.map_text("Chi 4m 5m on 6m"), "Chi 4p 5p on 6p");
        assert_eq!(map.map_text("Pon Wh"), "Pon Wh");
        assert_eq!(
            map.map_text("Red R5m, honour 5z, word man"),
            "Red R5p, honour 5z, word man"
        );

        let wind = wind_mapping();
        assert_eq!(
            wind.map_text("Wh is a dragon; E is a wind"),
            "Wh is a dragon; S is a wind"
        );
        assert_eq!(wind.map_text("code 2z and 5z"), "code 3z and 5z");
    }

    #[test]
    fn hand_strings_are_rebuilt_canonically() {
        let mirror = mirror_mapping();
        assert_eq!(mirror.map_hand_string("123m789p").unwrap(), "789m123p");
        assert_eq!(mirror.map_hand_string("11122m").unwrap(), "88999m");
        assert_eq!(mirror.map_hand_string("112z").unwrap(), "112z");

        let suits = suit_mapping();
        assert_eq!(suits.map_hand_string("123m456p").unwrap(), "123p456s");
        assert_eq!(suits.map_hand_string("12z").unwrap(), "12z");

        let wind = wind_mapping();
        assert_eq!(wind.map_hand_string("123z55z").unwrap(), "23455z");

        assert_eq!(mirror.map_hand_string("").unwrap(), "");
        for bad in ["123", "m123", "0m", "123x", "123m4"] {
            assert!(
                mirror.map_hand_string(bad).is_err(),
                "`{bad}` must be rejected"
            );
        }
    }

    #[test]
    fn answers_keep_their_shape() {
        let map = suit_mapping();
        let answer = CorrectAction::Dama {
            discard: "3m".to_string(),
        };
        assert_eq!(
            map.map_correct_action(&answer).unwrap(),
            CorrectAction::Dama {
                discard: "3p".to_string()
            }
        );

        let best = CorrectAction::best(
            "Discard_3m",
            Some("3m".into()),
            vec!["3m".into()],
            "Discard 3m",
        );
        let mapped = map.map_correct_action(&best).unwrap();
        assert_eq!(mapped.tile(), Some("3p"));
        assert_eq!(mapped.action_type(), crate::state::CorrectActionType::Best);
    }

    #[test]
    fn an_identity_mapping_leaves_text_and_hand_strings_alone() {
        let map = Mapping::identity();
        assert_eq!(map.map_text("Discard 3m"), "Discard 3m");
        assert_eq!(map.map_hand_string("123m").unwrap(), "123m");
        assert_eq!(map.map_action_name("Discard_5mr").unwrap(), "Discard_5mr");
    }
}
