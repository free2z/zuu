use std::str::FromStr;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use std::{
    fmt::Write as _,
    fs::{File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use rand::{RngCore, rngs::OsRng};
use secrecy::ExposeSecret;
use sha2::{Digest, Sha256};
use zcash_client_backend::data_api::wallet::{
    ConfirmationsPolicy, CreateErrT, LockRequest, ProposeTransferErrT, SpendingKeys,
    create_proposed_transactions,
    input_selection::{GreedyInputSelector, SpendPolicy},
    propose_transfer,
};
use zcash_client_backend::data_api::{InputSource, WalletCommitmentTrees, WalletRead, WalletWrite};
use zcash_client_backend::fees::DustOutputPolicy;
use zcash_client_backend::fees::zip317::SingleOutputChangeStrategy;
use zcash_client_backend::proposal::Proposal;
use zcash_client_backend::proto::service::{RawTransaction, TxFilter};
use zcash_client_backend::wallet::OvkPolicy;
use zcash_keys::address::Address;
use zcash_primitives::transaction::{TxVersion, fees::zip317::FeeRule as Zip317FeeRule};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::PoolType;
use zcash_protocol::consensus;
use zcash_protocol::memo::{Memo, MemoBytes};
use zcash_protocol::value::Zatoshis;
use zcash_protocol::{ShieldedPool, TxId};

use crate::error::{Error, Result};
use crate::models::{
    AddressValidation, BroadcastStatus, ExecuteSendResult, PaymentRequest, PendingSendStatus,
    SaplingParamsStatus, SendConfirmation, SendPaymentReview, SendProposal, SendReview,
};
use crate::wallet::client::connect_to_lightwalletd;
use crate::wallet::keys;
use crate::wallet::{WalletProposal, WalletState};

/// A transaction that has already been created in the wallet database.
/// Retrying this record always rebroadcasts `raw_transaction`; it never signs
/// or creates another transaction for the same proposal.
#[derive(Clone, serde::Deserialize, serde::Serialize)]
pub struct PendingBroadcast {
    wallet_id: String,
    pub(super) proposal_id: u32,
    txid: String,
    txid_bytes: Vec<u8>,
    raw_transaction: Vec<u8>,
    status: BroadcastStatus,
    message: Option<String>,
    attempts: u32,
    #[serde(default)]
    had_ambiguous_attempt: bool,
    #[serde(default)]
    recovery_error: Option<String>,
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const INTERRUPTED_CREATION_RECOVERY_ERROR: &str = "Transaction creation was interrupted; automatic rebroadcast is unavailable. Inspect wallet history before creating another payment.";
// A consensus-valid transaction is far smaller than this even after JSON's
// integer-array expansion. Bound both allocation and streaming reads so a
// local malformed journal cannot exhaust process memory during startup.
const MAX_PENDING_JOURNAL_BYTES: u64 = 32 * 1024 * 1024;
const SEND_REVIEW_VERSION: u32 = 2;
const SEND_REVIEW_DOMAIN: &[u8] = b"ZUULI_SEND_REVIEW\0";
const SEND_PROPOSAL_TOKEN_DOMAIN: &[u8] = b"ZUULI_SEND_PROPOSAL_TOKEN\0";
const SEND_CONFIRMATION_TOKEN_DOMAIN: &[u8] = b"ZUULI_SEND_CONFIRMATION_TOKEN\0";
const SEND_FEE_POLICY: &str = "zip317-standard";
const SEND_CHANGE_POLICY: &str = "zip317-shielded-auto";
const SEND_CONFIRMATION_TTL: Duration = Duration::from_secs(2 * 60);

fn proposal_lock_request() -> Option<LockRequest> {
    // The process-local send state machine already serializes proposal and
    // execution. Preserve the pre-locking API behavior until durable owner and
    // unlock recovery semantics are designed together.
    None
}

fn proposed_transaction_version() -> Option<TxVersion> {
    // Let librustzcash select the consensus transaction version for the target
    // height, matching the behavior before this argument was introduced.
    None
}

type NativeSendChangeStrategy<DbT> = SingleOutputChangeStrategy<Zip317FeeRule, DbT>;
type NativeSendProposalError<DbT> = ProposeTransferErrT<
    DbT,
    zcash_client_sqlite::wallet::commitment_tree::Error,
    GreedyInputSelector<DbT>,
    NativeSendChangeStrategy<DbT>,
>;

/// The single production authority for money-affecting proposal policy. Both
/// fixed-amount sends and every send-all retry cross this exact boundary.
#[allow(clippy::type_complexity)]
fn propose_native_send_with_policy<DbT, ParamsT>(
    db: &mut DbT,
    params: &ParamsT,
    account_id: <DbT as InputSource>::AccountId,
    request: zip321::TransactionRequest,
    spend_policy: &SpendPolicy,
) -> std::result::Result<
    Proposal<Zip317FeeRule, <DbT as InputSource>::NoteRef>,
    NativeSendProposalError<DbT>,
>
where
    DbT: WalletWrite + InputSource<Error = <DbT as WalletRead>::Error>,
    <DbT as InputSource>::NoteRef: Copy + Eq + Ord,
    ParamsT: consensus::Parameters + Clone,
{
    let input_selector = GreedyInputSelector::new();
    let change_strategy = SingleOutputChangeStrategy::new(
        Zip317FeeRule::standard(),
        None,
        ShieldedPool::Orchard,
        DustOutputPolicy::default(),
    );

    propose_transfer::<_, _, _, _, zcash_client_sqlite::wallet::commitment_tree::Error>(
        db,
        params,
        account_id,
        &input_selector,
        &change_strategy,
        request,
        ConfirmationsPolicy::default(),
        spend_policy,
        proposal_lock_request(),
        proposed_transaction_version(),
    )
}

#[allow(clippy::type_complexity)]
fn propose_native_send<DbT, ParamsT>(
    db: &mut DbT,
    params: &ParamsT,
    account_id: <DbT as InputSource>::AccountId,
    request: zip321::TransactionRequest,
) -> std::result::Result<
    Proposal<Zip317FeeRule, <DbT as InputSource>::NoteRef>,
    NativeSendProposalError<DbT>,
>
where
    DbT: WalletWrite + InputSource<Error = <DbT as WalletRead>::Error>,
    <DbT as InputSource>::NoteRef: Copy + Eq + Ord,
    ParamsT: consensus::Parameters + Clone,
{
    propose_native_send_with_policy(db, params, account_id, request, &SpendPolicy::default())
}

#[allow(clippy::type_complexity)]
fn propose_fixed_native_send<DbT, ParamsT>(
    db: &mut DbT,
    params: &ParamsT,
    account_id: <DbT as InputSource>::AccountId,
    request: zip321::TransactionRequest,
) -> std::result::Result<
    Proposal<Zip317FeeRule, <DbT as InputSource>::NoteRef>,
    NativeSendProposalError<DbT>,
>
where
    DbT: WalletWrite + InputSource<Error = <DbT as WalletRead>::Error>,
    <DbT as InputSource>::NoteRef: Copy + Eq + Ord,
    ParamsT: consensus::Parameters + Clone,
{
    propose_native_send(db, params, account_id, request)
}

#[allow(clippy::type_complexity)]
fn propose_send_all_native_attempt<DbT, ParamsT>(
    db: &mut DbT,
    params: &ParamsT,
    account_id: <DbT as InputSource>::AccountId,
    request: zip321::TransactionRequest,
) -> std::result::Result<
    Proposal<Zip317FeeRule, <DbT as InputSource>::NoteRef>,
    NativeSendProposalError<DbT>,
>
where
    DbT: WalletWrite + InputSource<Error = <DbT as WalletRead>::Error>,
    <DbT as InputSource>::NoteRef: Copy + Eq + Ord,
    ParamsT: consensus::Parameters + Clone,
{
    propose_native_send(db, params, account_id, request)
}

type NativeSendCreationError<DbT> = CreateErrT<
    DbT,
    std::convert::Infallible,
    Zip317FeeRule,
    std::convert::Infallible,
    <DbT as InputSource>::NoteRef,
>;

/// The single production authority for transaction creation and outgoing
/// viewing-key retention.
#[allow(clippy::type_complexity)]
fn create_native_send_transactions<DbT, ParamsT>(
    db: &mut DbT,
    params: &ParamsT,
    prover: &LocalTxProver,
    spending_keys: &SpendingKeys,
    proposal: &Proposal<Zip317FeeRule, <DbT as InputSource>::NoteRef>,
) -> std::result::Result<nonempty::NonEmpty<TxId>, NativeSendCreationError<DbT>>
where
    DbT: WalletWrite + WalletCommitmentTrees + InputSource,
    ParamsT: consensus::Parameters + Clone,
{
    create_proposed_transactions::<_, _, std::convert::Infallible, _, std::convert::Infallible, _>(
        db,
        params,
        prover,
        prover,
        spending_keys,
        OvkPolicy::Sender,
        proposal,
        // Preserve the builder-derived expiry height for every proposal step.
        None,
    )
}

#[derive(Clone, Copy)]
struct ConfirmationClock {
    monotonic: Instant,
    wall: SystemTime,
}

impl ConfirmationClock {
    fn now() -> Self {
        Self {
            monotonic: Instant::now(),
            wall: SystemTime::now(),
        }
    }
}

struct ExecutionAuthorization {
    confirmation_token_hash: [u8; 32],
    issued_at_wall: SystemTime,
    expires_at_monotonic: Instant,
    expires_at_wall: SystemTime,
}

struct ProposalAuthorization {
    proposal_id: u32,
    wallet_id: String,
    session_id: [u8; 32],
    review_digest: String,
    proposal_token_hash: [u8; 32],
    execution: Option<ExecutionAuthorization>,
}

/// Native-only proposal state. The executable proposal and its reviewed
/// authorization are installed and consumed atomically under `send_operation`.
pub struct PendingProposal {
    authorization: ProposalAuthorization,
    review: SendReview,
    proposal: WalletProposal,
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX[(byte >> 4) as usize] as char);
        encoded.push(HEX[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn bound_token_hash(domain: &[u8], token: &str, review_digest: &str) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    push_digest_field(&mut hasher, review_digest.as_bytes());
    push_digest_field(&mut hasher, token.as_bytes());
    hasher.finalize().into()
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

impl ProposalAuthorization {
    fn verify_context(&self, wallet_id: &str, session_id: &[u8; 32]) -> Result<()> {
        if self.wallet_id != wallet_id || !constant_time_eq(&self.session_id, session_id) {
            return Err(Error::SendError(
                "send proposal belongs to a different wallet session".into(),
            ));
        }
        Ok(())
    }

    fn verify_proposal(
        &self,
        proposal_id: u32,
        review_digest: &str,
        proposal_token: &str,
        wallet_id: &str,
        session_id: &[u8; 32],
    ) -> Result<()> {
        self.verify_context(wallet_id, session_id)?;
        let token_matches = constant_time_eq(
            &self.proposal_token_hash,
            &bound_token_hash(SEND_PROPOSAL_TOKEN_DOMAIN, proposal_token, review_digest),
        );
        if self.proposal_id != proposal_id
            || !constant_time_eq(self.review_digest.as_bytes(), review_digest.as_bytes())
            || !token_matches
        {
            return Err(Error::SendError(
                "send proposal credentials do not match the reviewed payment".into(),
            ));
        }
        Ok(())
    }

    fn verify_execution(
        &self,
        proposal_id: u32,
        review_digest: &str,
        confirmation_token: &str,
        wallet_id: &str,
        session_id: &[u8; 32],
        now: ConfirmationClock,
    ) -> Result<()> {
        self.verify_context(wallet_id, session_id)?;
        if self.proposal_id != proposal_id
            || !constant_time_eq(self.review_digest.as_bytes(), review_digest.as_bytes())
        {
            return Err(Error::SendError(
                "send confirmation does not match the reviewed payment".into(),
            ));
        }
        let execution = self.execution.as_ref().ok_or_else(|| {
            Error::SendError("native payment confirmation is required before execution".into())
        })?;
        // Android/Linux monotonic clocks do not necessarily advance during
        // suspend, while wall clocks can be adjusted backwards. Require both
        // independent deadlines and reject rollback from issuance so neither
        // clock behavior can extend this short-lived authority.
        if now.monotonic >= execution.expires_at_monotonic
            || now.wall >= execution.expires_at_wall
            || now.wall < execution.issued_at_wall
        {
            return Err(Error::SendError(
                "native payment confirmation expired; review the payment again".into(),
            ));
        }
        if !constant_time_eq(
            &execution.confirmation_token_hash,
            &bound_token_hash(
                SEND_CONFIRMATION_TOKEN_DOMAIN,
                confirmation_token,
                review_digest,
            ),
        ) {
            return Err(Error::SendError(
                "send confirmation does not match the reviewed payment".into(),
            ));
        }
        Ok(())
    }
}

impl PendingProposal {
    fn verify_native_review(&self) -> Result<()> {
        let expected_digest = send_review_digest(
            &self.review,
            self.authorization.proposal_id,
            &self.authorization.wallet_id,
            &self.authorization.session_id,
        );
        if !constant_time_eq(
            expected_digest.as_bytes(),
            self.authorization.review_digest.as_bytes(),
        ) {
            return Err(Error::SendError(
                "native send review no longer matches its proposal".into(),
            ));
        }
        let proposal_review = review_from_native_proposal(&self.review.network, &self.proposal)?;
        if proposal_review != self.review {
            return Err(Error::SendError(
                "reviewed payment no longer matches native proposal semantics".into(),
            ));
        }
        Ok(())
    }

    fn verify_proposal(
        &self,
        proposal_id: u32,
        review_digest: &str,
        proposal_token: &str,
        wallet_id: &str,
        session_id: &[u8; 32],
    ) -> Result<()> {
        self.verify_native_review()?;
        self.authorization.verify_proposal(
            proposal_id,
            review_digest,
            proposal_token,
            wallet_id,
            session_id,
        )
    }

    fn verify_execution(
        &self,
        proposal_id: u32,
        review_digest: &str,
        confirmation_token: &str,
        wallet_id: &str,
        session_id: &[u8; 32],
        now: ConfirmationClock,
    ) -> Result<()> {
        self.verify_native_review()?;
        self.authorization.verify_execution(
            proposal_id,
            review_digest,
            confirmation_token,
            wallet_id,
            session_id,
            now,
        )
    }

    fn issue_confirmation(
        &mut self,
        proposal_id: u32,
        review_digest: &str,
        proposal_token: &str,
        wallet_id: &str,
        session_id: &[u8; 32],
        now: ConfirmationClock,
    ) -> Result<SendConfirmation> {
        self.verify_proposal(
            proposal_id,
            review_digest,
            proposal_token,
            wallet_id,
            session_id,
        )?;
        let mut token_bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut token_bytes);
        let confirmation_token = encode_hex(&token_bytes);
        let expires_at_monotonic = now
            .monotonic
            .checked_add(SEND_CONFIRMATION_TTL)
            .ok_or_else(|| Error::SendError("confirmation deadline overflowed".into()))?;
        let expires_at_wall = now
            .wall
            .checked_add(SEND_CONFIRMATION_TTL)
            .ok_or_else(|| Error::SendError("confirmation deadline overflowed".into()))?;
        let expires_at_millis = expires_at_wall
            .duration_since(UNIX_EPOCH)
            .map_err(|_| Error::SendError("system clock predates the Unix epoch".into()))?
            .as_millis()
            .try_into()
            .map_err(|_| Error::SendError("confirmation deadline overflowed".into()))?;
        self.authorization.execution = Some(ExecutionAuthorization {
            confirmation_token_hash: bound_token_hash(
                SEND_CONFIRMATION_TOKEN_DOMAIN,
                &confirmation_token,
                review_digest,
            ),
            issued_at_wall: now.wall,
            expires_at_monotonic,
            expires_at_wall,
        });
        Ok(SendConfirmation {
            confirmation_token,
            expires_at: expires_at_millis,
        })
    }
}

fn take_authorized<T>(slot: &mut Option<T>, authorize: impl FnOnce(&T) -> Result<()>) -> Result<T> {
    let pending = slot.as_ref().ok_or_else(|| {
        Error::SendError("no pending proposal — create and review a new proposal".into())
    })?;
    authorize(pending)?;
    slot.take()
        .ok_or_else(|| Error::SendError("pending proposal disappeared during confirmation".into()))
}

fn push_digest_field(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_be_bytes());
    hasher.update(value);
}

fn send_review_digest(
    review: &SendReview,
    proposal_id: u32,
    wallet_id: &str,
    session_id: &[u8; 32],
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(SEND_REVIEW_DOMAIN);
    hasher.update(proposal_id.to_be_bytes());
    push_digest_field(&mut hasher, wallet_id.as_bytes());
    hasher.update(session_id);
    hasher.update(review.version.to_be_bytes());
    push_digest_field(&mut hasher, review.network.as_bytes());
    hasher.update((review.payments.len() as u64).to_be_bytes());
    for payment in &review.payments {
        push_digest_field(&mut hasher, payment.recipient.as_bytes());
        hasher.update(payment.amount.to_be_bytes());
        match &payment.memo {
            Some(memo) => {
                hasher.update([1]);
                push_digest_field(&mut hasher, memo.as_bytes());
            }
            None => hasher.update([0]),
        }
    }
    push_digest_field(&mut hasher, review.fee_policy.as_bytes());
    hasher.update(review.fee.to_be_bytes());
    hasher.update(review.total.to_be_bytes());
    push_digest_field(&mut hasher, review.change_policy.as_bytes());
    encode_hex(&hasher.finalize())
}

fn network_label(network: &zcash_protocol::consensus::Network) -> &'static str {
    match network {
        zcash_protocol::consensus::Network::MainNetwork => "mainnet",
        zcash_protocol::consensus::Network::TestNetwork => "testnet",
    }
}

fn create_pending_proposal(
    proposal_id: u32,
    proposal: WalletProposal,
    review: SendReview,
    wallet_id: String,
    session_id: [u8; 32],
) -> (PendingProposal, SendProposal) {
    let review_digest = send_review_digest(&review, proposal_id, &wallet_id, &session_id);
    let mut token_bytes = [0_u8; 32];
    OsRng.fill_bytes(&mut token_bytes);
    let proposal_token = encode_hex(&token_bytes);
    let pending = PendingProposal {
        authorization: ProposalAuthorization {
            proposal_id,
            wallet_id,
            session_id,
            review_digest: review_digest.clone(),
            proposal_token_hash: bound_token_hash(
                SEND_PROPOSAL_TOKEN_DOMAIN,
                &proposal_token,
                &review_digest,
            ),
            execution: None,
        },
        review: review.clone(),
        proposal,
    };
    let public = SendProposal {
        proposal_id,
        review,
        review_digest,
        proposal_token,
    };
    (pending, public)
}

fn format_zec_amount(zatoshis: u64) -> String {
    format!(
        "{}.{:08} ZEC",
        zatoshis / 100_000_000,
        zatoshis % 100_000_000
    )
}

fn is_unicode_format_control(character: char) -> bool {
    matches!(
        character as u32,
        0x00AD
            | 0x0600..=0x0605
            | 0x061C
            | 0x06DD
            | 0x070F
            | 0x0890..=0x0891
            | 0x08E2
            | 0x180E
            | 0x200B..=0x200F
            | 0x202A..=0x202E
            | 0x2060..=0x2064
            | 0x2066..=0x206F
            | 0xFEFF
            | 0xFFF9..=0xFFFB
            | 0x110BD
            | 0x110CD
            | 0x13430..=0x1343F
            | 0x1BCA0..=0x1BCA3
            | 0x1D173..=0x1D17A
            | 0xE0001
            | 0xE0020..=0xE007F
    )
}

/// Quote an exact memo without allowing Unicode layout controls to alter the
/// native dialog's field structure. Ordinary Unicode stays readable; every
/// character that can add a line, hide text, or reorder fields is visible.
fn quote_native_memo(memo: &str) -> String {
    let mut quoted = String::with_capacity(memo.len() + 2);
    quoted.push('"');
    for character in memo.chars() {
        match character {
            '"' => quoted.push_str("\\\""),
            '\\' => quoted.push_str("\\\\"),
            '\n' => quoted.push_str("\\n"),
            '\r' => quoted.push_str("\\r"),
            '\t' => quoted.push_str("\\t"),
            '\u{08}' => quoted.push_str("\\b"),
            '\u{0C}' => quoted.push_str("\\f"),
            _ if character.is_control()
                || matches!(character, '\u{2028}' | '\u{2029}')
                || is_unicode_format_control(character) =>
            {
                write!(quoted, "\\u{{{:X}}}", character as u32)
                    .expect("writing to a String cannot fail");
            }
            _ => quoted.push(character),
        }
    }
    quoted.push('"');
    quoted
}

/// Exact native confirmation copy. Memo layout controls are visibly escaped
/// so untrusted content cannot visually impersonate or reorder a field.
pub(crate) fn format_native_send_confirmation(review: &SendReview) -> Result<String> {
    let mut lines = vec![
        "A web page requested this Zcash payment. Verify every field in this native dialog."
            .to_owned(),
        String::new(),
    ];
    for (index, payment) in review.payments.iter().enumerate() {
        if review.payments.len() > 1 {
            lines.push(format!("Payment {}", index + 1));
        }
        lines.push(format!("To: {}", payment.recipient));
        lines.push(format!("Amount: {}", format_zec_amount(payment.amount)));
        let memo = match &payment.memo {
            Some(memo) => quote_native_memo(memo),
            None => "(none)".to_owned(),
        };
        lines.push(format!("Memo (quoted): {memo}"));
    }
    lines.extend([
        format!("Network fee: {}", format_zec_amount(review.fee)),
        format!("Total: {}", format_zec_amount(review.total)),
        format!("Network: {}", review.network),
        "Change: shielded automatically".to_owned(),
        String::new(),
        "Authorize only if these are the payment details you intend to send.".to_owned(),
    ]);
    Ok(lines.join("\n"))
}

fn review_from_native_proposal(network: &str, proposal: &WalletProposal) -> Result<SendReview> {
    if proposal.steps().len() != 1 {
        return Err(Error::SendError(
            "multi-transaction send proposals are not supported safely".into(),
        ));
    }
    let fee_rule = proposal.fee_rule();
    if fee_rule.marginal_fee() != zcash_primitives::transaction::fees::zip317::MARGINAL_FEE
        || fee_rule.grace_actions() != zcash_primitives::transaction::fees::zip317::GRACE_ACTIONS
        || fee_rule.p2pkh_standard_input_size()
            != zcash_primitives::transaction::fees::zip317::P2PKH_STANDARD_INPUT_SIZE
        || fee_rule.p2pkh_standard_output_size()
            != zcash_primitives::transaction::fees::zip317::P2PKH_STANDARD_OUTPUT_SIZE
    {
        return Err(Error::SendError(
            "native proposal uses an unreviewed fee policy".into(),
        ));
    }
    let step = proposal.steps().first();
    if step.is_shielding() {
        return Err(Error::SendError(
            "shielding proposals cannot enter the payment confirmation flow".into(),
        ));
    }
    if step
        .balance()
        .proposed_change()
        .iter()
        .any(|change| !matches!(change.output_pool(), PoolType::Shielded(_)))
    {
        return Err(Error::SendError(
            "native proposal uses an unreviewed change policy".into(),
        ));
    }
    let request_payments = step.transaction_request().payments();
    if request_payments.is_empty()
        || request_payments.len() != step.payment_pools().len()
        || request_payments
            .keys()
            .enumerate()
            .any(|(expected, actual)| expected != *actual)
    {
        return Err(Error::SendError(
            "native proposal payment structure is not reviewable".into(),
        ));
    }
    let payments = request_payments
        .values()
        .map(|payment| {
            if payment.label().is_some()
                || payment.message().is_some()
                || !payment.other_params().is_empty()
            {
                return Err(Error::SendError(
                    "native proposal contains unreviewed payment metadata".into(),
                ));
            }
            let amount = payment
                .amount()
                .map(u64::from)
                .ok_or_else(|| Error::SendError("native proposal payment has no amount".into()))?;
            let memo = payment
                .memo()
                .map(|bytes| match Memo::try_from(bytes) {
                    Ok(Memo::Text(text)) => Ok(text.to_string()),
                    Ok(Memo::Empty) => Ok(String::new()),
                    Ok(Memo::Future(_) | Memo::Arbitrary(_)) => Err(Error::SendError(
                        "native proposal contains a non-text memo".into(),
                    )),
                    Err(error) => Err(Error::SendError(format!(
                        "native proposal memo is invalid: {error}"
                    ))),
                })
                .transpose()?;
            Ok(SendPaymentReview {
                recipient: payment.recipient_address().encode(),
                amount,
                memo,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let fee = u64::from(step.balance().fee_required());
    let total = payments.iter().try_fold(fee, |total, payment| {
        total
            .checked_add(payment.amount)
            .ok_or_else(|| Error::SendError("send total overflowed".into()))
    })?;
    Ok(SendReview {
        version: SEND_REVIEW_VERSION,
        network: network.to_owned(),
        payments,
        fee_policy: SEND_FEE_POLICY.to_owned(),
        fee,
        total,
        change_policy: SEND_CHANGE_POLICY.to_owned(),
    })
}

fn pending_broadcast_path(data_dir: &Path, wallet_id: &str) -> Result<std::path::PathBuf> {
    if wallet_id.is_empty()
        || !wallet_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        return Err(Error::DatabaseError("invalid wallet identifier".into()));
    }
    Ok(data_dir.join(format!("pending-send-{wallet_id}.json")))
}

fn validate_recovery_metadata(metadata: &Metadata, label: &str) -> Result<()> {
    if !metadata.file_type().is_file() {
        return Err(Error::DatabaseError(format!(
            "pending send {label} is not a regular file"
        )));
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.nlink() != 1 {
            return Err(Error::DatabaseError(format!(
                "pending send {label} has an unsafe link count"
            )));
        }
        if metadata.mode() & 0o077 != 0 {
            return Err(Error::DatabaseError(format!(
                "pending send {label} has unsafe permissions"
            )));
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(Error::DatabaseError(format!(
                "pending send {label} is an unsafe reparse point"
            )));
        }
    }

    Ok(())
}

#[cfg(windows)]
fn validate_windows_file_handle(file: &File, label: &str) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is owned by `file` for the duration of this call and
    // `information` points to a correctly-sized writable Win32 structure.
    let succeeded =
        unsafe { GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information) };
    if succeeded == 0 {
        return Err(Error::DatabaseError(format!(
            "pending send {label} link metadata could not be read: {}",
            std::io::Error::last_os_error()
        )));
    }
    if information.nNumberOfLinks != 1 {
        return Err(Error::DatabaseError(format!(
            "pending send {label} has an unsafe link count"
        )));
    }
    Ok(())
}

fn open_recovery_file(path: &Path, label: &str) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Inspect the directory entry itself instead of traversing a reparse
        // point. Handle metadata below then rejects every reparse point.
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }

    let file = options.open(path).map_err(|error| {
        Error::DatabaseError(format!(
            "pending send {label} could not be opened safely: {error}"
        ))
    })?;
    let metadata = file.metadata().map_err(|error| {
        Error::DatabaseError(format!(
            "pending send {label} metadata could not be read: {error}"
        ))
    })?;
    validate_recovery_metadata(&metadata, label)?;
    #[cfg(windows)]
    validate_windows_file_handle(&file, label)?;
    Ok(file)
}

/// Validate a journal pathname without following links. The returned boolean
/// records whether the exact directory entry existed at validation time.
fn validate_recovery_path(path: &Path, label: &str) -> Result<bool> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            validate_recovery_metadata(&metadata, label)?;
            // `MetadataExt::number_of_links` is unstable on Windows. Validate
            // the opened handle with the stable Win32 API instead, which also
            // closes the path-metadata/open race for hard-link checks.
            #[cfg(windows)]
            drop(open_recovery_file(path, label)?);
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(Error::DatabaseError(format!(
            "pending send {label} could not be inspected: {error}"
        ))),
    }
}

fn read_recovery_file(path: &Path, label: &str) -> Result<Option<Vec<u8>>> {
    if !validate_recovery_path(path, label)? {
        return Ok(None);
    }

    let file = open_recovery_file(path, label)?;
    let metadata = file.metadata().map_err(|error| {
        Error::DatabaseError(format!(
            "pending send {label} metadata could not be read: {error}"
        ))
    })?;
    if metadata.len() > MAX_PENDING_JOURNAL_BYTES {
        return Err(Error::DatabaseError(format!(
            "pending send {label} exceeds the recovery size limit"
        )));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PENDING_JOURNAL_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            Error::DatabaseError(format!("pending send {label} could not be read: {error}"))
        })?;
    if bytes.len() as u64 > MAX_PENDING_JOURNAL_BYTES {
        return Err(Error::DatabaseError(format!(
            "pending send {label} exceeds the recovery size limit"
        )));
    }
    Ok(Some(bytes))
}

struct TemporaryJournal {
    path: PathBuf,
}

impl Drop for TemporaryJournal {
    fn drop(&mut self) {
        match std::fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!("failed to clean exact pending send temporary file: {error}")
            }
        }
    }
}

fn create_unique_journal(data_dir: &Path, wallet_id: &str) -> Result<(File, TemporaryJournal)> {
    for _ in 0..16 {
        let path = data_dir.join(format!(
            ".pending-send-{wallet_id}-{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        match options.open(&path) {
            Ok(file) => return Ok((file, TemporaryJournal { path })),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(Error::DatabaseError(format!(
                    "failed to create unique pending send recovery state: {error}"
                )));
            }
        }
    }
    Err(Error::DatabaseError(
        "failed to allocate unique pending send recovery state".into(),
    ))
}

#[cfg(unix)]
fn sync_recovery_directory(data_dir: &Path) -> Result<()> {
    OpenOptions::new()
        .read(true)
        .open(data_dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| {
            Error::DatabaseError(format!(
                "failed to sync pending send recovery directory: {error}"
            ))
        })
}

pub(crate) fn load_pending_broadcast(data_dir: &Path, wallet_id: &str) -> Option<PendingBroadcast> {
    let corrupt = |message: String| PendingBroadcast {
        wallet_id: wallet_id.to_string(),
        proposal_id: 0,
        txid: "unavailable".into(),
        txid_bytes: vec![],
        raw_transaction: vec![],
        status: BroadcastStatus::Unknown,
        message: Some(message.clone()),
        attempts: 1,
        had_ambiguous_attempt: true,
        recovery_error: Some(message),
    };
    let path = pending_broadcast_path(data_dir, wallet_id).ok()?;
    let bytes = match read_recovery_file(&path, "recovery state") {
        Ok(Some(bytes)) => bytes,
        #[cfg(windows)]
        Ok(None) => {
            let backup = path.with_extension("json.bak");
            match read_recovery_file(&backup, "recovery backup") {
                Ok(Some(bytes)) => bytes,
                Ok(None) => return None,
                Err(error) => {
                    let message = error.to_string();
                    tracing::error!("{message}");
                    return Some(corrupt(message));
                }
            }
        }
        #[cfg(not(windows))]
        Ok(None) => return None,
        Err(error) => {
            let message = error.to_string();
            tracing::error!("{message}");
            return Some(corrupt(message));
        }
    };
    let mut record: PendingBroadcast = match serde_json::from_slice(&bytes) {
        Ok(record) => record,
        Err(error) => {
            let message = format!("pending send recovery state is invalid: {error}");
            tracing::error!("{message}");
            return Some(corrupt(message));
        }
    };
    let is_creation_intent = record.status == BroadcastStatus::Unknown
        && record.txid == "unavailable"
        && record.txid_bytes.is_empty()
        && record.raw_transaction.is_empty()
        && record.recovery_error.is_some();
    if record.wallet_id != wallet_id
        || (!is_creation_intent
            && (record.txid_bytes.len() != 32 || record.raw_transaction.is_empty()))
    {
        tracing::error!("pending send recovery state failed structural validation");
        return Some(corrupt(
            "pending send recovery state failed structural validation".into(),
        ));
    }
    // A short-lived pre-release build marked a complete transaction as
    // unrecoverable when its wallet DB row was missing. Exact raw bytes are
    // still retryable, so migrate that state back to the non-discardable retry
    // path rather than letting a history gap authorize a replacement payment.
    if record.recovery_error.is_some() && !record.raw_transaction.is_empty() {
        record.recovery_error = None;
        record.message = Some(
            "The wallet database is missing this transaction; only retry these exact saved bytes or restore the wallet database."
                .into(),
        );
    }
    Some(record)
}

fn persist_pending_broadcast(data_dir: &Path, record: &PendingBroadcast) -> Result<()> {
    let path = pending_broadcast_path(data_dir, &record.wallet_id)?;
    let backup = path.with_extension("json.bak");
    let stable_exists = validate_recovery_path(&path, "recovery state")?;
    let backup_exists = validate_recovery_path(&backup, "recovery backup")?;
    #[cfg(not(windows))]
    let _ = (stable_exists, backup_exists);
    let bytes = serde_json::to_vec(record)
        .map_err(|error| Error::DatabaseError(format!("failed to encode pending send: {error}")))?;
    if bytes.len() as u64 > MAX_PENDING_JOURNAL_BYTES {
        return Err(Error::DatabaseError(
            "pending send recovery state exceeds the size limit".into(),
        ));
    }
    let (mut file, temporary) = create_unique_journal(data_dir, &record.wallet_id)?;
    file.write_all(&bytes).map_err(|error| {
        Error::DatabaseError(format!(
            "failed to write pending send recovery state: {error}"
        ))
    })?;
    file.sync_all().map_err(|error| {
        Error::DatabaseError(format!(
            "failed to sync pending send recovery state: {error}"
        ))
    })?;
    drop(file);
    #[cfg(windows)]
    {
        // Windows rename does not replace an existing file. Preserve the old
        // record as a recovery fallback so there is never a crash window with
        // no durable evidence that a send may have happened.
        if stable_exists {
            if backup_exists {
                std::fs::remove_file(&backup).map_err(|error| {
                    Error::DatabaseError(format!(
                        "failed to prepare pending send recovery backup: {error}"
                    ))
                })?;
            }
            std::fs::rename(&path, &backup).map_err(|error| {
                Error::DatabaseError(format!(
                    "failed to preserve pending send recovery backup: {error}"
                ))
            })?;
            if let Err(error) = std::fs::rename(&temporary.path, &path) {
                let _ = std::fs::rename(&backup, &path);
                return Err(Error::DatabaseError(format!(
                    "failed to commit pending send recovery state: {error}"
                )));
            }
            if let Err(error) = std::fs::remove_file(&backup) {
                tracing::warn!("pending send recovery backup remains after commit: {error}");
            }
        } else {
            std::fs::rename(&temporary.path, &path).map_err(|error| {
                Error::DatabaseError(format!(
                    "failed to commit pending send recovery state: {error}"
                ))
            })?;
        }
    }
    #[cfg(not(windows))]
    std::fs::rename(&temporary.path, &path).map_err(|error| {
        Error::DatabaseError(format!(
            "failed to commit pending send recovery state: {error}"
        ))
    })?;
    // On Unix, fsync the directory as well as the file. Without this, a crash
    // after lightwalletd accepts the transaction can lose the directory entry
    // and make the next launch incorrectly believe no send is pending.
    #[cfg(unix)]
    sync_recovery_directory(data_dir)?;
    Ok(())
}

pub(crate) fn clear_pending_broadcast(data_dir: &Path, wallet_id: &str) -> Result<()> {
    let path = pending_broadcast_path(data_dir, wallet_id)?;
    let backup = path.with_extension("json.bak");
    let stable_exists = validate_recovery_path(&path, "recovery state")?;
    let backup_exists = validate_recovery_path(&backup, "recovery backup")?;
    if backup_exists {
        std::fs::remove_file(&backup).map_err(|error| {
            Error::DatabaseError(format!(
                "failed to clear pending send recovery backup: {error}"
            ))
        })?;
    }
    if stable_exists {
        std::fs::remove_file(path).map_err(|error| {
            Error::DatabaseError(format!(
                "failed to clear pending send recovery state: {error}"
            ))
        })?;
    }
    #[cfg(unix)]
    if stable_exists || backup_exists {
        sync_recovery_directory(data_dir)?;
    }
    Ok(())
}

pub(crate) fn ensure_wallet_has_no_unknown_send(data_dir: &Path, wallet_id: &str) -> Result<()> {
    if load_pending_broadcast(data_dir, wallet_id)
        .is_some_and(|pending| pending.status == BroadcastStatus::Unknown)
    {
        Err(Error::SendError(
            "this wallet has a transaction with unknown broadcast status; retry it before deleting the wallet"
                .into(),
        ))
    } else {
        Ok(())
    }
}

impl PendingBroadcast {
    fn public_status(&self) -> PendingSendStatus {
        PendingSendStatus {
            proposal_id: self.proposal_id,
            txid: self.txid.clone(),
            status: self.status,
            message: self.message.clone(),
            recovery_required: self.recovery_error.is_some(),
            can_discard: is_manually_discardable(self),
        }
    }
}

fn invalid_recipient(error: impl Into<String>) -> AddressValidation {
    AddressValidation {
        valid: false,
        address_type: None,
        can_receive_memo: false,
        error: Some(error.into()),
    }
}

fn validate_parsed_recipient(
    network: &zcash_protocol::consensus::Network,
    parsed: zcash_address::ZcashAddress,
) -> Result<(zcash_address::ZcashAddress, AddressValidation)> {
    let typed = Address::try_from_zcash_address(network, parsed.clone()).map_err(|error| {
        let message = match error {
            zcash_address::ConversionError::IncorrectNetwork { .. } => {
                "address belongs to a different Zcash network".to_string()
            }
            _ => format!("unsupported recipient address: {error}"),
        };
        Error::AddressError(message)
    })?;

    let (address_type, can_receive_memo) = match &typed {
        Address::Sapling(_) => ("sapling", true),
        Address::Unified(_) => {
            let can_receive_memo = typed.can_receive_as(PoolType::Shielded(ShieldedPool::Sapling))
                || typed.can_receive_as(PoolType::Shielded(ShieldedPool::Orchard))
                || typed.can_receive_as(PoolType::Shielded(ShieldedPool::Ironwood));
            if !can_receive_memo && !typed.can_receive_as(PoolType::Transparent) {
                return Err(Error::AddressError(
                    "Unified address contains no receiver supported by this wallet".into(),
                ));
            }
            ("unified", can_receive_memo)
        }
        Address::Transparent(_) => ("transparent", false),
        // ZIP 320 TEX payments are two-transaction proposals when funded from
        // shielded value. This plugin does not yet have a durable ordered-batch
        // broadcaster, so accepting one would broadcast only half the payment.
        Address::Tex(_) => {
            return Err(Error::AddressError(
                "TEX recipients are not supported until ordered multi-transaction recovery is available"
                    .into(),
            ));
        }
    };

    Ok((
        parsed,
        AddressValidation {
            valid: true,
            address_type: Some(address_type.to_string()),
            can_receive_memo,
            error: None,
        },
    ))
}

fn parse_recipient(
    network: &zcash_protocol::consensus::Network,
    encoded: &str,
) -> Result<(zcash_address::ZcashAddress, AddressValidation)> {
    let parsed = zcash_address::ZcashAddress::try_from_encoded(encoded)
        .map_err(|_| Error::AddressError("invalid Zcash address".into()))?;
    validate_parsed_recipient(network, parsed)
}

/// Validate both the address encoding and the wallet's configured network.
/// A syntactically valid testnet address must never be presented as valid by a
/// mainnet wallet (or vice versa).
pub fn validate_recipient_address(
    network: &zcash_protocol::consensus::Network,
    encoded: &str,
) -> AddressValidation {
    match parse_recipient(network, encoded) {
        Ok((_, validation)) => validation,
        Err(Error::AddressError(message)) => invalid_recipient(message),
        Err(_) => invalid_recipient("invalid Zcash address"),
    }
}

/// Parse the subset of ZIP 321 that the current single-payment send UI can
/// execute without dropping payment intent or selecting a receiver for the
/// wrong network. The proposal boundary independently repeats recipient
/// validation so this parser is never the sole authority.
pub fn parse_payment_uri(
    network: &zcash_protocol::consensus::Network,
    uri: &str,
) -> Result<PaymentRequest> {
    let request = zip321::TransactionRequest::from_uri(uri)
        .map_err(|error| Error::Other(format!("invalid payment URI: {error:?}")))?;
    if request.payments().len() != 1 {
        return Err(Error::Other(format!(
            "payment URI must contain exactly one payment; found {}",
            request.payments().len()
        )));
    }

    let payment = request
        .payments()
        .values()
        .next()
        .ok_or_else(|| Error::Other("payment URI contains no payments".into()))?;
    let (recipient, _) = validate_parsed_recipient(network, payment.recipient_address().clone())?;
    let memo = payment
        .memo()
        .map(|bytes| match Memo::try_from(bytes) {
            Ok(Memo::Text(text)) => Ok(text.to_string()),
            Ok(Memo::Empty) => Ok(String::new()),
            Ok(Memo::Future(_) | Memo::Arbitrary(_)) => Err(Error::Other(
                "payment URI contains a non-text memo unsupported by this app".into(),
            )),
            Err(error) => Err(Error::Other(format!(
                "payment URI contains an invalid memo: {error}"
            ))),
        })
        .transpose()?;

    Ok(PaymentRequest {
        address: recipient.encode(),
        amount: payment.amount().map(u64::from),
        memo,
        label: payment.label().cloned(),
    })
}

fn require_prover(prover: Option<&LocalTxProver>) -> Result<&LocalTxProver> {
    prover.ok_or_else(|| {
        Error::SendError(
            "Sapling proving parameters are not ready; prepare them before confirming the payment"
                .into(),
        )
    })
}

fn ensure_no_unresolved_broadcast(pending: Option<&PendingBroadcast>) -> Result<()> {
    if pending.is_some_and(|record| record.status == BroadcastStatus::Unknown) {
        Err(Error::SendError(
            "a previously created transaction is not confirmed as broadcast; retry that exact transaction before creating another payment"
                .into(),
        ))
    } else {
        Ok(())
    }
}

fn is_manually_discardable(record: &PendingBroadcast) -> bool {
    record.status == BroadcastStatus::Unknown
        // Only the exact, successfully-decoded creation intent written by this
        // process is discardable. A synthetic record produced by a transient
        // read error or corrupt journal may still hide exact retry bytes, so it
        // must remain fail-closed for forensic recovery instead of being
        // unlinked by the UI escape hatch.
        && record.recovery_error.as_deref() == Some(INTERRUPTED_CREATION_RECOVERY_ERROR)
        && record.txid == "unavailable"
        && record.txid_bytes.is_empty()
        && record.raw_transaction.is_empty()
}

fn remote_lookup_matches(record: &PendingBroadcast, returned_bytes: &[u8]) -> bool {
    returned_bytes == record.raw_transaction
}

/// Commit proposal state only when proposal construction succeeded. Keeping
/// this transition small and deterministic makes it impossible for a rejected
/// proposal to become executable.
fn install_accepted_proposal<T, O, E>(
    slot: &mut Option<T>,
    candidate: std::result::Result<(T, O), E>,
) -> std::result::Result<O, E> {
    match candidate {
        Ok((proposal, output)) => {
            *slot = Some(proposal);
            Ok(output)
        }
        Err(error) => {
            // A previously-reviewed proposal must not remain executable after
            // a newer proposal attempt was rejected.
            *slot = None;
            Err(error)
        }
    }
}

fn classify_broadcast_response(
    txid: String,
    had_ambiguous_attempt: bool,
    response: Option<(i32, String)>,
) -> ExecuteSendResult {
    match response {
        Some((0, _)) => ExecuteSendResult {
            txid,
            status: BroadcastStatus::Accepted,
            message: None,
        },
        Some((code, _message)) => {
            // RPC_VERIFY_ALREADY_IN_CHAIN is a fixed protocol code. Never let
            // attacker-controlled response text turn an arbitrary rejection
            // into acceptance and erase the only retry journal.
            let already_known = code == -27;
            if already_known {
                ExecuteSendResult {
                    txid,
                    status: BroadcastStatus::Accepted,
                    message: None,
                }
            } else if had_ambiguous_attempt {
                // A completed rejection after an earlier ambiguous attempt
                // cannot prove the earlier attempt was rejected. Never
                // downgrade Unknown to Rejected and invite a replacement send.
                ExecuteSendResult {
                    txid,
                    status: BroadcastStatus::Unknown,
                    message: Some(format!(
                        "The rebroadcast was not accepted (code {code}), but the earlier broadcast may have succeeded. Retry this exact transaction only."
                    )),
                }
            } else {
                ExecuteSendResult {
                    txid,
                    status: BroadcastStatus::Rejected,
                    message: Some(format!("lightwalletd rejected the transaction (code {code})")),
                }
            }
        }
        None => ExecuteSendResult {
            txid,
            status: BroadcastStatus::Unknown,
            message: Some(
                "The transaction was created, but its broadcast status is unknown. Retry this exact transaction; do not create another payment."
                    .into(),
            ),
        },
    }
}

/// Remove corrupt/truncated sapling param files so that `with_default_location()`
/// and `download_sapling_parameters()` don't panic on size verification.
fn clean_corrupt_sapling_params() {
    const EXPECTED_SPEND_BYTES: u64 = 47_958_396;
    const EXPECTED_OUTPUT_BYTES: u64 = 3_592_860;

    let Some(params_dir) = zcash_proofs::default_params_folder() else {
        return;
    };

    for &(name, expected) in &[
        (zcash_proofs::SAPLING_SPEND_NAME, EXPECTED_SPEND_BYTES),
        (zcash_proofs::SAPLING_OUTPUT_NAME, EXPECTED_OUTPUT_BYTES),
    ] {
        let path = params_dir.join(name);
        if let Ok(meta) = std::fs::metadata(&path)
            && meta.len() != expected
        {
            tracing::warn!(
                "removing corrupt {name} ({} bytes, expected {expected})",
                meta.len()
            );
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Ensure Sapling proving parameters are available, downloading if needed.
pub async fn ensure_sapling_params(state: &WalletState) -> Result<SaplingParamsStatus> {
    // The same mutex also serializes preparation, preventing two UI requests
    // from racing downloads into the same parameter files.
    let mut prover_guard = state.prover.lock().await;
    if prover_guard.is_some() {
        return Ok(SaplingParamsStatus { ready: true });
    }

    // Parameter verification and LocalTxProver construction read and parse
    // roughly 50 MiB. Keep the entire load/download/load sequence off the
    // async runtime so mobile and desktop UI work cannot be starved.
    let prover = tokio::task::spawn_blocking(|| -> Result<LocalTxProver> {
        clean_corrupt_sapling_params();
        if let Some(prover) = LocalTxProver::with_default_location() {
            return Ok(prover);
        }
        zcash_proofs::download_sapling_parameters(Some(300)).map_err(|error| {
            Error::SendError(format!(
                "failed to download Sapling proving parameters: {error}"
            ))
        })?;
        LocalTxProver::with_default_location().ok_or_else(|| {
            Error::SendError("Sapling proving parameters were not found after download".into())
        })
    })
    .await
    .map_err(|error| Error::SendError(format!("parameter preparation task failed: {error}")))??;
    *prover_guard = Some(prover);

    Ok(SaplingParamsStatus { ready: true })
}

/// Propose a send transaction and return the actual ZIP-317 fee.
pub async fn propose_send(
    state: &WalletState,
    to: &str,
    amount: u64,
    memo: Option<&str>,
) -> Result<SendProposal> {
    let _send_operation = state.send_operation.lock().await;
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    {
        let pending = state.pending_broadcast.lock().await;
        ensure_no_unresolved_broadcast(pending.as_ref())?;
    }
    *state.pending_proposal.lock().await = None;

    // Parse the recipient and require it to match this wallet's network.
    let (recipient, _) = parse_recipient(&state.network, to)?;

    // Build the payment request
    let zatoshis =
        Zatoshis::from_u64(amount).map_err(|_| Error::SendError("invalid amount".into()))?;

    let memo_bytes = match memo {
        Some(m) => {
            Some(MemoBytes::from(Memo::from_str(m).map_err(|e| {
                Error::SendError(format!("invalid memo: {e}"))
            })?))
        }
        None => None,
    };

    let payment = zip321::Payment::new(
        recipient.clone(),
        Some(zatoshis),
        memo_bytes,
        None,
        None,
        vec![],
    )
    .map_err(|e| Error::SendError(format!("failed to create payment: {e:?}")))?;

    let request = zip321::TransactionRequest::new(vec![payment])
        .map_err(|e| Error::SendError(format!("failed to create transaction request: {e:?}")))?;

    // Propose the transfer (no prover needed)
    let mut db_guard = state.db.lock().await;
    let db = db_guard.as_mut().ok_or(Error::WalletNotInitialized)?;

    let account_ids = db
        .get_account_ids()
        .map_err(|e| Error::DatabaseError(format!("{e}")))?;
    let account_id = account_ids
        .first()
        .copied()
        .ok_or(Error::SendError("no accounts found".into()))?;

    let proposal = propose_fixed_native_send(db, &state.network, account_id, request)
        .map_err(|e| Error::SendError(format!("failed to propose transfer: {e:?}")));

    drop(db_guard);

    let candidate = proposal.and_then(|proposal| {
        let id = state.proposal_counter.fetch_add(1, Ordering::Relaxed);
        // Derive the displayed and authorized details back from the executable
        // native proposal, never from the renderer request kept above.
        let review = review_from_native_proposal(network_label(&state.network), &proposal)?;
        Ok(create_pending_proposal(
            id,
            proposal,
            review,
            wallet_id.clone(),
            state.send_session_id,
        ))
    });
    let mut pending_broadcast = state.pending_broadcast.lock().await;
    ensure_no_unresolved_broadcast(pending_broadcast.as_ref())?;
    let mut proposal_guard = state.pending_proposal.lock().await;
    let result = install_accepted_proposal(&mut *proposal_guard, candidate);
    match result {
        Ok(output) => {
            if let Some(record) = pending_broadcast.as_ref()
                && let Err(error) = clear_pending_broadcast(&state.data_dir, &record.wallet_id)
            {
                *proposal_guard = None;
                return Err(error);
            }
            *pending_broadcast = None;
            Ok(output)
        }
        Err(error) => Err(error),
    }
}

/// Propose a "send all" transaction — finds the maximum amount after ZIP-317 fee.
pub async fn propose_send_all(
    state: &WalletState,
    to: &str,
    memo: Option<&str>,
) -> Result<SendProposal> {
    let _send_operation = state.send_operation.lock().await;
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    {
        let pending = state.pending_broadcast.lock().await;
        ensure_no_unresolved_broadcast(pending.as_ref())?;
    }
    *state.pending_proposal.lock().await = None;

    // Get spendable balance
    let spendable = {
        let db_guard = state.read_db.lock().await;
        let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;
        let policy = ConfirmationsPolicy::default();
        let summary = db
            .get_wallet_summary(policy)
            .map_err(|e| Error::DatabaseError(format!("{e}")))?
            .ok_or(Error::SendError("no wallet summary available".into()))?;
        let account_ids = db
            .get_account_ids()
            .map_err(|e| Error::DatabaseError(format!("{e}")))?;
        let account_id = account_ids
            .first()
            .copied()
            .ok_or(Error::SendError("no accounts found".into()))?;
        let balance = summary
            .account_balances()
            .get(&account_id)
            .ok_or(Error::SendError("no balance for account".into()))?;
        let sapling = balance.sapling_balance();
        let orchard = balance.orchard_balance();
        // Ironwood is a third shielded pool (NU6.3); after activation, Orchard
        // becomes spend-only and new shielded value lands in Ironwood, so it must
        // be counted or the wallet will report a false "insufficient balance".
        let ironwood = balance.ironwood_balance();
        u64::from(sapling.spendable_value())
            + u64::from(orchard.spendable_value())
            + u64::from(ironwood.spendable_value())
    };

    if spendable <= 10000 {
        return Err(Error::SendError("insufficient spendable balance".into()));
    }

    // Parse recipient once and require it to match this wallet's network.
    let (recipient, _) = parse_recipient(&state.network, to)?;

    let memo_bytes = match memo {
        Some(m) => {
            Some(MemoBytes::from(Memo::from_str(m).map_err(|e| {
                Error::SendError(format!("invalid memo: {e}"))
            })?))
        }
        None => None,
    };

    // Start with optimistic estimate: spendable - minimum fee
    let mut amount = spendable - 10000;

    for _ in 0..3 {
        let zatoshis =
            Zatoshis::from_u64(amount).map_err(|_| Error::SendError("invalid amount".into()))?;

        let payment = zip321::Payment::new(
            recipient.clone(),
            Some(zatoshis),
            memo_bytes.clone(),
            None,
            None,
            vec![],
        )
        .map_err(|e| Error::SendError(format!("failed to create payment: {e:?}")))?;

        let request = zip321::TransactionRequest::new(vec![payment]).map_err(|e| {
            Error::SendError(format!("failed to create transaction request: {e:?}"))
        })?;

        let mut db_guard = state.db.lock().await;
        let db = db_guard.as_mut().ok_or(Error::WalletNotInitialized)?;

        let account_ids = db
            .get_account_ids()
            .map_err(|e| Error::DatabaseError(format!("{e}")))?;
        let account_id = account_ids
            .first()
            .copied()
            .ok_or(Error::SendError("no accounts found".into()))?;

        let result = propose_send_all_native_attempt(db, &state.network, account_id, request);

        drop(db_guard);

        match result {
            Ok(proposal) => {
                if proposal.steps().len() != 1 {
                    return Err(Error::SendError(
                        "multi-transaction send proposals are not supported safely".into(),
                    ));
                }
                let actual_fee: u64 = proposal
                    .steps()
                    .iter()
                    .map(|s| u64::from(s.balance().fee_required()))
                    .sum();

                if amount + actual_fee <= spendable {
                    // This proposal works — store it
                    let id = state.proposal_counter.fetch_add(1, Ordering::Relaxed);
                    let mut pending_broadcast = state.pending_broadcast.lock().await;
                    ensure_no_unresolved_broadcast(pending_broadcast.as_ref())?;
                    if let Some(record) = pending_broadcast.as_ref() {
                        clear_pending_broadcast(&state.data_dir, &record.wallet_id)?;
                    }
                    let review =
                        review_from_native_proposal(network_label(&state.network), &proposal)?;
                    let (pending, public) = create_pending_proposal(
                        id,
                        proposal,
                        review,
                        wallet_id.clone(),
                        state.send_session_id,
                    );
                    *state.pending_proposal.lock().await = Some(pending);
                    *pending_broadcast = None;
                    return Ok(public);
                }

                // Fee was higher than expected — adjust and retry
                amount = spendable - actual_fee;
            }
            Err(zcash_client_backend::data_api::error::Error::InsufficientFunds {
                required,
                ..
            }) => {
                let required_u64 = u64::from(required);
                let computed_fee = required_u64.saturating_sub(amount);
                if spendable > computed_fee {
                    amount = spendable - computed_fee;
                    continue;
                }
                return Err(Error::SendError("insufficient funds to cover fee".into()));
            }
            Err(e) => {
                return Err(Error::SendError(format!(
                    "failed to propose transfer: {e:?}"
                )));
            }
        }
    }

    Err(Error::SendError(
        "could not converge on send-all amount after retries".into(),
    ))
}

/// Validate the renderer's exact proposal credential and return the immutable
/// native review to display. The caller holds both transition and send locks
/// across this lookup, native user interaction, and token issuance.
pub async fn prepare_send_confirmation(
    state: &WalletState,
    proposal_id: u32,
    review_digest: &str,
    proposal_token: &str,
) -> Result<SendReview> {
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    let proposal_guard = state.pending_proposal.lock().await;
    let pending = proposal_guard.as_ref().ok_or_else(|| {
        Error::SendError("no pending proposal — create and review a new proposal".into())
    })?;
    pending.verify_proposal(
        proposal_id,
        review_digest,
        proposal_token,
        &wallet_id,
        &state.send_session_id,
    )?;
    Ok(pending.review.clone())
}

/// Mint a short-lived execution credential only after the exact native review
/// was accepted. A second confirmation replaces the first token atomically.
pub async fn issue_send_confirmation(
    state: &WalletState,
    proposal_id: u32,
    review_digest: &str,
    proposal_token: &str,
) -> Result<SendConfirmation> {
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    let mut proposal_guard = state.pending_proposal.lock().await;
    let pending = proposal_guard.as_mut().ok_or_else(|| {
        Error::SendError("no pending proposal — create and review a new proposal".into())
    })?;
    pending.issue_confirmation(
        proposal_id,
        review_digest,
        proposal_token,
        &wallet_id,
        &state.send_session_id,
        ConfirmationClock::now(),
    )
}

/// Atomically validate and consume a reviewed proposal. The caller must hold
/// `send_operation` across this call and `execute_send`, so no replacement can
/// interleave after authorization. Consumption is deliberately before custody
/// loading: a failed execution always requires a fresh native review.
pub async fn take_send_proposal(
    state: &WalletState,
    proposal_id: u32,
    review_digest: &str,
    confirmation_token: &str,
) -> Result<PendingProposal> {
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    let mut proposal_guard = state.pending_proposal.lock().await;
    take_authorized(&mut *proposal_guard, |pending| {
        pending.verify_execution(
            proposal_id,
            review_digest,
            confirmation_token,
            &wallet_id,
            &state.send_session_id,
            ConfirmationClock::now(),
        )
    })
}

/// Execute a previously-authorized send transaction. The proposal has already
/// been consumed, so all failures from this point require a new review.
pub async fn execute_send(
    state: &WalletState,
    proposal_id: u32,
    pending_proposal: PendingProposal,
) -> Result<ExecuteSendResult> {
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;

    // Serialize execution and retries. This is intentionally held across the
    // broadcast call: two taps may resend the same bytes, but they must never
    // race into two transaction creations or concurrent RPCs.
    let mut broadcast_guard = state.pending_broadcast.lock().await;

    if let Some(record) = broadcast_guard.as_mut() {
        if record.wallet_id != wallet_id {
            return Err(Error::SendError(
                "pending transaction belongs to a different wallet".into(),
            ));
        }
        if record.proposal_id == proposal_id {
            return Err(Error::SendError(
                "this confirmation was already consumed; use retry_pending_send for an ambiguous broadcast"
                    .into(),
            ));
        }

        ensure_no_unresolved_broadcast(Some(record))?;
        clear_pending_broadcast(&state.data_dir, &record.wallet_id)?;
        *broadcast_guard = None;
    }

    let prover_guard = state.prover.lock().await;
    let prover = require_prover(prover_guard.as_ref())?;

    // Derive USK from seed
    let usk = {
        let seed_guard = state.seed.lock().await;
        let seed = seed_guard.as_ref().ok_or(Error::Other(
            "seed not available - please restart the wallet".into(),
        ))?;
        keys::derive_usk(seed.expose_secret(), &state.network, 0)?
    };

    let mut db_guard = state.db.lock().await;
    let db = db_guard.as_mut().ok_or(Error::WalletNotInitialized)?;

    // Write a fail-closed intent before transaction creation mutates the wallet
    // database. If the process crashes while proving/signing, the next launch
    // must not silently permit a replacement payment.
    let intent = PendingBroadcast {
        wallet_id: wallet_id.clone(),
        proposal_id,
        txid: "unavailable".into(),
        txid_bytes: vec![],
        raw_transaction: vec![],
        status: BroadcastStatus::Unknown,
        message: Some(
            "Transaction creation was interrupted. Inspect wallet history before creating another payment."
                .into(),
        ),
        attempts: 0,
        had_ambiguous_attempt: false,
        recovery_error: Some(INTERRUPTED_CREATION_RECOVERY_ERROR.into()),
    };
    persist_pending_broadcast(&state.data_dir, &intent)?;
    *broadcast_guard = Some(intent);

    // Create the transaction
    let spending_keys = SpendingKeys::from_unified_spending_key(usk);

    let mut transaction_created = false;
    let created = (|| -> Result<PendingBroadcast> {
        let txids = create_native_send_transactions(
            db,
            &state.network,
            prover,
            &spending_keys,
            &pending_proposal.proposal,
        )
        .map_err(|e| Error::SendError(format!("failed to create transaction: {e:?}")))?;
        transaction_created = true;

        // `create_proposed_transactions` returns `NonEmpty<TxId>`.
        let txid = *txids.first();
        let tx = db
            .get_transaction(txid)
            .map_err(|e| Error::SendError(format!("failed to read transaction: {e}")))?
            .ok_or_else(|| {
                Error::SendError("transaction not found in wallet DB after creation".into())
            })?;
        let mut raw_transaction = Vec::new();
        tx.write(&mut raw_transaction)
            .map_err(|e| Error::SendError(format!("failed to serialize transaction: {e}")))?;

        Ok(PendingBroadcast {
            wallet_id: wallet_id.clone(),
            proposal_id,
            txid: format!("{txid}"),
            txid_bytes: txid.as_ref().to_vec(),
            raw_transaction,
            // Until a complete lightwalletd response arrives, delivery is unknown.
            status: BroadcastStatus::Unknown,
            message: None,
            attempts: 0,
            had_ambiguous_attempt: false,
            recovery_error: None,
        })
    })();

    let record = match created {
        Ok(record) => record,
        Err(error) => {
            if transaction_created {
                tracing::error!(
                    "transaction was created but exact recovery bytes could not be prepared; leaving the fail-closed intent in place"
                );
            } else {
                match clear_pending_broadcast(&state.data_dir, &wallet_id) {
                    Ok(()) => *broadcast_guard = None,
                    Err(clear_error) => tracing::error!(
                        "transaction creation failed and its fail-closed intent could not be cleared: {clear_error}"
                    ),
                }
            }
            return Err(error);
        }
    };
    *broadcast_guard = Some(record);
    // Replace the intent with complete retry bytes before any network I/O.
    // If this fails, the in-memory record remains retryable and the durable
    // intent remains fail-closed after restart.
    let record = broadcast_guard
        .as_ref()
        .ok_or_else(|| Error::SendError("internal broadcast state was lost".into()))?;
    persist_pending_broadcast(&state.data_dir, record)?;

    // Drop cryptographic and database locks before network I/O. The broadcast
    // state lock stays held to serialize retries.
    drop(db_guard);
    drop(prover_guard);

    let record = broadcast_guard
        .as_mut()
        .ok_or_else(|| Error::SendError("internal broadcast state was lost".into()))?;
    broadcast_record(state, record).await
}

/// Discard exactly the native proposal the renderer is abandoning. Stale or
/// forged credentials never clear a newer proposal.
pub async fn discard_send_proposal(
    state: &WalletState,
    proposal_id: u32,
    review_digest: &str,
    proposal_token: &str,
) -> Result<()> {
    let _send_operation = state.send_operation.lock().await;
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    let mut proposal_guard = state.pending_proposal.lock().await;
    let discarded = take_authorized(&mut *proposal_guard, |pending| {
        pending.verify_proposal(
            proposal_id,
            review_digest,
            proposal_token,
            &wallet_id,
            &state.send_session_id,
        )
    })?;
    drop(discarded);
    Ok(())
}

pub async fn get_pending_send(state: &WalletState) -> Result<Option<PendingSendStatus>> {
    let pending = state.pending_broadcast.lock().await;
    Ok(pending.as_ref().map(PendingBroadcast::public_status))
}

pub async fn retry_pending_send(state: &WalletState) -> Result<ExecuteSendResult> {
    let _send_operation = state.send_operation.lock().await;
    if !state.is_initialized().await {
        return Err(Error::WalletNotInitialized);
    }
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    let mut pending = state.pending_broadcast.lock().await;
    let record = pending
        .as_mut()
        .ok_or_else(|| Error::SendError("there is no pending transaction to rebroadcast".into()))?;
    if record.wallet_id != wallet_id {
        return Err(Error::SendError(
            "pending transaction belongs to a different wallet".into(),
        ));
    }
    if let Some(error) = &record.recovery_error {
        return Err(Error::SendError(error.clone()));
    }
    if record.status != BroadcastStatus::Unknown {
        return Ok(ExecuteSendResult {
            txid: record.txid.clone(),
            status: record.status,
            message: record.message.clone(),
        });
    }
    broadcast_record(state, record).await
}

pub async fn discard_unrecoverable_send(
    state: &WalletState,
    proposal_id: u32,
    confirmation: &str,
) -> Result<()> {
    const REQUIRED_CONFIRMATION: &str = "I CHECKED WALLET HISTORY";
    let _send_operation = state.send_operation.lock().await;
    if confirmation != REQUIRED_CONFIRMATION {
        return Err(Error::SendError(
            "the unrecoverable-send confirmation phrase did not match".into(),
        ));
    }
    let wallet_id = state
        .active_wallet_id()
        .await
        .ok_or(Error::WalletNotInitialized)?;
    let mut pending = state.pending_broadcast.lock().await;
    let record = pending
        .as_ref()
        .ok_or_else(|| Error::SendError("there is no unrecoverable pending transaction".into()))?;
    if record.wallet_id != wallet_id || record.proposal_id != proposal_id {
        return Err(Error::SendError(
            "pending transaction does not match the active wallet".into(),
        ));
    }
    if !is_manually_discardable(record) {
        return Err(Error::SendError(
            "only an unrecoverable record without exact retry bytes can be discarded manually"
                .into(),
        ));
    }
    clear_pending_broadcast(&state.data_dir, &wallet_id)?;
    tracing::warn!(
        wallet_id = %wallet_id,
        proposal_id,
        "operator acknowledged wallet-history review and discarded unrecoverable send state"
    );
    *pending = None;
    *state.pending_proposal.lock().await = None;
    Ok(())
}

fn safe_remote_message(message: &str) -> String {
    message
        .chars()
        .filter(|character| !character.is_control() || character.is_ascii_whitespace())
        .take(240)
        .collect()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum LocalPendingState {
    Pending,
    Mined,
    Expired,
}

async fn local_pending_state(
    state: &WalletState,
    record: &mut PendingBroadcast,
) -> Result<LocalPendingState> {
    let txid_bytes: [u8; 32] = record.txid_bytes.as_slice().try_into().map_err(|_| {
        Error::SendError("pending transaction recovery data has an invalid txid".into())
    })?;
    let txid = TxId::from_bytes(txid_bytes);
    let db_guard = state.read_db.lock().await;
    let db = db_guard.as_ref().ok_or(Error::WalletNotInitialized)?;
    if db
        .get_tx_height(txid)
        .map_err(|error| {
            Error::DatabaseError(format!("failed to read transaction height: {error}"))
        })?
        .is_some()
    {
        return Ok(LocalPendingState::Mined);
    }
    let transaction = db
        .get_transaction(txid)
        .map_err(|error| {
            Error::DatabaseError(format!("failed to read pending transaction: {error}"))
        })?
        .ok_or_else(|| {
            Error::SendError("pending transaction is missing from the wallet database".into())
        });
    let transaction = match transaction {
        Ok(transaction) => transaction,
        Err(error) => {
            let message =
                "The wallet database is missing this transaction. The exact saved transaction remains locked for retry; restore the wallet database if reconciliation cannot complete."
                    .to_string();
            record.message = Some(message.clone());
            tracing::warn!(txid = %record.txid, "pending transaction is missing from the wallet database; retaining exact retry bytes");
            if let Err(persist_error) = persist_pending_broadcast(&state.data_dir, record) {
                tracing::error!(
                    "failed to persist missing-transaction recovery state: {persist_error}"
                );
            }
            tracing::debug!("wallet database lookup detail: {error}");
            return Ok(LocalPendingState::Pending);
        }
    };
    let expiry_height = transaction.expiry_height();
    if expiry_height == zcash_protocol::consensus::BlockHeight::from_u32(0) {
        return Ok(LocalPendingState::Pending);
    }
    let fully_scanned = db
        .block_fully_scanned()
        .map_err(|error| {
            Error::DatabaseError(format!("failed to read wallet scan height: {error}"))
        })?
        .map(|metadata| metadata.block_height());
    Ok(
        if fully_scanned.is_some_and(|height| height >= expiry_height) {
            LocalPendingState::Expired
        } else {
            LocalPendingState::Pending
        },
    )
}

fn apply_broadcast_result(
    state: &WalletState,
    record: &mut PendingBroadcast,
    result: ExecuteSendResult,
) -> ExecuteSendResult {
    record.status = result.status;
    record.message.clone_from(&result.message);
    let persistence = if result.status == BroadcastStatus::Accepted {
        clear_pending_broadcast(&state.data_dir, &record.wallet_id)
    } else {
        persist_pending_broadcast(&state.data_dir, record)
    };
    if let Err(error) = persistence {
        // The in-memory state remains fail-closed for this process. Never turn
        // a post-broadcast persistence problem into a retry that re-signs.
        tracing::error!("failed to update pending send recovery state: {error}");
    }
    result
}

fn resolve_local_pending_state(
    record: &PendingBroadcast,
    local_state: LocalPendingState,
) -> Option<ExecuteSendResult> {
    match local_state {
        LocalPendingState::Mined => Some(ExecuteSendResult {
            txid: record.txid.clone(),
            status: BroadcastStatus::Accepted,
            message: None,
        }),
        LocalPendingState::Expired => Some(ExecuteSendResult {
            txid: record.txid.clone(),
            status: BroadcastStatus::Rejected,
            message: Some(
                "The wallet has scanned beyond the transaction's expiry height without finding it. It is safe to create a new payment."
                    .into(),
            ),
        }),
        LocalPendingState::Pending => None,
    }
}

async fn broadcast_record(
    state: &WalletState,
    record: &mut PendingBroadcast,
) -> Result<ExecuteSendResult> {
    if let Some(error) = &record.recovery_error {
        return Err(Error::SendError(error.clone()));
    }

    let local_state = local_pending_state(state, record).await?;
    if let Some(result) = resolve_local_pending_state(record, local_state) {
        return Ok(apply_broadcast_result(state, record, result));
    }

    if let Err(error) = persist_pending_broadcast(&state.data_dir, record) {
        tracing::error!("refusing to broadcast without durable recovery state: {error}");
        let result = ExecuteSendResult {
            txid: record.txid.clone(),
            status: BroadcastStatus::Unknown,
            message: Some(
                "The transaction was created but recovery state could not be saved, so it was not broadcast. Keep the app open and retry this exact transaction."
                    .into(),
            ),
        };
        record.status = result.status;
        record.message.clone_from(&result.message);
        return Ok(result);
    }

    let url = state.lightwalletd_url.read().await.clone();
    let mut client =
        match tokio::time::timeout(CONNECT_TIMEOUT, connect_to_lightwalletd(&url)).await {
            Ok(Ok(client)) => client,
            Ok(Err(error)) => {
                tracing::warn!("pending send could not connect to lightwalletd: {error}");
                return Ok(apply_broadcast_result(
                    state,
                    record,
                    classify_broadcast_response(
                        record.txid.clone(),
                        record.had_ambiguous_attempt,
                        None,
                    ),
                ));
            }
            Err(_) => {
                tracing::warn!("pending send lightwalletd connection timed out");
                return Ok(apply_broadcast_result(
                    state,
                    record,
                    classify_broadcast_response(
                        record.txid.clone(),
                        record.had_ambiguous_attempt,
                        None,
                    ),
                ));
            }
        };

    if record.attempts > 0 {
        let lookup = tokio::time::timeout(
            RPC_TIMEOUT,
            client.get_transaction(TxFilter {
                block: None,
                index: 0,
                hash: record.txid_bytes.clone(),
            }),
        )
        .await;
        match lookup {
            Ok(Ok(response)) => {
                let returned = response.into_inner();
                if remote_lookup_matches(record, &returned.data) {
                    return Ok(apply_broadcast_result(
                        state,
                        record,
                        ExecuteSendResult {
                            txid: record.txid.clone(),
                            status: BroadcastStatus::Accepted,
                            message: None,
                        },
                    ));
                }
                tracing::warn!(
                    "lightwalletd returned different bytes for the pending txid; retaining recovery state and rebroadcasting the exact local transaction"
                );
            }
            Ok(Err(status)) if status.code() == tonic::Code::NotFound => {
                let local_state = local_pending_state(state, record).await?;
                if let Some(result) = resolve_local_pending_state(record, local_state) {
                    return Ok(apply_broadcast_result(state, record, result));
                }
            }
            Ok(Err(status)) => tracing::warn!(
                code = ?status.code(),
                "pending send txid lookup failed; rebroadcasting identical bytes"
            ),
            Err(_) => {
                tracing::warn!("pending send txid lookup timed out; rebroadcasting identical bytes")
            }
        }
    }

    let ambiguity_before_attempt = record.had_ambiguous_attempt;
    // Persist pessimistically before entering the RPC. A process crash during
    // `send_transaction` is itself ambiguous and must survive restart.
    record.had_ambiguous_attempt = true;
    let attempts_before_attempt = record.attempts;
    record.attempts = record.attempts.saturating_add(1);
    if let Err(error) = persist_pending_broadcast(&state.data_dir, record) {
        record.had_ambiguous_attempt = ambiguity_before_attempt;
        record.attempts = attempts_before_attempt;
        tracing::error!("refusing to broadcast without durable attempt state: {error}");
        return Ok(apply_broadcast_result(
            state,
            record,
            classify_broadcast_response(record.txid.clone(), record.had_ambiguous_attempt, None),
        ));
    }

    let response = match tokio::time::timeout(
        RPC_TIMEOUT,
        client.send_transaction(RawTransaction {
            data: record.raw_transaction.clone(),
            height: 0,
        }),
    )
    .await
    {
        Ok(Ok(response)) => {
            let response = response.into_inner();
            if response.error_code != 0 {
                tracing::warn!(
                    error_code = response.error_code,
                    error_message = %safe_remote_message(&response.error_message),
                    "lightwalletd rejected a transaction broadcast"
                );
            }
            Some((response.error_code, response.error_message))
        }
        Ok(Err(status)) => {
            tracing::warn!(code = ?status.code(), "transaction broadcast response was ambiguous");
            None
        }
        Err(_) => {
            tracing::warn!("transaction broadcast timed out with ambiguous status");
            None
        }
    };

    if response.is_some() {
        // A complete RPC response removes only the pessimism introduced for
        // this attempt; ambiguity from any earlier attempt remains sticky.
        record.had_ambiguous_attempt = ambiguity_before_attempt;
    }
    Ok(apply_broadcast_result(
        state,
        record,
        classify_broadcast_response(record.txid.clone(), record.had_ambiguous_attempt, response),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use transparent::{
        bundle::{OutPoint, TxOut},
        keys::TransparentKeyScope,
    };
    use zcash_address::unified::{Address as UnifiedAddress, Encoding, Receiver};
    use zcash_client_backend::data_api::Account;
    use zcash_client_backend::data_api::testing::{
        orchard::OrchardPoolTester,
        pool::{ShieldedPoolTester, dsl::TestDsl},
    };
    use zcash_client_backend::data_api::wallet::input_selection::TransparentSpendPolicy;
    use zcash_client_backend::wallet::WalletTransparentOutput;
    use zcash_client_sqlite::testing::{BlockCache, db::TestDbFactory};
    use zcash_protocol::consensus::{Network, NetworkType};

    const MAINNET_TADDR: &str = "t1Hsc1LR8yKnbbe3twRp88p6vFfC5t7DLbs";
    const TESTNET_TADDR: &str = "tm9iMLAuYMzJ6jtFLcA7rzUmfreGuKvr7Ma";
    const MAINNET_SAPLING: &str =
        "zs1qqqqqqqqqqqqqqqqqqcguyvaw2vjk4sdyeg0lc970u659lvhqq7t0np6hlup5lusxle75c8v35z";
    const MAINNET_TEX: &str = "tex1s2rt77ggv6q989lr49rkgzmh5slsksa9khdgte";
    const WALLET_ID: &str = "wallet-a";
    const SESSION_ID: [u8; 32] = [0x11; 32];
    const OTHER_SESSION_ID: [u8; 32] = [0x22; 32];

    fn payment_request(
        network: &impl consensus::Parameters,
        recipient: &Address,
        amount: u64,
    ) -> zip321::TransactionRequest {
        zip321::TransactionRequest::new(vec![zip321::Payment::without_memo(
            recipient.to_zcash_address(network),
            Zatoshis::const_from_u64(amount),
        )])
        .expect("the independently fixed test payment is valid")
    }

    #[test]
    fn production_send_boundaries_preserve_pool_depth_fee_and_sender_recovery() {
        const NOTE_VALUE: u64 = 60_000;
        const FIXED_SEND_VALUE: u64 = 10_000;
        const SEND_ALL_VALUE: u64 = 50_000;
        const EXPECTED_FEE: u64 = 10_000;

        let mut st =
            TestDsl::with_sapling_birthday_account(TestDbFactory::default(), BlockCache::new())
                .build::<OrchardPoolTester>();
        let (_, _, _) = st.add_a_single_note_checking_balance(Zatoshis::const_from_u64(NOTE_VALUE));

        let recipient_key = OrchardPoolTester::sk(&[0xf5; 32]);
        let recipient = OrchardPoolTester::sk_default_address(&recipient_key);
        let account = st.get_account();
        let account_id = account.id();
        let network = *st.network();

        let immature = propose_fixed_native_send(
            st.wallet_mut(),
            &network,
            account_id,
            payment_request(&network, &recipient, FIXED_SEND_VALUE),
        );
        assert!(
            immature.is_err(),
            "an externally received Orchard note must not be spendable after one confirmation"
        );

        st.add_empty_blocks(9);
        let proposal = propose_fixed_native_send(
            st.wallet_mut(),
            &network,
            account_id,
            payment_request(&network, &recipient, FIXED_SEND_VALUE),
        )
        .expect("the same Orchard note must be spendable after ten confirmations");
        assert_eq!(proposal.steps().len(), 1);
        assert_eq!(proposal.input_count_in_pool(PoolType::ORCHARD), 1);
        assert_eq!(proposal.input_count_in_pool(PoolType::SAPLING), 0);
        assert_eq!(
            proposal
                .steps()
                .head
                .change_count_in_pool(PoolType::ORCHARD),
            1
        );
        assert_eq!(
            proposal
                .steps()
                .head
                .change_count_in_pool(PoolType::SAPLING),
            0
        );
        assert_eq!(
            u64::from(proposal.steps().head.balance().fee_required()),
            EXPECTED_FEE
        );

        // Exercise the production wrapper used by every send-all retry. Spending the
        // independently fixed note value minus the expected fee must consume the whole note,
        // retain ZIP 317's fee, and return no value as change. Orchard padding can retain a
        // zero-valued change entry, so value rather than vector shape is the behavior at stake.
        let send_all_proposal = propose_send_all_native_attempt(
            st.wallet_mut(),
            &network,
            account_id,
            payment_request(&network, &recipient, SEND_ALL_VALUE),
        )
        .expect("the send-all-shaped request must be proposed by the shared boundary");
        assert_eq!(send_all_proposal.input_count_in_pool(PoolType::ORCHARD), 1);
        assert_eq!(
            u64::from(send_all_proposal.steps().head.balance().fee_required()),
            EXPECTED_FEE
        );
        assert_eq!(
            send_all_proposal
                .steps()
                .head
                .balance()
                .proposed_change()
                .iter()
                .map(|change| u64::from(change.value()))
                .sum::<u64>(),
            0
        );

        let spending_keys = SpendingKeys::from_unified_spending_key(account.usk().clone());
        let prover = LocalTxProver::bundled();
        let recovery_height = proposal.min_target_height().into();
        let txids = create_native_send_transactions(
            st.wallet_mut(),
            &network,
            &prover,
            &spending_keys,
            &proposal,
        )
        .expect("the production creation boundary must build and persist the transaction");
        let tx = st
            .wallet()
            .get_transaction(txids.head)
            .expect("the test wallet database remains readable")
            .expect("the created transaction is persisted");
        let sender_fvk = OrchardPoolTester::test_account_fvk(&st);
        let (_, recovered_recipient, _) =
            OrchardPoolTester::try_output_recovery(&network, recovery_height, &tx, &sender_fvk)
                .expect("the sender OVK must recover the external Orchard output");
        assert_eq!(recovered_recipient, recipient);
    }

    #[test]
    fn production_transparent_spend_shields_change_to_orchard() {
        const UTXO_VALUE: u64 = 60_000;
        const PAYMENT_VALUE: u64 = 10_000;
        const EXPECTED_CHANGE: u64 = 35_000;

        let mut st =
            TestDsl::with_sapling_birthday_account(TestDbFactory::default(), BlockCache::new())
                .build::<OrchardPoolTester>();
        let account = st.get_account();
        let account_id = account.id();
        let network = *st.network();
        let (transparent_recipient, _) = account.usk().default_transparent_address();
        let received_height = st.add_empty_blocks(1);
        let utxo = WalletTransparentOutput::from_parts(
            OutPoint::fake(),
            TxOut::new(
                Zatoshis::const_from_u64(UTXO_VALUE),
                transparent_recipient.script().into(),
            ),
            Some(received_height),
            Some(account_id),
            Some(TransparentKeyScope::EXTERNAL),
            None,
        )
        .expect("the independently constructed transparent UTXO is valid");
        st.wallet_mut()
            .put_received_transparent_utxo(&utxo)
            .expect("the real wallet database accepts the transparent UTXO");
        st.add_empty_blocks(9);

        let spend_policy =
            SpendPolicy::default().with_transparent(TransparentSpendPolicy::any_account_addr());
        let proposal = propose_native_send_with_policy(
            st.wallet_mut(),
            &network,
            account_id,
            payment_request(
                &network,
                &Address::from(transparent_recipient),
                PAYMENT_VALUE,
            ),
            &spend_policy,
        )
        .expect("the production proposal core proposes the mature transparent spend");
        assert_eq!(proposal.input_count_in_pool(PoolType::TRANSPARENT), 1);
        assert_eq!(
            proposal
                .steps()
                .head
                .change_count_in_pool(PoolType::ORCHARD),
            1
        );
        assert_eq!(
            proposal
                .steps()
                .head
                .change_count_in_pool(PoolType::SAPLING),
            0
        );
        assert_eq!(
            proposal
                .steps()
                .head
                .balance()
                .proposed_change()
                .iter()
                .map(|change| u64::from(change.value()))
                .sum::<u64>(),
            EXPECTED_CHANGE
        );
    }

    #[test]
    fn proposal_defaults_preserve_unlocked_height_selected_transactions() {
        assert!(proposal_lock_request().is_none());
        assert!(proposed_transaction_version().is_none());
    }

    fn pending(status: BroadcastStatus) -> PendingBroadcast {
        PendingBroadcast {
            wallet_id: "wallet_test".into(),
            proposal_id: 7,
            txid: "00".repeat(32),
            txid_bytes: vec![0; 32],
            raw_transaction: vec![1, 2, 3, 4],
            status,
            message: None,
            attempts: 0,
            had_ambiguous_attempt: false,
            recovery_error: None,
        }
    }

    fn review() -> SendReview {
        SendReview {
            version: SEND_REVIEW_VERSION,
            network: "mainnet".into(),
            payments: vec![SendPaymentReview {
                recipient: MAINNET_TADDR.into(),
                amount: 50_000,
                memo: Some("exact private memo".into()),
            }],
            fee_policy: SEND_FEE_POLICY.into(),
            fee: 10_000,
            total: 60_000,
            change_policy: SEND_CHANGE_POLICY.into(),
        }
    }

    fn digest(review: &SendReview) -> String {
        send_review_digest(review, 17, WALLET_ID, &SESSION_ID)
    }

    fn authorization(proposal_token: &str) -> ProposalAuthorization {
        let review_digest = digest(&review());
        ProposalAuthorization {
            proposal_id: 17,
            wallet_id: WALLET_ID.into(),
            session_id: SESSION_ID,
            proposal_token_hash: bound_token_hash(
                SEND_PROPOSAL_TOKEN_DOMAIN,
                proposal_token,
                &review_digest,
            ),
            review_digest,
            execution: None,
        }
    }

    fn authorize_execution(
        authorization: &mut ProposalAuthorization,
        confirmation_token: &str,
        issued_at_monotonic: Instant,
        issued_at_wall: SystemTime,
    ) {
        authorization.execution = Some(ExecutionAuthorization {
            confirmation_token_hash: bound_token_hash(
                SEND_CONFIRMATION_TOKEN_DOMAIN,
                confirmation_token,
                &authorization.review_digest,
            ),
            issued_at_wall,
            expires_at_monotonic: issued_at_monotonic + SEND_CONFIRMATION_TTL,
            expires_at_wall: issued_at_wall + SEND_CONFIRMATION_TTL,
        });
    }

    #[test]
    fn review_digest_binds_every_ordered_review_field() {
        let original = review();
        let original_digest = digest(&original);
        let mut ordered = original.clone();
        ordered.payments.push(SendPaymentReview {
            recipient: "second-recipient".into(),
            amount: 1,
            memo: None,
        });
        let mut reordered = ordered.clone();
        reordered.payments.reverse();
        assert_ne!(digest(&ordered), digest(&reordered));
        let mutations = [
            SendReview {
                version: SEND_REVIEW_VERSION + 1,
                ..original.clone()
            },
            SendReview {
                network: "testnet".into(),
                ..original.clone()
            },
            SendReview {
                payments: vec![SendPaymentReview {
                    recipient: TESTNET_TADDR.into(),
                    ..original.payments[0].clone()
                }],
                ..original.clone()
            },
            SendReview {
                payments: vec![SendPaymentReview {
                    amount: 50_001,
                    ..original.payments[0].clone()
                }],
                ..original.clone()
            },
            SendReview {
                payments: vec![SendPaymentReview {
                    memo: None,
                    ..original.payments[0].clone()
                }],
                ..original.clone()
            },
            SendReview {
                fee_policy: "different".into(),
                ..original.clone()
            },
            SendReview {
                fee: 20_000,
                ..original.clone()
            },
            SendReview {
                total: 70_000,
                ..original.clone()
            },
            SendReview {
                change_policy: "different".into(),
                ..original.clone()
            },
        ];

        for mutation in mutations {
            assert_ne!(digest(&mutation), original_digest);
        }
        assert_ne!(
            send_review_digest(&original, 18, WALLET_ID, &SESSION_ID),
            original_digest
        );
        assert_ne!(
            send_review_digest(&original, 17, "wallet-b", &SESSION_ID),
            original_digest
        );
        assert_ne!(
            send_review_digest(&original, 17, WALLET_ID, &OTHER_SESSION_ID),
            original_digest
        );
    }

    #[test]
    fn native_confirmation_is_required_exact_expiring_and_one_use() {
        let proposal_token = "opaque-proposal-token";
        let confirmation_token = "opaque-confirmation-token";
        let review_digest = digest(&review());
        let now = Instant::now();
        let wall_now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let clock = ConfirmationClock {
            monotonic: now,
            wall: wall_now,
        };
        let mut pending = authorization(proposal_token);

        assert!(
            pending
                .verify_execution(
                    17,
                    &review_digest,
                    confirmation_token,
                    WALLET_ID,
                    &SESSION_ID,
                    clock,
                )
                .unwrap_err()
                .to_string()
                .contains("native payment confirmation is required")
        );
        authorize_execution(&mut pending, confirmation_token, now, wall_now);
        let mut slot = Some(pending);

        assert!(
            take_authorized(&mut slot, |pending| {
                pending.verify_execution(
                    17,
                    &review_digest,
                    confirmation_token,
                    WALLET_ID,
                    &SESSION_ID,
                    clock,
                )
            })
            .is_ok()
        );
        assert!(slot.is_none());
        assert!(take_authorized(&mut slot, |_| Ok(())).is_err());
    }

    #[test]
    fn stale_or_context_mismatched_confirmation_cannot_consume_the_proposal() {
        let confirmation_token = "opaque-confirmation-token";
        let review_digest = digest(&review());
        let now = Instant::now();
        let wall_now = UNIX_EPOCH + Duration::from_secs(1_000_000);
        let clock = ConfirmationClock {
            monotonic: now,
            wall: wall_now,
        };
        for (wallet_id, session_id, supplied_digest, supplied_token) in [
            (
                "wallet-b",
                &SESSION_ID,
                review_digest.as_str(),
                confirmation_token,
            ),
            (
                WALLET_ID,
                &OTHER_SESSION_ID,
                review_digest.as_str(),
                confirmation_token,
            ),
            (WALLET_ID, &SESSION_ID, "wrong-digest", confirmation_token),
            (
                WALLET_ID,
                &SESSION_ID,
                review_digest.as_str(),
                "wrong-token",
            ),
        ] {
            let mut pending = authorization("proposal-token");
            authorize_execution(&mut pending, confirmation_token, now, wall_now);
            let mut slot = Some(pending);
            assert!(
                take_authorized(&mut slot, |pending| {
                    pending.verify_execution(
                        17,
                        supplied_digest,
                        supplied_token,
                        wallet_id,
                        session_id,
                        clock,
                    )
                })
                .is_err()
            );
            assert!(slot.is_some());
        }
    }

    #[test]
    fn confirmation_rejects_either_expiry_clock_and_wall_rollback() {
        let confirmation_token = "opaque-confirmation-token";
        let review_digest = digest(&review());
        let issued_monotonic = Instant::now();
        let issued_wall = UNIX_EPOCH + Duration::from_secs(1_000_000);

        for now in [
            // Monotonic expiry remains authoritative if the wall clock pauses.
            ConfirmationClock {
                monotonic: issued_monotonic + SEND_CONFIRMATION_TTL,
                wall: issued_wall,
            },
            // Wall expiry catches device suspend while monotonic time pauses.
            ConfirmationClock {
                monotonic: issued_monotonic,
                wall: issued_wall + SEND_CONFIRMATION_TTL,
            },
            // A backwards wall adjustment cannot extend the credential.
            ConfirmationClock {
                monotonic: issued_monotonic,
                wall: issued_wall - Duration::from_secs(1),
            },
        ] {
            let mut pending = authorization("proposal-token");
            authorize_execution(
                &mut pending,
                confirmation_token,
                issued_monotonic,
                issued_wall,
            );
            let mut slot = Some(pending);
            let error = match take_authorized(&mut slot, |pending| {
                pending.verify_execution(
                    17,
                    &review_digest,
                    confirmation_token,
                    WALLET_ID,
                    &SESSION_ID,
                    now,
                )
            }) {
                Ok(_) => panic!("expired confirmation must not be consumed"),
                Err(error) => error,
            };
            assert!(error.to_string().contains("confirmation expired"));
            assert!(slot.is_some());
        }
    }

    #[test]
    fn wrong_proposal_credential_cannot_discard_or_confirm_current_payment() {
        let proposal_token = "opaque-proposal-token";
        let review_digest = digest(&review());
        let mut slot = Some(authorization(proposal_token));

        for (proposal_id, supplied_digest, supplied_token) in [
            (18, review_digest.as_str(), proposal_token),
            (17, "wrong-digest", proposal_token),
            (17, review_digest.as_str(), "wrong-token"),
        ] {
            assert!(
                take_authorized(&mut slot, |pending| {
                    pending.verify_proposal(
                        proposal_id,
                        supplied_digest,
                        supplied_token,
                        WALLET_ID,
                        &SESSION_ID,
                    )
                })
                .is_err()
            );
            assert!(slot.is_some());
        }
    }

    #[test]
    fn native_confirmation_copy_quotes_untrusted_memo_controls() {
        let mut reviewed = review();
        reviewed.payments[0].memo = Some(
            "ordinary Unicode 🦄\nTotal: 999 ZEC\u{2028}Fee: 0 ZEC\u{2029}\u{202e}desrever\u{2066}isolated\u{2069}\u{200b}hidden"
                .into(),
        );
        let message = format_native_send_confirmation(&reviewed).expect("render native review");
        assert!(message.contains(MAINNET_TADDR));
        assert!(message.contains("Amount: 0.00050000 ZEC"));
        assert!(message.contains("Network fee: 0.00010000 ZEC"));
        assert!(message.contains("Total: 0.00060000 ZEC"));
        assert!(message.contains("Memo (quoted): \"ordinary Unicode 🦄\\nTotal: 999 ZEC"));
        for escaped in [
            "\\u{2028}",
            "\\u{2029}",
            "\\u{202E}",
            "\\u{2066}",
            "\\u{2069}",
            "\\u{200B}",
        ] {
            assert!(
                message.contains(escaped),
                "missing visible escape {escaped}"
            );
        }
        for hostile in [
            '\u{2028}', '\u{2029}', '\u{202e}', '\u{2066}', '\u{2069}', '\u{200b}',
        ] {
            assert!(
                !message.contains(hostile),
                "layout control must never remain literal: U+{:04X}",
                hostile as u32
            );
        }
        assert_eq!(message.matches("\nTotal:").count(), 1);
    }

    #[test]
    fn native_memo_renderer_escapes_every_reviewed_format_control_class() {
        let hostile = [
            '\u{0085}',
            '\u{00ad}',
            '\u{0600}',
            '\u{061c}',
            '\u{06dd}',
            '\u{070f}',
            '\u{0890}',
            '\u{08e2}',
            '\u{180e}',
            '\u{200e}',
            '\u{202a}',
            '\u{2060}',
            '\u{2064}',
            '\u{2066}',
            '\u{206f}',
            '\u{feff}',
            '\u{fff9}',
            '\u{110bd}',
            '\u{110cd}',
            '\u{13430}',
            '\u{1bca0}',
            '\u{1d173}',
            '\u{e0001}',
            '\u{e0020}',
            '\u{e007f}',
        ];
        let memo: String = hostile.into_iter().collect();
        let quoted = quote_native_memo(&memo);

        for character in hostile {
            assert!(!quoted.contains(character));
            assert!(quoted.contains(&format!("\\u{{{:X}}}", character as u32)));
        }
    }

    #[test]
    fn no_prover_fails_before_execution() {
        let error = match require_prover(None) {
            Ok(_) => panic!("missing prover must fail closed"),
            Err(error) => error,
        };
        assert!(
            error
                .to_string()
                .contains("proving parameters are not ready")
        );
    }

    #[test]
    fn wrong_network_address_is_rejected() {
        let validation = validate_recipient_address(&Network::MainNetwork, TESTNET_TADDR);
        assert!(!validation.valid);
        assert_eq!(
            validation.error.as_deref(),
            Some("address belongs to a different Zcash network")
        );

        let mainnet = validate_recipient_address(&Network::MainNetwork, MAINNET_TADDR);
        assert!(mainnet.valid);
        assert_eq!(mainnet.address_type.as_deref(), Some("transparent"));
    }

    #[test]
    fn zip321_requires_exactly_one_payment() {
        let uri =
            format!("zcash:?address={MAINNET_TADDR}&amount=1&address.1={MAINNET_TADDR}&amount.1=2");
        let error = parse_payment_uri(&Network::MainNetwork, &uri).unwrap_err();
        assert_eq!(
            error.to_string(),
            "payment URI must contain exactly one payment; found 2"
        );

        let empty = parse_payment_uri(&Network::MainNetwork, "zcash:").unwrap_err();
        assert_eq!(
            empty.to_string(),
            "payment URI must contain exactly one payment; found 0"
        );
    }

    #[test]
    fn zip321_recipient_is_bound_to_the_active_network() {
        let wrong_network = format!("zcash:{TESTNET_TADDR}?amount=1");
        let error = parse_payment_uri(&Network::MainNetwork, &wrong_network).unwrap_err();
        assert_eq!(
            error.to_string(),
            "address error: address belongs to a different Zcash network"
        );

        let mainnet = format!("zcash:{MAINNET_TADDR}?amount=1");
        let request = parse_payment_uri(&Network::MainNetwork, &mainnet).unwrap();
        assert_eq!(request.address, MAINNET_TADDR);
        assert_eq!(request.amount, Some(100_000_000));
    }

    #[test]
    fn zip321_text_memo_is_returned_as_text_not_debug_bytes() {
        let uri = format!("zcash:{MAINNET_SAPLING}?amount=1&memo=aGVsbG8");
        let request = parse_payment_uri(&Network::MainNetwork, &uri).unwrap();
        assert_eq!(request.memo.as_deref(), Some("hello"));
    }

    #[test]
    fn zip321_opaque_or_invalid_memo_is_rejected_instead_of_rewritten() {
        let future = MemoBytes::from_bytes(&[0xf5]).unwrap();
        let future_uri = format!(
            "zcash:{MAINNET_SAPLING}?amount=1&memo={}",
            zip321::memo_to_base64(&future)
        );
        assert_eq!(
            parse_payment_uri(&Network::MainNetwork, &future_uri)
                .unwrap_err()
                .to_string(),
            "payment URI contains a non-text memo unsupported by this app"
        );

        let invalid_utf8 = MemoBytes::from_bytes(&[0xc3, 0x28]).unwrap();
        let invalid_uri = format!(
            "zcash:{MAINNET_SAPLING}?amount=1&memo={}",
            zip321::memo_to_base64(&invalid_utf8)
        );
        assert!(
            parse_payment_uri(&Network::MainNetwork, &invalid_uri)
                .unwrap_err()
                .to_string()
                .contains("payment URI contains an invalid memo")
        );
    }

    #[test]
    fn unified_address_requires_a_receiver_this_wallet_can_pay() {
        let unknown_only = UnifiedAddress::try_from_items(vec![Receiver::Unknown {
            typecode: 0x04,
            data: vec![0x42; 32],
        }])
        .unwrap()
        .encode(&NetworkType::Main);
        let validation = validate_recipient_address(&Network::MainNetwork, &unknown_only);
        assert!(!validation.valid);
        assert_eq!(
            validation.error.as_deref(),
            Some("Unified address contains no receiver supported by this wallet")
        );

        let uri = format!("zcash:{unknown_only}?amount=1");
        assert_eq!(
            parse_payment_uri(&Network::MainNetwork, &uri)
                .unwrap_err()
                .to_string(),
            "address error: Unified address contains no receiver supported by this wallet"
        );
    }

    #[test]
    fn unified_address_with_a_supported_receiver_remains_valid() {
        let supported = UnifiedAddress::try_from_items(vec![
            Receiver::P2pkh([0x24; 20]),
            Receiver::Unknown {
                typecode: 0x04,
                data: vec![0x42; 32],
            },
        ])
        .unwrap()
        .encode(&NetworkType::Main);
        let validation = validate_recipient_address(&Network::MainNetwork, &supported);
        assert!(validation.valid);
        assert_eq!(validation.address_type.as_deref(), Some("unified"));
        assert!(!validation.can_receive_memo);
    }

    #[test]
    fn tex_is_rejected_until_ordered_batch_recovery_exists() {
        let validation = validate_recipient_address(&Network::MainNetwork, MAINNET_TEX);
        assert!(!validation.valid);
        assert!(
            validation
                .error
                .as_deref()
                .is_some_and(|message| { message.contains("ordered multi-transaction recovery") })
        );
    }

    #[test]
    fn rejected_proposal_never_replaces_executable_state() {
        let mut slot = Some("existing");
        let rejected: std::result::Result<(&str, ()), &str> = Err("rejected");
        assert_eq!(
            install_accepted_proposal(&mut slot, rejected),
            Err("rejected")
        );
        assert_eq!(slot, None);
    }

    #[test]
    fn broadcast_success_is_explicit() {
        let result = classify_broadcast_response("txid".into(), false, Some((0, String::new())));
        assert_eq!(result.status, BroadcastStatus::Accepted);
        assert_eq!(result.txid, "txid");
        assert_eq!(result.message, None);
    }

    #[test]
    fn broadcast_rejection_is_explicit_and_remote_text_is_not_echoed() {
        let result = classify_broadcast_response(
            "txid".into(),
            false,
            Some((16, "remote detail that must not reach logs or UI".into())),
        );
        assert_eq!(result.status, BroadcastStatus::Rejected);
        assert_eq!(
            result.message.as_deref(),
            Some("lightwalletd rejected the transaction (code 16)")
        );
    }

    #[test]
    fn ambiguous_broadcast_blocks_new_proposal_and_preserves_retry_bytes() {
        let record = pending(BroadcastStatus::Unknown);
        let original_bytes = record.raw_transaction.clone();
        assert!(ensure_no_unresolved_broadcast(Some(&record)).is_err());

        let result = classify_broadcast_response(record.txid.clone(), true, None);
        assert_eq!(result.status, BroadcastStatus::Unknown);
        assert_eq!(record.raw_transaction, original_bytes);
        assert!(
            result
                .message
                .as_deref()
                .is_some_and(|message| message.contains("exact transaction"))
        );
    }

    #[test]
    fn accepted_broadcast_allows_next_proposal() {
        let record = pending(BroadcastStatus::Accepted);
        assert!(ensure_no_unresolved_broadcast(Some(&record)).is_ok());
    }

    #[test]
    fn definite_rejection_allows_a_new_proposal() {
        let record = pending(BroadcastStatus::Rejected);
        assert!(ensure_no_unresolved_broadcast(Some(&record)).is_ok());
    }

    #[test]
    fn ambiguous_retry_never_downgrades_to_rejected() {
        let result = classify_broadcast_response(
            "txid".into(),
            true,
            Some((-26, "txn-mempool-conflict".into())),
        );
        assert_eq!(result.status, BroadcastStatus::Unknown);
    }

    #[test]
    fn locally_expired_ambiguous_send_resolves_without_rebroadcast() {
        let mut record = pending(BroadcastStatus::Unknown);
        record.attempts = 1;
        record.had_ambiguous_attempt = true;

        let result = resolve_local_pending_state(&record, LocalPendingState::Expired)
            .expect("expiry must resolve before any remote lookup or rebroadcast");

        assert_eq!(result.status, BroadcastStatus::Rejected);
        assert_eq!(result.txid, record.txid);
        assert!(result.message.as_deref().is_some_and(|message| {
            message.contains("scanned beyond the transaction's expiry height")
        }));
    }

    #[test]
    fn definite_rejection_does_not_become_ambiguous_on_retry() {
        let result = classify_broadcast_response(
            "txid".into(),
            false,
            Some((-26, "bad-txns-inputs-spent".into())),
        );
        assert_eq!(result.status, BroadcastStatus::Rejected);
    }

    #[test]
    fn already_known_retry_is_accepted() {
        let result = classify_broadcast_response(
            "txid".into(),
            true,
            Some((-27, "transaction already in block chain".into())),
        );
        assert_eq!(result.status, BroadcastStatus::Accepted);
    }

    #[test]
    fn attacker_controlled_already_known_text_cannot_fake_acceptance() {
        let result = classify_broadcast_response(
            "txid".into(),
            false,
            Some((-26, "already in block chain".into())),
        );
        assert_eq!(result.status, BroadcastStatus::Rejected);
    }

    #[test]
    fn txid_lookup_requires_the_exact_persisted_transaction_bytes() {
        let record = pending(BroadcastStatus::Unknown);
        assert!(remote_lookup_matches(&record, &record.raw_transaction));
        assert!(!remote_lookup_matches(&record, &[9, 9, 9]));
    }

    #[test]
    fn complete_transaction_is_never_manually_discardable() {
        let mut record = pending(BroadcastStatus::Unknown);
        record.recovery_error = Some("wallet DB row missing".into());
        assert!(!is_manually_discardable(&record));

        record.txid = "unavailable".into();
        record.txid_bytes.clear();
        record.raw_transaction.clear();
        assert!(!is_manually_discardable(&record));
        record.recovery_error = Some(INTERRUPTED_CREATION_RECOVERY_ERROR.into());
        assert!(is_manually_discardable(&record));
    }

    #[test]
    fn pending_broadcast_survives_state_reconstruction() {
        let directory =
            std::env::temp_dir().join(format!("zuuli-pending-send-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let mut record = pending(BroadcastStatus::Unknown);
        record.attempts = 1;
        persist_pending_broadcast(&directory, &record).expect("persist recovery state");

        let loaded =
            load_pending_broadcast(&directory, &record.wallet_id).expect("load recovery state");
        assert_eq!(loaded.status, BroadcastStatus::Unknown);
        assert_eq!(loaded.attempts, 1);
        assert_eq!(loaded.raw_transaction, record.raw_transaction);
        assert!(ensure_no_unresolved_broadcast(Some(&loaded)).is_err());

        clear_pending_broadcast(&directory, &record.wallet_id).expect("clear recovery state");
        std::fs::remove_dir(&directory).expect("remove test directory");
    }

    #[test]
    fn legacy_missing_db_error_migrates_complete_transaction_to_exact_retry() {
        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-missing-db-migration-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let mut record = pending(BroadcastStatus::Unknown);
        record.recovery_error = Some("wallet DB row missing".into());
        persist_pending_broadcast(&directory, &record).expect("persist legacy recovery state");

        let loaded = load_pending_broadcast(&directory, &record.wallet_id)
            .expect("load complete recovery state");
        assert!(loaded.recovery_error.is_none());
        assert_eq!(loaded.raw_transaction, record.raw_transaction);
        assert!(!is_manually_discardable(&loaded));
        assert!(ensure_no_unresolved_broadcast(Some(&loaded)).is_err());

        clear_pending_broadcast(&directory, &record.wallet_id).expect("clear recovery state");
        std::fs::remove_dir(&directory).expect("remove test directory");
    }

    #[cfg(unix)]
    #[test]
    fn unique_temporary_file_never_follows_stale_deterministic_symlink() {
        use std::os::unix::fs::symlink;

        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-stale-temp-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let victim = directory.join("victim");
        std::fs::write(&victim, b"must not change").expect("write victim");
        let stale = pending_broadcast_path(&directory, "wallet_test")
            .expect("journal path")
            .with_extension("json.tmp");
        symlink(&victim, &stale).expect("create stale temporary symlink");

        let record = pending(BroadcastStatus::Unknown);
        persist_pending_broadcast(&directory, &record)
            .expect("unique create-new temporary must bypass stale name");
        assert_eq!(
            std::fs::read(&victim).expect("read victim"),
            b"must not change"
        );
        assert!(
            std::fs::symlink_metadata(&stale)
                .expect("stale link remains untouched")
                .file_type()
                .is_symlink()
        );
        assert_eq!(
            load_pending_broadcast(&directory, &record.wallet_id)
                .expect("load committed journal")
                .raw_transaction,
            record.raw_transaction
        );

        clear_pending_broadcast(&directory, &record.wallet_id).expect("clear journal");
        std::fs::remove_file(stale).expect("remove stale link");
        std::fs::remove_file(victim).expect("remove victim");
        std::fs::remove_dir(directory).expect("remove test directory");
    }

    #[cfg(unix)]
    #[test]
    fn linked_stable_and_backup_paths_fail_closed_without_touching_targets() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-linked-path-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let victim = directory.join("victim");
        std::fs::write(&victim, b"must not change").expect("write victim");
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o600))
            .expect("secure victim permissions");
        let record = pending(BroadcastStatus::Unknown);
        let stable = pending_broadcast_path(&directory, &record.wallet_id).expect("journal path");
        symlink(&victim, &stable).expect("create stable symlink");

        let loaded = load_pending_broadcast(&directory, &record.wallet_id)
            .expect("unsafe stable path must remain represented");
        assert!(loaded.recovery_error.is_some());
        assert!(persist_pending_broadcast(&directory, &record).is_err());
        assert!(clear_pending_broadcast(&directory, &record.wallet_id).is_err());
        assert_eq!(
            std::fs::read(&victim).expect("read victim"),
            b"must not change"
        );
        std::fs::remove_file(&stable).expect("remove stable symlink");

        let backup = stable.with_extension("json.bak");
        symlink(&victim, &backup).expect("create backup symlink");
        assert!(persist_pending_broadcast(&directory, &record).is_err());
        assert_eq!(
            std::fs::read(&victim).expect("read victim"),
            b"must not change"
        );
        std::fs::remove_file(backup).expect("remove backup symlink");
        std::fs::remove_file(victim).expect("remove victim");
        std::fs::remove_dir(directory).expect("remove test directory");
    }

    #[cfg(unix)]
    #[test]
    fn hardlinked_stable_path_fails_closed_without_truncating_inode() {
        use std::os::unix::fs::PermissionsExt;

        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-hardlink-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let victim = directory.join("victim");
        std::fs::write(&victim, b"must not change").expect("write victim");
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o600))
            .expect("secure victim permissions");
        let record = pending(BroadcastStatus::Unknown);
        let stable = pending_broadcast_path(&directory, &record.wallet_id).expect("journal path");
        std::fs::hard_link(&victim, &stable).expect("create stable hardlink");

        let loaded = load_pending_broadcast(&directory, &record.wallet_id)
            .expect("unsafe hardlink must remain represented");
        assert!(loaded.recovery_error.is_some());
        assert!(persist_pending_broadcast(&directory, &record).is_err());
        assert!(clear_pending_broadcast(&directory, &record.wallet_id).is_err());
        assert_eq!(
            std::fs::read(&victim).expect("read victim"),
            b"must not change"
        );

        std::fs::remove_file(stable).expect("remove hardlink");
        std::fs::remove_file(victim).expect("remove victim");
        std::fs::remove_dir(directory).expect("remove test directory");
    }

    #[test]
    fn oversized_recovery_state_fails_closed_without_reading_or_truncating_it() {
        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-oversized-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let wallet_id = "wallet_test";
        let stable = pending_broadcast_path(&directory, wallet_id).expect("journal path");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&stable)
            .expect("create oversized journal");
        file.set_len(MAX_PENDING_JOURNAL_BYTES + 1)
            .expect("extend oversized journal");
        drop(file);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&stable, std::fs::Permissions::from_mode(0o600))
                .expect("secure journal permissions");
        }

        let loaded = load_pending_broadcast(&directory, wallet_id)
            .expect("oversized state must remain represented");
        assert!(loaded.recovery_error.is_some());
        assert_eq!(
            std::fs::metadata(&stable).expect("journal metadata").len(),
            MAX_PENDING_JOURNAL_BYTES + 1,
            "fail-closed loading must not truncate attacker-controlled input"
        );

        clear_pending_broadcast(&directory, wallet_id).expect("clear oversized journal");
        std::fs::remove_dir(directory).expect("remove test directory");
    }

    #[test]
    fn corrupt_recovery_state_fails_closed() {
        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-corrupt-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let wallet_id = "wallet_test";
        std::fs::write(
            pending_broadcast_path(&directory, wallet_id).expect("recovery path"),
            b"not-json",
        )
        .expect("write corrupt recovery state");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = pending_broadcast_path(&directory, wallet_id).expect("recovery path");
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
                .expect("secure corrupt state permissions");
        }

        let loaded = load_pending_broadcast(&directory, wallet_id)
            .expect("corrupt state must remain represented");
        assert_eq!(loaded.status, BroadcastStatus::Unknown);
        assert!(loaded.recovery_error.is_some());
        assert!(!is_manually_discardable(&loaded));
        assert!(ensure_no_unresolved_broadcast(Some(&loaded)).is_err());

        clear_pending_broadcast(&directory, wallet_id).expect("clear recovery state");
        std::fs::remove_dir(&directory).expect("remove test directory");
    }

    #[test]
    fn interrupted_creation_intent_fails_closed_after_restart() {
        let directory = std::env::temp_dir().join(format!(
            "zuuli-pending-send-intent-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).expect("create test directory");
        let mut intent = pending(BroadcastStatus::Unknown);
        intent.txid = "unavailable".into();
        intent.txid_bytes.clear();
        intent.raw_transaction.clear();
        intent.recovery_error = Some(INTERRUPTED_CREATION_RECOVERY_ERROR.into());
        persist_pending_broadcast(&directory, &intent).expect("persist send intent");

        let loaded = load_pending_broadcast(&directory, &intent.wallet_id)
            .expect("intent must remain represented");
        assert_eq!(loaded.status, BroadcastStatus::Unknown);
        assert!(loaded.recovery_error.is_some());
        assert_eq!(loaded.proposal_id, intent.proposal_id);
        assert!(loaded.public_status().recovery_required);
        assert!(loaded.public_status().can_discard);
        assert!(ensure_no_unresolved_broadcast(Some(&loaded)).is_err());

        clear_pending_broadcast(&directory, &intent.wallet_id).expect("clear send intent");
        std::fs::remove_dir(&directory).expect("remove test directory");
    }
}
