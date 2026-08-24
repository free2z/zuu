//! What an operator configures, where the values come from, and what the
//! defaults assume about the machine.
//!
//! # Three sources, one precedence
//!
//! **flags > environment > file > default.** A file is optional; a relay with
//! no file at all starts on the defaults below, which is what makes
//! `docker run f2z-relay` a sentence rather than a project.
//!
//! Every key is spellable in all three, and the mapping is mechanical: the
//! file's `[limits] max_inflight` is `F2Z_RELAY_LIMITS_MAX_INFLIGHT` in the
//! environment. Unknown keys in the file are an **error**, not a warning: a
//! mistyped `max_queue_byes` that silently kept the default would be a quota an
//! operator believes they set.
//!
//! # The defaults are sized for a 1 GB VPS, and that is a decision
//!
//! [ADR 0005](https://github.com/free2z/zuu/blob/main/docs/e2ee/decisions/0005-federation.md)
//! puts the economics of the whole federation on a cheap box, so the defaults
//! are what that box can actually hold rather than what a benchmark likes:
//!
//! | Knob | Default | Why that number |
//! |---|---|---|
//! | `limits.max_connections` | 512 | Each connection is a task, two buffers and a subscription set. 512 is a few MB and leaves the page cache the rest. |
//! | `limits.antireplay_seen_max` | 65 536 | ~3 MB of `(key, nonce)` pairs. §5.5 refuses rather than evicts, so this is a hard ceiling on a *bounded* structure. |
//! | `limits.storage_high_water_bytes` | 8 GiB | §13.1 layer 4 turns on here. The point is to hit backpressure before the filesystem does, because a full disk is not a graceful refusal. |
//! | `limits.max_queues` | 50 000 | Bounds the row count the idle sweep walks, which is the one periodic cost proportional to queues rather than to traffic. |
//! | `commit.window_ms` | 5 | See [`crate::commit`]. Long enough to gather a batch at any rate worth batching, short enough to be invisible next to a WAN round trip. |
//!
//! # Secrets
//!
//! One value here is key material: `identity.seed`, which exists so a container
//! with no persistent volume can be handed its identity through the
//! environment. `--print-config` renders it as `"<redacted>"`, and
//! `tests/redaction.rs` proves it.

use std::collections::BTreeMap;
use std::fmt::Write as _;
use std::net::SocketAddr;
use std::path::PathBuf;

use f2z_relay_proto::SeenSet;
use serde::Deserialize;

use crate::log::Level;

/// Why a configuration could not be built.
#[derive(Debug)]
pub enum ConfigError {
    /// The file could not be read.
    Read(PathBuf, std::io::Error),
    /// The file is not valid TOML, or carries a key this build does not know.
    Parse(String),
    /// A value is present but unusable, naming the key and what is wrong.
    Invalid(&'static str, String),
    /// A flag was given that this build does not know.
    UnknownFlag(String),
    /// A flag that takes a value was given none.
    MissingValue(&'static str),
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Read(path, error) => write!(f, "cannot read {}: {error}", path.display()),
            Self::Parse(detail) => write!(f, "configuration file: {detail}"),
            Self::Invalid(key, detail) => write!(f, "{key}: {detail}"),
            Self::UnknownFlag(flag) => write!(f, "unknown flag {flag}; try --help"),
            Self::MissingValue(flag) => write!(f, "{flag} needs a value"),
        }
    }
}

impl std::error::Error for ConfigError {}

type Result<T> = core::result::Result<T, ConfigError>;

// ---------------------------------------------------------------------------
// The shape.
// ---------------------------------------------------------------------------

/// Everything a relay is configured with.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// The public WebSocket listener (§2.1, §2.3).
    pub listen: Listen,
    /// The loopback-only operational listener.
    pub admin: Admin,
    /// Where queues live.
    pub store: Store,
    /// The relay's long-term Ed25519 identity (§5.2).
    pub identity: Identity,
    /// The group-commit writer.
    pub commit: Commit,
    /// The numbers §13.1 layers 1 and 4 are made of.
    pub limits: Limits,
    /// §7.7's TTL bands.
    pub queues: Queues,
    /// §9's bucket set.
    pub padding: Padding,
    /// §13.1 layers 2 and 3, and §12.3.
    pub antiabuse: AntiAbuse,
    /// §11.1's operator block — "the point of the document".
    pub operator: Operator,
    /// §11.1's provenance block.
    pub provenance: Provenance,
    /// How much the relay says. See [`crate::log`] for what it may not say.
    pub log: Log,
}

/// The public listener.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Listen {
    /// The address to bind.
    pub address: String,
    /// §2.3's override. Binding a non-loopback address without TLS is a startup
    /// **failure** unless this is set, and setting it is published in the
    /// capability document as `transport_security: none`.
    pub insecure: bool,
    /// PEM certificate chain. Both this and `tls_key` present means TLS.
    pub tls_cert: String,
    /// PEM private key.
    pub tls_key: String,
    /// §2.5's cap between accept and a valid `HELLO`.
    pub handshake_timeout_ms: u32,
    /// §2.4's server-driven Ping interval.
    pub ping_interval_seconds: u16,
    /// §2.4: close after this many consecutive missed Pongs.
    pub missed_pongs_before_close: u32,
}

/// The loopback-only operational listener.
///
/// **Deliberately not the public port.** `/healthz` and `/metrics` are an
/// operator interface; exposing them is how a relay ends up publishing queue
/// depth and connection counts to anyone who asks, which is metadata the whole
/// design refuses to disclose over the protocol.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Admin {
    /// Whether to serve it at all.
    pub enabled: bool,
    /// The address. Refused at startup if it is not loopback.
    pub address: String,
}

/// Storage.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Store {
    /// `sqlite` (durable, §11.1's `fsync-per-append`) or `memory` (volatile).
    pub backend: String,
    /// The SQLite file. Ignored by the memory backend.
    pub path: String,
}

/// The identity key.
#[derive(Clone, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Identity {
    /// Where the 32-byte seed lives.
    pub path: String,
    /// Create the file if it is missing. Off in production deployments that
    /// provision keys out of band, so a lost volume fails loudly instead of
    /// silently becoming a different relay.
    pub generate: bool,
    /// The seed itself, 64 hex characters, for a container with no volume.
    ///
    /// **Key material.** Overrides `path` when set, and is what
    /// `--print-config` redacts.
    pub seed: String,
}

// The seed is the relay's long-term private key. A derived `Debug` would put it
// in any error that ever formats a Config.
impl std::fmt::Debug for Identity {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Identity")
            .field("path", &self.path)
            .field("generate", &self.generate)
            .field(
                "seed",
                if self.seed.is_empty() {
                    &"<unset>"
                } else {
                    &"<redacted>"
                },
            )
            .finish()
    }
}

/// The group-commit writer (§8.4, and [`crate::commit`]).
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Commit {
    /// How long a batch gathers before it commits.
    pub window_ms: u32,
    /// The most appends one transaction takes.
    pub max_batch: u32,
}

/// §13.1's numbers.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Limits {
    /// §4.1's published frame cap.
    pub max_frame_bytes: u32,
    /// §4.3's published in-flight window.
    pub max_inflight: u16,
    /// §5.5's published timestamp window.
    pub clock_skew_ms: u32,
    /// §5.5's published seen-set retention. MUST be at least twice
    /// `clock_skew_ms` — see [`Config::check`] and issue #586.
    pub antireplay_window_ms: u32,
    /// §5.5's published seen-set bound. On reaching it the relay refuses new
    /// signed commands with `ERR_BACKPRESSURE`; it never evicts.
    pub antireplay_seen_max: u32,
    /// §13.1 layer 1: concurrent connections, all sources.
    pub max_connections: u32,
    /// §13.1 layer 1: concurrent connections from one source address.
    pub max_connections_per_source: u32,
    /// §13.1 layer 1: new connections per second from one source address.
    pub new_connections_per_source_per_second: u32,
    /// §13.1 layer 1: commands per second on one connection.
    pub commands_per_connection_per_second: u32,
    /// §6.1: `GET_CHALLENGE` per minute per source, "or it becomes the cheapest
    /// way to make the relay do work".
    pub challenges_per_source_per_minute: u32,
    /// §13.1 layer 3: how many queues may exist at once.
    pub max_queues: u64,
    /// §13.1 layer 2's published per-queue message cap.
    pub max_queue_messages: u32,
    /// §13.1 layer 2's published per-queue byte cap.
    pub max_queue_bytes: u64,
    /// §13.1 layer 4: storage above this turns backpressure on.
    pub storage_high_water_bytes: u64,
    /// How many outbound frames one connection may have queued before the relay
    /// stops producing for it (§13.1's "not to unbounded server-side
    /// buffering").
    pub max_outbound_queue: u32,
}

/// §7.7's TTL bands, and how often they are swept.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Queues {
    /// The floor a request is clamped up to.
    pub min_message_ttl_seconds: u32,
    /// The ceiling. MUST NOT exceed 30 days (§7.7, §11.3 step 5).
    pub max_message_ttl_seconds: u32,
    /// What `req_message_ttl_seconds = 0` ("no preference") is granted.
    pub default_message_ttl_seconds: u32,
    /// The idle floor.
    pub min_idle_ttl_seconds: u32,
    /// The idle ceiling.
    pub max_idle_ttl_seconds: u32,
    /// What `req_idle_ttl_seconds = 0` is granted.
    pub default_idle_ttl_seconds: u32,
    /// How often the expiry tick runs.
    pub expiry_tick_seconds: u32,
}

/// §9's published bucket set.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Padding {
    /// Strictly ascending, non-empty, no zero.
    pub sizes: Vec<u32>,
    /// §9's client-side chunk size.
    pub max_chunk_bytes: u32,
}

/// §13.1 layer 3 and §12.3.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct AntiAbuse {
    /// `open`, `pow` (the default) or `token`.
    pub queue_creation_mode: String,
    /// Leading zero bits a queue-creation stamp must show.
    pub queue_creation_pow_bits: u8,
    /// Leading zero bits a `CONTACT_APPEND` stamp must show.
    pub contact_append_pow_bits: u8,
    /// How long a `GET_CHALLENGE` challenge stays spendable.
    pub challenge_ttl_ms: u32,
    /// The most challenges the relay will hold at once. Reaching it is
    /// `ERR_BACKPRESSURE` on `GET_CHALLENGE`, never an eviction: an evicted
    /// challenge is a client whose stamp becomes invalid after it paid for it.
    pub max_challenges: u32,
    /// §12: whether first contact is offered here at all.
    pub contact_queues_enabled: bool,
    /// §12.3's pending cap.
    pub contact_max_pending: u32,
    /// §12.3's byte cap.
    pub contact_max_bytes: u64,
    /// §13.3: published so a user behind shared egress can choose a relay that
    /// does not use them.
    pub per_source_limits: bool,
}

/// §11.1's operator block.
///
/// Every field defaults to empty, and §11.1 is explicit that a relay publishing
/// this unedited "is publishing a document that answers none of the questions it
/// exists to answer". The emptiness is deliberate — inventing an operator name
/// would be worse — and it is what an operator is expected to fill in.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Operator {
    /// Who runs it.
    pub name: String,
    /// How to reach a human.
    pub contact: String,
    /// Where abuse reports go.
    pub abuse_contact: String,
    /// Where the operator and the hardware sit. §11.1: a user choosing among
    /// *k* relays is making a jurisdictional choice whether or not anyone tells
    /// them so.
    pub jurisdiction: String,
    /// The published policy.
    pub policy_url: String,
}

/// §11.1's provenance block — what turns "open source and self-hostable" into
/// something a third party can check.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Provenance {
    /// Where the source is.
    pub source_repo_url: String,
    /// The commit this binary was built from.
    pub source_commit: String,
    /// A reproducible-build digest of the running binary.
    pub build_digest: String,
}

/// Logging.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(default, deny_unknown_fields)]
pub struct Log {
    /// `off`, `error`, `warn`, `info`, `debug`, `trace`.
    pub level: String,
}

// ---------------------------------------------------------------------------
// Defaults.
// ---------------------------------------------------------------------------

impl Default for Listen {
    fn default() -> Self {
        Self {
            // Loopback, so the out-of-the-box relay is one §2.3 permits without
            // an override. An operator who wants the internet says so.
            address: "127.0.0.1:8443".to_owned(),
            insecure: false,
            tls_cert: String::new(),
            tls_key: String::new(),
            handshake_timeout_ms: 10_000,
            ping_interval_seconds: 25,
            missed_pongs_before_close: 2,
        }
    }
}

impl Default for Admin {
    fn default() -> Self {
        Self {
            enabled: true,
            address: "127.0.0.1:9101".to_owned(),
        }
    }
}

impl Default for Store {
    fn default() -> Self {
        Self {
            backend: "sqlite".to_owned(),
            path: "relay.sqlite".to_owned(),
        }
    }
}

impl Default for Identity {
    fn default() -> Self {
        Self {
            path: "relay-identity.key".to_owned(),
            generate: true,
            seed: String::new(),
        }
    }
}

impl Default for Commit {
    fn default() -> Self {
        Self {
            window_ms: 5,
            max_batch: 256,
        }
    }
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_frame_bytes: 1024 * 1024,
            max_inflight: 32,
            clock_skew_ms: 120_000,
            antireplay_window_ms: 240_000,
            antireplay_seen_max: 65_536,
            max_connections: 512,
            max_connections_per_source: 16,
            new_connections_per_source_per_second: 8,
            commands_per_connection_per_second: 64,
            challenges_per_source_per_minute: 60,
            max_queues: 50_000,
            max_queue_messages: 4_096,
            max_queue_bytes: 64 * 1024 * 1024,
            storage_high_water_bytes: 8 * 1024 * 1024 * 1024,
            max_outbound_queue: 256,
        }
    }
}

impl Default for Queues {
    fn default() -> Self {
        Self {
            min_message_ttl_seconds: 60,
            max_message_ttl_seconds: f2z_codec::MAX_MESSAGE_TTL_SECONDS,
            default_message_ttl_seconds: 604_800,
            min_idle_ttl_seconds: 3_600,
            max_idle_ttl_seconds: 31_536_000,
            default_idle_ttl_seconds: 7_776_000,
            expiry_tick_seconds: 60,
        }
    }
}

impl Default for Padding {
    fn default() -> Self {
        Self {
            sizes: f2z_codec::padding::PROPOSED_BUCKETS.to_vec(),
            max_chunk_bytes: f2z_codec::padding::DEFAULT_MAX_CHUNK_BYTES,
        }
    }
}

impl Default for AntiAbuse {
    fn default() -> Self {
        Self {
            // §13.1: "`pow` — **the default.**"
            queue_creation_mode: "pow".to_owned(),
            queue_creation_pow_bits: 20,
            contact_append_pow_bits: 20,
            challenge_ttl_ms: 60_000,
            max_challenges: 65_536,
            contact_queues_enabled: true,
            contact_max_pending: 64,
            contact_max_bytes: 256 * 1024,
            per_source_limits: true,
        }
    }
}

impl Default for Provenance {
    fn default() -> Self {
        Self {
            source_repo_url: "https://github.com/free2z/zuu".to_owned(),
            source_commit: String::new(),
            build_digest: String::new(),
        }
    }
}

impl Default for Log {
    fn default() -> Self {
        Self {
            level: "info".to_owned(),
        }
    }
}

// ---------------------------------------------------------------------------
// Loading.
// ---------------------------------------------------------------------------

/// How the queue-creation gate is set (§13.1 layer 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreationMode {
    /// No gate. §13.1: "Appropriate only for a private relay on a closed
    /// network."
    Open,
    /// A `PowStamp` over a relay-issued challenge. The default.
    Pow,
    /// An operator-issued bearer token. **Refused at startup** — see
    /// [`Config::check`].
    Token,
}

impl Config {
    /// Read a TOML file.
    ///
    /// # Errors
    ///
    /// [`ConfigError::Read`] or [`ConfigError::Parse`]. An unknown key is a
    /// parse error, deliberately.
    pub fn from_toml_path(path: &std::path::Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .map_err(|error| ConfigError::Read(path.to_path_buf(), error))?;
        Self::from_toml_str(&text)
    }

    /// Parse TOML text.
    ///
    /// # Errors
    ///
    /// [`ConfigError::Parse`], naming the key when the key is what is wrong.
    pub fn from_toml_str(text: &str) -> Result<Self> {
        toml::from_str(text).map_err(|error| ConfigError::Parse(error.to_string()))
    }

    /// Apply `F2Z_RELAY_*` over whatever is already here.
    ///
    /// # Errors
    ///
    /// [`ConfigError::Invalid`] for a variable whose value does not parse.
    pub fn apply_env<I>(&mut self, variables: I) -> Result<()>
    where
        I: IntoIterator<Item = (String, String)>,
    {
        let mut sorted = BTreeMap::new();
        for (name, value) in variables {
            if let Some(key) = name.strip_prefix("F2Z_RELAY_") {
                sorted.insert(key.to_ascii_lowercase(), value);
            }
        }
        for (key, value) in sorted {
            self.set(&key, &value)?;
        }
        Ok(())
    }

    /// Set one `section_key` value, as the environment spells it.
    ///
    /// # Errors
    ///
    /// [`ConfigError::Invalid`] when the value does not parse, or the key is not
    /// one this build knows.
    #[expect(
        clippy::too_many_lines,
        reason = "one match arm per configuration key; splitting it would hide \
                  the one place a reader can see the whole surface"
    )]
    pub fn set(&mut self, key: &str, value: &str) -> Result<()> {
        match key {
            "listen_address" => self.listen.address = value.to_owned(),
            "listen_insecure" => self.listen.insecure = boolean("listen_insecure", value)?,
            "listen_tls_cert" => self.listen.tls_cert = value.to_owned(),
            "listen_tls_key" => self.listen.tls_key = value.to_owned(),
            "listen_handshake_timeout_ms" => {
                self.listen.handshake_timeout_ms = number("listen_handshake_timeout_ms", value)?;
            }
            "listen_ping_interval_seconds" => {
                self.listen.ping_interval_seconds = number("listen_ping_interval_seconds", value)?;
            }
            "listen_missed_pongs_before_close" => {
                self.listen.missed_pongs_before_close =
                    number("listen_missed_pongs_before_close", value)?;
            }
            "admin_enabled" => self.admin.enabled = boolean("admin_enabled", value)?,
            "admin_address" => self.admin.address = value.to_owned(),
            "store_backend" => self.store.backend = value.to_owned(),
            "store_path" => self.store.path = value.to_owned(),
            "identity_path" => self.identity.path = value.to_owned(),
            "identity_generate" => self.identity.generate = boolean("identity_generate", value)?,
            "identity_seed" => self.identity.seed = value.to_owned(),
            "commit_window_ms" => self.commit.window_ms = number("commit_window_ms", value)?,
            "commit_max_batch" => self.commit.max_batch = number("commit_max_batch", value)?,
            "limits_max_frame_bytes" => {
                self.limits.max_frame_bytes = number("limits_max_frame_bytes", value)?;
            }
            "limits_max_inflight" => {
                self.limits.max_inflight = number("limits_max_inflight", value)?;
            }
            "limits_clock_skew_ms" => {
                self.limits.clock_skew_ms = number("limits_clock_skew_ms", value)?;
            }
            "limits_antireplay_window_ms" => {
                self.limits.antireplay_window_ms = number("limits_antireplay_window_ms", value)?;
            }
            "limits_antireplay_seen_max" => {
                self.limits.antireplay_seen_max = number("limits_antireplay_seen_max", value)?;
            }
            "limits_max_connections" => {
                self.limits.max_connections = number("limits_max_connections", value)?;
            }
            "limits_max_connections_per_source" => {
                self.limits.max_connections_per_source =
                    number("limits_max_connections_per_source", value)?;
            }
            "limits_new_connections_per_source_per_second" => {
                self.limits.new_connections_per_source_per_second =
                    number("limits_new_connections_per_source_per_second", value)?;
            }
            "limits_commands_per_connection_per_second" => {
                self.limits.commands_per_connection_per_second =
                    number("limits_commands_per_connection_per_second", value)?;
            }
            "limits_challenges_per_source_per_minute" => {
                self.limits.challenges_per_source_per_minute =
                    number("limits_challenges_per_source_per_minute", value)?;
            }
            "limits_max_queues" => self.limits.max_queues = number("limits_max_queues", value)?,
            "limits_max_queue_messages" => {
                self.limits.max_queue_messages = number("limits_max_queue_messages", value)?;
            }
            "limits_max_queue_bytes" => {
                self.limits.max_queue_bytes = number("limits_max_queue_bytes", value)?;
            }
            "limits_storage_high_water_bytes" => {
                self.limits.storage_high_water_bytes =
                    number("limits_storage_high_water_bytes", value)?;
            }
            "limits_max_outbound_queue" => {
                self.limits.max_outbound_queue = number("limits_max_outbound_queue", value)?;
            }
            "queues_min_message_ttl_seconds" => {
                self.queues.min_message_ttl_seconds =
                    number("queues_min_message_ttl_seconds", value)?;
            }
            "queues_max_message_ttl_seconds" => {
                self.queues.max_message_ttl_seconds =
                    number("queues_max_message_ttl_seconds", value)?;
            }
            "queues_default_message_ttl_seconds" => {
                self.queues.default_message_ttl_seconds =
                    number("queues_default_message_ttl_seconds", value)?;
            }
            "queues_min_idle_ttl_seconds" => {
                self.queues.min_idle_ttl_seconds = number("queues_min_idle_ttl_seconds", value)?;
            }
            "queues_max_idle_ttl_seconds" => {
                self.queues.max_idle_ttl_seconds = number("queues_max_idle_ttl_seconds", value)?;
            }
            "queues_default_idle_ttl_seconds" => {
                self.queues.default_idle_ttl_seconds =
                    number("queues_default_idle_ttl_seconds", value)?;
            }
            "queues_expiry_tick_seconds" => {
                self.queues.expiry_tick_seconds = number("queues_expiry_tick_seconds", value)?;
            }
            "padding_sizes" => self.padding.sizes = number_list("padding_sizes", value)?,
            "padding_max_chunk_bytes" => {
                self.padding.max_chunk_bytes = number("padding_max_chunk_bytes", value)?;
            }
            "antiabuse_queue_creation_mode" => {
                self.antiabuse.queue_creation_mode = value.to_owned();
            }
            "antiabuse_queue_creation_pow_bits" => {
                self.antiabuse.queue_creation_pow_bits =
                    number("antiabuse_queue_creation_pow_bits", value)?;
            }
            "antiabuse_contact_append_pow_bits" => {
                self.antiabuse.contact_append_pow_bits =
                    number("antiabuse_contact_append_pow_bits", value)?;
            }
            "antiabuse_challenge_ttl_ms" => {
                self.antiabuse.challenge_ttl_ms = number("antiabuse_challenge_ttl_ms", value)?;
            }
            "antiabuse_max_challenges" => {
                self.antiabuse.max_challenges = number("antiabuse_max_challenges", value)?;
            }
            "antiabuse_contact_queues_enabled" => {
                self.antiabuse.contact_queues_enabled =
                    boolean("antiabuse_contact_queues_enabled", value)?;
            }
            "antiabuse_contact_max_pending" => {
                self.antiabuse.contact_max_pending =
                    number("antiabuse_contact_max_pending", value)?;
            }
            "antiabuse_contact_max_bytes" => {
                self.antiabuse.contact_max_bytes = number("antiabuse_contact_max_bytes", value)?;
            }
            "antiabuse_per_source_limits" => {
                self.antiabuse.per_source_limits = boolean("antiabuse_per_source_limits", value)?;
            }
            "operator_name" => self.operator.name = value.to_owned(),
            "operator_contact" => self.operator.contact = value.to_owned(),
            "operator_abuse_contact" => self.operator.abuse_contact = value.to_owned(),
            "operator_jurisdiction" => self.operator.jurisdiction = value.to_owned(),
            "operator_policy_url" => self.operator.policy_url = value.to_owned(),
            "provenance_source_repo_url" => self.provenance.source_repo_url = value.to_owned(),
            "provenance_source_commit" => self.provenance.source_commit = value.to_owned(),
            "provenance_build_digest" => self.provenance.build_digest = value.to_owned(),
            "log_level" => self.log.level = value.to_owned(),
            other => {
                return Err(ConfigError::Invalid(
                    "environment",
                    format!(
                        "F2Z_RELAY_{} names no configuration key",
                        other.to_uppercase()
                    ),
                ));
            }
        }
        Ok(())
    }

    /// The parsed listen address.
    ///
    /// # Errors
    ///
    /// [`ConfigError::Invalid`] if it is not `host:port`.
    pub fn listen_addr(&self) -> Result<SocketAddr> {
        self.listen
            .address
            .parse()
            .map_err(|_| ConfigError::Invalid("listen.address", self.listen.address.clone()))
    }

    /// The parsed admin address.
    ///
    /// # Errors
    ///
    /// [`ConfigError::Invalid`] if it is not `host:port`.
    pub fn admin_addr(&self) -> Result<SocketAddr> {
        self.admin
            .address
            .parse()
            .map_err(|_| ConfigError::Invalid("admin.address", self.admin.address.clone()))
    }

    /// Whether the listener terminates TLS itself.
    #[must_use]
    pub fn tls_enabled(&self) -> bool {
        !self.listen.tls_cert.is_empty() && !self.listen.tls_key.is_empty()
    }

    /// §13.1 layer 3's mode.
    ///
    /// # Errors
    ///
    /// [`ConfigError::Invalid`] for a value that is not one of the three.
    pub fn creation_mode(&self) -> Result<CreationMode> {
        match self.antiabuse.queue_creation_mode.as_str() {
            "open" => Ok(CreationMode::Open),
            "pow" => Ok(CreationMode::Pow),
            "token" => Ok(CreationMode::Token),
            other => Err(ConfigError::Invalid(
                "antiabuse.queue_creation_mode",
                format!("{other} is not one of open, pow, token"),
            )),
        }
    }

    /// The log level.
    ///
    /// # Errors
    ///
    /// [`ConfigError::Invalid`] for an unrecognized name.
    pub fn log_level(&self) -> Result<Level> {
        Level::parse(&self.log.level)
            .map_err(|other| ConfigError::Invalid("log.level", other.to_owned()))
    }

    /// Everything `--check-config` checks, and everything startup checks.
    ///
    /// This is where the rules that a *pair* of values must satisfy live —
    /// the ones no single field can enforce and no client can see until it is
    /// too late.
    ///
    /// # Errors
    ///
    /// [`ConfigError::Invalid`], naming the key that is wrong.
    #[expect(
        clippy::too_many_lines,
        reason = "the cross-field rules of WIRE.md, each with the section it \
                  comes from; a reader needs them in one list"
    )]
    pub fn check(&self) -> Result<()> {
        let listen = self.listen_addr()?;
        self.log_level()?;
        let mode = self.creation_mode()?;

        // §13.1 defines `token` as an operator-issued bearer credential and
        // gives it **no wire shape at all** in v1: `CreateQueueRequest` carries
        // a `PowStamp` and a reserved `flags` field that MUST be 0, and nothing
        // else. There is no conforming way for a client to present a token, so
        // a relay that published this mode would be publishing a gate no client
        // can pass. Refused here rather than faked, which is the same call
        // `f2z-relay-testkit` made. Reported as a spec defect.
        if matches!(mode, CreationMode::Token) {
            return Err(ConfigError::Invalid(
                "antiabuse.queue_creation_mode",
                "token mode has no wire representation in WIRE.md v1: CREATE_QUEUE \
                 carries only a PowStamp and a reserved flags field, so a client \
                 has no conforming way to present a token"
                    .to_owned(),
            ));
        }

        // §2.3, and it is a startup check rather than a warning: the process
        // exits. A non-loopback bind with no TLS is the one configuration that
        // silently downgrades every connection metadata property the design
        // has, so it takes an explicit act to reach.
        if !self.tls_enabled() && !is_loopback(&listen) && !self.listen.insecure {
            return Err(ConfigError::Invalid(
                "listen.address",
                "refusing to bind a non-loopback address without TLS (WIRE.md §2.3); \
                 configure listen.tls_cert and listen.tls_key, or pass \
                 --insecure-listen to publish transport_security: none and \
                 channel_binding_mode: none"
                    .to_owned(),
            ));
        }
        if self.tls_enabled() && self.listen.insecure {
            return Err(ConfigError::Invalid(
                "listen.insecure",
                "--insecure-listen contradicts a configured certificate; a relay \
                 that terminates TLS must publish transport_security: tls"
                    .to_owned(),
            ));
        }

        if self.admin.enabled {
            let admin = self.admin_addr()?;
            // §11.1 publishes nothing about connection counts or queue depth,
            // and `/metrics` carries both. A metrics endpoint reachable from
            // the network is the metadata disclosure the protocol refuses,
            // arriving through the side door.
            if !is_loopback(&admin) {
                return Err(ConfigError::Invalid(
                    "admin.address",
                    "the admin listener serves /healthz and /metrics and must be \
                     loopback-only; put a reverse proxy in front of it if a \
                     scraper needs it"
                        .to_owned(),
                ));
            }
            // Port 0 asks the OS to choose, so two zeros are not a collision —
            // they are two different ports the kernel has not picked yet. Only a
            // concrete pair can actually clash.
            if admin.port() != 0 && admin.port() == listen.port() && admin.ip() == listen.ip() {
                return Err(ConfigError::Invalid(
                    "admin.address",
                    "the admin listener must not share the protocol listener's address".to_owned(),
                ));
            }
        }

        match self.store.backend.as_str() {
            "sqlite" | "memory" => {}
            other => {
                return Err(ConfigError::Invalid(
                    "store.backend",
                    format!("{other} is not one of sqlite, memory"),
                ));
            }
        }
        if self.store.backend == "sqlite" && self.store.path.is_empty() {
            return Err(ConfigError::Invalid(
                "store.path",
                "the sqlite backend needs a file".to_owned(),
            ));
        }
        if self.identity.seed.is_empty() && self.identity.path.is_empty() {
            return Err(ConfigError::Invalid(
                "identity.path",
                "a relay needs an identity: set identity.path or identity.seed".to_owned(),
            ));
        }
        if !self.identity.seed.is_empty() && decode_seed(&self.identity.seed).is_none() {
            return Err(ConfigError::Invalid(
                "identity.seed",
                "must be exactly 64 hexadecimal characters".to_owned(),
            ));
        }

        // #586's finding, enforced rather than published. A frame is acceptable
        // anywhere in `ts ± clock_skew_ms`, so a seen-set entry must be
        // retained for `2 × clock_skew_ms` from first observation or §5.5's
        // replay protection has a hole exactly the width of the shortfall. The
        // specification permits the hole; this relay refuses to open it, which
        // is why the corresponding conformance vector is one it cannot satisfy
        // by construction rather than one it fails.
        if !SeenSet::new(u64::from(self.limits.antireplay_window_ms), 1)
            .retention_is_sound(u64::from(self.limits.clock_skew_ms))
        {
            return Err(ConfigError::Invalid(
                "limits.antireplay_window_ms",
                "must be at least 2 x limits.clock_skew_ms, or the seen-set has no \
                 coverage for frames in the gap (WIRE.md §5.5, issue #586)"
                    .to_owned(),
            ));
        }
        if self.limits.clock_skew_ms == 0 {
            return Err(ConfigError::Invalid(
                "limits.clock_skew_ms",
                "a zero window rejects every client whose clock is not the relay's".to_owned(),
            ));
        }
        if self.limits.max_inflight == 0 {
            return Err(ConfigError::Invalid(
                "limits.max_inflight",
                "a zero window admits no commands at all".to_owned(),
            ));
        }
        if self.limits.antireplay_seen_max == 0 {
            return Err(ConfigError::Invalid(
                "limits.antireplay_seen_max",
                "a zero seen-set refuses every signed command (WIRE.md §5.5 is \
                 fail-closed)"
                    .to_owned(),
            ));
        }
        if self.limits.max_connections == 0 {
            return Err(ConfigError::Invalid(
                "limits.max_connections",
                "a relay that accepts no connections is not a relay".to_owned(),
            ));
        }
        if self.commit.max_batch == 0 {
            return Err(ConfigError::Invalid(
                "commit.max_batch",
                "a zero batch commits nothing".to_owned(),
            ));
        }
        if self.limits.max_outbound_queue == 0 {
            return Err(ConfigError::Invalid(
                "limits.max_outbound_queue",
                "a zero outbound queue cannot carry a response".to_owned(),
            ));
        }
        if self.queues.expiry_tick_seconds == 0 {
            return Err(ConfigError::Invalid(
                "queues.expiry_tick_seconds",
                "the TTL sweep needs a period".to_owned(),
            ));
        }

        // §7.7 and §11.3 step 5. A relay claiming more than 30 days is claiming
        // a policy the architecture forbids, and a conforming client refuses it
        // — so refusing to start is strictly kinder than starting and being
        // refused by everyone.
        if self.queues.max_message_ttl_seconds > f2z_codec::MAX_MESSAGE_TTL_SECONDS {
            return Err(ConfigError::Invalid(
                "queues.max_message_ttl_seconds",
                "WIRE.md §7.7 caps the message TTL at 2592000 seconds (30 days)".to_owned(),
            ));
        }

        let buckets =
            f2z_codec::padding::PaddingBuckets::new(self.padding.sizes.clone()).map_err(|_| {
                ConfigError::Invalid(
                    "padding.sizes",
                    "must be a non-empty, strictly ascending set of non-zero sizes".to_owned(),
                )
            })?;
        if u64::from(self.limits.max_frame_bytes) < u64::from(buckets.largest()) {
            return Err(ConfigError::Invalid(
                "limits.max_frame_bytes",
                "is below this relay's own largest padding bucket, so the set it \
                 publishes is one no client can use"
                    .to_owned(),
            ));
        }
        if !buckets.is_plausible() {
            return Err(ConfigError::Invalid(
                "padding.sizes",
                "§9: a set with more than 16 entries, or a spacing below 512 bytes, \
                 is indistinguishable from an attempt to let a colluding client \
                 leak length through size, and a conforming client refuses it"
                    .to_owned(),
            ));
        }

        if matches!(mode, CreationMode::Pow) && self.antiabuse.queue_creation_pow_bits == 0 {
            return Err(ConfigError::Invalid(
                "antiabuse.queue_creation_pow_bits",
                "pow mode with zero difficulty is a gate with nothing behind it".to_owned(),
            ));
        }
        // §12.3 lists proof of work as one of four caps a relay MUST enforce.
        if self.antiabuse.contact_queues_enabled && self.antiabuse.contact_append_pow_bits == 0 {
            return Err(ConfigError::Invalid(
                "antiabuse.contact_append_pow_bits",
                "§12.3: offering contact queues without proof of work is offering \
                 an unsigned, unmetered write endpoint to the whole internet"
                    .to_owned(),
            ));
        }
        if self.antiabuse.queue_creation_pow_bits > 64
            || self.antiabuse.contact_append_pow_bits > 64
        {
            return Err(ConfigError::Invalid(
                "antiabuse.queue_creation_pow_bits",
                "a difficulty above 64 bits is not solvable by any client".to_owned(),
            ));
        }
        if self.antiabuse.max_challenges == 0 {
            return Err(ConfigError::Invalid(
                "antiabuse.max_challenges",
                "a zero challenge table refuses every stamp the relay demands".to_owned(),
            ));
        }

        for (key, text) in [
            ("operator.name", &self.operator.name),
            ("operator.contact", &self.operator.contact),
            ("operator.abuse_contact", &self.operator.abuse_contact),
            ("operator.jurisdiction", &self.operator.jurisdiction),
            ("operator.policy_url", &self.operator.policy_url),
            (
                "provenance.source_repo_url",
                &self.provenance.source_repo_url,
            ),
            ("provenance.source_commit", &self.provenance.source_commit),
            ("provenance.build_digest", &self.provenance.build_digest),
        ] {
            if text.len() > 255 {
                return Err(ConfigError::Invalid(
                    key,
                    "§11.1 gives this field a one-byte length prefix; 255 bytes is \
                     the ceiling"
                        .to_owned(),
                ));
            }
        }

        Ok(())
    }

    /// The configuration as TOML, with key material redacted.
    ///
    /// What `--print-config` prints. Re-parsing the output yields the same
    /// configuration **except** for `identity.seed`, which is the point: the
    /// output is for a bug report and a bug report is a place secrets go to
    /// live forever.
    #[must_use]
    #[expect(
        clippy::too_many_lines,
        reason = "a printer with one line per key; the alternative is a macro \
                  that makes the redaction harder to see"
    )]
    pub fn to_redacted_toml(&self) -> String {
        let mut out = String::with_capacity(2048);
        let _ = writeln!(out, "[listen]");
        let _ = writeln!(out, "address = {:?}", self.listen.address);
        let _ = writeln!(out, "insecure = {}", self.listen.insecure);
        let _ = writeln!(out, "tls_cert = {:?}", self.listen.tls_cert);
        let _ = writeln!(out, "tls_key = {:?}", self.listen.tls_key);
        let _ = writeln!(
            out,
            "handshake_timeout_ms = {}",
            self.listen.handshake_timeout_ms
        );
        let _ = writeln!(
            out,
            "ping_interval_seconds = {}",
            self.listen.ping_interval_seconds
        );
        let _ = writeln!(
            out,
            "missed_pongs_before_close = {}",
            self.listen.missed_pongs_before_close
        );

        let _ = writeln!(out, "\n[admin]");
        let _ = writeln!(out, "enabled = {}", self.admin.enabled);
        let _ = writeln!(out, "address = {:?}", self.admin.address);

        let _ = writeln!(out, "\n[store]");
        let _ = writeln!(out, "backend = {:?}", self.store.backend);
        let _ = writeln!(out, "path = {:?}", self.store.path);

        let _ = writeln!(out, "\n[identity]");
        let _ = writeln!(out, "path = {:?}", self.identity.path);
        let _ = writeln!(out, "generate = {}", self.identity.generate);
        // The one secret in the file. Never printed, present or absent.
        let _ = writeln!(
            out,
            "seed = {:?}",
            if self.identity.seed.is_empty() {
                "<unset>"
            } else {
                "<redacted>"
            }
        );

        let _ = writeln!(out, "\n[commit]");
        let _ = writeln!(out, "window_ms = {}", self.commit.window_ms);
        let _ = writeln!(out, "max_batch = {}", self.commit.max_batch);

        let _ = writeln!(out, "\n[limits]");
        let _ = writeln!(out, "max_frame_bytes = {}", self.limits.max_frame_bytes);
        let _ = writeln!(out, "max_inflight = {}", self.limits.max_inflight);
        let _ = writeln!(out, "clock_skew_ms = {}", self.limits.clock_skew_ms);
        let _ = writeln!(
            out,
            "antireplay_window_ms = {}",
            self.limits.antireplay_window_ms
        );
        let _ = writeln!(
            out,
            "antireplay_seen_max = {}",
            self.limits.antireplay_seen_max
        );
        let _ = writeln!(out, "max_connections = {}", self.limits.max_connections);
        let _ = writeln!(
            out,
            "max_connections_per_source = {}",
            self.limits.max_connections_per_source
        );
        let _ = writeln!(
            out,
            "new_connections_per_source_per_second = {}",
            self.limits.new_connections_per_source_per_second
        );
        let _ = writeln!(
            out,
            "commands_per_connection_per_second = {}",
            self.limits.commands_per_connection_per_second
        );
        let _ = writeln!(
            out,
            "challenges_per_source_per_minute = {}",
            self.limits.challenges_per_source_per_minute
        );
        let _ = writeln!(out, "max_queues = {}", self.limits.max_queues);
        let _ = writeln!(
            out,
            "max_queue_messages = {}",
            self.limits.max_queue_messages
        );
        let _ = writeln!(out, "max_queue_bytes = {}", self.limits.max_queue_bytes);
        let _ = writeln!(
            out,
            "storage_high_water_bytes = {}",
            self.limits.storage_high_water_bytes
        );
        let _ = writeln!(
            out,
            "max_outbound_queue = {}",
            self.limits.max_outbound_queue
        );

        let _ = writeln!(out, "\n[queues]");
        let _ = writeln!(
            out,
            "min_message_ttl_seconds = {}",
            self.queues.min_message_ttl_seconds
        );
        let _ = writeln!(
            out,
            "max_message_ttl_seconds = {}",
            self.queues.max_message_ttl_seconds
        );
        let _ = writeln!(
            out,
            "default_message_ttl_seconds = {}",
            self.queues.default_message_ttl_seconds
        );
        let _ = writeln!(
            out,
            "min_idle_ttl_seconds = {}",
            self.queues.min_idle_ttl_seconds
        );
        let _ = writeln!(
            out,
            "max_idle_ttl_seconds = {}",
            self.queues.max_idle_ttl_seconds
        );
        let _ = writeln!(
            out,
            "default_idle_ttl_seconds = {}",
            self.queues.default_idle_ttl_seconds
        );
        let _ = writeln!(
            out,
            "expiry_tick_seconds = {}",
            self.queues.expiry_tick_seconds
        );

        let _ = writeln!(out, "\n[padding]");
        let _ = writeln!(out, "sizes = {:?}", self.padding.sizes);
        let _ = writeln!(out, "max_chunk_bytes = {}", self.padding.max_chunk_bytes);

        let _ = writeln!(out, "\n[antiabuse]");
        let _ = writeln!(
            out,
            "queue_creation_mode = {:?}",
            self.antiabuse.queue_creation_mode
        );
        let _ = writeln!(
            out,
            "queue_creation_pow_bits = {}",
            self.antiabuse.queue_creation_pow_bits
        );
        let _ = writeln!(
            out,
            "contact_append_pow_bits = {}",
            self.antiabuse.contact_append_pow_bits
        );
        let _ = writeln!(
            out,
            "challenge_ttl_ms = {}",
            self.antiabuse.challenge_ttl_ms
        );
        let _ = writeln!(out, "max_challenges = {}", self.antiabuse.max_challenges);
        let _ = writeln!(
            out,
            "contact_queues_enabled = {}",
            self.antiabuse.contact_queues_enabled
        );
        let _ = writeln!(
            out,
            "contact_max_pending = {}",
            self.antiabuse.contact_max_pending
        );
        let _ = writeln!(
            out,
            "contact_max_bytes = {}",
            self.antiabuse.contact_max_bytes
        );
        let _ = writeln!(
            out,
            "per_source_limits = {}",
            self.antiabuse.per_source_limits
        );

        let _ = writeln!(out, "\n[operator]");
        let _ = writeln!(out, "name = {:?}", self.operator.name);
        let _ = writeln!(out, "contact = {:?}", self.operator.contact);
        let _ = writeln!(out, "abuse_contact = {:?}", self.operator.abuse_contact);
        let _ = writeln!(out, "jurisdiction = {:?}", self.operator.jurisdiction);
        let _ = writeln!(out, "policy_url = {:?}", self.operator.policy_url);

        let _ = writeln!(out, "\n[provenance]");
        let _ = writeln!(
            out,
            "source_repo_url = {:?}",
            self.provenance.source_repo_url
        );
        let _ = writeln!(out, "source_commit = {:?}", self.provenance.source_commit);
        let _ = writeln!(out, "build_digest = {:?}", self.provenance.build_digest);

        let _ = writeln!(out, "\n[log]");
        let _ = writeln!(out, "level = {:?}", self.log.level);
        out
    }
}

/// Whether an address is one §2.3 lets a relay serve without TLS.
#[must_use]
pub fn is_loopback(addr: &SocketAddr) -> bool {
    match addr.ip() {
        std::net::IpAddr::V4(v4) => v4.is_loopback(),
        std::net::IpAddr::V6(v6) => v6.is_loopback(),
    }
}

/// Decode a 64-character hex seed.
#[must_use]
pub fn decode_seed(text: &str) -> Option<[u8; 32]> {
    if text.len() != 64 {
        return None;
    }
    let bytes = text.as_bytes();
    let mut seed = [0u8; 32];
    for index in 0usize..32 {
        let high = nibble(*bytes.get(index.checked_mul(2)?)?)?;
        let low = nibble(*bytes.get(index.checked_mul(2)?.checked_add(1)?)?)?;
        *seed.get_mut(index)? = (high << 4) | low;
    }
    Some(seed)
}

const fn nibble(byte: u8) -> Option<u8> {
    // `checked_*` rather than `-` and `+`: the workspace denies the arithmetic
    // families outright, because this crate's parser is the unauthenticated
    // attack surface and a panic there is a remote denial of service. The range
    // patterns already make every subtraction safe; saying so with the checked
    // form is what makes that reviewable rather than argued.
    match byte {
        b'0'..=b'9' => byte.checked_sub(b'0'),
        b'a'..=b'f' => match byte.checked_sub(b'a') {
            Some(offset) => offset.checked_add(10),
            None => None,
        },
        b'A'..=b'F' => match byte.checked_sub(b'A') {
            Some(offset) => offset.checked_add(10),
            None => None,
        },
        _ => None,
    }
}

fn boolean(key: &'static str, value: &str) -> Result<bool> {
    match value {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        other => Err(ConfigError::Invalid(
            key,
            format!("{other} is not a boolean"),
        )),
    }
}

fn number<T: std::str::FromStr>(key: &'static str, value: &str) -> Result<T> {
    value
        .parse()
        .map_err(|_| ConfigError::Invalid(key, format!("{value} is not a number this field takes")))
}

fn number_list(key: &'static str, value: &str) -> Result<Vec<u32>> {
    value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| number(key, part))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_pass_their_own_check() {
        assert!(Config::default().check().is_ok());
    }

    #[test]
    fn the_default_creation_mode_is_proof_of_work() {
        assert_eq!(
            Config::default().creation_mode().unwrap(),
            CreationMode::Pow
        );
    }

    #[test]
    fn antireplay_window_pins_the_shared_soundness_boundary() {
        // Issue #586: the specification as written *permits* this document, and
        // a client that checks refuses it. This relay declines to be that
        // relay, which is why the corresponding conformance vector is
        // unsatisfiable here by construction.
        let mut config = Config::default();
        let sound_boundary = config
            .limits
            .clock_skew_ms
            .checked_mul(2)
            .expect("the u32 configuration boundary fits");
        config.limits.antireplay_window_ms = sound_boundary - 1;
        let error = config.check().unwrap_err();
        assert!(format!("{error}").contains("antireplay_window_ms"));

        config.limits.antireplay_window_ms = sound_boundary;
        assert!(config.check().is_ok());
    }

    #[test]
    fn a_public_bind_without_tls_needs_the_override() {
        let mut config = Config::default();
        config.listen.address = "0.0.0.0:8443".to_owned();
        assert!(config.check().is_err());
        config.listen.insecure = true;
        assert!(config.check().is_ok());
    }

    #[test]
    fn tls_and_the_insecure_override_are_mutually_exclusive() {
        let mut config = Config::default();
        config.listen.address = "0.0.0.0:8443".to_owned();
        config.listen.tls_cert = "cert.pem".to_owned();
        config.listen.tls_key = "key.pem".to_owned();
        assert!(config.check().is_ok());
        config.listen.insecure = true;
        assert!(config.check().is_err());
    }

    #[test]
    fn the_admin_listener_may_not_leave_the_host() {
        let mut config = Config::default();
        config.admin.address = "0.0.0.0:9101".to_owned();
        let error = config.check().unwrap_err();
        assert!(format!("{error}").contains("loopback-only"));
    }

    #[test]
    fn token_mode_is_refused_because_it_has_no_wire_shape() {
        let mut config = Config::default();
        config.antiabuse.queue_creation_mode = "token".to_owned();
        let error = config.check().unwrap_err();
        assert!(format!("{error}").contains("no wire representation"));
    }

    #[test]
    fn a_ttl_above_the_architectures_ceiling_is_refused() {
        let mut config = Config::default();
        config.queues.max_message_ttl_seconds = f2z_codec::MAX_MESSAGE_TTL_SECONDS + 1;
        assert!(config.check().is_err());
    }

    #[test]
    fn contact_queues_without_proof_of_work_are_refused() {
        let mut config = Config::default();
        config.antiabuse.contact_append_pow_bits = 0;
        assert!(config.check().is_err());
        config.antiabuse.contact_queues_enabled = false;
        assert!(config.check().is_ok());
    }

    #[test]
    fn an_unknown_file_key_is_an_error_rather_than_a_default() {
        let error = Config::from_toml_str("[limits]\nmax_queue_byes = 10\n").unwrap_err();
        assert!(format!("{error}").contains("max_queue_byes"));
    }

    #[test]
    fn a_file_sets_only_what_it_names() {
        let config = Config::from_toml_str("[limits]\nmax_inflight = 8\n").unwrap();
        assert_eq!(config.limits.max_inflight, 8);
        assert_eq!(
            config.limits.max_frame_bytes,
            Limits::default().max_frame_bytes
        );
    }

    #[test]
    fn the_environment_spells_every_key_the_file_does() {
        let mut config = Config::default();
        config
            .apply_env([
                ("F2Z_RELAY_LIMITS_MAX_INFLIGHT".to_owned(), "4".to_owned()),
                ("F2Z_RELAY_PADDING_SIZES".to_owned(), "512,1024".to_owned()),
                ("F2Z_RELAY_ADMIN_ENABLED".to_owned(), "false".to_owned()),
                ("PATH".to_owned(), "/ignored".to_owned()),
            ])
            .unwrap();
        assert_eq!(config.limits.max_inflight, 4);
        assert_eq!(config.padding.sizes, vec![512, 1024]);
        assert!(!config.admin.enabled);
    }

    #[test]
    fn an_unknown_environment_key_is_named_rather_than_ignored() {
        let mut config = Config::default();
        let error = config
            .apply_env([("F2Z_RELAY_LIMITS_MAX_INFLITE".to_owned(), "4".to_owned())])
            .unwrap_err();
        assert!(format!("{error}").contains("LIMITS_MAX_INFLITE"));
    }

    #[test]
    fn print_config_never_prints_the_seed() {
        let mut config = Config::default();
        config.identity.seed = "ab".repeat(32);
        let printed = config.to_redacted_toml();
        assert!(printed.contains("<redacted>"));
        assert!(!printed.contains("abab"));
        // And the debug rendering does not leak it either, which matters
        // because a Config lands in a startup error message.
        assert!(!format!("{config:?}").contains("abab"));
    }

    #[test]
    fn everything_print_config_prints_parses_back() {
        let config = Config::default();
        let round = Config::from_toml_str(&config.to_redacted_toml()).unwrap();
        // Every field except the redacted one.
        assert_eq!(round.limits, config.limits);
        assert_eq!(round.queues, config.queues);
        assert_eq!(round.antiabuse, config.antiabuse);
        assert_eq!(round.padding, config.padding);
    }

    #[test]
    fn a_seed_decodes_only_from_sixty_four_hex_characters() {
        assert_eq!(decode_seed(&"00".repeat(32)), Some([0u8; 32]));
        assert_eq!(decode_seed(&"ff".repeat(32)), Some([0xffu8; 32]));
        assert_eq!(decode_seed("00"), None);
        assert_eq!(decode_seed(&"zz".repeat(32)), None);
    }

    #[test]
    fn two_ephemeral_ports_are_not_a_collision() {
        let mut config = Config::default();
        config.listen.address = "127.0.0.1:0".to_owned();
        config.admin.address = "127.0.0.1:0".to_owned();
        assert!(config.check().is_ok());
        // A concrete shared address still is one.
        config.listen.address = "127.0.0.1:9101".to_owned();
        config.admin.address = "127.0.0.1:9101".to_owned();
        assert!(config.check().is_err());
    }

    #[test]
    fn an_implausible_padding_set_is_refused_at_startup() {
        let mut config = Config::default();
        config.padding.sizes = (1..=20u32).map(|n| n * 8).collect();
        assert!(config.check().is_err());
    }
}
