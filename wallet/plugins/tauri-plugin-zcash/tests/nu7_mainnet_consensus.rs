//! Mainnet NU7 must be known to the librustzcash this wallet builds against.
//!
//! Zcash mainnet activated NU7 (ZIP 259) at height 3,543,405, consensus branch
//! ID `0x77190AD9`. A librustzcash that still gates mainnet NU7 behind
//! `zcash_unstable = "nu7"` maps that height to no upgrade and refuses every
//! post-activation transaction with `invalid consensus branch id 0x77190ad9`,
//! so the wallet stops being able to decode its own history.
//!
//! These tests compile with no `zcash_unstable` cfg (CI sets none), so they
//! prove the shipping configuration rather than an opt-in one.

use zcash_primitives::transaction::Transaction;
use zcash_protocol::consensus::{
    BlockHeight, BranchId, MAIN_NETWORK, Network, NetworkUpgrade, Parameters,
};
use zcash_protocol::constants::{
    V5_TX_VERSION, V5_VERSION_GROUP_ID, V6_TX_VERSION, V6_VERSION_GROUP_ID,
};

const NU7_BRANCH_ID: u32 = 0x7719_0ad9;
const NU7_MAINNET_ACTIVATION: u32 = 3_543_405;

#[test]
fn nu7_branch_id_parses_as_nu7() {
    assert_eq!(BranchId::try_from(NU7_BRANCH_ID), Ok(BranchId::Nu7));
    assert_eq!(u32::from(BranchId::Nu7), NU7_BRANCH_ID);
}

#[test]
fn mainnet_activation_heights_are_set() {
    for (upgrade, height) in [
        (NetworkUpgrade::Nu6_2, 3_364_600),
        (NetworkUpgrade::Nu6_3, 3_428_143),
        (NetworkUpgrade::Nu7, NU7_MAINNET_ACTIVATION),
    ] {
        assert_eq!(
            MAIN_NETWORK.activation_height(upgrade),
            Some(BlockHeight::from_u32(height)),
            "{upgrade:?} mainnet activation height",
        );
        assert_eq!(
            Network::MainNetwork.activation_height(upgrade),
            Some(BlockHeight::from_u32(height)),
        );
    }
}

#[test]
fn mainnet_branch_switches_to_nu7_at_activation() {
    let at =
        |height: u32| BranchId::for_height(&Network::MainNetwork, BlockHeight::from_u32(height));
    assert_eq!(at(NU7_MAINNET_ACTIVATION - 1), BranchId::Nu6_3);
    assert_eq!(at(NU7_MAINNET_ACTIVATION), BranchId::Nu7);
    assert_eq!(at(NU7_MAINNET_ACTIVATION + 1_000), BranchId::Nu7);
}

/// An empty v5/v6 transaction carrying the NU7 branch ID, built byte-for-byte
/// from the wire format rather than through librustzcash's own builder, so a
/// parser that rejects the branch ID fails exactly as it did in production.
fn empty_transaction(version: u32, group_id: u32, trailing_empty_vectors: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(version | (1 << 31)).to_le_bytes()); // fOverwintered
    bytes.extend_from_slice(&group_id.to_le_bytes());
    bytes.extend_from_slice(&NU7_BRANCH_ID.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes()); // nLockTime
    bytes.extend_from_slice(&(NU7_MAINNET_ACTIVATION + 120).to_le_bytes()); // nExpiryHeight
    // vin, vout, Sapling spends, Sapling outputs, then one empty action vector
    // per Orchard-protocol pool.
    bytes.extend(std::iter::repeat_n(0u8, trailing_empty_vectors));
    bytes
}

fn assert_parses_as_nu7(bytes: &[u8]) {
    // The branch ID argument is only consulted for pre-v5 formats; v5 and
    // later carry their own, which is the field under test.
    let tx = Transaction::read(bytes, BranchId::Nu6_3)
        .expect("a mainnet post-NU7 transaction must parse");
    assert_eq!(tx.consensus_branch_id(), BranchId::Nu7);

    let mut reserialized = Vec::new();
    tx.write(&mut reserialized).expect("reserialize");
    assert_eq!(reserialized, bytes, "round trip must preserve the encoding");
}

#[test]
fn v5_transaction_with_nu7_branch_id_parses() {
    // vin, vout, spends, outputs, orchard actions.
    assert_parses_as_nu7(&empty_transaction(V5_TX_VERSION, V5_VERSION_GROUP_ID, 5));
}

#[test]
fn v6_transaction_with_nu7_branch_id_parses() {
    // vin, vout, spends, outputs, orchard actions, ironwood actions.
    assert_parses_as_nu7(&empty_transaction(V6_TX_VERSION, V6_VERSION_GROUP_ID, 6));
}
