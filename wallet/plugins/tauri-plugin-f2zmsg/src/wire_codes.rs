//! `CLIENT-CONTRACT.md` §8.1 — the wire-code mapping, in full.
//!
//! The bridge does this translation and the frontend never sees a number. It is
//! tabulated exhaustively because "closed" is only a real property if every
//! code has a target: a union that quietly drops six codes into the
//! nearest-looking member is how a wrong device clock ends up rendered as a
//! relay defect.
//!
//! Two rules govern everything below.
//!
//! **The default rule.** A code neither table names — from a protocol version
//! newer than this client, or a known code returned in a context these tables
//! do not give it — maps to `relay-protocol-violation` if a relay returned it
//! and `directory-protocol-violation` if the log did. It is **never** mapped to
//! `internal`, which means *our own engine* faulted, and it is never dropped.
//! That is what "closed" buys a frontend: the set of values a component can
//! receive is fixed, so a protocol that grows a code produces a defect report
//! instead of an `undefined` branch.
//!
//! **What is deliberately absent.** `directory-proof-invalid`,
//! `witness-threshold-unmet`, `relay-identity-mismatch`, `relay-unreachable`,
//! `relay-refused-insecure`, `handle-ineligible` and the whole local group are
//! **client-side outcomes, not wire codes**: the client computes them and no
//! server sends them. Keeping them out of the mapping is the point — a code a
//! relay or a log chooses can never, on its own, produce one of the codes that
//! mean an attack.

use f2z_codec::ErrorCode as WireCode;
use f2z_relay_proto::{ProtoError, Refusal};

use crate::models::ErrorCode;

/// Which side of a signed command a refusal arrived on.
///
/// It is a parameter because §8.1 maps two wire codes differently depending on
/// it, and both differences are load-bearing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommandSide {
    /// A command signed by the **send-side** queue key: `BIND_SEND`, `APPEND`.
    Send,
    /// A command signed by the **receive-side** queue key: `CREATE_QUEUE`,
    /// `SUBSCRIBE`, `READ`, `ACK`, `DELETE_QUEUE` — or an unsigned one.
    Receive,
}

/// Whether this is the first bind for an address the peer has just advertised.
///
/// `ERR_ALREADY_BOUND` on a *first* bind means a relay operator took the write
/// capability (`WIRE.md` §7.4) and is fatal, loud and non-dismissible. On any
/// later bind it means we should not have tried, which is our own bug.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BindAttempt {
    FirstForFreshAdvert,
    Later,
}

/// `WIRE.md` §10 → [`ErrorCode`].
///
/// `attempt` is only consulted for `ERR_ALREADY_BOUND`; callers that are not
/// binding pass [`BindAttempt::Later`], which is the safe reading — it blames
/// the client rather than accusing an operator of theft.
#[must_use]
pub fn from_relay(code: WireCode, side: CommandSide, attempt: BindAttempt) -> ErrorCode {
    match code {
        // 1, 3, 5, 6 — a malformed frame, an unknown frame type, an unknown
        // command or a bad signature is a bug in one of the two
        // implementations. Never silently retried.
        WireCode::Malformed | WireCode::FrameType | WireCode::UnknownCommand => {
            ErrorCode::RelayProtocolViolation
        }
        WireCode::BadSignature => ErrorCode::RelayProtocolViolation,
        // 2
        WireCode::UnsupportedVersion => ErrorCode::RelayVersionUnsupported,
        // 4, 18 — the relay refusing new writes rather than deleting un-acked
        // ones, which is the correct failure mode.
        WireCode::TooManyInflight | WireCode::Backpressure => ErrorCode::RelayBackpressure,
        // 7 — THIS DEVICE'S clock is wrong, not the relay's. Never a defect
        // report against the relay, and never a reason to set a system clock
        // from a relay-supplied time.
        WireCode::StaleTimestamp => ErrorCode::DeviceClockSkew,
        // 8 — a repeated `(signer_key, nonce)` is our CSPRNG's fault.
        WireCode::Replay => ErrorCode::RelayProtocolViolation,
        // 9 — reserved and unused in v1, so receiving it *is* the violation.
        WireCode::ChannelBinding => ErrorCode::RelayProtocolViolation,
        // 10 — see the note in §8.1. Mapping both `ERR_NO_ACCESS` and
        // `ERR_UNAVAILABLE` to `send-unavailable` on the send side makes the
        // client behave identically whichever way #550 lands, and is
        // independently what §10's existence-oracle rule wants.
        WireCode::NoAccess => match side {
            CommandSide::Send => ErrorCode::SendUnavailable,
            CommandSide::Receive => ErrorCode::RelayProtocolViolation,
        },
        // 11
        WireCode::AlreadyBound => match attempt {
            BindAttempt::FirstForFreshAdvert => ErrorCode::SendAddressStolen,
            BindAttempt::Later => ErrorCode::RelayProtocolViolation,
        },
        // 12 — our emitted size is not in the relay's `padding_sizes`.
        WireCode::BadSize => ErrorCode::RelayCapabilityMismatch,
        // 13 — an ACK past the head is a client bug.
        WireCode::AckTooHigh => ErrorCode::RelayProtocolViolation,
        // 14
        WireCode::Quota => ErrorCode::RelayQuota,
        // 15
        WireCode::Unavailable => ErrorCode::SendUnavailable,
        // 16, 17
        WireCode::PowRequired => ErrorCode::PowRequired,
        WireCode::PowInvalid => ErrorCode::PowFailed,
        // 19
        WireCode::RateLimited => ErrorCode::RelayRateLimited,
        // 20 — the wrong command for this queue kind is a client bug.
        WireCode::NotPermitted => ErrorCode::RelayProtocolViolation,
        // 21
        WireCode::Internal => ErrorCode::Internal,
        // §8.1's default rule. `f2z_codec::ErrorCode` is `#[non_exhaustive]`,
        // so a code from a protocol version newer than this build arrives here.
        // It is a relay's code, so it becomes `relay-protocol-violation` — never
        // `internal`, which means our own engine faulted, and never dropped.
        _ => ErrorCode::RelayProtocolViolation,
    }
}

/// `KT.md` §9.5 → [`ErrorCode`], by wire number.
///
/// Taken by number rather than by a typed enum because the log's codes reach
/// this client as an integer in a JSON body, and because §8.1's default rule is
/// about numbers this build has never heard of.
///
/// Deliberately **not** `directory-proof-invalid` for any of them: that one is a
/// *cryptographic* failure and is fork evidence, and collapsing the two would
/// turn every one of our own encoding bugs into an accusation.
#[must_use]
pub const fn from_directory(code: u16) -> ErrorCode {
    match code {
        // 1, 2, 3, 4, 8, 10 — malformed, unsupported, a signature or
        // authorization the log rejected, an over-wide range, or a witness-only
        // endpoint a client never calls.
        1 | 2 | 3 | 4 | 8 | 10 => ErrorCode::DirectoryProtocolViolation,
        5 => ErrorCode::DirectoryVersionConflict,
        6 => ErrorCode::DirectoryCooldown,
        7 => ErrorCode::DirectoryEpochUnavailable,
        9 => ErrorCode::DirectoryRateLimited,
        11 => ErrorCode::Internal,
        // §8.1's default rule for the log.
        _ => ErrorCode::DirectoryProtocolViolation,
    }
}

/// A client-side refusal of a relay (`WIRE.md` §11.3, §2.5, §5.2) → [`ErrorCode`].
///
/// None of these is a wire code: the client computed every one of them, which
/// is why they are in a separate function from [`from_relay`] rather than folded
/// into it. Two are attack indicators and must never be retried automatically.
#[must_use]
pub const fn from_refusal(refusal: Refusal) -> ErrorCode {
    match refusal {
        // §5.2's substituted relay. Fatal and loud: raise an alarm, stop using
        // this relay for this conversation, do not retry against it.
        Refusal::RelayIdMismatch
        | Refusal::RelayIdNotDerived
        | Refusal::RelayProofInvalid
        | Refusal::RelayKeyInvalid => ErrorCode::RelayIdentityMismatch,
        // §2.3's insecure-transport opt-in, not yet given for this relay.
        Refusal::InsecureTransport => ErrorCode::RelayRefusedInsecure,
        // Everything else is the relay's published document disagreeing with
        // what it must be: a capability mismatch, refused rather than degraded
        // into a warning banner (§3.11).
        _ => ErrorCode::RelayCapabilityMismatch,
    }
}

/// The whole of [`ProtoError`], mapped.
#[must_use]
pub fn from_proto(error: ProtoError, side: CommandSide, attempt: BindAttempt) -> ErrorCode {
    match error {
        ProtoError::Wire(code) => from_relay(code, side, attempt),
        ProtoError::Refused(refusal) => from_refusal(refusal),
        // §8.1's default rule: a status this build does not know, from a
        // relay — and, because `ProtoError` is `#[non_exhaustive]`, any variant
        // a newer `f2z-relay-proto` adds.
        ProtoError::UnknownStatus(_) => ErrorCode::RelayProtocolViolation,
        // And, because `ProtoError` is `#[non_exhaustive]`, any variant a newer
        // `f2z-relay-proto` adds. Same rule, same reason.
        _ => ErrorCode::RelayProtocolViolation,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_wire_code_has_a_target_on_both_sides() {
        // "Closed" is only real if the mapping is total. This is the assertion
        // that makes the word honest.
        for code in WireCode::ALL {
            for side in [CommandSide::Send, CommandSide::Receive] {
                for attempt in [BindAttempt::FirstForFreshAdvert, BindAttempt::Later] {
                    let mapped = from_relay(code, side, attempt);
                    assert!(
                        ErrorCode::ALL.contains(&mapped),
                        "{code:?} on {side:?}/{attempt:?} left the union"
                    );
                }
            }
        }
    }

    #[test]
    fn a_stale_timestamp_blames_this_device_and_not_the_relay() {
        // §8.1's most consequential single row: `ERR_STALE_TIMESTAMP` means our
        // clock is wrong. Rendering it as a relay defect would send the user
        // chasing a relay that is behaving correctly.
        assert_eq!(
            from_relay(
                WireCode::StaleTimestamp,
                CommandSide::Send,
                BindAttempt::Later
            ),
            ErrorCode::DeviceClockSkew
        );
    }

    #[test]
    fn no_access_and_unavailable_are_indistinguishable_on_the_send_side() {
        // The #550 hedge. Whichever way the open question lands, the user sees
        // the same thing, which is what §10's existence-oracle rule wants.
        assert_eq!(
            from_relay(WireCode::NoAccess, CommandSide::Send, BindAttempt::Later),
            from_relay(WireCode::Unavailable, CommandSide::Send, BindAttempt::Later)
        );
        assert_eq!(
            from_relay(WireCode::NoAccess, CommandSide::Send, BindAttempt::Later),
            ErrorCode::SendUnavailable
        );
    }

    #[test]
    fn a_stolen_send_address_is_only_claimed_on_a_first_bind() {
        assert_eq!(
            from_relay(
                WireCode::AlreadyBound,
                CommandSide::Send,
                BindAttempt::FirstForFreshAdvert
            ),
            ErrorCode::SendAddressStolen
        );
        assert_eq!(
            from_relay(
                WireCode::AlreadyBound,
                CommandSide::Send,
                BindAttempt::Later
            ),
            ErrorCode::RelayProtocolViolation
        );
    }

    #[test]
    fn a_code_no_table_names_is_a_protocol_violation_and_never_internal() {
        assert_eq!(from_directory(9999), ErrorCode::DirectoryProtocolViolation);
        assert_eq!(
            from_proto(
                ProtoError::UnknownStatus(9999),
                CommandSide::Receive,
                BindAttempt::Later
            ),
            ErrorCode::RelayProtocolViolation
        );
    }

    #[test]
    fn only_the_relays_own_faults_map_to_internal() {
        // `internal` means OUR engine faulted, so exactly one wire code on each
        // side may reach it: the peer reporting its own fault.
        let internal: Vec<WireCode> = WireCode::ALL
            .into_iter()
            .filter(|code| {
                from_relay(*code, CommandSide::Receive, BindAttempt::Later) == ErrorCode::Internal
            })
            .collect();
        assert_eq!(internal, vec![WireCode::Internal]);
    }

    #[test]
    fn a_substituted_relay_is_never_a_capability_warning() {
        for refusal in [
            Refusal::RelayIdMismatch,
            Refusal::RelayIdNotDerived,
            Refusal::RelayProofInvalid,
            Refusal::RelayKeyInvalid,
        ] {
            assert_eq!(from_refusal(refusal), ErrorCode::RelayIdentityMismatch);
        }
    }

    #[test]
    fn the_directory_table_never_produces_proof_invalid() {
        // Fork evidence is computed by the client's verifier, never chosen by
        // the log. A log that could name it could accuse itself out of trouble.
        for code in 0u16..=32 {
            assert_ne!(from_directory(code), ErrorCode::DirectoryProofInvalid);
        }
    }
}
