//! `f2z-fakerelay` — a relay endpoint in one command, for client development.
//!
//! ```text
//! cargo run -p f2z-relay-testkit --bin f2z-fakerelay
//! # → ws://127.0.0.1:9944/relay/v1
//! ```
//!
//! # Read this before pointing anything real at it
//!
//! **This is not a relay.** It is a conforming test double, and three of its
//! properties make deployment a security incident rather than a mistake:
//!
//! 1. **Its addresses are predictable.** `WIRE.md` §7.1 requires queue
//!    addresses from the relay's own CSPRNG, and §7.1's whole argument is that
//!    a client cannot predict or squat them. This process derives them from a
//!    seed with BLAKE2b in counter mode, so anyone who knows the seed — and the
//!    default seed is a constant in this repository — knows every address it
//!    will ever hand out.
//! 2. **It serves `ws://`.** §2.1 admits `wss://` only. Everything except MLS
//!    ciphertext — connection metadata, queue addresses, commands — travels in
//!    the clear. That is published honestly as `transport_security: none` and
//!    `channel_binding_mode: none`, and a conforming client refuses it without
//!    an explicit per-relay opt-in (§2.3 obligation 3).
//! 3. **It stores nothing durably.** `durability_mode: memory`. Every queue and
//!    every message dies with the process.
//!
//! §2.3's binding rule is enforced rather than printed: a non-loopback address
//! is refused unless `--insecure-listen` is typed, and typing it prints the
//! three obligations §2.3 attaches to the override.

use std::net::SocketAddr;
use std::process::ExitCode;

use f2z_relay_testkit::config::RelayConfig;
use f2z_relay_testkit::fake::FakeRelay;
use f2z_relay_testkit::faults::PolicyFaults;

const DEFAULT_LISTEN: &str = "127.0.0.1:9944";

const USAGE: &str = "\
f2z-fakerelay — a spec-conforming FakeRelay over ws://, for client development.

USAGE:
    f2z-fakerelay [OPTIONS]

OPTIONS:
    --listen ADDR             Address to bind (default 127.0.0.1:9944).
    --insecure-listen         Allow a non-loopback bind. WIRE.md §2.3 requires
                              this to be an explicit act; it is refused
                              otherwise, and the obligations are printed.
    --pow                     Demand a proof-of-work stamp for queue creation
                              (WIRE.md §13.1's default mode). The difficulty is
                              deliberately trivial; see the crate docs.
    --frozen-clock            Freeze the relay clock instead of following the
                              host. Useful when driving TTLs from a script;
                              a real client's timestamps will fall outside the
                              window unless it reads GET_CHALLENGE(clock).
    --seed HEX                32-byte hex seed for the address generator.
    --identity-seed HEX       32-byte hex seed for the relay identity key.
    --ping-interval-ms MS     WebSocket Ping interval (WIRE.md §2.4, default
                              25000 in this binary).
    --unsound-antireplay      Publish antireplay_window_ms below 2 x
                              clock_skew_ms and enforce it — the capability
                              document of https://github.com/free2z/zuu/issues/586,
                              which the specification currently permits and a
                              conforming client must refuse.
    --backpressure            Start in WIRE.md §13.1 layer 4 global backpressure.
    -h, --help                Print this and exit.
";

fn main() -> ExitCode {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse(&arguments) {
        Ok(Some(options)) => options,
        Ok(None) => {
            print!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(reason) => {
            eprintln!("f2z-fakerelay: {reason}\n");
            eprint!("{USAGE}");
            return ExitCode::FAILURE;
        }
    };

    match run(options) {
        Ok(()) => ExitCode::SUCCESS,
        Err(reason) => {
            eprintln!("f2z-fakerelay: {reason}");
            ExitCode::FAILURE
        }
    }
}

struct Options {
    listen: SocketAddr,
    insecure_listen: bool,
    pow: bool,
    frozen_clock: bool,
    seed: Option<[u8; 32]>,
    identity_seed: Option<[u8; 32]>,
    ping_interval_ms: u64,
    unsound_antireplay: bool,
    backpressure: bool,
}

fn parse(arguments: &[String]) -> Result<Option<Options>, String> {
    let mut options = Options {
        listen: DEFAULT_LISTEN
            .parse()
            .map_err(|_| "the built-in default address is unparseable".to_owned())?,
        insecure_listen: false,
        pow: false,
        frozen_clock: false,
        seed: None,
        identity_seed: None,
        // §2.4's published default. The library default is far shorter so tests
        // do not wait 25 seconds to see a Ping; a binary a human runs should
        // behave like the specification.
        ping_interval_ms: 25_000,
        unsound_antireplay: false,
        backpressure: false,
    };

    let mut index = 0usize;
    while let Some(argument) = arguments.get(index) {
        index = index.saturating_add(1);
        match argument.as_str() {
            "-h" | "--help" => return Ok(None),
            "--insecure-listen" => options.insecure_listen = true,
            "--pow" => options.pow = true,
            "--frozen-clock" => options.frozen_clock = true,
            "--unsound-antireplay" => options.unsound_antireplay = true,
            "--backpressure" => options.backpressure = true,
            "--listen" => {
                let value = value_of(arguments, &mut index, "--listen")?;
                options.listen = value
                    .parse()
                    .map_err(|_| format!("--listen: {value} is not an address:port"))?;
            }
            "--seed" => {
                let value = value_of(arguments, &mut index, "--seed")?;
                options.seed = Some(parse_seed(&value)?);
            }
            "--identity-seed" => {
                let value = value_of(arguments, &mut index, "--identity-seed")?;
                options.identity_seed = Some(parse_seed(&value)?);
            }
            "--ping-interval-ms" => {
                let value = value_of(arguments, &mut index, "--ping-interval-ms")?;
                options.ping_interval_ms = value
                    .parse()
                    .map_err(|_| format!("--ping-interval-ms: {value} is not a number"))?;
            }
            other => return Err(format!("unknown option {other}")),
        }
    }
    Ok(Some(options))
}

fn value_of(arguments: &[String], index: &mut usize, name: &str) -> Result<String, String> {
    let value = arguments
        .get(*index)
        .ok_or_else(|| format!("{name} needs a value"))?;
    *index = index.saturating_add(1);
    Ok(value.clone())
}

fn parse_seed(text: &str) -> Result<[u8; 32], String> {
    if text.len() != 64 {
        return Err(format!("a seed is 64 hex characters, got {}", text.len()));
    }
    let mut seed = [0u8; 32];
    let bytes = text.as_bytes();
    for (slot, index) in seed.iter_mut().zip((0usize..64).step_by(2)) {
        let pair = bytes
            .get(index..index.saturating_add(2))
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .ok_or_else(|| "a seed must be hex".to_owned())?;
        *slot = u8::from_str_radix(pair, 16).map_err(|_| "a seed must be hex".to_owned())?;
    }
    Ok(seed)
}

fn run(options: Options) -> Result<(), String> {
    let mut config = RelayConfig::default();
    if !options.frozen_clock {
        config = config.with_system_clock();
    }
    if options.pow {
        config = config.with_pow();
    }
    if let Some(seed) = options.seed {
        config.rng_seed = seed;
    }
    if let Some(seed) = options.identity_seed {
        config.identity_seed = seed;
    }
    config.ping_interval = std::time::Duration::from_millis(options.ping_interval_ms);
    config.policy_faults = PolicyFaults {
        unsound_antireplay_window: options.unsound_antireplay,
        global_backpressure: options.backpressure,
        ..PolicyFaults::default()
    };

    let relay = FakeRelay::new(config).map_err(|error| error.to_string())?;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("could not start the async runtime: {error}"))?;

    runtime.block_on(async move {
        let server = relay
            .listen(options.listen, options.insecure_listen)
            .await
            .map_err(|error| error.to_string())?;

        announce(&relay, &server, &options);

        // Serve until the process is signalled. There is no graceful-shutdown
        // path on purpose: nothing here is durable, so there is nothing a
        // graceful shutdown could preserve.
        std::future::pending::<()>().await;
        drop(server);
        Ok(())
    })
}

fn announce(
    relay: &FakeRelay,
    server: &f2z_relay_testkit::websocket::RelayServer,
    options: &Options,
) {
    let published = relay.published_capabilities();
    println!("f2z-fakerelay — a TEST DOUBLE. Do not deploy this.");
    println!("  endpoint            {}", server.url());
    println!(
        "  relay_id            {}",
        base64url(relay.relay_id().as_ref())
    );
    println!(
        "  relay_identity_pk   {}",
        base64url(relay.identity_key().as_ref())
    );
    println!("  protocol            WIRE.md v1, subprotocol free2z-relay.v1");
    println!("  transport_security  none      (ws://, WIRE.md §2.3)");
    println!("  channel_binding     none      (no TLS session to export from, §5.3)");
    println!("  durability_mode     memory    (§8.4: an accepted APPEND may not survive)");
    println!(
        "  queue_creation      {}",
        if options.pow { "pow" } else { "open" }
    );
    println!(
        "  clock_skew_ms       {}   antireplay_window_ms {}",
        published.clock_skew_ms, published.antireplay_window_ms
    );
    println!(
        "  padding_sizes       {:?}",
        published.padding_sizes.as_slice()
    );
    println!();
    println!("A conforming client REFUSES this relay unless it opts in per-relay:");
    println!("  ClientPolicy {{ allow_insecure_transport: true, .. }}   (§2.3 obligation 3)");
    if options.unsound_antireplay {
        println!();
        println!("  !! --unsound-antireplay is on: antireplay_window_ms < 2 x clock_skew_ms.");
        println!("     https://github.com/free2z/zuu/issues/586 — the document is VALID under");
        println!("     WIRE.md as written, and a conforming client must refuse it anyway.");
    }
    if !server.local_addr().ip().is_loopback() {
        println!();
        println!("  !! Bound to a non-loopback address without TLS (§2.3 override). Obligations:");
        println!("     1. transport_security: none is published. It is.");
        println!("     2. channel_binding_mode: none is published. It is.");
        println!("     3. Clients must refuse by default and require an explicit opt-in.");
        println!("     Queue addresses from this process are PREDICTABLE. Do not use it.");
    }
}

/// base64url without padding — `WIRE.md` §3.4's form for byte strings in
/// human-readable output.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().saturating_mul(4).saturating_div(3));
    for chunk in bytes.chunks(3) {
        let first = chunk.first().copied().unwrap_or(0);
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        let triple = (u32::from(first) << 16) | (u32::from(second) << 8) | u32::from(third);
        let indices = [
            (triple >> 18) & 0x3f,
            (triple >> 12) & 0x3f,
            (triple >> 6) & 0x3f,
            triple & 0x3f,
        ];
        let take = match chunk.len() {
            1 => 2,
            2 => 3,
            _ => 4,
        };
        for index in indices.iter().take(take) {
            let position = usize::try_from(*index).unwrap_or(0);
            if let Some(symbol) = ALPHABET.get(position) {
                out.push(char::from(*symbol));
            }
        }
    }
    out
}
