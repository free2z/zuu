use tonic::transport::Channel;
use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;

use crate::error::{Error, Result};

/// Connect to a lightwalletd gRPC server.
pub async fn connect_to_lightwalletd(url: &str) -> Result<CompactTxStreamerClient<Channel>> {
    zuuli_transport::global()
        .channel(url)
        .await
        .map(CompactTxStreamerClient::new)
        .map_err(|e| Error::NetworkError(format!("failed to connect to lightwalletd: {e}")))
}

/// Endpoint rotation must retain the sync task's original policy epoch.
pub async fn connect_at_epoch(url: &str, epoch: u64) -> Result<CompactTxStreamerClient<Channel>> {
    zuuli_transport::global()
        .channel_at_epoch(url, epoch)
        .await
        .map(CompactTxStreamerClient::new)
        .map_err(|e| Error::NetworkError(format!("failed to connect to lightwalletd: {e}")))
}
