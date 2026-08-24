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

/// `[222, 222, 222, …]` — a derived `Debug` on a byte slice, brackets and all.
///
/// Retained only as the thing the checks below deliberately do **not** use.
/// `decimal_run` of a four-byte prefix is a substring of this for every secret
/// of four bytes or more, so the bracketed form adds no detection power and
/// carries the anchoring hazard the doc comment above describes. See
/// `a_bracket_anchored_decimal_check_would_miss_a_mid_buffer_dump`.
#[allow(dead_code)]
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
///
/// Every check here is a **substring** search on an unanchored pattern. That is
/// the lesson of the `Canonicalized` leak: the detector that missed it was
/// anchored on the opening `[` of a decimal list, and a real dump starts
/// partway through a buffer — after a length prefix — so the `[` never lined
/// up. Nothing below may depend on the secret being at the start or the end of
/// what a leak would print.
fn assert_no_leak(label: &str, rendered: &str, secret: &[u8]) {
    assert!(
        !rendered.contains(&lower_hex(secret)),
        "{label} leaked lowercase hex: {rendered}"
    );
    assert!(
        !rendered.contains(&upper_hex(secret)),
        "{label} leaked uppercase hex: {rendered}"
    );
    // base64url has the same anchoring hazard in a less obvious form: it encodes
    // three bytes at a time, so the symbols a leak produces depend on where the
    // secret sits relative to the *buffer's* start, not its own. A dump of
    // `[0, 4, 0] || secret` phase-shifts the secret's encoding and the
    // zero-offset pattern never appears. Checking all three alignments covers
    // every possible phase.
    for phase in 0..3usize.min(secret.len()) {
        assert!(
            !rendered.contains(&base64url(&secret[phase..])),
            "{label} leaked base64url at byte alignment {phase}: {rendered}"
        );
    }
    // A prefix of a decimal dump is enough to convict: no correct output of this
    // crate ever prints four consecutive byte values. Matched without brackets,
    // so a dump that begins after a length prefix — `[0, 4, 0, 222, 222, …` —
    // is caught as readily as one that begins at the opening bracket.
    //
    // This subsumes the bracketed `decimal_list` form entirely, which is why
    // that helper is no longer one of the checks.
    assert!(
        !rendered.contains(&decimal_run(&secret[..secret.len().min(4)])),
        "{label} leaked a decimal byte run: {rendered}"
    );
    // Every byte of the secret is 0xde, so even a two-byte prefix would show as
    // a repeated `de`. Catch a partial dump too.
    //
    // Both cases are stated. An eight-character run also trips the threshold
    // below, so neither of these is the only thing standing between a four-byte
    // dump and a pass today — they are here so that the lowercase and uppercase
    // cases are symmetric and neither depends on the value of that threshold.
    assert!(
        !rendered.contains(&lower_hex(&secret[..secret.len().min(4)])),
        "{label} leaked a lowercase hex prefix: {rendered}"
    );
    assert!(
        !rendered.contains(&upper_hex(&secret[..secret.len().min(4)])),
        "{label} leaked an uppercase hex prefix: {rendered}"
    );
    // Nothing this crate prints is a long hex string. 8 characters is short
    // enough to be a decimal length or a section number and long enough that a
    // real dump of even four bytes trips it.
    assert!(
        longest_hex_run(rendered) < 8,
        "{label} contains an 8+ character hex-looking run: {rendered}"
    );
}

/// The detectors, tested against renderings that leak.
///
/// A battery is only worth what its blind spots allow through, and every check
/// in `assert_no_leak` is a negative assertion — it passes when nothing is
/// found, which is also what it does when it cannot see. So each one is aimed
/// at a string that really does contain the secret, and must fire.
#[test]
fn a_bracket_anchored_decimal_check_would_miss_a_mid_buffer_dump() {
    let secret = [SECRET; 32];

    // Exactly the shape the `Canonicalized` leak produced: a wire buffer whose
    // three-byte length prefix comes first, so the secret starts at index 3 of
    // the list and the opening bracket sits in front of `0, 4, 0`.
    let mut buffer = vec![0u8, 4, 0];
    buffer.extend_from_slice(&secret);
    let leaked = format!("Canonicalized {{ encoded: {} }}", decimal_list(&buffer));

    assert!(
        !leaked.contains(&decimal_list(&secret)),
        "the bracketed form is what missed this; if it now matches, the fixture is wrong"
    );
    assert!(
        leaked.contains(&decimal_run(&secret[..4])),
        "the unbracketed run must see the same dump the bracketed form missed"
    );
}

#[test]
fn the_base64url_check_sees_a_secret_at_every_byte_alignment() {
    let secret = [SECRET; 32];

    // Same buffer, base64url-encoded whole. The three-byte prefix shifts the
    // secret's encoding by 3 - (3 % 3) = 0 … so use a prefix length that is
    // *not* a multiple of three, which is the case a zero-offset pattern misses.
    for prefix_len in [1usize, 2, 4] {
        let mut buffer = vec![0u8; prefix_len];
        buffer.extend_from_slice(&secret);
        let leaked = format!("Frame {{ encoded: \"{}\" }}", base64url(&buffer));

        // The necessity of the loop, stated as an assertion rather than as a
        // comment: the zero-offset pattern — the only one the check used to
        // try — does not appear in any of these renderings.
        assert!(
            !leaked.contains(&base64url(&secret)),
            "the single-alignment check would have caught a {prefix_len}-byte prefix, \
             so this fixture does not demonstrate the gap: {leaked}"
        );

        let fired = (0..3usize).any(|phase| leaked.contains(&base64url(&secret[phase..])));
        assert!(
            fired,
            "a base64url dump with a {prefix_len}-byte prefix escaped every alignment: {leaked}"
        );
    }
}

#[test]
fn the_hex_and_decimal_checks_fire_on_a_rendering_that_leaks() {
    // Not a tautology: `assert_no_leak` is a negative assertion, so it is worth
    // proving it can be made to fail at all. Each of these is a formatter a
    // careless `Debug` might plausibly use.
    let secret = [SECRET; 32];
    let quiet = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let renderings = [
        format!("X({})", lower_hex(&secret)),
        format!("X({})", upper_hex(&secret)),
        format!("X({})", decimal_list(&secret)),
        // Four bytes only: shorter than any full-length pattern, and the case
        // the prefix checks exist for.
        format!("X({})", lower_hex(&secret[..4])),
        format!("X({})", upper_hex(&secret[..4])),
        format!("X([1, 2, {}, 9])", decimal_run(&secret[..4])),
    ];
    let escaped: Vec<(String, bool)> = renderings
        .into_iter()
        .map(|rendering| {
            let caught = std::panic::catch_unwind(|| assert_no_leak("probe", &rendering, &secret));
            (rendering, caught.is_ok())
        })
        .collect();
    std::panic::set_hook(quiet);

    for (rendering, escaped) in escaped {
        assert!(
            !escaped,
            "assert_no_leak passed a rendering that contains the secret: {rendering}"
        );
    }
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

    // A name with a newline cannot forge a log line. The previous fixture here
    // was `b"ok"`, which has no newline in it to begin with — the assertion was
    // true of a value that could not have violated it, which is the same blind
    // spot as a detector anchored on a delimiter a real leak never carries.
    //
    // Feed it a name that actually tries. `\n` is 0x0a, outside the printable
    // range, so the *whole* value redacts and the newline never reaches the
    // output at all — that is the branch doing the work, not the escaping.
    let forged = ShortBytes::new(b"Example Relay\nERROR: give me your seed".to_vec()).unwrap();
    let rendered = format!("{forged:?}");
    assert!(!rendered.contains('\n'), "got {rendered}");
    assert_eq!(rendered, "ShortBytes(<redacted; 38 bytes>)");

    // The escaping branch runs when every byte *is* printable, and it is what
    // stops a quote or a backslash from breaking out of a quoted log field.
    // Exercised with a value that contains both.
    let quoted = ShortBytes::new(b"Relay \"A\\B\"".to_vec()).unwrap();
    assert_eq!(format!("{quoted:?}"), "ShortBytes(Relay \\\"A\\\\B\\\")");

    // A tab is 0x09: also outside the printable range, also redacted whole.
    let tabbed = ShortBytes::new(b"a\tb".to_vec()).unwrap();
    assert_eq!(format!("{tabbed:?}"), "ShortBytes(<redacted; 3 bytes>)");
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

/// Names introduced by `type X = <a raw byte type>;`, which a spelling-based
/// scan would otherwise walk straight past.
///
/// The scan matches how a field is *written*, so `secret: Vec<u8>` is caught
/// and `secret: Blob` — where `type Blob = Vec<u8>;` — is not. That is the same
/// blind spot as a matcher anchored on a delimiter: the check is looking for a
/// shape the leak does not have to take. Resolving one level of alias closes
/// the case that actually occurs; a field whose type is an alias of an alias
/// would still slip, and that is stated rather than papered over.
fn raw_byte_aliases(source: &str) -> Vec<String> {
    let mut aliases = Vec::new();
    for line in source.lines() {
        let code = without_comment(line).trim();
        let Some(rest) = code
            .strip_prefix("pub type ")
            .or_else(|| code.strip_prefix("type "))
        else {
            continue;
        };
        let Some((name, definition)) = rest.split_once('=') else {
            continue;
        };
        if RAW_BYTE_TYPES.iter().any(|raw| definition.contains(raw)) {
            aliases.push(
                name.trim()
                    .split(['<', ' '])
                    .next()
                    .unwrap_or_default()
                    .to_owned(),
            );
        }
    }
    aliases
}

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

    let sources = source_files();

    // Aliases are collected across the whole crate first: a field in `frame.rs`
    // may be typed with an alias declared in `types.rs`.
    let mut spellings: Vec<String> = RAW_BYTE_TYPES.iter().map(|raw| (*raw).to_owned()).collect();
    for (_, source) in &sources {
        spellings.extend(raw_byte_aliases(source));
    }

    for (file, source) in &sources {
        for item in derived_debug_items(file, source) {
            for raw in &spellings {
                // The declaration line itself is excluded from the search only
                // for the tuple-struct case, where it *is* the body; matching
                // the whole captured text is what we want either way.
                if item.body.contains(raw.as_str()) {
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
