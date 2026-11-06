//! Public mainnet block at the NU7 activation boundary, obtained using getblock.
use std::collections::HashMap;
use zcash_paymentd::chain::decrypt_block;
use zcash_protocol::consensus::{BlockHeight, BranchId, MAIN_NETWORK, Network};

const HEIGHT: u32 = 3_543_405;
const HASH: &str = "0000000000246a2b1fecb3f465770894d146f6b7044e46b13ffb65e57e4ccd4a";

#[test]
fn mainnet_activation_boundary_and_real_nu7_block_decode() {
    assert_eq!(
        u32::from(BranchId::for_height(
            &MAIN_NETWORK,
            BlockHeight::from(HEIGHT - 1)
        )),
        0x37a5165b
    );
    assert_eq!(
        u32::from(BranchId::for_height(
            &MAIN_NETWORK,
            BlockHeight::from(HEIGHT)
        )),
        0x77190ad9
    );
    let raw = hex::decode(include_str!("fixtures/mainnet-3543405.hex").trim()).unwrap();
    let block = decrypt_block(
        &Network::MainNetwork,
        "main",
        &HashMap::new(),
        HEIGHT,
        HASH,
        &raw,
    )
    .unwrap();
    assert_eq!(block.height, HEIGHT);
    assert_eq!(block.hash, HASH);
    assert!(block.payments.is_empty());
    assert!(
        decrypt_block(
            &Network::MainNetwork,
            "main",
            &HashMap::new(),
            HEIGHT - 1,
            HASH,
            &raw
        )
        .is_err()
    );
    let mut trailing = raw;
    trailing.push(0);
    assert!(
        decrypt_block(
            &Network::MainNetwork,
            "main",
            &HashMap::new(),
            HEIGHT,
            HASH,
            &trailing
        )
        .is_err()
    );
}
