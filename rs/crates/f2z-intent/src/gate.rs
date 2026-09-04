//! The one entry point, so no caller can perform four checks out of five.
//!
//! Every guard in this crate is separately testable, which is why they are
//! separate modules. That is also the hazard: a wallet integration that calls
//! [`IntentRequest::parse`] and forgets [`IntentLedger::claim`] has a bridge
//! that looks finished and replays. `#553`'s lesson, restated — a guard whose
//! application depends on somebody remembering it covers whatever they last
//! remembered.
//!
//! So the ZUULI side calls [`IntentGate::admit`] and nothing else. It returns
//! an [`AdmittedIntent`], and an [`AdmittedIntent`] cannot be constructed any
//! other way, so "the request was admitted" is a type rather than a comment.

use f2z_codec::types::Digest;

use crate::caller::{AuthorizedCaller, CallerAttestation, CallerRegistry};
use crate::clock::{DEFAULT_CLOCK_SKEW_MS, IntentClock, check_request_window};
use crate::error::IntentError;
use crate::ledger::IntentLedger;
use crate::wire::{IntentBody, IntentRequest};

/// A request that passed every pre-confirmation guard.
///
/// Holding one means: the bytes were canonical, the version and family were
/// implemented, every field was valid, the caller is registered, the window is
/// open on the wallet's clock, and the identifier has been spent. It does
/// **not** mean the user approved anything — that is
/// [`crate::confirmation`], and it comes next.
#[derive(Debug)]
pub struct AdmittedIntent {
    request: IntentRequest,
    caller: AuthorizedCaller,
}

impl AdmittedIntent {
    /// The parsed request.
    #[must_use]
    pub const fn request(&self) -> &IntentRequest {
        &self.request
    }

    /// Who the wallet will say sent it, and how much that is worth.
    #[must_use]
    pub const fn caller(&self) -> &AuthorizedCaller {
        &self.caller
    }

    /// The family request.
    #[must_use]
    pub const fn body(&self) -> &IntentBody {
        self.request.body()
    }

    /// The digest a confirmation binds to.
    #[must_use]
    pub fn request_digest(&self) -> Digest {
        self.request.digest()
    }
}

/// The wallet-side gate: a caller registry, a replay ledger, and a skew
/// tolerance.
#[derive(Clone, Debug)]
pub struct IntentGate {
    registry: CallerRegistry,
    ledger: IntentLedger,
    skew_ms: u64,
}

impl IntentGate {
    /// A gate over `registry`, with the default ledger capacity and the
    /// default issuance skew.
    #[must_use]
    pub const fn new(registry: CallerRegistry) -> Self {
        Self {
            registry,
            ledger: IntentLedger::new(),
            skew_ms: DEFAULT_CLOCK_SKEW_MS,
        }
    }

    /// A gate with an explicit ledger and skew, for tests and for a wallet
    /// with an unusual clock story.
    #[must_use]
    pub const fn with_parts(registry: CallerRegistry, ledger: IntentLedger, skew_ms: u64) -> Self {
        Self {
            registry,
            ledger,
            skew_ms,
        }
    }

    /// Parse, authorize, time-check and spend — in that order.
    ///
    /// The order is a decision:
    ///
    /// 1. **Parse.** Nothing can be judged about bytes that are not a request.
    /// 2. **Authorize the caller.** An unregistered app's request is refused
    ///    before its identifier is recorded, so a stranger cannot fill the
    ///    ledger, and before the wallet spends any effort rendering it.
    /// 3. **Check the window**, against the wallet's clock rather than the
    ///    caller's claim.
    /// 4. **Spend the identifier**, last, so a request refused by 1–3 does not
    ///    burn an identifier the honest caller may retry with.
    ///
    /// # Errors
    ///
    /// Any [`IntentError`] the four steps can produce. The variants are
    /// deliberately not narrowed here: adding a fifth guard must not silently
    /// widen a documented set.
    pub fn admit(
        &mut self,
        bytes: &[u8],
        attestation: CallerAttestation<'_>,
        now: IntentClock,
    ) -> Result<AdmittedIntent, IntentError> {
        let request = IntentRequest::parse(bytes)?;
        let caller = self
            .registry
            .authorize(request.claimed_caller(), attestation)?;
        check_request_window(
            request.issued_at_ms(),
            request.expires_at_ms(),
            now,
            self.skew_ms,
        )?;
        self.ledger
            .claim(request.request_id(), request.expires_at_ms(), now)?;
        Ok(AdmittedIntent { request, caller })
    }

    /// How many unexpired identifiers the ledger holds.
    #[must_use]
    pub fn outstanding(&self) -> usize {
        self.ledger.len()
    }
}
