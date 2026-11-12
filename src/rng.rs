//! WebAssembly-compatible Random Number Generation (RNG) abstraction.
//!
//! In WebAssembly environments (`target_arch = "wasm32"`), this uses `js_sys::Math::random()`.
//! For native environments (e.g. `cargo test`), it falls back to a thread-local PRNG
//! seeded from the clock. Native callers can reseed that PRNG with [`seed`] to
//! replay a generation run (a `wasm32` build has no such hook: the browser's
//! entropy cannot be reseeded).

#[cfg(target_arch = "wasm32")]
pub fn random_f64() -> f64 {
    js_sys::Math::random()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn random_f64() -> f64 {
    (next_native_state() as f64) / (u64::MAX as f64)
}

#[cfg(not(target_arch = "wasm32"))]
const FALLBACK_SEED: u64 = 0x853c49e6748fea9b;

#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    /// Zero means "not seeded yet"; the first draw replaces it with the clock.
    static NATIVE_STATE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Reseeds the native generation PRNG, so a run can be replayed exactly.
///
/// Generation is unseeded in production by design: the browser build gets fresh
/// entropy from `Math.random`. Tests and offline tools that need to reproduce a
/// draw call this first. Reseeding affects only the calling thread, which is
/// what the Rust test harness needs (one thread per test).
///
/// Not available on `wasm32`, where the entropy source is the host's
/// `Math.random`.
#[cfg(not(target_arch = "wasm32"))]
pub fn seed(value: u64) {
    NATIVE_STATE.with(|state| state.set(if value == 0 { FALLBACK_SEED } else { value }));
}

#[cfg(not(target_arch = "wasm32"))]
fn next_native_state() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    NATIVE_STATE.with(|state| {
        let mut x = state.get();
        if x == 0 {
            x = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(FALLBACK_SEED);
            if x == 0 {
                x = FALLBACK_SEED;
            }
        }

        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        if x == 0 {
            x = FALLBACK_SEED;
        }
        state.set(x);
        x
    })
}

/// Returns a random integer in the range `[start, end)`.
/// If `start >= end`, returns `start`.
pub fn gen_range(start: usize, end: usize) -> usize {
    if start >= end {
        return start;
    }
    let span = (end - start) as f64;
    let r = random_f64();
    start + ((r * span).floor() as usize).min(end - 1)
}

/// Returns true with probability `p` (where `0.0 <= p <= 1.0`).
pub fn gen_bool(p: f64) -> bool {
    random_f64() < p
}

/// Shuffles a slice in-place using the Fisher-Yates algorithm.
pub fn shuffle<T>(slice: &mut [T]) {
    for i in (1..slice.len()).rev() {
        let j = gen_range(0, i + 1);
        slice.swap(i, j);
    }
}

/// Pick a random element from a slice.
pub fn choose<T: Clone>(slice: &[T]) -> Option<T> {
    if slice.is_empty() {
        None
    } else {
        Some(slice[gen_range(0, slice.len())].clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_random_range() {
        for _ in 0..100 {
            let val = gen_range(5, 10);
            assert!((5..10).contains(&val));
        }
    }

    #[test]
    fn test_shuffle() {
        let mut items = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        let original = items.clone();
        shuffle(&mut items);
        assert_eq!(items.len(), original.len());
    }
}
