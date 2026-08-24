//! `f2z-witness` — the free2z key-transparency cosigning daemon.
//!
//! Arguments are parsed by hand, in the shape `f2z-assert` and `f2z-kt`
//! established: strict `--flag value` pairs, no clustering, no abbreviation,
//! and an unknown flag is a hard error.
//!
//! **`healthz` is a hard contract with the deployment.** The distroless image
//! has no shell, no `wget` and no `curl`, and §9.3 promises the witness has no
//! inbound listener to dial, so the probe is `exec` on this binary. See
//! [`f2z_witness::health`].

#![forbid(unsafe_code)]
#![allow(clippy::print_stderr, clippy::print_stdout)]

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use f2z_codec::types::PublicKey;
use f2z_kt_core::types::LogId;
use f2z_witness::health::{self, DEFAULT_STALE_AFTER_MS};
use f2z_witness::witness::{Outcome, Settings, Witness};
use f2z_witness::{HttpTransport, hex, now_ms, state, unhex};

const USAGE: &str = "\
f2z-witness — the free2z key-transparency cosigning daemon (docs/e2ee/KT.md §7)

USAGE:
    f2z-witness run     --log-url URL --log-id HEX --log-pk HEX --key FILE
                        --state FILE [--evidence DIR] [--interval SECONDS]
                        [--max-audit-span N] [--allow-cleartext]
    f2z-witness poll    (same flags as run; performs exactly one poll)
    f2z-witness healthz --state FILE [--evidence DIR] [--stale-after SECONDS]
    f2z-witness keygen  [--out FILE]
    f2z-witness state   --state FILE
    f2z-witness --help

COMMANDS:
    run       Poll, verify, cosign, forever.
    poll      One iteration. Exits non-zero if the witness is halted.
    healthz   Read the state file and report whether this witness is
              following a log. Exits 0 only when it is. Intended for an
              `exec` liveness probe: the image is distroless and there is no
              inbound listener to dial.
    keygen    Generate this witness's Ed25519 signing key.
    state     Print what the witness currently holds.

A HALTED WITNESS MUST NOT BE RESTARTED BLINDLY. KT.md §7.1: once halted it
stays halted until a human looks at the evidence, because an automatic resync
is an automatic way to erase the only record of the thing the witness exists
to find.
";

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(message) => {
            eprintln!("f2z-witness: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<u8, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        print!("{USAGE}");
        return Ok(0);
    };
    let rest = args.get(1..).unwrap_or_default();

    match command {
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(0)
        }
        "run" => daemon(rest, false),
        "poll" => daemon(rest, true),
        "healthz" => healthz(rest),
        "keygen" => keygen(rest),
        "state" => show_state(rest),
        other => Err(format!("unknown command `{other}`; try --help")),
    }
}

const DAEMON_FLAGS: &[&str] = &[
    "--log-url",
    "--log-id",
    "--log-pk",
    "--key",
    "--state",
    "--evidence",
    "--interval",
    "--max-audit-span",
    "--allow-cleartext",
];

fn flags(args: &[String], allowed: &[&str]) -> Result<Vec<(String, String)>, String> {
    let mut pairs = Vec::new();
    let mut index = 0usize;
    while let Some(flag) = args.get(index) {
        if !allowed.contains(&flag.as_str()) {
            return Err(format!("unknown flag `{flag}`"));
        }
        // `--allow-cleartext` is the one boolean; it still takes an explicit
        // value, so that turning off the HTTPS requirement is never a
        // single-token thing that slips into a command line.
        let Some(value) = args.get(index.saturating_add(1)) else {
            return Err(format!("`{flag}` needs a value"));
        };
        pairs.push((flag.clone(), value.clone()));
        index = index.saturating_add(2);
    }
    Ok(pairs)
}

fn value<'a>(pairs: &'a [(String, String)], flag: &str) -> Option<&'a str> {
    pairs
        .iter()
        .find(|(name, _)| name == flag)
        .map(|(_, value)| value.as_str())
}

fn required<'a>(pairs: &'a [(String, String)], flag: &str) -> Result<&'a str, String> {
    value(pairs, flag).ok_or_else(|| format!("{flag} is required"))
}

fn daemon(args: &[String], once: bool) -> Result<u8, String> {
    let pairs = flags(args, DAEMON_FLAGS)?;
    install_logger();

    let url = required(&pairs, "--log-url")?;
    let log_id = LogId::new(
        unhex::<32>(required(&pairs, "--log-id")?).ok_or("--log-id must be 64 hex characters")?,
    );
    let accepted_log_pk = PublicKey::new(
        unhex::<32>(required(&pairs, "--log-pk")?).ok_or("--log-pk must be 64 hex characters")?,
    );
    let state_path = PathBuf::from(required(&pairs, "--state")?);
    let evidence_dir = value(&pairs, "--evidence").map_or_else(
        || {
            state_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("evidence")
        },
        PathBuf::from,
    );
    let interval = value(&pairs, "--interval")
        .unwrap_or("600")
        .parse::<u64>()
        .map_err(|_| "--interval must be a number of seconds")?
        .max(1);
    let max_audit_span = value(&pairs, "--max-audit-span")
        .unwrap_or("64")
        .parse::<u64>()
        .map_err(|_| "--max-audit-span must be a number")?
        .max(1);

    let seed = read_key(Path::new(required(&pairs, "--key")?))?;

    let timeout = std::time::Duration::from_secs(60);
    let transport = match value(&pairs, "--allow-cleartext") {
        Some("yes") => {
            log::warn!(
                "polling {url} without TLS: anyone on the path can choose which history this \
                 witness cosigns. Only sound for a loopback sidecar."
            );
            HttpTransport::insecure_loopback(url, timeout)
        }
        Some(other) => return Err(format!("--allow-cleartext takes `yes`, not `{other}`")),
        None => HttpTransport::new(url, timeout),
    }
    .map_err(|error| error.to_string())?;

    let settings = Settings {
        log_id,
        accepted_log_pk,
        state_path,
        evidence_dir: evidence_dir.clone(),
        max_audit_span,
    };
    let mut witness =
        Witness::new(settings, &seed, Box::new(transport)).map_err(|error| error.to_string())?;
    log::info!("witness {}", hex(witness.public_key().as_bytes()));

    loop {
        match witness.poll_once(now_ms()) {
            Ok(Outcome::Halted { kind }) => {
                // Exit non-zero, and do not loop. A restart loop around a
                // halted witness is a machine repeatedly asking to be allowed
                // past the fault, and the answer is a person.
                eprintln!(
                    "f2z-witness: HALTED on {kind:?}. Evidence is in {}. Read it before doing \
                     anything else; clearing the state file destroys it.",
                    evidence_dir.display()
                );
                return Ok(1);
            }
            Ok(outcome) => log::info!("{outcome:?}"),
            // Transport failures are the network, not the log. Retry.
            Err(error) if error.is_retryable() => log::warn!("{error}"),
            Err(error) => return Err(error.to_string()),
        }
        if once {
            return Ok(0);
        }
        std::thread::sleep(std::time::Duration::from_secs(interval));
    }
}

fn healthz(args: &[String]) -> Result<u8, String> {
    let pairs = flags(args, &["--state", "--evidence", "--stale-after"])?;
    let state_path = PathBuf::from(required(&pairs, "--state")?);
    let evidence_dir = value(&pairs, "--evidence").map_or_else(
        || {
            state_path
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("evidence")
        },
        PathBuf::from,
    );
    let stale_after_ms = match value(&pairs, "--stale-after") {
        Some(seconds) => seconds
            .parse::<u64>()
            .map_err(|_| "--stale-after must be a number of seconds")?
            .saturating_mul(1_000),
        None => DEFAULT_STALE_AFTER_MS,
    };

    let health =
        health::probe(&state_path, now_ms(), stale_after_ms).map_err(|error| error.to_string())?;
    let message = health.message(&evidence_dir);
    if health.is_healthy() {
        println!("{message}");
    } else {
        eprintln!("{message}");
    }
    Ok(health.exit_code())
}

fn show_state(args: &[String]) -> Result<u8, String> {
    let pairs = flags(args, &["--state"])?;
    let path = PathBuf::from(required(&pairs, "--state")?);
    let Some(state) = state::load(&path).map_err(|error| error.to_string())? else {
        println!("no state file at {}", path.display());
        return Ok(1);
    };
    println!("log_id           {}", hex(state.log_id.as_bytes()));
    println!("accepted_log_pk  {}", hex(state.accepted_log_pk.as_bytes()));
    println!("epoch            {}", state.epoch);
    println!("tree_size        {}", state.tree_size);
    println!("root_hash        {}", hex(state.root_hash.as_bytes()));
    println!("sth_hash         {}", hex(state.sth_hash.as_bytes()));
    println!("vrf_public_key   {}", hex(state.vrf_public_key.as_bytes()));
    println!("published_at_ms  {}", state.published_at_ms);
    println!("updated_at_ms    {}", state.updated_at_ms);
    match state.halt_kind() {
        Some(kind) => println!("halted           {kind:?}"),
        None => println!("halted           no"),
    }
    Ok(0)
}

fn keygen(args: &[String]) -> Result<u8, String> {
    let pairs = flags(args, &["--out"])?;
    let seed = random_32()?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    match value(&pairs, "--out") {
        Some(path) => {
            write_private(Path::new(path), &hex(&seed))?;
            eprintln!("witness_pk {}", hex(&signing.verifying_key().to_bytes()));
        }
        None => {
            println!("{}", hex(&seed));
            eprintln!("witness_pk {}", hex(&signing.verifying_key().to_bytes()));
        }
    }
    Ok(0)
}

fn read_key(path: &Path) -> Result<[u8; 32], String> {
    let raw = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    if let Ok(exact) = <[u8; 32]>::try_from(raw.as_slice()) {
        return Ok(exact);
    }
    let text = core::str::from_utf8(&raw).map_err(|_| format!("{}: not a key", path.display()))?;
    unhex::<32>(text).ok_or_else(|| format!("{}: not a 32-byte key", path.display()))
}

/// 32 bytes from `/dev/urandom`. No `rand`, no `getrandom`, no dependency in
/// the graph of a key generator; if the device is unavailable this refuses
/// rather than falling back to anything.
fn random_32() -> Result<[u8; 32], String> {
    use std::io::Read as _;
    let mut file =
        std::fs::File::open("/dev/urandom").map_err(|error| format!("/dev/urandom: {error}"))?;
    let mut seed = [0u8; 32];
    file.read_exact(&mut seed)
        .map_err(|error| format!("/dev/urandom: {error}"))?;
    Ok(seed)
}

fn write_private(path: &Path, contents: &str) -> Result<(), String> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("{}: {error}", path.display()))?;
    writeln!(file, "{contents}").map_err(|error| error.to_string())
}

/// A stderr logger, in the shape `f2z-kt` uses and for the same reason: a
/// dependency here would be a dependency in an AGPL server binary whose graph
/// is being kept deliberately small.
fn install_logger() {
    struct Stderr;
    impl log::Log for Stderr {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            metadata.level() <= log::max_level()
        }
        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) {
                eprintln!("{:<5} {}", record.level(), record.args());
            }
        }
        fn flush(&self) {}
    }
    static LOGGER: Stderr = Stderr;
    log::set_max_level(log::LevelFilter::Info);
    let _ = log::set_logger(&LOGGER);
}
