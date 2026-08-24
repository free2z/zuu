//! Behavioral coverage for the shipped `f2z-assert` command.
//!
//! The binary's small helpers have unit tests, but these tests deliberately
//! cross the process boundary. That holds command dispatch, option routing and
//! output selection to the same contracts as the helpers they reach.

#![allow(
    clippy::arithmetic_side_effects,
    clippy::indexing_slicing,
    clippy::panic,
    clippy::unwrap_used
)]

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};

use f2z_authority::{HandleAssertion, Intent, SigningKey, authority_id};
use f2z_codec::canonical::{Canonical as _, decode_canonical};

const FIXED_KEY_SEED: [u8; 32] = [
    0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
];
const LOG_ID_BYTES: [u8; 32] = [
    0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f,
    0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x3f,
];
const IDENTITY_PK_BYTES: [u8; 32] = [
    0x40, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x4c, 0x4d, 0x4e, 0x4f,
    0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x5b, 0x5c, 0x5d, 0x5e, 0x5f,
];
const EXPLICIT_NONCE_BYTES: [u8; 16] = [
    0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x6b, 0x6c, 0x6d, 0x6e, 0x6f,
];
const RAW_AUTHORITY_SEED: [u8; 32] = [
    0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f,
    0x90, 0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,
];
const RAW_ISSUE_SEED: [u8; 32] = [
    0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
    0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
];

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(name: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "f2z-authority-cli-{name}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn path_text(path: &Path) -> &str {
    path.to_str().unwrap()
}

fn command(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_f2z-assert"))
        .args(args)
        .output()
        .unwrap()
}

fn command_strings(args: &[String]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_f2z-assert"))
        .args(args)
        .output()
        .unwrap()
}

#[cfg(unix)]
fn keygen_with_zero_umask(path: &Path) -> Output {
    Command::new("/bin/sh")
        .args(["-c", "umask 000; exec \"$@\"", "f2z-authority-cli-test"])
        .arg(env!("CARGO_BIN_EXE_f2z-assert"))
        .args(["keygen", "--out", path_text(path)])
        .output()
        .unwrap()
}

#[cfg(not(unix))]
fn keygen_with_zero_umask(path: &Path) -> Output {
    command(&["keygen", "--out", path_text(path)])
}

fn independent_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

fn independent_unhex(text: &[u8]) -> Vec<u8> {
    fn nibble(byte: u8) -> u8 {
        match byte {
            b'0'..=b'9' => byte - b'0',
            b'a'..=b'f' => byte - b'a' + 10,
            _ => panic!("non-lowercase-hex byte {byte:#x}"),
        }
    }

    assert_eq!(text.len() % 2, 0);
    text.chunks_exact(2)
        .map(|pair| nibble(pair[0]) * 16 + nibble(pair[1]))
        .collect()
}

fn fixed_key_file(directory: &TestDirectory) -> (PathBuf, SigningKey) {
    let path = directory.join("authority.key");
    let seed = FIXED_KEY_SEED;
    fs::write(&path, independent_hex(&seed)).unwrap();
    (path, SigningKey::from_seed(&seed))
}

fn raw_key_file(directory: &TestDirectory, name: &str, seed: [u8; 32]) -> (PathBuf, SigningKey) {
    let path = directory.join(name);
    fs::write(&path, seed).unwrap();
    (path, SigningKey::from_seed(&seed))
}

fn valid_issue_arguments(key_path: &Path) -> Vec<String> {
    vec![
        "issue".to_owned(),
        "--key".to_owned(),
        path_text(key_path).to_owned(),
        "--log-id".to_owned(),
        independent_hex(&LOG_ID_BYTES),
        "--handle".to_owned(),
        "alice".to_owned(),
        "--identity-pk".to_owned(),
        independent_hex(&IDENTITY_PK_BYTES),
        "--issued-ms".to_owned(),
        "1000".to_owned(),
        "--expires-ms".to_owned(),
        "5000".to_owned(),
        "--nonce".to_owned(),
        independent_hex(&EXPLICIT_NONCE_BYTES),
    ]
}

fn decode_assertion(bytes: &[u8]) -> HandleAssertion {
    decode_canonical::<HandleAssertion>(bytes)
        .unwrap()
        .value()
        .clone()
}

fn assert_authority_signature(assertion: &HandleAssertion, authority: &SigningKey) {
    let verifier =
        ed25519_dalek::VerifyingKey::from_bytes(authority.public_key().as_bytes()).unwrap();
    let signature = ed25519_dalek::Signature::from_bytes(assertion.signature.as_bytes());
    assert!(
        verifier
            .verify_strict(&assertion.assertion.signing_bytes().unwrap(), &signature)
            .is_ok(),
        "the emitted assertion was not signed by the --key authority"
    );
}

#[test]
fn keygen_reaches_the_exact_secure_no_clobber_output_path() {
    let directory = TestDirectory::new("keygen");
    let path = directory.join("requested.key");
    let adjacent = directory.join("requested.key.new");

    let first = keygen_with_zero_umask(&path);
    assert!(
        first.status.success(),
        "keygen failed: {}",
        String::from_utf8_lossy(&first.stderr)
    );
    assert!(path.is_file(), "keygen did not create the requested path");
    assert!(!adjacent.exists(), "keygen wrote an adjacent path instead");
    let original = fs::read(&path).unwrap();
    assert_eq!(original.len(), 64);
    let generated_seed = independent_unhex(&original);
    assert_eq!(generated_seed.len(), 32);
    // An all-zero 256-bit sample has probability 2^-256 under the production
    // OS RNG. Treat it as catastrophic output so this boundary test also holds
    // the post-read handling in `fill_os_random` to the generated key bytes.
    assert!(
        generated_seed.iter().any(|byte| *byte != 0),
        "production keygen emitted a catastrophic all-zero seed"
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    let second = command(&["keygen", "--out", path_text(&path)]);
    assert!(!second.status.success(), "keygen clobbered an existing key");
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn authority_dispatch_reports_the_derived_id_and_public_key_as_hex() {
    let directory = TestDirectory::new("authority");
    let (key_path, authority) = fixed_key_file(&directory);
    let output = command(&["authority", "--key", path_text(&key_path)]);
    assert!(
        output.status.success(),
        "authority failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let public = authority.public_key();
    let expected = format!(
        "authority_id  {}\npublic_key    {}\n",
        independent_hex(authority_id(&public).as_bytes()),
        independent_hex(public.as_bytes())
    );
    assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);

    let unknown = command(&[
        "authority",
        "--key",
        path_text(&key_path),
        "--bogus",
        "value",
    ]);
    assert!(!unknown.status.success(), "an unknown flag was accepted");
    assert!(
        String::from_utf8_lossy(&unknown.stderr).contains("unknown flag --bogus"),
        "the parser failed for an unrelated reason: {}",
        String::from_utf8_lossy(&unknown.stderr)
    );
}

#[test]
fn issue_dispatch_maps_every_explicit_option_and_writes_raw_signed_bytes() {
    let directory = TestDirectory::new("issue-raw");
    let (key_path, authority) = fixed_key_file(&directory);
    let output_path = directory.join("assertion.bin");
    let log_id = independent_hex(&LOG_ID_BYTES);
    let identity_pk = independent_hex(&IDENTITY_PK_BYTES);
    let nonce = independent_hex(&EXPLICIT_NONCE_BYTES);

    let output = command(&[
        "issue",
        "--key",
        path_text(&key_path),
        "--log-id",
        &log_id,
        "--handle",
        "alice",
        "--identity-pk",
        &identity_pk,
        "--intent",
        "reset",
        "--account-epoch",
        "41",
        "--issued-ms",
        "16909060",
        "--expires-ms",
        "84281096",
        "--nonce",
        &nonce,
        "--out",
        path_text(&output_path),
    ]);
    assert!(
        output.status.success(),
        "issue failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let bytes = fs::read(&output_path).unwrap();
    let assertion = decode_assertion(&bytes);
    let body = &assertion.assertion;
    assert_eq!(body.authority_id, authority_id(&authority.public_key()));
    assert_eq!(body.log_id.as_bytes(), &LOG_ID_BYTES);
    assert_eq!(body.handle.as_bytes(), b"alice");
    assert_eq!(body.identity_pk.as_bytes(), &IDENTITY_PK_BYTES);
    assert_eq!(body.intent, Intent::Reset);
    assert_eq!(body.account_epoch, 41);
    assert_eq!(body.issued_ms, 16_909_060);
    assert_eq!(body.expires_ms, 84_281_096);
    assert_eq!(body.nonce.as_bytes(), &EXPLICIT_NONCE_BYTES);
    assert_eq!(body.handle_id, body.handle.handle_id());
    assert_eq!(bytes, assertion.encode_canonical().unwrap());
    assert_authority_signature(&assertion, &authority);
}

#[test]
fn issue_stdout_is_lowercase_hex_and_validity_maps_to_expiry() {
    let directory = TestDirectory::new("issue-stdout");
    let (key_path, authority) = fixed_key_file(&directory);
    let log_id = independent_hex(&LOG_ID_BYTES);
    let identity_pk = independent_hex(&IDENTITY_PK_BYTES);
    let nonce = independent_hex(&EXPLICIT_NONCE_BYTES);

    let output = command(&[
        "issue",
        "--key",
        path_text(&key_path),
        "--log-id",
        &log_id,
        "--handle",
        "bob_7",
        "--identity-pk",
        &identity_pk,
        "--account-epoch",
        "7",
        "--issued-ms",
        "1000",
        "--validity-ms",
        "2500",
        "--nonce",
        &nonce,
    ]);
    assert!(
        output.status.success(),
        "issue failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout.last(), Some(&b'\n'));
    let encoded = output.stdout.strip_suffix(b"\n").unwrap();
    let bytes = independent_unhex(encoded);
    assert_eq!(encoded, independent_hex(&bytes).as_bytes());

    let assertion = decode_assertion(&bytes);
    assert_eq!(assertion.assertion.intent, Intent::Bind);
    assert_eq!(assertion.assertion.account_epoch, 7);
    assert_eq!(assertion.assertion.issued_ms, 1_000);
    assert_eq!(assertion.assertion.expires_ms, 3_500);
    assert_authority_signature(&assertion, &authority);
}

#[test]
fn issue_refuses_an_expiry_before_issuance_through_the_command_path() {
    let directory = TestDirectory::new("issue-window");
    let (key_path, _) = fixed_key_file(&directory);
    let output = command(&[
        "issue",
        "--key",
        path_text(&key_path),
        "--log-id",
        &independent_hex(&LOG_ID_BYTES),
        "--handle",
        "alice",
        "--identity-pk",
        &independent_hex(&IDENTITY_PK_BYTES),
        "--issued-ms",
        "2000",
        "--expires-ms",
        "1000",
        "--nonce",
        &independent_hex(&EXPLICIT_NONCE_BYTES),
    ]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("expires_ms must be after issued_ms"));
}

#[test]
fn keygen_rejects_unknown_flags_through_its_own_command_path() {
    let output = command(&["keygen", "--bogus", "value"]);
    assert!(!output.status.success(), "keygen ignored an unknown flag");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("unknown flag --bogus"),
        "keygen failed for an unrelated reason: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "keygen generated a key before refusing"
    );
}

#[test]
fn issue_rejects_unknown_flags_through_its_own_command_path() {
    let directory = TestDirectory::new("issue-unknown");
    let (key_path, _) = fixed_key_file(&directory);
    let mut args = valid_issue_arguments(&key_path);
    args.extend(["--bogus".to_owned(), "value".to_owned()]);
    let output = command_strings(&args);
    assert!(!output.status.success(), "issue ignored an unknown flag");
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("unknown flag --bogus"),
        "issue failed for an unrelated reason: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stdout.is_empty(),
        "issue minted an assertion before refusing"
    );
}

#[test]
fn authority_accepts_the_documented_32_byte_raw_key_file() {
    let directory = TestDirectory::new("authority-raw-key");
    let (key_path, authority) = raw_key_file(&directory, "authority.raw", RAW_AUTHORITY_SEED);
    let output = command(&["authority", "--key", path_text(&key_path)]);
    assert!(
        output.status.success(),
        "authority rejected a raw key: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let public = authority.public_key();
    let expected = format!(
        "authority_id  {}\npublic_key    {}\n",
        independent_hex(authority_id(&public).as_bytes()),
        independent_hex(public.as_bytes())
    );
    assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
}

#[test]
fn issue_accepts_the_documented_32_byte_raw_key_file_and_signs_with_it() {
    let directory = TestDirectory::new("issue-raw-key");
    let (key_path, authority) = raw_key_file(&directory, "authority.raw", RAW_ISSUE_SEED);
    let output_path = directory.join("assertion.bin");
    let mut args = valid_issue_arguments(&key_path);
    args.extend(["--out".to_owned(), path_text(&output_path).to_owned()]);
    let output = command_strings(&args);
    assert!(
        output.status.success(),
        "issue rejected a raw key: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let assertion = decode_assertion(&fs::read(output_path).unwrap());
    assert_eq!(assertion.assertion.log_id.as_bytes(), &LOG_ID_BYTES);
    assert_eq!(
        assertion.assertion.identity_pk.as_bytes(),
        &IDENTITY_PK_BYTES
    );
    assert_eq!(assertion.assertion.nonce.as_bytes(), &EXPLICIT_NONCE_BYTES);
    assert_eq!(
        assertion.assertion.authority_id,
        authority_id(&authority.public_key())
    );
    assert_authority_signature(&assertion, &authority);
}

#[test]
fn explicit_expiry_takes_precedence_over_validity_through_issue() {
    let directory = TestDirectory::new("issue-expiry-precedence");
    let (key_path, _) = fixed_key_file(&directory);
    let output_path = directory.join("assertion.bin");
    let mut args = valid_issue_arguments(&key_path);
    args.extend([
        "--validity-ms".to_owned(),
        "1".to_owned(),
        "--out".to_owned(),
        path_text(&output_path).to_owned(),
    ]);
    let output = command_strings(&args);
    assert!(
        output.status.success(),
        "issue rejected valid explicit-expiry input: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let assertion = decode_assertion(&fs::read(output_path).unwrap());
    assert_eq!(assertion.assertion.issued_ms, 1_000);
    assert_eq!(assertion.assertion.expires_ms, 5_000);
}

#[test]
fn every_subcommand_rejects_positional_arguments_before_doing_work() {
    let directory = TestDirectory::new("positionals");
    let (key_path, _) = fixed_key_file(&directory);

    let keygen = command(&["keygen", "positional"]);
    assert!(
        !keygen.status.success(),
        "keygen accepted a positional argument"
    );
    assert!(
        String::from_utf8_lossy(&keygen.stderr).contains("expected a --flag"),
        "keygen failed for an unrelated reason: {}",
        String::from_utf8_lossy(&keygen.stderr)
    );
    assert!(keygen.stdout.is_empty());

    let authority = command(&["authority", "--key", path_text(&key_path), "positional"]);
    assert!(
        !authority.status.success(),
        "authority accepted a positional argument"
    );
    assert!(
        String::from_utf8_lossy(&authority.stderr).contains("expected a --flag"),
        "authority failed for an unrelated reason: {}",
        String::from_utf8_lossy(&authority.stderr)
    );
    assert!(authority.stdout.is_empty());

    let mut issue_args = valid_issue_arguments(&key_path);
    issue_args.push("positional".to_owned());
    let issue = command_strings(&issue_args);
    assert!(
        !issue.status.success(),
        "issue accepted a positional argument"
    );
    assert!(
        String::from_utf8_lossy(&issue.stderr).contains("expected a --flag"),
        "issue failed for an unrelated reason: {}",
        String::from_utf8_lossy(&issue.stderr)
    );
    assert!(issue.stdout.is_empty());
}

// ------------------------------------------------------------------- zuu#651

#[test]
fn issue_refuses_a_reset_without_an_explicit_account_epoch() {
    // `--account-epoch` defaults to 0 for a bind, which is the honest baseline
    // for an account nothing has happened to yet. On a reset the value carries
    // the whole of A15: it must be the authority's durable per-account counter,
    // read after the ownership event, and this binary holds no such counter. So
    // it asks. Defaulting here — or, worse, reaching for a clock — is what
    // zuu#651 is about.
    let directory = TestDirectory::new("issue-reset-epoch");
    let (key_path, _) = fixed_key_file(&directory);
    let output = command(&[
        "issue",
        "--key",
        path_text(&key_path),
        "--log-id",
        &independent_hex(&LOG_ID_BYTES),
        "--handle",
        "alice",
        "--identity-pk",
        &independent_hex(&IDENTITY_PK_BYTES),
        "--intent",
        "reset",
        "--issued-ms",
        "1000",
        "--expires-ms",
        "2000",
        "--nonce",
        &independent_hex(&EXPLICIT_NONCE_BYTES),
    ]);
    assert!(
        !output.status.success(),
        "a reset was issued with no counter"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("--account-epoch is required for --intent reset"),
        "refused for an unrelated reason: {stderr}"
    );
    assert!(
        stderr.contains("never a clock"),
        "the reason is not stated: {stderr}"
    );
    assert!(output.stdout.is_empty(), "an assertion was written anyway");

    // The same command with the counter supplied is fine, and a bind with no
    // counter at all is still fine.
    let with_counter = command(&[
        "issue",
        "--key",
        path_text(&key_path),
        "--log-id",
        &independent_hex(&LOG_ID_BYTES),
        "--handle",
        "alice",
        "--identity-pk",
        &independent_hex(&IDENTITY_PK_BYTES),
        "--intent",
        "reset",
        "--account-epoch",
        "3",
        "--issued-ms",
        "1000",
        "--expires-ms",
        "2000",
        "--nonce",
        &independent_hex(&EXPLICIT_NONCE_BYTES),
    ]);
    assert!(
        with_counter.status.success(),
        "issue failed: {}",
        String::from_utf8_lossy(&with_counter.stderr)
    );
    let assertion = decode_assertion(&independent_unhex(
        with_counter.stdout.strip_suffix(b"\n").unwrap(),
    ));
    assert_eq!(assertion.assertion.intent, Intent::Reset);
    assert_eq!(assertion.assertion.account_epoch, 3);
}

#[test]
fn issue_refuses_a_clock_shaped_account_epoch() {
    // Unix time in whole seconds is the exact value a non-conforming issuer
    // substitutes when the counter is unavailable. It is refused at the
    // keyboard rather than at somebody else's log.
    let directory = TestDirectory::new("issue-clock-epoch");
    let (key_path, _) = fixed_key_file(&directory);
    let output = command(&[
        "issue",
        "--key",
        path_text(&key_path),
        "--log-id",
        &independent_hex(&LOG_ID_BYTES),
        "--handle",
        "alice",
        "--identity-pk",
        &independent_hex(&IDENTITY_PK_BYTES),
        "--intent",
        "reset",
        "--account-epoch",
        "1787000000",
        "--issued-ms",
        "1000",
        "--expires-ms",
        "2000",
        "--nonce",
        &independent_hex(&EXPLICIT_NONCE_BYTES),
    ]);
    assert!(
        !output.status.success(),
        "a clock was minted into an assertion"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("account_epoch is a clock, not a counter"),
        "refused for an unrelated reason: {stderr}"
    );
    assert!(output.stdout.is_empty());
}
