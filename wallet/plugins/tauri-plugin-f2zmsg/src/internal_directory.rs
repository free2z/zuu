//! The **INTERNAL-DISPOSABLE** directory this build is compiled against —
//! [ADR 0017](../../../../docs/e2ee/decisions/0017-internal-directory-activation.md).
//!
//! # Why a checked-in file, and why it fails closed
//!
//! [`crate::directory::DirectoryConfig`] has no `Default` because `KT.md` §12
//! has not decided the public log's identity, witness list or *t*, and a plugin
//! that invented them would be inventing them for every user. ADR 0017 decides
//! them for **one** deployment — a disposable internal log free2z runs, with
//! free2z as its only witness — and this module is where that decision enters
//! the build: `../internal-directory.conf`, compiled in with `include_str!`.
//!
//! The file ships with every key and URL set to `PLACEHOLDER`, and in that
//! state [`bundled`] answers [`Bundled::Unconfigured`]: the engine keeps
//! [`crate::directory::NoDirectory`] and no relay is added. A half-filled file
//! is **malformed**, not partially configured — the unit test below fails the
//! build on it, and a binary that carried one anyway logs the reason and stays
//! unconfigured. There is no environment variable and no runtime override: the
//! only way to point a build at a log is a reviewed change to that one file.
//!
//! # What the posture does not let the file say
//!
//! Witness **independence**. Every `witness_pk` here becomes a
//! [`crate::directory::WitnessConfig`] with `independent: false`, because the
//! internal posture is precisely that free2z operates the log and the witness
//! (`KT.md` §8.3). The threshold is met and the independent count is zero, so
//! `EngineStatus.independentWitnesses` stays `0` and the UI's warning stays up.

use std::collections::BTreeSet;
use std::time::Duration;

use f2z_codec::types::PublicKey;

use crate::directory::{DirectoryConfig, WitnessConfig};

/// The file, as compiled into this build.
pub const BUNDLED_TEXT: &str = include_str!("../internal-directory.conf");

/// The one posture this file may declare.
pub const POSTURE: &str = "internal-disposable";

/// The literal a not-yet-deployed value carries.
pub const PLACEHOLDER: &str = "PLACEHOLDER";

/// How long a lookup or submission waits for the log.
const LOG_TIMEOUT: Duration = Duration::from_secs(15);

/// A filled-in internal directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InternalDirectory {
    /// The log's origin, `https://`.
    pub log_url: String,
    /// The log's genesis signing key.
    pub log_public_key: [u8; 32],
    /// `H("free2z/kt/v1/log-id", log_public_key)` (`KT.md` §6.1). The file
    /// carries it too, and the parser refuses a value that is not this
    /// derivation, so the two cannot disagree.
    pub log_id: [u8; 32],
    /// The log's ECVRF public key. Pinned against the first tree head a
    /// device sees; `KT.md` §6.3 refuses any change after that.
    pub vrf_public_key: [u8; 32],
    /// ADR 0014's pinned reset authority.
    pub reset_authority_pk: [u8; 32],
    /// ADR 0014's cooldown, in seconds.
    pub reset_cooldown_seconds: u32,
    /// The witnesses — all operated by the log's operator.
    pub witnesses: Vec<[u8; 32]>,
    /// *t*.
    pub threshold: usize,
    /// Contract C: the key a `HandleAssertion` must be signed by.
    pub handle_authority_pk: [u8; 32],
    /// Contract C: where the enrolling wallet fetches one, `https://`.
    pub handle_assertion_url: String,
    /// The relay a fresh engine is configured with, `wss://`.
    pub relay_url: String,
}

impl InternalDirectory {
    /// The client configuration [`crate::directory::KtDirectory`] takes.
    #[must_use]
    pub fn directory_config(&self) -> DirectoryConfig {
        DirectoryConfig {
            base_url: self.log_url.clone(),
            log_id: self.log_id,
            log_public_key: self.log_public_key,
            reset_authority_pk: self.reset_authority_pk,
            reset_cooldown_seconds: self.reset_cooldown_seconds,
            witnesses: self
                .witnesses
                .iter()
                .map(|public_key| WitnessConfig {
                    public_key: *public_key,
                    // ADR 0017: never independent in this posture.
                    independent: false,
                })
                .collect(),
            threshold: self.threshold,
            timeout: LOG_TIMEOUT,
            vrf_public_key: Some(self.vrf_public_key),
            checkpoint_path: None,
        }
    }
}

/// What the compiled-in file says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Bundled {
    /// Nothing is configured; the build fails closed. The string says why.
    Unconfigured(String),
    /// The internal directory, validated. Boxed: it is two orders of magnitude
    /// larger than the reason string beside it.
    Configured(Box<InternalDirectory>),
}

impl Bundled {
    /// The configuration, if there is one.
    #[must_use]
    pub fn configured(&self) -> Option<&InternalDirectory> {
        match self {
            Self::Configured(directory) => Some(directory.as_ref()),
            Self::Unconfigured(_) => None,
        }
    }
}

/// The compiled-in configuration.
///
/// A malformed file is reported once, at `error`, and treated as
/// unconfigured — never as partially configured.
#[must_use]
pub fn bundled() -> Bundled {
    match parse(BUNDLED_TEXT) {
        Ok(bundled) => bundled,
        Err(reason) => {
            tracing::error!(
                %reason,
                "internal-directory.conf is malformed; messaging stays on NoDirectory"
            );
            Bundled::Unconfigured(format!("malformed internal-directory.conf: {reason}"))
        }
    }
}

/// Parse the file's text.
///
/// # Errors
///
/// A description of the first problem: an unknown or repeated key, a missing
/// one, a posture other than [`POSTURE`], a mix of placeholder and real
/// values, a URL with the wrong scheme, a key that is not 64 hex characters, a
/// duplicate witness, or a threshold outside `1..=witnesses`.
pub fn parse(text: &str) -> Result<Bundled, String> {
    let mut posture = None;
    let mut singles: std::collections::BTreeMap<&str, &str> = std::collections::BTreeMap::new();
    let mut witnesses: Vec<&str> = Vec::new();

    for (index, raw) in text.lines().enumerate() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let number = index.saturating_add(1);
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| format!("line {number}: expected `key = value`"))?;
        let (key, value) = (key.trim(), value.trim());
        match key {
            "posture" => {
                if posture.replace(value).is_some() {
                    return Err(format!("line {number}: `posture` is set twice"));
                }
            }
            "witness_pk" => witnesses.push(value),
            "log_url"
            | "log_public_key"
            | "log_id"
            | "vrf_public_key"
            | "reset_authority_pk"
            | "reset_cooldown_seconds"
            | "threshold"
            | "handle_authority_pk"
            | "handle_assertion_url"
            | "relay_url" => {
                if singles.insert(key, value).is_some() {
                    return Err(format!("line {number}: `{key}` is set twice"));
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
    // the placeholder file and are not part of this census.
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
    let threshold = get("threshold")?
        .parse::<usize>()
        .map_err(|_| "`threshold` is not a number".to_owned())?;

    if placeholders == deployable.len().saturating_add(witnesses.len()) {
        return Ok(Bundled::Unconfigured(
            "internal-directory.conf still carries PLACEHOLDER values".to_owned(),
        ));
    }
    if placeholders > 0 {
        return Err(
            "some values are PLACEHOLDER and some are not; fill in every value or none".to_owned(),
        );
    }

    let log_public_key = key("log_public_key", get("log_public_key")?)?;
    let log_id = *f2z_kt_core::labels::log_id(&PublicKey::new(log_public_key)).as_bytes();
    if key("log_id", get("log_id")?)? != log_id {
        return Err(
            "`log_id` is not BLAKE2b-256(\"free2z/kt/v1/log-id\" || log_public_key); the two \
             values come from different logs"
                .to_owned(),
        );
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

    Ok(Bundled::Configured(Box::new(InternalDirectory {
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
    })))
}

fn key(name: &str, value: &str) -> Result<[u8; 32], String> {
    let invalid = || format!("`{name}` is not 64 lowercase hex characters");
    if value.len() != 64 || value.bytes().any(|byte| byte.is_ascii_uppercase()) {
        return Err(invalid());
    }
    hex::decode(value)
        .ok()
        .and_then(|bytes| <[u8; 32]>::try_from(bytes).ok())
        .ok_or_else(invalid)
}

fn url(name: &str, value: &str, scheme: &str) -> Result<String, String> {
    let rest = value
        .strip_prefix(scheme)
        .ok_or_else(|| format!("`{name}` must start with {scheme}"))?;
    if rest.is_empty() || rest.contains(char::is_whitespace) {
        return Err(format!("`{name}` has no host"));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "0101010101010101010101010101010101010101010101010101010101010101";
    const B: &str = "0202020202020202020202020202020202020202020202020202020202020202";
    const C: &str = "0303030303030303030303030303030303030303030303030303030303030303";
    const D: &str = "0404040404040404040404040404040404040404040404040404040404040404";

    /// `log_id` for [`A`], computed outside the parser.
    fn log_id_of_a() -> String {
        hex::encode(f2z_kt_core::labels::log_id(&PublicKey::new([1; 32])).as_bytes())
    }

    fn filled() -> String {
        format!(
            "posture = internal-disposable\n\
             log_url = https://kt.internal.example\n\
             log_public_key = {A}\n\
             log_id = {}\n\
             vrf_public_key = {C}\n\
             reset_authority_pk = {B}\n\
             reset_cooldown_seconds = 604800\n\
             witness_pk = {C}\n\
             threshold = 1\n\
             handle_authority_pk = {D}\n\
             handle_assertion_url = https://api.internal.example/api/kt/handle-assertion/\n\
             relay_url = wss://relay.internal.example/relay/v1\n",
            log_id_of_a()
        )
    }

    #[test]
    fn the_checked_in_file_is_well_formed() {
        // A half-filled file fails here, in CI, rather than shipping a build
        // that silently stays on NoDirectory.
        assert!(parse(BUNDLED_TEXT).is_ok(), "{:?}", parse(BUNDLED_TEXT));
    }

    #[test]
    fn the_checked_in_placeholders_fail_closed() {
        // While the deployment has not supplied values, nothing is configured.
        // When workstream 9 fills the file, this test is the one to update.
        assert!(matches!(bundled(), Bundled::Unconfigured(_)));
        assert!(bundled().configured().is_none());
    }

    #[test]
    fn a_filled_file_configures_a_dependent_witness_and_derives_the_log_id() {
        let Bundled::Configured(directory) = parse(&filled()).unwrap() else {
            panic!("a filled file is configured");
        };
        let config = directory.directory_config();
        assert_eq!(config.threshold, 1);
        assert_eq!(config.witnesses.len(), 1);
        assert!(
            !config.witnesses[0].independent,
            "the internal posture never asserts independence"
        );
        let derived = f2z_kt_core::labels::log_id(&PublicKey::new([1; 32]));
        assert_eq!(&directory.log_id, derived.as_bytes());
        assert_eq!(config.log_id, directory.log_id);
        assert_eq!(directory.handle_authority_pk, [4; 32]);
        assert_eq!(directory.vrf_public_key, [3; 32]);
        assert_eq!(config.vrf_public_key, Some([3; 32]));
        assert_eq!(directory.relay_url, "wss://relay.internal.example/relay/v1");
    }

    #[test]
    fn a_partly_filled_file_is_malformed_not_partly_configured() {
        let partial = filled().replace(C, PLACEHOLDER);
        assert!(parse(&partial).unwrap_err().contains("PLACEHOLDER"));
        let partial = BUNDLED_TEXT.replace("log_url = PLACEHOLDER", "log_url = https://kt.x");
        assert!(parse(&partial).is_err());
    }

    #[test]
    fn every_scheme_is_checked() {
        for (from, to) in [
            ("log_url = https://", "log_url = http://"),
            (
                "handle_assertion_url = https://",
                "handle_assertion_url = http://",
            ),
            ("relay_url = wss://", "relay_url = ws://"),
        ] {
            let text = filled().replace(from, to);
            assert!(parse(&text).is_err(), "{to} must be refused");
        }
    }

    #[test]
    fn keys_thresholds_and_postures_are_checked() {
        let cases = [
            filled().replace(A, "01"),
            filled().replace(A, &"AB".repeat(32)),
            filled().replace("threshold = 1", "threshold = 0"),
            // A log id from another log.
            filled().replace(&log_id_of_a(), B),
            filled().replace(&format!("log_id = {}\n", log_id_of_a()), ""),
            filled().replace(&format!("vrf_public_key = {C}\n"), ""),
            filled().replace("threshold = 1", "threshold = 2"),
            filled().replace("posture = internal-disposable", "posture = public"),
            filled().replace("posture = internal-disposable\n", ""),
            format!("{}witness_pk = {C}\n", filled()),
            format!("{}log_url = https://again.example\n", filled()),
            format!("{}witness_independent = true\n", filled()),
            filled().replace("relay_url = wss://relay.internal.example/relay/v1\n", ""),
        ];
        for text in cases {
            assert!(parse(&text).is_err(), "must be refused:\n{text}");
        }
    }

    #[test]
    fn two_witnesses_admit_a_threshold_of_two() {
        let text =
            format!("{}witness_pk = {A}\n", filled()).replace("threshold = 1", "threshold = 2");
        let Bundled::Configured(directory) = parse(&text).unwrap() else {
            panic!("configured");
        };
        assert_eq!(directory.witnesses.len(), 2);
        assert_eq!(directory.threshold, 2);
    }
}
