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
//!
//! # #636: a hand-rolled line scanner cannot parse Rust
//!
//! This scan used to walk physical *lines*, counting `#`, `[`/`]` and `{`/`}`
//! characters to find where an attribute or an item body ended. That is not
//! parsing Rust; it is guessing at Rust from its punctuation, and the guess is
//! wrong exactly when the punctuation appears somewhere the grammar does not
//! mean it — inside a string, inside a comment, or split across a line an
//! attribute's own brackets do not close on.
//!
//! #636 found the sharpest version of that: a `#[must_use = "…"]` reason
//! string that happens to mention a bracketed index (`"see buffer[i]"`, say)
//! contains a `]` the depth counter cannot tell apart from the one that really
//! closes the attribute. The counter reaches zero one character too early,
//! mistakes the *next* source line for the item declaration, and — because
//! Rust identifiers like `struct` and `enum` are ordinary words that can
//! appear in an English sentence — sometimes that misread "declaration" is
//! well-formed enough that nothing panics. The real item three lines down,
//! `Vec<u8>` field and all, is simply never visited again: no error, no
//! shrunken count, a green job.
//! `a_bracket_inside_an_attribute_string_cannot_hide_the_struct_after_it`
//! below reproduces exactly this — verified against the pre-fix scanner
//! before this file changed it — and is the proof the defect was real, not
//! merely theoretical.
//!
//! The fix is to stop guessing. [`syn::parse_file`] is the same tokenizer and
//! grammar `rustc` itself parses this source with, so an attribute's extent,
//! an item's identifier, and a field's type are read off a real syntax tree
//! rather than reconstructed from bracket-matching. A file `syn` cannot parse
//! is refused outright — [`parse_source`] panics rather than returning a
//! partial or empty result, so the one failure mode this scan must never have
//! again, coverage silently narrowing while the job stays green, is now a
//! parse a human has to look at.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's parser is a remote denial of
// service; neither hazard exists here, and a loud `panic!` on unparseable
// input is this file's entire point (#636's second demand — a check that
// cannot read a file must fail, not shrug).
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

use std::collections::BTreeSet;

use syn::parse::Parser;
use syn::{
    Attribute, Fields, GenericArgument, Item, Meta, PathArguments, Token, Type,
    punctuated::Punctuated,
};

mod common;

use common::{source_files, workspace_crates};

/// Field type spellings that a derived `Debug` renders as a decimal byte dump.
const RAW_BYTE_TYPES: &[&str] = &["Vec<u8>", "[u8;", "&[u8]", "TlsByteVec", "Box<[u8]>"];

/// Parse `source` as a whole Rust file, or refuse to scan it at all.
///
/// This is the load-bearing call of the whole rewrite: every other function
/// here works from the [`syn::File`] this returns, never from source text
/// directly, so there is no line-by-line guessing left to get wrong. A file
/// `syn` rejects is a file this scan cannot vouch for, and vouching for it
/// anyway — by skipping it, or by scanning whatever partial text preceded the
/// error — is exactly the failure #636 is about. `panic!` here fails the one
/// `#[test]` this lives in, which fails `cargo test`, which fails CI: loud,
/// not silent.
fn parse_source(file: &str, source: &str) -> syn::File {
    syn::parse_file(source).unwrap_or_else(|error| {
        panic!(
            "{file}: could not be parsed as Rust source; refusing to skip unchecked source \
             rather than guess at it from punctuation: {error}"
        )
    })
}

/// Names introduced by `type X = <a raw byte type>;`.
///
/// The scan matches how a field is *typed*, so `secret: Vec<u8>` is caught and
/// `secret: Blob` — where `type Blob = Vec<u8>;` — is not. That is the same
/// blind spot as a matcher anchored on a delimiter: the check is looking for a
/// shape the leak does not have to take. Resolving one level of alias closes
/// the case that actually occurs; a field whose type is an alias of an alias
/// would still slip, and that is stated rather than papered over.
///
/// Reading this off `syntax.items` rather than off source lines is what lets
/// `type Bytes =\n    Vec<u8>;` — the alias declaration itself split across
/// lines — resolve correctly; a line-anchored `type X = ` prefix match never
/// could.
fn raw_byte_aliases(syntax: &syn::File) -> Vec<String> {
    let none = BTreeSet::new();
    syntax
        .items
        .iter()
        .filter_map(|item| match item {
            Item::Type(alias) if !raw_labels_for_type(&alias.ty, &none).is_empty() => {
                Some(alias.ident.to_string())
            }
            _ => None,
        })
        .collect()
}

/// A `struct` or `enum` item that carried `#[derive(..., Debug, ...)]`, and
/// the raw-byte spellings actually found among its field types.
struct DerivedDebugItem {
    file: String,
    name: String,
    raw_types: BTreeSet<String>,
}

/// Three-valued truth for a `cfg(...)` predicate, evaluated only where the
/// answer does not depend on the eventual build's feature/target
/// configuration.
///
/// `#[cfg_attr(some_feature, derive(Debug))]` genuinely might or might not
/// derive `Debug` depending on flags this scan cannot know; `Unknown` keeps
/// that derive visible rather than guessing it away. Only `all()`/`any()`
/// with no nested predicates, or a `not(...)` of an already-resolved
/// predicate, resolve to `Always` or `Never` — which is exactly enough to
/// evaluate the vacuous `cfg_attr(all(), ...)` shape this file's fixture
/// uses, without pretending to be a real `cfg` evaluator.
#[derive(Clone, Copy, PartialEq, Eq)]
enum CfgTruth {
    Always,
    Never,
    Unknown,
}

fn cfg_truth(meta: &Meta) -> CfgTruth {
    if let Meta::List(list) = meta {
        let nested = Punctuated::<Meta, Token![,]>::parse_terminated.parse2(list.tokens.clone());
        if let Ok(nested) = nested {
            if list.path.is_ident("all") {
                return nested.iter().fold(CfgTruth::Always, |truth, item| {
                    match (truth, cfg_truth(item)) {
                        (CfgTruth::Never, _) | (_, CfgTruth::Never) => CfgTruth::Never,
                        (CfgTruth::Always, CfgTruth::Always) => CfgTruth::Always,
                        _ => CfgTruth::Unknown,
                    }
                });
            }
            if list.path.is_ident("any") {
                return nested.iter().fold(CfgTruth::Never, |truth, item| {
                    match (truth, cfg_truth(item)) {
                        (CfgTruth::Always, _) | (_, CfgTruth::Always) => CfgTruth::Always,
                        (CfgTruth::Never, CfgTruth::Never) => CfgTruth::Never,
                        _ => CfgTruth::Unknown,
                    }
                });
            }
            if list.path.is_ident("not") && nested.len() == 1 {
                return match cfg_truth(nested.first().unwrap()) {
                    CfgTruth::Always => CfgTruth::Never,
                    CfgTruth::Never => CfgTruth::Always,
                    CfgTruth::Unknown => CfgTruth::Unknown,
                };
            }
        }
    }
    CfgTruth::Unknown
}

/// Whether `meta` is a `#[derive(...)]` whose list names `Debug` —
/// possibly through a re-exported or fully-qualified path, since only the
/// last path segment has to read `Debug` — or a `#[cfg_attr(condition,
/// derive(...))]` whose condition is not statically `Never` and whose
/// nested attribute itself names `Debug`.
///
/// `syn` has already separated this attribute's delimiters from its content
/// before this function ever sees it, so nothing here cares whether the
/// original source wrote the list on one line or ten, nor what a doc comment
/// or reason string between `derive` and the item happened to contain.
///
/// Before this, the scan only ever asked `attribute.path().is_ident("derive")`
/// — so `#[cfg_attr(all(), derive(Debug))]`, a derive that is unconditionally
/// active, was invisible to it: `path()` on a `cfg_attr` attribute reads
/// `cfg_attr`, never `derive`, and the scan moved on without ever looking at
/// what the `cfg_attr` was gating. A type could derive `Debug` over raw bytes
/// this way and the leak check would report a clean scan.
fn meta_derives_debug(meta: &Meta) -> bool {
    let Meta::List(list) = meta else {
        return false;
    };
    if list.path.is_ident("derive") {
        return Punctuated::<syn::Path, Token![,]>::parse_terminated
            .parse2(list.tokens.clone())
            .unwrap_or_else(|error| {
                panic!("a #[derive(...)] list could not be parsed; refusing to skip it: {error}")
            })
            .iter()
            .any(|path| {
                path.segments
                    .last()
                    .is_some_and(|segment| segment.ident == "Debug")
            });
    }
    if !list.path.is_ident("cfg_attr") {
        return false;
    }
    let nested = Punctuated::<Meta, Token![,]>::parse_terminated
        .parse2(list.tokens.clone())
        .unwrap_or_else(|error| {
            panic!("a #[cfg_attr(...)] could not be parsed; refusing to skip a possible derive: {error}")
        });
    let mut nested = nested.iter();
    let condition = nested.next().unwrap_or_else(|| {
        panic!("a #[cfg_attr(...)] had no condition; refusing to skip a possible derive")
    });
    cfg_truth(condition) != CfgTruth::Never && nested.any(meta_derives_debug)
}

/// Whether any attribute in `attrs` derives `Debug`, directly or through a
/// `cfg_attr` whose condition is not statically `Never`. See
/// [`meta_derives_debug`].
fn attrs_derive_debug(attrs: &[Attribute]) -> bool {
    attrs
        .iter()
        .any(|attribute| meta_derives_debug(&attribute.meta))
}

/// Whether `ty` is the bare `u8` path type, with no qualification and no
/// generic arguments.
fn is_u8(ty: &Type) -> bool {
    matches!(
        ty,
        Type::Path(path)
            if path.qself.is_none()
                && path.path.segments.last().is_some_and(|segment| {
                    segment.ident == "u8" && matches!(segment.arguments, PathArguments::None)
                })
    )
}

fn first_type_argument(arguments: &PathArguments) -> Option<&Type> {
    let PathArguments::AngleBracketed(arguments) = arguments else {
        return None;
    };
    arguments.args.iter().find_map(|argument| match argument {
        GenericArgument::Type(ty) => Some(ty),
        _ => None,
    })
}

/// Every [`RAW_BYTE_TYPES`] (or registered alias) spelling that `ty` matches
/// or contains, read structurally off the type rather than off its spelling.
///
/// This is what closes the turbofish and whitespace gaps a text scan carries
/// for free alongside the multi-line one #636 was filed for: `Vec::<u8>` and
/// `Vec < u8 >` parse to the identical [`syn::Type`] as `Vec<u8>`, so a field
/// written either way is caught without either spelling needing its own
/// clause here.
fn raw_labels_for_type(ty: &Type, aliases: &BTreeSet<String>) -> BTreeSet<String> {
    let mut labels = BTreeSet::new();
    match ty {
        Type::Array(array) => {
            if is_u8(&array.elem) {
                labels.insert("[u8;".to_owned());
            } else {
                labels.extend(raw_labels_for_type(&array.elem, aliases));
            }
        }
        Type::Slice(slice) => {
            labels.extend(raw_labels_for_type(&slice.elem, aliases));
        }
        Type::Reference(reference) => {
            if matches!(&*reference.elem, Type::Slice(slice) if is_u8(&slice.elem)) {
                labels.insert("&[u8]".to_owned());
            } else {
                labels.extend(raw_labels_for_type(&reference.elem, aliases));
            }
        }
        Type::Paren(inner) => labels.extend(raw_labels_for_type(&inner.elem, aliases)),
        Type::Group(inner) => labels.extend(raw_labels_for_type(&inner.elem, aliases)),
        Type::Tuple(tuple) => {
            for element in &tuple.elems {
                labels.extend(raw_labels_for_type(element, aliases));
            }
        }
        Type::Path(path) if path.qself.is_none() => {
            for segment in &path.path.segments {
                let name = segment.ident.to_string();
                if aliases.contains(&name) {
                    labels.insert(name.clone());
                }
                if name.starts_with("TlsByteVec") {
                    labels.insert("TlsByteVec".to_owned());
                }
                if name == "Vec" && first_type_argument(&segment.arguments).is_some_and(is_u8) {
                    labels.insert("Vec<u8>".to_owned());
                }
                if name == "Box"
                    && first_type_argument(&segment.arguments).is_some_and(
                        |argument| matches!(argument, Type::Slice(slice) if is_u8(&slice.elem)),
                    )
                {
                    labels.insert("Box<[u8]>".to_owned());
                }
                // Recurse into every generic argument: `Option<Vec<u8>>` must
                // still be caught, the way a substring search over its
                // spelling would catch it for free.
                if let PathArguments::AngleBracketed(arguments) = &segment.arguments {
                    for argument in &arguments.args {
                        if let GenericArgument::Type(argument) = argument {
                            labels.extend(raw_labels_for_type(argument, aliases));
                        }
                    }
                }
            }
        }
        _ => {}
    }
    labels
}

fn field_types(fields: &Fields) -> impl Iterator<Item = &Type> {
    fields.iter().map(|field| &field.ty)
}

/// Collect every `struct`/`enum` in `syntax` whose attributes carry
/// `derive(Debug)`, together with the raw-byte spellings among its fields.
///
/// There is no more "skip attributes and comments until the item" step: `syn`
/// already partitioned the file into items with their attributes attached, so
/// a `#[derive(Debug)]` is either on a real `Item::Struct`/`Item::Enum` or it
/// is not looked at here at all. The entire class of bug this file exists to
/// fix — mistaking an attribute's continuation, or a comment, or a doc string,
/// for the item that follows it — has no code path left to occur through.
fn derived_debug_items(
    file: &str,
    syntax: &syn::File,
    aliases: &BTreeSet<String>,
) -> Vec<DerivedDebugItem> {
    let mut items = Vec::new();
    for item in &syntax.items {
        let (attrs, name, fields): (&[Attribute], String, Vec<&Type>) = match item {
            Item::Struct(item) => (
                &item.attrs,
                item.ident.to_string(),
                field_types(&item.fields).collect(),
            ),
            Item::Enum(item) => (
                &item.attrs,
                item.ident.to_string(),
                item.variants
                    .iter()
                    .flat_map(|variant| field_types(&variant.fields))
                    .collect(),
            ),
            _ => continue,
        };
        if !attrs_derive_debug(attrs) {
            continue;
        }
        let raw_types = fields
            .into_iter()
            .flat_map(|ty| raw_labels_for_type(ty, aliases))
            .collect();
        items.push(DerivedDebugItem {
            file: file.to_owned(),
            name,
            raw_types,
        });
    }
    items
}

/// Parse `source`, then run the production scan over it exactly as
/// `no_type_derives_debug_while_holding_raw_bytes` does for one real file.
/// The negative-control tests below all go through this, rather than a
/// hand-simplified restatement of the logic, so they exercise the actual
/// guard and not a softer imitation of it.
fn scan_source(file: &str, source: &str) -> (Vec<String>, Vec<String>) {
    let syntax = parse_source(file, source);
    let mut spellings: BTreeSet<String> =
        RAW_BYTE_TYPES.iter().map(|raw| (*raw).to_owned()).collect();
    spellings.extend(raw_byte_aliases(&syntax));

    let mut scanned = Vec::new();
    let mut violations = Vec::new();
    for item in derived_debug_items(file, &syntax, &spellings) {
        for raw in &item.raw_types {
            violations.push(format!(
                "{}: `{}` derives Debug while holding `{}` — a derived Debug \
                 renders that as a decimal byte dump. Hand-write Debug and \
                 report the field by length, as `Payload` and `Canonicalized` do.",
                item.file, item.name, raw
            ));
        }
        scanned.push(item.name);
    }
    (scanned, violations)
}

#[test]
fn multiline_attribute_cannot_hide_a_raw_byte_debug_leak() {
    // The exact shape #636 names: a `#[must_use = "…"]` reason wrapped across
    // two physical lines by a backslash continuation, immediately after a
    // `#[derive(..., Debug, ...)]` and immediately before the item it
    // decorates — the shape `f2z-relay-store`'s `Committed<T>` carried until
    // #632 shortened it, which is the only reason the original bug ever
    // stopped manifesting rather than ever having stopped existing.
    const SOURCE: &str = "#[derive(Clone, Debug)]\n#[must_use = \"line one \\\n              line two\"]\npub struct Committed {\n    secret: Vec<u8>,\n}\n";
    let (scanned, violations) = scan_source("committed.rs", SOURCE);
    assert_eq!(scanned, ["Committed"]);
    assert_eq!(violations.len(), 1);
    assert!(violations[0].contains("`Committed` derives Debug while holding `Vec<u8>`"));
}

#[test]
fn a_bracket_inside_an_attribute_string_cannot_hide_the_struct_after_it() {
    // The concrete defect this test proves was real before this file's fix,
    // not merely theoretical.
    //
    // The `must_use` reason string below is a genuinely multi-line attribute:
    // a backslash-newline continuation, exactly as Rust's own grammar allows,
    // carries the string (and so the attribute) across two physical lines.
    // Its text also happens to mention a bracketed index and a semicolon —
    // ordinary English, not special syntax to a human reader.
    //
    // The old bracket-depth counter could not tell the `]` inside "index]"
    // from the one that really closes the attribute: it saw one `[` and one
    // `]` on the *first* physical line and called the attribute closed right
    // there, one physical line early. It then read the second physical line —
    // still, per Rust's real grammar, inside the unterminated string — as the
    // item declaration. That line's words happen to read "struct Ignored;",
    // which is well-formed enough to satisfy the old scanner's keyword check
    // without panicking, and terminates its body at the first semicolon
    // found — which is the one right there. The real item, `Leaky`, with the
    // real `Vec<u8>` field, is never visited again.
    //
    // Verified against the pre-fix scanner directly: it returned exactly one
    // item, `Ignored`, whose captured body did **not** contain `Vec<u8>` —
    // `Leaky` was not merely unflagged, it was never seen. Zero violations,
    // job green, leak unexamined.
    const SOURCE: &str = r#"#[derive(Debug)]
#[must_use = "see index] out of range; \
              struct Ignored; more context"]
pub struct Leaky {
    secret: Vec<u8>,
}
"#;
    let (scanned, violations) = scan_source("bracket-in-string.rs", SOURCE);
    assert_eq!(
        scanned,
        ["Leaky"],
        "the scanner must find the real item the derive applies to, not a \
         phrase from inside the attribute's own still-open string"
    );
    assert_eq!(violations.len(), 1);
    assert!(violations[0].contains("`Leaky` derives Debug while holding `Vec<u8>`"));
}

#[test]
fn comment_between_derive_and_parenthesis_cannot_hide_a_raw_byte_debug_leak() {
    const SOURCE: &str = "#[derive /* the Rust lexer discards this comment */ (Debug)]\nstruct CommentLeak(Vec<u8>);\n";
    let (scanned, violations) = scan_source("commented-derive.rs", SOURCE);
    assert_eq!(scanned, ["CommentLeak"]);
    assert_eq!(violations.len(), 1);
    assert!(violations[0].contains("`CommentLeak` derives Debug while holding `Vec<u8>`"));
}

#[test]
fn turbofish_vec_type_cannot_hide_a_raw_byte_debug_leak() {
    const SOURCE: &str = "#[derive(Debug)]\nstruct TurbofishLeak(Vec::<u8>);\n";
    let (scanned, violations) = scan_source("turbofish.rs", SOURCE);
    assert_eq!(scanned, ["TurbofishLeak"]);
    assert_eq!(violations.len(), 1);
    assert!(violations[0].contains("`TurbofishLeak` derives Debug while holding `Vec<u8>`"));
}

#[test]
fn multiline_type_alias_cannot_hide_a_raw_byte_debug_leak() {
    const SOURCE: &str = "type Bytes =\n    Vec<u8>;\n#[derive(Debug)]\nstruct AliasLeak(Bytes);\n";
    let (scanned, violations) = scan_source("multiline-alias.rs", SOURCE);
    assert_eq!(scanned, ["AliasLeak"]);
    assert_eq!(violations.len(), 1);
    assert!(violations[0].contains("`AliasLeak` derives Debug while holding `Bytes`"));
}

#[test]
fn active_cfg_attr_derive_cannot_hide_a_raw_byte_debug_leak() {
    // Before `meta_derives_debug` above, this scan only ever asked
    // `attribute.path().is_ident("derive")`. `#[cfg_attr(all(), derive(Debug))]`
    // is a derive that is unconditionally active — `all()` with no nested
    // predicates is vacuously true — yet `path()` on a `cfg_attr` attribute
    // reads `cfg_attr`, never `derive`, so the scanner never looked inside it
    // at all. Verified directly against the pre-fix scanner: `scanned` came
    // back `[]` and `violations` came back `[]`, a clean bill of health for a
    // type that does derive `Debug` over a raw `Vec<u8>`.
    const SOURCE: &str = "#[cfg_attr(all(), derive(Debug))]\nstruct CfgAttrLeak(Vec<u8>);\n";
    let (scanned, violations) = scan_source("cfg-attr.rs", SOURCE);
    assert_eq!(scanned, ["CfgAttrLeak"]);
    assert_eq!(violations.len(), 1);
    assert!(violations[0].contains("`CfgAttrLeak` derives Debug while holding `Vec<u8>`"));
}

#[test]
fn safe_types_are_not_flagged() {
    const SOURCE: &str = "#[derive(Debug)]\nstruct Fine {\n    count: u32,\n    label: String,\n    words: Vec<u16>,\n}\n#[derive(Clone)]\nstruct NotDebug {\n    secret: Vec<u8>,\n}\n";
    let (scanned, violations) = scan_source("safe.rs", SOURCE);
    assert_eq!(scanned, ["Fine"]);
    assert!(violations.is_empty());
}

#[test]
fn compiler_accepted_token_controls_match_the_scanner_contract() {
    // Every fixture above is a claim about how `rustc` parses a token shape
    // — a comment inside `derive`'s parentheses, a turbofish `Vec::<u8>`, a
    // multi-line type alias, an unconditionally active `cfg_attr` derive.
    // Asserting on `scan_source`'s output alone only proves this file's own
    // parser agrees with itself; it says nothing about whether the source is
    // real Rust `rustc` would actually accept. This test compiles the same
    // shapes with the real compiler first, so a fixture that quietly stopped
    // being valid Rust — or never was — fails loudly here instead of just
    // exercising a scanner bug with another scanner bug.
    const SOURCE: &str = r#"
#![allow(dead_code)]
#[cfg_attr(all(), derive(Debug))]
struct CfgAttrLeak(Vec<u8>);
#[derive /* review */ (Debug)]
struct CommentLeak(Vec<u8>);
#[derive(Debug)]
struct TurbofishLeak(Vec::<u8>);
type Bytes =
    Vec<u8>;
#[derive(Debug)]
struct AliasLeak(Bytes);

#[cfg_attr(any(), derive(Debug))]
struct InactiveCfg(Vec<u8>);
#[derive(Clone)]
struct NotDebug(Vec<u8>);
#[derive(Debug)]
struct SafeWords(Vec::<u16>);
type Words =
    Vec<u16>;
#[derive(Debug)]
struct SafeAlias(Words);
"#;

    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory =
        std::env::temp_dir().join(format!("f2z-debug-scan-{}-{unique}", std::process::id()));
    std::fs::create_dir(&directory).unwrap();
    let source_path = directory.join("controls.rs");
    let metadata_path = directory.join("controls.rmeta");
    std::fs::write(&source_path, SOURCE).unwrap();
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let output = std::process::Command::new(rustc)
        .args(["--edition=2024", "--crate-type=lib", "--emit=metadata"])
        .arg(&source_path)
        .arg("-o")
        .arg(&metadata_path)
        .output()
        .unwrap();
    std::fs::remove_dir_all(&directory).unwrap();
    assert!(
        output.status.success(),
        "the scanner's Rust-token fixture must compile:\n{}",
        String::from_utf8_lossy(&output.stderr)
    );

    let (scanned, violations) = scan_source("compiler-controls.rs", SOURCE);
    assert_eq!(
        scanned,
        [
            "CfgAttrLeak",
            "CommentLeak",
            "TurbofishLeak",
            "AliasLeak",
            "SafeWords",
            "SafeAlias"
        ]
    );
    assert_eq!(
        violations.len(),
        4,
        "safe token controls must remain unflagged"
    );
    for leak in ["CfgAttrLeak", "CommentLeak", "TurbofishLeak", "AliasLeak"] {
        assert!(
            violations
                .iter()
                .any(|violation| violation.contains(&format!("`{leak}`")))
        );
    }
}

#[test]
#[should_panic(expected = "malformed.rs: could not be parsed as Rust source")]
fn unparseable_source_fails_closed_instead_of_being_skipped() {
    // #636's second demand: a file this scan cannot read must fail the job,
    // never quietly contribute zero findings to a scan that then reports
    // success. An unclosed attribute is not valid Rust, and `syn` refuses it
    // exactly the way `rustc` would.
    const SOURCE: &str =
        "#[derive(Debug)]\n#[must_use =\nstruct ThisMustNotBeMistakenForAnItem(Vec<u8>);\n";
    let _ = scan_source("malformed.rs", SOURCE);
}

#[test]
fn no_type_derives_debug_while_holding_raw_bytes() {
    let mut scanned = Vec::new();
    let mut violations = Vec::new();
    let mut crates_reached = Vec::new();
    let mut examined = 0usize;

    let sources = source_files();

    for file in &sources {
        if !crates_reached.contains(&file.krate) {
            crates_reached.push(file.krate.clone());
        }
        let (file_scanned, file_violations) = scan_source(&file.label, &file.source);
        // Counted only once `scan_source` has actually returned for this
        // file, so a future `continue` that skips a file too "hard" to parse
        // shows up here as a coverage drop rather than as silence — #636's
        // third demand.
        examined += 1;
        scanned.extend(file_scanned);
        violations.extend(file_violations);
    }

    assert_eq!(
        examined,
        sources.len(),
        "the scan examined {examined} of {} collected source files; the missing ones are \
         unchecked, not clean",
        sources.len()
    );

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
