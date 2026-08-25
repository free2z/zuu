//! The labels, and how a storage key is built from one.
//!
//! # These bytes are a wire format
//!
//! Everything here is byte-identical to `openmls_memory_storage 0.5.0` — the
//! same label spellings, the same `label || serde_json(key) || version_be`
//! layout — and that is deliberate rather than lazy. Two consequences follow
//! from it, and both are worth more than a prettier scheme:
//!
//!   1. A store written by `openmls_memory_storage` is readable by this crate
//!      and vice versa, so the reference implementation can be used as an
//!      oracle in tests rather than merely as a model.
//!   2. A reviewer can diff this crate's provider against upstream's
//!      method-for-method, which is the only practical way to gain confidence
//!      in 57 mechanical methods.
//!
//! **So do not "improve" the layout.** Changing a label or the key layout
//! silently orphans every group already on a user's disk: OpenMLS's loaders
//! return `Ok(None)` for a key that is merely spelled differently, and
//! `MlsGroup::load` answers "no such group" rather than "your storage moved".
//!
//! # Why the labels are not `free2z/...` domain labels
//!
//! `docs/e2ee/WIRE.md` §1.3's labels are hash-domain separators fed to
//! `H(label, x)` and are held prefix-free across the tree by
//! `scripts/check-hash-domain-labels.mjs`. These are neither: they are map key
//! prefixes in a private local store, they are OpenMLS's names rather than
//! ours, and nothing hashes them. Renaming them into the `free2z/` namespace
//! would put OpenMLS's storage layout under our specification's prefix-free
//! rule for no benefit and would break property (1) above.
//!
//! Prefix-freeness is worth having here anyway, for a different reason — see
//! [`LABELS`] and the test beneath it.


// --- crypto objects ---------------------------------------------------------

pub(crate) const KEY_PACKAGE_LABEL: &[u8] = b"KeyPackage";
pub(crate) const PSK_LABEL: &[u8] = b"Psk";
pub(crate) const ENCRYPTION_KEY_PAIR_LABEL: &[u8] = b"EncryptionKeyPair";
pub(crate) const SIGNATURE_KEY_PAIR_LABEL: &[u8] = b"SignatureKeyPair";
pub(crate) const EPOCH_KEY_PAIRS_LABEL: &[u8] = b"EpochKeyPairs";

// --- related to PublicGroup -------------------------------------------------

pub(crate) const TREE_LABEL: &[u8] = b"Tree";
pub(crate) const GROUP_CONTEXT_LABEL: &[u8] = b"GroupContext";
#[cfg(feature = "extensions-draft-08")]
pub(crate) const APPLICATION_EXPORT_TREE_LABEL: &[u8] = b"ApplicationExportTree";
pub(crate) const INTERIM_TRANSCRIPT_HASH_LABEL: &[u8] = b"InterimTranscriptHash";
pub(crate) const CONFIRMATION_TAG_LABEL: &[u8] = b"ConfirmationTag";

// --- related to MlsGroup ----------------------------------------------------

pub(crate) const JOIN_CONFIG_LABEL: &[u8] = b"MlsGroupJoinConfig";
pub(crate) const OWN_LEAF_NODES_LABEL: &[u8] = b"OwnLeafNodes";
pub(crate) const GROUP_STATE_LABEL: &[u8] = b"GroupState";
pub(crate) const QUEUED_PROPOSAL_LABEL: &[u8] = b"QueuedProposal";
pub(crate) const PROPOSAL_QUEUE_REFS_LABEL: &[u8] = b"ProposalQueueRefs";
pub(crate) const OWN_LEAF_NODE_INDEX_LABEL: &[u8] = b"OwnLeafNodeIndex";
pub(crate) const EPOCH_SECRETS_LABEL: &[u8] = b"EpochSecrets";
pub(crate) const RESUMPTION_PSK_STORE_LABEL: &[u8] = b"ResumptionPsk";
pub(crate) const MESSAGE_SECRETS_LABEL: &[u8] = b"MessageSecrets";

/// Every label this crate mints, for the prefix-freeness test below.
///
/// `#[cfg(test)]` because the property is asserted rather than consulted: no
/// runtime path iterates the labels, and a list that existed only to be
/// compiled would drift from the constants above without anything noticing.
///
/// A leading label that is a proper prefix of another matters here even though
/// nothing is hashed, because the *serialised key* that follows is
/// attacker-influenced in one case: `Psk` keys are PSK identifiers, and a
/// group's PSK id is chosen by whoever proposed the PSK. If `Psk` were a prefix
/// of some other label `PskX`, a crafted identifier beginning with `X` would
/// address an `PskX` entry. That is a storage-confusion bug, not a hash-domain
/// one, and it is closed by the same property.
#[cfg(test)]
pub(crate) const LABELS: &[&[u8]] = &[
    KEY_PACKAGE_LABEL,
    PSK_LABEL,
    ENCRYPTION_KEY_PAIR_LABEL,
    SIGNATURE_KEY_PAIR_LABEL,
    EPOCH_KEY_PAIRS_LABEL,
    TREE_LABEL,
    GROUP_CONTEXT_LABEL,
    #[cfg(feature = "extensions-draft-08")]
    APPLICATION_EXPORT_TREE_LABEL,
    INTERIM_TRANSCRIPT_HASH_LABEL,
    CONFIRMATION_TAG_LABEL,
    JOIN_CONFIG_LABEL,
    OWN_LEAF_NODES_LABEL,
    GROUP_STATE_LABEL,
    QUEUED_PROPOSAL_LABEL,
    PROPOSAL_QUEUE_REFS_LABEL,
    OWN_LEAF_NODE_INDEX_LABEL,
    EPOCH_SECRETS_LABEL,
    RESUMPTION_PSK_STORE_LABEL,
    MESSAGE_SECRETS_LABEL,
];

/// A label rendered for an error message. Labels are ASCII by construction;
/// the fallback exists so this function cannot fail.
pub(crate) const fn label_name(label: &[u8]) -> &'static str {
    // `match` on a slice pattern rather than `str::from_utf8`, so the returned
    // lifetime is `'static` and `StoreError` needs no allocation.
    match label {
        b"KeyPackage" => "KeyPackage",
        b"Psk" => "Psk",
        b"EncryptionKeyPair" => "EncryptionKeyPair",
        b"SignatureKeyPair" => "SignatureKeyPair",
        b"EpochKeyPairs" => "EpochKeyPairs",
        b"Tree" => "Tree",
        b"GroupContext" => "GroupContext",
        b"ApplicationExportTree" => "ApplicationExportTree",
        b"InterimTranscriptHash" => "InterimTranscriptHash",
        b"ConfirmationTag" => "ConfirmationTag",
        b"MlsGroupJoinConfig" => "MlsGroupJoinConfig",
        b"OwnLeafNodes" => "OwnLeafNodes",
        b"GroupState" => "GroupState",
        b"QueuedProposal" => "QueuedProposal",
        b"ProposalQueueRefs" => "ProposalQueueRefs",
        b"OwnLeafNodeIndex" => "OwnLeafNodeIndex",
        b"EpochSecrets" => "EpochSecrets",
        b"ResumptionPsk" => "ResumptionPsk",
        b"MessageSecrets" => "MessageSecrets",
        _ => "unknown",
    }
}

/// `label || key || VERSION` — the exact layout `openmls_memory_storage` uses.
pub(crate) fn build_key_from_vec<const V: u16>(label: &[u8], key: Vec<u8>) -> Vec<u8> {
    let mut key_out = label.to_vec();
    key_out.extend_from_slice(&key);
    key_out.extend_from_slice(&u16::to_be_bytes(V));
    key_out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Not a hash-domain check — see the module note. It closes the
    /// storage-confusion case where an attacker-influenced serialised key
    /// (a PSK identifier) could be made to address another label's entry.
    #[test]
    fn no_label_is_a_prefix_of_another() {
        for (i, a) in LABELS.iter().enumerate() {
            for (j, b) in LABELS.iter().enumerate() {
                if i == j {
                    continue;
                }
                assert!(
                    !b.starts_with(a),
                    "label {} is a prefix of label {}",
                    label_name(a),
                    label_name(b)
                );
            }
        }
    }

    #[test]
    fn every_label_has_a_name() {
        for label in LABELS {
            assert_ne!(
                label_name(label),
                "unknown",
                "unnamed label: {}",
                String::from_utf8_lossy(label)
            );
        }
    }

    #[test]
    fn the_key_layout_is_label_then_key_then_big_endian_version() {
        let key = build_key_from_vec::<1>(b"Tree", b"GID".to_vec());
        assert_eq!(key, b"TreeGID\x00\x01".to_vec());
    }

    #[test]
    fn two_versions_of_the_same_key_do_not_collide() {
        assert_ne!(
            build_key_from_vec::<1>(b"Tree", b"g".to_vec()),
            build_key_from_vec::<2>(b"Tree", b"g".to_vec())
        );
    }
}
