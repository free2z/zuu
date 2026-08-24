//! Configuration — a `key = value` file, parsed by hand.
//!
//! Hand-rolled for the reason `f2z-assert` hand-rolls its argument parser: this
//! runs before anything else in a security-critical binary, an operator's typo
//! must be an error rather than a default, and a reviewer should be able to
//! read the whole of it. There is no interpolation, no includes, no
//! environment expansion and no unknown-key tolerance — an unknown key is a
//! typo, and a typo in a key called `reset_authority_pk` is not something to
//! shrug at.
//!
//! ```text
//! # a comment
//! listen = 127.0.0.1:8443
//! data_dir = /var/lib/f2z-kt
//! signing_key_file = /etc/f2z-kt/log.key
//! vrf_key_file = /etc/f2z-kt/vrf.key
//! reset_authority_pk = <64 hex>
//! authority_pk = <64 hex>        # repeatable; omit entirely for no-authority
//! witness_pk = <64 hex>          # repeatable, advisory only
//! ```
//!
//! Every numeric knob has a default drawn from `KT.md`'s proposed placeholders,
//! and every one of those is **a placeholder**: §5.1 and §12 are explicit that
//! the cadence and the merge delay need measurement, and this file does not
//! pretend otherwise.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use f2z_authority::authority::{
    AuthorityConfig, AuthorityKey, AuthoritySet, DEFAULT_CLOCK_SKEW_MS, DEFAULT_MAX_VALIDITY_MS,
};
use f2z_codec::types::{PublicKey, ShortBytes};
use f2z_kt_core::{PROPOSED_EPOCH_INTERVAL_SECONDS, PROPOSED_MAX_MERGE_DELAY_SECONDS};

use crate::error::{LogError, Result};

/// The published numbers and identities a log runs on.
#[derive(Clone, Debug)]
pub struct LogSettings {
    /// The signing key `log_id` is derived from and never changes (`KT.md`
    /// §6.1). Equal to the current signing key until the first rotation.
    pub genesis_log_pk: PublicKey,
    /// The pinned reset authority key (ADR 0014). Publishing it in the
    /// descriptor does **not** discharge the requirement that clients pin it.
    pub reset_authority_pk: PublicKey,
    /// ADR 0014's cooldown, in seconds.
    pub reset_cooldown_seconds: u32,
    /// `KT.md` §5.1's cadence. A **placeholder**; §13-P.
    pub epoch_interval_seconds: u32,
    /// `KT.md` §5.2's merge promise. A **placeholder**; §13-P.
    pub max_merge_delay_seconds: u32,
    /// The widest `/kt/v1/audit` range this log will answer, in epochs
    /// (`KT.md` §9.3). Above it: `ERR_RANGE_TOO_WIDE`.
    pub max_audit_span: u32,
    /// The largest `/kt/v1/submit` body, in bytes.
    pub max_submission_bytes: usize,
    /// The largest body on every other endpoint, in bytes.
    pub max_request_bytes: usize,
    /// How many assertion nonces to remember. The ledger **refuses** rather
    /// than evicting when it is full, because evicting silently reopens the
    /// replay window under exactly the memory pressure an attacker would
    /// create.
    pub nonce_ledger_capacity: usize,
    /// A successor log signing key announcement (`KT.md` §6.4), or all-zero.
    pub successor_log_pk: PublicKey,
    /// Operator identity, for the descriptor (`KT.md` §9.1).
    pub operator_name: ShortBytes,
    /// Operator contact, for the descriptor.
    pub operator_contact: ShortBytes,
    /// Operator jurisdiction, for the descriptor.
    pub operator_jurisdiction: ShortBytes,
    /// Operator policy URL, for the descriptor.
    pub operator_policy_url: ShortBytes,
    /// Where this binary's source lives, for the descriptor.
    pub source_repo_url: ShortBytes,
    /// The commit it was built from, for the descriptor.
    pub source_commit: ShortBytes,
    /// A reproducible-build digest, for the descriptor.
    pub build_digest: ShortBytes,
}

impl LogSettings {
    /// The defaults, given the two keys that have none.
    ///
    /// # Errors
    ///
    /// [`LogError::Config`] if a descriptor string is longer than 255 bytes.
    pub fn defaults(genesis_log_pk: PublicKey, reset_authority_pk: PublicKey) -> Result<Self> {
        Ok(Self {
            genesis_log_pk,
            reset_authority_pk,
            // ADR 0014 proposes seven days.
            reset_cooldown_seconds: 7 * 24 * 60 * 60,
            epoch_interval_seconds: PROPOSED_EPOCH_INTERVAL_SECONDS,
            max_merge_delay_seconds: PROPOSED_MAX_MERGE_DELAY_SECONDS,
            max_audit_span: 64,
            max_submission_bytes: 1 << 18,
            max_request_bytes: 1 << 14,
            nonce_ledger_capacity: 1 << 16,
            successor_log_pk: PublicKey::zero(),
            operator_name: short(b"")?,
            operator_contact: short(b"")?,
            operator_jurisdiction: short(b"")?,
            operator_policy_url: short(b"")?,
            source_repo_url: short(b"https://github.com/free2z/zuu")?,
            source_commit: short(b"")?,
            build_digest: short(b"")?,
        })
    }
}

/// Everything the process needs to start.
#[derive(Clone, Debug)]
pub struct Config {
    /// The address to bind. **Plain HTTP.** See [`Config::listen`]'s note.
    pub listen: String,
    /// Where the journals live.
    pub data_dir: PathBuf,
    /// The log signing key file.
    pub signing_key_file: PathBuf,
    /// The ECVRF private key file.
    pub vrf_key_file: PathBuf,
    /// The external signing command, when built with the `kms` feature. The
    /// first element is the program.
    pub signing_command: Vec<String>,
    /// The public half of the key the signing command uses.
    pub signing_command_pk: Option<PublicKey>,
    /// The handle-assertion authorities. Empty means the **no-authority mode**,
    /// which is reported in the signed policy document.
    pub authorities: Vec<PublicKey>,
    /// The log's cap on an assertion's validity window, in milliseconds.
    pub authority_max_validity_ms: u64,
    /// The clock skew allowed an issuer, in milliseconds.
    pub authority_clock_skew_ms: u64,
    /// Cosigning keys this log recognises. Advisory only (`KT.md` §9.5).
    pub witnesses: Vec<PublicKey>,
    /// The published numbers.
    pub settings: LogSettings,
}

impl Config {
    /// Read and validate a configuration file.
    ///
    /// # Errors
    ///
    /// [`LogError::Config`] for an unreadable file, an unknown key, a malformed
    /// value, or a required key that is missing.
    pub fn load(path: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| LogError::Config(format!("{}: {error}", path.display())))?;
        Self::parse(&text)
    }

    /// Parse a configuration from text.
    ///
    /// # Errors
    ///
    /// As [`Config::load`].
    pub fn parse(text: &str) -> Result<Self> {
        let mut listen = String::from("127.0.0.1:8443");
        let mut data_dir = None;
        let mut signing_key_file = None;
        let mut vrf_key_file = None;
        let mut signing_command = Vec::new();
        let mut signing_command_pk = None;
        let mut reset_authority_pk = None;
        let mut genesis_log_pk = None;
        let mut authorities = Vec::new();
        let mut witnesses = Vec::new();
        let mut authority_max_validity_ms = DEFAULT_MAX_VALIDITY_MS;
        let mut authority_clock_skew_ms = DEFAULT_CLOCK_SKEW_MS;
        let mut numbers = Numbers::default();
        let mut strings = Strings::default();
        let mut seen = BTreeSet::new();

        for (number, raw) in text.lines().enumerate() {
            let line = raw.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                return Err(LogError::Config(format!(
                    "line {}: expected `key = value`",
                    number.saturating_add(1)
                )));
            };
            let key = key.trim();
            let value = value.trim();
            // Repeatable keys are the only ones allowed to appear twice.
            let repeatable = matches!(key, "authority_pk" | "witness_pk" | "signing_command_arg");
            if !repeatable && !seen.insert(key.to_owned()) {
                return Err(LogError::Config(format!(
                    "line {}: `{key}` is set more than once",
                    number.saturating_add(1)
                )));
            }

            match key {
                "listen" => listen = value.to_owned(),
                "data_dir" => data_dir = Some(PathBuf::from(value)),
                "signing_key_file" => signing_key_file = Some(PathBuf::from(value)),
                "vrf_key_file" => vrf_key_file = Some(PathBuf::from(value)),
                "signing_command" => signing_command.insert(0, value.to_owned()),
                "signing_command_arg" => signing_command.push(value.to_owned()),
                "signing_command_pk" => signing_command_pk = Some(public_key(key, value)?),
                "reset_authority_pk" => reset_authority_pk = Some(public_key(key, value)?),
                "genesis_log_pk" => genesis_log_pk = Some(public_key(key, value)?),
                "authority_pk" => authorities.push(public_key(key, value)?),
                "witness_pk" => witnesses.push(public_key(key, value)?),
                "authority_max_validity_ms" => authority_max_validity_ms = number_u64(key, value)?,
                "authority_clock_skew_ms" => authority_clock_skew_ms = number_u64(key, value)?,
                _ => numbers.set(key, value).or_else(|| strings.set(key, value)).ok_or_else(
                    || {
                        LogError::Config(format!(
                            "line {}: unknown key `{key}`",
                            number.saturating_add(1)
                        ))
                    },
                )??,
            }
        }

        let reset_authority_pk = reset_authority_pk.ok_or_else(|| {
            LogError::Config("reset_authority_pk is required (ADR 0014)".to_owned())
        })?;
        // `genesis_log_pk` is optional at first start: the current signing key
        // *is* the genesis key until a rotation happens, and the caller fills
        // it in. It is a separate key only after §6.4 has been exercised.
        let mut settings = LogSettings::defaults(
            genesis_log_pk.unwrap_or_else(PublicKey::zero),
            reset_authority_pk,
        )?;
        numbers.apply(&mut settings);
        strings.apply(&mut settings)?;

        Ok(Self {
            listen,
            data_dir: data_dir
                .ok_or_else(|| LogError::Config("data_dir is required".to_owned()))?,
            signing_key_file: signing_key_file.unwrap_or_else(|| PathBuf::from("log.key")),
            vrf_key_file: vrf_key_file.unwrap_or_else(|| PathBuf::from("vrf.key")),
            signing_command,
            signing_command_pk,
            authorities,
            authority_max_validity_ms,
            authority_clock_skew_ms,
            witnesses,
            settings,
        })
    }

    /// Build the `f2z-authority` policy this configuration describes.
    ///
    /// An empty `authority_pk` list is the **no-authority mode**, and it is a
    /// deliberate configuration rather than a default that happened: a log run
    /// this way tells every client so, in [`crate::policy`]'s signed document.
    ///
    /// # Errors
    ///
    /// [`LogError::Authority`] if the set or the validity cap is invalid.
    pub fn authority_config(&self, log_id: f2z_kt_core::types::LogId) -> Result<AuthorityConfig> {
        let set = if self.authorities.is_empty() {
            AuthoritySet::none()
        } else {
            AuthoritySet::new(self.authorities.iter().copied().map(AuthorityKey::new).collect())?
        };
        let log_id = f2z_authority::types::LogId::new(*log_id.as_bytes());
        Ok(AuthorityConfig::new(
            log_id,
            set,
            self.authority_max_validity_ms,
            self.authority_clock_skew_ms,
        )?)
    }
}

/// The numeric knobs, so the match arm above stays readable.
#[derive(Default)]
struct Numbers {
    reset_cooldown_seconds: Option<u32>,
    epoch_interval_seconds: Option<u32>,
    max_merge_delay_seconds: Option<u32>,
    max_audit_span: Option<u32>,
    max_submission_bytes: Option<u64>,
    max_request_bytes: Option<u64>,
    nonce_ledger_capacity: Option<u64>,
}

impl Numbers {
    fn set(&mut self, key: &str, value: &str) -> Option<Result<()>> {
        let slot32 = |target: &mut Option<u32>, value: &str| -> Result<()> {
            *target = Some(
                value
                    .parse::<u32>()
                    .map_err(|_| LogError::Config(format!("`{value}` is not a number")))?,
            );
            Ok(())
        };
        let slot64 = |target: &mut Option<u64>, value: &str| -> Result<()> {
            *target = Some(
                value
                    .parse::<u64>()
                    .map_err(|_| LogError::Config(format!("`{value}` is not a number")))?,
            );
            Ok(())
        };
        Some(match key {
            "reset_cooldown_seconds" => slot32(&mut self.reset_cooldown_seconds, value),
            "epoch_interval_seconds" => slot32(&mut self.epoch_interval_seconds, value),
            "max_merge_delay_seconds" => slot32(&mut self.max_merge_delay_seconds, value),
            "max_audit_span" => slot32(&mut self.max_audit_span, value),
            "max_submission_bytes" => slot64(&mut self.max_submission_bytes, value),
            "max_request_bytes" => slot64(&mut self.max_request_bytes, value),
            "nonce_ledger_capacity" => slot64(&mut self.nonce_ledger_capacity, value),
            _ => return None,
        })
    }

    fn apply(self, settings: &mut LogSettings) {
        if let Some(value) = self.reset_cooldown_seconds {
            settings.reset_cooldown_seconds = value;
        }
        if let Some(value) = self.epoch_interval_seconds {
            settings.epoch_interval_seconds = value;
        }
        if let Some(value) = self.max_merge_delay_seconds {
            settings.max_merge_delay_seconds = value;
        }
        if let Some(value) = self.max_audit_span {
            settings.max_audit_span = value;
        }
        if let Some(value) = self.max_submission_bytes {
            settings.max_submission_bytes = usize::try_from(value).unwrap_or(usize::MAX);
        }
        if let Some(value) = self.max_request_bytes {
            settings.max_request_bytes = usize::try_from(value).unwrap_or(usize::MAX);
        }
        if let Some(value) = self.nonce_ledger_capacity {
            settings.nonce_ledger_capacity = usize::try_from(value).unwrap_or(usize::MAX);
        }
    }
}

/// The descriptor strings.
#[derive(Default)]
struct Strings {
    operator_name: Option<String>,
    operator_contact: Option<String>,
    operator_jurisdiction: Option<String>,
    operator_policy_url: Option<String>,
    source_repo_url: Option<String>,
    source_commit: Option<String>,
    build_digest: Option<String>,
}

impl Strings {
    fn set(&mut self, key: &str, value: &str) -> Option<Result<()>> {
        let target = match key {
            "operator_name" => &mut self.operator_name,
            "operator_contact" => &mut self.operator_contact,
            "operator_jurisdiction" => &mut self.operator_jurisdiction,
            "operator_policy_url" => &mut self.operator_policy_url,
            "source_repo_url" => &mut self.source_repo_url,
            "source_commit" => &mut self.source_commit,
            "build_digest" => &mut self.build_digest,
            _ => return None,
        };
        *target = Some(value.to_owned());
        Some(Ok(()))
    }

    fn apply(self, settings: &mut LogSettings) -> Result<()> {
        if let Some(value) = self.operator_name {
            settings.operator_name = short(value.as_bytes())?;
        }
        if let Some(value) = self.operator_contact {
            settings.operator_contact = short(value.as_bytes())?;
        }
        if let Some(value) = self.operator_jurisdiction {
            settings.operator_jurisdiction = short(value.as_bytes())?;
        }
        if let Some(value) = self.operator_policy_url {
            settings.operator_policy_url = short(value.as_bytes())?;
        }
        if let Some(value) = self.source_repo_url {
            settings.source_repo_url = short(value.as_bytes())?;
        }
        if let Some(value) = self.source_commit {
            settings.source_commit = short(value.as_bytes())?;
        }
        if let Some(value) = self.build_digest {
            settings.build_digest = short(value.as_bytes())?;
        }
        Ok(())
    }
}

fn short(bytes: &[u8]) -> Result<ShortBytes> {
    ShortBytes::new(bytes.to_vec())
        .map_err(|_| LogError::Config("a descriptor field exceeds 255 bytes".to_owned()))
}

fn public_key(key: &str, value: &str) -> Result<PublicKey> {
    crate::hexbytes::decode_array::<32>(value)
        .map(PublicKey::new)
        .ok_or_else(|| LogError::Config(format!("`{key}` is not 64 hex characters")))
}

fn number_u64(key: &str, value: &str) -> Result<u64> {
    value
        .parse::<u64>()
        .map_err(|_| LogError::Config(format!("`{key}` is not a number")))
}

#[cfg(test)]
mod tests {
    use super::Config;

    const MINIMAL: &str = "
        data_dir = /var/lib/f2z-kt
        reset_authority_pk = 0101010101010101010101010101010101010101010101010101010101010101
    ";

    #[test]
    fn the_minimal_configuration_is_a_data_dir_and_a_pinned_reset_key() {
        let config = Config::parse(MINIMAL).unwrap();
        assert_eq!(config.data_dir.to_string_lossy(), "/var/lib/f2z-kt");
        assert_eq!(
            config.settings.epoch_interval_seconds,
            f2z_kt_core::PROPOSED_EPOCH_INTERVAL_SECONDS
        );
        assert!(
            config.authorities.is_empty(),
            "no authority configured is the reported no-authority mode, not an error"
        );
    }

    #[test]
    fn a_typo_is_an_error_rather_than_a_default() {
        let text = format!("{MINIMAL}\nepoch_intervall_seconds = 5\n");
        let error = Config::parse(&text).unwrap_err();
        assert!(format!("{error}").contains("unknown key"));
    }

    #[test]
    fn a_missing_reset_authority_key_refuses_to_start() {
        let error = Config::parse("data_dir = /tmp/x").unwrap_err();
        assert!(format!("{error}").contains("reset_authority_pk"));
    }

    #[test]
    fn a_key_set_twice_is_an_error_but_the_repeatable_ones_are_not() {
        let doubled = format!("{MINIMAL}\ndata_dir = /elsewhere\n");
        assert!(Config::parse(&doubled).is_err());

        let two_authorities = format!(
            "{MINIMAL}\nauthority_pk = {}\nauthority_pk = {}\n",
            "02".repeat(32),
            "03".repeat(32)
        );
        let config = Config::parse(&two_authorities).unwrap();
        assert_eq!(config.authorities.len(), 2);
    }

    #[test]
    fn a_short_public_key_is_refused_rather_than_padded() {
        let text = format!("{MINIMAL}\nauthority_pk = 0102\n");
        assert!(Config::parse(&text).is_err());
    }
}
