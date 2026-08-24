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
/// Returns 32 zero bytes when there is no TLS session, which is the value §5.3
/// requires in `channel_binding_mode: none` — the same constant both ends use,
/// so the transcript still verifies and the binding simply provides nothing.
#[must_use]
pub fn export(
    connection: &tokio_rustls::rustls::ServerConnection,
) -> f2z_codec::types::ChannelBinding {
    let mut output = [0u8; EXPORTER_LEN];
    match connection.export_keying_material(output, EXPORTER_LABEL, None) {
        Ok(bytes) => f2z_codec::types::ChannelBinding::new(bytes),
        // An exporter that cannot be derived from a completed TLS 1.3 handshake
        // is a `rustls` state this code has no way to repair. Zeros are the
        // value §5.3 defines for "no binding", so the connection degrades to the
        // documented weaker mode rather than to a value only one end knows.
        Err(_) => {
            crate::log_warn!("TLS exporter unavailable; this connection has no channel binding");
            output = [0u8; EXPORTER_LEN];
            f2z_codec::types::ChannelBinding::new(output)
        }
    }
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
