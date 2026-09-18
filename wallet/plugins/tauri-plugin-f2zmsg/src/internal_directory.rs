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
//! The file shipped with every key and URL set to `PLACEHOLDER` until zuu#1022
//! workstream 9 deployed the log, the witness, the handle authority and the
//! relay; it now carries their real values, and [`bundled`] answers
//! [`Bundled::Configured`]. With any key or URL still `PLACEHOLDER` the answer
//! is [`Bundled::Unconfigured`]: the engine keeps
//! [`crate::directory::NoDirectory`] and no relay is added — the state
//! `PLACEHOLDER_TEXT` keeps under test. A half-filled file
//! is **malformed**, not partially configured, and malformed is a **compile
//! error**: `build.rs` runs [`syntax::parse`] — the same function this module
//! runs — over the file and fails the build, so no binary can carry one. The
//! runtime still re-checks and treats an error as unconfigured, which is
//! unreachable in a build that compiled and costs nothing to keep. There is no
//! environment variable and no runtime override: the only way to point a
//! build at a log is a reviewed change to that one file.
//!
//! # What the posture does not let the file say
//!
//! Witness **independence**. Every `witness_pk` here becomes a
//! [`crate::directory::WitnessConfig`] with `independent: false`, because the
//! internal posture is precisely that free2z operates the log and the witness
//! (`KT.md` §8.3). The threshold is met and the independent count is zero, so
//! `EngineStatus.independentWitnesses` stays `0` and the UI's warning stays up.

use std::time::Duration;

use f2z_codec::types::PublicKey;

use crate::directory::{DirectoryConfig, WitnessConfig};

pub mod syntax;

/// `build.rs`'s own `log_id`, compiled here only so a test can compare it.
#[cfg(test)]
#[path = "internal_directory/log_id.rs"]
mod build_log_id;

pub use syntax::{MIN_RESET_COOLDOWN_SECONDS, PLACEHOLDER, POSTURE};

/// The file, as compiled into this build.
pub const BUNDLED_TEXT: &str = include_str!("../internal-directory.conf");

/// The unfilled file, as a **test fixture only** — never compiled into a build.
///
/// [`BUNDLED_TEXT`] now carries the internal deployment's real values, so it is
/// no longer an instance of the state the fail-closed rule is about. This is,
/// in the same grammar, and the tests below prove `Unconfigured` over it and
/// hold it to the shipped file's key set.
#[cfg(test)]
pub const PLACEHOLDER_TEXT: &str = include_str!("internal_directory/placeholder.conf");

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
    /// Contract C: the key a `HandleAssertion` must be signed by — and the
    /// one key the log's signed authority policy must list (ADR 0017 §3).
    pub handle_authority_pk: [u8; 32],
    /// Contract C: where the enrolling wallet fetches one, `https://`.
    pub handle_assertion_url: String,
    /// The relay a fresh engine is configured with, `wss://`.
    pub relay_url: String,
    /// Genesis keys of log generations this build has deliberately left. A
    /// device's stored checkpoint from one of them is set aside; a checkpoint
    /// from any other log is refused (ADR 0017 §3).
    pub retired_log_public_keys: Vec<[u8; 32]>,
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
            required_authority: Some(self.handle_authority_pk),
            retired_log_public_keys: self.retired_log_public_keys.clone(),
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

/// Parse the file's text: [`syntax::parse`] with `KT.md` §6.1's `log_id`.
///
/// # Errors
///
/// A description of the first problem: an unknown or repeated key, a missing
/// one, a posture other than [`POSTURE`], a mix of placeholder and real
/// values, a value that is not printable ASCII or carries a `#`, a URL with
/// the wrong scheme or no plain host, a key that is not 64 lowercase hex
/// characters, a duplicate witness or retired key, a cooldown under
/// [`MIN_RESET_COOLDOWN_SECONDS`], or a threshold outside `1..=witnesses`.
pub fn parse(text: &str) -> Result<Bundled, String> {
    Ok(match syntax::parse(text, &log_id_of)? {
        syntax::Outcome::Unconfigured => Bundled::Unconfigured(
            "internal-directory.conf still carries PLACEHOLDER values".to_owned(),
        ),
        syntax::Outcome::Configured(parsed) => {
            let syntax::Parsed {
                log_url,
                log_public_key,
                log_id,
                vrf_public_key,
                reset_authority_pk,
                reset_cooldown_seconds,
                witnesses,
                threshold,
                handle_authority_pk,
                handle_assertion_url,
                relay_url,
                retired_log_public_keys,
            } = *parsed;
            Bundled::Configured(Box::new(InternalDirectory {
                log_url,
                log_public_key,
                log_id,
                vrf_public_key,
                reset_authority_pk,
                reset_cooldown_seconds,
                witnesses,
                threshold,
                handle_authority_pk,
                handle_assertion_url,
                relay_url,
                retired_log_public_keys,
            }))
        }
    })
}

fn log_id_of(public_key: &[u8; 32]) -> [u8; 32] {
    *f2z_kt_core::labels::log_id(&PublicKey::new(*public_key)).as_bytes()
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
        // `build.rs` already refused to compile a malformed file; this is the
        // same verdict through the runtime path.
        assert!(parse(BUNDLED_TEXT).is_ok(), "{:?}", parse(BUNDLED_TEXT));
    }

    #[test]
    fn the_build_time_log_id_is_the_protocol_log_id() {
        // `build.rs` checks `log_id` with its own BLAKE2b; it must be exactly
        // `KT.md` §6.1's, or the compile-time check refuses good files (or
        // passes bad ones).
        for seed in [
            [0u8; 32],
            [1; 32],
            [0xa1; 32],
            *b"0123456789abcdef0123456789abcdef",
        ] {
            assert_eq!(super::build_log_id::log_id(&seed), log_id_of(&seed));
        }
    }

    #[test]
    fn the_build_script_runs_the_runtime_grammar() {
        // The compile-time guarantee is only as good as the claim that
        // build.rs parses with THIS grammar and fails the build on an error.
        let script = include_str!("../build.rs");
        assert!(script.contains("#[path = \"src/internal_directory/syntax.rs\"]"));
        assert!(script.contains("directory_syntax::parse(&text"));
        assert!(script.contains("std::process::exit(1)"));
        assert!(script.contains("check_internal_directory();"));
    }

    #[test]
    fn a_hash_is_never_a_trailing_comment() {
        // The old parser cut each line at its first `#`, so this configured
        // `https://kt.internal.example` without a word.
        for text in [
            filled().replace(
                "log_url = https://kt.internal.example",
                "log_url = https://kt.internal.example#.evil.example",
            ),
            filled().replace(
                "relay_url = wss://relay.internal.example/relay/v1",
                "relay_url = wss://relay.internal.example/relay/v1 # the relay",
            ),
            filled().replace("threshold = 1", "threshold = 1#2"),
            BUNDLED_TEXT.replace("threshold = 1", "threshold = 1 # t"),
        ] {
            let refusal = parse(&text).unwrap_err();
            assert!(refusal.contains('#'), "{refusal}");
        }
        // A whole-line comment, indented or not, is still a comment.
        assert!(parse(&format!("  # note\n{}# end\n", filled())).is_ok());
    }

    #[test]
    fn values_are_printable_ascii_only() {
        for text in [
            // A zero-width space inside the host.
            filled().replace("kt.internal.example", "kt.inter\u{200b}nal.example"),
            // A Cyrillic `а` for the Latin one.
            filled().replace("relay.internal.example", "rel\u{0430}y.internal.example"),
            // A no-break space inside the value.
            filled().replace(
                "/api/kt/handle-assertion/",
                "/api/kt/handle\u{00a0}assertion/",
            ),
            // A plain space inside the value.
            filled().replace(
                "relay.internal.example/relay/v1",
                "relay.internal.example /relay/v1",
            ),
            // A tab inside the value.
            filled().replace("threshold = 1", "threshold = 1\t1"),
            // Empty.
            filled().replace(
                "relay_url = wss://relay.internal.example/relay/v1",
                "relay_url =",
            ),
        ] {
            let refusal = parse(&text).unwrap_err();
            assert!(refusal.contains("printable ASCII"), "{refusal}\n{text}");
        }
        // Comment prose may carry any UTF-8.
        assert!(parse(&format!("# ADR 0017 — the internal log\n{}", filled())).is_ok());
    }

    #[test]
    fn urls_name_a_plain_host() {
        for (from, to) in [
            (
                "https://kt.internal.example",
                "https://free2z.cash@kt.internal.example",
            ),
            (
                "https://kt.internal.example",
                "https://kt.internal.example\\@x",
            ),
            (
                "https://kt.internal.example",
                "https:///kt.internal.example",
            ),
            ("https://kt.internal.example", "https://:443"),
            ("https://kt.internal.example", "https://kt_internal.example"),
            ("wss://relay.internal.example/relay/v1", "wss://?relay"),
        ] {
            assert!(
                parse(&filled().replace(from, to)).is_err(),
                "{to} must be refused"
            );
        }
        let with_port = filled().replace(
            "https://kt.internal.example",
            "https://kt.internal.example:8443",
        );
        assert!(parse(&with_port).unwrap().configured().is_some());
    }

    #[test]
    fn the_reset_cooldown_has_a_floor() {
        let below = MIN_RESET_COOLDOWN_SECONDS - 1;
        for text in [
            filled().replace(
                "reset_cooldown_seconds = 604800",
                &format!("reset_cooldown_seconds = {below}"),
            ),
            filled().replace(
                "reset_cooldown_seconds = 604800",
                "reset_cooldown_seconds = 60",
            ),
            filled().replace(
                "reset_cooldown_seconds = 604800",
                "reset_cooldown_seconds = 0",
            ),
            // The unconfigured file is held to it too: the floor is not a
            // surprise that waits for deployment day.
            BUNDLED_TEXT.replace(
                "reset_cooldown_seconds = 604800",
                "reset_cooldown_seconds = 60",
            ),
        ] {
            assert!(parse(&text).unwrap_err().contains("reset_cooldown_seconds"));
        }
        let at_floor = filled().replace(
            "reset_cooldown_seconds = 604800",
            &format!("reset_cooldown_seconds = {MIN_RESET_COOLDOWN_SECONDS}"),
        );
        assert!(parse(&at_floor).is_ok());
        assert_eq!(MIN_RESET_COOLDOWN_SECONDS, 604_800);
    }

    #[test]
    fn retired_generations_are_real_distinct_and_not_the_current_log() {
        let text = format!(
            "{}retired_log_public_key = {B}\nretired_log_public_key = {C}\n",
            filled()
        );
        let Bundled::Configured(directory) = parse(&text).unwrap() else {
            panic!("configured");
        };
        assert_eq!(directory.retired_log_public_keys, vec![[2; 32], [3; 32]]);
        assert_eq!(
            directory.directory_config().retired_log_public_keys,
            vec![[2; 32], [3; 32]]
        );
        assert!(
            parse(&filled())
                .unwrap()
                .configured()
                .unwrap()
                .retired_log_public_keys
                .is_empty()
        );

        for text in [
            format!(
                "{}retired_log_public_key = {B}\nretired_log_public_key = {B}\n",
                filled()
            ),
            format!("{}retired_log_public_key = {A}\n", filled()),
            format!("{}retired_log_public_key = {PLACEHOLDER}\n", filled()),
            format!("{}retired_log_public_key = {PLACEHOLDER}\n", BUNDLED_TEXT),
            format!("{PLACEHOLDER_TEXT}retired_log_public_key = {PLACEHOLDER}\n"),
            // The shipped file's own genesis key is not a generation it left.
            format!(
                "{BUNDLED_TEXT}retired_log_public_key = \
                 650b5cadbe37ad0054bbcfd77e202917318ca3fd847ac835f810bfb41c913e61\n"
            ),
        ] {
            assert!(parse(&text).is_err(), "must be refused:\n{text}");
        }
    }

    #[test]
    fn the_bundled_authority_becomes_the_required_authority() {
        let Bundled::Configured(directory) = parse(&filled()).unwrap() else {
            panic!("configured");
        };
        assert_eq!(
            directory.directory_config().required_authority,
            Some([4; 32])
        );
    }

    #[test]
    fn a_placeholder_file_fails_closed() {
        // The property the shipped file used to carry itself. It is deployed
        // now, so the fixture carries it: a file whose deployable values are
        // all `PLACEHOLDER` configures NOTHING — not a log, not a relay, not a
        // partial anything.
        let parsed = parse(PLACEHOLDER_TEXT).expect("a well-formed unfilled file");
        assert!(matches!(parsed, Bundled::Unconfigured(_)), "{parsed:?}");
        assert!(parsed.configured().is_none());
        let Bundled::Unconfigured(reason) = parsed else {
            unreachable!()
        };
        assert!(reason.contains("PLACEHOLDER"), "{reason}");
    }

    #[test]
    fn the_placeholder_fixture_declares_the_shipped_files_keys() {
        // The fixture is only worth having while it is the shipped file with
        // its values removed. A key added to one and not the other would leave
        // fail-closed proven over a grammar nothing ships.
        fn settings(text: &str) -> Vec<(&str, &str)> {
            let mut settings: Vec<(&str, &str)> = text
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty() && !line.starts_with('#'))
                .map(|line| {
                    let (key, value) = line.split_once('=').unwrap_or((line, ""));
                    (key.trim(), value.trim())
                })
                .collect();
            settings.sort_unstable();
            settings
        }
        let fixture = settings(PLACEHOLDER_TEXT);
        let shipped = settings(BUNDLED_TEXT);
        assert_eq!(
            fixture.iter().map(|(key, _)| *key).collect::<Vec<_>>(),
            shipped.iter().map(|(key, _)| *key).collect::<Vec<_>>()
        );
        // The fixture is unfilled wherever a value is deployable, and the
        // shipped file is filled there. `PLACEHOLDER` appears in both files'
        // *prose*, which is why this reads settings and not the whole text.
        assert!(
            fixture
                .iter()
                .any(|(key, value)| *key == "log_url" && *value == PLACEHOLDER)
        );
        assert!(
            !shipped.iter().any(|(_, value)| *value == PLACEHOLDER),
            "the shipped file carries no placeholder value"
        );
    }

    #[test]
    fn the_shipped_file_configures_the_internal_deployment() {
        // zuu#1022 workstream 9's deployed values, each verified against the
        // live service before this file was filled in: the log's signed tree
        // head verifies under `log_public_key` and carries this `log_id`, its
        // heads carry this `vrf_public_key`, its §4.6 policy vouches for
        // exactly this `handle_authority_pk`, and
        // `GET https://free2z.cash/api/e2ee/authority/` publishes the same key.
        let Bundled::Configured(directory) = bundled() else {
            panic!(
                "the shipped file configures the internal directory: {:?}",
                bundled()
            );
        };
        assert_eq!(directory.log_url, "https://kt.free2z.cash");
        assert_eq!(
            hex::encode(directory.log_public_key),
            "650b5cadbe37ad0054bbcfd77e202917318ca3fd847ac835f810bfb41c913e61"
        );
        assert_eq!(
            hex::encode(directory.log_id),
            "05b5dc5aa07ecae55442b8b32b6b8bebcc6490031112caa30adefa84070dc7e9"
        );
        assert_eq!(
            hex::encode(directory.vrf_public_key),
            "6b86eeff3c36a159f2841b16b73568bc85f60ba6aa7a0478eff2d3d2ac4b7706"
        );
        assert_eq!(
            hex::encode(directory.reset_authority_pk),
            "98d24429bc467cd94f2d4863ae84d50d5321c93030389bc144fd75f1afb34db3"
        );
        assert_eq!(directory.reset_cooldown_seconds, MIN_RESET_COOLDOWN_SECONDS);
        assert_eq!(
            directory
                .witnesses
                .iter()
                .map(hex::encode)
                .collect::<Vec<_>>(),
            vec!["98868a0c8239837425f4fbb9e5293691940457d5fd0ccd4aff465701f8669518"]
        );
        assert_eq!(directory.threshold, 1);
        assert_eq!(
            hex::encode(directory.handle_authority_pk),
            "332e237e2f9db842905c2a6011f4d306824b2f33eef01686d5b29d69e843934f"
        );
        assert_eq!(
            directory.handle_assertion_url,
            "https://free2z.cash/api/kt/handle-assertion/"
        );
        assert_eq!(directory.relay_url, "wss://relay.free2z.cash/relay/v1");
        // Nothing has been wiped yet, so no generation has been left behind.
        assert!(directory.retired_log_public_keys.is_empty());

        // The posture, restated where it is used: one witness, free2z's own,
        // counted as NOT independent, so the warning stays on screen.
        let config = directory.directory_config();
        assert_eq!(config.witnesses.len(), 1);
        assert!(!config.witnesses[0].independent);
        assert_eq!(config.threshold, 1);
        assert_eq!(config.base_url, "https://kt.free2z.cash");
        assert_eq!(config.vrf_public_key, Some(directory.vrf_public_key));
        // ADR 0017 §3 / #1027: the log must vouch for exactly this authority,
        // and this is the value the client holds it to.
        assert_eq!(
            config.required_authority,
            Some(directory.handle_authority_pk)
        );

        // `KT.md` §6.1, derived here rather than read from the file — the same
        // check `build.rs` made, restated so a pasted-in pair from two
        // different logs cannot survive review.
        assert_eq!(
            f2z_kt_core::labels::log_id(&PublicKey::new(directory.log_public_key)).as_bytes(),
            &directory.log_id
        );
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
        let partial = PLACEHOLDER_TEXT.replace("log_url = PLACEHOLDER", "log_url = https://kt.x");
        assert!(parse(&partial).is_err());
        // And the other direction, over the file that actually ships: knocking
        // one deployed value back out is malformed, not "mostly configured".
        let partial = BUNDLED_TEXT.replace(
            "relay_url = wss://relay.free2z.cash/relay/v1",
            "relay_url = PLACEHOLDER",
        );
        assert!(parse(&partial).unwrap_err().contains("PLACEHOLDER"));
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
