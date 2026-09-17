//! The grammar of `internal-directory.conf`, with **no dependencies**.
//!
//! This one file is compiled twice: into the plugin, where
//! [`super::parse`] turns its answer into a [`super::Bundled`], and into
//! `build.rs`, which runs the same function over the checked-in file and fails
//! the build on any error. So a malformed file is a compile error in every
//! crate that links the plugin (ZUULI and e2e2z), not only a failing unit test
//! in this one. That is why it may use `std` and nothing else: a build script
//! cannot reach the plugin's dependencies, and the one thing it needs that
//! `std` lacks — the `log_id` derivation — is passed in as a function.
//!
//! # Grammar
//!
//! - One `key = value` per line. A line whose first non-blank character is
//!   `#` is a comment; nothing else is.
//! - A `#` anywhere else is an **error**, not the start of a trailing comment.
//!   The old parser cut every line at its first `#`, so a URL with a fragment
//!   was silently truncated into a different URL.
//! - Every value is printable ASCII with no spaces (`0x21..=0x7e`). A
//!   zero-width space, a non-breaking space or a Cyrillic `а` in a host is a
//!   different host that renders the same in review; refusing everything
//!   outside that range is the only rule a reviewer can check by eye.
//! - Comment lines may carry any UTF-8: they are prose, and never values.

// `build.rs` includes this file for [`parse`] alone, so the accessors the
// plugin also uses would read as dead code there.
#![allow(dead_code)]

use std::collections::BTreeMap;
use std::collections::BTreeSet;

/// The one posture this file may declare.
pub const POSTURE: &str = "internal-disposable";

/// The literal a not-yet-deployed value carries.
pub const PLACEHOLDER: &str = "PLACEHOLDER";

/// The smallest `reset_cooldown_seconds` a build accepts: seven days.
///
/// ADR 0014's cooldown is the window in which a user who still holds their
/// key can see a platform-authority reset of their handle and cancel it, and
/// in which conforming clients keep encrypting to the old key. It protects a
/// person only if they open the app inside it, so it is sized in how often
/// people open a messaging app, not in how fast a server can merge. ADR 0014
/// proposes seven days, the log's own default (`f2z-kt`'s `LogSettings`) is
/// seven days, and nothing on record argues for less. A smaller number in a
/// reviewed file is far more likely a test fixture's `60` pasted in than a
/// decision, and this client *enforces* the value on every reset it sees, so
/// a typo here would silently shorten the one delay that turns a compromised
/// reset authority from invisible to visible. Lowering the floor is a code
/// change, reviewed as one.
pub const MIN_RESET_COOLDOWN_SECONDS: u32 = 7 * 24 * 60 * 60;

/// The file's values, checked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Parsed {
    pub log_url: String,
    pub log_public_key: [u8; 32],
    pub log_id: [u8; 32],
    pub vrf_public_key: [u8; 32],
    pub reset_authority_pk: [u8; 32],
    pub reset_cooldown_seconds: u32,
    pub witnesses: Vec<[u8; 32]>,
    pub threshold: usize,
    pub handle_authority_pk: [u8; 32],
    pub handle_assertion_url: String,
    pub relay_url: String,
    pub retired_log_public_keys: Vec<[u8; 32]>,
}

/// What the file says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Every deployable value is still `PLACEHOLDER`.
    Unconfigured,
    /// Every deployable value is real, and all of them passed.
    Configured(Box<Parsed>),
}

const SINGLE_KEYS: [&str; 10] = [
    "log_url",
    "log_public_key",
    "log_id",
    "vrf_public_key",
    "reset_authority_pk",
    "reset_cooldown_seconds",
    "threshold",
    "handle_authority_pk",
    "handle_assertion_url",
    "relay_url",
];

/// Parse the file's text.
///
/// `log_id_of` is `KT.md` §6.1's `H("free2z/kt/v1/log-id", pk)`: the plugin
/// passes `f2z_kt_core::labels::log_id`, and `build.rs` passes the same
/// BLAKE2b-256 computed with the `blake2` crate that implementation uses. A
/// unit test holds the two to the same answer.
///
/// # Errors
///
/// A description of the first problem found.
pub fn parse(text: &str, log_id_of: &dyn Fn(&[u8; 32]) -> [u8; 32]) -> Result<Outcome, String> {
    let mut posture = None;
    let mut singles: BTreeMap<&str, &str> = BTreeMap::new();
    let mut witnesses: Vec<&str> = Vec::new();
    let mut retired: Vec<&str> = Vec::new();

    for (index, raw) in text.lines().enumerate() {
        let number = index.saturating_add(1);
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if line.contains('#') {
            return Err(format!(
                "line {number}: `#` is only allowed at the start of a comment line"
            ));
        }
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("line {number}: expected `key = value`"))?;
        let (key, value) = (key.trim(), value.trim());
        if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err(format!(
                "line {number}: the value of `{key}` must be printable ASCII with no spaces"
            ));
        }
        match key {
            "posture" => {
                if posture.replace(value).is_some() {
                    return Err(format!("line {number}: `posture` is set twice"));
                }
            }
            "witness_pk" => witnesses.push(value),
            "retired_log_public_key" => retired.push(value),
            known if SINGLE_KEYS.contains(&known) => {
                if singles.insert(known, value).is_some() {
                    return Err(format!("line {number}: `{known}` is set twice"));
                }
            }
            other => return Err(format!("line {number}: unknown key `{other}`")),
        }
    }

    if posture != Some(POSTURE) {
        return Err(format!("`posture` must be `{POSTURE}`"));
    }
    let get = |key: &str| {
        singles
            .get(key)
            .copied()
            .ok_or_else(|| format!("`{key}` is required"))
    };

    // Every value a deployment supplies. The two numbers have real defaults in
    // the placeholder file and are not part of this census, and a retired
    // generation is only ever a real key.
    let deployable = [
        get("log_url")?,
        get("log_public_key")?,
        get("log_id")?,
        get("vrf_public_key")?,
        get("reset_authority_pk")?,
        get("handle_authority_pk")?,
        get("handle_assertion_url")?,
        get("relay_url")?,
    ];
    if witnesses.is_empty() {
        return Err("at least one `witness_pk` is required".to_owned());
    }
    let placeholders = deployable
        .iter()
        .chain(witnesses.iter())
        .filter(|value| **value == PLACEHOLDER)
        .count();
    let reset_cooldown_seconds = get("reset_cooldown_seconds")?
        .parse::<u32>()
        .map_err(|_| "`reset_cooldown_seconds` is not a u32".to_owned())?;
    if reset_cooldown_seconds < MIN_RESET_COOLDOWN_SECONDS {
        return Err(format!(
            "`reset_cooldown_seconds` must be at least {MIN_RESET_COOLDOWN_SECONDS} (seven days, \
             ADR 0014)"
        ));
    }
    let threshold = get("threshold")?
        .parse::<usize>()
        .map_err(|_| "`threshold` is not a number".to_owned())?;
    let mut distinct_retired = BTreeSet::new();
    let retired_log_public_keys = retired
        .iter()
        .map(|value| {
            let parsed = key("retired_log_public_key", value)?;
            if distinct_retired.insert(parsed) {
                Ok(parsed)
            } else {
                Err("a `retired_log_public_key` is listed twice".to_owned())
            }
        })
        .collect::<Result<Vec<_>, _>>()?;

    if placeholders == deployable.len().saturating_add(witnesses.len()) {
        return Ok(Outcome::Unconfigured);
    }
    if placeholders > 0 {
        return Err(
            "some values are PLACEHOLDER and some are not; fill in every value or none".to_owned(),
        );
    }

    let log_public_key = key("log_public_key", get("log_public_key")?)?;
    let log_id = log_id_of(&log_public_key);
    if key("log_id", get("log_id")?)? != log_id {
        return Err(
            "`log_id` is not BLAKE2b-256(\"free2z/kt/v1/log-id\" || log_public_key); the two \
             values come from different logs"
                .to_owned(),
        );
    }
    if distinct_retired.contains(&log_public_key) {
        return Err("the current `log_public_key` is also listed as retired".to_owned());
    }
    let mut distinct = BTreeSet::new();
    let witnesses = witnesses
        .iter()
        .map(|value| {
            let parsed = key("witness_pk", value)?;
            if distinct.insert(parsed) {
                Ok(parsed)
            } else {
                Err("a `witness_pk` is listed twice".to_owned())
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    if threshold == 0 || threshold > witnesses.len() {
        return Err(format!(
            "`threshold` must be between 1 and {} (the number of witness_pk lines)",
            witnesses.len()
        ));
    }

    Ok(Outcome::Configured(Box::new(Parsed {
        log_url: url("log_url", get("log_url")?, "https://")?,
        log_id,
        log_public_key,
        vrf_public_key: key("vrf_public_key", get("vrf_public_key")?)?,
        reset_authority_pk: key("reset_authority_pk", get("reset_authority_pk")?)?,
        reset_cooldown_seconds,
        witnesses,
        threshold,
        handle_authority_pk: key("handle_authority_pk", get("handle_authority_pk")?)?,
        handle_assertion_url: url(
            "handle_assertion_url",
            get("handle_assertion_url")?,
            "https://",
        )?,
        relay_url: url("relay_url", get("relay_url")?, "wss://")?,
        retired_log_public_keys,
    })))
}

/// 64 lowercase hex characters, decoded without a crate.
fn key(name: &str, value: &str) -> Result<[u8; 32], String> {
    let invalid = || format!("`{name}` is not 64 lowercase hex characters");
    let digits = value.as_bytes();
    if digits.len() != 64 {
        return Err(invalid());
    }
    let nibble = |digit: u8| match digit {
        b'0'..=b'9' => Some(digit.wrapping_sub(b'0')),
        b'a'..=b'f' => Some(digit.wrapping_sub(b'a').wrapping_add(10)),
        _ => None,
    };
    let mut out = [0u8; 32];
    for (slot, pair) in out.iter_mut().zip(digits.chunks_exact(2)) {
        let (Some(&high), Some(&low)) = (pair.first(), pair.get(1)) else {
            return Err(invalid());
        };
        let (Some(high), Some(low)) = (nibble(high), nibble(low)) else {
            return Err(invalid());
        };
        *slot = (high << 4) | low;
    }
    Ok(out)
}

/// A URL with the expected scheme and a plain host.
///
/// Deliberately not a URL parser: the rules are the few a reviewer can check
/// by reading the line. No userinfo (`https://free2z.cash@elsewhere` goes to
/// `elsewhere`), no backslash (which some parsers read as a path separator),
/// and a non-empty host made of letters, digits, `-`, `.` and an optional
/// `:port`.
fn url(name: &str, value: &str, scheme: &str) -> Result<String, String> {
    let rest = value
        .strip_prefix(scheme)
        .ok_or_else(|| format!("`{name}` must start with {scheme}"))?;
    if rest.contains('@') || rest.contains('\\') {
        return Err(format!(
            "`{name}` must not contain `@` or `\\`; name the host directly"
        ));
    }
    let authority = rest.split(['/', '?']).next().unwrap_or_default();
    let host_ok = !authority.is_empty()
        && !authority.starts_with([':', '.', '-'])
        && authority
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b':'));
    if !host_ok {
        return Err(format!("`{name}` has no valid host"));
    }
    Ok(value.to_owned())
}
