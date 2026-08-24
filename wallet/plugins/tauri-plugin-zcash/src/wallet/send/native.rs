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
use zcash_client_backend::wallet::OvkPolicy;
use zcash_primitives::transaction::{TxVersion, fees::zip317::FeeRule as Zip317FeeRule};
use zcash_proofs::prover::LocalTxProver;
use zcash_protocol::consensus;
use zcash_protocol::{ShieldedPool, TxId};

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

/// The private production authority for money-affecting proposal policy.
/// Parent orchestration can reach only the behavior-tested fixed and send-all
/// entry points below, never this policy-bearing core or its types.
#[allow(clippy::type_complexity)]
fn propose_with_policy<DbT, ParamsT>(
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
fn propose_default<DbT, ParamsT>(
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
    propose_with_policy(db, params, account_id, request, &SpendPolicy::default())
}

#[allow(clippy::type_complexity)]
pub(super) fn propose_fixed_validated<DbT, ParamsT>(
    db: &mut DbT,
    params: &ParamsT,
    account_id: <DbT as InputSource>::AccountId,
    _validated_amount: u64,
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
    propose_default(db, params, account_id, request)
}

#[allow(clippy::type_complexity)]
pub(super) fn propose_send_all_validated<DbT, ParamsT>(
    db: &mut DbT,
    params: &ParamsT,
    account_id: <DbT as InputSource>::AccountId,
    _validated_amount: u64,
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
    propose_default(db, params, account_id, request)
}

type NativeSendCreationError<DbT> = CreateErrT<
    DbT,
    std::convert::Infallible,
    Zip317FeeRule,
    std::convert::Infallible,
    <DbT as InputSource>::NoteRef,
>;

/// The private production authority for transaction creation and outgoing
/// viewing-key retention.
#[allow(clippy::type_complexity)]
pub(super) fn create_transactions<DbT, ParamsT>(
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

#[cfg(test)]
mod tests {
    use super::*;
    use transparent::{
        bundle::{OutPoint, TxOut},
        keys::TransparentKeyScope,
    };
    use zcash_client_backend::data_api::Account;
    use zcash_client_backend::data_api::testing::{
        orchard::OrchardPoolTester,
        pool::{ShieldedPoolTester, dsl::TestDsl},
    };
    use zcash_client_backend::data_api::wallet::input_selection::TransparentSpendPolicy;
    use zcash_client_backend::wallet::WalletTransparentOutput;
    use zcash_client_sqlite::testing::{BlockCache, db::TestDbFactory};
    use zcash_protocol::PoolType;
    use zcash_protocol::value::Zatoshis;

    fn payment_request(
        network: &impl consensus::Parameters,
        recipient: &zcash_keys::address::Address,
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

        let immature = propose_fixed_validated(
            st.wallet_mut(),
            &network,
            account_id,
            FIXED_SEND_VALUE,
            payment_request(&network, &recipient, FIXED_SEND_VALUE),
        );
        assert!(
            immature.is_err(),
            "an externally received Orchard note must not be spendable after one confirmation"
        );

        st.add_empty_blocks(9);
        let proposal = propose_fixed_validated(
            st.wallet_mut(),
            &network,
            account_id,
            FIXED_SEND_VALUE,
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

        let send_all_proposal = propose_send_all_validated(
            st.wallet_mut(),
            &network,
            account_id,
            SEND_ALL_VALUE,
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
        let txids = create_transactions(
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
        let proposal = propose_with_policy(
            st.wallet_mut(),
            &network,
            account_id,
            payment_request(
                &network,
                &zcash_keys::address::Address::from(transparent_recipient),
                PAYMENT_VALUE,
            ),
            &spend_policy,
        )
        .expect("the private production proposal core proposes the mature transparent spend");
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
}
