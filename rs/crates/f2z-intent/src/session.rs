//! The caller's half: remembering what you asked, so you can tell what you
//! were answered.
//!
//! This is `wallet/zuuli/src/lib/wallet/creator-tip.ts` generalised, and the
//! comment at the top of that file is the whole design:
//!
//! > A route state is renderer-controlled and therefore cannot authenticate
//! > itself. Keep the source snapshot in module memory and use the route nonce
//! > only as a lookup capability. Reloads and fresh deep links intentionally
//! > lose this map and fail closed.
//!
//! Swap "route state" for "deep-link response" and "renderer" for "whatever
//! app opened this link" and the sentence is unchanged. A response arrives as
//! bytes from an unauthenticated channel; the only thing that makes it an
//! *answer* is that the client is holding a matching outstanding question.
//!
//! # What this does and does not prove
//!
//! It proves the responder had the `request_id` — 32 CSPRNG bytes the client
//! generated and put in exactly one outbound link. An app that never saw the
//! request cannot produce one, so a *bystander* cannot forge a response.
//!
//! **It does not prove the responder is ZUULI.** An app that received the
//! request — because it registered the same link and the OS routed there —
//! has the identifier and can answer. That is precisely why [#461] (verified
//! App Links / Universal Links) is a hard prerequisite for shipping any intent
//! that carries authority, and it is why `sign-challenge` must not be trusted
//! over a custom scheme. `docs/intent-bridge/CALLER-AUTHENTICATION.md` §4
//! states the residual risk if that assumption fails.
//!
//! # One-use on this side too
//!
//! [`IntentSession::accept`] removes the pending entry whether it accepts or
//! refuses on a bound field. A second copy of the same response — the exact
//! replay an attacker gets for free on a link they observed — finds nothing
//! outstanding and is [`IntentError::Unsolicited`].
//!
//! [#461]: https://github.com/free2z/zuu/issues/461

use alloc::vec::Vec;

use f2z_codec::types::Body;

use crate::clock::IntentClock;
use crate::error::IntentError;
use crate::wire::{Intent, IntentRequestV1, RequestId, decode_response, encode_request};

/// One question this client is still waiting on.
///
/// The frozen snapshot. Every field is re-checked against the response, so a
/// response that agrees about the identifier but not about the family is
/// refused rather than half-believed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Pending {
    request_id: RequestId,
    intent: Intent,
    expires_at_ms: u64,
}

/// A fulfilled response, family-tagged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptedResponse {
    /// The family, taken from the *pending* record rather than the response.
    intent: Intent,
    /// The family result bytes, to be decoded by the caller.
    payload: Body,
}

impl AcceptedResponse {
    /// The family.
    #[must_use]
    pub const fn intent(&self) -> Intent {
        self.intent
    }

    /// The family result, still opaque.
    #[must_use]
    pub const fn payload(&self) -> &Body {
        &self.payload
    }
}

/// The client-side outstanding-request map.
///
/// Deliberately in memory only. Persisting it would let a response be accepted
/// after a restart, which is exactly the "reloads intentionally lose this map
/// and fail closed" property of `creator-tip.ts`.
#[derive(Clone, Debug)]
pub struct IntentSession {
    capacity: usize,
    pending: Vec<Pending>,
}

impl IntentSession {
    /// How many questions one client keeps outstanding.
    ///
    /// Thirty-two, matching `creator-tip.ts`'s `MAX_PENDING_INTENTS`. A client
    /// with more than a handful of unanswered intents is not a client, it is a
    /// leak.
    pub const DEFAULT_CAPACITY: usize = 32;

    /// An empty session.
    #[must_use]
    pub const fn new() -> Self {
        Self::with_capacity(Self::DEFAULT_CAPACITY)
    }

    /// An empty session with an explicit bound.
    #[must_use]
    pub const fn with_capacity(capacity: usize) -> Self {
        Self {
            capacity,
            pending: Vec::new(),
        }
    }

    /// How many questions are outstanding.
    #[must_use]
    pub fn len(&self) -> usize {
        self.pending.len()
    }

    /// Whether nothing is outstanding.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    /// Encode a request and record it as outstanding.
    ///
    /// The client must send exactly these bytes. Sending anything else means
    /// the response it eventually accepts answers a different question than
    /// the one it recorded.
    ///
    /// # Errors
    ///
    /// - [`IntentError::UnknownIntent`] if the family code is not implemented.
    /// - [`IntentError::InvalidValue`] on a duplicate identifier, or on a
    ///   window that is inverted.
    /// - [`IntentError::LedgerFull`] if the session is full. Same reasoning as
    ///   [`crate::ledger`]: dropping the oldest outstanding question is how an
    ///   attacker makes room for a forged answer.
    /// - [`IntentError::Malformed`] if the request cannot be encoded.
    pub fn issue(
        &mut self,
        request: &IntentRequestV1,
        now: IntentClock,
    ) -> Result<Vec<u8>, IntentError> {
        let intent = Intent::from_code(request.intent)?;
        if request.expires_at_ms <= request.issued_at_ms {
            return Err(IntentError::InvalidValue);
        }
        self.prune(now);
        if self
            .pending
            .iter()
            .any(|entry| entry.request_id == request.request_id)
        {
            return Err(IntentError::InvalidValue);
        }
        if self.pending.len() >= self.capacity {
            return Err(IntentError::LedgerFull);
        }
        let bytes = encode_request(request)?;
        self.pending.push(Pending {
            request_id: request.request_id,
            intent,
            expires_at_ms: request.expires_at_ms,
        });
        Ok(bytes)
    }

    /// Drop every question whose window has closed.
    pub fn prune(&mut self, now: IntentClock) {
        self.pending
            .retain(|entry| entry.expires_at_ms > now.wall_ms);
    }

    /// Judge a response against the outstanding questions.
    ///
    /// # Errors
    ///
    /// - [`IntentError::Malformed`] / [`IntentError::UnsupportedVersion`] /
    ///   [`IntentError::UnknownIntent`] from [`decode_response`].
    /// - [`IntentError::Unsolicited`] if no outstanding question has this
    ///   identifier, or if the one that does disagrees about the family.
    /// - [`IntentError::Expired`] if the question's own window has closed.
    /// - Whatever refusal the wallet returned, when `status` is non-zero. An
    ///   unrecognized status becomes [`IntentError::Malformed`] rather than
    ///   being reported as success.
    pub fn accept(
        &mut self,
        bytes: &[u8],
        now: IntentClock,
    ) -> Result<AcceptedResponse, IntentError> {
        let response = decode_response(bytes)?;
        let position = self
            .pending
            .iter()
            .position(|entry| entry.request_id == response.request_id)
            .ok_or(IntentError::Unsolicited)?;
        // One use: the question is answered — or spoiled — either way.
        let Some(entry) = self.pending.get(position).copied() else {
            return Err(IntentError::Unsolicited);
        };
        self.pending.remove(position);
        if entry.intent.code() != response.intent {
            return Err(IntentError::Unsolicited);
        }
        if now.wall_ms >= entry.expires_at_ms {
            return Err(IntentError::Expired);
        }
        if response.status != 0 {
            return Err(IntentError::from_status(response.status).unwrap_or(IntentError::Malformed));
        }
        Ok(AcceptedResponse {
            intent: entry.intent,
            payload: response.payload,
        })
    }
}

impl Default for IntentSession {
    fn default() -> Self {
        Self::new()
    }
}
