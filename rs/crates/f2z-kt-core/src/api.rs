//! The request and response envelopes of `KT.md` §9.2.
//!
//! **In this crate rather than in the server, on §11.4's reasoning.** `KT.md`
//! §11.4 is explicit that the log, the witness and the client link *one* crate,
//! and these composites are exactly the kind of thing that must not have two
//! implementations: a witness that decoded a tree-head bundle differently from
//! the log that encoded it would cosign a root it did not actually read.
//!
//! §9.2 fixes the **paths, the methods and what each carries**; it does not
//! give a byte layout for the composites ("`DirectoryEntry` + `LookupProof` +
//! tree head + cosignatures"). These are those composites, in the TLS
//! presentation language and under `WIRE.md` §3 like everything else, and every
//! one of them is **invented here** and marked as such.
//!
//! # Three rules this module exists to hold
//!
//! **1. JSON is a container, never a transcript.** The API is served as
//! `application/octet-stream` `tls_codec` bytes, and *also* as JSON for the
//! benefit of anyone with `curl` and no protocol library. The JSON carries the
//! **same** `tls_codec` bytes, base64url-encoded, and a client verifies those
//! bytes. Nothing is ever signed over a JSON rendering, nothing is ever
//! reconstructed from JSON fields, and a JSON body that disagreed with its
//! embedded bytes would change no signature's verdict. See the log server's `json` module.
//!
//! **2. `akd`'s proof bytes are carried opaquely** (`KT.md` §9.4). They are
//! protobuf, protobuf is not canonical, and `WIRE.md` §3.3's re-encode-equality
//! rule does not reach inside them. That is safe for §9.4's precise reason:
//! nothing we sign is derived from a proof's encoding. Every proof here is a
//! [`Payload`], never a decoded structure.
//!
//! **3. The handle is in the body, never the path.** [`LookupRequest`] and
//! [`HistoryRequest`] exist so that `POST /kt/v1/lookup` can take a handle
//! without it landing in an access log, an intermediary's log, or a `Referer`.
//! §9.2 is honest about the size of that: the log still learns the handle,
//! because it has to answer. It removes the accidental copies, not the
//! intentional one.

use f2z_codec::types::{Payload, ShortBytes, Signature};
use f2z_codec::vec::VecU24;
use crate::cosign::WitnessCosignature;
use crate::sth::SignedTreeHead;
use crate::types::{Handle, check_label, label_field};
use crate::{KT_VERSION, KtError};
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

/// `SubmissionEnvelope`'s type tag.
///
/// **Not a signing label.** `KT.md` §6.2's closed set is the set of labels that
/// appear *inside signed bytes*; this envelope is not signed and this constant
/// is a version-and-type tag on an unsigned container. It is here because a
/// decoder that checks a constant before doing anything else is cheaper than a
/// decoder that discovers the type from the shape.
pub const LABEL_SUBMISSION: &[u8] = b"free2z/kt/v1/submission";

/// `LookupRequest`'s type tag. Not a signing label; see [`LABEL_SUBMISSION`].
pub const LABEL_LOOKUP_REQUEST: &[u8] = b"free2z/kt/v1/lookup-request";

/// `LookupResponse`'s type tag. Not a signing label.
pub const LABEL_LOOKUP_RESPONSE: &[u8] = b"free2z/kt/v1/lookup-response";

/// `HistoryRequest`'s type tag. Not a signing label.
pub const LABEL_HISTORY_REQUEST: &[u8] = b"free2z/kt/v1/history-request";

/// `HistoryResponse`'s type tag. Not a signing label.
pub const LABEL_HISTORY_RESPONSE: &[u8] = b"free2z/kt/v1/history-response";

/// `AuditResponse`'s type tag. Not a signing label.
pub const LABEL_AUDIT_RESPONSE: &[u8] = b"free2z/kt/v1/audit-response";

/// `TreeHeadBundle`'s type tag. Not a signing label.
pub const LABEL_TREE_HEAD_BUNDLE: &[u8] = b"free2z/kt/v1/tree-head-bundle";

/// `ErrorBody`'s type tag. Not a signing label.
pub const LABEL_ERROR: &[u8] = b"free2z/kt/v1/error";

/// A submitted `DirectoryEntry`, its handle assertion, and the identity key's
/// signature binding the two together. **Invented here.**
///
/// # Why this is not just a `DirectoryEntry`
///
/// §9.2 says `POST /kt/v1/submit` carries a `DirectoryEntry`. Taken literally
/// that is [zuu#594]: `KT.md` §4.4's authorization table has no case for
/// `entry_version == 1`, so a log that accepts a bare first entry from whoever
/// sends one is **conforming**, and hands `@alice` to the first stranger who
/// asks. This crate refuses to ship that. The envelope carries the two fields
/// `f2z-authority` needs to close the hole, and [`crate::admit`] is where they
/// are checked.
///
/// `identity_signature` is over `tls_codec(AssertionBindingTBS)` by the entry's
/// own `identity_pk`, and it is **never optional** — not on a log with an
/// authority, not on one without. It is what makes a stolen assertion useless,
/// and on a no-authority log it is the whole of the check.
///
/// `assertion` is empty exactly when the log has no authority
/// (`f2z_authority::AuthoritySet::none`). Presenting one to a log that has no
/// authority is an error, and omitting one from a log that has an authority is
/// an error; the log will not quietly do the other thing.
///
/// [zuu#594]: https://github.com/free2z/zuu/issues/594
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct SubmissionEnvelope {
    /// Exactly [`LABEL_SUBMISSION`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// `tls_codec(DirectoryEntry)`, carried as bytes rather than as a decoded
    /// structure so that [`crate::validate_submission`] receives **the
    /// bytes that arrived** and applies re-encode equality itself. Decoding
    /// here and re-encoding for the validator would put a second codec between
    /// the wire and the rule, which is the parse-versus-verify gap `WIRE.md`
    /// §3.3 exists to close.
    pub entry: Payload,
    /// `tls_codec(HandleAssertion)`, or empty on a log with no authority.
    pub assertion: Payload,
    /// Ed25519 over `tls_codec(AssertionBindingTBS)` by the entry's
    /// `identity_pk`.
    pub identity_signature: Signature,
}

impl SubmissionEnvelope {
    /// Check the constants before anything reads a field.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`] or [`KtError::UnsupportedVersion`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_SUBMISSION)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        Ok(())
    }

    /// Build one, for a client or a test.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the entry or the assertion is larger than a
    /// `u24` length prefix can express.
    pub fn new(
        entry: &[u8],
        assertion: Option<&[u8]>,
        identity_signature: Signature,
    ) -> Result<Self, KtError> {
        Ok(Self {
            label: label_field(LABEL_SUBMISSION)?,
            kt_version: KT_VERSION,
            entry: Payload::new(entry.to_vec()).map_err(|_| KtError::Malformed)?,
            assertion: Payload::new(assertion.unwrap_or(&[]).to_vec())
                .map_err(|_| KtError::Malformed)?,
            identity_signature,
        })
    }

    /// The assertion bytes, or `None` when the field is empty.
    ///
    /// An empty field and an absent field are the same thing on the wire; this
    /// is the one place that equivalence is decided, so no caller has to
    /// remember it.
    #[must_use]
    pub fn assertion_bytes(&self) -> Option<&[u8]> {
        let bytes = self.assertion.as_slice();
        if bytes.is_empty() { None } else { Some(bytes) }
    }
}

/// A tree head with the cosignatures the log has collected for it (`KT.md`
/// §9.2, `GET /kt/v1/sth`). **Invented here.**
///
/// §7.5 states the conflict of interest this creates and it is worth repeating
/// where the type is defined: if the log is the only distributor of
/// cosignatures then the party under audit controls the distribution of the
/// evidence used to audit it, and can withhold one it does not like and simply
/// appear to have fewer witnesses that epoch. A client SHOULD fetch
/// cosignatures from at least one witness it configured as well.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct TreeHeadBundle {
    /// Exactly [`LABEL_TREE_HEAD_BUNDLE`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The head itself, signed by the log.
    pub head: SignedTreeHead,
    /// Every cosignature the log holds for exactly this
    /// `(log_id, epoch, tree_size, root_hash)`. The log does not filter by any
    /// client's witness set — it cannot know one — and a client applies
    /// [`crate::verify_threshold`] against **its own** set.
    pub cosignatures: VecU24<WitnessCosignature>,
}

impl TreeHeadBundle {
    /// Assemble a bundle.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the label will not fit, which it always will.
    pub fn new(head: SignedTreeHead, cosignatures: Vec<WitnessCosignature>) -> Result<Self, KtError> {
        Ok(Self {
            label: label_field(LABEL_TREE_HEAD_BUNDLE)?,
            kt_version: KT_VERSION,
            head,
            cosignatures: VecU24::new(cosignatures),
        })
    }

    /// Check the constants.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`] or [`KtError::UnsupportedVersion`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_TREE_HEAD_BUNDLE)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        Ok(())
    }
}

/// `POST /kt/v1/lookup`'s body. **Invented here.**
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct LookupRequest {
    /// Exactly [`LABEL_LOOKUP_REQUEST`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The handle being resolved. In the **body**, per §9.2.
    pub handle: Handle,
}

impl LookupRequest {
    /// Build one.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the label will not fit.
    pub fn new(handle: Handle) -> Result<Self, KtError> {
        Ok(Self {
            label: label_field(LABEL_LOOKUP_REQUEST)?,
            kt_version: KT_VERSION,
            handle,
        })
    }

    /// Check the constants and the handle charset.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`] or
    /// [`KtError::BadHandle`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_LOOKUP_REQUEST)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        self.handle.validate()
    }
}

/// Whether a lookup found a registered handle.
///
/// # This field is an admission, and it should not have to exist
///
/// `KT.md` §8.1 and §9.5 require that an unregistered handle be answered with a
/// **proof of non-membership** — *"'No such user' is a claim the log must
/// prove"* — and that is why §9.5 has no unknown-handle error code.
///
/// **`akd` 0.13 cannot produce that proof.** `akd::Directory::lookup` returns
/// `StorageError::NotFound` for a label with no user state; the
/// `NonMembershipProof` inside a `LookupProof` proves the freshness marker's
/// absence for a label that *does* exist, not that a label was never
/// registered. There is no public API in the adopted library that answers "this
/// handle is not in the tree" with anything a client can check.
///
/// So this log tells the truth about what it can prove: [`Presence::Absent`]
/// is an **assertion**, carries no proof, and is labelled as unproved on the
/// wire so that no client mistakes it for one. Reported as a spec defect rather
/// than papered over.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum Presence {
    /// The handle is registered; `entry` and `proof` are populated and the
    /// proof verifies under the accompanying root.
    Present,
    /// The log asserts the handle is not registered. **Unproved.** See the
    /// type documentation.
    AbsentUnproved,
}

impl Presence {
    /// The wire byte.
    #[must_use]
    pub const fn code(self) -> u8 {
        match self {
            Self::Present => 1,
            Self::AbsentUnproved => 0,
        }
    }

    /// Decode the wire byte.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] for anything but 0 or 1.
    pub const fn from_code(code: u8) -> Result<Self, KtError> {
        match code {
            0 => Ok(Self::AbsentUnproved),
            1 => Ok(Self::Present),
            _ => Err(KtError::Malformed),
        }
    }
}

/// `POST /kt/v1/lookup`'s response. **Invented here.**
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct LookupResponse {
    /// Exactly [`LABEL_LOOKUP_RESPONSE`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// [`Presence`], as its byte. Not a `tls_codec` enum because a one-byte
    /// discriminant with no variant bodies is what it is.
    pub presence: u8,
    /// `tls_codec(DirectoryEntry)`, empty when `presence` is absent.
    ///
    /// The client recomputes
    /// `AkdValue = H("free2z/kt/v1/value", tls_codec(DirectoryEntry))` from
    /// **these** bytes under re-encode equality and uses that as the value in
    /// `lookup_verify` — never a value the log asserts (§8.1 step 4).
    pub entry: Payload,
    /// `akd`'s `LookupProof`, protobuf, opaque (§9.4). Empty when absent.
    pub proof: Payload,
    /// The root the proof is against, with its cosignatures.
    pub bundle: TreeHeadBundle,
}

impl LookupResponse {
    /// Check the constants.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`], or
    /// [`KtError::Malformed`] for an unknown `presence` byte or a body that
    /// disagrees with it.
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_LOOKUP_RESPONSE)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        let presence = Presence::from_code(self.presence)?;
        let populated = !self.entry.as_slice().is_empty() && !self.proof.as_slice().is_empty();
        let empty = self.entry.as_slice().is_empty() && self.proof.as_slice().is_empty();
        match presence {
            Presence::Present if populated => {}
            Presence::AbsentUnproved if empty => {}
            _ => return Err(KtError::Malformed),
        }
        self.bundle.validate()
    }
}

/// `POST /kt/v1/history`'s body. **Invented here.**
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct HistoryRequest {
    /// Exactly [`LABEL_HISTORY_REQUEST`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The handle whose history is wanted. In the **body**, per §9.2.
    pub handle: Handle,
    /// `akd`'s `HistoryParams`, narrowed to the two cases a self-audit needs:
    /// `0` = `Complete`, `1` = `MostRecent(n)` with `n` in [`Self::count`].
    ///
    /// §9.2 says "`{handle, params}`" and does not say what `params` is;
    /// `akd`'s own enum has four variants, two of which (`SinceEpoch`,
    /// `MostRecent`) let a caller ask for an unbounded amount of work. This is
    /// the narrowing, and it is an ambiguity call rather than a reading.
    pub params: u8,
    /// The count for `MostRecent`. Ignored when `params` is `0`.
    pub count: u32,
}

impl HistoryRequest {
    /// The complete history of a handle.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the label will not fit.
    pub fn complete(handle: Handle) -> Result<Self, KtError> {
        Ok(Self {
            label: label_field(LABEL_HISTORY_REQUEST)?,
            kt_version: KT_VERSION,
            handle,
            params: 0,
            count: 0,
        })
    }

    /// Check the constants, the handle and the parameter shape.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`], [`KtError::UnsupportedVersion`],
    /// [`KtError::BadHandle`], or [`KtError::Malformed`] for an unknown
    /// `params` code or a zero `count` on `MostRecent`.
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_HISTORY_REQUEST)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        self.handle.validate()?;
        match self.params {
            0 => Ok(()),
            1 if self.count > 0 => Ok(()),
            _ => Err(KtError::Malformed),
        }
    }
}

/// `POST /kt/v1/history`'s response. **Invented here.**
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct HistoryResponse {
    /// Exactly [`LABEL_HISTORY_RESPONSE`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// One `tls_codec(DirectoryEntry)` per returned version, newest first —
    /// the order `akd`'s `HistoryProof` uses, so a client can zip the two
    /// without re-deriving an ordering.
    pub entries: VecU24<Payload>,
    /// `akd`'s `HistoryProof`, protobuf, opaque (§9.4).
    pub proof: Payload,
    /// The root the proof is against, with its cosignatures.
    pub bundle: TreeHeadBundle,
}

impl HistoryResponse {
    /// Check the constants.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`] or [`KtError::UnsupportedVersion`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_HISTORY_RESPONSE)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        self.bundle.validate()
    }
}

/// `GET /kt/v1/audit`'s response. **Invented here.**
///
/// §9.2 says it carries "`AppendOnlyProof` (akd protobuf, §9.4) + both tree
/// heads". It carries **every** head in the range rather than two, because
/// §6.3 rule 7 forbids a verifier from skipping an epoch — *"a gap accepted on
/// trust is a branch accepted on trust"* — so a witness that received only the
/// endpoints would have to fetch the rest one at a time before it could accept
/// either. Sending the run it must have anyway is the same bytes in one
/// round trip.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct AuditResponse {
    /// Exactly [`LABEL_AUDIT_RESPONSE`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// `akd`'s `AppendOnlyProof`, protobuf, opaque (§9.4).
    pub proof: Payload,
    /// Every head from `from` to `to` inclusive, in ascending epoch order —
    /// exactly the slice `crate::auditor::verify_append_only` wants,
    /// with the already-accepted head at position 0.
    pub heads: VecU24<SignedTreeHead>,
}

impl AuditResponse {
    /// Check the constants.
    ///
    /// # Errors
    ///
    /// [`KtError::WrongLabel`] or [`KtError::UnsupportedVersion`].
    pub fn validate(&self) -> Result<(), KtError> {
        check_label(&self.label, LABEL_AUDIT_RESPONSE)?;
        if self.kt_version != KT_VERSION {
            return Err(KtError::UnsupportedVersion);
        }
        Ok(())
    }
}

/// An error response body. **Invented here.**
///
/// One `uint16` and nothing else, because `KT.md` §9.5 says `ERR_INTERNAL`
/// *"carries no detail, ever"* and a body shaped to carry detail is a body that
/// will eventually carry it.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct ErrorBody {
    /// Exactly [`LABEL_ERROR`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The §9.5 code.
    pub code: u16,
}

impl ErrorBody {
    /// Build one.
    ///
    /// # Errors
    ///
    /// [`KtError::Malformed`] if the label will not fit.
    pub fn new(code: u16) -> Result<Self, KtError> {
        Ok(Self {
            label: label_field(LABEL_ERROR)?,
            kt_version: KT_VERSION,
            code,
        })
    }
}

#[cfg(test)]
mod tests {
    use f2z_codec::Canonical as _;
    use f2z_codec::types::Signature;

    use super::{
        ErrorBody, HistoryRequest, LookupRequest, LookupResponse, Presence, SubmissionEnvelope,
        TreeHeadBundle,
    };
    use crate::KT_VERSION;
    use crate::sth::{SignedTreeHead, SignedTreeHeadTBS};
    use crate::types::{Handle, label_field};

    #[test]
    fn every_envelope_round_trips_canonically() {
        let envelope =
            SubmissionEnvelope::new(b"entry-bytes", Some(b"assertion"), Signature::new([3u8; 64]))
                .unwrap();
        let bytes = envelope.encode_canonical().unwrap();
        let decoded = f2z_codec::decode_canonical::<SubmissionEnvelope>(&bytes).unwrap();
        assert_eq!(decoded.value(), &envelope);
        assert!(envelope.validate().is_ok());

        let request = LookupRequest::new(Handle::new(b"alice".to_vec()).unwrap()).unwrap();
        let bytes = request.encode_canonical().unwrap();
        assert_eq!(
            f2z_codec::decode_canonical::<LookupRequest>(&bytes)
                .unwrap()
                .value(),
            &request
        );
        assert!(request.validate().is_ok());

        let error = ErrorBody::new(11).unwrap();
        let bytes = error.encode_canonical().unwrap();
        assert_eq!(
            f2z_codec::decode_canonical::<ErrorBody>(&bytes)
                .unwrap()
                .value(),
            &error
        );
    }

    #[test]
    fn an_empty_assertion_field_reads_as_no_assertion() {
        let with = SubmissionEnvelope::new(b"e", Some(b"a"), Signature::new([0u8; 64])).unwrap();
        let without = SubmissionEnvelope::new(b"e", None, Signature::new([0u8; 64])).unwrap();
        assert_eq!(with.assertion_bytes(), Some(b"a".as_slice()));
        assert_eq!(without.assertion_bytes(), None);
        // And an explicitly empty slice is the same thing, so a client that
        // sends `Some(&[])` is not treated as a log with an authority.
        let explicit = SubmissionEnvelope::new(b"e", Some(b""), Signature::new([0u8; 64])).unwrap();
        assert_eq!(explicit.assertion_bytes(), None);
    }

    #[test]
    fn a_history_request_refuses_a_zero_count_most_recent() {
        let mut request = HistoryRequest::complete(Handle::new(b"bob".to_vec()).unwrap()).unwrap();
        assert!(request.validate().is_ok());
        request.params = 1;
        request.count = 0;
        assert!(request.validate().is_err());
        request.count = 3;
        assert!(request.validate().is_ok());
        request.params = 7;
        assert!(request.validate().is_err());
    }

    #[test]
    fn a_lookup_response_cannot_claim_presence_with_no_entry() {
        // The shape check exists so that a client cannot be handed
        // `presence = Present` with nothing to verify and quietly treat the
        // handle as resolved.
        let bundle = TreeHeadBundle::new(
            SignedTreeHead {
                sth: SignedTreeHeadTBS {
                    label: label_field(crate::labels::LABEL_STH).unwrap(),
                    kt_version: KT_VERSION,
                    log_id: crate::types::LogId::zero(),
                    epoch: 1,
                    tree_size: 1,
                    root_hash: f2z_codec::types::Digest::zero(),
                    prev_sth_hash: f2z_codec::types::Digest::zero(),
                    vrf_public_key: f2z_codec::types::PublicKey::zero(),
                    published_at_ms: 1,
                    reset_count: 0,
                    epoch_interval_seconds: 600,
                    max_merge_delay_seconds: 3_600,
                    successor_log_pk: f2z_codec::types::PublicKey::zero(),
                },
                signature: Signature::zero(),
            },
            Vec::new(),
        )
        .unwrap();
        let mut response = LookupResponse {
            label: label_field(super::LABEL_LOOKUP_RESPONSE).unwrap(),
            kt_version: KT_VERSION,
            presence: Presence::Present.code(),
            entry: f2z_codec::types::Payload::new(Vec::new()).unwrap(),
            proof: f2z_codec::types::Payload::new(Vec::new()).unwrap(),
            bundle,
        };
        assert!(response.validate().is_err());

        response.presence = Presence::AbsentUnproved.code();
        assert!(response.validate().is_ok());

        response.entry = f2z_codec::types::Payload::new(b"entry".to_vec()).unwrap();
        assert!(
            response.validate().is_err(),
            "an absent verdict carrying an entry is incoherent and must not decode as either"
        );
    }
}
