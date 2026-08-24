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
use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
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

  --account-epoch is the authority's DURABLE PER-ACCOUNT COUNTER (KT.md
  §4.5.4). It is not a timestamp: a clock satisfies strictly-greater-than-the-
  last-one forever, which deletes the rule that stops a reset assertion being
  spent twice on one account-ownership event. It defaults to 0 for --intent
  bind, which is the baseline a handle's first reset must exceed, and is
  REQUIRED for --intent reset. A value at or above 1048576 is refused outright
  as a clock.

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
    fill_os_random(&mut seed)?;
    let hex = to_hex(&seed);
    match options.get("out") {
        Some(path) => {
            write_new_private_key(path, hex.as_bytes())?;
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

/// Create the issuing-key file atomically with its final permissions.
///
/// `create_new` is the no-clobber guard. On Unix, `mode` is applied by the
/// opening syscall itself, so there is no interval in which another process
/// can read a newly-created 0644 private key before a later chmod.
fn open_private_key(path: &str) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| format!("creating new private key {path}: {error}"))
}

fn write_new_private_key(path: &str, bytes: &[u8]) -> Result<(), String> {
    let mut file = open_private_key(path)?;
    file.write_all(bytes)
        .map_err(|error| format!("writing {path}: {error}"))
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
    // `bind` establishes the baseline a handle's first reset must exceed, and 0
    // is the honest baseline for an account nothing has happened to yet. A
    // `reset` is the opposite: its whole job is to be a *different* value from
    // the last one, and a default there would be this tool inventing the number
    // the authority is supposed to hold. KT.md §4.5.4 requires a durable
    // per-account counter; this binary has no storage, so on the one path where
    // the value carries the security property it asks rather than guesses.
    let account_epoch = match (options.get("account-epoch"), intent) {
        (Some(value), _) => parse_u32(value, "--account-epoch")?,
        (None, Intent::Bind) => 0,
        (None, Intent::Reset) => {
            return Err(
                "--account-epoch is required for --intent reset: it must be the \
                        authority's durable per-account counter, read after the account-ownership \
                        event that justifies the reset, and never a clock (KT.md §4.5.4)"
                    .into(),
            );
        }
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
            fill_os_random(&mut bytes)?;
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
fn fill_os_random(buffer: &mut [u8]) -> Result<(), String> {
    let mut source = fs::File::open("/dev/urandom").map_err(|error| {
        format!(
            "no random source (/dev/urandom: {error}). \
             Pass --nonce explicitly, and generate keys on a platform that has one."
        )
    })?;
    fill_random(&mut source, buffer).map_err(|error| format!("reading /dev/urandom: {error}"))
}

fn fill_random(source: &mut impl std::io::Read, buffer: &mut [u8]) -> std::io::Result<()> {
    source.read_exact(buffer)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    fn unused_path(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!(
            "f2z-authority-{name}-{}-{unique}",
            std::process::id()
        ))
    }

    #[cfg(unix)]
    #[test]
    fn private_key_is_mode_0600_at_the_open_boundary() {
        use std::process::Command;

        let key_path = unused_path("mode");
        let probe_path = unused_path("umask-probe");
        let status = Command::new("/bin/sh")
            .args(["-c", "umask 000; exec \"$@\"", "f2z-authority-mode-test"])
            .arg(env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::private_key_mode_subprocess",
                "--nocapture",
            ])
            .env("F2Z_AUTHORITY_MODE_TEST_KEY", &key_path)
            .env("F2Z_AUTHORITY_MODE_TEST_PROBE", &probe_path)
            .status()
            .unwrap();

        let key_created = key_path.is_file();
        let probe_created = probe_path.is_file();
        let _ = fs::remove_file(key_path);
        let _ = fs::remove_file(probe_path);
        assert!(status.success(), "the isolated mode-at-open check failed");
        assert!(
            key_created && probe_created,
            "the isolated mode-at-open helper did not create both fixtures"
        );
    }

    /// Subprocess half of `private_key_is_mode_0600_at_the_open_boundary`.
    ///
    /// The probe proves the parent installed a zero umask before this process
    /// started. That makes a relaxed production mode observable even when the
    /// shell which launched Cargo has a restrictive umask such as 077.
    #[cfg(unix)]
    #[test]
    fn private_key_mode_subprocess() {
        use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

        let Ok(key_path) = env::var("F2Z_AUTHORITY_MODE_TEST_KEY") else {
            return;
        };
        let probe_path = env::var("F2Z_AUTHORITY_MODE_TEST_PROBE").unwrap();
        let probe = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o666)
            .open(&probe_path)
            .unwrap();
        let probe_mode = probe.metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(
            probe_mode, 0o666,
            "the isolated subprocess did not start with umask 000"
        );

        let file = open_private_key(&key_path).unwrap();
        let mode = file.metadata().unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "the file was visible with mode {mode:o} at open"
        );
    }

    #[test]
    fn private_key_creation_never_clobbers_an_existing_file() {
        let path = unused_path("clobber");
        let path_text = path.to_str().unwrap();
        fs::write(&path, b"existing sentinel").unwrap();

        assert!(write_new_private_key(path_text, b"replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"existing sentinel");
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn successful_random_reads_preserve_every_nonzero_source_byte() {
        let expected = [
            0x81, 0x02, 0x93, 0x14, 0xa5, 0x26, 0xb7, 0x38, 0xc9, 0x4a, 0xdb, 0x5c, 0xed, 0x6e,
            0xff, 0x70,
        ];
        let mut source = std::io::Cursor::new(expected);
        let mut actual = [0xa5; 16];
        fill_random(&mut source, &mut actual).unwrap();
        assert_eq!(actual, expected);
    }
}
