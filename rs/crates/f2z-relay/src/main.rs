//! `f2z-relay` — the relay daemon's entry point.
//!
//! Everything here is argument handling, the five inspection modes, and a
//! shutdown that is a signal rather than a `SIGKILL`. The relay itself is
//! [`f2z_relay::server::Server`].

#![forbid(unsafe_code)]

use std::process::ExitCode;

use f2z_relay::caps;
use f2z_relay::cli::{self, Mode};
use f2z_relay::config::Config;
use f2z_relay::server::{Server, Stopped};

fn main() -> ExitCode {
    let invocation = match cli::parse(std::env::args().skip(1), std::env::vars()) {
        Ok(invocation) => invocation,
        Err(error) => {
            eprintln!("f2z-relay: {error}");
            return ExitCode::from(2);
        }
    };

    match invocation.mode {
        Mode::Help => {
            print!("{}", cli::HELP);
            ExitCode::SUCCESS
        }
        Mode::Version => {
            print!("{}", cli::version());
            ExitCode::SUCCESS
        }
        Mode::PrintConfig => {
            // Printed **before** `check`, so a configuration that does not
            // start can still be shown — which is when a reader most wants it.
            print!("{}", invocation.config.to_redacted_toml());
            ExitCode::SUCCESS
        }
        Mode::CheckConfig => match invocation.config.check() {
            Ok(()) => {
                println!("configuration is valid");
                ExitCode::SUCCESS
            }
            Err(error) => {
                eprintln!("f2z-relay: {error}");
                ExitCode::from(2)
            }
        },
        Mode::PrintCapabilities => print_capabilities(&invocation.config),
        Mode::Run => run(invocation.config),
    }
}

/// §11.2's representation, for an operator to publish.
///
/// This relay does not serve `/.well-known/free2z-relay/v1/capabilities`
/// itself — [`caps`] explains why, and the short version is that it would put
/// an HTTP request parser on the unauthenticated public port for an affordance
/// aimed at humans. What it does instead is hand the operator the exact bytes,
/// signature and digest included, to publish from whatever already serves their
/// website. §11.2's property survives: same values, same signature, same
/// digest, at a URL anyone can poll and diff.
fn print_capabilities(config: &Config) -> ExitCode {
    if let Err(error) = config.check() {
        eprintln!("f2z-relay: {error}");
        return ExitCode::from(2);
    }
    let identity = if config.identity.seed.is_empty() {
        f2z_relay::identity::load_or_create(
            std::path::Path::new(&config.identity.path),
            config.identity.generate,
        )
    } else {
        f2z_relay::identity::from_hex(&config.identity.seed)
    };
    let identity = match identity {
        Ok(identity) => identity,
        Err(error) => {
            eprintln!("f2z-relay: {error}");
            return ExitCode::from(2);
        }
    };
    // The mode the store *would* report. Opening the store to ask would create
    // the database as a side effect of a print, which is not what a print does.
    let durability = if config.store.backend == "memory" {
        f2z_relay_store::Durability::Memory
    } else {
        f2z_relay_store::Durability::FsyncPerAppend
    };
    let built = caps::build(
        config,
        &identity.public_key(),
        durability,
        f2z_relay::now_ms(),
    )
    .and_then(|capabilities| caps::publish(&identity, capabilities));
    match built {
        Ok(published) => {
            print!("{}", caps::to_json(&published));
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("f2z-relay: {error}");
            ExitCode::from(2)
        }
    }
}

fn run(config: Config) -> ExitCode {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("f2z-relay: cannot start the runtime: {error}");
            return ExitCode::FAILURE;
        }
    };

    runtime.block_on(async {
        let server = match Server::start(config).await {
            Ok(server) => server,
            Err(error) => {
                eprintln!("f2z-relay: {error}");
                return ExitCode::from(2);
            }
        };
        eprintln!("f2z-relay: serving {}", server.url());
        if let Some(admin) = server.admin_addr() {
            eprintln!("f2z-relay: admin on http://{admin}/healthz and /metrics");
        }
        if let Some(health) = server.health_addr() {
            eprintln!("f2z-relay: health on http://{health}/healthz (no /metrics)");
        }

        // Not `wait_for_signal().await; server.shutdown().await;` — that leaves
        // the join handles unobserved, which is zuu#671: a panicking protocol
        // task ends silently and the process goes on answering `/healthz` with
        // `200` while completing nothing for a single client. Every probe and
        // the load balancer's health check stay green over a relay that cannot
        // serve, and under delete-on-ack a relay that accepts and then loses is
        // data loss rather than an outage.
        //
        // §6.4's NOTICE(2) goes out inside `run_until_stopped` on both paths,
        // before the sockets close: a client that learns the relay is going away
        // can reconnect elsewhere rather than treating a closed socket as a
        // fault.
        match server.run_until_stopped(wait_for_signal()).await {
            Stopped::Requested => ExitCode::SUCCESS,
            Stopped::TaskEnded(name) => {
                // Non-zero, and loud. A crash-looping pod is the correct
                // outcome: `replicas: 1` with `strategy: Recreate` makes it a
                // brief, visible outage, and the alternative is a `Ready`
                // endpoint in the load balancer's rotation that serves nobody.
                eprintln!(
                    "f2z-relay: the {name} stopped while the relay was running; this process                      cannot serve and is exiting"
                );
                ExitCode::FAILURE
            }
        }
    })
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                    return;
                }
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
