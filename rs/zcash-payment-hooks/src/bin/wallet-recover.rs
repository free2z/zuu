//! Explicit transaction enhancement independent of the wallet request queue.
//! Caller must serialize this command with wallet synchronization.
use anyhow::{Result, ensure};
use clap::Parser;
use std::{path::PathBuf, time::Duration};
use zcash_client_backend::proto::service::{
    TxFilter, compact_tx_streamer_client::CompactTxStreamerClient,
};
use zcash_protocol::consensus::{BlockHeight, Network};

#[derive(Parser)]
struct Args {
    #[arg(long)]
    wallet_db: PathBuf,
    #[arg(long)]
    server: String,
    #[arg(long, value_parser = ["main", "test"])]
    network: String,
    /// Display-order txid from a mined received note in this wallet.
    #[arg(long)]
    txid: String,
    #[arg(long)]
    height: u32,
}

#[tokio::main]
async fn main() -> Result<()> {
    // No paths, server credentials, transaction IDs, or provider errors in logs.
    if run(Args::parse()).await.is_err() {
        eprintln!("wallet transaction recovery failed");
        std::process::exit(1);
    }
    Ok(())
}

async fn run(a: Args) -> Result<()> {
    ensure!(a.wallet_db.is_file(), "existing wallet required");
    ensure!(a.height > 0, "mined height required");
    let mut hash = hex::decode(&a.txid)?;
    ensure!(hash.len() == 32, "invalid txid");
    hash.reverse();
    let params = if a.network == "main" {
        Network::MainNetwork
    } else {
        Network::TestNetwork
    };
    let height = BlockHeight::from_u32(a.height);
    // No migration, rewind, reset, queue SQL, or status mutation on NotFound.
    let mut db = zcash_paymentd::wallet_recovery::open_recovery_wallet(&a.wallet_db, params)?;
    zcash_paymentd::wallet_recovery::validate_received(&db, &hash, height)?;
    let endpoint = tonic::transport::Endpoint::from_shared(a.server)?
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .tls_config(tonic::transport::ClientTlsConfig::new().with_webpki_roots())?;
    let mut client = CompactTxStreamerClient::new(endpoint.connect().await?)
        .max_decoding_message_size(4 * 1024 * 1024);
    let response = client
        .get_transaction(TxFilter {
            hash: hash.clone(),
            ..Default::default()
        })
        .await
        .map(|r| r.into_inner());
    let hydrated =
        zcash_paymentd::wallet_recovery::apply_response(&mut db, params, &hash, height, response)?;
    println!("{}", if hydrated { "hydrated" } else { "unavailable" });
    Ok(())
}
