//! Fixtures for this crate's own unit tests.
//!
//! `#[cfg(test)]`, so nothing here is compiled into a shipping client. The
//! end-to-end suite in `tests/acceptance.rs` deliberately does **not** use
//! these: it stands up a real log and a real witness, because a client verified
//! against a fixture of a log is a client verified against a second
//! implementation of the thing it exists to catch lying. These exist for the
//! small structural rules — the pin store, the alarm log — where standing up an
//! `akd` tree would obscure what is being asserted.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use f2z_codec::types::{Digest, PublicKey, Signature};
use f2z_codec::vec::VecU16;
use f2z_kt_core::entry::{DirectoryEntry, DirectoryEntryTBS, EntryAuthorization, EntryKind};
use f2z_kt_core::submit::PublishedEntry;
use f2z_kt_core::types::{Handle, LogId, label_field};
use f2z_kt_core::{KT_VERSION, labels};

/// A structurally valid entry with the fields the pin rules read.
///
/// The authorization signature is not real: nothing in these tests verifies
/// one, and a fixture that signed would be a fixture that could be mistaken for
/// evidence that signing was checked.
#[must_use]
pub fn entry(handle: &str, version: u32, identity: u8, prev_entry_hash: Digest) -> DirectoryEntry {
    DirectoryEntry {
        entry: DirectoryEntryTBS {
            label: label_field(labels::LABEL_ENTRY).unwrap(),
            kt_version: KT_VERSION,
            log_id: LogId::new([0x11; 32]),
            handle: Handle::new(handle.as_bytes().to_vec()).unwrap(),
            entry_version: version,
            kind: EntryKind::SameKey,
            identity_pk: PublicKey::new([identity; 32]),
            directory_auth_pk: PublicKey::new([identity.wrapping_add(1); 32]),
            devices: VecU16::new(Vec::new()),
            revocations: VecU16::new(Vec::new()),
            contact_endpoints: VecU16::new(Vec::new()),
            prev_entry_hash,
            no_reset: 0,
            created_at_ms: 1_700_000_000_000,
        },
        authorization: EntryAuthorization::SameKey {
            auth_signature: Signature::zero(),
        },
    }
}

/// The published state of [`entry`].
#[must_use]
pub fn published(
    handle: &str,
    version: u32,
    identity: u8,
    prev_entry_hash: Digest,
) -> PublishedEntry {
    PublishedEntry::from_entry(&entry(handle, version, identity, prev_entry_hash)).unwrap()
}
