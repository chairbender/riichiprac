//! Golden-oracle comparison against libriichi's `encode_obs(4, false)`.
//!
//! `testdata/sp_oracle.json` was produced by a throwaway test in the Mortal
//! checkout at commit `0cff2b5`: it replays fixed mjai logs from
//! `libriichi/src/state/test.rs`, serializes the corresponding player state in
//! our `GameState` shape, and records the full 1012x34 observation.

use serde_json::Value;

use crate::state::GameState;

use super::encoder::{OBS_CHANNELS, TILE_KINDS, encode_v4_observation};

fn load_cases() -> Vec<Value> {
    let text = include_str!("../../testdata/sp_oracle.json");
    let value: Value = serde_json::from_str(text).expect("oracle JSON must parse");
    value["cases"].as_array().expect("cases array").to_vec()
}

#[test]
fn matches_libriichi_v4_observation() {
    let cases = load_cases();
    assert!(cases.len() >= 3, "expected at least three oracle positions");

    for case in cases {
        let name = case["name"].as_str().unwrap_or("unnamed");
        let state: GameState = serde_json::from_value(case.clone())
            .unwrap_or_else(|err| panic!("{name}: state must decode: {err}"));
        let expected: Vec<Vec<f32>> = case["obs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                row.as_array()
                    .unwrap()
                    .iter()
                    .map(|value| value.as_f64().unwrap() as f32)
                    .collect()
            })
            .collect();
        assert_eq!(expected.len(), OBS_CHANNELS);
        assert_eq!(expected[0].len(), TILE_KINDS);

        let actual = encode_v4_observation(&state);
        assert_eq!(actual.len(), OBS_CHANNELS * TILE_KINDS);

        for row in 0..OBS_CHANNELS {
            for column in 0..TILE_KINDS {
                let got = actual[row * TILE_KINDS + column];
                let want = expected[row][column];
                if row >= 889 {
                    assert!(
                        (got - want).abs() <= 1e-4,
                        "{name}: row {row} col {column}: got {got}, want {want}"
                    );
                } else {
                    assert!(
                        (got - want).abs() <= 1e-6,
                        "{name}: row {row} col {column}: got {got}, want {want}"
                    );
                }
            }
        }
    }
}
