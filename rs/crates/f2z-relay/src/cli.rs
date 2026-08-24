//! The command line: flags over environment over file over default.
//!
//! Hand-rolled rather than delegated to an argument parser, for the reason
//! §2.2 gives about transports and this crate applies to its whole dependency
//! graph: every crate in a server binary is attack surface and audit scope, and
//! the whole of what is needed here is fifteen flags with no subcommands, no
//! completions and no colour.
//!
//! The four inspection modes exist because a relay's configuration decides
//! things a client can see and refuse — §2.3's transport, §5.5's window, §9's
//! buckets, §13.1's gate — so "what am I actually running" has to be answerable
//! without starting anything:
//!
//! | Flag | What it does |
//! |---|---|
//! | `--help` | The flags, and where each one lands in the file |
//! | `--version` | The crate version and the protocol version |
//! | `--print-config` | The merged configuration as TOML, **key material redacted** |
//! | `--check-config` | Everything [`Config::check`] decides, then exit |
//! | `--print-capabilities` | §11.2's JSON document, for an operator to publish |

use crate::config::{Config, ConfigError};

/// What the process was asked to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Mode {
    /// Run the relay.
    Run,
    /// Print the flags.
    Help,
    /// Print the versions.
    Version,
    /// Print the merged configuration, redacted.
    PrintConfig,
    /// Check the configuration and exit.
    CheckConfig,
    /// Print the signed capability document as §11.2's JSON.
    PrintCapabilities,
}

/// A parsed command line.
#[derive(Debug)]
pub struct Invocation {
    /// What to do.
    pub mode: Mode,
    /// The merged configuration.
    pub config: Config,
}

/// The `--help` text.
pub const HELP: &str = "\
f2z-relay — the free2z relay daemon (docs/e2ee/WIRE.md v1)

USAGE:
    f2z-relay [OPTIONS]

OPTIONS:
    -c, --config <PATH>        TOML configuration file
        --listen <ADDR>        Protocol listener            [listen.address]
        --insecure-listen      Bind non-loopback without TLS, and publish
                               transport_security: none     [listen.insecure]
        --tls-cert <PATH>      PEM certificate chain        [listen.tls_cert]
        --tls-key <PATH>       PEM private key              [listen.tls_key]
        --admin-listen <ADDR>  Loopback /healthz + /metrics [admin.address]
        --no-admin             Do not serve them at all     [admin.enabled]
        --health-listen <ADDR> /healthz ONLY, any address   [health.address]
        --no-health            Do not serve it at all       [health.enabled]
        --store <BACKEND>      sqlite | memory              [store.backend]
        --store-path <PATH>    SQLite file                  [store.path]
        --identity <PATH>      Ed25519 identity key file    [identity.path]
        --no-generate-identity Fail if the key is missing   [identity.generate]
        --log-level <LEVEL>    off|error|warn|info|debug|trace  [log.level]

    -h, --help                 Print this and exit
    -V, --version              Print versions and exit
        --print-config         Print the merged configuration, secrets redacted
        --check-config         Validate the configuration and exit
        --print-capabilities   Print the signed capability document as JSON

ENVIRONMENT:
    Every file key is settable as F2Z_RELAY_<SECTION>_<KEY>; the file's
    [limits] max_inflight is F2Z_RELAY_LIMITS_MAX_INFLIGHT. Flags win over the
    environment, the environment wins over the file, the file wins over the
    defaults.

    F2Z_RELAY_IDENTITY_SEED is key material: 64 hexadecimal characters, for a
    container with no persistent volume. --print-config redacts it.
";

/// Parse a command line and merge every source.
///
/// # Errors
///
/// [`ConfigError`] for an unknown flag, a flag with no value, an unreadable or
/// invalid file, or an environment variable that does not parse.
pub fn parse<A, E>(arguments: A, environment: E) -> Result<Invocation, ConfigError>
where
    A: IntoIterator<Item = String>,
    E: IntoIterator<Item = (String, String)>,
{
    let arguments: Vec<String> = arguments.into_iter().collect();
    let mut mode = Mode::Run;

    // The file is read first, because the flags that follow have to win over
    // it — and `--config` itself has to be found before anything is read.
    let mut config_path: Option<String> = None;
    let mut index = 0usize;
    while let Some(argument) = arguments.get(index) {
        if argument == "--config" || argument == "-c" {
            config_path = Some(
                arguments
                    .get(index.saturating_add(1))
                    .cloned()
                    .ok_or(ConfigError::MissingValue("--config"))?,
            );
        }
        index = index.saturating_add(1);
    }

    let mut config = match &config_path {
        Some(path) => Config::from_toml_path(std::path::Path::new(path))?,
        None => Config::default(),
    };
    config.apply_env(environment)?;

    let mut index = 0usize;
    while let Some(argument) = arguments.get(index) {
        let take = |flag: &'static str| -> Result<String, ConfigError> {
            arguments
                .get(index.saturating_add(1))
                .cloned()
                .ok_or(ConfigError::MissingValue(flag))
        };
        match argument.as_str() {
            "-h" | "--help" => mode = Mode::Help,
            "-V" | "--version" => mode = Mode::Version,
            "--print-config" => mode = Mode::PrintConfig,
            "--check-config" => mode = Mode::CheckConfig,
            "--print-capabilities" => mode = Mode::PrintCapabilities,
            "-c" | "--config" => {
                take("--config")?;
                index = index.saturating_add(1);
            }
            "--listen" => {
                config.listen.address = take("--listen")?;
                index = index.saturating_add(1);
            }
            "--insecure-listen" => config.listen.insecure = true,
            "--tls-cert" => {
                config.listen.tls_cert = take("--tls-cert")?;
                index = index.saturating_add(1);
            }
            "--tls-key" => {
                config.listen.tls_key = take("--tls-key")?;
                index = index.saturating_add(1);
            }
            "--admin-listen" => {
                config.admin.address = take("--admin-listen")?;
                config.admin.enabled = true;
                index = index.saturating_add(1);
            }
            "--no-admin" => config.admin.enabled = false,
            "--health-listen" => {
                config.health.address = take("--health-listen")?;
                config.health.enabled = true;
                index = index.saturating_add(1);
            }
            "--no-health" => config.health.enabled = false,
            "--store" => {
                config.store.backend = take("--store")?;
                index = index.saturating_add(1);
            }
            "--store-path" => {
                config.store.path = take("--store-path")?;
                index = index.saturating_add(1);
            }
            "--identity" => {
                config.identity.path = take("--identity")?;
                index = index.saturating_add(1);
            }
            "--no-generate-identity" => config.identity.generate = false,
            "--log-level" => {
                config.log.level = take("--log-level")?;
                index = index.saturating_add(1);
            }
            other => return Err(ConfigError::UnknownFlag(other.to_owned())),
        }
        index = index.saturating_add(1);
    }

    Ok(Invocation { mode, config })
}

/// The `--version` text.
#[must_use]
pub fn version() -> String {
    format!(
        "f2z-relay {}\nWIRE.md protocol version {}\n",
        env!("CARGO_PKG_VERSION"),
        f2z_codec::PROTOCOL_VERSION,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|item| (*item).to_owned()).collect()
    }

    #[test]
    fn no_arguments_runs_on_the_defaults() {
        let invocation = parse(args(&[]), []).unwrap();
        assert_eq!(invocation.mode, Mode::Run);
        assert_eq!(invocation.config, Config::default());
    }

    #[test]
    fn a_flag_wins_over_the_environment() {
        let invocation = parse(
            args(&["--listen", "127.0.0.1:1"]),
            [(
                "F2Z_RELAY_LISTEN_ADDRESS".to_owned(),
                "127.0.0.1:2".to_owned(),
            )],
        )
        .unwrap();
        assert_eq!(invocation.config.listen.address, "127.0.0.1:1");
    }

    #[test]
    fn the_environment_wins_over_the_defaults() {
        let invocation = parse(
            args(&[]),
            [("F2Z_RELAY_LIMITS_MAX_INFLIGHT".to_owned(), "7".to_owned())],
        )
        .unwrap();
        assert_eq!(invocation.config.limits.max_inflight, 7);
    }

    #[test]
    fn every_inspection_mode_is_reachable() {
        for (flag, expected) in [
            ("--help", Mode::Help),
            ("-h", Mode::Help),
            ("--version", Mode::Version),
            ("-V", Mode::Version),
            ("--print-config", Mode::PrintConfig),
            ("--check-config", Mode::CheckConfig),
            ("--print-capabilities", Mode::PrintCapabilities),
        ] {
            assert_eq!(parse(args(&[flag]), []).unwrap().mode, expected);
        }
    }

    #[test]
    fn an_unknown_flag_is_named_rather_than_ignored() {
        let error = parse(args(&["--lisen", "x"]), []).unwrap_err();
        assert!(format!("{error}").contains("--lisen"));
    }

    #[test]
    fn a_flag_with_no_value_says_so() {
        let error = parse(args(&["--listen"]), []).unwrap_err();
        assert!(format!("{error}").contains("--listen"));
    }

    #[test]
    fn the_insecure_override_is_a_flag_and_not_a_default() {
        assert!(!parse(args(&[]), []).unwrap().config.listen.insecure);
        assert!(
            parse(args(&["--insecure-listen"]), [])
                .unwrap()
                .config
                .listen
                .insecure
        );
    }

    #[test]
    fn help_names_every_flag_the_parser_accepts() {
        for flag in [
            "--config",
            "--listen",
            "--insecure-listen",
            "--tls-cert",
            "--tls-key",
            "--admin-listen",
            "--no-admin",
            "--health-listen",
            "--no-health",
            "--store",
            "--store-path",
            "--identity",
            "--no-generate-identity",
            "--log-level",
            "--print-config",
            "--check-config",
            "--print-capabilities",
        ] {
            assert!(HELP.contains(flag), "--help does not mention {flag}");
        }
    }

    #[test]
    fn the_health_listener_is_off_until_it_is_asked_for() {
        // A relay that nobody probes opens no extra port. `--health-listen`
        // both sets the address and turns it on, in one token, because the two
        // spellings that could disagree are exactly how a deployment ends up
        // with a configured-but-unserved probe target.
        assert!(!parse(args(&[]), []).unwrap().config.health.enabled);
        let invocation = parse(args(&["--health-listen", "0.0.0.0:8081"]), []).unwrap();
        assert!(invocation.config.health.enabled);
        assert_eq!(invocation.config.health.address, "0.0.0.0:8081");
        assert!(
            !parse(
                args(&["--health-listen", "0.0.0.0:8081", "--no-health"]),
                []
            )
            .unwrap()
            .config
            .health
            .enabled
        );
    }

    #[test]
    fn version_names_both_versions() {
        let text = version();
        assert!(text.contains(env!("CARGO_PKG_VERSION")));
        assert!(text.contains("protocol version 1"));
    }
}
