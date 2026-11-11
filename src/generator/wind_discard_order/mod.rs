//! `wind_discard_order`: which valueless wind to throw on the first turn.
//!
//! Riichi Book 1, ch. 9, "Be mindful of the seating" (Seating-related tip 2):
//!
//! > When discarding valueless wind tiles, discard the right player's wind
//! > first, then the facing player's wind next.
//!
//! The same section gives the reason. A Pon (or Kan) by the right player
//! (shimocha) skips the facing player's turn and hands the right player an
//! extra draw, so the right player is the one whose call is most worth denying.
//! Throwing their wind early does that: it is unlikely to be called at once,
//! and other players discarding the same wind makes it harder for the shimocha
//! to pair it later. The facing player's wind is the next-best discard; the
//! left player's wind comes last.
//!
//! The answer is pure seat arithmetic: the shimocha is always seat 1, so the
//! correct discard is seat 0's wind advanced one seat. The generator shapes a
//! first-turn board around that fact and rejects any hand that muddies it (a
//! round or seat wind, a dragon, a ready hand, or a dora on a held wind), so the
//! seat order is the only thing that decides.

mod board;

use crate::generator::support::retry::generate_with_retries;
use crate::state::GameState;

/// Generates a first-turn board whose answer is the right player's wind.
pub fn generate(category: &str) -> Result<GameState, String> {
    generate_with_retries("wind_discard_order", 500, || board::build(category))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::generator::support::state_validation::validate_reachable_state;
    use crate::state::{CorrectActionType, TargetAction};

    fn wind_code(wind: crate::state::Wind) -> &'static str {
        match wind {
            crate::state::Wind::East => "1z",
            crate::state::Wind::South => "2z",
            crate::state::Wind::West => "3z",
            crate::state::Wind::North => "4z",
        }
    }

    #[test]
    fn answer_is_always_the_right_players_wind() {
        for run in 0..100 {
            let state = generate("wind_discard_order")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.target_action, TargetAction::NaniKiru);
            assert_eq!(state.correct_action.action_type(), CorrectActionType::Dama);
            assert!(state.equivalent_tiles.is_empty());

            let shimocha = state.players.iter().find(|player| player.seat == 1);
            let shimocha = shimocha.expect("the right player is seat 1");
            assert_eq!(
                state.correct_action.tile(),
                Some(wind_code(shimocha.wind)),
                "run {run}: the discard must be the shimocha's wind",
            );
        }
    }

    #[test]
    fn hand_holds_two_or_three_valueless_winds_and_nothing_else() {
        let mut saw_two = false;
        let mut saw_three = false;

        for run in 0..150 {
            let state = generate("wind_discard_order")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            let human_wind = state.players[0].wind;
            let held_winds: Vec<&str> = state
                .tiles
                .iter()
                .map(String::as_str)
                .filter(|code| {
                    code.ends_with('z') && *code != "5z" && *code != "6z" && *code != "7z"
                })
                .collect();

            assert!(
                (2..=3).contains(&held_winds.len()),
                "run {run}: {} winds in hand ({held_winds:?})",
                held_winds.len()
            );
            if held_winds.len() == 2 {
                saw_two = true;
            } else {
                saw_three = true;
            }

            // Every held wind is valueless: not the seat wind, not the round wind.
            for wind in crate::state::Wind::ALL {
                let code = wind_code(wind);
                if wind == human_wind || wind == state.round_wind {
                    assert!(
                        !held_winds.contains(&code),
                        "run {run}: the hand holds value wind {code}"
                    );
                }
            }

            // No dragon ever sneaks into the filler.
            for code in &state.tiles {
                assert!(
                    !matches!(code.as_str(), "5z" | "6z" | "7z"),
                    "run {run}: the hand holds dragon {code}"
                );
            }
        }

        assert!(saw_two, "two-wind hands must be generated");
        assert!(saw_three, "three-wind hands must be generated");
    }

    #[test]
    fn board_is_the_players_first_turn() {
        for run in 0..100 {
            let state = generate("wind_discard_order")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));

            assert_eq!(state.hand_number, 1, "run {run}");
            assert_eq!(state.current_turn, 0, "run {run}");
            assert!(state.players[0].discards.is_empty(), "run {run}");
            assert!(state.players[0].hand.len() == 13, "run {run}");
            assert!(state.players[0].draw.is_some(), "run {run}");

            for player in &state.players {
                assert!(player.melds.is_empty(), "run {run}: seat {}", player.seat);
                assert!(!player.is_riichi, "run {run}: seat {}", player.seat);
                assert!(
                    player.discards.len() <= 1,
                    "run {run}: seat {} has {} discards on the first go-around",
                    player.seat,
                    player.discards.len()
                );
            }

            // The dora indicator is never a wind, so every wind stays valueless.
            for indicator in &state.dora_indicators {
                assert!(
                    !indicator.ends_with('z'),
                    "run {run}: wind dora {indicator}"
                );
            }

            validate_reachable_state(&state)
                .unwrap_or_else(|err| panic!("run {run}: unreachable table: {err}"));
        }
    }

    #[test]
    fn the_hand_is_not_ready() {
        for run in 0..50 {
            let state = generate("wind_discard_order")
                .unwrap_or_else(|err| panic!("run {run} failed: {err}"));
            assert!(state.shanten >= 1, "run {run}: shanten {}", state.shanten);
            assert!(!state.is_agari, "run {run}");
        }
    }
}
