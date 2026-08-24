//! `FakeRelay` — the handle a client developer actually holds.
//!
//! One relay, two ways to reach it, and the same [`crate::engine::Relay`]
//! behind both:
//!
//! ```text
//!                       ┌────────────────────────────┐
//!   FakeRelay::connect ─┤                            │
//!    (tokio::io::duplex)│   connection::drive         │
//!                       │        engine::Relay        │
//!   ws://127.0.0.1:0 ───┤                            │
//!    (RelayServer)      └────────────────────────────┘
//! ```
//!
//! The in-process path is for the tests that run in milliseconds. The socket
//! path is for the framing, ordering and reconnection bugs the in-process path
//! physically cannot expose. Running the conformance suite against both and
//! comparing the verdicts is what turns "they share an implementation" from a
//! claim into a check — `tests/conformance.rs` does exactly that.

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use f2z_codec::commands::{Capabilities, SignedCapabilities};
use f2z_codec::types::{ChannelBinding, PublicKey, RelayId};
use futures_util::future::BoxFuture;

use crate::client::{Client, ClientConfig};
use crate::clock::Clock;
use crate::config::RelayConfig;
use crate::engine::Relay;
use crate::error::Result;
use crate::faults::FaultInjector;
use crate::transport::{Transport, duplex};
use crate::websocket::{self, RelayServer};

/// The buffer of an in-process connection, in bytes.
///
/// Generous on purpose: a relay writer and a client writer that both block on a
/// full pipe is a deadlock in the harness, not a finding about the protocol.
/// §4.1's `max_frame_bytes` is what should refuse an oversize frame.
const DUPLEX_CAPACITY: usize = 4 * 1024 * 1024;

/// A spec-conforming relay you can break on purpose.
#[derive(Clone, Debug)]
pub struct FakeRelay {
    relay: Arc<Relay>,
    /// How many client configurations this relay has handed out.
    ///
    /// §5.5's seen-set is relay-wide, and on a frozen clock nothing in it ever
    /// ages out. Two connections drawing nonces from one stream would therefore
    /// collide on `(signer_key, nonce)` the moment the same queue key signed
    /// from both, and the second command would be refused as a replay — a
    /// harness bug that looks exactly like a relay bug and costs an afternoon.
    /// Each configuration gets its own stream, derived from this counter, so it
    /// is unique *and* reproducible.
    connections: Arc<AtomicU64>,
}

impl FakeRelay {
    /// Build a relay.
    ///
    /// # Errors
    ///
    /// As [`Relay::new`].
    pub fn new(config: RelayConfig) -> Result<Self> {
        Ok(Self {
            relay: Arc::new(Relay::new(config)?),
            connections: Arc::new(AtomicU64::new(0)),
        })
    }

    /// A relay on [`RelayConfig::default`]: frozen clock, `ws://`-honest
    /// capability document, open queue creation, nothing faulted.
    ///
    /// # Errors
    ///
    /// As [`Relay::new`].
    pub fn with_defaults() -> Result<Self> {
        Self::new(RelayConfig::default())
    }

    /// The live fault handle. Cloneable, and armed rules take effect on the
    /// next frame — arming is not a restart.
    #[must_use]
    pub fn faults(&self) -> FaultInjector {
        self.relay.faults().clone()
    }

    /// The relay's clock. Frozen unless the configuration said otherwise.
    #[must_use]
    pub fn clock(&self) -> Clock {
        self.relay.clock().clone()
    }

    /// §5.2's identity binding.
    #[must_use]
    pub fn relay_id(&self) -> RelayId {
        self.relay.relay_id()
    }

    /// The relay's long-term public key.
    #[must_use]
    pub fn identity_key(&self) -> PublicKey {
        self.relay.identity_key()
    }

    /// The channel binding both ends use (§5.3). Zeros in `none` mode.
    #[must_use]
    pub fn channel_binding(&self) -> ChannelBinding {
        self.relay.channel_binding()
    }

    /// The document as it stands now, policy faults included.
    #[must_use]
    pub fn published_capabilities(&self) -> Capabilities {
        self.relay.published_capabilities()
    }

    /// The signed document (§11.1).
    ///
    /// # Errors
    ///
    /// As [`Relay::signed_capabilities`].
    pub fn signed_capabilities(&self) -> Result<SignedCapabilities> {
        self.relay.signed_capabilities()
    }

    /// Send `NOTICE(3)` to every subscribed connection (§6.4).
    ///
    /// Arming a policy fault changes the published document; this is how a
    /// client's re-fetch path gets exercised rather than assumed.
    pub fn announce_capability_change(&self) {
        self.relay.announce_capability_change();
    }

    /// A client configuration that already knows this relay: its channel
    /// binding, its `relay_id`, and its published padding set.
    ///
    /// Supplying `expected_relay_id` mirrors what a real client has — §7.2's
    /// advert carries `(relay_url, relay_id, send_addr)` together, and §5.2's
    /// substitution check is only possible because of it.
    #[must_use]
    pub fn client_config(&self) -> ClientConfig {
        let published = self.published_capabilities();
        let padding =
            f2z_codec::padding::PaddingBuckets::new(published.padding_sizes.as_slice().to_vec())
                .unwrap_or_default();
        ClientConfig {
            channel_binding: self.channel_binding(),
            expected_relay_id: Some(self.relay_id()),
            padding,
            nonce_seed: self.next_nonce_seed(),
            ..ClientConfig::default()
        }
    }

    /// A nonce stream no other client of this relay has been given.
    fn next_nonce_seed(&self) -> [u8; 32] {
        let ordinal = self.connections.fetch_add(1, Ordering::SeqCst);
        let mut input = [0u8; 40];
        if let Some(slot) = input.get_mut(..32) {
            slot.copy_from_slice(&self.relay.config().rng_seed);
        }
        if let Some(slot) = input.get_mut(32..) {
            slot.copy_from_slice(&ordinal.to_be_bytes());
        }
        *f2z_codec::hash::hash(b"f2z-relay-testkit/client-nonce-seed/v1", &input).as_bytes()
    }

    /// Open an in-process connection and spawn the relay side of it.
    ///
    /// Needs a Tokio runtime, because the relay half runs as a task.
    #[must_use]
    pub fn connect(&self) -> Transport {
        let (client_side, relay_side) = duplex(DUPLEX_CAPACITY);
        let relay = Arc::clone(&self.relay);
        tokio::spawn(crate::connection::drive(relay, relay_side));
        client_side
    }

    /// An in-process connection with `HELLO` already completed.
    ///
    /// # Errors
    ///
    /// As [`Client::connect`].
    pub async fn client(&self) -> Result<Client> {
        Client::connect(self.connect(), self.client_config()).await
    }

    /// Listen on `127.0.0.1:0` and return the running server.
    ///
    /// # Errors
    ///
    /// As [`websocket::bind`] and [`websocket::serve`].
    pub async fn listen_loopback(&self) -> Result<RelayServer> {
        let addr: SocketAddr = ([127, 0, 0, 1], 0).into();
        self.listen(addr, false).await
    }

    /// Listen on `addr`.
    ///
    /// §2.3: a non-loopback bind without TLS is refused unless
    /// `insecure_listen` is set, which is a deliberate act with published
    /// consequences rather than a warning.
    ///
    /// # Errors
    ///
    /// As [`websocket::bind`] and [`websocket::serve`].
    pub async fn listen(&self, addr: SocketAddr, insecure_listen: bool) -> Result<RelayServer> {
        let listener = websocket::bind(addr, insecure_listen).await?;
        websocket::serve(Arc::clone(&self.relay), listener)
    }

    /// This relay as an in-process conformance target.
    #[must_use]
    pub fn in_process_endpoint(&self) -> InProcessEndpoint {
        InProcessEndpoint {
            relay: self.clone(),
        }
    }

    /// This relay as a conformance target reached over a real socket.
    #[must_use]
    pub fn websocket_endpoint(&self, server: &RelayServer) -> WebSocketEndpoint {
        WebSocketEndpoint {
            url: server.url(),
            config: self.client_config(),
            faults: Some(self.faults()),
            clock: Some(self.clock()),
        }
    }
}

/// Something the conformance suite can be run against.
///
/// Two implementations ship here — in-process and WebSocket — and a third is
/// the whole point: `f2z-relay`, once it exists, is a [`WebSocketEndpoint`]
/// with a URL and no fault handle. The suite then reports the fault vectors as
/// skipped rather than failing them, so the same file is a real check of both
/// relays instead of two files that drift.
pub trait Endpoint: Send + Sync {
    /// Open a transport to this relay.
    fn connect(&self) -> BoxFuture<'_, Result<Transport>>;

    /// A client configuration suited to this relay.
    fn client_config(&self) -> ClientConfig;

    /// The fault handle, when the target is one we can break on purpose.
    /// `None` for a real relay, which is not a failure — it is the reason the
    /// suite reports "skipped" rather than "passed".
    fn faults(&self) -> Option<FaultInjector> {
        None
    }

    /// The clock, when the target's clock can be steered.
    fn clock(&self) -> Option<Clock> {
        None
    }

    /// How to name this target in a report.
    fn describe(&self) -> String;
}

/// The in-process target.
#[derive(Clone, Debug)]
pub struct InProcessEndpoint {
    relay: FakeRelay,
}

impl InProcessEndpoint {
    /// The relay behind it.
    #[must_use]
    pub const fn relay(&self) -> &FakeRelay {
        &self.relay
    }
}

impl Endpoint for InProcessEndpoint {
    fn connect(&self) -> BoxFuture<'_, Result<Transport>> {
        Box::pin(async move { Ok(self.relay.connect()) })
    }

    fn client_config(&self) -> ClientConfig {
        self.relay.client_config()
    }

    fn faults(&self) -> Option<FaultInjector> {
        Some(self.relay.faults())
    }

    fn clock(&self) -> Option<Clock> {
        Some(self.relay.clock())
    }

    fn describe(&self) -> String {
        "in-process (tokio::io::duplex)".to_owned()
    }
}

/// A target reached over a real WebSocket — a `FakeRelay`'s listener, or any
/// other relay that speaks `WIRE.md` v1.
#[derive(Clone, Debug)]
pub struct WebSocketEndpoint {
    url: String,
    config: ClientConfig,
    faults: Option<FaultInjector>,
    clock: Option<Clock>,
}

impl WebSocketEndpoint {
    /// A target at `url`, with default client policy.
    ///
    /// This is the constructor `f2z-relay` will be run through. It has no fault
    /// handle and no clock, which the suite reports honestly.
    #[must_use]
    pub fn new(url: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            config: ClientConfig::default(),
            faults: None,
            clock: None,
        }
    }

    /// Use this client configuration instead of the default.
    #[must_use]
    pub fn with_client_config(mut self, config: ClientConfig) -> Self {
        self.config = config;
        self
    }

    /// The endpoint URL.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }
}

impl Endpoint for WebSocketEndpoint {
    fn connect(&self) -> BoxFuture<'_, Result<Transport>> {
        Box::pin(async move { websocket::connect(&self.url).await })
    }

    fn client_config(&self) -> ClientConfig {
        self.config.clone()
    }

    fn faults(&self) -> Option<FaultInjector> {
        self.faults.clone()
    }

    fn clock(&self) -> Option<Clock> {
        self.clock.clone()
    }

    fn describe(&self) -> String {
        format!("websocket {}", self.url)
    }
}
