//! `f2z-kt` — the free2z key-transparency log server.
//!
//! Arguments are parsed by hand, in the shape `f2z-assert` established: strict
//! `--flag value` pairs, no clustering, no abbreviation, and an unknown flag is
//! a hard error. The reason is the same one: this is the first code a
//! security-critical binary runs on operator input, and a typo in a flag that
//! names a key file should stop the process rather than fall through to a
//! default.

#![forbid(unsafe_code)]
// A binary's `main` reports and exits; these are the lints for a parser on an
// unauthenticated path, and this is neither.
#![allow(clippy::print_stderr, clippy::print_stdout)]

use std::path::PathBuf;
use std::process::ExitCode;

use f2z_kt::config::Config;
use f2z_kt::logging::{self, Level};
use f2z_kt::{hexbytes, server};

const USAGE: &str = "\
f2z-kt — the free2z key-transparency log server (docs/e2ee/KT.md v1)

USAGE:
    f2z-kt serve --config FILE [--log-level LEVEL]
    f2z-kt keygen [--out FILE]
    f2z-kt public-key --key FILE
    f2z-kt check --config FILE
    f2z-kt healthz --url URL
    f2z-kt --help

COMMANDS:
    serve       Run the log: replay the journals, publish epochs on the
                cadence, and serve KT.md §9.2's endpoints.
    keygen      Generate an Ed25519 key (a log signing key or a VRF key) and
                print 64 hex characters, or write it to FILE with mode 0600.
    public-key  Print the public half of a key file.
    check       Load the configuration and the journals, report what the log
                would run as, and exit without listening.
    healthz     Probe a running log's /healthz over HTTP and exit non-zero if
                it does not answer.

LEVELS: error, warn, info (default), debug
";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("f2z-kt: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        print!("{USAGE}");
        return Ok(());
    };
    let rest = args.get(1..).unwrap_or_default();

    match command {
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        "serve" => serve(rest),
        "keygen" => keygen(rest),
        "public-key" => public_key(rest),
        "check" => check(rest),
        "healthz" => healthz(rest),
        other => Err(format!("unknown command `{other}`; try --help")),
    }
}

/// Parse strict `--flag value` pairs.
fn flags(args: &[String], allowed: &[&str]) -> Result<Vec<(String, String)>, String> {
    let mut pairs = Vec::new();
    let mut index = 0usize;
    while let Some(flag) = args.get(index) {
        if !allowed.contains(&flag.as_str()) {
            return Err(format!("unknown flag `{flag}`"));
        }
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

fn serve(args: &[String]) -> Result<(), String> {
    let pairs = flags(args, &["--config", "--log-level"])?;
    let level = match value(&pairs, "--log-level") {
        Some(name) => Level::parse(name).ok_or_else(|| format!("unknown log level `{name}`"))?,
        None => Level::Info,
    };
    logging::install(level);

    let path = value(&pairs, "--config").ok_or("serve needs --config FILE")?;
    let config = Config::load(&PathBuf::from(path)).map_err(|error| error.to_string())?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    runtime.block_on(async {
        let state = server::build(&config).await.map_err(|e| e.to_string())?;
        server::serve(state, &config.listen)
            .await
            .map_err(|e| e.to_string())
    })
}

fn check(args: &[String]) -> Result<(), String> {
    let pairs = flags(args, &["--config", "--log-level"])?;
    logging::install(Level::Info);
    let path = value(&pairs, "--config").ok_or("check needs --config FILE")?;
    let config = Config::load(&PathBuf::from(path)).map_err(|error| error.to_string())?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())?;
    let state = runtime.block_on(server::build(&config)).map_err(|e| e.to_string())?;
    let epoch = runtime.block_on(state.log.current_epoch());
    let pending = runtime.block_on(state.log.pending_count());

    println!("log_id           {}", hexbytes::encode(state.log.log_id().as_bytes()));
    println!(
        "log_signing_pk   {}",
        hexbytes::encode(state.log.log_public_key().as_bytes())
    );
    println!(
        "vrf_public_key   {}",
        hexbytes::encode(state.log.vrf_public_key().as_bytes())
    );
    println!("epoch            {epoch}");
    println!("pending          {pending}");
    println!(
        "handles          {}",
        state.log.authority().authorities().status()
    );
    Ok(())
}

fn keygen(args: &[String]) -> Result<(), String> {
    let pairs = flags(args, &["--out"])?;
    let seed = random_32()?;
    match value(&pairs, "--out") {
        Some(path) => {
            write_private(std::path::Path::new(path), &hexbytes::encode(&seed))?;
            let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
            eprintln!(
                "public_key {}",
                hexbytes::encode(&signing.verifying_key().to_bytes())
            );
            Ok(())
        }
        None => {
            println!("{}", hexbytes::encode(&seed));
            Ok(())
        }
    }
}

fn public_key(args: &[String]) -> Result<(), String> {
    let pairs = flags(args, &["--key"])?;
    let path = value(&pairs, "--key").ok_or("public-key needs --key FILE")?;
    let signer =
        f2z_kt::FileSigner::load(std::path::Path::new(path)).map_err(|error| error.to_string())?;
    use f2z_kt::LogSigner as _;
    println!("{}", hexbytes::encode(signer.public_key().as_bytes()));
    Ok(())
}

fn healthz(args: &[String]) -> Result<(), String> {
    let pairs = flags(args, &["--url"])?;
    let url = value(&pairs, "--url").unwrap_or("http://127.0.0.1:8443/healthz");
    // Deliberately minimal: connect, ask, and look at the status line. A probe
    // that parsed the log's state would be a probe that restarts a healthy log
    // for a reason the operator did not choose.
    let (host, path) = split_url(url)?;
    use std::io::{Read as _, Write as _};
    let mut stream = std::net::TcpStream::connect(&host)
        .map_err(|error| format!("{host}: {error}"))?;
    stream
        .write_all(format!("GET {path} HTTP/1.0\r\nHost: {host}\r\n\r\n").as_bytes())
        .map_err(|error| error.to_string())?;
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    if response.starts_with("HTTP/1.0 200") || response.starts_with("HTTP/1.1 200") {
        println!("ok");
        Ok(())
    } else {
        Err(format!("unhealthy: {}", response.lines().next().unwrap_or("")))
    }
}

fn split_url(url: &str) -> Result<(String, String), String> {
    let rest = url
        .strip_prefix("http://")
        .ok_or("healthz --url must be an http:// URL; TLS is terminated in front of the log")?;
    match rest.split_once('/') {
        Some((host, path)) => Ok((host.to_owned(), format!("/{path}"))),
        None => Ok((rest.to_owned(), "/healthz".to_owned())),
    }
}

/// 32 bytes from `/dev/urandom`.
///
/// The same choice `f2z-assert` made: no `getrandom`, no `rand`, no dependency
/// in the graph of a key generator. If the device is unavailable this refuses
/// rather than falling back to anything.
fn random_32() -> Result<[u8; 32], String> {
    use std::io::Read as _;
    let mut file = std::fs::File::open("/dev/urandom")
        .map_err(|error| format!("/dev/urandom: {error}"))?;
    let mut seed = [0u8; 32];
    file.read_exact(&mut seed)
        .map_err(|error| format!("/dev/urandom: {error}"))?;
    Ok(seed)
}

fn write_private(path: &std::path::Path, contents: &str) -> Result<(), String> {
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
