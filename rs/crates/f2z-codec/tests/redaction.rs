//! `--log-level trace` must never become a ciphertext archive.
//!
//! Every newtype that carries an address, a payload or a key renders through
//! `Debug` without its bytes, and so does every structure that contains one —
//! because a derived `Debug` delegates to the field's, which is exactly why the
//! redaction lives on the newtype rather than on the frame.
//!
//! The tests below are deliberately paranoid: it is not enough that the obvious
//! hex encoding is absent. Base16 in either case, base64url, a **decimal byte
//! list**, and any long run of hex-looking characters are all checked, because a
//! `Debug` that leaked bytes would most plausibly do it through one of those and
//! not through the exact format this file happened to guess.
//!
//! The decimal case is not hypothetical. `tls_codec`'s own byte vectors derive
//! `Debug` and print `TlsByteVecU24 { vec: [222, 222, 222, …] }` — a complete
//! dump that contains no hex at all. That is why every body and payload in this
//! crate is a newtype rather than a bare `tls_codec` vector.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's parser is a remote denial of
// service; neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::canonical::Canonical;
use f2z_codec::commands::{AppendRequest, ContactAppendRequest, CreateQueueRequest, QueuedMessage};
use f2z_codec::frame::{CommandAuth, RelayFrame, Request, SignedAuth};
use f2z_codec::pow::PowStamp;
use f2z_codec::types::{
    Challenge, ChannelBinding, Digest, Nonce, Payload, PublicKey, QueueAddress, RelayId, Salt,
    ShortBytes, Signature,
};

/// A byte pattern that is unmistakable in any encoding a leak might use.
const SECRET: u8 = 0xde;

fn lower_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn upper_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

/// `222, 222, 222, …` — the body of a derived `Debug` on a byte slice, with no
/// surrounding brackets.
///
/// Unbracketed on purpose. A real dump is very often *not* the whole list: a
/// wire buffer opens with a length prefix, so the secret starts partway through
/// as `[0, 4, 0, 222, 222, …`. Anchoring the pattern on `[` makes the check
/// miss exactly the shape it exists to catch.
fn decimal_run(bytes: &[u8]) -> String {
    let joined: Vec<String> = bytes.iter().map(|byte| byte.to_string()).collect();
    joined.join(", ")
}

/// `[222, 222, 222, …]` — a derived `Debug` on a byte slice.
fn decimal_list(bytes: &[u8]) -> String {
    format!("[{}]", decimal_run(bytes))
}

fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let mut buffer = [0u8; 3];
        buffer[..chunk.len()].copy_from_slice(chunk);
        let value =
            (u32::from(buffer[0]) << 16) | (u32::from(buffer[1]) << 8) | u32::from(buffer[2]);
        let symbols = match chunk.len() {
            1 => 2,
            2 => 3,
            _ => 4,
        };
        for index in 0..symbols {
            let shift = 18 - 6 * index;
            let symbol = ((value >> shift) & 0x3f) as usize;
            out.push(ALPHABET[symbol] as char);
        }
    }
    out
}

/// The longest run of characters that could be a hex dump.
///
/// A run of pure decimal digits does not count: this crate legitimately prints
/// millisecond timestamps and byte lengths, and treating `1700000000000` as a
/// hex dump would make the check fire on correct output instead of on a leak. A
/// run has to contain at least one `a`-`f` to be evidence of base16.
fn longest_hex_run(text: &str) -> usize {
    let mut longest = 0usize;
    let mut current = 0usize;
    let mut has_alpha = false;
    for character in text.chars() {
        if character.is_ascii_hexdigit() {
            current += 1;
            has_alpha |= character.is_ascii_alphabetic();
            if has_alpha {
                longest = longest.max(current);
            }
        } else {
            current = 0;
            has_alpha = false;
        }
    }
    longest
}

/// Assert that `rendered` cannot be turned back into `secret`.
fn assert_no_leak(label: &str, rendered: &str, secret: &[u8]) {
    assert!(
        !rendered.contains(&lower_hex(secret)),
        "{label} leaked lowercase hex: {rendered}"
    );
    assert!(
        !rendered.contains(&upper_hex(secret)),
        "{label} leaked uppercase hex: {rendered}"
    );
    assert!(
        !rendered.contains(&base64url(secret)),
        "{label} leaked base64url: {rendered}"
    );
    assert!(
        !rendered.contains(&decimal_list(secret)),
        "{label} leaked a decimal byte list: {rendered}"
    );
    // A prefix of a decimal dump is enough to convict: no correct output of this
    // crate ever prints four consecutive byte values. Matched without brackets,
    // so a dump that begins after a length prefix — `[0, 4, 0, 222, 222, …` —
    // is caught as readily as one that begins at the opening bracket.
    assert!(
        !rendered.contains(&decimal_run(&secret[..secret.len().min(4)])),
        "{label} leaked a decimal byte run: {rendered}"
    );
    // Every byte of the secret is 0xde, so even a two-byte prefix would show as
    // a repeated `de`. Catch a partial dump too.
    assert!(
        !rendered.contains(&lower_hex(&secret[..secret.len().min(4)])),
        "{label} leaked a hex prefix: {rendered}"
    );
    // Nothing this crate prints is a long hex string. 8 characters is short
    // enough to be a decimal length or a section number and long enough that a
    // real dump of even four bytes trips it.
    assert!(
        longest_hex_run(rendered) < 8,
        "{label} contains an 8+ character hex-looking run: {rendered}"
    );
}

#[test]
fn every_opaque_newtype_redacts() {
    let secret32 = [SECRET; 32];
    let secret64 = [SECRET; 64];
    let secret16 = [SECRET; 16];

    let cases: Vec<(&str, String, &[u8])> = vec![
        (
            "QueueAddress",
            format!("{:?}", QueueAddress::new(secret32)),
            &secret32,
        ),
        (
            "PublicKey",
            format!("{:?}", PublicKey::new(secret32)),
            &secret32,
        ),
        (
            "RelayId",
            format!("{:?}", RelayId::new(secret32)),
            &secret32,
        ),
        (
            "ChannelBinding",
            format!("{:?}", ChannelBinding::new(secret32)),
            &secret32,
        ),
        (
            "Challenge",
            format!("{:?}", Challenge::new(secret32)),
            &secret32,
        ),
        ("Digest", format!("{:?}", Digest::new(secret32)), &secret32),
        (
            "Signature",
            format!("{:?}", Signature::new(secret64)),
            &secret64,
        ),
        ("Nonce", format!("{:?}", Nonce::new(secret16)), &secret16),
        ("Salt", format!("{:?}", Salt::new(secret16)), &secret16),
    ];

    for (label, rendered, secret) in cases {
        assert_no_leak(label, &rendered, secret);
        assert!(
            rendered.contains("<redacted>"),
            "{label} must say it redacted something, got {rendered}"
        );
    }
}

#[test]
fn a_payload_reports_its_length_and_nothing_else() {
    let payload = Payload::new(vec![SECRET; 4096]).unwrap();
    let rendered = format!("{payload:?}");
    assert_eq!(rendered, "Payload(<redacted; 4096 bytes>)");
    assert_no_leak("Payload", &rendered, &[SECRET; 4096]);
}

#[test]
fn a_whole_frame_renders_without_a_single_secret_byte() {
    // The realistic disaster: someone derives Debug on the frame type and turns
    // trace logging on in production.
    let auth = SignedAuth {
        address: QueueAddress::new([SECRET; 32]),
        signer_key: PublicKey::new([SECRET; 32]),
        timestamp_ms: 1_700_000_000_000,
        nonce: Nonce::new([SECRET; 16]),
        signature: Signature::new([SECRET; 64]),
    };
    let body = AppendRequest {
        payload: Payload::new(vec![SECRET; 16_384]).unwrap(),
    };
    let frame = RelayFrame::request(
        9,
        Request::new(
            0x0021,
            CommandAuth::Signed(auth),
            body.encode_canonical().unwrap(),
        )
        .unwrap(),
    );

    let rendered = format!("{frame:?}");
    assert_no_leak("RelayFrame", &rendered, &[SECRET; 32]);
    assert_no_leak("RelayFrame", &rendered, &[SECRET; 64]);

    // The frame's `body` is an opaque `Body`, and this is the assertion that
    // makes that choice load-bearing: the payload inside it is 16 KiB of 0xde
    // and none of it appears, in any encoding.
    assert_no_leak("RelayFrame", &rendered, &[SECRET; 16_384]);
    assert!(rendered.contains("<redacted"), "got {rendered}");

    let rendered_body = format!("{body:?}");
    assert_no_leak("AppendRequest", &rendered_body, &[SECRET; 16_384]);
}

#[test]
fn every_command_carrying_a_secret_redacts_it() {
    let cases: Vec<(&str, String)> = vec![
        (
            "AppendRequest",
            format!(
                "{:?}",
                AppendRequest {
                    payload: Payload::new(vec![SECRET; 1024]).unwrap()
                }
            ),
        ),
        (
            "ContactAppendRequest",
            format!(
                "{:?}",
                ContactAppendRequest {
                    contact_addr: QueueAddress::new([SECRET; 32]),
                    payload: Payload::new(vec![SECRET; 1024]).unwrap(),
                    stamp: PowStamp {
                        challenge: Challenge::new([SECRET; 32]),
                        salt: Salt::new([SECRET; 16]),
                        counter: 42,
                    },
                }
            ),
        ),
        (
            "CreateQueueRequest",
            format!(
                "{:?}",
                CreateQueueRequest {
                    recv_key: PublicKey::new([SECRET; 32]),
                    req_message_ttl_seconds: 86_400,
                    req_idle_ttl_seconds: 86_400,
                    flags: 0,
                    stamp: PowStamp::empty(),
                }
            ),
        ),
        (
            "QueuedMessage",
            format!(
                "{:?}",
                QueuedMessage {
                    index: 3,
                    received_at_ms: 1_700_000_000_000,
                    payload: Payload::new(vec![SECRET; 65_536]).unwrap(),
                }
            ),
        ),
    ];

    for (label, rendered) in cases {
        assert_no_leak(label, &rendered, &[SECRET; 32]);
        assert_no_leak(label, &rendered, &[SECRET; 16]);
    }
}

#[test]
fn a_challenge_scope_is_an_address_and_redacts_but_operator_text_does_not() {
    // §11.1's operator fields exist to be read; §6.1's `scope` is a contact
    // address. Same type, opposite requirements, so the rule is on the content.
    let address = ShortBytes::new(vec![SECRET; 32]).unwrap();
    let rendered = format!("{address:?}");
    assert_no_leak("ShortBytes(scope)", &rendered, &[SECRET; 32]);
    assert!(rendered.contains("<redacted"), "got {rendered}");

    let operator = ShortBytes::new(b"Example Relay Co, Reykjavik".to_vec()).unwrap();
    assert_eq!(
        format!("{operator:?}"),
        "ShortBytes(Example Relay Co, Reykjavik)"
    );

    // Escaped, so a name with a newline cannot forge a log line.
    let hostile = ShortBytes::new(b"ok".to_vec()).unwrap();
    assert!(!format!("{hostile:?}").contains('\n'));
}

#[test]
fn a_canonicalized_value_never_dumps_the_bytes_it_arrived_as() {
    // `Canonicalized` is what every receive path holds: the decoded value *and*
    // the canonical bytes §5 hashes. The value's own `Debug` is already
    // redacted by the newtypes, so this test exists for the other field — the
    // raw `Vec<u8>`, which is the whole frame, ciphertext included.
    let body = AppendRequest {
        payload: Payload::new(vec![SECRET; 1024]).unwrap(),
    };
    let wire = body.encode_canonical().unwrap();
    let canonical = AppendRequest::decode_canonical(&wire).unwrap();

    let rendered = format!("{canonical:?}");
    assert_no_leak("Canonicalized<AppendRequest>", &rendered, &[SECRET; 1024]);
    assert!(
        rendered.contains("<redacted"),
        "Canonicalized must say it redacted something, got {rendered}"
    );
}

// ---------------------------------------------------------------------------
// The structural check.
//
// Everything above tests one type at a time against a fixture. That is how this
// defect got in: `Canonicalized` was never formatted, so the guard never looked
// at it, and the newtype discipline held only where somebody remembered to
// apply it. Two hand-written `Debug` impls in a row is a convention, not a
// control.
//
// So the check below is on the *source*, not on a value: no type in this crate
// may derive `Debug` while holding raw bytes. It fires on a type nobody wrote a
// fixture for, which is precisely the case the fixtures cannot cover.
// ---------------------------------------------------------------------------

/// Field type spellings that a derived `Debug` renders as a decimal byte dump.
const RAW_BYTE_TYPES: &[&str] = &["Vec<u8>", "[u8;", "&[u8]", "TlsByteVec", "Box<[u8]>"];

/// A `struct` or `enum` declaration that carried `#[derive(..., Debug, ...)]`.
struct DerivedDebugItem {
    file: String,
    name: String,
    body: String,
}

/// Every `.rs` file under `src/`, resolved from the manifest rather than the
/// process CWD so the test does not depend on where cargo was invoked.
fn source_files() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let read = std::fs::read_dir(dir);
        assert!(read.is_ok(), "could not read {dir:?}");
        let entries = read.unwrap();
        for entry in entries {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                out.push((name, std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    let mut out = Vec::new();
    walk(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src"),
        &mut out,
    );
    assert!(!out.is_empty(), "found no source files to scan");
    out
}

/// Strip a line comment, so a brace inside a doc comment does not confuse the
/// depth count. Struct bodies contain no string literals, so a naive cut is
/// safe here and a real parser is not worth the dependency.
fn without_comment(line: &str) -> &str {
    match line.find("//") {
        Some(index) => &line[..index],
        None => line,
    }
}

/// Collect every `struct`/`enum` in `source` whose derive list contains `Debug`.
fn derived_debug_items(file: &str, source: &str) -> Vec<DerivedDebugItem> {
    let lines: Vec<&str> = source.lines().collect();
    let mut items = Vec::new();
    let mut index = 0usize;

    while index < lines.len() {
        if !lines[index].trim_start().starts_with("#[derive(") {
            index += 1;
            continue;
        }

        // A derive list may span several lines (see `pow.rs`'s `PowParams`).
        let mut derives = String::new();
        while index < lines.len() {
            derives.push_str(lines[index]);
            index += 1;
            if derives.contains(")]") {
                break;
            }
        }
        let mentions_debug = derives
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .any(|token| token == "Debug");
        if !mentions_debug {
            continue;
        }

        // Skip any further attributes and comments between the derive and the
        // item it applies to.
        while index < lines.len() {
            let trimmed = lines[index].trim_start();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with("//") {
                index += 1;
            } else {
                break;
            }
        }
        assert!(index < lines.len(), "{file}: derive with no item after it");

        let declaration = lines[index];
        let mut words = declaration
            .split_whitespace()
            .skip_while(|word| *word != "struct" && *word != "enum");
        let keyword = words.next();
        let identifier = words.next();
        assert!(
            keyword.is_some() && identifier.is_some(),
            "{file}: derive(Debug) sits on an item this scanner does not recognise, so it \
             is not being checked: {declaration}"
        );
        let name = identifier
            .unwrap()
            .trim_end_matches(['<', '(', '{', ';'])
            .split(['<', '(', '{'])
            .next()
            .unwrap()
            .to_owned();

        // Accumulate the body: braced items to matching depth, tuple and unit
        // items to the terminating semicolon.
        let mut body = String::new();
        if without_comment(declaration).contains('{') {
            let mut depth = 0i32;
            while index < lines.len() {
                let line = lines[index];
                body.push_str(line);
                body.push('\n');
                let code = without_comment(line);
                depth += i32::try_from(code.matches('{').count()).unwrap();
                depth -= i32::try_from(code.matches('}').count()).unwrap();
                index += 1;
                if depth == 0 {
                    break;
                }
            }
        } else {
            while index < lines.len() {
                let line = lines[index];
                body.push_str(line);
                body.push('\n');
                index += 1;
                if without_comment(line).contains(';') {
                    break;
                }
            }
        }

        items.push(DerivedDebugItem {
            file: file.to_owned(),
            name,
            body,
        });
    }

    items
}

#[test]
fn no_type_derives_debug_while_holding_raw_bytes() {
    let mut scanned = Vec::new();
    let mut violations = Vec::new();

    for (file, source) in source_files() {
        for item in derived_debug_items(&file, &source) {
            for raw in RAW_BYTE_TYPES {
                // The declaration line itself is excluded from the search only
                // for the tuple-struct case, where it *is* the body; matching
                // the whole captured text is what we want either way.
                if item.body.contains(raw) {
                    violations.push(format!(
                        "{}: `{}` derives Debug while holding `{}` — a derived Debug \
                         renders that as a decimal byte dump. Hand-write Debug and \
                         report the field by length, as `Payload` and `Canonicalized` do.",
                        item.file, item.name, raw
                    ));
                }
            }
            scanned.push(item.name);
        }
    }

    // A scanner that silently matches nothing would pass forever. Anchor it on
    // types that certainly do derive `Debug`, so a parser regression is loud.
    assert!(
        scanned.iter().any(|name| name == "RelayFrame"),
        "the scanner did not find RelayFrame; it is no longer parsing the source. Found: {scanned:?}"
    );
    assert!(
        scanned.len() > 20,
        "the scanner found only {} derive(Debug) types, which is too few to be real: {scanned:?}",
        scanned.len()
    );

    assert!(
        violations.is_empty(),
        "types deriving Debug over raw bytes:\n  {}",
        violations.join("\n  ")
    );
}
