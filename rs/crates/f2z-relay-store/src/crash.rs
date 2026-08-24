//! Deterministic process death, for the one property that cannot be tested any
//! other way.
//!
//! # Why an in-process panic proves nothing here
//!
//! The claim under test is "what is on the disk after the machine stops". A
//! caught `panic!` unwinds inside a live process that still owns the SQLite
//! connection, still holds its page cache, and will run `Drop` on its way out —
//! rolling back the very transaction whose fate is the question. It exercises
//! the error path, not the durability one.
//!
//! `abort()` is different: no unwinding, no destructors, no `sqlite3_close`,
//! no flush of anything the kernel had not already been told to write. What
//! survives is exactly what `synchronous = FULL` put on the disk. The test
//! harness then reopens the same file **in a new process** and asserts the two
//! invariants delete-on-ack depends on:
//!
//! - nothing **acked-but-undeleted** — no message at or below the persisted
//!   watermark is still stored;
//! - nothing **accepted-but-lost** — every append whose receipt the caller
//!   actually received is still there.
//!
//! # Why it is behind a feature
//!
//! `crash-injection` is off by default and must never be enabled in anything
//! that ships: it compiles a conditional `abort()` into the middle of the
//! commit path. It is a `[features]` entry rather than `#[cfg(test)]` because
//! the crash has to happen inside the library, in a *separate binary* the test
//! spawns, and `#[cfg(test)]` code does not exist in a dependency build.
//!
//! # How it is driven
//!
//! By environment variable, because the child process is spawned rather than
//! called. [`arm_from_env`] reads `F2Z_RELAY_STORE_CRASH_AT`; unset or
//! unrecognized means armed at nothing, so a stray value cannot make a
//! production build die at a random instant even if the feature were somehow
//! on.
//!
//! **Nothing in the library arms itself.** `SqliteStore::open` deliberately
//! does *not* call [`arm_from_env`], because a store that armed at open would
//! die on the first append rather than on the one the test chose — and the
//! interesting crash is almost never the first one. The child arms immediately
//! before the operation it means to lose.

use core::sync::atomic::{AtomicU8, Ordering};

/// The environment variable [`arm_from_env`] reads.
pub const CRASH_POINT_ENV: &str = "F2Z_RELAY_STORE_CRASH_AT";

/// An instant in the commit path at which the process can be made to die.
///
/// The pairs are the point: each write has a "before the commit" and an "after
/// the commit, before the caller is told" variant, and the two assert opposite
/// things. Before-commit must leave **no trace**; after-commit must leave the
/// write **complete**, even though the caller never received its receipt and so
/// never reported `accepted`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrashPoint {
    /// Never crash. The value a build with the feature on but nothing armed
    /// runs at.
    Never,
    /// Inside `append_batch`, with every row written and the transaction not
    /// yet committed.
    BeforeAppendCommit,
    /// Inside `append_batch`, after the commit's fsync returned and before the
    /// receipts reach the caller.
    AfterAppendCommit,
    /// Inside `ack`, with the range delete and the watermark advance staged and
    /// the transaction not yet committed.
    BeforeAckCommit,
    /// Inside `ack`, after the commit's fsync returned and before the outcome
    /// reaches the caller.
    AfterAckCommit,
}

impl CrashPoint {
    /// The name used in [`CRASH_POINT_ENV`], and in test failure output.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::BeforeAppendCommit => "before-append-commit",
            Self::AfterAppendCommit => "after-append-commit",
            Self::BeforeAckCommit => "before-ack-commit",
            Self::AfterAckCommit => "after-ack-commit",
        }
    }

    /// Parse a name. Anything unrecognized is [`CrashPoint::Never`] — see the
    /// module note on why an unknown value must not be a crash.
    #[must_use]
    pub fn parse(name: &str) -> Self {
        match name {
            "before-append-commit" => Self::BeforeAppendCommit,
            "after-append-commit" => Self::AfterAppendCommit,
            "before-ack-commit" => Self::BeforeAckCommit,
            "after-ack-commit" => Self::AfterAckCommit,
            _ => Self::Never,
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::Never => 0,
            Self::BeforeAppendCommit => 1,
            Self::AfterAppendCommit => 2,
            Self::BeforeAckCommit => 3,
            Self::AfterAckCommit => 4,
        }
    }
}

static ARMED: AtomicU8 = AtomicU8::new(0);

/// Arm a crash point for this process.
pub fn arm(point: CrashPoint) {
    ARMED.store(point.tag(), Ordering::SeqCst);
}

/// Arm from [`CRASH_POINT_ENV`], if it is set to a name this build knows.
pub fn arm_from_env() {
    if let Ok(value) = std::env::var(CRASH_POINT_ENV) {
        arm(CrashPoint::parse(&value));
    }
}

/// Kill the process, right here, if this point is the armed one.
///
/// `abort()` rather than `exit()`: a normal exit runs at-exit handlers and
/// flushes buffers, which is the opposite of the event being simulated.
pub(crate) fn fire(point: CrashPoint) {
    if ARMED.load(Ordering::SeqCst) == point.tag() {
        std::process::abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_name_is_never_a_crash() {
        assert_eq!(CrashPoint::parse("kaboom"), CrashPoint::Never);
        assert_eq!(CrashPoint::parse(""), CrashPoint::Never);
        assert_eq!(
            CrashPoint::parse(CrashPoint::AfterAckCommit.name()),
            CrashPoint::AfterAckCommit
        );
    }

    #[test]
    fn nothing_is_armed_by_default() {
        assert_eq!(ARMED.load(Ordering::SeqCst), CrashPoint::Never.tag());
    }
}
