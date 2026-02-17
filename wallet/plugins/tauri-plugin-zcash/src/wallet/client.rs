use zcash_client_backend::proto::service::compact_tx_streamer_client::CompactTxStreamerClient;
use tonic::transport::Channel;

use crate::error::{Error, Result};

/// Connect to a lightwalletd gRPC server.
pub async fn connect_to_lightwalletd(url: &str) -> Result<CompactTxStreamerClient<Channel>> {
    CompactTxStreamerClient::connect(url.to_string())
        .await
        .map_err(|e| Error::NetworkError(format!("failed to connect to lightwalletd: {e}")))
}
