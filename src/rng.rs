//! WebAssembly-compatible Random Number Generation (RNG) abstraction.
//!
//! In WebAssembly environments (`target_arch = "wasm32"`), this uses `js_sys::Math::random()`.
//! For native environments (e.g. `cargo test`), it falls back to a thread-local PRNG.

#[cfg(target_arch = "wasm32")]
pub fn random_f64() -> f64 {
    js_sys::Math::random()
}

#[cfg(not(target_arch = "wasm32"))]
pub fn random_f64() -> f64 {
    use std::cell::Cell;
    use std::time::{SystemTime, UNIX_EPOCH};

    thread_local! {
        static STATE: Cell<u64> = Cell::new({
            let seed = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0x853c49e6748fea9b);
            if seed == 0 { 0x853c49e6748fea9b } else { seed }
        });
    }

    STATE.with(|s| {
        let mut x = s.get();
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        s.set(x);
        (x as f64) / (u64::MAX as f64)
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
