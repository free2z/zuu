//! The 57 methods, **in the order `openmls_traits::storage` declares them**.
//!
//! # Read this before changing anything in this file
//!
//! There is no cleverness here and there must not be any. Every method reduces
//! to one of six helpers on [`F2zStorageProvider`] — `write`, `append`,
//! `remove_item`, `read`, `read_list`, `delete` — named after
//! `openmls_memory_storage 0.5.0`'s and doing the same thing to the same bytes.
//! The order is the **trait's** order, not the reference implementation's,
//! because the trait is the specification and a reviewer checking that all 57
//! are present and correctly wired should be able to read this file and
//! `storage.rs` side by side without jumping.
//!
//! Grouped by the trait's own section comments:
//!
//! | Section | Methods |
//! |---|---|
//! | setters/writers/enqueuers for group state | 13 |
//! | setters/writers/enqueuers for crypto objects | 5 |
//! | getters for group state | 13 |
//! | getters for crypto objects | 6 |
//! | deleters for group state | 13 |
//! | deleters for crypto objects | 6 |
//!
//! Three of those (`write_application_export_tree`, `application_export_tree`,
//! `delete_application_export_tree`) exist only under `extensions-draft-08`,
//! which the trait gates and this crate forwards.
//!
//! # Where this deliberately differs from the reference
//!
//! Two places, both because the reference is wrong or because the workspace
//! forbids what it does. Neither changes a byte on disk.
//!
//! **1. Nothing panics.** `openmls_memory_storage` `unwrap()`s serialisation
//! and, in `queued_proposals`, `unwrap()`s a `read` that returns `None`. This
//! workspace denies `clippy::unwrap_used` because a panic inside a crypto core
//! is a crash of the whole client, and a corrupted store is exactly when a
//! client most needs to report an error rather than die. Every one of those is
//! a [`StoreError`] here. The `queued_proposals` case is the sharp one: a
//! proposal reference in the queue whose proposal is missing is a *corrupt
//! store*, and upstream turns it into a panic in the middle of message
//! processing.
//!
//! **2. `clear_proposal_queue` actually clears the queue.** Upstream builds the
//! per-proposal key as `serde_json::to_vec(&(group_id, proposal_ref))` and
//! removes *that* from the map — but every write goes in under
//! `build_key_from_vec(label, key, version)`, so the key it removes is one no
//! entry was ever stored at. The refs list is deleted and the proposal bodies
//! are left behind forever. Ported faithfully that would be a slow leak of
//! serialised proposals in every client's store, so it is fixed here, and the
//! fix is one line: go through the same `delete` helper every other deleter
//! uses. `tests/provider.rs` pins it.
//!
//! [`F2zStorageProvider`]: crate::F2zStorageProvider
//! [`StoreError`]: crate::StoreError

use openmls_traits::storage::{CURRENT_VERSION, StorageProvider, traits};

use crate::backend::StorageBackend;
use crate::error::{Result, StoreError};
use crate::keys::{
    CONFIRMATION_TAG_LABEL, ENCRYPTION_KEY_PAIR_LABEL, EPOCH_KEY_PAIRS_LABEL, EPOCH_SECRETS_LABEL,
    GROUP_CONTEXT_LABEL, GROUP_STATE_LABEL, JOIN_CONFIG_LABEL, KEY_PACKAGE_LABEL,
    INTERIM_TRANSCRIPT_HASH_LABEL, MESSAGE_SECRETS_LABEL, OWN_LEAF_NODES_LABEL,
    OWN_LEAF_NODE_INDEX_LABEL, PROPOSAL_QUEUE_REFS_LABEL, PSK_LABEL, QUEUED_PROPOSAL_LABEL,
    RESUMPTION_PSK_STORE_LABEL, SIGNATURE_KEY_PAIR_LABEL, TREE_LABEL,
};
#[cfg(feature = "extensions-draft-08")]
use crate::keys::APPLICATION_EXPORT_TREE_LABEL;
use crate::provider::{F2zStorageProvider, encode};

/// The epoch-key-pairs key: `group_id || epoch || leaf_index`, each
/// `serde_json`-encoded and concatenated. Byte-identical to upstream's
/// `epoch_key_pairs_id`.
fn epoch_key_pairs_id(
    group_id: &impl traits::GroupId<CURRENT_VERSION>,
    epoch: &impl traits::EpochKey<CURRENT_VERSION>,
    leaf_index: u32,
) -> Result<Vec<u8>> {
    let mut key = encode(group_id, EPOCH_KEY_PAIRS_LABEL)?;
    key.extend_from_slice(&encode(epoch, EPOCH_KEY_PAIRS_LABEL)?);
    key.extend_from_slice(&encode(&leaf_index, EPOCH_KEY_PAIRS_LABEL)?);
    Ok(key)
}

impl<B: StorageBackend> StorageProvider<CURRENT_VERSION> for F2zStorageProvider<B> {
    type Error = StoreError;

    //
    //    ---   setters/writers/enqueuers for group state  ---
    //

    fn write_mls_join_config<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        MlsGroupJoinConfig: traits::MlsGroupJoinConfig<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        config: &MlsGroupJoinConfig,
    ) -> Result<()> {
        let key = encode(group_id, JOIN_CONFIG_LABEL)?;
        let value = encode(config, JOIN_CONFIG_LABEL)?;
        self.write::<CURRENT_VERSION>(JOIN_CONFIG_LABEL, &key, value)
    }

    fn append_own_leaf_node<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNode: traits::LeafNode<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        leaf_node: &LeafNode,
    ) -> Result<()> {
        let key = encode(group_id, OWN_LEAF_NODES_LABEL)?;
        let value = encode(leaf_node, OWN_LEAF_NODES_LABEL)?;
        self.append::<CURRENT_VERSION>(OWN_LEAF_NODES_LABEL, &key, value)
    }

    fn queue_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
        proposal: &QueuedProposal,
    ) -> Result<()> {
        // Write the proposal under the compound key (group_id, proposal_ref).
        let key = encode(&(group_id, proposal_ref), QUEUED_PROPOSAL_LABEL)?;
        let value = encode(proposal, QUEUED_PROPOSAL_LABEL)?;
        self.write::<CURRENT_VERSION>(QUEUED_PROPOSAL_LABEL, &key, value)?;

        // …and add its reference to the group's queue.
        //
        // Two writes for one logical enqueue, which is precisely why this crate
        // has a transaction: without one, a crash between them leaves either an
        // orphan proposal or a reference to a proposal that is not there.
        let key = encode(group_id, PROPOSAL_QUEUE_REFS_LABEL)?;
        let value = encode(proposal_ref, PROPOSAL_QUEUE_REFS_LABEL)?;
        self.append::<CURRENT_VERSION>(PROPOSAL_QUEUE_REFS_LABEL, &key, value)
    }

    fn write_tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        TreeSync: traits::TreeSync<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        tree: &TreeSync,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            TREE_LABEL,
            &encode(group_id, TREE_LABEL)?,
            encode(tree, TREE_LABEL)?,
        )
    }

    fn write_interim_transcript_hash<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        interim_transcript_hash: &InterimTranscriptHash,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            INTERIM_TRANSCRIPT_HASH_LABEL,
            &encode(group_id, INTERIM_TRANSCRIPT_HASH_LABEL)?,
            encode(interim_transcript_hash, INTERIM_TRANSCRIPT_HASH_LABEL)?,
        )
    }

    fn write_context<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupContext: traits::GroupContext<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        group_context: &GroupContext,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            GROUP_CONTEXT_LABEL,
            &encode(group_id, GROUP_CONTEXT_LABEL)?,
            encode(group_context, GROUP_CONTEXT_LABEL)?,
        )
    }

    fn write_confirmation_tag<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        confirmation_tag: &ConfirmationTag,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            CONFIRMATION_TAG_LABEL,
            &encode(group_id, CONFIRMATION_TAG_LABEL)?,
            encode(confirmation_tag, CONFIRMATION_TAG_LABEL)?,
        )
    }

    fn write_group_state<
        GroupState: traits::GroupState<CURRENT_VERSION>,
        GroupId: traits::GroupId<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        group_state: &GroupState,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            GROUP_STATE_LABEL,
            &encode(group_id, GROUP_STATE_LABEL)?,
            encode(group_state, GROUP_STATE_LABEL)?,
        )
    }

    fn write_message_secrets<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        MessageSecrets: traits::MessageSecrets<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        message_secrets: &MessageSecrets,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            MESSAGE_SECRETS_LABEL,
            &encode(group_id, MESSAGE_SECRETS_LABEL)?,
            encode(message_secrets, MESSAGE_SECRETS_LABEL)?,
        )
    }

    fn write_resumption_psk_store<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ResumptionPskStore: traits::ResumptionPskStore<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        resumption_psk_store: &ResumptionPskStore,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            RESUMPTION_PSK_STORE_LABEL,
            &encode(group_id, RESUMPTION_PSK_STORE_LABEL)?,
            encode(resumption_psk_store, RESUMPTION_PSK_STORE_LABEL)?,
        )
    }

    fn write_own_leaf_index<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNodeIndex: traits::LeafNodeIndex<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        own_leaf_index: &LeafNodeIndex,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            OWN_LEAF_NODE_INDEX_LABEL,
            &encode(group_id, OWN_LEAF_NODE_INDEX_LABEL)?,
            encode(own_leaf_index, OWN_LEAF_NODE_INDEX_LABEL)?,
        )
    }

    fn write_group_epoch_secrets<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupEpochSecrets: traits::GroupEpochSecrets<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        group_epoch_secrets: &GroupEpochSecrets,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            EPOCH_SECRETS_LABEL,
            &encode(group_id, EPOCH_SECRETS_LABEL)?,
            encode(group_epoch_secrets, EPOCH_SECRETS_LABEL)?,
        )
    }

    #[cfg(feature = "extensions-draft-08")]
    fn write_application_export_tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ApplicationExportTree: traits::ApplicationExportTree<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        application_export_tree: &ApplicationExportTree,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            APPLICATION_EXPORT_TREE_LABEL,
            &encode(group_id, APPLICATION_EXPORT_TREE_LABEL)?,
            encode(application_export_tree, APPLICATION_EXPORT_TREE_LABEL)?,
        )
    }

    //
    //    ---   setters/writers/enqueuers for crypto objects  ---
    //

    fn write_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
        signature_key_pair: &SignatureKeyPair,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            SIGNATURE_KEY_PAIR_LABEL,
            &encode(public_key, SIGNATURE_KEY_PAIR_LABEL)?,
            encode(signature_key_pair, SIGNATURE_KEY_PAIR_LABEL)?,
        )
    }

    fn write_encryption_key_pair<
        EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
        key_pair: &HpkeKeyPair,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            ENCRYPTION_KEY_PAIR_LABEL,
            &encode(public_key, ENCRYPTION_KEY_PAIR_LABEL)?,
            encode(key_pair, ENCRYPTION_KEY_PAIR_LABEL)?,
        )
    }

    fn write_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
        key_pairs: &[HpkeKeyPair],
    ) -> Result<()> {
        let key = epoch_key_pairs_id(group_id, epoch, leaf_index)?;
        let value = encode(key_pairs, EPOCH_KEY_PAIRS_LABEL)?;
        self.write::<CURRENT_VERSION>(EPOCH_KEY_PAIRS_LABEL, &key, value)
    }

    fn write_key_package<
        HashReference: traits::HashReference<CURRENT_VERSION>,
        KeyPackage: traits::KeyPackage<CURRENT_VERSION>,
    >(
        &self,
        hash_ref: &HashReference,
        key_package: &KeyPackage,
    ) -> Result<()> {
        let key = encode(hash_ref, KEY_PACKAGE_LABEL)?;
        let value = encode(key_package, KEY_PACKAGE_LABEL)?;
        self.write::<CURRENT_VERSION>(KEY_PACKAGE_LABEL, &key, value)
    }

    fn write_psk<
        PskId: traits::PskId<CURRENT_VERSION>,
        PskBundle: traits::PskBundle<CURRENT_VERSION>,
    >(
        &self,
        psk_id: &PskId,
        psk: &PskBundle,
    ) -> Result<()> {
        self.write::<CURRENT_VERSION>(
            PSK_LABEL,
            &encode(psk_id, PSK_LABEL)?,
            encode(psk, PSK_LABEL)?,
        )
    }

    //
    //    ---   getters for group state  ---
    //

    fn mls_group_join_config<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        MlsGroupJoinConfig: traits::MlsGroupJoinConfig<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<MlsGroupJoinConfig>> {
        self.read::<CURRENT_VERSION, _>(JOIN_CONFIG_LABEL, &encode(group_id, JOIN_CONFIG_LABEL)?)
    }

    fn own_leaf_nodes<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNode: traits::LeafNode<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<LeafNode>> {
        self.read_list::<CURRENT_VERSION, _>(
            OWN_LEAF_NODES_LABEL,
            &encode(group_id, OWN_LEAF_NODES_LABEL)?,
        )
    }

    fn queued_proposal_refs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<ProposalRef>> {
        self.read_list::<CURRENT_VERSION, _>(
            PROPOSAL_QUEUE_REFS_LABEL,
            &encode(group_id, PROPOSAL_QUEUE_REFS_LABEL)?,
        )
    }

    fn queued_proposals<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
        QueuedProposal: traits::QueuedProposal<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Vec<(ProposalRef, QueuedProposal)>> {
        let refs: Vec<ProposalRef> = self.read_list::<CURRENT_VERSION, _>(
            PROPOSAL_QUEUE_REFS_LABEL,
            &encode(group_id, PROPOSAL_QUEUE_REFS_LABEL)?,
        )?;

        refs.into_iter()
            .map(|proposal_ref| {
                let key = encode(&(group_id, &proposal_ref), QUEUED_PROPOSAL_LABEL)?;
                // A reference in the queue whose proposal is absent is a
                // corrupt store. Upstream `unwrap()`s here, which turns it into
                // a panic in the middle of message processing; this is an error
                // the caller can report and recover from.
                let proposal = self
                    .read::<CURRENT_VERSION, _>(QUEUED_PROPOSAL_LABEL, &key)?
                    .ok_or(StoreError::Serialization {
                        label: "QueuedProposal",
                    })?;
                Ok((proposal_ref, proposal))
            })
            .collect()
    }

    fn tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        TreeSync: traits::TreeSync<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<TreeSync>> {
        self.read::<CURRENT_VERSION, _>(TREE_LABEL, &encode(group_id, TREE_LABEL)?)
    }

    fn group_context<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupContext: traits::GroupContext<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<GroupContext>> {
        self.read::<CURRENT_VERSION, _>(GROUP_CONTEXT_LABEL, &encode(group_id, GROUP_CONTEXT_LABEL)?)
    }

    fn interim_transcript_hash<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        InterimTranscriptHash: traits::InterimTranscriptHash<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<InterimTranscriptHash>> {
        self.read::<CURRENT_VERSION, _>(
            INTERIM_TRANSCRIPT_HASH_LABEL,
            &encode(group_id, INTERIM_TRANSCRIPT_HASH_LABEL)?,
        )
    }

    fn confirmation_tag<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ConfirmationTag: traits::ConfirmationTag<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<ConfirmationTag>> {
        self.read::<CURRENT_VERSION, _>(
            CONFIRMATION_TAG_LABEL,
            &encode(group_id, CONFIRMATION_TAG_LABEL)?,
        )
    }

    fn group_state<
        GroupState: traits::GroupState<CURRENT_VERSION>,
        GroupId: traits::GroupId<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<GroupState>> {
        self.read::<CURRENT_VERSION, _>(GROUP_STATE_LABEL, &encode(group_id, GROUP_STATE_LABEL)?)
    }

    fn message_secrets<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        MessageSecrets: traits::MessageSecrets<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<MessageSecrets>> {
        self.read::<CURRENT_VERSION, _>(
            MESSAGE_SECRETS_LABEL,
            &encode(group_id, MESSAGE_SECRETS_LABEL)?,
        )
    }

    fn resumption_psk_store<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ResumptionPskStore: traits::ResumptionPskStore<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<ResumptionPskStore>> {
        self.read::<CURRENT_VERSION, _>(
            RESUMPTION_PSK_STORE_LABEL,
            &encode(group_id, RESUMPTION_PSK_STORE_LABEL)?,
        )
    }

    fn own_leaf_index<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        LeafNodeIndex: traits::LeafNodeIndex<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<LeafNodeIndex>> {
        self.read::<CURRENT_VERSION, _>(
            OWN_LEAF_NODE_INDEX_LABEL,
            &encode(group_id, OWN_LEAF_NODE_INDEX_LABEL)?,
        )
    }

    fn group_epoch_secrets<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        GroupEpochSecrets: traits::GroupEpochSecrets<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<GroupEpochSecrets>> {
        self.read::<CURRENT_VERSION, _>(EPOCH_SECRETS_LABEL, &encode(group_id, EPOCH_SECRETS_LABEL)?)
    }

    //
    //    ---   getter for crypto objects  ---
    //

    fn signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
        SignatureKeyPair: traits::SignatureKeyPair<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<Option<SignatureKeyPair>> {
        self.read::<CURRENT_VERSION, _>(
            SIGNATURE_KEY_PAIR_LABEL,
            &encode(public_key, SIGNATURE_KEY_PAIR_LABEL)?,
        )
    }

    fn encryption_key_pair<
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
        EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>,
    >(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<Option<HpkeKeyPair>> {
        self.read::<CURRENT_VERSION, _>(
            ENCRYPTION_KEY_PAIR_LABEL,
            &encode(public_key, ENCRYPTION_KEY_PAIR_LABEL)?,
        )
    }

    fn encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
        HpkeKeyPair: traits::HpkeKeyPair<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<Vec<HpkeKeyPair>> {
        let key = epoch_key_pairs_id(group_id, epoch, leaf_index)?;
        // Note the shape: this one is stored as a *single* serialised `Vec`,
        // not as this crate's append-list encoding, so it is `read` and not
        // `read_list`. An absent entry is an empty vector, per the trait.
        Ok(self
            .read::<CURRENT_VERSION, Vec<HpkeKeyPair>>(EPOCH_KEY_PAIRS_LABEL, &key)?
            .unwrap_or_default())
    }

    fn key_package<
        KeyPackageRef: traits::HashReference<CURRENT_VERSION>,
        KeyPackage: traits::KeyPackage<CURRENT_VERSION>,
    >(
        &self,
        hash_ref: &KeyPackageRef,
    ) -> Result<Option<KeyPackage>> {
        self.read::<CURRENT_VERSION, _>(KEY_PACKAGE_LABEL, &encode(hash_ref, KEY_PACKAGE_LABEL)?)
    }

    fn psk<
        PskBundle: traits::PskBundle<CURRENT_VERSION>,
        PskId: traits::PskId<CURRENT_VERSION>,
    >(
        &self,
        psk_id: &PskId,
    ) -> Result<Option<PskBundle>> {
        self.read::<CURRENT_VERSION, _>(PSK_LABEL, &encode(psk_id, PSK_LABEL)?)
    }

    #[cfg(feature = "extensions-draft-08")]
    fn application_export_tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ApplicationExportTree: traits::ApplicationExportTree<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<Option<ApplicationExportTree>> {
        self.read::<CURRENT_VERSION, _>(
            APPLICATION_EXPORT_TREE_LABEL,
            &encode(group_id, APPLICATION_EXPORT_TREE_LABEL)?,
        )
    }

    //
    //     ---    deleters for group state    ---
    //

    fn remove_proposal<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        proposal_ref: &ProposalRef,
    ) -> Result<()> {
        let key = encode(group_id, PROPOSAL_QUEUE_REFS_LABEL)?;
        let value = encode(proposal_ref, PROPOSAL_QUEUE_REFS_LABEL)?;
        self.remove_item::<CURRENT_VERSION>(PROPOSAL_QUEUE_REFS_LABEL, &key, &value)?;

        let key = encode(&(group_id, proposal_ref), QUEUED_PROPOSAL_LABEL)?;
        self.delete::<CURRENT_VERSION>(QUEUED_PROPOSAL_LABEL, &key)
    }

    fn delete_own_leaf_nodes<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(
            OWN_LEAF_NODES_LABEL,
            &encode(group_id, OWN_LEAF_NODES_LABEL)?,
        )
    }

    fn delete_group_config<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(JOIN_CONFIG_LABEL, &encode(group_id, JOIN_CONFIG_LABEL)?)
    }

    fn delete_tree<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(TREE_LABEL, &encode(group_id, TREE_LABEL)?)
    }

    fn delete_confirmation_tag<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(
            CONFIRMATION_TAG_LABEL,
            &encode(group_id, CONFIRMATION_TAG_LABEL)?,
        )
    }

    fn delete_group_state<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(GROUP_STATE_LABEL, &encode(group_id, GROUP_STATE_LABEL)?)
    }

    fn delete_context<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(GROUP_CONTEXT_LABEL, &encode(group_id, GROUP_CONTEXT_LABEL)?)
    }

    fn delete_interim_transcript_hash<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(
            INTERIM_TRANSCRIPT_HASH_LABEL,
            &encode(group_id, INTERIM_TRANSCRIPT_HASH_LABEL)?,
        )
    }

    fn delete_message_secrets<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(
            MESSAGE_SECRETS_LABEL,
            &encode(group_id, MESSAGE_SECRETS_LABEL)?,
        )
    }

    fn delete_all_resumption_psk_secrets<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(
            RESUMPTION_PSK_STORE_LABEL,
            &encode(group_id, RESUMPTION_PSK_STORE_LABEL)?,
        )
    }

    fn delete_own_leaf_index<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(
            OWN_LEAF_NODE_INDEX_LABEL,
            &encode(group_id, OWN_LEAF_NODE_INDEX_LABEL)?,
        )
    }

    fn delete_group_epoch_secrets<GroupId: traits::GroupId<CURRENT_VERSION>>(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(EPOCH_SECRETS_LABEL, &encode(group_id, EPOCH_SECRETS_LABEL)?)
    }

    fn clear_proposal_queue<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ProposalRef: traits::ProposalRef<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        let refs: Vec<ProposalRef> = self.read_list::<CURRENT_VERSION, _>(
            PROPOSAL_QUEUE_REFS_LABEL,
            &encode(group_id, PROPOSAL_QUEUE_REFS_LABEL)?,
        )?;

        // See the module note: upstream removes a key that nothing was ever
        // stored under, so the proposal bodies survive forever. These go
        // through the same `delete` helper every other deleter uses, which is
        // the only way they can address the entry `queue_proposal` wrote.
        for proposal_ref in refs {
            let key = encode(&(group_id, &proposal_ref), QUEUED_PROPOSAL_LABEL)?;
            self.delete::<CURRENT_VERSION>(QUEUED_PROPOSAL_LABEL, &key)?;
        }

        self.delete::<CURRENT_VERSION>(
            PROPOSAL_QUEUE_REFS_LABEL,
            &encode(group_id, PROPOSAL_QUEUE_REFS_LABEL)?,
        )
    }

    //
    //    ---   deleters for crypto objects   ---
    //

    fn delete_signature_key_pair<
        SignaturePublicKey: traits::SignaturePublicKey<CURRENT_VERSION>,
    >(
        &self,
        public_key: &SignaturePublicKey,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(
            SIGNATURE_KEY_PAIR_LABEL,
            &encode(public_key, SIGNATURE_KEY_PAIR_LABEL)?,
        )
    }

    fn delete_encryption_key_pair<EncryptionKey: traits::EncryptionKey<CURRENT_VERSION>>(
        &self,
        public_key: &EncryptionKey,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(
            ENCRYPTION_KEY_PAIR_LABEL,
            &encode(public_key, ENCRYPTION_KEY_PAIR_LABEL)?,
        )
    }

    fn delete_encryption_epoch_key_pairs<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        EpochKey: traits::EpochKey<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
        epoch: &EpochKey,
        leaf_index: u32,
    ) -> Result<()> {
        let key = epoch_key_pairs_id(group_id, epoch, leaf_index)?;
        self.delete::<CURRENT_VERSION>(EPOCH_KEY_PAIRS_LABEL, &key)
    }

    fn delete_key_package<KeyPackageRef: traits::HashReference<CURRENT_VERSION>>(
        &self,
        hash_ref: &KeyPackageRef,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(KEY_PACKAGE_LABEL, &encode(hash_ref, KEY_PACKAGE_LABEL)?)
    }

    fn delete_psk<PskKey: traits::PskId<CURRENT_VERSION>>(&self, psk_id: &PskKey) -> Result<()> {
        self.delete::<CURRENT_VERSION>(PSK_LABEL, &encode(psk_id, PSK_LABEL)?)
    }

    #[cfg(feature = "extensions-draft-08")]
    fn delete_application_export_tree<
        GroupId: traits::GroupId<CURRENT_VERSION>,
        ApplicationExportTree: traits::ApplicationExportTree<CURRENT_VERSION>,
    >(
        &self,
        group_id: &GroupId,
    ) -> Result<()> {
        self.delete::<CURRENT_VERSION>(
            APPLICATION_EXPORT_TREE_LABEL,
            &encode(group_id, APPLICATION_EXPORT_TREE_LABEL)?,
        )
    }
}
