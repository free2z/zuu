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
//!
//! # Every task started here is supervised (zuu#671)
//!
//! The tasks below are spawned detached, and a panic in one of them ends that
//! task and nothing else. That produced the worst shape available: a process
//! whose protocol listener had died, whose health listener was still answering
//! `/healthz` with `200`, and which therefore passed the startup, readiness and
//! liveness probes *and* the load balancer's health check while completing
//! nothing for a single client. Under delete-on-ack that is not a degraded
//! service — a sender that is told `accepted` by a relay that then loses the
//! message has had data destroyed between them.
//!
//! So [`Server::run_until_stopped`] selects over the join handles alongside the
//! caller's signal, and **a supervised task that ends before shutdown was asked
//! for takes the whole process down**. The deployment is `replicas: 1` with
//! `strategy: Recreate`, so this is a brief outage rather than a silent wrong
//! answer: a crash-looping pod fails its probes, is visibly not `Ready`, and
//! leaves the load balancer with no endpoint to send traffic to. That is the
//! correct trade under delete-on-ack, and it is the one the health-probe work
//! of #665 assumed was already true.
//!
//! # The write path is supervised too, and it is not a task (zuu#685)
//!
//! The four tasks above were the whole of #683's supervision, and the relay has
//! a **fifth** long-lived worker that owns the entire write path: the
//! group-commit writer, which is an OS thread because an fsync is a blocking
//! syscall of unbounded duration. `Supervised` holds `JoinHandle`s, so a thread
//! could not be in it — a type boundary, not a missed name — and a dead writer
//! left the relay returning `ERR_UNAVAILABLE` for every `APPEND` and
//! `CONTACT_APPEND` while `/healthz` answered `200` and every probe passed.
//! Under delete-on-ack that is the worst failure in the system: `accepted` for
//! messages that never became durable.
//!
//! It is covered by supervising a **task that waits on the writer thread's
//! liveness signal** ([`crate::commit::WriterStopped`]) and registering that
//! task in the same list as the other four. The watchdog is therefore itself
//! supervised: it cannot be the unsupervised thing that closes a supervision
//! gap.

use std::future::Future;
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
    /// The health listener could not be bound.
    Health(crate::admin::AdminError),
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
            Self::Health(error) => write!(f, "health: {error}"),
            Self::Spawn(error) => write!(f, "cannot start the commit writer: {error}"),
            Self::NoRandomness => f.write_str("the operating system refused to provide randomness"),
        }
    }
}

impl std::error::Error for StartError {}

/// The protocol listener — the only task that serves clients (§2.1).
pub const PROTOCOL_TASK: &str = "protocol listener";
/// The loopback-only operator surface: `/healthz` and `/metrics`.
pub const ADMIN_TASK: &str = "admin listener";
/// The health-only surface the kubelet and the load balancer probe (#665).
pub const HEALTH_TASK: &str = "health listener";
/// §7.7's TTL sweep and §5.5's seen-set aging.
pub const EXPIRY_TASK: &str = "queue expiry tick";
/// The group-commit writer — **the entire write path** (zuu#685).
///
/// The worker is an OS thread rather than a tokio task, for the reason
/// `commit.rs` argues at length: an fsync is a blocking syscall of unbounded
/// duration. Supervision reaches it anyway through a task that waits on the
/// thread's liveness signal, and that task is registered here like every other,
/// so the watchdog is supervised by the same mechanism it feeds.
pub const COMMIT_TASK: &str = "group-commit writer";

/// How long a failing relay is given to close its sockets politely.
///
/// It is a bound and not a promise: the point of the failure path is that the
/// process stops, and a task that will not finish must not be able to keep the
/// listener open by refusing to.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// A running relay.
pub struct Server {
    relay: Arc<Relay>,
    protocol_addr: std::net::SocketAddr,
    admin_addr: Option<std::net::SocketAddr>,
    health_addr: Option<std::net::SocketAddr>,
    shutdown: watch::Sender<bool>,
    tasks: Vec<Supervised>,
    /// A second handle on the group-commit writer, so that a test can kill it.
    /// See [`Server::stop_commit_writer`].
    #[cfg(any(test, feature = "testing"))]
    writer: CommitWriter,
}

/// A task the relay cannot serve without, and the name an operator sees when it
/// is the one that ended.
struct Supervised {
    name: &'static str,
    /// `None` once it has been observed to finish, so it is never polled twice.
    handle: Option<tokio::task::JoinHandle<()>>,
}

/// Why a relay stopped serving.
///
/// Deliberately **not** `#[non_exhaustive]`: the binary is a separate crate, so
/// that attribute would force a wildcard arm in `main`, and a wildcard arm is
/// how a future stop reason silently becomes a zero exit. A new variant here
/// should break every caller until each has decided what it means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    /// The caller's signal fired. An ordinary shutdown; exit zero.
    Requested,
    /// A supervised task ended before shutdown was asked for — it panicked, or
    /// it was cancelled. The relay cannot do its job and the process must not
    /// go on passing health checks; exit non-zero.
    TaskEnded(&'static str),
}

impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Server")
            .field("protocol_addr", &self.protocol_addr)
            .field("admin_addr", &self.admin_addr)
            .field("health_addr", &self.health_addr)
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

        let (writer, writer_stopped) = CommitWriter::start(
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

        // Bound AFTER the store and the identity, like everything else here: a
        // relay that answers `/healthz` before it can serve is a relay whose
        // readiness probe lies during exactly the window the probe exists for.
        let health_listener = if config.health.enabled {
            let health_configured = config.health_addr().map_err(StartError::Config)?;
            Some(
                crate::admin::bind_health(health_configured)
                    .await
                    .map_err(StartError::Health)?,
            )
        } else {
            None
        };
        let health_addr = health_listener
            .as_ref()
            .and_then(|listener| listener.local_addr().ok());

        #[cfg(any(test, feature = "testing"))]
        let writer_handle = writer.clone();

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
        let mut tasks = Vec::with_capacity(5);
        let mut supervise = |name, handle| {
            tasks.push(Supervised {
                name,
                handle: Some(handle),
            })
        };
        // zuu#685. The write path is an OS thread, so what is supervised here
        // is a **task that waits for that thread to end**. It is in the same
        // list as everything else on purpose: a watchdog outside the mechanism
        // would move the fail-open rather than close it, and this one's own
        // death is reported exactly as the writer's would be.
        //
        // It ends on an ordinary shutdown too, like every other task here —
        // the writer thread is left to be reaped with the process, which is
        // what it did before this fix. Waiting for it would mean waiting for a
        // `recv` that only returns when the last `Sender` is dropped, and the
        // connection tasks hold those.
        {
            let mut shutting_down = watcher.clone();
            supervise(
                COMMIT_TASK,
                tokio::spawn(async move {
                    tokio::select! {
                        () = writer_stopped.wait() => {}
                        _ = shutting_down.changed() => {}
                    }
                }),
            );
        }
        supervise(
            PROTOCOL_TASK,
            tokio::spawn(crate::listener::serve(
                Arc::clone(&relay),
                listener,
                acceptor,
                watcher.clone(),
            )),
        );
        if let Some(admin_listener) = admin_listener {
            supervise(
                ADMIN_TASK,
                tokio::spawn(crate::admin::serve(
                    Arc::clone(&relay),
                    admin_listener,
                    crate::admin::Scope::Operator,
                    watcher.clone(),
                )),
            );
        }
        if let Some(health_listener) = health_listener {
            supervise(
                HEALTH_TASK,
                tokio::spawn(crate::admin::serve(
                    Arc::clone(&relay),
                    health_listener,
                    crate::admin::Scope::HealthOnly,
                    watcher.clone(),
                )),
            );
        }
        // Supervised for a correctness reason rather than an availability one:
        // §7.7's TTLs stop being enforced the moment this task is gone, and
        // nothing a client can observe says so.
        supervise(
            EXPIRY_TASK,
            tokio::spawn(crate::expiry::run(Arc::clone(&relay), watcher)),
        );

        crate::log_info!("relay listening", "port" = protocol_addr.port());
        Ok(Self {
            relay,
            protocol_addr,
            admin_addr,
            health_addr,
            shutdown,
            tasks,
            #[cfg(any(test, feature = "testing"))]
            writer: writer_handle,
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

    /// The bound health address, if the health listener is enabled.
    #[must_use]
    pub const fn health_addr(&self) -> Option<std::net::SocketAddr> {
        self.health_addr
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

    /// Serve until `signal` fires **or a supervised task ends**, then stop.
    ///
    /// This is the whole of zuu#671's fix and it is deliberately the only
    /// supported way to run a relay: `Server::start` followed by an `await` on
    /// a signal leaves the join handles unobserved, and an unobserved task that
    /// panics is a relay that answers `/healthz` with `200` and serves nobody.
    ///
    /// Either way the listeners are closed before this returns — bounded by
    /// [`SHUTDOWN_GRACE`], because on the failure path a wedged task must not be
    /// able to hold the protocol port open. A [`Stopped::TaskEnded`] result is
    /// the caller's instruction to exit **non-zero**: under `replicas: 1` and
    /// `strategy: Recreate` a crash-loop is a short, visible outage, and the
    /// alternative is a `Ready` pod in the load balancer's rotation that
    /// silently drops what senders were told was accepted.
    pub async fn run_until_stopped(mut self, signal: impl Future<Output = ()>) -> Stopped {
        let stopped = {
            let mut signal = core::pin::pin!(signal);
            tokio::select! {
                biased;
                name = self.supervise() => Stopped::TaskEnded(name),
                () = &mut signal => Stopped::Requested,
            }
        };
        if matches!(stopped, Stopped::TaskEnded(_)) {
            // The name is not in this line on purpose: `log::line` takes a
            // literal message and numeric fields only, which is what keeps
            // payloads, addresses and keys out of the operator log. `main`
            // prints the name to stderr, where an operator reads a fatal.
            crate::log_error!("a supervised task ended; stopping the relay");
        }
        if tokio::time::timeout(SHUTDOWN_GRACE, self.shutdown())
            .await
            .is_err()
        {
            crate::log_error!("shutdown did not finish in time; exiting anyway");
        }
        stopped
    }

    /// Resolve when any supervised task ends. Pending while all are alive.
    ///
    /// Each handle is polled at most to completion once — a `JoinHandle` polled
    /// after it has finished panics, and this runs inside a `select!` that may
    /// poll it many times.
    async fn supervise(&mut self) -> &'static str {
        let tasks = &mut self.tasks;
        core::future::poll_fn(move |cx| {
            for task in tasks.iter_mut() {
                let Some(handle) = task.handle.as_mut() else {
                    continue;
                };
                if core::pin::Pin::new(handle).poll(cx).is_ready() {
                    task.handle = None;
                    return core::task::Poll::Ready(task.name);
                }
            }
            core::task::Poll::Pending
        })
        .await
    }

    /// Kill the group-commit writer **thread**, so that a test can produce the
    /// failure [`COMMIT_TASK`]'s supervision exists for. Returns whether the
    /// message could be delivered.
    ///
    /// Not [`Self::abort_task`]: aborting the watchdog would prove only that
    /// the watchdog is in the supervised list, and would pass identically if
    /// nothing connected it to the writer. This kills the thread that owns the
    /// write path, and the assertion is that the process stops — which is the
    /// chain the defect broke.
    #[cfg(any(test, feature = "testing"))]
    pub fn stop_commit_writer(&self) -> bool {
        self.writer.stop_for_test()
    }

    /// Abort a supervised task by name, so that a test can produce the failure
    /// this supervision exists for. Returns whether one was found.
    ///
    /// There is no other way to write that test. The failure it stands in for
    /// is a **panic**, which comes from a bug rather than from an input, and a
    /// fault-injection hook inside the shipped listener would be a far worse
    /// thing to carry than a method behind a feature that never reaches the
    /// binary. An aborted task and a panicked one are the same shape here:
    /// the handle completes, and nothing else in the process notices.
    #[cfg(any(test, feature = "testing"))]
    pub fn abort_task(&mut self, name: &str) -> bool {
        self.tasks
            .iter()
            .find(|task| task.name == name)
            .and_then(|task| task.handle.as_ref())
            .is_some_and(|handle| {
                handle.abort();
                true
            })
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
            if let Some(handle) = task.handle {
                let _ = handle.await;
            }
        }
        crate::log_info!("relay stopped");
    }
}
