//! Wiring: a [`Config`] in, a running relay out.
//!
//! Startup order is the order in which failure is cheapest to explain:
//!
//! 1. **Check the configuration.** Everything [`Config::check`] can decide
//!    without touching the world — §2.3's bind rule, §5.5's retention
//!    invariant, §7.7's 30-day ceiling, §12.3's contact-queue caps.
//! 2. **Establish the identity** (§5.2). Losing it makes this a *different
//!    relay* to every client holding a queue advert that names it, so it
//!    happens before anything is bound and it fails loudly.
//! 3. **Open the store**, which is where `synchronous = FULL` and
//!    `secure_delete = ON` are verified rather than assumed.
//! 4. **Build and sign the capability document** from the same values the
//!    engine will enforce. A document that fails §11.1's own validity rules
//!    fails here, rather than being served to clients that will refuse it.
//! 5. **Start the commit writer**, then the listeners, then the tick.
//!
//! Shutdown is a `watch` flag every task selects on, plus a `NOTICE(2)` to
//! subscribed readers (§6.4) so a client learns the relay is going away rather
//! than inferring it from a closed socket.

use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use crate::abuse::AbuseGuard;
use crate::caps;
use crate::commit::CommitWriter;
use crate::config::Config;
use crate::engine::Relay;
use crate::metrics::Metrics;
use crate::subscriptions::{NOTICE_SHUTDOWN, Subscriptions};

/// Why a relay could not start.
#[derive(Debug)]
pub enum StartError {
    /// The configuration is not usable.
    Config(crate::config::ConfigError),
    /// The identity key could not be established.
    Identity(crate::identity::IdentityError),
    /// The store could not be opened.
    Store(f2z_relay_store::StoreError),
    /// The capability document could not be built or signed.
    Capabilities(crate::caps::CapabilitiesError),
    /// TLS could not be configured.
    Tls(crate::tls::TlsError),
    /// The protocol listener could not be bound.
    Listen(crate::listener::ListenError),
    /// The admin listener could not be bound.
    Admin(crate::admin::AdminError),
    /// A background thread could not be spawned.
    Spawn(std::io::Error),
    /// The operating system refused to provide randomness.
    NoRandomness,
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Config(error) => write!(f, "{error}"),
            Self::Identity(error) => write!(f, "{error}"),
            Self::Store(error) => write!(f, "store: {error}"),
            Self::Capabilities(error) => write!(f, "{error}"),
            Self::Tls(error) => write!(f, "{error}"),
            Self::Listen(error) => write!(f, "{error}"),
            Self::Admin(error) => write!(f, "{error}"),
            Self::Spawn(error) => write!(f, "cannot start the commit writer: {error}"),
            Self::NoRandomness => f.write_str("the operating system refused to provide randomness"),
        }
    }
}

impl std::error::Error for StartError {}

/// A running relay.
pub struct Server {
    relay: Arc<Relay>,
    protocol_addr: std::net::SocketAddr,
    admin_addr: Option<std::net::SocketAddr>,
    shutdown: watch::Sender<bool>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Server")
            .field("protocol_addr", &self.protocol_addr)
            .field("admin_addr", &self.admin_addr)
            .finish_non_exhaustive()
    }
}

impl Server {
    /// Start a relay.
    ///
    /// # Errors
    ///
    /// [`StartError`], every variant of which is fatal. Nothing here degrades:
    /// a relay that cannot serve TLS must not silently serve plaintext, and a
    /// relay that cannot open its store must not serve from memory.
    pub async fn start(config: Config) -> Result<Self, StartError> {
        config.check().map_err(StartError::Config)?;
        if let Ok(level) = config.log_level() {
            crate::log::set_level(level);
        }

        let identity = if config.identity.seed.is_empty() {
            crate::identity::load_or_create(
                std::path::Path::new(&config.identity.path),
                config.identity.generate,
            )
        } else {
            crate::identity::from_hex(&config.identity.seed)
        }
        .map_err(StartError::Identity)?;

        let store: Arc<dyn f2z_relay_store::RelayStore + Send + Sync> =
            match config.store.backend.as_str() {
                "memory" => Arc::new(f2z_relay_store::MemoryStore::new()),
                // Anything else was rejected by `check`; `sqlite` is the only
                // remaining value.
                _ => Arc::new(
                    f2z_relay_store::SqliteStore::open(&config.store.path)
                        .map_err(StartError::Store)?,
                ),
            };
        let durability = store.durability();

        let now = crate::now_ms();
        let capabilities = caps::build(&config, &identity.public_key(), durability, now)
            .map_err(StartError::Capabilities)?;
        let padding = f2z_codec::padding::PaddingBuckets::new(config.padding.sizes.clone())
            .map_err(|_| {
                StartError::Config(crate::config::ConfigError::Invalid(
                    "padding.sizes",
                    "is not a valid ascending set".to_owned(),
                ))
            })?;
        let published = caps::publish(&identity, capabilities).map_err(StartError::Capabilities)?;

        let metrics = Arc::new(Metrics::new());
        let subscriptions = Arc::new(Subscriptions::new());
        let abuse = Arc::new(AbuseGuard::new(
            config.limits.clone(),
            config.antiabuse.per_source_limits,
            crate::rng::seed().map_err(|_| StartError::NoRandomness)?,
        ));

        let writer = CommitWriter::start(
            Arc::clone(&store),
            Arc::clone(&metrics),
            Duration::from_millis(u64::from(config.commit.window_ms)),
            usize::try_from(config.commit.max_batch).unwrap_or(256),
        )
        .map_err(StartError::Spawn)?;

        let acceptor = if config.tls_enabled() {
            Some(
                crate::tls::acceptor(
                    std::path::Path::new(&config.listen.tls_cert),
                    std::path::Path::new(&config.listen.tls_key),
                )
                .map_err(StartError::Tls)?,
            )
        } else {
            None
        };

        let listen_addr = config.listen_addr().map_err(StartError::Config)?;
        let admin_enabled = config.admin.enabled;
        let admin_configured = config.admin_addr().map_err(StartError::Config)?;

        let listener =
            crate::listener::bind(listen_addr, acceptor.is_some(), config.listen.insecure)
                .await
                .map_err(StartError::Listen)?;
        let protocol_addr = listener
            .local_addr()
            .map_err(|error| StartError::Listen(crate::listener::ListenError::Io(error)))?;

        let admin_listener = if admin_enabled {
            Some(
                crate::admin::bind(admin_configured)
                    .await
                    .map_err(StartError::Admin)?,
            )
        } else {
            None
        };
        let admin_addr = admin_listener
            .as_ref()
            .and_then(|listener| listener.local_addr().ok());

        let relay = Arc::new(Relay::new(
            config,
            identity,
            published,
            padding,
            Arc::clone(&store),
            writer,
            Arc::clone(&subscriptions),
            Arc::clone(&abuse),
            Arc::clone(&metrics),
        ));

        let (shutdown, watcher) = watch::channel(false);
        let mut tasks = Vec::with_capacity(3);
        tasks.push(tokio::spawn(crate::listener::serve(
            Arc::clone(&relay),
            listener,
            acceptor,
            watcher.clone(),
        )));
        if let Some(admin_listener) = admin_listener {
            tasks.push(tokio::spawn(crate::admin::serve(
                Arc::clone(&relay),
                admin_listener,
                watcher.clone(),
            )));
        }
        tasks.push(tokio::spawn(crate::expiry::run(
            Arc::clone(&relay),
            watcher,
        )));

        crate::log_info!("relay listening", "port" = protocol_addr.port());
        Ok(Self {
            relay,
            protocol_addr,
            admin_addr,
            shutdown,
            tasks,
        })
    }

    /// The bound protocol address. With port 0 this is the port the OS chose.
    #[must_use]
    pub const fn protocol_addr(&self) -> std::net::SocketAddr {
        self.protocol_addr
    }

    /// The bound admin address, if the admin listener is enabled.
    #[must_use]
    pub const fn admin_addr(&self) -> Option<std::net::SocketAddr> {
        self.admin_addr
    }

    /// The relay itself, for a test that wants to read its published document.
    #[must_use]
    pub const fn relay(&self) -> &Arc<Relay> {
        &self.relay
    }

    /// The `ws://` or `wss://` endpoint URL, path included (§2.1).
    #[must_use]
    pub fn url(&self) -> String {
        let scheme = if self.relay.config().tls_enabled() {
            "wss"
        } else {
            "ws"
        };
        format!(
            "{scheme}://{}{}",
            self.protocol_addr,
            crate::transport::RELAY_PATH
        )
    }

    /// Stop accepting, tell subscribed readers, and wait for the tasks.
    ///
    /// §6.4's `NOTICE(2)` is sent first: a client that learns the relay is
    /// going away can stop sending and reconnect elsewhere, rather than
    /// discovering it from a closed socket and treating it as a fault.
    pub async fn shutdown(self) {
        self.relay.subscriptions().notify_all(
            NOTICE_SHUTDOWN,
            crate::now_ms(),
            self.relay.metrics(),
        );
        // A moment for the writers to drain that notice before the same flag
        // closes their connections.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let _ = self.shutdown.send(true);
        for task in self.tasks {
            let _ = task.await;
        }
        crate::log_info!("relay stopped");
    }
}
