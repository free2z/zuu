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

use std::sync::Arc;

use crate::api::{AppState, router};
use crate::config::Config;
use crate::error::{LogError, Result};
use crate::log::LogService;
use crate::ratelimit::RateLimiter;
use crate::signer::{FileSigner, LogSigner};
use crate::vrf::FileVrf;
use crate::{descriptor, now_ms, policy};

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
            "signing_command is set but this binary was built without the `kms` feature"
                .to_owned(),
        ));
    }
    Ok(Arc::new(FileSigner::load(&config.signing_key_file)?))
}

/// Run the epoch scheduler and the HTTP listener until the process is asked to
/// stop.
///
/// # Errors
///
/// [`LogError::Config`] if the listen address will not bind.
pub async fn serve(state: Arc<AppState>, listen: &str) -> Result<()> {
    let interval = u64::from(state.log.settings().epoch_interval_seconds).max(1);
    let scheduler = {
        let log = Arc::clone(&state.log);
        tokio::spawn(async move {
            let mut ticker =
                tokio::time::interval(tokio::time::Duration::from_secs(interval));
            // `Delay` rather than `Burst`: a process that was descheduled must
            // not then publish four epochs back to back, which would spend four
            // signatures to say nothing and make the cadence a client observes
            // meaningless.
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // The first tick completes immediately; genesis has already been
            // published, so skip it.
            ticker.tick().await;
            loop {
                ticker.tick().await;
                if let Err(error) = log.publish_epoch(now_ms()).await {
                    log::error!("epoch not published: {error}; retrying next tick");
                }
            }
        })
    };

    let listener = tokio::net::TcpListener::bind(listen)
        .await
        .map_err(|error| LogError::Config(format!("{listen}: {error}")))?;
    log::info!(
        "listening on {} (plain HTTP; terminate TLS in front of this process)",
        listen
    );

    let result = axum::serve(listener, router(state))
        .with_graceful_shutdown(shutdown())
        .await
        .map_err(|error| LogError::Config(format!("serve: {error}")));
    scheduler.abort();
    result
}

async fn shutdown() {
    let _ = tokio::signal::ctrl_c().await;
    log::info!("shutting down");
}
