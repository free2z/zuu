//! Deterministic process death, for the one property that cannot be tested any
//! other way.
//!
//! This is [`f2z-relay-store`'s module][sibling] applied to the other end of
//! the same invariant. There, the question was what the *relay* still holds
//! after a power cut; here it is what the *client* still holds, and the two
//! meet at delete-on-ack: the relay deletes its copy when the client
//! acknowledges, so a client that acknowledges a message it did not durably
//! store has destroyed it ([`ARCHITECTURE.md` §6.4][s64]).
//!
//! # Why an in-process panic proves nothing
//!
//! A caught `panic!` unwinds inside a live process that still owns the SQLite
//! connection and will run `Drop` on its way out — and this crate's `Drop`
//! **rolls the transaction back**, which is the very outcome under test. It
//! exercises the error path, not the durability one.
//!
//! `abort()` is different: no unwinding, no destructors, no `sqlite3_close`, no
//! flush of anything the kernel had not already been told to write. What
//! survives is exactly what `synchronous = FULL` put on the disk.
//!
//! # Why it is behind a feature
//!
//! `crash-injection` is off by default and must never be enabled in anything
//! that ships: it compiles a conditional `abort()` into the commit path. A
//! `[features]` entry rather than `#[cfg(test)]` because the crash has to
//! happen inside the library, in a *separate binary* the test spawns, and
//! `#[cfg(test)]` code does not exist in a dependency build.
//!
//! # How it is driven
//!
//! By environment variable, because the child process is spawned rather than
//! called. [`arm_from_env`] reads `F2Z_MSG_STORE_CRASH_AT`; unset or
//! unrecognised means armed at nothing, so a stray value cannot make a
//! production build die at a random instant even if the feature were somehow
//! on. **Nothing in the library arms itself.**
//!
//! [sibling]: https://github.com/free2z/zuu/blob/main/rs/crates/f2z-relay-store/src/crash.rs
//! [s64]: https://github.com/free2z/zuu/blob/main/docs/e2ee/ARCHITECTURE.md#64-delete-on-ack-and-lost-acknowledgements

use core::sync::atomic::{AtomicU8, Ordering};

/// The environment variable [`arm_from_env`] reads.
pub const CRASH_POINT_ENV: &str = "F2Z_MSG_STORE_CRASH_AT";

/// An instant in the transaction commit path at which the process can be made
/// to die.
///
/// The two non-`Never` values assert opposite things, and that is the point.
/// **Before** the commit must leave *no trace* of the whole operation — not the
/// tree, not the epoch secrets, not the application record — so the message is
/// still un-acknowledged and the relay still holds it. **After** the commit
/// must leave the operation *complete*, even though the caller never received
/// the receipt and so never acknowledged: an at-least-once redelivery is
/// correct and recoverable, a half-applied group is neither.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrashPoint {
    /// Never crash. What a build with the feature on but nothing armed runs at.
    Never,
    /// Inside `Transaction::commit`, with the whole write set staged and the
    /// backend not yet told about any of it.
    BeforeCommit,
    /// Inside `Transaction::commit`, after the backend's commit returned and
    /// before the receipt reaches the caller.
    AfterCommit,
}

impl CrashPoint {
    /// The name used in [`CRASH_POINT_ENV`], and in test failure output.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Never => "never",
            Self::BeforeCommit => "before-commit",
            Self::AfterCommit => "after-commit",
        }
    }

    /// Parse a name. Anything unrecognised is [`CrashPoint::Never`] — see the
    /// module note on why an unknown value must not be a crash.
    #[must_use]
    pub fn parse(name: &str) -> Self {
        match name {
            "before-commit" => Self::BeforeCommit,
            "after-commit" => Self::AfterCommit,
            _ => Self::Never,
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::Never => 0,
            Self::BeforeCommit => 1,
            Self::AfterCommit => 2,
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
            CrashPoint::parse(CrashPoint::AfterCommit.name()),
            CrashPoint::AfterCommit
        );
    }

    #[test]
    fn nothing_is_armed_by_default() {
        assert_eq!(ARMED.load(Ordering::SeqCst), CrashPoint::Never.tag());
    }
}
