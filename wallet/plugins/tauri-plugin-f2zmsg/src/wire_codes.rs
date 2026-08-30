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
use f2z_codec::commands::Command;
use f2z_relay_proto::{ProtoError, Refusal};

use crate::models::ErrorCode;

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
/// `command` is the exact command whose response carried the code. A known
/// code in any context `WIRE.md` does not give it follows §8.1's default rule
/// and becomes `relay-protocol-violation`. `attempt` is valid only for
/// `BIND_SEND`; callers cannot turn a response to another command into a theft
/// alarm by labelling it a first bind.
#[must_use]
pub fn from_relay(code: WireCode, command: Command, attempt: BindAttempt) -> ErrorCode {
    if matches!(attempt, BindAttempt::FirstForFreshAdvert) && !matches!(command, Command::BindSend)
    {
        return ErrorCode::RelayProtocolViolation;
    }

    match code {
        // 1, 3, 5, 6 — a malformed frame, an unknown frame type, an unknown
        // command or a bad signature is a bug in one of the two
        // implementations. Never silently retried.
        WireCode::Malformed
        | WireCode::FrameType
        | WireCode::UnknownCommand
        | WireCode::BadSignature
        | WireCode::Replay
        | WireCode::ChannelBinding
        | WireCode::NoAccess
        | WireCode::AckTooHigh
        | WireCode::NotPermitted => ErrorCode::RelayProtocolViolation,
        // 2 — only HELLO negotiates the version.
        WireCode::UnsupportedVersion if matches!(command, Command::Hello) => {
            ErrorCode::RelayVersionUnsupported
        }
        // 4 — HELLO is the first and only in-flight command at its point in the
        // session. Every later command may hit the published in-flight cap.
        WireCode::TooManyInflight if !matches!(command, Command::Hello) => {
            ErrorCode::RelayBackpressure
        }
        // 7 — THIS DEVICE'S clock is wrong, not the relay's. Never a defect
        // report against the relay, and never a reason to set a system clock
        // from a relay-supplied time.
        WireCode::StaleTimestamp if command.auth() != f2z_codec::commands::Auth::None => {
            ErrorCode::DeviceClockSkew
        }
        // 11 — only a first attempt to BIND_SEND can prove send-capability
        // theft. A later attempt means the client should not have tried.
        WireCode::AlreadyBound
            if matches!(command, Command::BindSend)
                && matches!(attempt, BindAttempt::FirstForFreshAdvert) =>
        {
            ErrorCode::SendAddressStolen
        }
        // 12 — exactly the two commands that carry padded payloads.
        WireCode::BadSize if matches!(command, Command::Append | Command::ContactAppend) => {
            ErrorCode::RelayCapabilityMismatch
        }
        // 14 — the receive-side owner is told only about queue-creation quota.
        WireCode::Quota
            if matches!(command, Command::CreateQueue | Command::CreateContactQueue) =>
        {
            ErrorCode::RelayQuota
        }
        // 15 — ordinary and contact send paths share the state-oracle collapse.
        WireCode::Unavailable
            if matches!(
                command,
                Command::BindSend | Command::Append | Command::ContactAppend
            ) =>
        {
            ErrorCode::SendUnavailable
        }
        // 16, 17 — the three commands that present a proof-of-work stamp.
        WireCode::PowRequired
            if matches!(
                command,
                Command::CreateQueue | Command::CreateContactQueue | Command::ContactAppend
            ) =>
        {
            ErrorCode::PowRequired
        }
        WireCode::PowInvalid
            if matches!(
                command,
                Command::CreateQueue | Command::CreateContactQueue | Command::ContactAppend
            ) =>
        {
            ErrorCode::PowFailed
        }
        // 18 — GET_CHALLENGE can fill its challenge table; every signed
        // command can fill the authenticated anti-replay set.
        WireCode::Backpressure
            if matches!(command, Command::GetChallenge)
                || command.auth() != f2z_codec::commands::Auth::None =>
        {
            ErrorCode::RelayBackpressure
        }
        // 19 — per-connection/source admission after HELLO.
        WireCode::RateLimited if !matches!(command, Command::Hello) => ErrorCode::RelayRateLimited,
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
pub fn from_proto(error: ProtoError, command: Command, attempt: BindAttempt) -> ErrorCode {
    match error {
        ProtoError::Wire(code) => from_relay(code, command, attempt),
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

    fn expected_relay_mapping(code: WireCode, command: Command, attempt: BindAttempt) -> ErrorCode {
        if matches!(attempt, BindAttempt::FirstForFreshAdvert)
            && !matches!(command, Command::BindSend)
        {
            return ErrorCode::RelayProtocolViolation;
        }
        match code {
            WireCode::UnsupportedVersion if matches!(command, Command::Hello) => {
                ErrorCode::RelayVersionUnsupported
            }
            WireCode::TooManyInflight if !matches!(command, Command::Hello) => {
                ErrorCode::RelayBackpressure
            }
            WireCode::StaleTimestamp if command.auth() != f2z_codec::commands::Auth::None => {
                ErrorCode::DeviceClockSkew
            }
            WireCode::AlreadyBound
                if matches!(command, Command::BindSend)
                    && matches!(attempt, BindAttempt::FirstForFreshAdvert) =>
            {
                ErrorCode::SendAddressStolen
            }
            WireCode::BadSize if matches!(command, Command::Append | Command::ContactAppend) => {
                ErrorCode::RelayCapabilityMismatch
            }
            WireCode::Quota
                if matches!(command, Command::CreateQueue | Command::CreateContactQueue) =>
            {
                ErrorCode::RelayQuota
            }
            WireCode::Unavailable
                if matches!(
                    command,
                    Command::BindSend | Command::Append | Command::ContactAppend
                ) =>
            {
                ErrorCode::SendUnavailable
            }
            WireCode::PowRequired
                if matches!(
                    command,
                    Command::CreateQueue | Command::CreateContactQueue | Command::ContactAppend
                ) =>
            {
                ErrorCode::PowRequired
            }
            WireCode::PowInvalid
                if matches!(
                    command,
                    Command::CreateQueue | Command::CreateContactQueue | Command::ContactAppend
                ) =>
            {
                ErrorCode::PowFailed
            }
            WireCode::Backpressure
                if matches!(command, Command::GetChallenge)
                    || command.auth() != f2z_codec::commands::Auth::None =>
            {
                ErrorCode::RelayBackpressure
            }
            WireCode::RateLimited if !matches!(command, Command::Hello) => {
                ErrorCode::RelayRateLimited
            }
            WireCode::Internal => ErrorCode::Internal,
            _ => ErrorCode::RelayProtocolViolation,
        }
    }

    #[test]
    fn every_command_code_and_attempt_matches_the_allowed_context_matrix() {
        // This is deliberately exhaustive on all three axes. Removing a guard,
        // allowing a code on one more command, or applying first-bind authority
        // outside BIND_SEND changes at least one cell and fails here.
        for code in WireCode::ALL {
            for command in Command::ALL {
                for attempt in [BindAttempt::FirstForFreshAdvert, BindAttempt::Later] {
                    assert_eq!(
                        from_relay(code, command, attempt),
                        expected_relay_mapping(code, command, attempt),
                        "{code:?} on {command:?}/{attempt:?}",
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
                Command::Append,
                BindAttempt::Later
            ),
            ErrorCode::DeviceClockSkew
        );
    }

    #[test]
    fn no_access_is_never_ordinary_send_unavailability() {
        // #550 closed the old hedge: state-dependent send-side refusals use
        // code 15. Code 10 on that path is a relay protocol violation, not an
        // unavailable queue that the client may silently retry.
        for command in Command::ALL {
            assert_eq!(
                from_relay(WireCode::NoAccess, command, BindAttempt::Later),
                ErrorCode::RelayProtocolViolation,
                "{command:?}",
            );
        }
        assert_eq!(
            from_relay(WireCode::Unavailable, Command::Append, BindAttempt::Later),
            ErrorCode::SendUnavailable
        );
    }

    #[test]
    fn state_revealing_codes_fail_closed_outside_their_commands() {
        assert_eq!(
            from_relay(WireCode::Unavailable, Command::Read, BindAttempt::Later),
            ErrorCode::RelayProtocolViolation
        );
        assert_eq!(
            from_relay(WireCode::Quota, Command::Append, BindAttempt::Later),
            ErrorCode::RelayProtocolViolation
        );
        assert_eq!(
            from_relay(
                WireCode::AlreadyBound,
                Command::ContactAppend,
                BindAttempt::FirstForFreshAdvert,
            ),
            ErrorCode::RelayProtocolViolation
        );
        assert_eq!(
            from_relay(
                WireCode::Unavailable,
                Command::Append,
                BindAttempt::FirstForFreshAdvert,
            ),
            ErrorCode::RelayProtocolViolation
        );
    }

    #[test]
    fn a_stolen_send_address_is_only_claimed_on_a_first_bind() {
        assert_eq!(
            from_relay(
                WireCode::AlreadyBound,
                Command::BindSend,
                BindAttempt::FirstForFreshAdvert
            ),
            ErrorCode::SendAddressStolen
        );
        assert_eq!(
            from_relay(
                WireCode::AlreadyBound,
                Command::BindSend,
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
                Command::Read,
                BindAttempt::Later
            ),
            ErrorCode::RelayProtocolViolation
        );
    }

    #[test]
    fn only_the_relays_own_faults_map_to_internal() {
        // `internal` means OUR engine faulted, so exactly one wire code on each
        // side may reach it: the peer reporting its own fault.
        for command in Command::ALL {
            let internal: Vec<WireCode> = WireCode::ALL
                .into_iter()
                .filter(|code| {
                    from_relay(*code, command, BindAttempt::Later) == ErrorCode::Internal
                })
                .collect();
            assert_eq!(internal, vec![WireCode::Internal], "{command:?}");
        }
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
