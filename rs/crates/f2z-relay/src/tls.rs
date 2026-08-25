//! TLS 1.3, and the exporter §5.3 binds every signature to.
//!
//! # TLS 1.3 is a floor, not a preference
//!
//! §2.1: *"A relay MUST NOT negotiate TLS 1.2 or below."* The reason is §5.3 —
//! the channel binding is the TLS 1.3 exporter of
//! [RFC 8446 §7.5](https://datatracker.ietf.org/doc/html/rfc8446#section-7.5),
//! and there is no defined binding for this protocol over TLS 1.2. So the
//! `rustls` configuration names TLS 1.3 as the only version rather than as a
//! minimum, and a client that cannot reach it fails the handshake instead of
//! reaching a relay whose transcripts would have to carry zeros.
//!
//! # The exporter, and the honest caveat
//!
//! ```text
//! channel_binding = TLS-Exporter("EXPORTER-free2z-relay-v1", "", 32)
//! ```
//!
//! Both ends compute it from their own TLS state and it is never transmitted.
//! The relay reconstructs every transcript with **its own** value, so a
//! signature made on a different TLS session simply fails to verify — which,
//! with §5.2's `relay_id`, is what makes a captured frame useless anywhere
//! except the connection it was captured from.
//!
//! §5.3 states the caveat and this module cannot remove it: **a relay behind a
//! TLS-terminating proxy cannot compute it.** There is no exporter without a TLS
//! session, no standardized way for a proxy to forward one, and trusting a
//! proxy-supplied value would defeat the point. Such a deployment runs this
//! relay with no certificate, behind the proxy, and publishes
//! `channel_binding_mode: none` and `transport_security: none` — which
//! [`crate::caps`] does automatically, because both come from the same
//! `tls_enabled()` question.

use std::io;
use std::path::Path;
use std::sync::Arc;

use tokio_rustls::TlsAcceptor;
use tokio_rustls::rustls::pki_types::pem::PemObject as _;
use tokio_rustls::rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio_rustls::rustls::{ServerConfig, SupportedProtocolVersion};

/// §5.3's exporter label.
pub const EXPORTER_LABEL: &[u8] = b"EXPORTER-free2z-relay-v1";

/// §5.3's exporter length.
pub const EXPORTER_LEN: usize = 32;

/// TLS 1.3 and nothing else (§2.1).
const VERSIONS: &[&SupportedProtocolVersion] = &[&tokio_rustls::rustls::version::TLS13];

/// Why TLS could not be configured.
#[derive(Debug)]
pub enum TlsError {
    /// A file could not be read or parsed.
    ///
    /// The PEM reader is `rustls-pki-types`' own rather than `rustls-pemfile`:
    /// that crate was archived in August 2025 (RUSTSEC-2025-0134) and its own
    /// advisory says its latest version is a thin wrapper around exactly this
    /// code. One fewer crate on the path that reads an operator's private key.
    Pem(&'static str, String),
    /// A file could not be read.
    Io(&'static str, io::Error),
    /// The certificate file holds no certificate.
    NoCertificate,
    /// The key file holds no private key this build can use.
    ///
    /// Retained as a distinct variant because the message names the three forms
    /// that are accepted, which is the thing an operator with a failing
    /// certificate actually needs to read.
    NoPrivateKey,
    /// `rustls` refused the pair.
    Rustls(tokio_rustls::rustls::Error),
}

impl std::fmt::Display for TlsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Pem(what, detail) => write!(f, "{what}: {detail}"),
            Self::Io(what, error) => write!(f, "{what}: {error}"),
            Self::NoCertificate => f.write_str("listen.tls_cert holds no PEM certificate"),
            Self::NoPrivateKey => f.write_str(
                "listen.tls_key holds no PKCS#8, PKCS#1 or SEC1 private key in PEM form",
            ),
            Self::Rustls(error) => write!(f, "TLS configuration: {error}"),
        }
    }
}

impl std::error::Error for TlsError {}

/// Build an acceptor that negotiates TLS 1.3 only.
///
/// # Errors
///
/// [`TlsError`], every variant of which is a startup failure. A relay
/// configured for TLS that cannot serve it must not silently fall back to
/// plaintext: §2.3's insecure path is an explicit act with published
/// consequences, not a degradation.
pub fn acceptor(cert_path: &Path, key_path: &Path) -> Result<TlsAcceptor, TlsError> {
    let certs = load_certificates(cert_path)?;
    let key = load_private_key(key_path)?;

    let config = ServerConfig::builder_with_protocol_versions(VERSIONS)
        // A relay authenticates itself with §5.2's Ed25519 identity key inside
        // the protocol, and its clients are anonymous by construction (ADR
        // 0004). There is no client certificate to want.
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .map_err(TlsError::Rustls)?;

    Ok(TlsAcceptor::from(Arc::new(config)))
}

fn load_certificates(path: &Path) -> Result<Vec<CertificateDer<'static>>, TlsError> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(path)
        .map_err(|error| TlsError::Pem("listen.tls_cert", error.to_string()))?
        .collect::<Result<_, _>>()
        .map_err(|error| TlsError::Pem("listen.tls_cert", error.to_string()))?;
    if certs.is_empty() {
        return Err(TlsError::NoCertificate);
    }
    Ok(certs)
}

fn load_private_key(path: &Path) -> Result<PrivateKeyDer<'static>, TlsError> {
    PrivateKeyDer::from_pem_file(path)
        .map_err(|error| TlsError::Pem("listen.tls_key", error.to_string()))
}

/// §5.3's exporter, taken from a completed handshake.
///
/// Returns `None` when there is no binding to be had, and the caller drops the
/// connection. Anything that reaches this function has a TLS session, so
/// [`crate::caps`] publishes `channel_binding_mode: tls-exporter`, and §5.3 is
/// explicit about what that costs:
///
/// > A relay in `tls-exporter` mode whose exporter output is 32 zero bytes MUST
/// > treat that as failure to obtain a binding and refuse the connection. Zero
/// > is the `none` sentinel; accepting it in both modes would make them
/// > identical in the signed transcript.
///
/// So neither a failing exporter nor an exporter that returns the sentinel may
/// degrade this connection into the `none` mode it does not publish. It is
/// [`acceptor`]'s stance one layer up, for the same reason: §2.3's insecure
/// path is an explicit act with published consequences, not a degradation.
pub fn export(
    connection: &tokio_rustls::rustls::ServerConnection,
) -> Option<f2z_codec::types::ChannelBinding> {
    let output = [0u8; EXPORTER_LEN];
    // An exporter that cannot be derived from a completed TLS 1.3 handshake is
    // a `rustls` state this code has no way to repair.
    let Ok(bytes) = connection.export_keying_material(output, EXPORTER_LABEL, None) else {
        crate::log_warn!("TLS exporter unavailable; refusing the connection (WIRE.md §5.3)");
        return None;
    };
    binding_from_exporter(bytes)
}

/// §5.3's rule about the exporter's **output**, kept separate from the
/// exporter's *error* so it can be exercised without terminating TLS.
fn binding_from_exporter(bytes: [u8; EXPORTER_LEN]) -> Option<f2z_codec::types::ChannelBinding> {
    let binding = f2z_codec::types::ChannelBinding::new(bytes);
    if binding.is_zero() {
        crate::log_warn!(
            "TLS exporter returned the `none` sentinel; refusing the connection (WIRE.md §5.3)"
        );
        return None;
    }
    Some(binding)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_exporter_label_and_length_are_section_5_3s() {
        assert_eq!(EXPORTER_LABEL, b"EXPORTER-free2z-relay-v1");
        assert_eq!(EXPORTER_LEN, 32);
    }

    #[test]
    fn only_tls_1_3_is_offered() {
        assert_eq!(VERSIONS.len(), 1);
    }

    #[test]
    fn a_zero_exporter_output_yields_no_binding() {
        // §5.3: "A relay in `tls-exporter` mode whose exporter output is 32
        // zero bytes MUST treat that as failure to obtain a binding and refuse
        // the connection." `export` returns `None` and `listener::handshake`
        // drops the connection on it.
        assert!(binding_from_exporter([0u8; EXPORTER_LEN]).is_none());
    }

    #[test]
    fn a_real_exporter_output_yields_that_binding() {
        // The positive control, so the refusal above is attributable to the
        // sentinel and not to the guard refusing everything.
        let mut bytes = [0u8; EXPORTER_LEN];
        bytes[EXPORTER_LEN - 1] = 1;
        let binding = binding_from_exporter(bytes).expect("a non-zero exporter output binds");
        assert_eq!(binding.as_bytes(), &bytes);
    }

    #[test]
    fn a_missing_certificate_is_a_startup_failure_and_names_the_key() {
        // `TlsAcceptor` has no `Debug`, so the error is taken by matching
        // rather than by `unwrap_err`.
        let Err(error) = acceptor(
            Path::new("/nonexistent/cert.pem"),
            Path::new("/nonexistent/key.pem"),
        ) else {
            panic!("a missing certificate must not configure TLS");
        };
        assert!(format!("{error}").contains("listen.tls_cert"));
    }
}
