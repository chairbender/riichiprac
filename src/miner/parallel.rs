//! Worker-pool, progress and shared-connection helpers for the offline miner
//! stages (Q2p).
//!
//! Offline, non-interactive stages are CPU-bound batch work and must use the
//! whole machine by default (`AGENTS.md` §5b, `replay-implementation-plan.md`
//! §7.1). Every parallel stage follows the same contract:
//!
//! - `--workers 0` resolves to [`std::thread::available_parallelism`] and
//!   `--workers 1` is the bounded mode for tests, fixtures and debugging;
//! - the unit of work is one replay file or one base scenario, and the per-unit
//!   results are merged in the **serial order** (file order, base order), so the
//!   report, the queue and the rows a run writes do not depend on the worker
//!   count;
//! - `--progress` prints a phase header plus one line per tenth of the shard, so
//!   "how far along is it?" is measured instead of guessed;
//! - the run report records the resolved worker count and the wall time.
//!
//! SQLite keeps a single writer, so the shared stage connection lives behind a
//! [`SharedDb`] mutex. Only the short statement work happens inside the lock;
//! the CPU-heavy part of a stage (a model forward pass, a replay walk) runs
//! outside it.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use rayon::ThreadPool;
use rusqlite::Connection;

/// Resolve a requested worker count: `0` means every available core.
#[must_use]
pub fn resolve_workers(requested: usize) -> usize {
    if requested == 0 {
        std::thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
    } else {
        requested
    }
}

/// Build the worker pool for one stage.
///
/// The error is a message only, so a stage can wrap it in its own error type.
pub fn worker_pool(workers: usize) -> Result<ThreadPool, String> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(workers)
        .build()
        .map_err(|err| format!("cannot start the worker pool: {err}"))
}

/// A miner-database connection shared by the workers of one stage.
///
/// `rusqlite::Connection` is `Send` but not `Sync`, and SQLite allows one
/// writer. A parallel stage therefore keeps its single connection behind this
/// mutex: a worker does the short statement work inside [`SharedDb::with`] and
/// everything expensive outside it.
pub struct SharedDb {
    connection: Mutex<Connection>,
}

impl SharedDb {
    /// Wrap an open, migrated miner database connection.
    #[must_use]
    pub fn new(connection: Connection) -> Self {
        Self {
            connection: Mutex::new(connection),
        }
    }

    /// Run `work` with exclusive use of the connection.
    ///
    /// A panic in another worker while it held the lock is surfaced as an
    /// ordinary poisoned guard rather than a second panic: the connection is
    /// still usable (`SQLite` recovers from a statement that was never
    /// committed).
    pub fn with<R>(&self, work: impl FnOnce(&Connection) -> R) -> R {
        let guard: MutexGuard<'_, Connection> = self
            .connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        work(&guard)
    }
}

/// Measured progress for one phase of a stage.
///
/// `enabled` mirrors `--progress`: with it off, nothing is printed and the
/// counters stay silent. With it on, the stage prints a header naming the unit
/// count and the worker count, then one line per tenth of the shard, then the
/// final count.
pub struct Progress {
    stage: &'static str,
    phase: &'static str,
    unit: &'static str,
    total: usize,
    step: usize,
    last: AtomicUsize,
    enabled: bool,
}

impl Progress {
    /// A progress reporter for `total` units of `unit` (for example
    /// `"replay file(s)"`).
    #[must_use]
    pub fn new(
        stage: &'static str,
        phase: &'static str,
        unit: &'static str,
        total: usize,
        enabled: bool,
    ) -> Self {
        Self {
            stage,
            phase,
            unit,
            total,
            step: (total / 10).max(1),
            last: AtomicUsize::new(0),
            enabled,
        }
    }

    /// Print the phase header: the shard size and the resolved worker count.
    pub fn announce(&self, workers: usize) {
        if self.enabled {
            eprintln!(
                "{}: {} {}, {workers} worker thread(s)",
                self.stage, self.total, self.unit
            );
        }
    }

    /// Count one finished unit and print at each tenth of the shard.
    pub fn tick(&self) {
        if !self.enabled {
            return;
        }
        let current = self.last.fetch_add(1, Ordering::Relaxed) + 1;
        if current == self.total || current.is_multiple_of(self.step) {
            eprintln!(
                "{}: {} {current}/{} {}",
                self.stage, self.phase, self.total, self.unit
            );
        }
    }

    /// How many units the phase counted so far.
    #[must_use]
    pub fn counted(&self) -> usize {
        self.last.load(Ordering::Relaxed)
    }
}

/// Milliseconds elapsed since `start`, as the run report records it.
#[must_use]
pub fn elapsed_ms(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_workers_means_every_core_and_one_is_kept() {
        let all = resolve_workers(0);
        assert!(all >= 1);
        assert_eq!(all, resolve_workers(0), "the resolution is stable");
        assert_eq!(resolve_workers(1), 1);
        assert_eq!(resolve_workers(3), 3);
    }

    #[test]
    fn a_shared_connection_is_usable_from_several_threads() {
        let connection = Connection::open_in_memory().expect("memory db");
        connection
            .execute_batch("CREATE TABLE t (v INTEGER)")
            .expect("schema");
        let db = std::sync::Arc::new(SharedDb::new(connection));
        let pool = worker_pool(4).expect("pool");
        pool.install(|| {
            use rayon::prelude::*;
            (0..64).into_par_iter().for_each(|value| {
                db.with(|connection| {
                    connection
                        .execute("INSERT INTO t (v) VALUES (?1)", [value])
                        .expect("insert")
                });
            });
        });
        let rows: i64 = db
            .with(|connection| connection.query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0)))
            .expect("count");
        assert_eq!(rows, 64);
    }

    #[test]
    fn progress_is_silent_when_disabled_and_counts_every_unit_when_enabled() {
        let quiet = Progress::new("extract", "walk", "replay file(s)", 3, false);
        quiet.announce(1);
        for _ in 0..3 {
            quiet.tick();
        }
        assert_eq!(quiet.counted(), 0, "a disabled reporter does not count");

        let loud = Progress::new("extract", "walk", "replay file(s)", 4, true);
        for _ in 0..4 {
            loud.tick();
        }
        assert_eq!(loud.counted(), 4);
    }
}
