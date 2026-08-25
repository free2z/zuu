//! What a store operation can refuse.
//!
//! `openmls_traits::storage::StorageProvider` requires `type Error: Debug +
//! std::error::Error`, so this type is not optional and its `Debug` is printed
//! by OpenMLS's own error paths. That is the reason it carries **no value
//! bytes**: an error that quoted the entry it failed to deserialise would put
//! group secrets into whatever log the application happens to install, from a
//! code path nobody reviews because it only runs when something is already
//! wrong. Labels and lengths are enough to diagnose with, and they are all that
//! is here.

use core::fmt;

/// A store operation's result.
pub type Result<T> = core::result::Result<T, StoreError>;

/// Why a store operation did not happen.
#[derive(Debug)]
#[non_exhaustive]
pub enum StoreError {
    /// A value could not be encoded to, or decoded from, its serde form.
    ///
    /// Carries the storage label and nothing else. The alternative — carrying
    /// `serde_json::Error` — would render the offending input in `Debug` for
    /// some error kinds, and the offending input here is key material.
    Serialization {
        /// The storage label the failure occurred under, e.g. `"KeyPackage"`.
        label: &'static str,
    },
    /// The in-memory journal or map lock was poisoned by a panic in another
    /// thread.
    ///
    /// Deliberately not recoverable-by-ignoring: a poisoned lock means some
    /// other thread died part-way through a write, and continuing would build
    /// group state on top of a half-applied one.
    Poisoned,
    /// [`Transaction`] was opened while another was already open on this
    /// provider.
    ///
    /// Nesting is refused rather than reference-counted because the inner
    /// scope's `commit` would then be a lie: the writes would still be
    /// discardable by the outer scope, and a caller that believed the receipt
    /// would acknowledge a message it had not durably stored.
    ///
    /// [`Transaction`]: crate::Transaction
    TransactionAlreadyOpen,
    /// A backend write failed.
    ///
    /// The `&'static str` is the operation, never the data.
    Backend(&'static str),
    /// The SQLite backend failed.
    #[cfg(feature = "sqlite")]
    Sqlite(rusqlite::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialization { label } => {
                write!(f, "could not serialise or deserialise a `{label}` entry")
            }
            Self::Poisoned => f.write_str("the storage lock was poisoned by a panicking thread"),
            Self::TransactionAlreadyOpen => {
                f.write_str("a storage transaction is already open on this provider")
            }
            Self::Backend(operation) => write!(f, "the storage backend failed during {operation}"),
            #[cfg(feature = "sqlite")]
            Self::Sqlite(error) => write!(f, "the SQLite backend failed: {error}"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            #[cfg(feature = "sqlite")]
            Self::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

#[cfg(feature = "sqlite")]
impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `Debug` of this type reaches OpenMLS's own error rendering, so it is
    /// worth one test that it stays a description rather than a dump.
    #[test]
    fn a_serialization_error_names_the_label_and_carries_nothing_else() {
        let rendered = format!(
            "{:?}",
            StoreError::Serialization {
                label: "KeyPackage"
            }
        );
        assert!(rendered.contains("KeyPackage"), "{rendered}");
        assert!(!rendered.contains(", 1, 2, 3"), "{rendered}");
    }

    #[test]
    fn every_variant_displays_without_panicking() {
        for error in [
            StoreError::Serialization { label: "Tree" },
            StoreError::Poisoned,
            StoreError::TransactionAlreadyOpen,
            StoreError::Backend("commit"),
        ] {
            assert!(!format!("{error}").is_empty());
        }
    }
}
