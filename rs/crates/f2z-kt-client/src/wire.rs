//! `KT.md` §9.2's paths, and the encode/decode half of the client — pure
//! functions, bytes in and bytes out.
//!
//! Nothing here opens a socket, reads a clock or holds state, which is what
//! makes it the whole of the client's protocol surface on
//! `wasm32-unknown-unknown`: a browser binding drives `fetch` in JavaScript and
//! hands the bytes to [`crate::KtClient`], and the verification that follows is
//! the same code the native build runs. See [`crate::transport`] for why that
//! is the shape rather than an async trait.
//!
//! # JSON is a container, never a transcript
//!
//! The log serves every response as `application/octet-stream` `tls_codec`
//! bytes *and* as JSON carrying **those same bytes**, base64url, beside a
//! human-readable rendering and the field `"authoritative": "tls_codec"`.
//!
//! **This crate asks for the bytes and decodes nothing else.** There is no JSON
//! parser here and there will not be one: a client that reconstructed a tree
//! head from rendered fields would be verifying a signature over bytes it
//! rebuilt rather than over bytes it was sent, which is the parse-versus-verify
//! gap `WIRE.md` §3.3 exists to close.

use f2z_codec::Canonical as _;
use f2z_codec::canonical::decode_canonical;
use f2z_kt_core::api::{
    ErrorBody, HistoryRequest, HistoryResponse, LookupRequest, LookupResponse, TreeHeadBundle,
};
use f2z_kt_core::descriptor::SignedLogDescriptor;
use f2z_kt_core::policy::SignedAuthorityPolicy;
use f2z_kt_core::types::Handle;

use crate::error::{ClientError, Result};

/// `GET /kt/v1/sth`, and `/{epoch}` beneath it.
pub const PATH_STH: &str = "/kt/v1/sth";

/// `POST /kt/v1/lookup`. **The handle goes in the body** (§9.2).
pub const PATH_LOOKUP: &str = "/kt/v1/lookup";

/// `POST /kt/v1/history`. **The handle goes in the body** (§9.2).
pub const PATH_HISTORY: &str = "/kt/v1/history";

/// `GET /.well-known/free2z-kt/v1/authority` — §4.6's signed policy.
pub const PATH_AUTHORITY: &str = "/.well-known/free2z-kt/v1/authority";

/// `GET /.well-known/free2z-kt/v1/log` — §9.1's signed descriptor.
pub const PATH_DESCRIPTOR: &str = "/.well-known/free2z-kt/v1/log";

/// The only content type this client sends or accepts.
pub const CONTENT_TYPE: &str = "application/octet-stream";

/// Encode a `POST /kt/v1/lookup` body.
///
/// # Errors
///
/// [`ClientError::Protocol`] if the handle is outside `[a-z0-9_]{1,30}` or the
/// request will not encode.
pub fn lookup_request(handle: &Handle) -> Result<Vec<u8>> {
    handle.validate()?;
    let request = LookupRequest::new(handle.clone())?;
    Ok(request.encode_canonical()?)
}

/// Encode a `POST /kt/v1/history` body asking for a handle's **complete**
/// history.
///
/// Complete rather than `MostRecent(n)` because §8.2 step 4's chain check has
/// to reach either version 1 or the client's pin, and a client that asked for a
/// window and got one would have to ask again to find out whether it had been
/// shown everything. `HistoryRequest` narrows `akd`'s four-variant parameter to
/// two for the same reason: the other two let a caller ask a log for an
/// unbounded amount of work.
///
/// # Errors
///
/// As [`lookup_request`].
pub fn history_request(handle: &Handle) -> Result<Vec<u8>> {
    handle.validate()?;
    let request = HistoryRequest::complete(handle.clone())?;
    Ok(request.encode_canonical()?)
}

/// Decode a `GET /kt/v1/sth` response.
///
/// # Errors
///
/// [`ClientError::Protocol`] if the bytes are not a canonical
/// [`TreeHeadBundle`], or its constants are wrong.
pub fn decode_bundle(bytes: &[u8]) -> Result<TreeHeadBundle> {
    let bundle = decode_canonical::<TreeHeadBundle>(bytes)?.into_value();
    bundle.validate()?;
    Ok(bundle)
}

/// Decode a `POST /kt/v1/lookup` response.
///
/// [`LookupResponse::validate`] is what refuses the two incoherent shapes §9.2
/// names: a response claiming presence with no entry or proof, and a response
/// claiming absence while carrying either. Neither can reach a caller of this
/// function.
///
/// # Errors
///
/// [`ClientError::Protocol`] as [`decode_bundle`].
pub fn decode_lookup(bytes: &[u8]) -> Result<LookupResponse> {
    let response = decode_canonical::<LookupResponse>(bytes)?.into_value();
    response.validate()?;
    Ok(response)
}

/// Decode a `POST /kt/v1/history` response.
///
/// # Errors
///
/// [`ClientError::Protocol`] as [`decode_bundle`].
pub fn decode_history(bytes: &[u8]) -> Result<HistoryResponse> {
    let response = decode_canonical::<HistoryResponse>(bytes)?.into_value();
    response.validate()?;
    Ok(response)
}

/// Decode a `GET /.well-known/free2z-kt/v1/authority` response.
///
/// # Errors
///
/// [`ClientError::Protocol`] as [`decode_bundle`].
pub fn decode_authority_policy(bytes: &[u8]) -> Result<SignedAuthorityPolicy> {
    Ok(decode_canonical::<SignedAuthorityPolicy>(bytes)?.into_value())
}

/// Decode a `GET /.well-known/free2z-kt/v1/log` response.
///
/// # Errors
///
/// [`ClientError::Protocol`] as [`decode_bundle`].
pub fn decode_descriptor(bytes: &[u8]) -> Result<SignedLogDescriptor> {
    Ok(decode_canonical::<SignedLogDescriptor>(bytes)?.into_value())
}

/// Read a §9.5 error body, if that is what the bytes are.
///
/// Returns `None` rather than an error for anything else, because the caller is
/// a transport deciding how to describe a non-2xx response and "the body was
/// not an `ErrorBody` either" is a different sentence from "the log said
/// `ERR_RATE_LIMITED`".
#[must_use]
pub fn decode_error(bytes: &[u8]) -> Option<f2z_kt_core::ErrorCode> {
    let body = decode_canonical::<ErrorBody>(bytes).ok()?.into_value();
    f2z_kt_core::ErrorCode::from_code(body.code)
}

/// Turn a non-2xx status and its body into a [`ClientError`].
///
/// The one piece of interpretation a transport does, and it does it because an
/// HTTP status is a transport fact: a §9.5 code arrives as a status plus a
/// body, and a transport that dropped the body would turn every one of them
/// into an indistinguishable "unreachable".
#[must_use]
pub fn status_error(url: &str, status: u16, body: &[u8]) -> ClientError {
    decode_error(body).map_or_else(
        || ClientError::Unreachable(format!("{url}: HTTP {status} with no usable error body")),
        ClientError::Refused,
    )
}

#[cfg(test)]
mod tests {
    use f2z_kt_core::types::Handle;

    use super::{PATH_HISTORY, PATH_LOOKUP, history_request, lookup_request};

    /// §9.2's whole reason for making these two endpoints `POST`.
    ///
    /// Asserted rather than observed, because the failure it guards against is
    /// a future implementer adding a query string "just for debugging" and
    /// putting every handle anyone ever resolved into an access log.
    #[test]
    fn neither_path_can_carry_a_handle() {
        assert!(!PATH_LOOKUP.contains('{'));
        assert!(!PATH_LOOKUP.contains('?'));
        assert!(!PATH_HISTORY.contains('{'));
        assert!(!PATH_HISTORY.contains('?'));
        assert_eq!(PATH_LOOKUP, "/kt/v1/lookup");
        assert_eq!(PATH_HISTORY, "/kt/v1/history");
    }

    #[test]
    fn a_request_body_carries_the_handle_and_the_path_does_not() {
        let handle = Handle::new(b"alice".to_vec()).unwrap();
        for body in [
            lookup_request(&handle).unwrap(),
            history_request(&handle).unwrap(),
        ] {
            assert!(
                body.windows(5).any(|window| window == b"alice"),
                "the handle must be in the body"
            );
        }
    }

    #[test]
    fn a_handle_outside_the_charset_never_reaches_the_wire() {
        // `CLIENT-CONTRACT.md` §11.3's `handle-ineligible`: the string cannot be
        // a handle at all, so no lookup is made and no answer exists to
        // misreport.
        assert!(Handle::new(b"Alice".to_vec()).is_err());
        assert!(Handle::new(b"a/b".to_vec()).is_err());
    }
}
