//! Signed commands: building one, and verifying one.
//!
//! This is `WIRE.md` §5 and §6 turned into two operations that are each other's
//! inverse, plus the typed pairing that keeps a command's request and response
//! from drifting apart.
//!
//! # The verification order is the security argument
//!
//! §5.1 fixes an order and says "it matters". [`CommandVerifier::verify`]
//! implements exactly it:
//!
//! 1. Decode and re-encode-compare (§3.3). The frame half is `f2z-codec`'s and
//!    has already happened by the time a [`Request`] exists; the *body* half
//!    happens here, because a frame's body is opaque bytes at the framing layer
//!    and a non-canonical structure inside it would survive a frame-level
//!    re-encode untouched.
//! 2. Timestamp window (§5.5) → `ERR_STALE_TIMESTAMP`.
//! 3. Preflight `(signer_key, nonce)` against the seen-set (§5.5) →
//!    `ERR_REPLAY`, without inserting it.
//! 4. Rebuild the transcript **from the relay's own `relay_id` and its own
//!    `channel_binding`** and verify the signature → `ERR_BAD_SIGNATURE`.
//! 5. Address and self-authentication rules (§6.2, §6.3) → `ERR_NO_ACCESS`.
//! 6. Policy — the payload's padding bucket (§9).
//! 7. Commit the authenticated `(signer_key, nonce)` with insert-if-absent
//!    semantics. A competing commit loses as `ERR_REPLAY`.
//!
//! Steps 2 and 3 precede the signature check because they are cheap and they
//! are the flood-resistant filters. Step 5 follows it so that an unsigned guess
//! cannot probe the address space. Reordering any of that is a security change,
//! which is why the whole sequence lives in one function instead of being
//! composed by each call site.
//!
//! What this module does **not** do is look anything up. Steps 5's *second*
//! half — "the address exists and `signer_key` is the key registered for it" —
//! and step 6's quotas are relay state; they live in [`crate::queue`] and above.

use core::fmt;
use core::marker::PhantomData;

use alloc::vec::Vec;

use f2z_codec::canonical::{Canonical, decode_canonical};
use f2z_codec::commands::{
    AckRequest, AckResponse, AppendRequest, Auth, BindSendRequest, ChallengeRequest,
    ChallengeResponse, Command, ContactAppendRequest, CreateContactQueueRequest,
    CreateContactQueueResponse, CreateQueueRequest, CreateQueueResponse, HelloRequest,
    HelloResponse, ReadRequest, ReadResponse, SignedCapabilities, SubscribeResponse,
    TranscriptAddress,
};
use f2z_codec::frame::{CommandAuth, RelayFrame, Request, SignedAuth};
use f2z_codec::padding::PaddingBuckets;
use f2z_codec::transcript::{AuthContext, TranscriptBuilder};
use f2z_codec::types::{Body, Nonce, Payload, PublicKey, QueueAddress};
use f2z_codec::{ErrorCode, PROTOCOL_VERSION};

use crate::error::{ProtoError, Result};
use crate::key::{SigningKey, keys_equal};
use crate::replay::{ReplayKey, SeenSet, TimestampWindow};

pub use empty::Empty;

mod empty {
    use alloc::vec::Vec;

    use tls_codec::{DeserializeBytes, Error as TlsError, SerializeBytes, Size};

    /// A body of zero bytes.
    ///
    /// Several commands have empty bodies **by rule** rather than by accident:
    /// `BIND_SEND`'s response is empty because §6.3 says so, and `APPEND`'s is
    /// empty because an index, a depth or a timestamp would convert the send
    /// capability into a weak read capability. Giving that its own type means
    /// the pairing in [`RelayCommand`] can state it, and means a caller cannot
    /// quietly start putting queue state in one.
    ///
    /// [`RelayCommand`]: crate::command::RelayCommand
    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    pub struct Empty;

    impl Size for Empty {
        fn tls_serialized_len(&self) -> usize {
            0
        }
    }

    impl SerializeBytes for Empty {
        fn tls_serialize(&self) -> Result<Vec<u8>, TlsError> {
            Ok(Vec::new())
        }
    }

    impl DeserializeBytes for Empty {
        fn tls_deserialize_bytes(bytes: &[u8]) -> Result<(Self, &[u8]), TlsError> {
            // Consumes nothing. `decode_canonical` demands the whole input be
            // consumed, so a non-empty body decoded as `Empty` is rejected
            // there rather than silently ignored — which is §3.5's "no ignoring
            // unknown trailing bytes" applied to the emptiest case.
            Ok((Self, bytes))
        }
    }
}

/// One command of §6, with its request body type and its response body type
/// bound together.
///
/// The pairing is the point. A relay handler and a client call site both name
/// the *command*, never a pair of body types, so there is no place to write a
/// `READ` request beside an `ACK` response. [`crate::inflight::Ticket`] carries
/// the same type from the moment a request is issued to the moment its response
/// is decoded, which is what makes a mismatched correlation a compile error
/// rather than a runtime surprise.
pub trait RelayCommand: Sized {
    /// The §6 command this implements.
    const COMMAND: Command;

    /// The request body, encoded per §6.
    type Request: Canonical + fmt::Debug;

    /// The response body, encoded per §6. [`Empty`] where the specification
    /// says the response carries nothing.
    type Response: Canonical + fmt::Debug;

    /// The command's own validity and self-authentication rules.
    ///
    /// `auth` is `None` for the unsigned commands of §6.1 and §12.2. The
    /// default accepts everything; the two creation commands and `BIND_SEND`
    /// override it, because for them the signature proves possession of a key
    /// carried *in the body* rather than of a key the relay has on file.
    ///
    /// # Errors
    ///
    /// Whatever the command's own rule says.
    fn check(request: &Self::Request, auth: Option<&SignedAuth>) -> Result<()> {
        let _ = (request, auth);
        Ok(())
    }

    /// The ciphertext payload this command carries, if any (§9).
    ///
    /// Exactly two commands have one — `APPEND` and `CONTACT_APPEND` — and
    /// naming them here is what lets [`CommandVerifier`] enforce the padding
    /// buckets without a match on the command code at every call site.
    fn payload(request: &Self::Request) -> Option<&Payload> {
        let _ = request;
        None
    }
}

/// The marker types, one per command code of §6.
///
/// They exist only to carry [`RelayCommand`]'s associated types; none of them
/// is ever constructed.
pub mod ops {
    use super::{
        AckRequest, AckResponse, AppendRequest, BindSendRequest, ChallengeRequest,
        ChallengeResponse, Command, ContactAppendRequest, CreateContactQueueRequest,
        CreateContactQueueResponse, CreateQueueRequest, CreateQueueResponse, Empty, ErrorCode,
        HelloRequest, HelloResponse, Payload, ProtoError, ReadRequest, ReadResponse, RelayCommand,
        Result, SignedAuth, SignedCapabilities, SubscribeResponse, keys_equal,
    };

    macro_rules! command {
        (
            $(#[$meta:meta])*
            $name:ident, $command:ident, $request:ty, $response:ty
        ) => {
            $(#[$meta])*
            #[derive(Clone, Copy, Debug, PartialEq, Eq)]
            pub struct $name;

            impl RelayCommand for $name {
                const COMMAND: Command = Command::$command;
                type Request = $request;
                type Response = $response;
            }
        };
    }

    command!(
        /// `0x0001` (§6.1). MUST be the first frame on a connection.
        Hello,
        Hello,
        HelloRequest,
        HelloResponse
    );
    command!(
        /// `0x0002` (§6.1). The response is the §11.1 document plus the
        /// relay's signature over it.
        GetCapabilities,
        GetCapabilities,
        Empty,
        SignedCapabilities
    );
    command!(
        /// `0x0003` (§6.1). Clock, single-use challenge, and current PoW
        /// parameters.
        GetChallenge,
        GetChallenge,
        ChallengeRequest,
        ChallengeResponse
    );
    command!(
        /// `0x0004` (§6.1). Application-level liveness, distinct from §2.4's
        /// WebSocket Ping, which a browser client cannot send.
        Ping,
        Ping,
        Empty,
        Empty
    );
    command!(
        /// `0x0011` (§6.2). Registers the connection for `MSG` pushes.
        Subscribe,
        Subscribe,
        Empty,
        SubscribeResponse
    );
    command!(
        /// `0x0012` (§6.2).
        ///
        /// §6.2 gives `SUBSCRIBE` and `UNSUBSCRIBE` "empty bodies" and then
        /// specifies a `SubscribeResponse`, so the empty-body sentence is about
        /// the requests. It never states `UNSUBSCRIBE`'s response shape.
        /// Reading it as empty is the only choice that does not invent a
        /// structure: there is no queue state an unsubscribe could report that
        /// `SUBSCRIBE` did not already return.
        Unsubscribe,
        Unsubscribe,
        Empty,
        Empty
    );
    command!(
        /// `0x0013` (§6.2). Never mutates.
        Read,
        Read,
        ReadRequest,
        ReadResponse
    );
    command!(
        /// `0x0014` (§6.2). Cumulative, monotone, idempotent, never selective.
        Ack,
        Ack,
        AckRequest,
        AckResponse
    );
    command!(
        /// `0x0015` (§6.2). Irreversible, and leaves no observable tombstone
        /// (§7.6).
        DeleteQueue,
        DeleteQueue,
        Empty,
        Empty
    );

    /// `0x0010` (§6.2). Both addresses come from the relay's CSPRNG (§7.1).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct CreateQueue;

    impl RelayCommand for CreateQueue {
        const COMMAND: Command = Command::CreateQueue;
        type Request = CreateQueueRequest;
        type Response = CreateQueueResponse;

        /// §6.2: the transcript's `address` is 32 zero bytes and `signer_key`
        /// MUST equal `recv_key`, so the request is self-authenticating — it
        /// proves possession of the key the new queue will be bound to.
        ///
        /// The mismatch is reported as `ERR_NO_ACCESS` rather than
        /// `ERR_BAD_SIGNATURE`: the signature is valid, and what failed is that
        /// the key which made it does not authorize the queue being asked for.
        /// That is precisely §10's code 10, and no address exists yet for it to
        /// be an oracle about.
        fn check(request: &Self::Request, auth: Option<&SignedAuth>) -> Result<()> {
            request.validate()?;
            let auth = auth.ok_or(ProtoError::Wire(ErrorCode::BadSignature))?;
            if keys_equal(&auth.signer_key, &request.recv_key) {
                Ok(())
            } else {
                Err(ProtoError::Wire(ErrorCode::NoAccess))
            }
        }
    }

    /// `0x0030` (§12.2). Like `CREATE_QUEUE`, but the second address is
    /// published and can never be bound.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct CreateContactQueue;

    impl RelayCommand for CreateContactQueue {
        const COMMAND: Command = Command::CreateContactQueue;
        type Request = CreateContactQueueRequest;
        type Response = CreateContactQueueResponse;

        /// §12.2 does not restate `CREATE_QUEUE`'s self-authentication rule,
        /// but the command has the same shape — a `recv_key` in the body, a
        /// zero address in the transcript, and no existing queue to look the
        /// signer up against — so the same rule is the only one that
        /// authenticates it at all. Applied here, and listed as an
        /// interpretation.
        fn check(request: &Self::Request, auth: Option<&SignedAuth>) -> Result<()> {
            let auth = auth.ok_or(ProtoError::Wire(ErrorCode::BadSignature))?;
            if keys_equal(&auth.signer_key, &request.recv_key) {
                Ok(())
            } else {
                Err(ProtoError::Wire(ErrorCode::NoAccess))
            }
        }
    }

    /// `0x0020` (§6.3). Once-only and irreversible (§7.3).
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct BindSend;

    impl RelayCommand for BindSend {
        const COMMAND: Command = Command::BindSend;
        type Request = BindSendRequest;
        /// **Empty by rule, not "empty for now"** (§6.3).
        type Response = Empty;

        /// §6's table has `BIND_SEND` signed by the send key, and §7.3 has the
        /// peer generating a fresh key and binding it. The send side is unbound
        /// until this command succeeds, so there is no registered key for §5.1
        /// step 5 to compare against: the only thing the signature can prove is
        /// possession of the key in the body. Requiring `signer_key ==
        /// send_key` is what makes that proof mean anything — without it a
        /// caller could bind a key it does not hold, which is the §7.4 theft
        /// with no work at all.
        fn check(request: &Self::Request, auth: Option<&SignedAuth>) -> Result<()> {
            let auth = auth.ok_or(ProtoError::Wire(ErrorCode::BadSignature))?;
            if keys_equal(&auth.signer_key, &request.send_key) {
                Ok(())
            } else {
                Err(ProtoError::Wire(ErrorCode::NoAccess))
            }
        }
    }

    /// `0x0021` (§6.3). The response body is empty and carries no queue state
    /// of any kind.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Append;

    impl RelayCommand for Append {
        const COMMAND: Command = Command::Append;
        type Request = AppendRequest;
        type Response = Empty;

        fn payload(request: &Self::Request) -> Option<&Payload> {
            Some(&request.payload)
        }
    }

    /// `0x0031` (§12.2). Unsigned; the proof-of-work stamp is the gate.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct ContactAppend;

    impl RelayCommand for ContactAppend {
        const COMMAND: Command = Command::ContactAppend;
        type Request = ContactAppendRequest;
        type Response = Empty;

        fn payload(request: &Self::Request) -> Option<&Payload> {
            Some(&request.payload)
        }
    }
}

/// A command that has been signed and is ready to send.
///
/// Constructed by [`SignedCommand::create`], which derives `signer_key` from
/// the signing key itself rather than taking it as an argument: a `SignedAuth`
/// whose `signer_key` is not the key that made the signature is a frame that
/// can only ever be refused, and there is no reason to be able to build one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedCommand<C> {
    request_id: u32,
    auth: SignedAuth,
    body: Body,
    marker: PhantomData<fn() -> C>,
}

impl<C: RelayCommand> SignedCommand<C> {
    /// Build and sign a command (§5.1).
    ///
    /// `address` is the queue address the command acts on, and MUST agree with
    /// §6's table: [`QueueAddress::zero`] for the two creation commands, the
    /// real address for everything else. `nonce` MUST be fresh from the
    /// caller's CSPRNG and `timestamp_ms` MUST be the caller's best estimate of
    /// the *relay's* clock (§5.5: a client with an unreliable clock learns the
    /// offset from `HELLO` and applies it locally, and MUST NOT set its system
    /// clock from it).
    ///
    /// # Errors
    ///
    /// - [`ErrorCode::Internal`] if `C` is an unsigned command — building a
    ///   signature for one is this process's own mistake, and §10's code 21 is
    ///   the one that carries no detail.
    /// - [`ErrorCode::Malformed`] if `request_id` is zero (§4.3) or the address
    ///   does not match §6's table for this command.
    /// - Whatever [`RelayCommand::check`] says.
    pub fn create(
        transcripts: &TranscriptBuilder,
        request_id: u32,
        address: QueueAddress,
        timestamp_ms: u64,
        nonce: Nonce,
        signing_key: &SigningKey,
        body: &C::Request,
    ) -> Result<Self> {
        if matches!(C::COMMAND.auth(), Auth::None) {
            return Err(ProtoError::Wire(ErrorCode::Internal));
        }
        if request_id == 0 {
            return Err(ProtoError::Wire(ErrorCode::Malformed));
        }
        check_transcript_address(C::COMMAND, &address)?;

        let encoded = body.encode_canonical()?;
        let context = AuthContext {
            address,
            signer_key: signing_key.public_key(),
            timestamp_ms,
            nonce,
        };
        let transcript = transcripts.build(C::COMMAND.code(), request_id, &context, &encoded)?;
        let signature = signing_key.sign(&transcript.signing_bytes()?);
        let auth = context.into_auth(signature);
        C::check(body, Some(&auth))?;

        Ok(Self {
            request_id,
            auth,
            body: Body::new(encoded)?,
            marker: PhantomData,
        })
    }

    /// The `request_id` this command was signed for. It is covered by the
    /// transcript, so it cannot be changed after the fact.
    #[must_use]
    pub const fn request_id(&self) -> u32 {
        self.request_id
    }

    /// The authenticator that will travel in the frame.
    #[must_use]
    pub const fn auth(&self) -> &SignedAuth {
        &self.auth
    }

    /// The canonical body bytes the signature covers.
    #[must_use]
    pub fn body(&self) -> &[u8] {
        self.body.as_slice()
    }

    /// The framing-layer request.
    ///
    /// # Errors
    ///
    /// [`ErrorCode::Malformed`] only if the body outgrew its length prefix,
    /// which [`SignedCommand::create`] already ruled out.
    pub fn request(&self) -> Result<Request> {
        Ok(Request::new(
            C::COMMAND.code(),
            CommandAuth::Signed(self.auth.clone()),
            self.body.as_slice().to_vec(),
        )?)
    }

    /// The whole frame, ready to encode with
    /// [`Canonical::encode_canonical`].
    ///
    /// # Errors
    ///
    /// As [`SignedCommand::request`].
    pub fn frame(&self) -> Result<RelayFrame> {
        Ok(RelayFrame::request(self.request_id, self.request()?))
    }

    /// The canonical bytes of the whole frame.
    ///
    /// # Errors
    ///
    /// As [`SignedCommand::request`].
    pub fn encode(&self) -> Result<Vec<u8>> {
        Ok(self.frame()?.encode_canonical()?)
    }
}

/// A command accepted through every check prescribed for `C`.
///
/// There is no public constructor. The only way to hold one is to have run
/// [`CommandVerifier::verify`] for a signed command, or
/// [`CommandVerifier::accept_unsigned`] for an unsigned command. The signed
/// path proves §5.1, including the timestamp window, signature, command policy,
/// and a replay key committed to that verifier's process-local [`SeenSet`]. It
/// does not attest that a relay also committed external, durable, or
/// cross-worker state. The unsigned path has no authenticator, timestamp, or
/// replay key to verify; it proves canonical encoding plus that command's own
/// rules and stores zero values in the authentication-only accessors below.
/// Holding this type therefore proves the checks for `C`'s prescribed path,
/// not that an arbitrary `Verified<C>` was authenticated.
#[derive(Debug)]
pub struct Verified<C: RelayCommand> {
    body: C::Request,
    address: QueueAddress,
    signer_key: PublicKey,
    timestamp_ms: u64,
    nonce: Nonce,
}

// Written out rather than derived: a derive would demand `C: PartialEq` and
// still not know that `C::Request` is comparable, and the thing worth comparing
// is the body.
impl<C: RelayCommand> PartialEq for Verified<C>
where
    C::Request: PartialEq,
{
    fn eq(&self, other: &Self) -> bool {
        self.body == other.body
            && self.address == other.address
            && self.signer_key == other.signer_key
            && self.timestamp_ms == other.timestamp_ms
            && self.nonce == other.nonce
    }
}

impl<C: RelayCommand> Eq for Verified<C> where C::Request: Eq {}

impl<C: RelayCommand> Verified<C> {
    /// The decoded, canonical request body.
    pub const fn body(&self) -> &C::Request {
        &self.body
    }

    /// Take the body.
    #[must_use]
    pub fn into_body(self) -> C::Request {
        self.body
    }

    /// The address the command acts on. [`QueueAddress::zero`] for the
    /// creation commands and for the unsigned commands.
    #[must_use]
    pub const fn address(&self) -> QueueAddress {
        self.address
    }

    /// For a signed command, the key that signed it — what §5.1 step 5 compares
    /// against the key registered for the address. [`PublicKey::zero`] for an
    /// unsigned command, which has no signer.
    #[must_use]
    pub const fn signer_key(&self) -> PublicKey {
        self.signer_key
    }

    /// For a signed command, the client clock it carried after the timestamp
    /// window check. Zero for an unsigned command, which carries no timestamp.
    #[must_use]
    pub const fn timestamp_ms(&self) -> u64 {
        self.timestamp_ms
    }

    /// For a signed command, its nonce after the corresponding replay key was
    /// committed to the seen-set. [`Nonce::zero`] for an unsigned command,
    /// which carries no nonce and does not touch the seen-set.
    #[must_use]
    pub const fn nonce(&self) -> Nonce {
        self.nonce
    }
}

/// The receiving half of §5: one connection's transcript builder, timestamp
/// window, seen-set and padding policy.
///
/// It holds the [`TranscriptBuilder`] rather than taking one per call for the
/// reason `f2z-codec` gives: `protocol_version`, `relay_id` and
/// `channel_binding` are constant for the life of a connection, and §5.2's
/// replay-across-relays attack and §5.3's replay-across-sessions attack are
/// both closed by exactly that. A per-command parameter would be a per-command
/// opportunity to pass the peer's value.
///
/// Cloning this value snapshots its [`SeenSet`]; it does not share replay
/// authority. Callers processing one replay domain in parallel must synchronize
/// one verifier or enforce the same atomic commit in external state. Likewise,
/// the in-memory set alone does not satisfy a durable anti-replay policy.
#[derive(Clone, Debug)]
pub struct CommandVerifier {
    transcripts: TranscriptBuilder,
    window: TimestampWindow,
    seen: SeenSet,
    padding: PaddingBuckets,
}

impl CommandVerifier {
    /// Bind a verifier to one connection.
    #[must_use]
    pub const fn new(
        transcripts: TranscriptBuilder,
        window: TimestampWindow,
        seen: SeenSet,
        padding: PaddingBuckets,
    ) -> Self {
        Self {
            transcripts,
            window,
            seen,
            padding,
        }
    }

    /// This connection's transcript builder.
    #[must_use]
    pub const fn transcripts(&self) -> &TranscriptBuilder {
        &self.transcripts
    }

    /// The seen-set, for an operator that wants to sweep or measure it.
    #[must_use]
    pub const fn seen_set(&self) -> &SeenSet {
        &self.seen
    }

    /// The seen-set, mutably.
    pub const fn seen_set_mut(&mut self) -> &mut SeenSet {
        &mut self.seen
    }

    /// The published padding buckets this verifier enforces (§9).
    #[must_use]
    pub const fn padding(&self) -> &PaddingBuckets {
        &self.padding
    }

    /// Verify a signed command, in §5.1's order.
    ///
    /// `now_ms` is the relay's clock. `request_id` is the frame's, not the
    /// body's — it is covered by the transcript, so a relay that passes a
    /// different one here will simply fail to verify, which is the intent.
    ///
    /// # Errors
    ///
    /// - [`ErrorCode::Internal`] if `request` is not for `C` at all. Dispatching
    ///   to the wrong handler is a relay fault, and §10's code 21 is the one
    ///   that carries no detail — telling the peer would be describing our own
    ///   internals to an unauthenticated caller.
    /// - [`ErrorCode::BadSignature`] if a signed command arrived unsigned, if
    ///   the signer key is not a curve point, or if the signature does not
    ///   verify. A missing signature is not `ERR_MALFORMED`: the frame is
    ///   well-formed and §10's fatal codes are for framing failures, so a
    ///   client that forgot to sign gets a non-fatal answer and may retry.
    /// - [`ErrorCode::Malformed`] if the body is not canonical (§3.3) or the
    ///   transcript address does not match §6's table. Both are fatal.
    /// - [`ErrorCode::StaleTimestamp`], [`ErrorCode::Replay`] or
    ///   [`ErrorCode::Backpressure`] from the anti-replay layer.
    /// - [`ErrorCode::NoAccess`] from a self-authentication rule.
    /// - [`ErrorCode::BadSize`] if the payload is not exactly one of the
    ///   published padding sizes (§9).
    pub fn verify<C: RelayCommand>(
        &mut self,
        now_ms: u64,
        request_id: u32,
        request: &Request,
    ) -> Result<Verified<C>> {
        if request.command != C::COMMAND.code() {
            return Err(ProtoError::Wire(ErrorCode::Internal));
        }
        if matches!(C::COMMAND.auth(), Auth::None) {
            return Err(ProtoError::Wire(ErrorCode::Internal));
        }
        let auth = match &request.auth {
            CommandAuth::Signed(auth) => auth,
            // A command that must be signed and was not. Non-fatal: nothing
            // about the framing was wrong.
            CommandAuth::Unsigned => return Err(ProtoError::Wire(ErrorCode::BadSignature)),
        };

        // Step 1, body half. The frame's re-encode equality has already been
        // proved by `f2z-codec`; the opaque body inside it has not, and the
        // bytes a signature covers are these.
        let body = decode_canonical::<C::Request>(request.body())?;

        // Step 2.
        self.window.check(now_ms, auth.timestamp_ms)?;
        // Step 3 checks only. Inserting an unauthenticated pair here would let
        // random invalid signatures consume the bounded global replay set.
        let replay_key = ReplayKey::new(auth.signer_key, auth.nonce);
        self.seen.preflight(now_ms, &replay_key)?;

        // Step 4. `relay_id` and `channel_binding` come from `self`; only the
        // rest comes from the frame.
        let verifying_key = crate::key::VerifyingKey::from_public_key(&auth.signer_key)?;
        let transcript = self.transcripts.rebuild_from_auth(
            C::COMMAND.code(),
            request_id,
            auth,
            body.bytes(),
        )?;
        verifying_key.verify(&transcript.signing_bytes()?, &auth.signature)?;

        // Step 5, frame half.
        check_transcript_address(C::COMMAND, &auth.address)?;
        C::check(body.value(), Some(auth))?;

        // Step 6.
        if let Some(payload) = C::payload(body.value()) {
            self.padding.validate_payload(payload)?;
        }

        // Commit only after authentication and every command check succeeds.
        // `commit` repeats the membership and capacity checks so two callers
        // that both won preflight cannot both accept the same pair.
        self.seen.commit(now_ms, replay_key)?;

        Ok(Verified {
            address: auth.address,
            signer_key: auth.signer_key,
            timestamp_ms: auth.timestamp_ms,
            nonce: auth.nonce,
            body: body.into_value(),
        })
    }

    /// Accept an unsigned command (§6.1, §12.2).
    ///
    /// There is no timestamp, no nonce and no signature to check, so this is
    /// §3.3 on the body plus the command's own rules. The gate on
    /// `CONTACT_APPEND` is a proof-of-work stamp over a relay-issued,
    /// single-use, expiring challenge (§12.3) — challenge issuance and
    /// consumption are relay state, so this crate checks the stamp's hash
    /// through `f2z-codec` and leaves the rest to the relay.
    ///
    /// # Errors
    ///
    /// - [`ErrorCode::Internal`] if `request` is not for `C`, or if `C` is a
    ///   signed command.
    /// - [`ErrorCode::Malformed`] if the frame carries a `SignedAuth` for a
    ///   command that has no transcript. That one *is* fatal: §5.1 has no
    ///   verification path for it, so accepting the frame would mean carrying
    ///   an authenticator nothing ever checks.
    /// - [`ErrorCode::BadSize`] if the payload is not exactly one of the
    ///   published padding sizes (§9).
    pub fn accept_unsigned<C: RelayCommand>(&self, request: &Request) -> Result<Verified<C>> {
        if request.command != C::COMMAND.code() {
            return Err(ProtoError::Wire(ErrorCode::Internal));
        }
        if !matches!(C::COMMAND.auth(), Auth::None) {
            return Err(ProtoError::Wire(ErrorCode::Internal));
        }
        if request.auth.signed().is_some() {
            return Err(ProtoError::Wire(ErrorCode::Malformed));
        }

        let body = decode_canonical::<C::Request>(request.body())?;
        C::check(body.value(), None)?;
        if let Some(payload) = C::payload(body.value()) {
            self.padding.validate_payload(payload)?;
        }

        Ok(Verified {
            address: QueueAddress::zero(),
            signer_key: PublicKey::zero(),
            timestamp_ms: 0,
            nonce: Nonce::zero(),
            body: body.into_value(),
        })
    }
}

/// §6's table, as a check: the transcript's `address` is zeros for the creation
/// commands and a real address for the rest.
///
/// The zero address is the sentinel for "no queue exists yet", so a non-creation
/// command carrying it is a command about no queue at all. `ERR_MALFORMED` is
/// the reading implemented here — the frame is not a valid instance of its own
/// command — and it is fatal, which is the right direction: this is not a state
/// disagreement between honest peers, it is a frame no conforming client emits.
fn check_transcript_address(command: Command, address: &QueueAddress) -> Result<()> {
    let ok = match command.transcript_address() {
        TranscriptAddress::Zeros => address.is_zero(),
        TranscriptAddress::RecvAddr | TranscriptAddress::SendAddr => !address.is_zero(),
        // Unsigned: there is no transcript, so there is nothing to check.
        TranscriptAddress::None => true,
    };
    if ok {
        Ok(())
    } else {
        Err(ProtoError::Wire(ErrorCode::Malformed))
    }
}

/// The unsigned `HELLO` request frame that MUST be a connection's first frame
/// (§2.5).
///
/// # Errors
///
/// [`ErrorCode::Malformed`] if `request_id` is zero (§4.3).
pub fn hello_request(request_id: u32, body: &HelloRequest) -> Result<RelayFrame> {
    unsigned_request::<ops::Hello>(request_id, body)
}

/// Build any unsigned request frame (§6.1, §12.2).
///
/// # Errors
///
/// - [`ErrorCode::Internal`] if `C` is a signed command.
/// - [`ErrorCode::Malformed`] if `request_id` is zero (§4.3).
pub fn unsigned_request<C: RelayCommand>(request_id: u32, body: &C::Request) -> Result<RelayFrame> {
    if !matches!(C::COMMAND.auth(), Auth::None) {
        return Err(ProtoError::Wire(ErrorCode::Internal));
    }
    if request_id == 0 {
        return Err(ProtoError::Wire(ErrorCode::Malformed));
    }
    let request = Request::new(
        C::COMMAND.code(),
        CommandAuth::Unsigned,
        body.encode_canonical()?,
    )?;
    Ok(RelayFrame::request(request_id, request))
}

/// Every command's protocol version, restated so a caller building a
/// [`TranscriptBuilder`] does not have to reach into `f2z-codec` for it.
pub const VERSION: u16 = PROTOCOL_VERSION;

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;
    use f2z_codec::pow::PowStamp;
    use f2z_codec::types::{ChannelBinding, RelayId};

    fn transcripts() -> TranscriptBuilder {
        TranscriptBuilder::new(
            VERSION,
            RelayId::new([0xaa; 32]),
            ChannelBinding::new([0xbb; 32]),
        )
    }

    fn verifier() -> CommandVerifier {
        CommandVerifier::new(
            transcripts(),
            TimestampWindow::default(),
            SeenSet::new(240_000, 1024),
            PaddingBuckets::default(),
        )
    }

    fn nonce(byte: u8) -> Nonce {
        Nonce::new([byte; 16])
    }

    const NOW: u64 = 1_800_000_000_000;

    /// Assemble a request frame the way a hostile client would, rather than
    /// the way [`SignedCommand::create`] permits.
    ///
    /// `create` derives `signer_key` from the signing key it is handed and
    /// runs [`check_transcript_address`] and `C::check` before it returns, so
    /// **every frame it can produce has already satisfied §5.1 step 5**. That
    /// makes it structurally unable to express the frame step 5 exists to
    /// refuse, and a test that only calls `create` therefore says nothing
    /// about [`CommandVerifier::verify`] — which is the side a relay runs
    /// against input it did not author.
    ///
    /// This builds the same bytes from the parts, with a *genuine* signature
    /// over exactly the `address` and `signer_key` named, so verification
    /// reaches step 5 instead of stopping at step 4's `ERR_BAD_SIGNATURE`.
    fn hostile_request<C: RelayCommand>(
        request_id: u32,
        address: QueueAddress,
        nonce: Nonce,
        signing_key: &SigningKey,
        body: &C::Request,
    ) -> Request {
        let encoded = body.encode_canonical().unwrap();
        let context = AuthContext {
            address,
            signer_key: signing_key.public_key(),
            timestamp_ms: NOW,
            nonce,
        };
        let transcript = transcripts()
            .build(C::COMMAND.code(), request_id, &context, &encoded)
            .unwrap();
        let auth = context.into_auth(signing_key.sign(&transcript.signing_bytes().unwrap()));
        Request::new(C::COMMAND.code(), CommandAuth::Signed(auth), encoded).unwrap()
    }

    #[test]
    fn verify_refuses_a_bind_send_whose_signer_is_not_the_key_it_binds() {
        // §7.4's send-capability theft, as a frame. The send side is unbound,
        // so the only thing the signature can prove is possession of the key
        // in the body; a caller that signs with its own key and names someone
        // else's `send_key` is binding a key it does not hold.
        let thief = SigningKey::from_seed(&[0x21; 32]);
        let victim = SigningKey::from_seed(&[0x22; 32]);
        let address = QueueAddress::new([0x23; 32]);

        // Control: the same construction, signer and `send_key` agreeing, is
        // accepted. Without this the refusal below could be any other step.
        let honest = hostile_request::<ops::BindSend>(
            1,
            address,
            nonce(0x21),
            &thief,
            &BindSendRequest {
                send_key: thief.public_key(),
            },
        );
        assert!(verifier().verify::<ops::BindSend>(NOW, 1, &honest).is_ok());

        let stolen = hostile_request::<ops::BindSend>(
            1,
            address,
            nonce(0x22),
            &thief,
            &BindSendRequest {
                send_key: victim.public_key(),
            },
        );
        let mut verifier = verifier();
        assert_eq!(
            verifier
                .verify::<ops::BindSend>(NOW, 1, &stolen)
                .map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::NoAccess))
        );
        assert!(
            verifier.seen_set().is_empty(),
            "an authenticated but unauthorized frame must not consume replay capacity"
        );
    }

    #[test]
    fn verify_refuses_a_create_queue_whose_signer_is_not_the_key_it_registers() {
        // The same rule on the other command that carries its own key: a
        // queue registered against a `recv_key` its creator does not hold is
        // a queue whose ciphertext the creator can never read and someone
        // else can.
        let caller = SigningKey::from_seed(&[0x24; 32]);
        let stranger = SigningKey::from_seed(&[0x25; 32]);
        let body = |recv_key| CreateQueueRequest {
            recv_key,
            req_message_ttl_seconds: 0,
            req_idle_ttl_seconds: 0,
            flags: 0,
            stamp: PowStamp::empty(),
        };

        let honest = hostile_request::<ops::CreateQueue>(
            2,
            QueueAddress::zero(),
            nonce(0x24),
            &caller,
            &body(caller.public_key()),
        );
        assert!(
            verifier()
                .verify::<ops::CreateQueue>(NOW, 2, &honest)
                .is_ok()
        );

        let hijacked = hostile_request::<ops::CreateQueue>(
            2,
            QueueAddress::zero(),
            nonce(0x25),
            &caller,
            &body(stranger.public_key()),
        );
        assert_eq!(
            verifier()
                .verify::<ops::CreateQueue>(NOW, 2, &hijacked)
                .map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::NoAccess))
        );
    }

    #[test]
    fn verify_refuses_a_frame_whose_transcript_address_contradicts_its_command() {
        // §6's table both ways. The zero address is the sentinel for "no queue
        // exists yet", so an `ACK` carrying it is an acknowledgement of no
        // queue at all, and a `CREATE_QUEUE` carrying a real one is a creation
        // command about a queue that already exists.
        let key = SigningKey::from_seed(&[0x26; 32]);
        let real = QueueAddress::new([0x27; 32]);

        let acknowledgement = |address| {
            hostile_request::<ops::Ack>(
                3,
                address,
                nonce(0x26),
                &key,
                &AckRequest { up_to_index: 1 },
            )
        };
        assert!(
            verifier()
                .verify::<ops::Ack>(NOW, 3, &acknowledgement(real))
                .is_ok()
        );
        assert_eq!(
            verifier()
                .verify::<ops::Ack>(NOW, 3, &acknowledgement(QueueAddress::zero()))
                .map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );

        let creation = |address| {
            hostile_request::<ops::CreateQueue>(
                4,
                address,
                nonce(0x27),
                &key,
                &CreateQueueRequest {
                    recv_key: key.public_key(),
                    req_message_ttl_seconds: 0,
                    req_idle_ttl_seconds: 0,
                    flags: 0,
                    stamp: PowStamp::empty(),
                },
            )
        };
        assert!(
            verifier()
                .verify::<ops::CreateQueue>(NOW, 4, &creation(QueueAddress::zero()))
                .is_ok()
        );
        assert_eq!(
            verifier()
                .verify::<ops::CreateQueue>(NOW, 4, &creation(real))
                .map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );
    }

    #[test]
    fn a_signed_append_round_trips_through_verification() {
        let key = SigningKey::from_seed(&[1u8; 32]);
        let address = QueueAddress::new([9u8; 32]);
        let body = AppendRequest {
            payload: Payload::new(vec![0u8; 1024]).unwrap(),
        };
        let signed = SignedCommand::<ops::Append>::create(
            &transcripts(),
            7,
            address,
            NOW,
            nonce(1),
            &key,
            &body,
        )
        .unwrap();

        let frame = signed.frame().unwrap();
        let bytes = frame.encode_canonical().unwrap();
        let decoded = decode_canonical::<RelayFrame>(&bytes).unwrap();
        assert_eq!(decoded.value(), &frame);

        let verified = verifier()
            .verify::<ops::Append>(NOW, 7, &signed.request().unwrap())
            .unwrap();
        assert_eq!(verified.address(), address);
        assert_eq!(verified.signer_key(), key.public_key());
        assert_eq!(verified.body(), &body);
    }

    #[test]
    fn verified_metadata_matches_the_signed_or_unsigned_acceptance_path() {
        let key = SigningKey::from_seed(&[0x81; 32]);
        let signer_key = key.public_key();
        let signed_address = QueueAddress::new([0x83; 32]);
        let signed_nonce = nonce(0x82);
        let verification_now = NOW + 1;
        let signed = SignedCommand::<ops::Append>::create(
            &transcripts(),
            17,
            signed_address,
            NOW,
            signed_nonce,
            &key,
            &AppendRequest {
                payload: Payload::new(vec![0u8; 1024]).unwrap(),
            },
        )
        .unwrap();
        let mut verifier = verifier();

        let verified_signed = verifier
            .verify::<ops::Append>(verification_now, 17, &signed.request().unwrap())
            .unwrap();
        assert_eq!(verified_signed.address(), signed_address);
        assert_eq!(verified_signed.signer_key(), signer_key);
        assert_eq!(verified_signed.timestamp_ms(), NOW);
        assert_eq!(verified_signed.nonce(), signed_nonce);
        assert!(
            verifier
                .seen_set()
                .contains(&ReplayKey::new(signer_key, signed_nonce)),
            "returning the signed result must imply its replay key is committed"
        );

        let unsigned =
            Request::new(Command::Ping.code(), CommandAuth::Unsigned, Vec::new()).unwrap();
        let verified_unsigned = verifier.accept_unsigned::<ops::Ping>(&unsigned).unwrap();
        assert_eq!(verified_unsigned.address(), QueueAddress::zero());
        assert_eq!(verified_unsigned.signer_key(), PublicKey::zero());
        assert_eq!(verified_unsigned.timestamp_ms(), 0);
        assert_eq!(verified_unsigned.nonce(), Nonce::zero());
        assert_eq!(
            verifier.seen_set().len(),
            1,
            "the unsigned path must not create a replay-set entry"
        );
    }

    #[test]
    fn a_signature_made_for_one_relay_fails_at_another() {
        let key = SigningKey::from_seed(&[2u8; 32]);
        let signed = SignedCommand::<ops::Ack>::create(
            &transcripts(),
            3,
            QueueAddress::new([5u8; 32]),
            NOW,
            nonce(2),
            &key,
            &AckRequest { up_to_index: 4 },
        )
        .unwrap();

        let mut elsewhere = CommandVerifier::new(
            TranscriptBuilder::new(
                VERSION,
                RelayId::new([0xcc; 32]),
                ChannelBinding::new([0xbb; 32]),
            ),
            TimestampWindow::default(),
            SeenSet::new(240_000, 16),
            PaddingBuckets::default(),
        );
        assert_eq!(
            elsewhere.verify::<ops::Ack>(NOW, 3, &signed.request().unwrap()),
            Err(ProtoError::Wire(ErrorCode::BadSignature))
        );
        assert!(
            elsewhere.seen_set().is_empty(),
            "an unauthenticated frame must not consume replay capacity"
        );
    }

    #[test]
    fn the_request_id_is_covered_by_the_transcript() {
        let key = SigningKey::from_seed(&[3u8; 32]);
        let signed = SignedCommand::<ops::Read>::create(
            &transcripts(),
            11,
            QueueAddress::new([5u8; 32]),
            NOW,
            nonce(3),
            &key,
            &ReadRequest {
                from_index: 0,
                max_messages: 8,
                max_bytes: 4096,
            },
        )
        .unwrap();
        assert_eq!(
            verifier().verify::<ops::Read>(NOW, 12, &signed.request().unwrap()),
            Err(ProtoError::Wire(ErrorCode::BadSignature))
        );
    }

    #[test]
    fn a_replayed_frame_is_refused_on_the_second_presentation() {
        let key = SigningKey::from_seed(&[4u8; 32]);
        let signed = SignedCommand::<ops::Subscribe>::create(
            &transcripts(),
            2,
            QueueAddress::new([6u8; 32]),
            NOW,
            nonce(4),
            &key,
            &Empty,
        )
        .unwrap();
        let request = signed.request().unwrap();
        let mut verifier = verifier();
        assert!(verifier.verify::<ops::Subscribe>(NOW, 2, &request).is_ok());
        assert_eq!(
            verifier.verify::<ops::Subscribe>(NOW, 2, &request),
            Err(ProtoError::Wire(ErrorCode::Replay))
        );
        assert_eq!(
            verifier.verify::<ops::Subscribe>(NOW, 3, &request),
            Err(ProtoError::Wire(ErrorCode::Replay)),
            "seen-set preflight must reject before the changed request id makes the signature fail"
        );
    }

    #[test]
    fn the_timestamp_window_is_checked_before_the_signature() {
        let key = SigningKey::from_seed(&[5u8; 32]);
        let signed = SignedCommand::<ops::Subscribe>::create(
            &transcripts(),
            2,
            QueueAddress::new([6u8; 32]),
            NOW,
            nonce(5),
            &key,
            &Empty,
        )
        .unwrap();
        let mut verifier = verifier();
        assert_eq!(
            verifier.verify::<ops::Subscribe>(NOW + 120_001, 2, &signed.request().unwrap()),
            Err(ProtoError::Wire(ErrorCode::StaleTimestamp))
        );
        // …and a stale frame did not consume a seen-set slot.
        assert!(verifier.seen_set().is_empty());
    }

    #[test]
    fn create_queue_must_be_signed_by_the_key_it_registers() {
        let key = SigningKey::from_seed(&[6u8; 32]);
        let other = SigningKey::from_seed(&[7u8; 32]);
        let body = CreateQueueRequest {
            recv_key: other.public_key(),
            req_message_ttl_seconds: 0,
            req_idle_ttl_seconds: 0,
            flags: 0,
            stamp: PowStamp::empty(),
        };
        assert_eq!(
            SignedCommand::<ops::CreateQueue>::create(
                &transcripts(),
                1,
                QueueAddress::zero(),
                NOW,
                nonce(6),
                &key,
                &body,
            ),
            Err(ProtoError::Wire(ErrorCode::NoAccess))
        );
    }

    #[test]
    fn create_queue_must_carry_the_zero_address() {
        let key = SigningKey::from_seed(&[8u8; 32]);
        let body = CreateQueueRequest {
            recv_key: key.public_key(),
            req_message_ttl_seconds: 0,
            req_idle_ttl_seconds: 0,
            flags: 0,
            stamp: PowStamp::empty(),
        };
        assert_eq!(
            SignedCommand::<ops::CreateQueue>::create(
                &transcripts(),
                1,
                QueueAddress::new([1u8; 32]),
                NOW,
                nonce(7),
                &key,
                &body,
            ),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );
        assert!(
            SignedCommand::<ops::CreateQueue>::create(
                &transcripts(),
                1,
                QueueAddress::zero(),
                NOW,
                nonce(7),
                &key,
                &body,
            )
            .is_ok()
        );
    }

    #[test]
    fn bind_send_must_be_signed_by_the_key_it_binds() {
        let key = SigningKey::from_seed(&[9u8; 32]);
        let other = SigningKey::from_seed(&[10u8; 32]);
        assert_eq!(
            SignedCommand::<ops::BindSend>::create(
                &transcripts(),
                1,
                QueueAddress::new([2u8; 32]),
                NOW,
                nonce(8),
                &key,
                &BindSendRequest {
                    send_key: other.public_key()
                },
            ),
            Err(ProtoError::Wire(ErrorCode::NoAccess))
        );
    }

    #[test]
    fn an_append_outside_the_padding_buckets_is_bad_size() {
        let key = SigningKey::from_seed(&[11u8; 32]);
        let signed = SignedCommand::<ops::Append>::create(
            &transcripts(),
            4,
            QueueAddress::new([3u8; 32]),
            NOW,
            nonce(9),
            &key,
            &AppendRequest {
                payload: Payload::new(vec![0u8; 1023]).unwrap(),
            },
        )
        .unwrap();
        let mut verifier = verifier();
        assert_eq!(
            verifier.verify::<ops::Append>(NOW, 4, &signed.request().unwrap()),
            Err(ProtoError::Wire(ErrorCode::BadSize))
        );
        assert!(
            verifier.seen_set().is_empty(),
            "a frame rejected by policy must not consume replay capacity"
        );
    }

    #[test]
    fn a_signed_command_that_arrives_unsigned_is_not_fatal() {
        let request = Request::new(
            Command::Ack.code(),
            CommandAuth::Unsigned,
            AckRequest { up_to_index: 1 }.encode_canonical().unwrap(),
        )
        .unwrap();
        let error = verifier().verify::<ops::Ack>(NOW, 1, &request).unwrap_err();
        assert_eq!(error, ProtoError::Wire(ErrorCode::BadSignature));
        assert!(!error.is_fatal());
    }

    #[test]
    fn an_unsigned_command_that_arrives_signed_is_fatal() {
        let key = SigningKey::from_seed(&[12u8; 32]);
        let auth = AuthContext {
            address: QueueAddress::zero(),
            signer_key: key.public_key(),
            timestamp_ms: NOW,
            nonce: nonce(10),
        }
        .into_auth(key.sign(b"whatever"));
        let request =
            Request::new(Command::Ping.code(), CommandAuth::Signed(auth), Vec::new()).unwrap();
        let error = verifier()
            .accept_unsigned::<ops::Ping>(&request)
            .unwrap_err();
        assert_eq!(error, ProtoError::Wire(ErrorCode::Malformed));
        assert!(error.is_fatal());
    }

    #[test]
    fn a_non_canonical_body_is_malformed_even_inside_a_canonical_frame() {
        let key = SigningKey::from_seed(&[13u8; 32]);
        let signed = SignedCommand::<ops::Ack>::create(
            &transcripts(),
            5,
            QueueAddress::new([4u8; 32]),
            NOW,
            nonce(11),
            &key,
            &AckRequest { up_to_index: 3 },
        )
        .unwrap();
        // One trailing byte inside the opaque body. The frame still re-encodes
        // byte-identically, which is exactly why the body needs its own §3.3.
        let mut body = signed.body().to_vec();
        body.push(0);
        let request = Request::new(
            Command::Ack.code(),
            CommandAuth::Signed(signed.auth().clone()),
            body,
        )
        .unwrap();
        assert_eq!(
            verifier().verify::<ops::Ack>(NOW, 5, &request),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );
    }

    #[test]
    fn dispatching_to_the_wrong_handler_is_a_relay_fault() {
        let key = SigningKey::from_seed(&[14u8; 32]);
        let signed = SignedCommand::<ops::Ack>::create(
            &transcripts(),
            6,
            QueueAddress::new([4u8; 32]),
            NOW,
            nonce(12),
            &key,
            &AckRequest { up_to_index: 3 },
        )
        .unwrap();
        assert_eq!(
            verifier().verify::<ops::Read>(NOW, 6, &signed.request().unwrap()),
            Err(ProtoError::Wire(ErrorCode::Internal))
        );
    }

    #[test]
    fn unsigned_commands_cannot_be_signed_and_signed_ones_cannot_be_unsigned() {
        let key = SigningKey::from_seed(&[15u8; 32]);
        assert_eq!(
            SignedCommand::<ops::Ping>::create(
                &transcripts(),
                1,
                QueueAddress::zero(),
                NOW,
                nonce(13),
                &key,
                &Empty,
            ),
            Err(ProtoError::Wire(ErrorCode::Internal))
        );
        assert_eq!(
            unsigned_request::<ops::Ack>(1, &AckRequest { up_to_index: 0 }).map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::Internal))
        );
    }

    #[test]
    fn an_unsigned_contact_append_is_accepted_and_size_checked() {
        let good = ContactAppendRequest {
            contact_addr: QueueAddress::new([7u8; 32]),
            payload: Payload::new(vec![0u8; 4096]).unwrap(),
            stamp: PowStamp::empty(),
        };
        let frame = unsigned_request::<ops::ContactAppend>(1, &good).unwrap();
        let f2z_codec::frame::FramePayload::Request(request) = &frame.payload else {
            unreachable!()
        };
        assert!(
            verifier()
                .accept_unsigned::<ops::ContactAppend>(request)
                .is_ok()
        );

        let bad = ContactAppendRequest {
            payload: Payload::new(vec![0u8; 4097]).unwrap(),
            ..good
        };
        let frame = unsigned_request::<ops::ContactAppend>(1, &bad).unwrap();
        let f2z_codec::frame::FramePayload::Request(request) = &frame.payload else {
            unreachable!()
        };
        assert_eq!(
            verifier()
                .accept_unsigned::<ops::ContactAppend>(request)
                .map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::BadSize))
        );
    }

    #[test]
    fn an_empty_body_rejects_anything_but_zero_bytes() {
        let request = Request::new(Command::Ping.code(), CommandAuth::Unsigned, vec![0u8]).unwrap();
        assert_eq!(
            verifier()
                .accept_unsigned::<ops::Ping>(&request)
                .map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );
    }

    #[test]
    fn hello_is_an_unsigned_frame_with_a_nonzero_request_id() {
        let body = HelloRequest {
            min_version: 1,
            max_version: 1,
            client_nonce: f2z_codec::types::Challenge::new([1u8; 32]),
        };
        assert!(hello_request(1, &body).is_ok());
        assert_eq!(
            hello_request(0, &body).map(|_| ()),
            Err(ProtoError::Wire(ErrorCode::Malformed))
        );
    }
}
