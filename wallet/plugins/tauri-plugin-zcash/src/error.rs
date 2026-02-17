use serde::{ser::Serializer, Serialize};

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Io(#[from] std::io::Error),

    #[error("wallet not initialized")]
    WalletNotInitialized,

    #[error("wallet already initialized")]
    WalletAlreadyInitialized,

    #[error("invalid mnemonic: {0}")]
    InvalidMnemonic(String),

    #[error("sync error: {0}")]
    SyncError(String),

    #[error("send error: {0}")]
    SendError(String),

    #[error("database error: {0}")]
    DatabaseError(String),

    #[error("network error: {0}")]
    NetworkError(String),

    #[error("address error: {0}")]
    AddressError(String),

    #[error("key derivation error: {0}")]
    KeyError(String),

    #[error("{0}")]
    Other(String),

    #[cfg(mobile)]
    #[error(transparent)]
    PluginInvoke(#[from] tauri::plugin::mobile::PluginInvokeError),
}

impl Serialize for Error {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}
