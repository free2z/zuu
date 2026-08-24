//! `f2z-assert` — issue a handle assertion by hand.
//!
//! A log operator with a web application in front of it will issue assertions
//! from that application. A self-hoster running the log and nothing else has no
//! such place to put the code, and would otherwise have to write a program
//! before they could bind their first handle. This is that program.
//!
//! It is deliberately tiny and dependency-free: it reads a key file, builds a
//! [`HandleAssertionTBS`], signs it, and writes the `tls_codec` bytes out. Every
//! rule that decides whether the result is *acceptable* lives in the library,
//! where the log and the client both run it; nothing here is a second opinion
//! about validity.
//!
//! ```text
//! f2z-assert keygen   [--out FILE]
//! f2z-assert authority --key FILE
//! f2z-assert issue --key FILE --log-id HEX --handle NAME --identity-pk HEX
//!                  [--intent bind|reset] [--account-epoch N]
//!                  [--issued-ms N] [--expires-ms N] [--validity-ms N]
//!                  [--nonce HEX] [--out FILE]
//! ```
//!
//! Randomness comes from `/dev/urandom`, read with the standard library and
//! nothing else. On a platform without it, `keygen` refuses and `issue`
//! requires an explicit `--nonce`: refusing is the only honest option, because
//! silently substituting a weaker source in a tool that mints identity claims is
//! the failure nobody would notice.

use std::env;
use std::fs;
use std::io::Read as _;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use f2z_authority::{
    AssertionNonce, DEFAULT_MAX_VALIDITY_MS, Handle, HandleAssertionTBS, Intent, LogId, SigningKey,
    authority_id,
};
use f2z_codec::canonical::Canonical as _;
use f2z_codec::types::PublicKey;

const USAGE: &str = "\
f2z-assert — issue a free2z handle-ownership assertion (docs/e2ee/KT.md)

USAGE:
  f2z-assert keygen [--out FILE]
      Generate an Ed25519 issuing key. Writes 64 hex characters.

  f2z-assert authority --key FILE
      Print the authority_id and public key for a key file, in the form an
      AuthoritySet entry takes.

  f2z-assert issue --key FILE --log-id HEX --handle NAME --identity-pk HEX
                   [--intent bind|reset] [--account-epoch N]
                   [--issued-ms N] [--expires-ms N] [--validity-ms N]
                   [--nonce HEX] [--out FILE]
      Sign an assertion. Writes hex to stdout, or raw bytes with --out.

NOTES:
  A key file holds 64 hex characters or 32 raw bytes. Surrounding whitespace is
  ignored. It is a private key: mode 0600, and never in a repository.

  --intent defaults to bind. Use reset only for ADR 0014's platform-reset path,
  where an account has changed hands; the log refuses a reset on a handle's
  first entry and refuses a bind on any later one.

  --validity-ms defaults to 900000 (15 minutes) and is ignored when --expires-ms
  is given. The LOG caps this independently: an assertion whose window exceeds
  the log's own cap is refused however it was signed.
";

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("f2z-assert: {message}");
            ExitCode::FAILURE
        }
    }
}

fn run(args: &[String]) -> Result<(), String> {
    let Some(command) = args.first() else {
        print!("{USAGE}");
        return Err("no subcommand given".into());
    };
    let rest = args.get(1..).unwrap_or_default();
    match command.as_str() {
        "keygen" => keygen(rest),
        "authority" => authority(rest),
        "issue" => issue(rest),
        "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        other => Err(format!("unknown subcommand `{other}`; try --help")),
    }
}

// ---------------------------------------------------------------- subcommands

fn keygen(args: &[String]) -> Result<(), String> {
    let options = Options::parse(args)?;
    options.reject_unknown(&["out"])?;
    let mut seed = [0u8; 32];
    fill_random(&mut seed)?;
    let hex = to_hex(&seed);
    match options.get("out") {
        Some(path) => {
            fs::write(path, hex.as_bytes()).map_err(|error| format!("writing {path}: {error}"))?;
            eprintln!("wrote a new issuing key to {path}");
            eprintln!(
                "authority_id {}",
                to_hex(authority_id(&SigningKey::from_seed(&seed).public_key()).as_bytes(),)
            );
        }
        None => println!("{hex}"),
    }
    Ok(())
}

fn authority(args: &[String]) -> Result<(), String> {
    let options = Options::parse(args)?;
    options.reject_unknown(&["key"])?;
    let key = read_key(options.require("key")?)?;
    let public = key.public_key();
    println!("authority_id  {}", to_hex(authority_id(&public).as_bytes()));
    println!("public_key    {}", to_hex(public.as_bytes()));
    Ok(())
}

fn issue(args: &[String]) -> Result<(), String> {
    let options = Options::parse(args)?;
    options.reject_unknown(&[
        "key",
        "log-id",
        "handle",
        "identity-pk",
        "intent",
        "account-epoch",
        "issued-ms",
        "expires-ms",
        "validity-ms",
        "nonce",
        "out",
    ])?;

    let key = read_key(options.require("key")?)?;
    let log_id = LogId::new(fixed_hex::<32>(options.require("log-id")?, "--log-id")?);
    let handle = Handle::parse(options.require("handle")?.as_bytes())
        .map_err(|error| format!("--handle: {error}"))?;
    let identity_pk = PublicKey::new(fixed_hex::<32>(
        options.require("identity-pk")?,
        "--identity-pk",
    )?);

    let intent = match options.get("intent").map(String::as_str) {
        None | Some("bind") => Intent::Bind,
        Some("reset") => Intent::Reset,
        Some(other) => return Err(format!("--intent must be bind or reset, not `{other}`")),
    };
    let account_epoch = match options.get("account-epoch") {
        Some(value) => parse_u32(value, "--account-epoch")?,
        None => 0,
    };

    let issued_ms = match options.get("issued-ms") {
        Some(value) => parse_u64(value, "--issued-ms")?,
        None => now_ms()?,
    };
    let expires_ms = match options.get("expires-ms") {
        Some(value) => parse_u64(value, "--expires-ms")?,
        None => {
            let validity = match options.get("validity-ms") {
                Some(value) => parse_u64(value, "--validity-ms")?,
                None => DEFAULT_MAX_VALIDITY_MS,
            };
            issued_ms
                .checked_add(validity)
                .ok_or("issued_ms + validity overflows")?
        }
    };
    if expires_ms <= issued_ms {
        return Err("expires_ms must be after issued_ms".into());
    }

    let nonce = match options.get("nonce") {
        Some(value) => AssertionNonce::new(fixed_hex::<16>(value, "--nonce")?),
        None => {
            let mut bytes = [0u8; 16];
            fill_random(&mut bytes)?;
            AssertionNonce::new(bytes)
        }
    };

    let assertion = HandleAssertionTBS::new(
        &key.public_key(),
        log_id,
        handle,
        identity_pk,
        intent,
        account_epoch,
        issued_ms,
        expires_ms,
        nonce,
    )
    .map_err(|error| format!("building the assertion: {error}"))?
    .sign(&key)
    .map_err(|error| format!("signing: {error}"))?;

    let bytes = assertion
        .encode_canonical()
        .map_err(|error| format!("encoding: {error}"))?;

    eprintln!(
        "issued {} for a {} intent, valid {} ms, authority_id {}",
        options.require("handle")?,
        intent,
        expires_ms.saturating_sub(issued_ms),
        to_hex(authority_id(&key.public_key()).as_bytes()),
    );
    eprintln!(
        "the submitter must ALSO sign the binding with the identity private key; \
         an assertion alone is not a submission (KT.md)"
    );

    match options.get("out") {
        Some(path) => {
            fs::write(path, &bytes).map_err(|error| format!("writing {path}: {error}"))?;
            eprintln!("wrote {} bytes to {path}", bytes.len());
        }
        None => println!("{}", to_hex(&bytes)),
    }
    Ok(())
}

// -------------------------------------------------------------------- helpers

/// `--name value` pairs, in order, with no abbreviation and no clustering.
struct Options(Vec<(String, String)>);

impl Options {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut pairs = Vec::new();
        let mut index = 0usize;
        while let Some(flag) = args.get(index) {
            let name = flag
                .strip_prefix("--")
                .ok_or_else(|| format!("expected a --flag, found `{flag}`"))?;
            let value = args
                .get(index.saturating_add(1))
                .ok_or_else(|| format!("--{name} needs a value"))?;
            pairs.push((name.to_owned(), value.clone()));
            index = index.saturating_add(2);
        }
        Ok(Self(pairs))
    }

    fn get(&self, name: &str) -> Option<&String> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value)
    }

    fn require(&self, name: &str) -> Result<&String, String> {
        self.get(name)
            .ok_or_else(|| format!("--{name} is required"))
    }

    /// A misspelled flag must be an error, not a silent default. This tool
    /// mints identity claims; `--handel alice` quietly issuing for something
    /// else is exactly the class of mistake it must not have.
    fn reject_unknown(&self, allowed: &[&str]) -> Result<(), String> {
        for (name, _) in &self.0 {
            if !allowed.contains(&name.as_str()) {
                return Err(format!("unknown flag --{name}; try --help"));
            }
        }
        Ok(())
    }
}

fn read_key(path: &str) -> Result<SigningKey, String> {
    let raw = fs::read(path).map_err(|error| format!("reading {path}: {error}"))?;
    let trimmed: Vec<u8> = {
        let start = raw
            .iter()
            .position(|byte| !byte.is_ascii_whitespace())
            .unwrap_or(raw.len());
        let end = raw
            .iter()
            .rposition(|byte| !byte.is_ascii_whitespace())
            .map_or(start, |index| index.saturating_add(1));
        raw.get(start..end).unwrap_or_default().to_vec()
    };

    if trimmed.len() == 64 {
        let text = core::str::from_utf8(&trimmed)
            .map_err(|_| format!("{path} is 64 bytes but is not hex"))?;
        return Ok(SigningKey::from_seed(&fixed_hex::<32>(text, path)?));
    }
    let seed: [u8; 32] = trimmed.as_slice().try_into().map_err(|_| {
        format!(
            "{path} must hold 64 hex characters or 32 raw bytes, found {} bytes",
            trimmed.len()
        )
    })?;
    Ok(SigningKey::from_seed(&seed))
}

fn fixed_hex<const N: usize>(text: &str, what: &str) -> Result<[u8; N], String> {
    let bytes = parse_hex(text).map_err(|error| format!("{what}: {error}"))?;
    bytes.as_slice().try_into().map_err(|_| {
        format!(
            "{what}: expected {N} bytes ({} hex characters), found {}",
            N.saturating_mul(2),
            bytes.len()
        )
    })
}

fn parse_hex(text: &str) -> Result<Vec<u8>, String> {
    let digits: Vec<u8> = text
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect();
    if !digits.len().is_multiple_of(2) {
        return Err("an odd number of hex characters".into());
    }
    let mut out = Vec::with_capacity(digits.len() / 2);
    for pair in digits.chunks(2) {
        let (Some(high), Some(low)) = (pair.first(), pair.get(1)) else {
            return Err("an odd number of hex characters".into());
        };
        let high = nibble(*high)?;
        let low = nibble(*low)?;
        out.push(high.saturating_mul(16).saturating_add(low));
    }
    Ok(out)
}

fn nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte.saturating_sub(b'0')),
        b'a'..=b'f' => Ok(byte.saturating_sub(b'a').saturating_add(10)),
        b'A'..=b'F' => Ok(byte.saturating_sub(b'A').saturating_add(10)),
        other => Err(format!("`{}` is not a hex digit", char::from(other))),
    }
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        out.push(char::from(hex_digit(byte >> 4)));
        out.push(char::from(hex_digit(byte & 0x0f)));
    }
    out
}

fn hex_digit(value: u8) -> u8 {
    if value < 10 {
        b'0'.saturating_add(value)
    } else {
        b'a'.saturating_add(value.saturating_sub(10))
    }
}

fn parse_u32(text: &str, what: &str) -> Result<u32, String> {
    text.parse().map_err(|_| format!("{what} must be a number"))
}

fn parse_u64(text: &str, what: &str) -> Result<u64, String> {
    text.parse().map_err(|_| format!("{what} must be a number"))
}

fn now_ms() -> Result<u64, String> {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "the system clock is before 1970".to_owned())?;
    u64::try_from(since.as_millis()).map_err(|_| "the system clock is implausible".to_owned())
}

/// Fill `buffer` from `/dev/urandom`.
///
/// No `getrandom`, no `rand`: one `open` and one `read_exact` is the whole
/// requirement, and a dependency in an issuing tool is a dependency in the
/// trust root. See the module note on why an unavailable source is a refusal
/// rather than a fallback.
fn fill_random(buffer: &mut [u8]) -> Result<(), String> {
    let mut source = fs::File::open("/dev/urandom").map_err(|error| {
        format!(
            "no random source (/dev/urandom: {error}). \
             Pass --nonce explicitly, and generate keys on a platform that has one."
        )
    })?;
    source
        .read_exact(buffer)
        .map_err(|error| format!("reading /dev/urandom: {error}"))
}
