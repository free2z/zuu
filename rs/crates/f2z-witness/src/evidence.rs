//! Writing `KT.md` §7.3 fault reports, and the cosignature history of §7.5.
//!
//! # "Refuse, and record" is two things, and the second is the useful one
//!
//! A witness that refuses to cosign is invisible: §7.2 says plainly that *"a
//! witness that never cosigns at all is indistinguishable from one that is
//! offline; absence is not evidence."* What makes a refusal mean anything is
//! the artefact left behind, and §7.3 fixes its shape so that the evidence is
//! **portable** — anyone with the log's public key can check a `rollback`,
//! `fork`, `chain_break`, `bad_signature` or `vrf_key_change` report in
//! milliseconds and needs to trust nobody, because the evidence is two or more
//! tree heads signed by the log's own key.
//!
//! One kind is different and this module does not pretend otherwise:
//! `append_only_failure` is **not** self-authenticating. The claim is "this
//! proof does not verify", and a third party must re-run `audit_verify` on the
//! bytes to see it. So the proof bytes go in `detail` — without them the report
//! is an assertion nobody can check — and the report is a prompt to check, not
//! a verdict.
//!
//! The witness signs its own reports. That is deliberate: §7.3 — *"a witness
//! that cries wolf is on the record too."*

use std::path::{Path, PathBuf};

use ed25519_dalek::{Signer as _, SigningKey};
use f2z_codec::Canonical as _;
use f2z_codec::types::{Payload, PublicKey, Signature};
use f2z_codec::vec::VecU24;
use f2z_kt_core::sth::SignedTreeHead;
use f2z_kt_core::types::{LogId, label_field};
use f2z_kt_core::{
    FaultKind, FaultReport, FaultReportTBS, KT_VERSION, WitnessCosignature, labels,
};

use crate::error::{Result, WitnessError};

/// Where a witness writes what it found, and what it said.
#[derive(Clone, Debug)]
pub struct Evidence {
    directory: PathBuf,
}

impl Evidence {
    /// Point at a directory. Created if it does not exist.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Local`] if it cannot be created.
    pub fn new(directory: &Path) -> Result<Self> {
        std::fs::create_dir_all(directory).map_err(|error| {
            WitnessError::Local(format!("{}: {error}", directory.display()))
        })?;
        Ok(Self {
            directory: directory.to_path_buf(),
        })
    }

    /// Where the reports and the cosignature history live. §7.5 asks a witness
    /// to publish both at a stable URL; serving this directory is the whole of
    /// that job.
    #[must_use]
    pub fn directory(&self) -> &Path {
        &self.directory
    }

    /// Build, sign and write a fault report.
    ///
    /// `a` is what the witness held, `b` is what it was served, `detail` is the
    /// proof bytes for `append_only_failure` and empty otherwise. Returns the
    /// path written, for the operator log.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Local`] if the report will not encode or will not write.
    pub fn record(
        &self,
        key: &SigningKey,
        witness_pk: PublicKey,
        log_id: LogId,
        kind: FaultKind,
        a: Vec<SignedTreeHead>,
        b: Vec<SignedTreeHead>,
        detail: &[u8],
        observed_at_ms: u64,
    ) -> Result<PathBuf> {
        let report = FaultReportTBS {
            label: label_field(labels::LABEL_FAULT)
                .map_err(|error| WitnessError::Local(error.to_string()))?,
            kt_version: KT_VERSION,
            log_id,
            kind,
            witness_pk,
            a: VecU24::new(a),
            b: VecU24::new(b),
            detail: Payload::new(detail.to_vec()).map_err(|_| {
                WitnessError::Local("fault detail exceeds 2^24-1 bytes".to_owned())
            })?,
            observed_at_ms,
        };
        let signing_bytes = report
            .signing_bytes()
            .map_err(|error| WitnessError::Local(error.to_string()))?;
        let signed = FaultReport {
            report,
            signature: Signature::new(key.sign(&signing_bytes).to_bytes()),
        };
        let bytes = signed
            .encode_canonical()
            .map_err(|error| WitnessError::Local(error.to_string()))?;

        let path = self
            .directory
            .join(format!("fault-{observed_at_ms}-{}.bin", kind.code()));
        std::fs::write(&path, &bytes)
            .map_err(|error| WitnessError::Local(format!("{}: {error}", path.display())))?;

        // The report is the artefact; the log line is so an operator finds it.
        // `is_self_authenticating` is stated here rather than left to a reader
        // of the file, because it is the difference between "here is proof" and
        // "here is something worth checking".
        log::error!(
            "FAULT {:?} recorded at {} ({})",
            kind,
            path.display(),
            if kind.is_self_authenticating() {
                "self-authenticating: anyone with the log's public key can check it"
            } else {
                "NOT self-authenticating: a third party must re-run audit_verify on the detail"
            }
        );
        Ok(path)
    }

    /// Append an emitted cosignature to this witness's own published history
    /// (§7.5).
    ///
    /// This matters more than it looks. If the **log** is the only distributor
    /// of cosignatures then the party under audit controls the distribution of
    /// the evidence used to audit it, and can withhold one it does not like and
    /// simply appear to have fewer witnesses that epoch. A witness that keeps
    /// its own copy is what makes that detectable.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Local`] on any write failure.
    pub fn append_cosignature(&self, cosignature: &WitnessCosignature) -> Result<()> {
        use std::io::Write as _;

        let bytes = cosignature
            .encode_canonical()
            .map_err(|error| WitnessError::Local(error.to_string()))?;
        let length = u32::try_from(bytes.len())
            .map_err(|_| WitnessError::Local("cosignature too large".to_owned()))?;
        let path = self.directory.join("cosignatures.log");
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|error| WitnessError::Local(format!("{}: {error}", path.display())))?;
        let mut framed = Vec::with_capacity(bytes.len().saturating_add(4));
        framed.extend_from_slice(&length.to_be_bytes());
        framed.extend_from_slice(&bytes);
        file.write_all(&framed)
            .map_err(|error| WitnessError::Local(format!("{}: {error}", path.display())))?;
        file.sync_data()
            .map_err(|error| WitnessError::Local(format!("{}: {error}", path.display())))
    }

    /// Every fault report written so far, by path.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Local`] if the directory cannot be read.
    pub fn reports(&self) -> Result<Vec<PathBuf>> {
        let mut paths = Vec::new();
        let entries = std::fs::read_dir(&self.directory).map_err(|error| {
            WitnessError::Local(format!("{}: {error}", self.directory.display()))
        })?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("fault-"))
            {
                paths.push(path);
            }
        }
        paths.sort();
        Ok(paths)
    }
}
