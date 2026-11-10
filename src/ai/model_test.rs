//! Tests for the Candle Mortal v4 port.
//!
//! The shape test runs on every target (including wasm32) with all-zero weights.
//! The parity test compares against a PyTorch forward pass recorded by
//! `scripts/mortal_reference.py`; it needs the converted checkpoint and is
//! therefore skipped on wasm and when the weights are absent.

use super::{INPUT_CHANNELS, MortalV4Model, POLICY_OUTPUTS, TILE_FEATURES};
use candle_core::{DType, Device, Tensor};
use candle_nn::VarBuilder;

/// Seed and constants of the deterministic observation generator shared with
/// `scripts/mortal_reference.py`.
const LCG_SEED: u32 = 0x1234_ABCD;
const LCG_MULTIPLIER: u32 = 1_664_525;
const LCG_INCREMENT: u32 = 1_013_904_223;

fn lcg_observation(batch: usize, device: &Device) -> Tensor {
    let mut state = LCG_SEED;
    let mut values = Vec::with_capacity(batch * INPUT_CHANNELS * TILE_FEATURES);
    for _ in 0..batch * INPUT_CHANNELS * TILE_FEATURES {
        state = state
            .wrapping_mul(LCG_MULTIPLIER)
            .wrapping_add(LCG_INCREMENT);
        // Exact in f32: (state >> 8) has at most 24 significant bits and the
        // divisor is a power of two.
        values.push((state >> 8) as f32 / 8_388_608.0 - 1.0);
    }
    Tensor::from_vec(values, (batch, INPUT_CHANNELS, TILE_FEATURES), device).unwrap()
}

#[test]
fn zero_weights_forward_produces_value_and_46_logits() {
    let device = Device::Cpu;
    let vb = VarBuilder::zeros(DType::F32, &device);
    let model = MortalV4Model::new(vb).expect("zero-weight model must bind");

    let xs = lcg_observation(1, &device);
    let out = model.forward(&xs).expect("forward pass must succeed");

    assert_eq!(out.dims(), &[1, POLICY_OUTPUTS]);
    // BatchNorm with zero affine weights yields zeros everywhere, so the
    // logits are finite (never NaN/Inf) even with degenerate weights.
    let values = out.flatten_all().unwrap().to_vec1::<f32>().unwrap();
    assert!(
        values.iter().all(|value| value.is_finite()),
        "degenerate weights must not produce NaN/Inf: {values:?}"
    );
}

#[test]
fn rejects_malformed_observations() {
    let device = Device::Cpu;
    let vb = VarBuilder::zeros(DType::F32, &device);
    let model = MortalV4Model::new(vb).unwrap();

    let wrong_channels = Tensor::zeros((1, 68, TILE_FEATURES), DType::F32, &device).unwrap();
    assert!(model.forward(&wrong_channels).is_err());

    let wrong_features = Tensor::zeros((1, INPUT_CHANNELS, 34 + 1), DType::F32, &device).unwrap();
    assert!(model.forward(&wrong_features).is_err());
}

/// Full parity check against the reference PyTorch forward pass.
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn real_checkpoint_matches_pytorch_reference() {
    const WEIGHTS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/frontend/public/models/mortal_298k.safetensors"
    );
    const FIXTURE: &str = include_str!("../../tests/fixtures/mortal_v4_parity.json");

    if !std::path::Path::new(WEIGHTS).exists() {
        eprintln!("skipping parity test: {WEIGHTS} is missing (run scripts/convert_weights.py)");
        return;
    }

    let fixture: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture must be JSON");
    let expected: Vec<f32> = fixture["outputs"]
        .as_array()
        .expect("fixture outputs must be an array")
        .iter()
        .map(|value| value.as_f64().expect("output must be a number") as f32)
        .collect();
    let tolerance = fixture["tolerance"]
        .as_f64()
        .expect("tolerance must be a number") as f32;
    assert_eq!(
        fixture["seed"].as_u64().unwrap() as u32,
        LCG_SEED,
        "fixture was generated with a different observation seed"
    );
    assert_eq!(expected.len(), POLICY_OUTPUTS);

    let device = Device::Cpu;
    let weights = std::fs::read(WEIGHTS).expect("checkpoint must be readable");
    let vb = VarBuilder::from_buffered_safetensors(weights, DType::F32, &device)
        .expect("checkpoint must parse");
    // Binding itself validates every parameter name and shape against the file.
    let model = MortalV4Model::new(vb).expect("all checkpoint weights must bind");

    let xs = lcg_observation(1, &device);
    let out = model.forward(&xs).expect("forward pass must succeed");
    assert_eq!(out.dims(), &[1, POLICY_OUTPUTS]);
    let got = out.flatten_all().unwrap().to_vec1::<f32>().unwrap();

    let mut worst = 0.0f32;
    for (index, (got, expected)) in got.iter().zip(&expected).enumerate() {
        let diff = (got - expected).abs();
        worst = worst.max(diff);
        assert!(
            diff <= tolerance,
            "output[{index}] = {got} differs from PyTorch {expected} by {diff} (> {tolerance})"
        );
    }
    println!("max abs diff vs PyTorch: {worst:e}");
}

/// End-to-end smoke test: real puzzle -> v4 observation -> checkpoint -> logits.
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn generated_puzzle_observations_run_through_the_checkpoint() {
    const WEIGHTS: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/frontend/public/models/mortal_298k.safetensors"
    );

    if !std::path::Path::new(WEIGHTS).exists() {
        eprintln!("skipping end-to-end test: {WEIGHTS} is missing");
        return;
    }

    let device = Device::Cpu;
    let vb = VarBuilder::from_buffered_safetensors(
        std::fs::read(WEIGHTS).expect("checkpoint must be readable"),
        DType::F32,
        &device,
    )
    .expect("checkpoint must parse");
    let model = MortalV4Model::new(vb).expect("checkpoint must bind");

    let json = crate::generate_puzzle("basic_test".to_string());
    let state: crate::state::GameState =
        serde_json::from_str(&json).expect("puzzle JSON must decode");
    let observation = crate::ai::encode_v4_observation(&state);

    let xs = Tensor::from_vec(observation, (1, INPUT_CHANNELS, TILE_FEATURES), &device)
        .expect("observation must form a tensor");
    let out = model.forward(&xs).expect("forward pass must succeed");
    assert_eq!(out.dims(), &[1, POLICY_OUTPUTS]);

    let values = out.flatten_all().unwrap().to_vec1::<f32>().unwrap();
    assert!(values.iter().all(|value| value.is_finite()));
    // A live checkpoint must distinguish at least some actions.
    let logits = &values[1..];
    assert!(
        logits
            .windows(2)
            .any(|pair| (pair[0] - pair[1]).abs() > 1e-6),
        "policy logits are all identical: {logits:?}"
    );
}
