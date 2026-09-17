//! `KT.md` §6.1's `log_id = BLAKE2b-256("free2z/kt/v1/log-id" || pk)`, for
//! `build.rs`.
//!
//! The plugin itself uses `f2z_kt_core::labels::log_id` and never this file. A
//! build script cannot link `f2z-kt-core`, so it computes the same digest with
//! the `blake2` crate that `f2z-codec`'s `hash` is built on, and the unit test
//! `the_build_time_log_id_is_the_protocol_log_id` holds the two to the same
//! bytes.

use blake2::Digest as _;

/// `f2z_kt_core::labels::LABEL_LOG_ID`, restated.
const LABEL_LOG_ID: &[u8] = b"free2z/kt/v1/log-id";

/// `H(LABEL_LOG_ID, public_key)`.
pub fn log_id(public_key: &[u8; 32]) -> [u8; 32] {
    let mut hasher = blake2::Blake2b::<blake2::digest::consts::U32>::new();
    hasher.update(LABEL_LOG_ID);
    hasher.update(public_key);
    hasher.finalize().into()
}
