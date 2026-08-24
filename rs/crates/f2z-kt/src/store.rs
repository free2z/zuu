//! Durable storage — three append-only journals and an `fsync`.
//!
//! # What is durable here, and what is derived
//!
//! `KT.md` §11.2 says the storage backend is ours and tells us why to be
//! careful with it: NCC Group explicitly deprioritised `akd`'s "storage caching
//! and parallelization strategy", and facebook/akd#495 — the append-only bypass
//! that sets our version floor — was in exactly that unreviewed region.
//!
//! The conclusion this crate draws is **not** to write a bespoke
//! `akd::storage::Database`. It is to make the durable artifact the log's own
//! history, and derive the tree from it:
//!
//! | Journal | Records | Why it must survive a restart |
//! |---|---|---|
//! | `submissions.log` | every [`AdmittedSubmission`]'s canonical entry bytes, in admission order | a submission the log accepted and then forgot is a broken §5.2 merge promise, and the client is holding a signed receipt that says so |
//! | `epochs.log` | every published `SignedTreeHead`, plus how many submissions it covers | §6.3's chain is only checkable if the log can still produce every head it signed |
//! | `cosignatures.log` | every `WitnessCosignature` accepted at `/kt/v1/cosign` | §9.2 has the log serve them; a log that forgets them looks like a log with fewer witnesses |
//!
//! The `akd` tree is rebuilt at startup by replaying `publish()` epoch by
//! epoch, in the recorded order, against an in-memory database — and **the
//! replay re-derives every root hash and compares it to the one the log
//! signed.** A corrupted journal, a lost record, or an `akd` version that no
//! longer produces the same tree is then a loud refusal to start, not a log
//! that quietly serves proofs against a root nobody cosigned.
//!
//! The cost is honest and it is stated rather than hidden: startup is O(entries
//! ever submitted), and the working set is memory-resident. That is the wrong
//! shape for a directory with millions of handles and the right shape for one
//! whose storage layer has had no review at all. Replacing it with a durable
//! `Database` implementation is future work, and the root-hash check above is
//! the acceptance test that replacement has to pass.
//!
//! # Framing, and what a torn write looks like
//!
//! Each record is `uint32` big-endian length, then that many bytes of
//! `tls_codec`. Appends are `write_all` followed by `sync_data`. A process that
//! dies mid-append leaves a short tail: on load, the first record whose length
//! prefix or body is incomplete ends the journal, and the file is truncated to
//! the last whole record. A record that is *complete but does not decode* is
//! not a torn write — it is corruption — and is a hard error.
//!
//! [`AdmittedSubmission`]: crate::admit::AdmittedSubmission

use std::fs::{File, OpenOptions};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};

use f2z_codec::Canonical as _;
use f2z_codec::decode_canonical;
use f2z_codec::types::{Payload, ShortBytes};
use f2z_kt_core::sth::SignedTreeHead;
use f2z_kt_core::types::{check_label, label_field};
use f2z_kt_core::{KT_VERSION, WitnessCosignature};
use tls_codec::{TlsDeserializeBytes, TlsSerializeBytes, TlsSize};

use crate::error::{LogError, Result};

/// `StoredSubmission`'s type tag. Not a signing label — see [`crate::wire`].
const LABEL_STORED_SUBMISSION: &[u8] = b"free2z/kt/v1/stored-submission";

/// `StoredEpoch`'s type tag. Not a signing label.
const LABEL_STORED_EPOCH: &[u8] = b"free2z/kt/v1/stored-epoch";

/// The largest record this crate will read back, as a guard against a length
/// prefix that a corrupt file made enormous. An append-only proof can be
/// megabytes (`KT.md` §10) but a *record* here is one entry, one tree head or
/// one cosignature.
const MAX_RECORD_BYTES: usize = 1 << 20;

/// One accepted submission, as it is written to `submissions.log`.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct StoredSubmission {
    /// Exactly [`LABEL_STORED_SUBMISSION`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// Position in admission order, from 0. Redundant with the record's
    /// position in the file, and checked against it on load: a journal whose
    /// sequence numbers do not match its order has been edited.
    pub sequence: u64,
    /// The log's clock when it admitted the submission — the receipt's
    /// `received_at_ms` (`KT.md` §5.3), kept so that a restart can still tell
    /// whether a merge promise was broken.
    pub received_at_ms: u64,
    /// `tls_codec(DirectoryEntry)`, canonical, exactly as
    /// [`f2z_kt_core::submit::AcceptedSubmission::canonical_bytes`] produced
    /// it. Never the bytes that arrived.
    pub entry: Payload,
}

/// One published epoch, as it is written to `epochs.log`.
#[derive(Clone, Debug, PartialEq, Eq, TlsSize, TlsSerializeBytes, TlsDeserializeBytes)]
pub struct StoredEpoch {
    /// Exactly [`LABEL_STORED_EPOCH`].
    pub label: ShortBytes,
    /// `0x0001`.
    pub kt_version: u16,
    /// The head the log signed for this epoch.
    pub head: SignedTreeHead,
    /// How many records of `submissions.log` this epoch and every epoch before
    /// it covers.
    ///
    /// Batches are contiguous prefixes of the submission journal — §4.3 allows
    /// at most one entry per handle per epoch, and the scheduler takes what is
    /// pending in order — so one watermark per epoch describes the whole
    /// partition, and "what is still pending" is everything past the last one.
    pub submissions_upto: u64,
}

/// Everything the journals held at startup.
#[derive(Debug, Default)]
pub struct Journal {
    /// Accepted submissions, in admission order.
    pub submissions: Vec<StoredSubmission>,
    /// Published epochs, in epoch order.
    pub epochs: Vec<StoredEpoch>,
    /// Cosignatures, in arrival order.
    pub cosignatures: Vec<WitnessCosignature>,
}

/// The three append-only journals.
#[derive(Debug)]
pub struct Store {
    dir: PathBuf,
    submissions: File,
    epochs: File,
    cosignatures: File,
    next_sequence: u64,
}

impl Store {
    /// Open (or create) the journals under `dir` and read them back.
    ///
    /// # Errors
    ///
    /// [`LogError::Storage`] if the directory cannot be created or a journal
    /// cannot be opened, and if a *complete* record fails to decode — which is
    /// corruption, not a torn write.
    pub fn open(dir: &Path) -> Result<(Self, Journal)> {
        std::fs::create_dir_all(dir).map_err(|error| storage(dir, error))?;

        let mut submissions = open_append(&dir.join("submissions.log"))?;
        let mut epochs = open_append(&dir.join("epochs.log"))?;
        let mut cosignatures = open_append(&dir.join("cosignatures.log"))?;

        let submissions_raw = read_records(&mut submissions, dir)?;
        let epochs_raw = read_records(&mut epochs, dir)?;
        let cosignatures_raw = read_records(&mut cosignatures, dir)?;

        let mut journal = Journal::default();
        for (index, bytes) in submissions_raw.iter().enumerate() {
            let record = decode_canonical::<StoredSubmission>(bytes)
                .map_err(|_| corrupt("submissions.log", index))?
                .into_value();
            check_label(&record.label, LABEL_STORED_SUBMISSION)
                .map_err(|_| corrupt("submissions.log", index))?;
            if record.kt_version != KT_VERSION
                || record.sequence != u64::try_from(index).unwrap_or(u64::MAX)
            {
                return Err(corrupt("submissions.log", index));
            }
            journal.submissions.push(record);
        }
        for (index, bytes) in epochs_raw.iter().enumerate() {
            let record = decode_canonical::<StoredEpoch>(bytes)
                .map_err(|_| corrupt("epochs.log", index))?
                .into_value();
            check_label(&record.label, LABEL_STORED_EPOCH)
                .map_err(|_| corrupt("epochs.log", index))?;
            if record.kt_version != KT_VERSION {
                return Err(corrupt("epochs.log", index));
            }
            journal.epochs.push(record);
        }
        for (index, bytes) in cosignatures_raw.iter().enumerate() {
            let record = decode_canonical::<WitnessCosignature>(bytes)
                .map_err(|_| corrupt("cosignatures.log", index))?
                .into_value();
            journal.cosignatures.push(record);
        }

        let next_sequence = u64::try_from(journal.submissions.len()).unwrap_or(u64::MAX);
        Ok((
            Self {
                dir: dir.to_path_buf(),
                submissions,
                epochs,
                cosignatures,
                next_sequence,
            },
            journal,
        ))
    }

    /// Where the journals live. Rendered in operator output; contains no user
    /// data.
    #[must_use]
    pub fn directory(&self) -> &Path {
        &self.dir
    }

    /// Append an accepted submission and `fsync`.
    ///
    /// Returns the record as written, so the caller does not have to
    /// reconstruct what it just persisted.
    ///
    /// # Errors
    ///
    /// [`LogError::Storage`] on any write or sync failure, and
    /// [`LogError::Malformed`] if the entry will not fit a `u24` length —
    /// which the submission path has already excluded.
    pub fn append_submission(
        &mut self,
        entry: &[u8],
        received_at_ms: u64,
    ) -> Result<StoredSubmission> {
        let record = StoredSubmission {
            label: label_field(LABEL_STORED_SUBMISSION).map_err(LogError::Kt)?,
            kt_version: KT_VERSION,
            sequence: self.next_sequence,
            received_at_ms,
            entry: Payload::new(entry.to_vec()).map_err(|_| LogError::Malformed)?,
        };
        let bytes = record.encode_canonical().map_err(|_| LogError::Malformed)?;
        append_record(&mut self.submissions, &bytes, &self.dir)?;
        self.next_sequence = self.next_sequence.saturating_add(1);
        Ok(record)
    }

    /// Append a published epoch and `fsync`.
    ///
    /// # Errors
    ///
    /// [`LogError::Storage`] on any write or sync failure.
    pub fn append_epoch(&mut self, head: &SignedTreeHead, submissions_upto: u64) -> Result<()> {
        let record = StoredEpoch {
            label: label_field(LABEL_STORED_EPOCH).map_err(LogError::Kt)?,
            kt_version: KT_VERSION,
            head: head.clone(),
            submissions_upto,
        };
        let bytes = record.encode_canonical().map_err(|_| LogError::Malformed)?;
        append_record(&mut self.epochs, &bytes, &self.dir)
    }

    /// Append a cosignature and `fsync`.
    ///
    /// # Errors
    ///
    /// [`LogError::Storage`] on any write or sync failure.
    pub fn append_cosignature(&mut self, cosignature: &WitnessCosignature) -> Result<()> {
        let bytes = cosignature
            .encode_canonical()
            .map_err(|_| LogError::Malformed)?;
        append_record(&mut self.cosignatures, &bytes, &self.dir)
    }
}

fn open_append(path: &Path) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(path)
        .map_err(|error| storage(path, error))
}

fn append_record(file: &mut File, bytes: &[u8], dir: &Path) -> Result<()> {
    let length = u32::try_from(bytes.len()).map_err(|_| LogError::Malformed)?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(LogError::Malformed);
    }
    let mut framed = Vec::with_capacity(bytes.len().saturating_add(4));
    framed.extend_from_slice(&length.to_be_bytes());
    framed.extend_from_slice(bytes);
    file.write_all(&framed)
        .map_err(|error| storage(dir, error))?;
    // `sync_data` rather than `sync_all`: the file's length is data for an
    // append, and the metadata we would additionally flush (mtime) is not
    // something correctness depends on.
    file.sync_data().map_err(|error| storage(dir, error))
}

/// Read every whole record, truncating a torn tail.
fn read_records(file: &mut File, dir: &Path) -> Result<Vec<Vec<u8>>> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| storage(dir, error))?;
    let mut raw = Vec::new();
    file.read_to_end(&mut raw)
        .map_err(|error| storage(dir, error))?;

    let mut records = Vec::new();
    let mut offset = 0usize;
    while let Some(header) = raw.get(offset..offset.saturating_add(4)) {
        let Ok(header) = <[u8; 4]>::try_from(header) else {
            break;
        };
        let length = u32::from_be_bytes(header) as usize;
        if length == 0 || length > MAX_RECORD_BYTES {
            // Not a torn write: a length prefix this file could never have
            // produced. Refuse rather than guess where the next record starts.
            return Err(LogError::Storage(format!(
                "{}: record at offset {offset} declares {length} bytes",
                dir.display()
            )));
        }
        let start = offset.saturating_add(4);
        let end = start.saturating_add(length);
        let Some(body) = raw.get(start..end) else {
            break;
        };
        records.push(body.to_vec());
        offset = end;
    }

    if offset != raw.len() {
        // A short tail from a process that died mid-append. Drop it, and make
        // the file agree, so the next append does not extend a partial record.
        file.set_len(u64::try_from(offset).unwrap_or(0))
            .map_err(|error| storage(dir, error))?;
        file.seek(SeekFrom::End(0))
            .map_err(|error| storage(dir, error))?;
        log::warn!(
            "truncated {} bytes of partial trailing record in {}",
            raw.len().saturating_sub(offset),
            dir.display()
        );
    }
    Ok(records)
}

fn storage(path: &Path, error: std::io::Error) -> LogError {
    LogError::Storage(format!("{}: {error}", path.display()))
}

fn corrupt(file: &str, index: usize) -> LogError {
    LogError::Storage(format!("{file}: record {index} does not decode"))
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use super::Store;

    #[test]
    fn journals_survive_a_reopen_and_keep_their_order() {
        let dir = crate::testing::temp_dir("store-reopen");
        {
            let (mut store, journal) = Store::open(&dir).unwrap();
            assert!(journal.submissions.is_empty());
            store.append_submission(b"first", 1_000).unwrap();
            store.append_submission(b"second", 2_000).unwrap();
        }
        let (_store, journal) = Store::open(&dir).unwrap();
        assert_eq!(journal.submissions.len(), 2);
        assert_eq!(journal.submissions[0].entry.as_slice(), b"first");
        assert_eq!(journal.submissions[0].sequence, 0);
        assert_eq!(journal.submissions[1].received_at_ms, 2_000);
    }

    #[test]
    fn a_torn_tail_is_dropped_and_the_next_append_lands_whole() {
        let dir = crate::testing::temp_dir("store-torn");
        {
            let (mut store, _) = Store::open(&dir).unwrap();
            store.append_submission(b"whole", 1).unwrap();
        }
        // Simulate a process that died between `write_all` and the end of the
        // record: a length prefix with only some of its body behind it.
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(dir.join("submissions.log"))
                .unwrap();
            file.write_all(&64u32.to_be_bytes()).unwrap();
            file.write_all(b"only twelve!").unwrap();
        }
        let (mut store, journal) = Store::open(&dir).unwrap();
        assert_eq!(journal.submissions.len(), 1, "the torn record is not read");
        store.append_submission(b"after", 2).unwrap();

        let (_store, journal) = Store::open(&dir).unwrap();
        assert_eq!(
            journal.submissions.len(),
            2,
            "the append after a truncation is a whole record, not an extension of the torn one"
        );
        assert_eq!(journal.submissions[1].entry.as_slice(), b"after");
    }

    #[test]
    fn a_complete_but_undecodable_record_is_refused_rather_than_skipped() {
        let dir = crate::testing::temp_dir("store-corrupt");
        {
            let (mut store, _) = Store::open(&dir).unwrap();
            store.append_submission(b"whole", 1).unwrap();
        }
        {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(dir.join("submissions.log"))
                .unwrap();
            file.write_all(&5u32.to_be_bytes()).unwrap();
            file.write_all(b"junk!").unwrap();
        }
        // Corruption is not a torn write. Guessing which records are still good
        // is how a log ends up serving proofs against a root it cannot rebuild.
        assert!(Store::open(&dir).is_err());
    }
}
