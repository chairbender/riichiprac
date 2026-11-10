use crate::state::GameState;

/// Runs a rejection-sampling loop and reports the last failure if it gives up.
pub fn generate_with_retries<F>(
    label: &str,
    max_attempts: usize,
    mut build: F,
) -> Result<GameState, String>
where
    F: FnMut() -> Result<GameState, String>,
{
    let mut last_error = String::new();

    for _ in 0..max_attempts {
        match build() {
            Ok(state) => return Ok(state),
            Err(err) => last_error = err,
        }
    }

    Err(format!(
        "Failed to satisfy {label} scenario constraints after {max_attempts} attempts: {last_error}"
    ))
}
