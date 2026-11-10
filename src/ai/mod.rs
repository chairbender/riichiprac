//! Client-side Mortal AI: Candle inference and (later) the observation encoder.

pub mod model;

#[cfg(test)]
mod model_test;

pub use model::{
    ACTION_SPACE, CONV_CHANNELS, FEATURE_DIM, INPUT_CHANNELS, MortalV4Model, NUM_BLOCKS,
    POLICY_OUTPUTS, TILE_FEATURES, mish,
};
