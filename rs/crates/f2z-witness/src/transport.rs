//! Talking to the log — outbound only.
//!
//! `KT.md` §9.3 and the roles table in §2 are a hard constraint on this file:
//! a witness has **no inbound port, no TLS certificate, no domain and no
//! database.** It polls over outbound HTTPS and it pushes its cosignature to
//! `/kt/v1/cosign`, which is an endpoint on the **log**. Nothing here listens.
//!
//! # Why a trait
//!
//! Not for mocking. The acceptance test drives this daemon against a **real**
//! [`f2z_kt`] log in the same process — a witness verified against a mock is a
//! witness that has not been tested — and the equivocating-log fixture is a
//! transport that serves two histories from one real log's signing key. Both
//! are transports, not fakes of the loop.
//!
//! [`f2z_kt`]: https://github.com/free2z/zuu/tree/main/rs/crates/f2z-kt

use crate::error::{Result, WitnessError};

/// How the witness reaches a log.
///
/// Every method returns raw bytes. Decoding, and every decision taken on what
/// was decoded, belongs to [`crate::witness`] — a transport that returned typed
/// values would be a second place where a response is interpreted.
pub trait Transport: Send + Sync {
    /// `GET /kt/v1/sth`.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Transport`] if the log could not be reached or did not
    /// answer with a body.
    fn latest_sth(&self) -> Result<Vec<u8>>;

    /// `GET /kt/v1/audit?from={from}&to={to}`.
    ///
    /// # Errors
    ///
    /// As [`Transport::latest_sth`].
    fn audit(&self, from: u64, to: u64) -> Result<Vec<u8>>;

    /// `POST /kt/v1/cosign`.
    ///
    /// # Errors
    ///
    /// As [`Transport::latest_sth`].
    fn cosign(&self, cosignature: &[u8]) -> Result<()>;
}

/// The real client: `ureq`, blocking, `rustls`.
///
/// Blocking because a poll loop is blocking-shaped, and an async client would
/// pull an executor and a connection pool into a process whose entire job is
/// one request every ten minutes. `rustls` rather than a system TLS library so
/// that the distroless image needs no shared object.
#[derive(Debug)]
pub struct HttpTransport {
    base: String,
    agent: ureq::Agent,
}

impl HttpTransport {
    /// Point a witness at a log.
    ///
    /// `base` is the origin, e.g. `https://kt.free2z.cash`. A trailing slash is
    /// trimmed so that the paths below are unambiguous.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Local`] if `base` is not an `https://` URL.
    ///
    /// **`http://` is refused.** A witness that polled a log in cleartext could
    /// be shown a different history by anybody on the path, and would then
    /// produce a cosignature that is perfectly valid and attests to a root the
    /// log never published — an equivocation the log did not even commit.
    /// `KT.md` §9.2 says HTTPS; this is the check that means it.
    pub fn new(base: &str, timeout: std::time::Duration) -> Result<Self> {
        if !base.starts_with("https://") {
            return Err(WitnessError::Local(format!(
                "{base}: a witness polls over HTTPS; a cleartext poll lets anyone on the path \
                 choose which history this witness cosigns"
            )));
        }
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .build();
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            agent: config.into(),
        })
    }

    /// As [`HttpTransport::new`], but permitting a cleartext base.
    ///
    /// **For a loopback sidecar and for nothing else.** The refusal in
    /// [`HttpTransport::new`] is the default because it is right in every case
    /// a witness is actually deployed in; this exists so an operator running
    /// the witness inside the same pod as the log, over `127.0.0.1`, is not
    /// forced to stand up a certificate for a socket that never leaves the
    /// host. It is a separate function rather than a flag so that using it is
    /// visible in the code that calls it.
    ///
    /// # Errors
    ///
    /// [`WitnessError::Local`] if `base` is neither `http://` nor `https://`.
    pub fn insecure_loopback(base: &str, timeout: std::time::Duration) -> Result<Self> {
        if !base.starts_with("http://") && !base.starts_with("https://") {
            return Err(WitnessError::Local(format!("{base}: not an http(s) URL")));
        }
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .build();
        Ok(Self {
            base: base.trim_end_matches('/').to_owned(),
            agent: config.into(),
        })
    }

    fn get(&self, path: &str) -> Result<Vec<u8>> {
        let url = format!("{}{path}", self.base);
        let mut response = self
            .agent
            .get(&url)
            .header("accept", "application/octet-stream")
            .call()
            .map_err(|error| WitnessError::Transport(format!("{url}: {error}")))?;
        response
            .body_mut()
            .read_to_vec()
            .map_err(|error| WitnessError::Transport(format!("{url}: {error}")))
    }
}

impl Transport for HttpTransport {
    fn latest_sth(&self) -> Result<Vec<u8>> {
        self.get("/kt/v1/sth")
    }

    fn audit(&self, from: u64, to: u64) -> Result<Vec<u8>> {
        self.get(&format!("/kt/v1/audit?from={from}&to={to}"))
    }

    fn cosign(&self, cosignature: &[u8]) -> Result<()> {
        let url = format!("{}/kt/v1/cosign", self.base);
        self.agent
            .post(&url)
            .header("content-type", "application/octet-stream")
            .send(cosignature)
            .map_err(|error| WitnessError::Transport(format!("{url}: {error}")))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::HttpTransport;

    #[test]
    fn a_cleartext_log_url_is_refused_by_default() {
        let error =
            HttpTransport::new("http://kt.example", std::time::Duration::from_secs(5)).unwrap_err();
        assert!(format!("{error}").contains("HTTPS"));
    }

    #[test]
    fn the_loopback_escape_hatch_is_a_separate_function_and_is_visible_at_the_call_site() {
        assert!(
            HttpTransport::insecure_loopback(
                "http://127.0.0.1:8443",
                std::time::Duration::from_secs(5)
            )
            .is_ok()
        );
        assert!(
            HttpTransport::insecure_loopback("ftp://nope", std::time::Duration::from_secs(5))
                .is_err()
        );
    }
}
