//! No crate in the `rs/` workspace may verify an Ed25519 signature
//! non-strictly.
//!
//! # The defect this exists for
//!
//! `ed25519_dalek`'s plain `verify` is the uncofactored `R' == R` comparison.
//! `verify_strict` screens a small-order `A` and a small-order `R` first.
//! Measured in this tree (ed25519-dalek 3.0.0 / curve25519-dalek 5.0.0), with
//! `A` the identity point — little-endian `0x01` then 31 zero bytes — and
//! `sig = A || [0u8; 32]`:
//!
//! ```text
//! ed25519 verify        -> ACCEPTS 64/64 distinct messages
//! ed25519 verify_strict -> REJECTS all 64
//! ```
//!
//! That is a **universal forgery key**: one public key whose single signature
//! validates against any message, for which nobody knows — or needs — a
//! private key. `WIRE.md` §5.1 step 5 compares `signer_key` against the key
//! registered for an address, so a key that verifies everything steals every
//! queue it is registered against.
//!
//! # Why a scan and not a fixture
//!
//! Because the fixture is the thing that failed. #589 found
//! `f2z-relay-proto`'s `small_order_keys_are_rejected_by_strict_verification`
//! used an **all-zero signature**, which *both* functions reject, so the test
//! passed whether or not strict verification was in use; #597 fixed it. #603
//! then found `f2z-authority` had independently written the same inert
//! fixture, where the end-to-end consequence is `admit` returning
//! `Ok(AdmittedHandle)` for a handle claimed with no private key at all.
//!
//! Two crates, written separately, reproduced the same mistake, because the
//! mistake is natural: an all-zero signature *looks* like the degenerate case
//! you would test, and it *does* fail, so the test goes green and reads as
//! correct. A third fixture would be a third chance to write it wrong. This
//! scan does not ask whether a fixture is convincing; it asks whether the
//! non-strict function is *reachable from the source at all*.
//!
//! # Where the line between "safe" and "non-strict" is drawn
//!
//! Naively grepping for `.verify(` produces three hits in this workspace that
//! are all **correct** — `hello.rs`, `capabilities.rs` and `command.rs` each
//! call `f2z_relay_proto::key::VerifyingKey::verify`, the crate's own wrapper,
//! which calls `verify_strict` inside. A check that cries wolf on correct code
//! gets silenced, and then it protects nothing. So the scan does not look at
//! `.verify(` as a spelling. It draws the line in three places, and each is
//! anchored so that it cannot quietly stop matching:
//!
//! 1. **The trait-import gate.** `ed25519_dalek::VerifyingKey` has **no
//!    inherent `verify`** — the method comes only from
//!    `impl Verifier<ed25519::Signature> for VerifyingKey`
//!    (`ed25519-dalek-3.0.0/src/verifying.rs:567`), and Rust requires a trait
//!    to be in scope to call its methods, through a `.` receiver or through a
//!    `Type::method` path alike. So a file that never names a `Verifier`
//!    trait *cannot* call plain Ed25519 verification. [`VERIFIER_TRAITS`]
//!    therefore flags the *name*, anywhere in the file, rather than the call:
//!    that survives `as _`, `as VK`, a re-export under another name (the
//!    re-export itself names it), and the fully-qualified
//!    `<K as ed25519_dalek::Verifier<S>>::verify(…)` form, which needs no
//!    import at all. A glob import of any module whose path mentions
//!    `ed25519` or `signature` is flagged too, since that is the one way the
//!    trait arrives unnamed. All four spellings were tried against this scan
//!    and all four are caught; what is *not* caught is a third-party crate
//!    re-exporting the trait under a different name, because then no file here
//!    ever writes `Verifier`.
//!
//! 2. **The non-strict entry points that need no trait.** `verify_prehashed`,
//!    `verify_stream`, `verify_batch`, `multipart_verify`, `verify_digest` and
//!    `raw_verify` are reachable without importing anything, and none of them
//!    screens small-order points. They are matched by name, as whole
//!    identifiers, so `verify_prehashed_strict` is not confused for
//!    `verify_prehashed`. Most sit behind `digest`/`hazmat`/`batch` features
//!    this workspace disables, which feature unification can turn back on
//!    without anybody editing a manifest here.
//!
//! 3. **The receiver rule.** A binding, or a struct field, whose type is
//!    `ed25519_dalek::VerifyingKey`, followed by `.verify(` on it — plus the
//!    fully-qualified spellings `ed25519_dalek::VerifyingKey::verify(` and
//!    `Verifier::verify(`. This is what gives a violation a line number rather
//!    than an import to go and read, and it is what catches the mutation #589
//!    demonstrated: `self.0.verify_strict(…)` becoming `self.0.verify(…)`
//!    inside the wrapper itself.
//!
//! And the wrapper is not *assumed* safe. [`WORKSPACE_VERIFY_FNS`] registers
//! every `fn verify…` defined under `rs/crates/*/src/` together with what
//! makes it strict, and the registration is checked against the source: the
//! one at the bottom must contain `verify_strict` in its body, and every other
//! must delegate to a registered one. An unregistered `fn verify…` fails the
//! scan by name — the #609 shape, where narrowing the list is louder than
//! leaving it alone, rather than a list that silently covers less.
//!
//! # What this cannot catch
//!
//! Stated plainly, as `workspace_debug_scan.rs` states its own:
//!
//! - **Another crate's non-strict Ed25519.** The rules name `ed25519_dalek`.
//!   A different Ed25519 implementation, wrapping non-strict verification
//!   behind its own type, would pass. `ed25519-dalek` is the workspace's only
//!   signature dependency today and `rs/Cargo.lock` is committed, so this is a
//!   change a reviewer would see; it is not a change this scan would report.
//! - **A macro that generates the call.** Nothing here expands macros.
//! - **A receiver whose type is inferred through a function return.**
//!   `let k = decode(bytes); k.verify(…)` where `decode` returns a dalek key
//!   is not resolved. Rule 1 still catches it — the file must import
//!   `Verifier` for that call to compile — which is why the gate is on the
//!   import and not only on the call.
//! - **Anything outside a crate's `src/`.** `tests/`, `benches/`, `examples/`
//!   and a `build.rs` are walked by nothing here — demonstrated, not assumed:
//!   a `use ed25519_dalek::Verifier as _;` plus a `key.verify(…)` added to
//!   `f2z-relay-proto/tests/properties.rs` leaves this scan green. That is
//!   deliberate rather than an oversight: none of those is compiled into the
//!   library a relay links, so a non-strict call there cannot reach
//!   `CommandVerifier::verify` or an `admit`-style authorization boundary, and
//!   the inert *fixture* half of #603 is a different check with a different
//!   remedy. Widening the walk would also mean widening the exemption rule,
//!   since an integration test's fixture is not inside a `#[cfg(test)]` item.
//! - **Anything outside `rs/crates/`.** The wallet's Rust is a different
//!   toolchain, a different lockfile, and a different lint set.
//!
//! A `cargo test -p f2z-relay-proto` alone will not run this. `cargo test
//! --locked --all-targets` from `rs/`, which is what `rs / tests` runs, will.
//!
//! # Why it lives in `f2z-codec/tests/`
//!
//! Same three-way choice `workspace_debug_scan.rs` made, and the same answer:
//! a copy in every crate drifts and is missing from the crate that needs it, a
//! crate that exists only to host it costs a manifest and a `rs/deny.toml`
//! entry and a toolchain registration for zero production code, and
//! `f2z-codec` is the root of the workspace dependency graph. It shares that
//! scan's crate walk outright (`tests/common/mod.rs`) so the two coverage
//! anchors cannot narrow independently of each other.
//!
//! It is a Rust test and not a `scripts/` checker — unlike
//! `check-hash-domain-labels.mjs`, whose subject lives partly in Markdown that
//! `rs.yml`'s change detector would skip. This scan's subject is Rust source
//! under `rs/crates/`, so any diff that could introduce a violation selects
//! `rs=true` by construction.

// Test code, run on the host by a person reading the failure. The workspace
// denies these because a panic in the relay's parser is a remote denial of
// service; neither hazard exists here.
#![allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::panic
)]

mod common;

use common::{
    cfg_test_ranges, code_lines, contains_identifier, identifier_positions, in_cfg_test,
    source_files, workspace_crates,
};

/// Trait names whose presence in a `use` makes non-strict Ed25519
/// verification callable in that file.
///
/// `Verifier` is the one that matters: it is `signature::Verifier`, which
/// `ed25519_dalek` re-exports (`lib.rs:294`) and which `ed25519::signature`
/// re-exports too, so the path is not a reliable signal but the imported name
/// is. The other three are the same hazard through the multipart, prehashed
/// and streaming impls on the same type.
///
/// Matched as whole identifiers, so `CommandVerifier` — this workspace's own
/// type, imported by two test files — is not a hit.
const VERIFIER_TRAITS: &[&str] = &[
    "Verifier",
    "MultipartVerifier",
    "DigestVerifier",
    "StreamVerifier",
];

/// Non-strict Ed25519 verification entry points that need no trait import.
///
/// Every one of these skips the small-order screen that `verify_strict` and
/// `verify_prehashed_strict` perform. Matched as whole identifiers followed by
/// a call, so `verify_prehashed_strict(` is not read as `verify_prehashed(`.
const NON_STRICT_ENTRY_POINTS: &[&str] = &[
    "verify_prehashed",
    "verify_stream",
    "verify_batch",
    "multipart_verify",
    "verify_digest",
    "raw_verify",
];

/// Fully-qualified spellings of a plain `verify` on a dalek key, which name no
/// local binding for the receiver rule to track.
const QUALIFIED_NON_STRICT_CALLS: &[&str] = &[
    "ed25519_dalek::VerifyingKey::verify(",
    "Verifier::verify(",
    "as Verifier>::verify(",
];

/// A deliberate non-strict call, registered with the reason it is not a
/// defect.
///
/// This is the escape hatch, and it is deliberately awkward: an entry names a
/// file and the exact text of the line, it must still match something (a stale
/// entry fails the scan, so the list cannot outlive what it excuses), and it
/// must sit inside `#[cfg(test)]` — a fixture proving what plain verification
/// accepts is the only honest reason to call it, and a fixture lives in a test
/// module. An entry that drifted into a shipped code path stops being covered
/// and the scan refuses it.
struct Registered {
    /// The `<crate>/<path>` label, as [`common::SourceFile`] spells it.
    file: &'static str,
    /// Text that must appear on the flagged line.
    line: &'static str,
    /// Why this is not the defect.
    why: &'static str,
}

/// The registered deliberate non-strict calls in this workspace.
///
/// Both entries are `f2z-relay-proto`'s universal-forgery fixture from #597 —
/// the test that asserts plain `verify` **accepts** the identity-point forgery
/// for 64 distinct messages and that the crate's wrapper **rejects** it. That
/// test cannot be written without calling the non-strict function, and a
/// fixture that could not call it would be back to asserting nothing, which is
/// the #589 defect exactly.
///
/// They double as this scan's positive control: if either stops matching, the
/// scanner has stopped seeing the one call in the tree it is known to be able
/// to see, and it fails rather than passing with nothing found.
const REGISTERED_NON_STRICT: &[Registered] = &[
    Registered {
        file: "f2z-relay-proto/src/key.rs",
        line: "use ed25519_dalek::Verifier as _;",
        why: "the #597 universal-forgery fixture must call plain `verify` to assert it \
              ACCEPTS the identity-point forgery; without that half the test would pass \
              for a reason unrelated to strictness, which is #589",
    },
    Registered {
        file: "f2z-relay-proto/src/key.rs",
        line: "raw.verify(&message, &dalek_signature).is_ok(),",
        why: "the call itself, inside that fixture's assertion",
    },
    Registered {
        file: "f2z-authority/src/key.rs",
        line: "use ed25519_dalek::Verifier as _;",
        why: "the #603 universal-forgery fixture must positively prove plain verification accepts what strict verification rejects",
    },
    Registered {
        file: "f2z-authority/src/key.rs",
        line: "raw.verify(&message, &dalek_signature).is_ok(),",
        why: "the deliberate non-strict call inside the #603 positive control",
    },
];

/// The `.verify(` call sites in this workspace that a naive grep flags and
/// that are **correct** — each calls `f2z_relay_proto::key::VerifyingKey`'s
/// wrapper, which calls `verify_strict` inside (and
/// [`WORKSPACE_VERIFY_FNS`] holds it to that).
///
/// They are registered as *negative* controls. A check that cries wolf on
/// correct code gets silenced, and then it protects nothing, so "these three
/// are not flagged" is asserted rather than observed once. Each entry names a
/// text that must still be in the file, so a control cannot go vacuous by the
/// call it guards being deleted.
const SAFE_WRAPPER_CALL_SITES: &[(&str, &str)] = &[
    ("f2z-relay-proto/src/hello.rs", ".verify("),
    (
        "f2z-relay-proto/src/capabilities.rs",
        "key.verify(&signing_bytes(",
    ),
    (
        "f2z-relay-proto/src/command.rs",
        "verifying_key.verify(&transcript.signing_bytes()?",
    ),
];

/// What makes one of this workspace's own `verify` functions strict.
enum Strictness {
    /// Its body calls `verify_strict` and contains no non-strict entry point.
    /// Each crate-level wrapper has one of these, and is the basis for that
    /// crate's delegation chain.
    CallsVerifyStrict {
        /// The expression whose strict method must be called.
        receiver: &'static str,
    },
    /// Its body calls a registered strict verifier, named `<file>::<fn>`.
    DelegatesTo {
        /// The registered strict function this call resolves to.
        target: &'static str,
        /// The local binding on which the wrapper method must be called.
        receiver: &'static str,
        /// The method name called on `receiver`.
        method: &'static str,
    },
    /// Its body calls a registered strict verifier as a **free function**
    /// rather than as a method — `sig::verify(key, message, signature)`.
    ///
    /// `f2z-kt-core` puts its one Ed25519 entry point in a free function
    /// instead of on a key newtype, so its wrappers cannot satisfy
    /// [`Strictness::DelegatesTo`]'s receiver rule. The guarantee is the same:
    /// the target is registered, and the target's own row is what holds it to
    /// `verify_strict`.
    DelegatesToFn {
        /// The registered strict function this call resolves to.
        target: &'static str,
        /// The exact path as written at the call site, e.g. `sig::verify`.
        call: &'static str,
    },
    /// It verifies something that is **not an Ed25519 signature**, so no
    /// delegation chain to `verify_strict` exists or should.
    ///
    /// `verify_lookup` and `verify_key_history` check `akd_core` proofs against
    /// an already-witnessed root; `verify_append_only` runs `akd`'s auditor;
    /// `verify_threshold` counts cosignatures whose signatures a registered
    /// verifier already checked; `verify_authorization` re-runs `KT.md` §4.4.
    ///
    /// The row still names the call it makes, so it cannot go vacuous by that
    /// call being deleted — which is the same property every other variant
    /// buys, applied to a different kind of verification.
    NotASignatureCheck {
        /// The verification call the body must still contain.
        via: &'static str,
    },
}

/// A `fn verify…` defined under `rs/crates/*/src/`, and why it is strict.
struct VerifyFn {
    /// The `<crate>/<path>` label.
    file: &'static str,
    /// The function name as written after `fn`.
    name: &'static str,
    /// Which non-test definition with this name in this file, from zero.
    ///
    /// This makes a registry row identify one definition rather than every
    /// same-name method in the file. An added second `fn verify` therefore
    /// needs its own row and its own body check.
    occurrence: usize,
    /// What holds it to strict verification.
    strictness: Strictness,
}

/// Every `fn verify…` in the workspace, registered.
///
/// This is what answers "why is `key.verify(…)` in `capabilities.rs` not a
/// finding?" mechanically rather than by trust. The scan enumerates the
/// definitions from the source and requires the two lists to match exactly, so
/// a crate that lands a new `fn verify_signature` fails by name until somebody
/// says what makes it strict — and the entry at the bottom of every delegation
/// chain is checked against the source, so the mutation #589 demonstrated
/// (`verify_strict` → `verify` in the wrapper) turns this red from another
/// crate.
const WORKSPACE_VERIFY_FNS: &[VerifyFn] = &[
    VerifyFn {
        file: "f2z-relay-proto/src/key.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::CallsVerifyStrict { receiver: "self.0" },
    },
    VerifyFn {
        file: "f2z-relay-proto/src/capabilities.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::DelegatesTo {
            target: "f2z-relay-proto/src/key.rs::verify",
            receiver: "key",
            method: "verify",
        },
    },
    VerifyFn {
        file: "f2z-relay-proto/src/command.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::DelegatesTo {
            target: "f2z-relay-proto/src/command.rs::verify_authorized",
            receiver: "self",
            method: "verify_authorized",
        },
    },
    VerifyFn {
        file: "f2z-relay-proto/src/command.rs",
        name: "verify_authorized",
        occurrence: 0,
        strictness: Strictness::DelegatesTo {
            target: "f2z-relay-proto/src/key.rs::verify",
            receiver: "verifying_key",
            method: "verify",
        },
    },
    VerifyFn {
        file: "f2z-relay-proto/src/hello.rs",
        name: "verify_hello_response",
        occurrence: 0,
        strictness: Strictness::DelegatesTo {
            target: "f2z-relay-proto/src/key.rs::verify",
            receiver: "identity",
            method: "verify",
        },
    },
    // The two relays. Neither verifies a signature itself: each builds a
    // `CommandVerifier` from `f2z-relay-proto` and hands it the frame, so what
    // they reach is `command.rs::verify_authorized`, which reaches
    // `key.rs::verify`'s `verify_strict`. Registered rather than exempted,
    // because "it only delegates" is the claim this scan exists to check
    // rather than accept.
    VerifyFn {
        file: "f2z-relay/src/engine.rs",
        name: "verify_with",
        occurrence: 0,
        strictness: Strictness::DelegatesTo {
            target: "f2z-relay-proto/src/command.rs::verify_authorized",
            receiver: "verifier",
            method: "verify_authorized",
        },
    },
    VerifyFn {
        file: "f2z-relay-testkit/src/engine.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::DelegatesTo {
            target: "f2z-relay-proto/src/command.rs::verify_authorized",
            receiver: "verifier",
            method: "verify_authorized",
        },
    },
    VerifyFn {
        file: "f2z-authority/src/key.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::CallsVerifyStrict { receiver: "self.0" },
    },
    VerifyFn {
        file: "f2z-authority/src/authority.rs",
        name: "verify_binding",
        occurrence: 0,
        strictness: Strictness::DelegatesTo {
            target: "f2z-authority/src/key.rs::verify",
            receiver: "identity_key",
            method: "verify",
        },
    },
    // ---- f2z-kt-core -------------------------------------------------------
    //
    // The crate's one Ed25519 entry point, and the basis of its chain.
    VerifyFn {
        file: "f2z-kt-core/src/sig.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::CallsVerifyStrict { receiver: "key" },
    },
    VerifyFn {
        file: "f2z-kt-core/src/cosign.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::DelegatesToFn {
            target: "f2z-kt-core/src/sig.rs::verify",
            call: "sig::verify",
        },
    },
    VerifyFn {
        file: "f2z-kt-core/src/descriptor.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::DelegatesToFn {
            target: "f2z-kt-core/src/sig.rs::verify",
            call: "sig::verify",
        },
    },
    VerifyFn {
        file: "f2z-kt-core/src/receipt.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::DelegatesToFn {
            target: "f2z-kt-core/src/sig.rs::verify",
            call: "sig::verify",
        },
    },
    VerifyFn {
        file: "f2z-kt-core/src/sth.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::DelegatesToFn {
            target: "f2z-kt-core/src/sig.rs::verify",
            call: "sig::verify",
        },
    },
    VerifyFn {
        file: "f2z-kt-core/src/witness.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::DelegatesToFn {
            target: "f2z-kt-core/src/sig.rs::verify",
            call: "sig::verify",
        },
    },
    // Counts cosignatures whose Ed25519 signatures `WitnessCosignature::verify`
    // — registered above — has already checked. `KT.md` §8.3's threshold is
    // arithmetic over verified statements, not a signature check of its own.
    VerifyFn {
        file: "f2z-kt-core/src/witness.rs",
        name: "verify_threshold",
        occurrence: 0,
        strictness: Strictness::NotASignatureCheck {
            via: "cosignature.verify",
        },
    },
    // `KT.md` §4.4 in full, and every signature inside it reaches `sig::verify`.
    VerifyFn {
        file: "f2z-kt-core/src/verify.rs",
        name: "verify_authorization",
        occurrence: 0,
        strictness: Strictness::NotASignatureCheck {
            via: "validate_submission",
        },
    },
    // `akd_core` proof verification against an already-witnessed root.
    VerifyFn {
        file: "f2z-kt-core/src/verify.rs",
        name: "verify_lookup",
        occurrence: 0,
        strictness: Strictness::NotASignatureCheck {
            via: "lookup_verify",
        },
    },
    VerifyFn {
        file: "f2z-kt-core/src/verify.rs",
        name: "verify_key_history",
        occurrence: 0,
        strictness: Strictness::NotASignatureCheck {
            via: "key_history_verify",
        },
    },
    // `KT.md` §7.1 step 4 — `akd`'s auditor, not a signature at all.
    VerifyFn {
        file: "f2z-kt-core/src/auditor.rs",
        name: "verify_append_only",
        occurrence: 0,
        strictness: Strictness::NotASignatureCheck {
            via: "audit_verify",
        },
    },
    // ---- f2z-kt ------------------------------------------------------------
    VerifyFn {
        file: "f2z-kt/src/policy.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::DelegatesToFn {
            target: "f2z-kt-core/src/sig.rs::verify",
            call: "sig::verify",
        },
    },
    VerifyFn {
        file: "f2z-kt/src/admit.rs",
        name: "verify_binding",
        occurrence: 0,
        strictness: Strictness::DelegatesToFn {
            target: "f2z-kt-core/src/sig.rs::verify",
            call: "sig::verify",
        },
    },
];

/// A flagged line: where it is, what it says, and which rule caught it.
struct Finding {
    file: String,
    line_number: usize,
    text: String,
    rule: String,
    line_index: usize,
}

impl Finding {
    fn render(&self) -> String {
        format!(
            "{}:{}: {} — {}",
            self.file,
            self.line_number,
            self.rule,
            self.text.trim()
        )
    }
}

/// Join a `use` item that spans several lines into one string, so a brace-list
/// import is scanned as the single statement it is.
///
/// Returns, for each `use` statement, the index of its first line and the
/// whole statement's code with comments and literals removed.
fn use_statements(source: &str) -> Vec<(usize, String)> {
    let lines = code_lines(source);
    let mut out = Vec::new();
    let mut index = 0usize;
    while index < lines.len() {
        let trimmed = lines[index].trim_start();
        if !(trimmed.starts_with("use ") || trimmed.starts_with("pub use ")) {
            index += 1;
            continue;
        }
        let start = index;
        let mut statement = String::new();
        while index < lines.len() {
            statement.push(' ');
            statement.push_str(lines[index].trim());
            index += 1;
            if statement.contains(';') {
                break;
            }
        }
        out.push((start, statement));
    }
    out
}

/// The local names under which `ed25519_dalek::VerifyingKey` is reachable in
/// this file: always the full path, plus whatever an import binds it to.
///
/// One level, like `workspace_debug_scan.rs`'s alias resolution: an alias of
/// an alias is not followed, and is stated rather than papered over. Rule 1
/// covers the residue — the call still needs the trait.
fn dalek_key_names(source: &str) -> Vec<String> {
    let mut names = vec!["ed25519_dalek::VerifyingKey".to_owned()];
    for (_, statement) in use_statements(source) {
        let Some(at) = statement.find("ed25519_dalek::VerifyingKey") else {
            continue;
        };
        let rest = &statement[at + "ed25519_dalek::VerifyingKey".len()..];
        let tail = rest.trim_start();
        if let Some(alias) = tail.strip_prefix("as ") {
            let bound = alias
                .trim()
                .split([',', ';', '}', ' '])
                .next()
                .unwrap_or_default();
            if !bound.is_empty() && bound != "_" {
                names.push(bound.to_owned());
            }
        } else {
            names.push("VerifyingKey".to_owned());
        }
    }
    names.sort();
    names.dedup();
    names
}

/// Receiver expressions in this file that are known to be an
/// `ed25519_dalek::VerifyingKey`: `let` bindings built from one, and struct
/// fields declared as one (reached as `self.<field>`, `self.0` for a
/// tuple struct).
fn dalek_receivers(source: &str) -> Vec<String> {
    let names = dalek_key_names(source);
    let mut receivers = Vec::new();
    for code in code_lines(source) {
        let trimmed = code.trim();
        let mentions_dalek_key = names.iter().any(|name| {
            if name.contains("::") {
                code.contains(name.as_str())
            } else {
                contains_identifier(&code, name)
            }
        });
        if !mentions_dalek_key {
            continue;
        }

        // `let raw = ed25519_dalek::VerifyingKey::from_bytes(..)` and
        // `let raw: ed25519_dalek::VerifyingKey = ..`.
        if let Some(rest) = trimmed.strip_prefix("let ") {
            let binding = rest
                .trim_start_matches("mut ")
                .split([':', ' ', '=', ';', ')'])
                .next()
                .unwrap_or_default()
                .trim();
            if !binding.is_empty() {
                receivers.push(binding.to_owned());
            }
            continue;
        }

        // A tuple struct's single field: `pub struct VerifyingKey(ed25519_dalek::VerifyingKey);`
        if trimmed.contains("struct ") && trimmed.contains('(') {
            receivers.push("self.0".to_owned());
            continue;
        }

        // A named field: `inner: ed25519_dalek::VerifyingKey,`
        if let Some((head, _)) = trimmed.split_once(':')
            && !head.contains('(')
            && !head.contains(' ')
            && !head.is_empty()
            && head.chars().all(common::is_identifier_char)
        {
            receivers.push(format!("self.{head}"));
        }
    }
    receivers.sort();
    receivers.dedup();
    receivers
}

/// Each physical line's code with any method chain it continues glued to the
/// front of it.
///
/// `rustfmt` breaks a chain across lines, so the wrapper's own call is written
///
/// ```text
/// self.0
///     .verify_strict(message, &signature)
/// ```
///
/// and the text `self.0.verify(` never appears in the file even when the call
/// is `self.0.verify(…)`. A receiver rule that matched physical lines would
/// therefore miss the exact mutation #589 demonstrated. The reported line
/// stays the physical one the call sits on, so a failure points at the code.
fn chained_lines(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut carry = String::new();
    for code in code_lines(source) {
        let trimmed = code.trim().to_owned();
        let logical = if trimmed.starts_with('.') {
            format!("{carry}{trimmed}")
        } else {
            trimmed
        };
        carry = logical.clone();
        out.push(logical);
    }
    out
}

/// Every non-strict Ed25519 finding in one file.
fn findings_in(label: &str, source: &str) -> Vec<Finding> {
    let mut findings = Vec::new();
    let lines: Vec<&str> = source.lines().collect();
    let projected = code_lines(source);

    let mut push = |line_index: usize, rule: String| {
        findings.push(Finding {
            file: label.to_owned(),
            line_number: line_index + 1,
            text: lines
                .get(line_index)
                .copied()
                .unwrap_or_default()
                .to_owned(),
            rule,
            line_index,
        });
    };

    // Rule 1a: the trait gate. The name may not appear in workspace source at
    // all — not in a `use`, not in a `<T as ed25519_dalek::Verifier<S>>::`
    // qualification, not in an `impl`. Naming the trait is the only thing that
    // makes the non-strict method callable, and a rule about the *name* rather
    // than about the `use` also covers the fully-qualified form, which needs
    // no import.
    for (index, code) in projected.iter().enumerate() {
        for trait_name in VERIFIER_TRAITS {
            if contains_identifier(code, trait_name) {
                push(
                    index,
                    format!(
                        "names the `{trait_name}` trait, which is the only thing that makes \
                         `ed25519_dalek`'s non-strict verification callable. Nothing in this \
                         workspace should need it outside a fixture"
                    ),
                );
            }
        }
    }

    // Rule 1b: a glob import that could carry one of those traits in without
    // naming it. Any `::*` whose path mentions ed25519 or signature counts,
    // rather than a fixed list of paths — `ed25519_dalek::*`,
    // `signature::prelude::*` and `ed25519_dalek::ed25519::signature::*` all
    // re-export the same trait, and enumerating re-export paths is a game the
    // scan would lose.
    for (at, statement) in use_statements(source) {
        if !statement.contains("::*") {
            continue;
        }
        let lowered = statement.to_ascii_lowercase();
        if lowered.contains("ed25519") || lowered.contains("signature") {
            push(
                at,
                "glob-imports a module that re-exports the `Verifier` trait, bringing \
                 non-strict Ed25519 verification into scope without naming it"
                    .to_owned(),
            );
        }
    }

    let receivers = dalek_receivers(source);
    let chained = chained_lines(source);
    for (index, code) in projected.iter().enumerate() {
        let logical = chained.get(index).cloned().unwrap_or_default();

        // Rule 2: entry points that need no trait import.
        for entry in NON_STRICT_ENTRY_POINTS {
            let called = identifier_positions(code, entry).any(|at| {
                let after = &code[at + entry.len()..];
                after.starts_with('(') || after.starts_with("::<")
            });
            if called {
                push(
                    index,
                    format!(
                        "calls `{entry}`, an Ed25519 entry point that does not screen \
                         small-order points"
                    ),
                );
            }
        }

        // Rule 3: a plain `verify` on something known to be a dalek key.
        for qualified in QUALIFIED_NON_STRICT_CALLS {
            // The chain is consulted for the receiver, but the finding is only
            // raised on the physical line the call is written on, so a chain
            // continuing past it is not reported a second time.
            if logical.contains(qualified) && code.contains("verify(") {
                push(
                    index,
                    format!("calls `{qualified}`, `ed25519_dalek`'s non-strict verification"),
                );
            }
        }
        for receiver in &receivers {
            if logical.contains(&format!("{receiver}.verify(")) && code.contains(".verify(") {
                push(
                    index,
                    format!(
                        "calls `.verify(` on `{receiver}`, which this file declares as an \
                         `ed25519_dalek::VerifyingKey`; that is the non-strict function. Use \
                         `verify_strict`"
                    ),
                );
            }
        }
    }

    findings
}

/// The body of `fn <name>` in `source`, from its declaration to the matching
/// close brace, with comments and literals removed.
fn function_body_at_line(source: &str, declaration_line: usize) -> Option<String> {
    let lines = code_lines(source);
    let declaration = declaration_line.checked_sub(1)?;
    let declaration_text = lines.get(declaration)?;
    assert!(
        declaration_text.contains("fn "),
        "line {declaration_line} is registered as a function declaration but is not one"
    );

    let mut body = String::new();
    let mut depth = 0i32;
    let mut opened = false;
    for line in lines.iter().skip(declaration) {
        body.push_str(line);
        body.push('\n');
        depth += i32::try_from(line.matches('{').count()).unwrap();
        depth -= i32::try_from(line.matches('}').count()).unwrap();
        if line.contains('{') {
            opened = true;
        }
        if opened && depth <= 0 {
            return Some(body);
        }
    }
    None
}

fn function_body(source: &str, name: &str) -> Option<String> {
    let declaration_line = verify_fn_definitions(source)
        .into_iter()
        .find(|(candidate, _, _)| candidate == name)
        .map(|(_, line, _)| line)?;
    function_body_at_line(source, declaration_line)
}

/// Every `fn verify…` defined in `source`, as `(name, line number)`, skipping
/// `#[test]` functions — a test named `verify_refuses_…` is not a verification
/// API and registering four of them would only teach a reader to ignore the
/// list.
fn verify_fn_definitions(source: &str) -> Vec<(String, usize, usize)> {
    let lines = code_lines(source);
    let mut out = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let Some(at) = line.find("fn ") else {
            continue;
        };
        let after = line[at + 3..].trim_start();
        if !after.starts_with("verify") {
            continue;
        }
        let name: String = after
            .chars()
            .take_while(|c| common::is_identifier_char(*c))
            .collect();
        if name == "verify" || name.starts_with("verify_") {
            let is_test = lines[..index]
                .iter()
                .rev()
                .take_while(|previous| {
                    let trimmed = previous.trim();
                    trimmed.is_empty() || trimmed.starts_with('#')
                })
                .any(|previous| previous.contains("#[test]"));
            if !is_test {
                let occurrence = out
                    .iter()
                    .filter(|(previous, _, _)| previous == &name)
                    .count();
                out.push((name, index + 1, occurrence));
            }
        }
    }
    out
}

fn registration_matches(entry: &VerifyFn, file: &str, name: &str, occurrence: usize) -> bool {
    entry.file == file && entry.name == name && entry.occurrence == occurrence
}

fn delegation_reaches_strict_base(mut target: &str, registry: &[VerifyFn]) -> bool {
    for _ in 0..registry.len() {
        let Some((target_file, target_name)) = target.rsplit_once("::") else {
            return false;
        };
        let mut matching = registry
            .iter()
            .filter(|entry| entry.file == target_file && entry.name == target_name);
        let Some(entry) = matching.next() else {
            return false;
        };
        // A delegation target names only file and function. If that pair has
        // multiple registered occurrences, choosing either one would let one
        // body vouch for another; ambiguity is therefore a refusal.
        if matching.next().is_some() {
            return false;
        }
        match entry.strictness {
            Strictness::CallsVerifyStrict { .. } => return true,
            Strictness::DelegatesTo {
                target: next_target,
                ..
            }
            | Strictness::DelegatesToFn {
                target: next_target,
                ..
            } => target = next_target,
            Strictness::NotASignatureCheck { .. } => return false,
        }
    }
    false
}

fn calls_method(body: &str, name: &str) -> bool {
    identifier_positions(body, name).any(|at| {
        let before = body[..at].trim_end();
        let after = body[at + name.len()..].trim_start();
        (before.ends_with('.') || before.ends_with("::"))
            && (after.starts_with('(') || after.starts_with("::<"))
    })
}

fn calls_method_on(body: &str, receiver: &str, name: &str) -> bool {
    identifier_positions(body, name).any(|at| {
        let before = body[..at].trim_end();
        let after = body[at + name.len()..].trim_start();
        let Some(before_dot) = before.strip_suffix('.') else {
            return false;
        };
        let before_dot = before_dot.trim_end();
        let Some(receiver_at) = before_dot.len().checked_sub(receiver.len()) else {
            return false;
        };
        identifier_positions(before_dot, receiver).any(|at| at == receiver_at)
            && (after.starts_with('(') || after.starts_with("::<"))
    })
}

/// Whether a registered verifier's body contains the exact call its registry
/// row promises. Both the live workspace audit and the wrong-receiver negative
/// controls go through this function, so the policy cannot quietly fall back
/// from receiver-specific matching to “somebody called a method with that
/// name.”
fn registered_body_has_required_call(strictness: &Strictness, body: &str) -> bool {
    match strictness {
        Strictness::CallsVerifyStrict { receiver } => {
            calls_method_on(body, receiver, "verify_strict")
        }
        Strictness::DelegatesTo {
            receiver, method, ..
        } => calls_method_on(body, receiver, method),
        Strictness::DelegatesToFn { call, .. } | Strictness::NotASignatureCheck { via: call } => {
            calls_path(body, call)
        }
    }
}

/// Whether `body` calls the free function at `path` — `sig::verify(…)`.
///
/// Held to the same standard as [`calls_method_on`]: the final segment must be
/// a real identifier followed by `(` or a turbofish, and the text immediately
/// before it must be the rest of the path. A comment or a same-named local
/// cannot satisfy it, which the negative controls below assert.
fn calls_path(body: &str, path: &str) -> bool {
    let (prefix, name) = match path.rsplit_once("::") {
        Some((prefix, name)) => (prefix, name),
        None => ("", path),
    };
    identifier_positions(body, name).any(|at| {
        let after = body[at + name.len()..].trim_start();
        if !(after.starts_with('(') || after.starts_with("::<")) {
            return false;
        }
        if prefix.is_empty() {
            return true;
        }
        let before = &body[..at];
        before.trim_end().ends_with(&format!("{prefix}::"))
    })
}

#[test]
fn a_free_function_call_is_matched_only_when_it_is_really_a_call() {
    assert!(calls_path("{ sig::verify(a, b, c) }", "sig::verify"));
    assert!(calls_path("{ sig::verify::<T>(a) }", "sig::verify"));
    assert!(calls_path(
        "{ audit_verify(hashes, proof) }",
        "audit_verify"
    ));
    // Not a call.
    assert!(!calls_path("{ let f = sig::verify; }", "sig::verify"));
    // The wrong path with the right final segment.
    assert!(!calls_path("{ other::verify(a) }", "sig::verify"));
    // A same-named local binding.
    assert!(!calls_path("{ let verify = 1; }", "sig::verify"));
}

#[test]
fn a_comment_or_unrelated_identifier_cannot_claim_strict_verification() {
    for fake in [
        "fn verify() -> Result<(), ()> { /* verify_strict */ Ok(()) }",
        "fn verify() { /* self.0.verify_strict(message, signature); */ Ok(()) }",
        "fn verify() -> Result<(), ()> { let verify_strict = (); let _ = verify_strict; Ok(()) }",
        "fn verify() { fn verify_strict() {} verify_strict(); }",
        "fn verify() { let _ = self.verify_strict; }",
    ] {
        let body = function_body(fake, "verify").unwrap();
        assert!(
            !calls_method(&body, "verify_strict"),
            "inert source text was mistaken for a strict-verification call: {fake}"
        );
    }
    let real = function_body(
        "fn verify() { self.0.verify_strict(message, signature); }",
        "verify",
    )
    .unwrap();
    assert!(calls_method(&real, "verify_strict"));
    assert!(calls_method_on(&real, "self.0", "verify_strict"));
    assert!(!calls_method_on(&real, "other", "verify_strict"));
    let wrong_receiver = function_body(
        "fn verify() { other.verify_strict(message, signature); }",
        "verify",
    )
    .unwrap();
    assert!(calls_method(&wrong_receiver, "verify_strict"));
    assert!(!calls_method_on(&wrong_receiver, "self.0", "verify_strict"));
    let field = function_body("fn verify() { let _ = self.0.verify_strict; }", "verify").unwrap();
    assert!(!calls_method_on(&field, "self.0", "verify_strict"));
}

#[test]
fn the_live_registry_contract_rejects_the_right_method_on_the_wrong_receiver() {
    let strict = Strictness::CallsVerifyStrict { receiver: "self.0" };
    let strict_body = function_body(
        "fn verify() { self.0.verify_strict(message, signature); }",
        "verify",
    )
    .unwrap();
    let wrong_strict_receiver = function_body(
        "fn verify() { other.verify_strict(message, signature); }",
        "verify",
    )
    .unwrap();
    assert!(registered_body_has_required_call(&strict, &strict_body));
    assert!(!registered_body_has_required_call(
        &strict,
        &wrong_strict_receiver
    ));

    let delegated = Strictness::DelegatesTo {
        target: "f2z-authority/src/key.rs::verify",
        receiver: "identity_key",
        method: "verify",
    };
    let delegated_body = function_body(
        "fn verify_binding() { identity_key.verify(message, signature); }",
        "verify_binding",
    )
    .unwrap();
    let wrong_delegate_receiver = function_body(
        "fn verify_binding() { other.verify(message, signature); }",
        "verify_binding",
    )
    .unwrap();
    assert!(registered_body_has_required_call(
        &delegated,
        &delegated_body
    ));
    assert!(!registered_body_has_required_call(
        &delegated,
        &wrong_delegate_receiver
    ));
}

#[test]
fn duplicate_verify_definitions_cannot_share_one_registry_row() {
    let source = "
        impl First { fn verify(&self) { self.0.verify_strict(message, signature); } }
        impl Second { fn verify(&self) -> Result<(), ()> { Ok(()) } }
    ";
    let definitions = verify_fn_definitions(source);
    assert_eq!(
        definitions,
        vec![("verify".to_owned(), 2, 0), ("verify".to_owned(), 3, 1)]
    );
    let registered = VerifyFn {
        file: "fixture/src/key.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::CallsVerifyStrict { receiver: "self.0" },
    };
    assert!(registration_matches(
        &registered,
        "fixture/src/key.rs",
        "verify",
        0
    ));
    assert!(!registration_matches(
        &registered,
        "fixture/src/key.rs",
        "verify",
        1
    ));
    let second_body = function_body_at_line(source, definitions[1].1).unwrap();
    assert!(!registered_body_has_required_call(
        &registered.strictness,
        &second_body
    ));
}

#[test]
fn a_delegation_chain_that_terminates_in_strict_verification_is_accepted() {
    let registry = [
        VerifyFn {
            file: "fixture/src/wrapper.rs",
            name: "verify",
            occurrence: 0,
            strictness: Strictness::DelegatesTo {
                target: "fixture/src/middle.rs::verify",
                receiver: "middle",
                method: "verify",
            },
        },
        VerifyFn {
            file: "fixture/src/middle.rs",
            name: "verify",
            occurrence: 0,
            strictness: Strictness::DelegatesToFn {
                target: "fixture/src/base.rs::verify",
                call: "base::verify",
            },
        },
        VerifyFn {
            file: "fixture/src/base.rs",
            name: "verify",
            occurrence: 0,
            strictness: Strictness::CallsVerifyStrict { receiver: "key" },
        },
    ];

    assert!(delegation_reaches_strict_base(
        "fixture/src/wrapper.rs::verify",
        &registry,
    ));
}

#[test]
fn a_delegation_chain_that_terminates_in_a_nonsignature_check_is_refused() {
    let registry = [VerifyFn {
        file: "fixture/src/proof.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::NotASignatureCheck {
            via: "proof.verify",
        },
    }];

    assert!(!delegation_reaches_strict_base(
        "fixture/src/proof.rs::verify",
        &registry,
    ));
}

#[test]
fn a_delegation_target_in_an_unregistered_file_is_refused() {
    let registry = [VerifyFn {
        file: "fixture/src/base.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::CallsVerifyStrict { receiver: "key" },
    }];

    assert!(!delegation_reaches_strict_base(
        "fixture/src/missing.rs::verify",
        &registry,
    ));
}

#[test]
fn an_unregistered_function_in_a_registered_file_is_refused() {
    let registry = [VerifyFn {
        file: "fixture/src/base.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::CallsVerifyStrict { receiver: "key" },
    }];

    assert!(!delegation_reaches_strict_base(
        "fixture/src/base.rs::verify_missing",
        &registry,
    ));
}

#[test]
fn a_delegation_target_with_multiple_registered_occurrences_is_refused() {
    let registry = [
        VerifyFn {
            file: "fixture/src/base.rs",
            name: "verify",
            occurrence: 0,
            strictness: Strictness::CallsVerifyStrict { receiver: "key" },
        },
        VerifyFn {
            file: "fixture/src/base.rs",
            name: "verify",
            occurrence: 1,
            strictness: Strictness::NotASignatureCheck {
                via: "proof.verify",
            },
        },
    ];

    assert!(!delegation_reaches_strict_base(
        "fixture/src/base.rs::verify",
        &registry,
    ));
}

#[test]
fn a_malformed_delegation_target_is_refused() {
    let registry = [VerifyFn {
        file: "fixture/src/base.rs",
        name: "verify",
        occurrence: 0,
        strictness: Strictness::CallsVerifyStrict { receiver: "key" },
    }];

    assert!(!delegation_reaches_strict_base(
        "not-a-file-and-function",
        &registry,
    ));
}

#[test]
fn a_mixed_delegation_cycle_is_refused() {
    let registry = [
        VerifyFn {
            file: "fixture/src/cycle-a.rs",
            name: "verify",
            occurrence: 0,
            strictness: Strictness::DelegatesTo {
                target: "fixture/src/cycle-b.rs::verify",
                receiver: "cycle_b",
                method: "verify",
            },
        },
        VerifyFn {
            file: "fixture/src/cycle-b.rs",
            name: "verify",
            occurrence: 0,
            strictness: Strictness::DelegatesToFn {
                target: "fixture/src/cycle-a.rs::verify",
                call: "cycle_a::verify",
            },
        },
    ];

    assert!(!delegation_reaches_strict_base(
        "fixture/src/cycle-a.rs::verify",
        &registry,
    ));
}

#[test]
fn no_crate_verifies_ed25519_signatures_non_strictly() {
    let sources = source_files();
    let mut crates_reached: Vec<String> = Vec::new();
    let mut violations: Vec<String> = Vec::new();
    let mut matched_registrations = vec![false; REGISTERED_NON_STRICT.len()];

    for file in &sources {
        if !crates_reached.contains(&file.krate) {
            crates_reached.push(file.krate.clone());
        }
        let test_ranges = cfg_test_ranges(&file.source);
        for finding in findings_in(&file.label, &file.source) {
            let registered = REGISTERED_NON_STRICT
                .iter()
                .position(|entry| entry.file == finding.file && finding.text.contains(entry.line));
            match registered {
                Some(at) => {
                    matched_registrations[at] = true;
                    assert!(
                        in_cfg_test(&test_ranges, finding.line_index),
                        "{}:{} is registered in REGISTERED_NON_STRICT but no longer sits \
                         inside a #[cfg(test)] item. A deliberate non-strict verification is \
                         only defensible as a fixture; this one now compiles into the crate.",
                        finding.file,
                        finding.line_number
                    );
                }
                None => violations.push(finding.render()),
            }
        }
    }

    // The coverage anchor, and the reason #597 gave this shape a name: a crate
    // added under `rs/crates/` must be *reached*, not merely listed. The
    // failure it replaces was a scan that quietly stopped at one crate's
    // boundary while still passing.
    let mut expected = workspace_crates();
    expected.sort();
    crates_reached.sort();
    assert_eq!(
        crates_reached, expected,
        "the scan did not reach every crate under rs/crates/. A crate outside it is a crate \
         where a non-strict Ed25519 verification goes unnoticed — which is #603 exactly."
    );

    // The detection anchor. A scanner that silently matched nothing would pass
    // forever, and the tree contains one call it is known to be able to see.
    for (index, entry) in REGISTERED_NON_STRICT.iter().enumerate() {
        assert!(
            matched_registrations[index],
            "REGISTERED_NON_STRICT names `{}` in {} but the scan did not flag it. It is \
             registered because {}. Either that fixture is gone — in which case nothing is \
             testing the distinction any more — or this scanner has stopped recognising a \
             non-strict call.",
            entry.line, entry.file, entry.why
        );
    }

    assert!(
        violations.is_empty(),
        "non-strict Ed25519 verification in the rs/ workspace. Plain `verify` accepts a \
         signature under the identity point for *every* message; `verify_strict` rejects it. \
         Use `verify_strict`, or register a test-only fixture in REGISTERED_NON_STRICT with \
         a reason:\n  {}",
        violations.join("\n  ")
    );
}

#[test]
fn every_verify_function_in_the_workspace_is_registered_as_strict() {
    let sources = source_files();
    let mut crates_reached: Vec<String> = Vec::new();
    let mut found: Vec<(String, String, usize, usize)> = Vec::new();

    for file in &sources {
        if !crates_reached.contains(&file.krate) {
            crates_reached.push(file.krate.clone());
        }
        for (name, line, occurrence) in verify_fn_definitions(&file.source) {
            found.push((file.label.clone(), name, line, occurrence));
        }
    }

    let mut expected = workspace_crates();
    expected.sort();
    crates_reached.sort();
    assert_eq!(
        crates_reached, expected,
        "the registry census did not reach every crate under rs/crates/, so a crate could \
         define an unregistered `verify` without this failing."
    );

    // Every definition must be registered …
    let unregistered: Vec<String> = found
        .iter()
        .filter(|(file, name, _, occurrence)| {
            !WORKSPACE_VERIFY_FNS
                .iter()
                .any(|entry| registration_matches(entry, file, name, *occurrence))
        })
        .map(|(file, name, line, occurrence)| {
            format!("{file}:{line}: fn {name} (occurrence {occurrence})")
        })
        .collect();
    assert!(
        unregistered.is_empty(),
        "these verification functions are not registered in WORKSPACE_VERIFY_FNS, so nothing \
         says what makes them strict:\n  {}",
        unregistered.join("\n  ")
    );

    // … and every registration must still exist, so the list cannot be
    // narrowed to whatever still passes.
    let missing: Vec<String> = WORKSPACE_VERIFY_FNS
        .iter()
        .filter(|entry| {
            !found.iter().any(|(file, name, _, occurrence)| {
                registration_matches(entry, file, name, *occurrence)
            })
        })
        .map(|entry| format!("{}::{}#{}", entry.file, entry.name, entry.occurrence))
        .collect();
    assert!(
        missing.is_empty(),
        "WORKSPACE_VERIFY_FNS registers functions that no longer exist, so the registry has \
         drifted from the source it is supposed to describe:\n  {}",
        missing.join("\n  ")
    );

    // The bottom of every delegation chain is checked against the source.
    for entry in WORKSPACE_VERIFY_FNS {
        let file = sources
            .iter()
            .find(|source| source.label == entry.file)
            .unwrap_or_else(|| panic!("{} is registered but was not walked", entry.file));
        let declaration_line = found
            .iter()
            .find(|(found_file, name, _, occurrence)| {
                registration_matches(entry, found_file, name, *occurrence)
            })
            .map(|(_, _, line, _)| *line)
            .unwrap_or_else(|| {
                panic!(
                    "{}::{}#{} is registered but its definition was not found",
                    entry.file, entry.name, entry.occurrence
                )
            });
        let body = function_body_at_line(&file.source, declaration_line).unwrap_or_else(|| {
            panic!(
                "could not read the body of {}::{}#{} at line {declaration_line}; this scanner has stopped parsing the source",
                entry.file, entry.name, entry.occurrence
            )
        });
        match entry.strictness {
            Strictness::CallsVerifyStrict { .. } => {
                assert!(
                    registered_body_has_required_call(&entry.strictness, &body),
                    "{}::{} is registered as calling `verify_strict` and its body no longer \
                     does. Every other verification in this workspace delegates to it, so this \
                     is a universal forgery away from `admit`-style authorization returning Ok \
                     for a key nobody holds. See #589, #597, #603.",
                    entry.file,
                    entry.name
                );
            }
            Strictness::DelegatesTo { target, .. } => {
                assert!(
                    delegation_reaches_strict_base(target, WORKSPACE_VERIFY_FNS),
                    "{}::{} delegates to {target}, whose registered chain does not terminate in \
                     a strict verifier",
                    entry.file,
                    entry.name
                );
                assert!(
                    registered_body_has_required_call(&entry.strictness, &body),
                    "{}::{} is registered as delegating to {target} and its body contains no \
                     call to it, so the registration describes something that is not there.",
                    entry.file,
                    entry.name
                );
            }
            Strictness::DelegatesToFn { target, call } => {
                let (target_file, target_name) = target.rsplit_once("::").unwrap();
                assert!(
                    WORKSPACE_VERIFY_FNS
                        .iter()
                        .any(|other| other.file == target_file
                            && other.name == target_name
                            && matches!(other.strictness, Strictness::CallsVerifyStrict { .. })),
                    "{}::{} delegates to {target}, which is not registered as a strict \
                     verifier",
                    entry.file,
                    entry.name
                );
                assert!(
                    registered_body_has_required_call(&entry.strictness, &body),
                    "{}::{} is registered as calling `{call}` and its body does not, so the \
                     registration describes something that is not there.",
                    entry.file,
                    entry.name
                );
            }
            Strictness::NotASignatureCheck { via } => {
                assert!(
                    registered_body_has_required_call(&entry.strictness, &body),
                    "{}::{} is registered as verifying something that is not an Ed25519 \
                     signature, via `{via}`, and its body no longer calls it — so the row is \
                     now an unexplained exemption rather than a described one.",
                    entry.file,
                    entry.name
                );
            }
        }
    }

    assert!(
        found.len() >= WORKSPACE_VERIFY_FNS.len(),
        "the scanner found {} verification functions, fewer than the {} registered; it is no \
         longer reading the source",
        found.len(),
        WORKSPACE_VERIFY_FNS.len()
    );
}

#[test]
fn the_crates_own_strict_wrapper_is_not_mistaken_for_ed25519_dalek() {
    let sources = source_files();
    for (label, needle) in SAFE_WRAPPER_CALL_SITES {
        let file = sources
            .iter()
            .find(|source| source.label == *label)
            .unwrap_or_else(|| panic!("{label} is a registered safe call site but was not walked"));
        assert!(
            file.source.contains(needle),
            "{label} no longer contains `{needle}`, so this negative control proves nothing. \
             Either the call moved — repoint the control — or the strict wrapper is no longer \
             used there, which is the thing to look at."
        );
        let findings = findings_in(&file.label, &file.source);
        assert!(
            findings.is_empty(),
            "{label} calls this workspace's own strict wrapper and the scan flagged it \
             anyway. A check that cries wolf on correct code gets deleted:\n  {}",
            findings
                .iter()
                .map(Finding::render)
                .collect::<Vec<_>>()
                .join("\n  ")
        );
    }
}
