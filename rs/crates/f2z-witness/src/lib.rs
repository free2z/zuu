//! **The free2z key-transparency cosigning daemon** — `docs/e2ee/KT.md` §7.
//!
//! # What a witness is for
//!
//! A log that equivocates shows one root to Alice and another to Bob, and every
//! proof it serves either of them verifies perfectly. Nothing inside the
//! cryptography catches that, because nothing inside the cryptography can see
//! both halves. A witness can: it follows **one** log, remembers what it was
//! shown, and signs a statement of the form *"witness W says the log with id L
//! had root R at epoch E with size S."*
//!
//! Two such statements with the same `(log_id, epoch)` and different
//! `(tree_size, root_hash)` are a contradiction on their face, checkable from
//! the cosignature bytes and W's public key alone, with no help from the party
//! under suspicion.
//!
//! # The one thing that makes it worth running
//!
//! §7.4: **a witness that does not verify the append-only proof is worthless.**
//! Verifying the signature attests to something the log's own signature already
//! proved. Verifying monotonicity catches a log that contradicts itself *in the
//! stream this witness was shown* — which a log maintaining two internally
//! consistent branches passes every time. Only `audit_verify` establishes that
//! the new root **extends** the old one rather than replacing part of it, and
//! it is the only check that catches the attack in [facebook/akd#495], where a
//! value is rewritten under a proof that still verifies.
//!
//! `KT.md` §7.4's structural defence is that the log and the witness link the
//! **same** verifier, at the same pinned version, so "cosign without verifying"
//! takes deleting a call rather than forgetting one. That is why this crate
//! depends on `f2z-kt-core` with its `auditor` feature and never reimplements
//! anything: [`witness::Witness::poll_once`] cannot reach a signature without
//! first holding an [`f2z_kt_core::auditor::AppendOnlyVerified`], which has no
//! public constructor.
//!
//! # The deployment shape, and why it is this shape
//!
//! §9.3 and §2: **no inbound port, no TLS certificate, no domain, no
//! database.** State is one file, replaced atomically. That is not minimalism
//! for its own sake — it is what makes running a witness cheap enough that the
//! set can be *independent*, which is the only real mitigation for
//! [`THREAT-MODEL.md` §3.9]'s malicious witness. A witness that needed a
//! certificate and a database would be run by the same three organisations that
//! already run everything.
//!
//! It is also why `f2z-witness healthz` exists as a **subcommand**: the
//! deployment image is distroless, so there is no shell, no `wget` and no
//! `curl`, and there is no listener to dial. An `exec` probe running this
//! binary is the only workable shape, and it reads the state file rather than
//! pinging anything.
//!
//! # `audit_verify` and wasm
//!
//! `akd::auditor::audit_verify` compiles for `wasm32-unknown-unknown` and then
//! traps at runtime, because `verify_append_only_hash` hardcodes
//! `AzksParallelismConfig::default()` and reaches `tokio::task::spawn`
//! (`KT.md` §11.3, zuu#544). **This daemon is native and that is fine here** —
//! but nothing in this crate may ever be built for wasm, and nothing that is
//! wasm-bound may ever depend on it.
//!
//! [facebook/akd#495]: https://github.com/facebook/akd/pull/495
//! [`THREAT-MODEL.md` §3.9]: https://github.com/free2z/zuu/blob/main/docs/e2ee/THREAT-MODEL.md

#![forbid(unsafe_code)]
// Unit tests are host code read by a person looking at a failure. The workspace
// denies these families because a panic on the unauthenticated path is a remote
// denial of service; a `.unwrap()` in a test is a failing test, which is the
// point of one. Same shape as `f2z-kt-core`.
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::expect_used,
        clippy::panic,
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects
    )
)]

pub mod error;
pub mod evidence;
pub mod health;
pub mod state;
pub mod transport;
pub mod witness;

pub use error::{Result, WitnessError};
pub use evidence::Evidence;
pub use state::WitnessState;
pub use transport::{HttpTransport, Transport};
pub use witness::{Outcome, Settings, Witness};

/// The wall clock, in milliseconds since the Unix epoch.
///
/// The only place this process reads a clock. `observed_at_ms` is the one field
/// it ends up in, and §7.2 excludes that field from the contradiction test on
/// purpose: two cosignatures over the same root at different times are normal,
/// not a conflict.
#[must_use]
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

/// Lowercase base16, for operator output.
///
/// Twenty lines rather than a dependency, for the reason `f2z-kt` gives: this
/// runs on operator input on the startup path of a security-critical binary.
#[must_use]
pub fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().saturating_mul(2));
    for byte in bytes {
        out.push(nibble(byte >> 4));
        out.push(nibble(byte & 0x0f));
    }
    out
}

/// Decode lowercase or uppercase base16 into a fixed-size array.
#[must_use]
pub fn unhex<const N: usize>(text: &str) -> Option<[u8; N]> {
    let bytes = text.trim().as_bytes();
    if bytes.len() != N.saturating_mul(2) {
        return None;
    }
    let mut out = [0u8; N];
    for (index, pair) in bytes.chunks_exact(2).enumerate() {
        let hi = value(pair.first().copied()?)?;
        let lo = value(pair.get(1).copied()?)?;
        *out.get_mut(index)? = (hi << 4) | lo;
    }
    Some(out)
}

/// The base16 alphabet, written out rather than computed.
///
/// `b'0' + value` is what this would ordinarily be, and the workspace denies
/// `arithmetic_side_effects` for a good reason: that family of bugs is exactly
/// the family that turns a parser on an unauthenticated path into a remote
/// denial of service. Sixteen arms have no such family, stay `const`, and need
/// no indexing — which the workspace also denies.
const fn nibble(value: u8) -> char {
    match value & 0x0f {
        0 => '0',
        1 => '1',
        2 => '2',
        3 => '3',
        4 => '4',
        5 => '5',
        6 => '6',
        7 => '7',
        8 => '8',
        9 => '9',
        10 => 'a',
        11 => 'b',
        12 => 'c',
        13 => 'd',
        14 => 'e',
        _ => 'f',
    }
}

const fn value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => byte.checked_sub(b'0'),
        b'a'..=b'f' => match byte.checked_sub(b'a') {
            Some(offset) => offset.checked_add(10),
            None => None,
        },
        b'A'..=b'F' => match byte.checked_sub(b'A') {
            Some(offset) => offset.checked_add(10),
            None => None,
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{hex, unhex};

    #[test]
    fn hex_round_trips_and_refuses_the_wrong_length() {
        assert_eq!(hex(&[0x00, 0xff, 0xa5]), "00ffa5");
        assert_eq!(unhex::<3>("00FFA5"), Some([0x00, 0xff, 0xa5]));
        assert_eq!(unhex::<32>("00ff"), None);
        assert_eq!(unhex::<2>("zzzz"), None);
    }
}
