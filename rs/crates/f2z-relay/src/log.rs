//! The relay's log, and the one rule it exists to keep.
//!
//! # No payload, no queue address, no key, no IP — at any level
//!
//! A relay is the one component that sees every ciphertext and every address in
//! the system. Its log is therefore the cheapest possible way to undo the whole
//! design: an operator who turns on `--log-level trace` while debugging must not
//! thereby create the metadata archive that [ADR 0004] exists to prevent, and
//! `THREAT-MODEL.md` §3.3's "compromised operator" must not be reachable by
//! accident from a rotated log file.
//!
//! So this module has no `Display` for anything protocol-shaped, no `{:?}` of a
//! frame, and no formatting of a socket address. What a log line may carry is a
//! *count*, a *duration*, a *code*, and a fixed string. `tests/redaction.rs`
//! scans every line this crate can emit for base16, base64url and — the trap —
//! the **decimal** byte-list form.
//!
//! ## The decimal trap, restated because it is the reason this is not obvious
//!
//! `f2z-codec`'s redaction tests document it: `tls_codec`'s byte vectors derive
//! `Debug` and render as `[222, 173, 190, 239, …]`, a complete dump of the bytes
//! that contains **no hex characters at all**. A leak check written to look for
//! `deadbeef` passes against that string while every byte is on the page. Every
//! type that crosses this crate's boundary is an `f2z-codec` newtype with a
//! redacting `Debug` for exactly that reason, and the test checks the decimal
//! run as well as the hex.
//!
//! # Why not `tracing` or `log`
//!
//! Two reasons, and the first is the rule above. A facade invites
//! `tracing::debug!(?frame)`, and the moment one exists somebody writes it. A
//! logger with no way to pass a value that is not a number or a `&'static str`
//! makes the leak a compile error rather than a review finding. The second is
//! plainer: this binary's dependency graph is its attack surface, and a leveled
//! writer to stderr is forty lines.
//!
//! [ADR 0004]: https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0004-metadata-ambition.md

use std::fmt;
use std::io::Write as _;
use std::sync::atomic::{AtomicU8, Ordering};

/// How much the relay says.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    /// Nothing at all. For an operator who ships logs some other way.
    Off,
    /// Only what stopped working.
    Error,
    /// Degradation an operator should see: backpressure on, a listener retrying.
    Warn,
    /// Lifecycle: bound, serving, sweeping, shutting down.
    #[default]
    Info,
    /// Per-connection lifecycle and per-sweep counts.
    Debug,
    /// Per-command counts. **Still no payloads, addresses, keys or peers.**
    Trace,
}

impl Level {
    /// Parse `--log-level`.
    ///
    /// # Errors
    ///
    /// The unrecognized text, so the caller can name it.
    pub fn parse(text: &str) -> Result<Self, &str> {
        match text {
            "off" => Ok(Self::Off),
            "error" => Ok(Self::Error),
            "warn" => Ok(Self::Warn),
            "info" => Ok(Self::Info),
            "debug" => Ok(Self::Debug),
            "trace" => Ok(Self::Trace),
            other => Err(other),
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
            Self::Trace => "trace",
        }
    }
}

impl fmt::Display for Level {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.label())
    }
}

/// The process-wide level. `Info` until [`set_level`] says otherwise.
static LEVEL: AtomicU8 = AtomicU8::new(Level::Info as u8);

/// Set the level for the process.
pub fn set_level(level: Level) {
    LEVEL.store(level as u8, Ordering::Relaxed);
}

/// The level the process is at.
#[must_use]
pub fn level() -> Level {
    match LEVEL.load(Ordering::Relaxed) {
        0 => Level::Off,
        1 => Level::Error,
        2 => Level::Warn,
        3 => Level::Info,
        4 => Level::Debug,
        _ => Level::Trace,
    }
}

/// Whether a line at `level` would be written.
#[must_use]
pub fn enabled(target: Level) -> bool {
    target != Level::Off && target <= level()
}

/// Write one line. Called only through the macros below.
///
/// `message` is a `&'static str` and `fields` are `(name, integer)` pairs, and
/// that signature *is* the redaction rule: there is no parameter through which
/// a payload, an address, a key or a peer address could travel.
pub fn line(target: Level, message: &'static str, fields: &[(&'static str, u64)]) {
    if !enabled(target) {
        return;
    }
    let mut out = String::with_capacity(64);
    out.push_str(target.label());
    out.push(' ');
    out.push_str(message);
    for (name, value) in fields {
        out.push(' ');
        out.push_str(name);
        out.push('=');
        // `u64` renders as digits and nothing else, which is the point: a
        // formatter that could take `impl Debug` is a formatter that will one
        // day take a `Payload`.
        let mut buffer = itoa(*value);
        out.push_str(buffer.as_str());
        buffer.clear();
    }
    out.push('\n');
    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(out.as_bytes());
    let _ = stderr.flush();
}

fn itoa(value: u64) -> String {
    let mut text = String::with_capacity(20);
    let mut digits = [0u8; 20];
    let mut length = 0usize;
    let mut remaining = value;
    loop {
        let digit = u8::try_from(remaining % 10).unwrap_or(0);
        if let Some(slot) = digits.get_mut(length) {
            *slot = b'0'.saturating_add(digit);
        }
        length = length.saturating_add(1);
        remaining /= 10;
        if remaining == 0 {
            break;
        }
    }
    for index in (0..length).rev() {
        let byte = digits.get(index).copied().unwrap_or(b'0');
        text.push(char::from(byte));
    }
    text
}

/// An error line.
#[macro_export]
macro_rules! log_error {
    ($message:literal $(, $name:literal = $value:expr)* $(,)?) => {
        $crate::log::line($crate::log::Level::Error, $message, &[$(($name, u64::from($value))),*])
    };
}

/// A warning line.
#[macro_export]
macro_rules! log_warn {
    ($message:literal $(, $name:literal = $value:expr)* $(,)?) => {
        $crate::log::line($crate::log::Level::Warn, $message, &[$(($name, u64::from($value))),*])
    };
}

/// An informational line.
#[macro_export]
macro_rules! log_info {
    ($message:literal $(, $name:literal = $value:expr)* $(,)?) => {
        $crate::log::line($crate::log::Level::Info, $message, &[$(($name, u64::from($value))),*])
    };
}

/// A debug line.
#[macro_export]
macro_rules! log_debug {
    ($message:literal $(, $name:literal = $value:expr)* $(,)?) => {
        $crate::log::line($crate::log::Level::Debug, $message, &[$(($name, u64::from($value))),*])
    };
}

/// A trace line. Still carries no payload, address, key or peer.
#[macro_export]
macro_rules! log_trace {
    ($message:literal $(, $name:literal = $value:expr)* $(,)?) => {
        $crate::log::line($crate::log::Level::Trace, $message, &[$(($name, u64::from($value))),*])
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_order_from_quiet_to_loud() {
        assert!(Level::Off < Level::Error);
        assert!(Level::Error < Level::Warn);
        assert!(Level::Warn < Level::Info);
        assert!(Level::Info < Level::Debug);
        assert!(Level::Debug < Level::Trace);
    }

    #[test]
    fn off_enables_nothing_including_itself() {
        set_level(Level::Off);
        assert!(!enabled(Level::Error));
        assert!(!enabled(Level::Off));
        set_level(Level::Info);
    }

    #[test]
    fn parsing_names_what_it_did_not_recognize() {
        assert_eq!(Level::parse("trace"), Ok(Level::Trace));
        assert_eq!(Level::parse("verbose"), Err("verbose"));
    }

    #[test]
    fn integers_render_as_digits() {
        assert_eq!(itoa(0), "0");
        assert_eq!(itoa(1), "1");
        assert_eq!(itoa(u64::MAX), "18446744073709551615");
    }
}
