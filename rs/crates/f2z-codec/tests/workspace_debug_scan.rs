//! No type in the `rs/` workspace may derive `Debug` while holding raw bytes.
//!
//! # Why this is a source scan and not a fixture
//!
//! `tests/redaction.rs` checks one type at a time against a value. That is how
//! the #563 defect got in: `Canonicalized` was never formatted, so no fixture
//! ever looked at it, and the newtype discipline held only where somebody
//! remembered to apply it. Two hand-written `Debug` impls in a row is a
//! convention, not a control. This check reads the *source*, so it fires on a
//! type nobody wrote a fixture for — precisely the case the fixtures cannot
//! cover.
//!
//! # Why it lives here rather than in each crate
//!
//! Added in #572, it resolved its root from `CARGO_MANIFEST_DIR` and so only
//! ever scanned `f2z-codec/src`. `f2z-relay-proto` — the crate holding the
//! signing keys — sat outside it, and so would every crate added after. That is
//! the "registration is a discipline, not a control" shape of #553: a guard
//! whose coverage depends on someone remembering to extend it covers whatever
//! they last remembered.
//!
//! The scope is now the workspace, and there are three places it could have
//! gone:
//!
//! - **Copied into every crate's tests.** Rejected. *n* copies of a scanner
//!   drift, and the copy that matters is the one in the crate whose author did
//!   not know to add it — which is the crate that has no copy.
//! - **A new crate that exists only to host it.** Rejected. It would cost a
//!   manifest, a restated `rust-version` and licence registered with
//!   `scripts/check-rust-toolchain.sh`, an `rs/deny.toml` entry and a wasm
//!   build target, all for zero production code, and it would still be one
//!   file — just a lonelier one.
//! - **One file, in the crate every other crate already depends on.** Taken.
//!   `f2z-codec` is the root of the workspace's dependency graph and the crate
//!   where the redaction doctrine is written down, so a reader following the
//!   rule arrives here anyway. Its own name says the scope is the workspace,
//!   and [`workspace_crates`] asserts that every crate under `rs/crates/` was
//!   actually reached — so adding a crate cannot silently narrow the scan the
//!   way adding `f2z-relay-proto` silently narrowed the old one.
//!
//! A `cargo test -p f2z-relay-proto` alone will not run this. `cargo test
//! --locked --all-targets` from `rs/`, which is what CI runs, will.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's parser is a remote denial of
// service; neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

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

mod common;

use common::{source_files, without_comment, workspace_crates};

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
    let mut crates_reached = Vec::new();

    let sources = source_files();

    // Aliases are collected across the whole workspace first: a field in
    // `f2z-codec`'s `frame.rs` may be typed with an alias declared in its
    // `types.rs`, and a field in another crate may be typed with either.
    let mut spellings: Vec<String> = RAW_BYTE_TYPES.iter().map(|raw| (*raw).to_owned()).collect();
    for file in &sources {
        spellings.extend(raw_byte_aliases(&file.source));
    }

    for file in &sources {
        if !crates_reached.contains(&file.krate) {
            crates_reached.push(file.krate.clone());
        }
        for item in derived_debug_items(&file.label, &file.source) {
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

    // The coverage anchor, and the whole reason this file exists. A crate
    // added under `rs/crates/` must be *reached*, not merely listed: the
    // failure this replaces was a scan that quietly stopped at one crate's
    // boundary while still passing.
    let mut expected = workspace_crates();
    expected.sort();
    crates_reached.sort();
    assert_eq!(
        crates_reached, expected,
        "the scan did not reach every crate under rs/crates/. A crate outside it is a \
         crate where a derived Debug over raw bytes goes unnoticed."
    );

    // A scanner that silently matches nothing would pass forever. Anchor it on
    // types that certainly do derive `Debug` — one per crate, so a parser
    // regression confined to a single crate is loud too.
    for expected_type in ["RelayFrame", "CommandVerifier"] {
        assert!(
            scanned.iter().any(|name| name == expected_type),
            "the scanner did not find {expected_type}; it is no longer parsing the source. \
             Found: {scanned:?}"
        );
    }
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
