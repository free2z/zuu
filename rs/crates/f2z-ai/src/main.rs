//! `f2z-ai` — the free2z AI gateway.
//!
//! Arguments are parsed by hand, in the shape `f2z-kt` established: strict
//! `--flag value` pairs and an unknown flag is a hard error.

#![forbid(unsafe_code)]
// A binary's `main` reports and exits.
#![allow(clippy::print_stderr, clippy::print_stdout)]

use std::path::PathBuf;
use std::process::ExitCode;

use f2z_ai::config::{Config, ENV_CONFIG_FILE};
use f2z_ai::{Deps, Gateway, Stopped, shutdown, telemetry};

const USAGE: &str = "\
f2z-ai — the free2z AI gateway (ai.free2z.cash), metered preview

USAGE:
    f2z-ai serve [--config FILE]
    f2z-ai check [--config FILE]
    f2z-ai --help

COMMANDS:
    serve   Serve /v1/chat on `listen` and /healthz, /readyz, /metrics on
            `admin_listen`. SIGTERM drains: readiness flips, new calls are
            refused, open streams get up to `drain_timeout_secs` (300).
    check   Load and validate the configuration, print it with secrets
            redacted, and exit.

CONFIGURATION:
    A TOML file (--config, or F2Z_AI_CONFIG), then F2Z_AI_<KEY> environment
    overrides. See rs/crates/f2z-ai/README.md. An unknown key or F2Z_AI_*
    variable is an error.

THIS BUILD:
    Metered text and function-tool chat, streamed or JSON. Configure catalogue trust, ledger,
    authentication and provider credentials before serving paid calls. Without
    backend configuration the diagnostic service stays closed and unready.
    Fallback, images and estimated-usage billing are not
    implemented in this preview. See the crate README and zuu#1078.
";

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(message) => {
            eprintln!("f2z-ai: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<ExitCode, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        print!("{USAGE}");
        return Ok(ExitCode::SUCCESS);
    };
    let rest = args.get(1..).unwrap_or_default();
    match command {
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(ExitCode::SUCCESS)
        }
        "serve" => serve(&load(rest)?),
        "check" => {
            let config = load(rest)?;
            println!("{config:#?}");
            Ok(ExitCode::SUCCESS)
        }
        other => Err(format!("unknown command `{other}`; try --help")),
    }
}

fn load(args: &[String]) -> Result<Config, String> {
    let mut file: Option<PathBuf> = std::env::var_os(ENV_CONFIG_FILE).map(PathBuf::from);
    let mut index = 0usize;
    while let Some(flag) = args.get(index) {
        match flag.as_str() {
            "--config" => {
                let value = args
                    .get(index.saturating_add(1))
                    .ok_or("`--config` needs a value")?;
                file = Some(PathBuf::from(value));
                index = index.saturating_add(2);
            }
            other => return Err(format!("unknown flag `{other}`")),
        }
    }
    Config::load(file.as_deref(), std::env::vars()).map_err(|e| e.to_string())
}

fn serve(config: &Config) -> Result<ExitCode, String> {
    // Before the runtime: the OTLP exporter's blocking HTTP client must not be
    // built (or dropped) inside one.
    let telemetry = telemetry::init(config)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    let stopped = runtime.block_on(async {
        let first = shutdown::terminate_signal().map_err(|e| format!("SIGTERM handler: {e}"))?;
        // A second SIGTERM or Ctrl-C during the drain exits at once: the
        // drain can last minutes, and someone pressing Ctrl-C twice at a
        // terminal means it. Nothing is settled for calls still open then;
        // the ledger's hold expiry releases them (metering.md §5.6).
        let signal = async move {
            first.await;
            tokio::spawn(async {
                if let Ok(second) = shutdown::terminate_signal() {
                    second.await;
                    eprintln!(
                        "f2z-ai: second shutdown signal; exiting without finishing the drain"
                    );
                    std::process::exit(130);
                }
            });
        };
        let deps = if config.catalog_url.is_none()
            && config.catalog_keys_file.is_none()
            && config.ledger_url.is_none()
        {
            Deps {
                gate: f2z_ai::auth::from_config(&config.auth)?,
                ..Deps::skeleton()
            }
        } else {
            if config.auth.redis_url.is_none() {
                return Err("configure shared Redis admission for metered service".to_owned());
            }
            if config.providers.is_empty() {
                return Err("configure at least one provider for metered service".to_owned());
            }
            let url = config
                .catalog_url
                .as_deref()
                .ok_or("catalog_url is required")?;
            let keys_path = config
                .catalog_keys_file
                .as_ref()
                .ok_or("catalog_keys_file is required")?;
            let keys: std::collections::BTreeMap<String, String> = serde_json::from_slice(
                &std::fs::read(keys_path).map_err(|_| "catalogue keys file unreadable")?,
            )
            .map_err(|_| "invalid catalogue keys file")?;
            let source = f2z_ai::catalog::HttpSource::new(url, &keys)?;
            let ledger = std::sync::Arc::new(
                f2z_ai::ledger::Postgres::connect(
                    config.ledger_url.as_ref().ok_or("ledger_url is required")?,
                    config.ledger_max_connections,
                )
                .await
                .map_err(|e| e.to_string())?,
            );
            let provider = f2z_ai::provider::ProviderBackend::from_config(config)?;
            let backend = std::sync::Arc::new(
                f2z_ai::meter::Metered::new(ledger, provider)
                    .with_allowed_models(config.allowed_models.clone()),
            );
            Deps {
                gate: f2z_ai::auth::from_config(&config.auth)?,
                catalog: std::sync::Arc::new(source),
                backend: backend.clone(),
                settler: backend,
            }
        };
        let gateway = Gateway::bind(config, deps)
            .await
            .map_err(|e| format!("bind: {e}"))?;
        Ok::<_, String>(gateway.run_until(signal).await)
    });
    drop(runtime);
    telemetry.shutdown();
    // Exhaustive on purpose, as in f2z-kt: a new stop reason is a compile
    // error here, not a wildcard that exits zero.
    match stopped? {
        Stopped::Drained(_) => Ok(ExitCode::SUCCESS),
        Stopped::TaskEnded(name) => Err(format!(
            "the {name} ended while serving; exiting non-zero so the process is restarted"
        )),
    }
}
