//! Mortal v4 policy/value network in pure Candle.
//!
//! This mirrors `Equim-chan/Mortal`'s `mortal/model.py` (version 4) exactly:
//!
//! ```text
//! obs (N, 1012, 34)
//!   -> Conv1d(1012, 192, k=3, pad=1, bias=False)
//!   -> 40 x PreActResBlock(192, BN eps=1e-3, Mish, channel attention)
//!   -> BatchNorm(192) -> Mish
//!   -> Conv1d(192, 32, k=3, pad=1) -> Mish -> Flatten(1088)
//!   -> Linear(1088, 1024) -> Mish            # 1024-d features
//!   -> Linear(1024, 47)                      # 1 value + 46 action logits
//! ```
//!
//! The parameter names follow the flattened Safetensors keys produced by
//! `scripts/convert_weights.py` (`scripts/weight_keys.txt` is the map):
//!
//! | Module | Prefix |
//! | --- | --- |
//! | stem / blocks / encoder head | `mortal.encoder.net.<index>.*` |
//! | policy DQN head | `current_dqn.net.*` |
//!
//! `net.<index>` indexes PyTorch's `nn.Sequential`; the indices for the encoder
//! head are derived from [`NUM_BLOCKS`] rather than hard-coded.

use candle_core::{D, DType, Module, Result, Tensor};
use candle_nn::{
    BatchNorm, BatchNormConfig, Conv1d, Conv1dConfig, Linear, ModuleT, VarBuilder, batch_norm,
    conv1d, conv1d_no_bias, linear, ops,
};

/// Mortal v4 observation channels (see `libriichi::consts::obs_shape(4)`).
pub const INPUT_CHANNELS: usize = 1012;
/// Tile kinds: 1m-9m, 1p-9p, 1s-9s, E, S, W, N, haku, hatsu, chun.
pub const TILE_FEATURES: usize = 34;
/// Width of the residual backbone.
pub const CONV_CHANNELS: usize = 192;
/// Pre-activation residual blocks in the backbone.
pub const NUM_BLOCKS: usize = 40;
/// Channel-attention bottleneck width: 192 / 16 = 12.
pub const ATTENTION_REDUCTION: usize = 16;
/// Width of the convolutional projection before the linear head.
pub const HEAD_CONV_CHANNELS: usize = 32;
/// Feature width handed to the policy head.
pub const FEATURE_DIM: usize = 1024;
/// Legal actions: 34 discards + 3 chi + pon + kan + riichi + agari + ryukyoku + pass.
pub const ACTION_SPACE: usize = 46;
/// Index 0 is the expected-value output, 1..47 are action logits.
pub const POLICY_OUTPUTS: usize = 1 + ACTION_SPACE;

/// BatchNorm hyper-parameters used by Mortal v4 (`momentum` only matters in training).
const BN_EPS: f64 = 1e-3;
const BN_MOMENTUM: f64 = 0.01;

/// Mish activation: `x * tanh(softplus(x))`.
///
/// `softplus` is evaluated as `max(x, 0) + ln(1 + exp(-|x|))` so that large
/// positive inputs cannot overflow `exp`, matching PyTorch's numerically stable
/// implementation.
pub fn mish(xs: &Tensor) -> Result<Tensor> {
    let zeros = xs.zeros_like()?;
    let shifted = (xs.abs()?.neg()?.exp()? + 1.0)?;
    let softplus = (xs.maximum(&zeros)? + shifted.log()?)?;
    xs.mul(&softplus.tanh()?)
}

/// BatchNorm1d with Mortal's eps, bound to `vb` (`weight`, `bias`, `running_mean`, `running_var`).
fn batch_norm_1d(channels: usize, vb: VarBuilder) -> Result<BatchNorm> {
    batch_norm(
        channels,
        BatchNormConfig {
            eps: BN_EPS,
            momentum: BN_MOMENTUM,
            remove_mean: true,
            affine: true,
        },
        vb,
    )
}

/// Squeeze-and-excitation channel attention over the 34 tile positions.
///
/// PyTorch computes `sigmoid(mlp(mean(x)) + mlp(amax(x)))` with a shared MLP,
/// then reweights every channel.
struct ChannelAttention {
    fc1: Linear,
    fc2: Linear,
}

impl ChannelAttention {
    fn new(channels: usize, reduction: usize, vb: VarBuilder) -> Result<Self> {
        let hidden = channels / reduction;
        let shared_mlp = vb.pp("shared_mlp");
        Ok(Self {
            fc1: linear(channels, hidden, shared_mlp.pp("0"))?,
            fc2: linear(hidden, channels, shared_mlp.pp("2"))?,
        })
    }

    fn forward(&self, xs: &Tensor) -> Result<Tensor> {
        let avg = xs.mean(D::Minus1)?;
        let max = xs.max(D::Minus1)?;
        let avg = self.fc2.forward(&mish(&self.fc1.forward(&avg)?)?)?;
        let max = self.fc2.forward(&mish(&self.fc1.forward(&max)?)?)?;
        let weight = ops::sigmoid(&(avg + max)?)?.unsqueeze(D::Minus1)?;
        xs.broadcast_mul(&weight)
    }
}

/// Pre-activation residual block:
/// `BN -> Mish -> Conv -> BN -> Mish -> Conv -> ChannelAttention -> + identity`.
struct PreActResBlock {
    norm1: BatchNorm,
    conv1: Conv1d,
    norm2: BatchNorm,
    conv2: Conv1d,
    ca: ChannelAttention,
}

impl PreActResBlock {
    fn new(channels: usize, vb: VarBuilder) -> Result<Self> {
        let res_unit = vb.pp("res_unit");
        // Shaped convolutions: kernel 3, padding 1, no bias.
        let conv_cfg = Conv1dConfig {
            padding: 1,
            ..Default::default()
        };
        Ok(Self {
            norm1: batch_norm_1d(channels, res_unit.pp("0"))?,
            conv1: conv1d_no_bias(channels, channels, 3, conv_cfg, res_unit.pp("2"))?,
            norm2: batch_norm_1d(channels, res_unit.pp("3"))?,
            conv2: conv1d_no_bias(channels, channels, 3, conv_cfg, res_unit.pp("5"))?,
            ca: ChannelAttention::new(channels, ATTENTION_REDUCTION, vb.pp("ca"))?,
        })
    }

    fn forward(&self, xs: &Tensor) -> Result<Tensor> {
        let out = self.norm1.forward_t(xs, false)?;
        let out = mish(&out)?;
        let out = self.conv1.forward(&out)?;
        let out = self.norm2.forward_t(&out, false)?;
        let out = mish(&out)?;
        let out = self.conv2.forward(&out)?;
        let out = self.ca.forward(&out)?;
        out + xs
    }
}

/// The full Mortal v4 network: observation encoder plus DQN policy/value head.
pub struct MortalV4Model {
    stem: Conv1d,
    blocks: Vec<PreActResBlock>,
    final_norm: BatchNorm,
    head_conv: Conv1d,
    head_fc: Linear,
    policy: Linear,
}

impl MortalV4Model {
    /// Bind every weight from `vb`.
    ///
    /// `vb` is the root of the Safetensors file: the encoder is read from
    /// `mortal.encoder.net.*` and the policy head from `current_dqn.net.*`.
    pub fn new(vb: VarBuilder) -> Result<Self> {
        let encoder = vb.pp("mortal").pp("encoder").pp("net");
        let conv_cfg = Conv1dConfig {
            padding: 1,
            ..Default::default()
        };

        let stem = conv1d_no_bias(INPUT_CHANNELS, CONV_CHANNELS, 3, conv_cfg, encoder.pp("0"))?;

        let mut blocks = Vec::with_capacity(NUM_BLOCKS);
        for index in 0..NUM_BLOCKS {
            blocks.push(PreActResBlock::new(CONV_CHANNELS, encoder.pp(index + 1))?);
        }

        // Encoding of PyTorch's nn.Sequential tail (see module docs):
        // blocks occupy 1..=NUM_BLOCKS, then BN, activation, conv, activation,
        // flatten and finally the linear layer.
        let final_norm = batch_norm_1d(CONV_CHANNELS, encoder.pp(NUM_BLOCKS + 1))?;
        let head_conv = conv1d(
            CONV_CHANNELS,
            HEAD_CONV_CHANNELS,
            3,
            conv_cfg,
            encoder.pp(NUM_BLOCKS + 3),
        )?;
        let head_fc = linear(
            HEAD_CONV_CHANNELS * TILE_FEATURES,
            FEATURE_DIM,
            encoder.pp(NUM_BLOCKS + 6),
        )?;

        let policy = linear(FEATURE_DIM, POLICY_OUTPUTS, vb.pp("current_dqn").pp("net"))?;

        Ok(Self {
            stem,
            blocks,
            final_norm,
            head_conv,
            head_fc,
            policy,
        })
    }

    /// Run inference on an observation batch of shape `(N, 1012, 34)`.
    ///
    /// Returns `(N, 47)`: row element 0 is the expected value, 1..47 are the
    /// action logits.
    pub fn forward(&self, xs: &Tensor) -> Result<Tensor> {
        let (_, channels, features) = xs.dims3()?;
        if channels != INPUT_CHANNELS || features != TILE_FEATURES {
            candle_core::bail!(
                "Mortal v4 expects observations of shape (N, {INPUT_CHANNELS}, {TILE_FEATURES}), got {:?}",
                xs.shape()
            );
        }
        if xs.dtype() != DType::F32 {
            candle_core::bail!("Mortal v4 expects f32 observations, got {:?}", xs.dtype());
        }

        let mut out = self.stem.forward(xs)?;
        for block in &self.blocks {
            out = block.forward(&out)?;
        }

        let out = self.final_norm.forward_t(&out, false)?;
        let out = mish(&out)?;
        let out = self.head_conv.forward(&out)?;
        let out = mish(&out)?;
        let out = out.flatten_from(1)?;
        let out = self.head_fc.forward(&out)?;
        let out = mish(&out)?;
        self.policy.forward(&out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use candle_core::Device;

    #[test]
    fn mish_matches_the_reference_formula() {
        let device = Device::Cpu;
        let xs = Tensor::new(&[-20.0f32, -3.0, -0.5, 0.0, 0.5, 3.0, 20.0], &device).unwrap();
        let got = mish(&xs).unwrap().to_vec1::<f32>().unwrap();
        let expected: Vec<f32> = xs
            .to_vec1::<f32>()
            .unwrap()
            .into_iter()
            .map(|x| {
                let softplus = if x > 20.0 { x } else { x.exp().ln_1p() };
                x * softplus.tanh()
            })
            .collect();
        for (got, expected) in got.iter().zip(&expected) {
            assert!((got - expected).abs() < 1e-6, "{got} != {expected}");
        }
    }
}
