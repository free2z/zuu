//! A stderr logger, and the rule about what never reaches it.
//!
//! # The rule
//!
//! **The log is public by construction, so log it normally — but never a
//! signing key, and never an unpublished submission.**
//!
//! The first half matters: a directory entry is a public record, and refusing
//! to log handles and epochs would make the server unoperable for no privacy
//! gain. What is *not* public is:
//!
//! - **Any key material.** Every type in this tree that holds a secret has a
//!   hand-written [`core::fmt::Debug`] that renders `<redacted>`; there is no
//!   path from a signer, a VRF key or an assertion issuer's key to a log line.
//! - **A submission that has not been published yet.** Between
//!   `/kt/v1/submit` and the epoch that carries it, the entry exists only
//!   between the submitter and the log. Writing it out turns the operator's log
//!   into a preview of directory changes — including, for a `platform_reset`,
//!   advance notice that a specific handle is about to change hands, which is
//!   precisely the window ADR 0014's cooldown exists to make *visible to the
//!   user* rather than to whoever reads the server's logs.
//!
//! `f2z-kt` therefore logs a submission as `handle@vN` and a verdict, never its
//! bytes. `/kt/v1/lookup` and `/kt/v1/history` log nothing per request at all —
//! §9.2 chose `POST` so the handle would stay out of access logs, and an
//! application log line would put it straight back.
//!
//! # Why not a logging framework
//!
//! Because the whole of it is twenty lines and a `Mutex`, and because a
//! dependency here would be a dependency in an AGPL server binary whose graph
//! we are keeping deliberately small. Structured output goes to stderr, one
//! line per record, and the deployment collects stderr.

use std::io::Write as _;
use std::sync::Mutex;

/// Minimum level, parsed from `--log-level` or `F2Z_LOG`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[non_exhaustive]
pub enum Level {
    /// Faults only.
    Error,
    /// Faults and things an operator should look at.
    Warn,
    /// The default: epochs published, submissions admitted, cosignatures
    /// accepted.
    Info,
    /// Everything, including `akd`'s own output.
    Debug,
}

impl Level {
    /// Parse a level name, case-insensitively.
    #[must_use]
    pub fn parse(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "error" => Some(Self::Error),
            "warn" | "warning" => Some(Self::Warn),
            "info" => Some(Self::Info),
            "debug" => Some(Self::Debug),
            _ => None,
        }
    }

    const fn to_filter(self) -> log::LevelFilter {
        match self {
            Self::Error => log::LevelFilter::Error,
            Self::Warn => log::LevelFilter::Warn,
            Self::Info => log::LevelFilter::Info,
            Self::Debug => log::LevelFilter::Debug,
        }
    }
}

struct Stderr {
    lock: Mutex<()>,
}

impl log::Log for Stderr {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // A poisoned lock must not stop the log from reporting: interleaved
        // output is worse than silence only if you can read it, and silence is
        // worse than both.
        let _guard = self.lock.lock();
        let mut stderr = std::io::stderr().lock();
        let _ = writeln!(
            stderr,
            "{:<5} {} {}",
            record.level(),
            record.target(),
            record.args()
        );
    }

    fn flush(&self) {
        let _ = std::io::stderr().flush();
    }
}

static LOGGER: std::sync::OnceLock<Stderr> = std::sync::OnceLock::new();

/// Install the logger. Idempotent; a second call is a no-op rather than an
/// error, so a test binary that starts two servers does not fail on it.
pub fn install(level: Level) {
    let logger = LOGGER.get_or_init(|| Stderr {
        lock: Mutex::new(()),
    });
    log::set_max_level(level.to_filter());
    // `set_logger` fails only if one is already installed, which is the
    // idempotent case.
    let _ = log::set_logger(logger);
}

#[cfg(test)]
mod tests {
    use super::Level;

    #[test]
    fn level_names_parse_and_an_unknown_one_is_none_rather_than_a_default() {
        assert_eq!(Level::parse("INFO"), Some(Level::Info));
        assert_eq!(Level::parse("warning"), Some(Level::Warn));
        assert_eq!(Level::parse("trace"), None);
        assert_eq!(Level::parse(""), None);
    }

    #[test]
    fn debug_is_the_most_verbose_and_error_the_least() {
        assert!(Level::Debug > Level::Info);
        assert!(Level::Info > Level::Warn);
        assert!(Level::Warn > Level::Error);
    }
}
