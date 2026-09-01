//! What a `FakeRelay` is configured with, and the one place a deliberate
//! departure from `WIRE.md` can be turned on.
//!
//! # The published document is the contract, including here
//!
//! Every policy value below ends up in the signed capability document of §11.1,
//! and the relay then enforces exactly what it published. That is not a detail:
//! §11.3 has a client *decide whether to talk to a relay at all* from that
//! document, so a test harness whose behaviour and whose document disagree
//! would teach clients to ignore it.
//!
//! The default document is therefore honest about what a `FakeRelay` is:
//!
//! - `transport_security: none` and `channel_binding_mode: none`. It serves
//!   `ws://`, not `wss://` — it is the §2.3 `--insecure-listen` case, and §2.3
//!   obligations 1 and 2 require exactly this pair. Clients must set
//!   [`ClientPolicy::allow_insecure_transport`], which is §2.3 obligation 3
//!   working as designed rather than a workaround.
//! - `durability_mode: memory`. Storage is a `BTreeMap` that dies with the
//!   process. §8.4 says an `APPEND` that returned 0 may not survive a crash in
//!   this mode, which is true here in the strongest possible sense.
//! - `queue_creation_mode: open`. §13.1 permits it for "a private relay on a
//!   closed network", which is what a test double is. [`RelayConfig::with_pow`]
//!   turns on `pow` mode for a client that wants to exercise stamps, at a
//!   difficulty a phone would laugh at.
//! - `antireplay_persistence: volatile`, because it is.
//!
//! None of those is a relaxation. Each is a policy `WIRE.md` allows, published
//! where a client can read it and refuse.
//!
//! [`ClientPolicy::allow_insecure_transport`]: f2z_relay_proto::capabilities::ClientPolicy::allow_insecure_transport

use std::time::Duration;

use f2z_codec::commands::{Capabilities, KeyPackagePolicy};
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::pow::{ALGORITHM_BLAKE2B_LEADING_ZERO_BITS, PowParams};
use f2z_codec::types::{ChannelBinding, ShortBytes};
use f2z_relay_proto::capabilities::{
    self, AntiReplayPersistence, ChannelBindingMode, DurabilityMode, QueueCreationMode,
    TransportSecurity,
};
use f2z_relay_proto::key::SigningKey;

use crate::clock::Clock;
use crate::error::{Result, TestkitError};
use crate::faults::PolicyFaults;

/// The proof-of-work difficulty a `FakeRelay` demands when it demands any.
///
/// Eight leading zero bits is 256 expected hashes — microseconds. §12.4 is
/// blunt that a difficulty high enough to cost an attacker anything is a
/// difficulty that makes a cheap phone sit there heating up, and a test suite
/// is the wrong place to pay that. What the low value still buys is the whole
/// *shape* of the exchange: `GET_CHALLENGE`, a stamp over a relay-issued,
/// single-use, expiring challenge, scoped to the target address, consumed on
/// use. Every one of those is a client obligation and every one is exercised.
pub const TESTKIT_POW_DIFFICULTY_BITS: u8 = 8;

/// Where the channel binding of §5.3 comes from.
///
/// A `FakeRelay` always serves `ws://` (see [`Relay::new`]'s §2.3 obligation-2
/// check), so `None` — `transport_security: none` paired with
/// `channel_binding_mode: none` — is the only value that can ever produce a
/// startable relay. There used to be a second variant, `Simulated([u8; 32])`,
/// that published `channel_binding_mode: tls-exporter` from a constant instead
/// of a real TLS exporter; #740 found it could not be paired with any
/// `transport_security` a `FakeRelay` can honestly publish and removed it. See
/// the "Known gaps" section of the crate README for how to exercise
/// `tls-exporter` instead: against the real relay.
///
/// [`Relay::new`]: crate::engine::Relay::new
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[non_exhaustive]
pub enum ChannelBindingSource {
    /// 32 zero bytes, published as `channel_binding_mode: none`.
    ///
    /// The only honest choice for a relay with no TLS session, and §5.3's
    /// stated consequence follows: the restart argument for a volatile
    /// seen-set does not hold, so the document also says
    /// `antireplay_persistence: volatile` and a client may refuse.
    None,
}

impl ChannelBindingSource {
    /// The binding value both ends use.
    #[must_use]
    pub const fn value(self) -> ChannelBinding {
        match self {
            Self::None => ChannelBinding::zero(),
        }
    }

    /// The `channel_binding_mode` byte this source publishes.
    #[must_use]
    pub const fn mode(self) -> ChannelBindingMode {
        match self {
            Self::None => ChannelBindingMode::None,
        }
    }
}

/// Deliberate departures from `WIRE.md`, all off by default.
///
/// **Every field here makes the relay accept something a conforming relay would
/// reject.** That is the most dangerous thing this crate can do: a fake that
/// accepts what the real relay refuses teaches a client to write code that
/// works in tests and fails in production. So each one is opt-in, each one is
/// named after the rule it suspends, and [`Relaxations::any`] lets a harness
/// assert that a run used none of them.
///
/// If you find yourself turning one on to make a client pass, the client is
/// wrong. The exception is deliberately narrow: a *relay* implementer bringing
/// up one layer at a time may want the layers below to stop refusing.
///
/// Deliberately **not** `#[non_exhaustive]`: like [`crate::faults::PolicyFaults`]
/// this is built by the caller, in their own file, with struct-update syntax.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Relaxations {
    /// Accept a payload whose length is not one of the published
    /// `padding_sizes` (§9). Suspends `ERR_BAD_SIZE`.
    pub accept_any_payload_size: bool,
    /// Accept `timestamp_ms` outside `±clock_skew_ms` (§5.5). Suspends
    /// `ERR_STALE_TIMESTAMP`. The seen-set still runs.
    pub accept_any_timestamp: bool,
    /// Accept `CREATE_QUEUE`, `CREATE_CONTACT_QUEUE` and `CONTACT_APPEND`
    /// without a valid stamp even while the document demands one (§13.1).
    /// Suspends `ERR_POW_REQUIRED` and `ERR_POW_INVALID`.
    pub accept_missing_pow: bool,
    /// Answer a second `HELLO` on one connection instead of refusing it
    /// (§2.5, §3.5).
    pub accept_repeated_hello: bool,
}

impl Relaxations {
    /// Whether any rule is suspended.
    #[must_use]
    pub const fn any(self) -> bool {
        self.accept_any_payload_size
            || self.accept_any_timestamp
            || self.accept_missing_pow
            || self.accept_repeated_hello
    }
}

/// Everything a [`FakeRelay`] is built from.
///
/// [`FakeRelay`]: crate::FakeRelay
#[derive(Clone)]
pub struct RelayConfig {
    /// The 32-byte seed of the relay's long-term Ed25519 identity key. Fixed by
    /// default so `relay_id` is reproducible across runs and can be written
    /// into a test's expectations.
    pub identity_seed: [u8; 32],
    /// The seed of the address and challenge generator. See [`crate::rng`] for
    /// why a test harness wants this deterministic and why that means
    /// `f2z-fakerelay` must never be deployed.
    pub rng_seed: [u8; 32],
    /// The relay's clock. Frozen by default (§5.5, §7.7 are unreachable
    /// otherwise).
    pub clock: Clock,
    /// Where §5.3's channel binding comes from.
    pub channel_binding: ChannelBindingSource,
    /// §2.5's deadline between accept and a valid `HELLO`.
    pub handshake_timeout: Duration,
    /// §2.4's server-side WebSocket Ping interval. Short by default so a test
    /// does not wait 25 seconds to observe one.
    pub ping_interval: Duration,
    /// §2.4: close after this many consecutive missed Pongs.
    pub missed_pongs_before_close: u32,
    /// The published policy. Start from [`RelayConfig::default`] and edit; the
    /// relay enforces what is in here, so an edit is a real policy change.
    pub capabilities: Capabilities,
    /// Additive §12.6 policy. Separate from the frozen v1 capability document.
    pub key_package_policy: KeyPackagePolicy,
    /// Deliberate departures from the specification. All off by default.
    pub relaxations: Relaxations,
    /// Faults that are properties of the relay rather than of a frame. Can also
    /// be changed at runtime through [`crate::faults::FaultInjector`].
    pub policy_faults: PolicyFaults,
}

// The two seeds decide the relay's identity key and every address it will hand
// out. Neither is printed: the identity seed is genuinely secret key material,
// and the address seed is §7.1's unpredictability in one value.
impl core::fmt::Debug for RelayConfig {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("RelayConfig")
            .field("identity_seed", &"<redacted>")
            .field("rng_seed", &"<redacted>")
            .field("clock", &self.clock)
            .field("channel_binding", &self.channel_binding)
            .field("handshake_timeout", &self.handshake_timeout)
            .field("ping_interval", &self.ping_interval)
            .field("relaxations", &self.relaxations)
            .field("policy_faults", &self.policy_faults)
            .finish_non_exhaustive()
    }
}

/// The default identity seed. A fixed, obviously-fake value: a `relay_id` that
/// shows up in a production log is a `f2z-fakerelay` that should not be there.
pub const DEFAULT_IDENTITY_SEED: [u8; 32] = *b"f2z-relay-testkit/fake-identity!";

/// The default address-generator seed.
pub const DEFAULT_RNG_SEED: [u8; 32] = *b"f2z-relay-testkit/fake-addresses";

impl Default for RelayConfig {
    fn default() -> Self {
        let clock = Clock::default();
        let identity = SigningKey::from_seed(&DEFAULT_IDENTITY_SEED);
        let capabilities = default_capabilities(&identity, clock.now_ms())
            // `defaults` is fallible only because its empty operator strings go
            // through the same length-checked constructor as any other, and the
            // testkit's strings are short constants. A default that cannot be
            // built is a bug in this crate, not a condition a caller can act
            // on, so it degrades to the unedited document rather than panicking
            // inside `Default`.
            .unwrap_or_else(|_| fallback_capabilities(&identity, clock.now_ms()));
        Self {
            identity_seed: DEFAULT_IDENTITY_SEED,
            rng_seed: DEFAULT_RNG_SEED,
            clock,
            channel_binding: ChannelBindingSource::None,
            handshake_timeout: Duration::from_millis(10_000),
            ping_interval: Duration::from_millis(500),
            missed_pongs_before_close: 2,
            capabilities,
            key_package_policy: KeyPackagePolicy {
                enabled: 1,
                max_pool_size: 64,
                claim_pow: testkit_pow(),
            },
            relaxations: Relaxations::default(),
            policy_faults: PolicyFaults::default(),
        }
    }
}

impl RelayConfig {
    /// The relay's identity key.
    #[must_use]
    pub fn identity(&self) -> SigningKey {
        SigningKey::from_seed(&self.identity_seed)
    }

    /// Demand a proof-of-work stamp for queue creation (§13.1's default mode),
    /// at [`TESTKIT_POW_DIFFICULTY_BITS`].
    #[must_use]
    pub fn with_pow(mut self) -> Self {
        self.capabilities.queue_creation_mode = QueueCreationMode::Pow.code();
        self.capabilities.queue_creation_pow = testkit_pow();
        self
    }

    /// Run on the host's wall clock instead of a frozen one. What
    /// `f2z-fakerelay` does, so a real client's real `timestamp_ms` lands
    /// inside the window.
    #[must_use]
    pub fn with_system_clock(mut self) -> Self {
        self.clock = Clock::system();
        self
    }

    /// Set the published padding buckets, and enforce them.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Config`] if the set is not the strictly ascending,
    /// non-empty, non-zero set §11.1 declares.
    pub fn with_padding(mut self, buckets: &PaddingBuckets) -> Result<Self> {
        self.capabilities.padding_sizes = buckets.sizes().to_vec().into();
        self.capabilities.max_frame_bytes = self
            .capabilities
            .max_frame_bytes
            .max(buckets.largest().saturating_add(4096));
        capabilities::validate(&self.capabilities)
            .map_err(|_| TestkitError::Config("padding set makes the document inconsistent"))?;
        Ok(self)
    }

    /// The padding buckets this relay publishes and enforces.
    ///
    /// # Errors
    ///
    /// [`TestkitError::Config`] if the configured document does not carry a
    /// valid set.
    pub fn padding(&self) -> Result<PaddingBuckets> {
        PaddingBuckets::new(self.capabilities.padding_sizes.as_slice().to_vec())
            .map_err(|_| TestkitError::Config("padding_sizes is not a valid ascending set"))
    }

    /// The capability document this configuration will actually publish, with
    /// every policy fault applied.
    ///
    /// Separate from [`RelayConfig::capabilities`] because a fault that changes
    /// behaviour must also change the published document — a relay whose
    /// document and conduct disagree is the one thing a client cannot defend
    /// against.
    #[must_use]
    pub fn published_capabilities(&self, faults: PolicyFaults) -> Capabilities {
        let mut published = self.capabilities.clone();
        published.channel_binding_mode = self.channel_binding.mode().code();
        if faults.unsound_antireplay_window {
            // Exactly the document #586 says a relay may publish today while
            // fully conforming, and exactly the one a client should refuse.
            published.antireplay_window_ms = published.clock_skew_ms;
        }
        if let Some(max) = faults.max_queue_messages {
            published.max_queue_messages = max;
        }
        if let Some(max) = faults.max_queue_bytes {
            published.max_queue_bytes = max;
        }
        published
    }
}

/// The proof-of-work parameters a `FakeRelay` publishes when it demands work.
#[must_use]
pub fn testkit_pow() -> PowParams {
    PowParams {
        algorithm: ALGORITHM_BLAKE2B_LEADING_ZERO_BITS,
        difficulty_bits: TESTKIT_POW_DIFFICULTY_BITS,
        challenge_ttl_ms: 60_000,
    }
}

/// The document a `FakeRelay` publishes by default.
///
/// # Errors
///
/// [`TestkitError::Config`] if the operator strings do not fit their length
/// prefixes, which they do.
pub fn default_capabilities(identity: &SigningKey, published_at_ms: u64) -> Result<Capabilities> {
    let mut capabilities = capabilities::defaults(&identity.public_key(), published_at_ms)
        .map_err(|_| TestkitError::Config("could not build the default capability document"))?;

    // §2.3: no TLS, so no exporter, so both bytes say so. A relay that lies
    // about `transport_security` is lying in its signed document, and the point
    // of publishing it is that lying becomes an act with evidence.
    capabilities.transport_security = TransportSecurity::None.code();
    capabilities.channel_binding_mode = ChannelBindingMode::None.code();
    capabilities.antireplay_persistence = AntiReplayPersistence::Volatile.code();
    // §8.4: a BTreeMap that dies with the process.
    capabilities.durability_mode = DurabilityMode::Memory.code();
    // §13.1: `open` is permitted for a private relay on a closed network.
    capabilities.queue_creation_mode = QueueCreationMode::Open.code();
    capabilities.queue_creation_pow = PowParams::none();
    // §12.3 requires proof of work whenever contact queues are offered, so the
    // difficulty is trivial rather than absent.
    capabilities.contact_append_pow = testkit_pow();
    // §13.3: nothing here rate-limits by source, and the field says so rather
    // than claiming a control that is not implemented.
    capabilities.per_source_limits = 0;

    // §11.1's operator block is "the point of the document". Filling it with
    // the truth about what this process is beats leaving it empty.
    capabilities.operator_name = short("f2z-relay-testkit FakeRelay (NOT A RELAY)")?;
    capabilities.operator_contact = short("https://github.com/free2z/zuu/issues")?;
    capabilities.operator_abuse_contact = short("https://github.com/free2z/zuu/issues")?;
    capabilities.operator_jurisdiction = short("none - a test double, running in a test process")?;
    capabilities.operator_policy_url =
        short("https://github.com/free2z/zuu/blob/main/rs/crates/f2z-relay-testkit/README.md")?;
    capabilities.source_repo_url = short("https://github.com/free2z/zuu")?;
    capabilities.source_commit = short("unversioned - built from a working tree")?;
    capabilities.build_digest = short("none - this binary is not reproducibly built")?;

    Ok(capabilities)
}

fn fallback_capabilities(identity: &SigningKey, published_at_ms: u64) -> Capabilities {
    // Reached only if a short ASCII constant above stops fitting in 255 bytes.
    // The unedited document is still a valid one; it just answers none of the
    // questions §11.1 exists to answer.
    capabilities::defaults(&identity.public_key(), published_at_ms).unwrap_or_else(|_| {
        // `defaults` itself cannot fail for a well-formed key. Rather than
        // panic in `Default`, fall through to a document built from the same
        // call with the same argument; if that is impossible the process has
        // bigger problems than its capability document.
        #[expect(
            clippy::unwrap_used,
            reason = "unreachable: capabilities::defaults is fallible only on an \
                      over-long operator string, and this call passes none"
        )]
        capabilities::defaults(&identity.public_key(), published_at_ms).unwrap()
    })
}

fn short(text: &str) -> Result<ShortBytes> {
    ShortBytes::new(text.as_bytes().to_vec())
        .map_err(|_| TestkitError::Config("an operator string exceeds 255 bytes"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use f2z_relay_proto::capabilities::ClientPolicy;

    #[test]
    fn the_default_document_is_valid_and_says_what_it_is() {
        let config = RelayConfig::default();
        assert!(capabilities::validate(&config.capabilities).is_ok());
        assert_eq!(
            config.capabilities.transport_security,
            TransportSecurity::None.code()
        );
        assert_eq!(
            config.capabilities.durability_mode,
            DurabilityMode::Memory.code()
        );
        assert!(!config.relaxations.any());
    }

    #[test]
    fn a_default_client_refuses_the_default_relay_until_it_opts_in() {
        // §2.3 obligation 3, working. This is the correct behaviour and a
        // client author should see it fail before they see it pass.
        let config = RelayConfig::default();
        let strict = ClientPolicy::default();
        assert!(strict.accept(&config.capabilities).is_err());

        let opted_in = ClientPolicy {
            allow_insecure_transport: true,
            ..ClientPolicy::default()
        };
        assert!(opted_in.accept(&config.capabilities).is_ok());
    }

    #[test]
    fn the_unsound_antireplay_fault_changes_the_published_document() {
        let config = RelayConfig::default();
        let faults = PolicyFaults {
            unsound_antireplay_window: true,
            ..PolicyFaults::default()
        };
        let published = config.published_capabilities(faults);
        assert_eq!(published.antireplay_window_ms, published.clock_skew_ms);
        // Still a *valid* document — that is the whole finding of #586.
        assert!(capabilities::validate(&published).is_ok());
        // And still refused by a client that checks the relation.
        let policy = ClientPolicy {
            allow_insecure_transport: true,
            ..ClientPolicy::default()
        };
        assert!(policy.accept(&published).is_err());
    }

    #[test]
    fn pow_mode_publishes_parameters_a_client_can_satisfy() {
        let config = RelayConfig::default().with_pow();
        assert!(capabilities::validate(&config.capabilities).is_ok());
        assert!(config.capabilities.queue_creation_pow.is_required());
    }
}
