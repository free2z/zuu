//! Wiring: build the log from a configuration, start the epoch scheduler, and
//! serve.
//!
//! # The scheduler is a separate task and it publishes on a deadline
//!
//! `KT.md` §5.1: an epoch every `epoch_interval` seconds **whether or not there
//! is anything to publish**. So this is a timer, not a queue drain — it does
//! not wait for work and it does not skip a tick because the batch was empty.
//! That is the whole point: a heartbeat converts "the log has been silent for
//! six hours" from an ambiguity into a fault with a timestamp.
//!
//! A tick that fails is logged and retried on the next one. It is deliberately
//! not fatal: an epoch the log could not sign because a KMS was briefly
//! unreachable is better published late than not at all, and a process that
//! exits on it takes the whole directory down for a transient.
//!
//! # Every task started here is supervised (zuu#684)
//!
//! A tick that *fails* is a transient. The scheduler **task** ending is not:
//! it panicked, or it was cancelled, and from that moment the log publishes
//! nothing at all. The listener does not care — `/healthz` answers from process
//! state, so the pod stays `Ready`, stays in rotation, and serves §9.2's
//! endpoints correctly forever, over a directory that has stopped moving.
//!
//! **That failure is silent in a way `f2z-relay`'s was not.** A relay that has
//! stopped accepting is loud: senders fail immediately. A key-transparency log
//! that has stopped publishing epochs errors on nothing. Clients keep verifying
//! against the last signed tree head, which stays valid; lookups keep
//! succeeding; and no client can distinguish "no directory changes happened"
//! from "the log stopped incorporating them".
//!
//! §5.1's heartbeat epochs exist precisely so that silence is detectable — an
//! epoch published on cadence even with nothing to add, so a client that sees
//! none knows something is wrong. A dead scheduler defeats that mechanism
//! rather than tripping it: **there are no heartbeats to miss, because there is
//! nothing left to emit them.**
//!
//! So [`Server::run_until_stopped`] selects over the join handles alongside the
//! caller's signal, and a supervised task that ends before shutdown was asked
//! for takes the whole process down with a non-zero exit — bounded by
//! [`SHUTDOWN_GRACE`], so a wedged task cannot keep the listener open by
//! refusing to finish. This is `f2z-relay`'s supervision idiom (zuu#671,
//! zuu#683) applied unchanged; there is deliberately not a second one.

use std::future::Future;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::watch;

use crate::api::{AppState, router};
use crate::config::Config;
use crate::error::{LogError, Result};
use crate::log::LogService;
use crate::ratelimit::RateLimiter;
use crate::signer::{FileSigner, LogSigner};
use crate::vrf::FileVrf;
use crate::{descriptor, now_ms, policy};

/// §5.1's cadence, heartbeat epochs included. The task the log exists to run.
pub const EPOCH_TASK: &str = "epoch scheduler";
/// §9.2's endpoints and `/healthz` — the surface every probe reads.
pub const HTTP_TASK: &str = "http listener";

/// How long a failing log is given to close its listener politely.
///
/// A bound and not a promise: the point of the failure path is that the process
/// stops, and a task that will not finish must not be able to hold the port by
/// refusing to.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Build every part of a running log from a configuration.
///
/// # Errors
///
/// [`LogError::Config`] for a configuration the log cannot start on,
/// [`LogError::Storage`] for a journal it cannot replay.
pub async fn build(config: &Config) -> Result<Arc<AppState>> {
    let signer = build_signer(config)?;

    // `genesis_log_pk` is what `log_id` is derived from and it never changes
    // (§6.1). Until §6.4's rotation has been exercised it is the current
    // signing key, and an operator who has not stated one gets that — because
    // the alternative, defaulting it to something else, would silently change
    // the log's identity.
    let mut settings = config.settings.clone();
    if settings.genesis_log_pk.is_zero() {
        settings.genesis_log_pk = signer.public_key();
    }
    let log_id = f2z_kt_core::labels::log_id(&settings.genesis_log_pk);

    let vrf = FileVrf::load(&config.vrf_key_file)?;
    let authority = config.authority_config(log_id)?;

    if !authority.authorities().vouches() {
        // Loud, once, at startup. zuu#594: a log with no authority hands any
        // unregistered handle to whoever asks first, and an operator who did
        // not mean to run that way should find out here rather than from a user.
        log::warn!(
            "NO HANDLE AUTHORITY CONFIGURED: any unregistered handle on this log can be claimed \
             by anyone who proves possession of an identity key. This is reported to clients in \
             the signed document at /.well-known/free2z-kt/v1/authority."
        );
    }

    if config.witnesses.is_empty() {
        // Loud, once, at startup, in the shape zuu#594's warning above uses.
        // zuu#669: this configuration used to make `/kt/v1/cosign` accept a
        // cosignature from **any** key, permanently. It now accepts none, and an
        // operator who meant to collect cosignatures should find that out here
        // rather than from a witness whose polls have been refused all week.
        log::warn!(
            "NO WITNESS KEYS CONFIGURED: /kt/v1/cosign will refuse every cosignature with \
             ERR_NOT_A_WITNESS, and this log will serve zero cosignatures in every tree-head \
             bundle. Set one `witness_pk` line per witness you actually run."
        );
    }

    let log = LogService::open(
        &config.data_dir,
        settings.clone(),
        Arc::clone(&signer),
        vrf,
        authority.clone(),
        config.witnesses.clone(),
    )
    .await?;

    // Genesis. §6.3's chain has to start somewhere and `/kt/v1/sth` must have
    // an answer from the first request, so a log with no epochs publishes one
    // before it listens.
    if log.current_epoch().await == 0 {
        log.publish_epoch(now_ms()).await?;
    }

    let vrf_public_key = *log.vrf_public_key();
    let log = Arc::new(log);
    let published_at_ms = now_ms();

    Ok(Arc::new(AppState {
        descriptor: descriptor::sign_descriptor(
            &settings,
            log_id,
            vrf_public_key,
            signer.as_ref(),
            published_at_ms,
        )?,
        policy: policy::sign_policy(&authority, log_id, signer.as_ref(), published_at_ms)?,
        log,
        limits: RateLimiter::defaults(),
        clock: Arc::new(now_ms),
    }))
}

/// Choose a signing backend.
///
/// [`FileSigner`] unless the `kms` feature is compiled in **and** a
/// `signing_command` is configured. Both halves are required: a build with the
/// feature but no command still uses a file, so enabling the feature cannot
/// silently change where a log's key lives.
#[allow(unused_variables)]
fn build_signer(config: &Config) -> Result<Arc<dyn LogSigner>> {
    #[cfg(feature = "kms")]
    if let Some((program, args)) = config.signing_command.split_first() {
        let public = config.signing_command_pk.ok_or_else(|| {
            LogError::Config(
                "signing_command is set but signing_command_pk is not: the log cannot publish a \
                 descriptor for a key it does not know"
                    .to_owned(),
            )
        })?;
        return Ok(Arc::new(crate::signer::KmsSigner::new(
            program.into(),
            args.iter().map(Into::into).collect(),
            public,
        )));
    }

    if !config.signing_command.is_empty() {
        return Err(LogError::Config(
            "signing_command is set but this binary was built without the `kms` feature".to_owned(),
        ));
    }
    Ok(Arc::new(FileSigner::load(&config.signing_key_file)?))
}

/// Why a log stopped serving.
///
/// Deliberately **not** `#[non_exhaustive]`, for the reason
/// `f2z_relay::server::Stopped` is not: the binary is a separate crate, so that
/// attribute would force a wildcard arm in `main`, and a wildcard arm is how a
/// future stop reason silently becomes a zero exit. A new variant here should
/// break every caller until each has decided what it means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stopped {
    /// The caller's signal fired. An ordinary shutdown; exit zero.
    Requested,
    /// A supervised task ended before shutdown was asked for — it panicked, or
    /// it was cancelled. The log cannot do its job and the process must not go
    /// on passing health checks; exit non-zero.
    TaskEnded(&'static str),
}

/// A task the log cannot serve without, and the name an operator sees when it
/// is the one that ended.
struct Supervised {
    name: &'static str,
    /// `None` once it has been observed to finish, so it is never polled twice.
    handle: Option<tokio::task::JoinHandle<()>>,
}

/// A running log: the epoch scheduler, the HTTP listener, and the supervision
/// that makes either one's death the process's death.
pub struct Server {
    addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    tasks: Vec<Supervised>,
}

impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Server")
            .field("addr", &self.addr)
            .finish_non_exhaustive()
    }
}

impl Server {
    /// Start the epoch scheduler and bind the listener.
    ///
    /// # Errors
    ///
    /// [`LogError::Config`] if the listen address will not bind.
    pub async fn start(state: Arc<AppState>, listen: &str) -> Result<Self> {
        let listener = tokio::net::TcpListener::bind(listen)
            .await
            .map_err(|error| LogError::Config(format!("{listen}: {error}")))?;
        let addr = listener
            .local_addr()
            .map_err(|error| LogError::Config(format!("{listen}: {error}")))?;

        let (shutdown, watcher) = watch::channel(false);
        let mut tasks = Vec::with_capacity(2);

        let interval = u64::from(state.log.settings().epoch_interval_seconds).max(1);
        let log = Arc::clone(&state.log);
        let scheduler_watcher = watcher.clone();
        tasks.push(Supervised {
            name: EPOCH_TASK,
            handle: Some(tokio::spawn(async move {
                let stop = changed(scheduler_watcher);
                let mut stop = core::pin::pin!(stop);
                let mut ticker = tokio::time::interval(Duration::from_secs(interval));
                // `Delay` rather than `Burst`: a process that was descheduled
                // must not then publish four epochs back to back, which would
                // spend four signatures to say nothing and make the cadence a
                // client observes meaningless.
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                // The first tick completes immediately; genesis has already
                // been published, so skip it.
                ticker.tick().await;
                loop {
                    tokio::select! {
                        _ = ticker.tick() => {
                            if let Err(error) = log.publish_epoch(now_ms()).await {
                                log::error!("epoch not published: {error}; retrying next tick");
                            }
                        }
                        // A requested shutdown ends this task on purpose, which
                        // is why the supervisor asks *whether shutdown was
                        // requested* rather than treating every ending as a
                        // fault. Without it the scheduler would be aborted mid
                        // `publish_epoch`, which is the one operation in this
                        // process that writes.
                        () = &mut stop => return,
                    }
                }
            })),
        });

        log::info!("listening on {addr} (plain HTTP; terminate TLS in front of this process)");
        tasks.push(Supervised {
            name: HTTP_TASK,
            handle: Some(tokio::spawn(async move {
                if let Err(error) = axum::serve(listener, router(state))
                    .with_graceful_shutdown(changed(watcher))
                    .await
                {
                    log::error!("serve: {error}");
                }
            })),
        });

        Ok(Self {
            addr,
            shutdown,
            tasks,
        })
    }

    /// The bound address. With port 0 this is the port the OS chose.
    #[must_use]
    pub const fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Serve until `signal` fires **or a supervised task ends**, then stop.
    ///
    /// This is the whole of zuu#684's fix and it is deliberately the only
    /// supported way to run a log: awaiting the listener alone leaves the
    /// scheduler's join handle unobserved, and an unobserved scheduler that
    /// panics is a log that answers every request correctly and never publishes
    /// another epoch.
    ///
    /// The listener is closed before this returns either way, bounded by
    /// [`SHUTDOWN_GRACE`]. A [`Stopped::TaskEnded`] result is the caller's
    /// instruction to exit **non-zero**: at `replicas: 1` a crash-loop is a
    /// short, visible outage, and the alternative is a `Ready` pod serving a
    /// frozen directory that nothing in the system reports as frozen.
    pub async fn run_until_stopped(mut self, signal: impl Future<Output = ()>) -> Stopped {
        let stopped = {
            let mut signal = core::pin::pin!(signal);
            tokio::select! {
                biased;
                name = self.supervise() => Stopped::TaskEnded(name),
                () = &mut signal => Stopped::Requested,
            }
        };
        if let Stopped::TaskEnded(name) = stopped {
            log::error!("{name} ended; stopping the log");
        }
        if tokio::time::timeout(SHUTDOWN_GRACE, self.stop())
            .await
            .is_err()
        {
            log::error!("shutdown did not finish in time; exiting anyway");
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

    /// Abort a supervised task by name, so that a test can produce the failure
    /// this supervision exists for. Returns whether one was found.
    ///
    /// There is no other way to write that test. The failure it stands in for
    /// is a **panic**, which comes from a bug rather than from an input, and a
    /// fault-injection hook inside the shipped scheduler would be a far worse
    /// thing to carry than a method behind a feature that never reaches the
    /// binary. An aborted task and a panicked one are the same shape here: the
    /// handle completes, and nothing else in the process notices.
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

    /// Tell every task to stop and wait for it.
    async fn stop(self) {
        let _ = self.shutdown.send(true);
        for task in self.tasks {
            if let Some(handle) = task.handle {
                let _ = handle.await;
            }
        }
        log::info!("log stopped");
    }
}

/// Resolve once the shutdown flag is set.
async fn changed(mut watcher: watch::Receiver<bool>) {
    // `*borrow()` first: the flag may already be set by the time a task gets
    // here, and `changed()` only reports transitions after this point.
    while !*watcher.borrow_and_update() {
        if watcher.changed().await.is_err() {
            return;
        }
    }
}

/// Run the epoch scheduler and the HTTP listener until the process is asked to
/// stop, or until one of them ends on its own.
///
/// # Errors
///
/// [`LogError::Config`] if the listen address will not bind.
pub async fn serve(state: Arc<AppState>, listen: &str) -> Result<Stopped> {
    Ok(Server::start(state, listen)
        .await?
        .run_until_stopped(shutdown())
        .await)
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    log::info!("shutting down");
}
