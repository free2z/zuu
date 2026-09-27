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
f2z-ai — the free2z AI gateway (ai.free2z.cash), skeleton build

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
    No catalogue source and no provider adapters: /readyz reports not ready and
    a valid /v1/chat is answered 503 catalog_unavailable (501 once a catalogue
    source is wired). zuu#1047.
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
        let gateway = Gateway::bind(config, Deps::skeleton())
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
