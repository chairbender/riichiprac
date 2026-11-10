//! Client-side Mortal AI: Candle inference and (later) the observation encoder.

pub mod encoder;
pub mod wasm_bridge;

#[cfg(test)]
mod encoder_test;
pub mod model;

#[cfg(test)]
mod model_test;

pub use encoder::{OBS_CHANNELS, OBS_LEN, encode_v4_observation, tile_index, tile_name};
pub use model::{
    ACTION_SPACE, CONV_CHANNELS, FEATURE_DIM, INPUT_CHANNELS, MortalV4Model, NUM_BLOCKS,
    POLICY_OUTPUTS, TILE_FEATURES, mish,
};
pub use wasm_bridge::WasmMortalEvaluator;
