//! Reaching the log — and the one deliberate choice this crate makes about
//! shape.
//!
//! # The handle is in the body, and this trait is what makes that structural
//!
//! `KT.md` §9.2 makes `/kt/v1/lookup` and `/kt/v1/history` `POST` with a body
//! *"so that the queried handle does not land in the log's access logs, any
//! intermediary's logs, or a `Referer` header by default"*. §9.2 is also honest
//! about the size of that: the log still learns the handle, because it has to
//! answer. It removes the accidental copies, not the intentional one.
//!
//! A trait with a `lookup(&self, url_path: &str)` would leave a future
//! implementer free to put the handle back in a path. This one takes
//! **already-encoded request bytes** and owns the path itself, so there is no
//! parameter a handle could be threaded through. [`crate::wire`] builds the
//! bodies; a transport never sees a [`f2z_kt_core::types::Handle`] at all.
//!
//! # Why the trait is synchronous, and what the browser does
//!
//! This was the choice the crate had to make deliberately, so it is written
//! down rather than implied.
//!
//! The alternative was `async fn` in a trait. It is stable, and it is the wrong
//! shape here for two reasons that are both about this code specifically rather
//! than about async in general:
//!
//! 1. **The `Send` bound splits by target.** A native caller wants
//!    `Send` futures so the client can live behind a `tokio` task. A browser
//!    caller *cannot* have them: `wasm-bindgen`'s `JsFuture` is `!Send`, and
//!    there is no way to write one trait that is `Send` on one target and not
//!    on the other without a feature that changes a public signature — which is
//!    a different trait wearing one name.
//! 2. **Neither real consumer is async-shaped.** The two are a Tauri command
//!    handler, which runs on a blocking pool and hands back a value, and a
//!    once-per-epoch self-audit poll. `f2z-witness`'s `Transport` reached the
//!    same conclusion for the same reason and this trait is deliberately its
//!    sibling.
//!
//! So the browser does not get a `fetch`-based implementation *from this
//! crate*. It gets something better suited to it. Every function in
//! [`crate::wire`] is pure — bytes in, structure out, no state and no clock —
//! and a WASM binding implements this trait over a handful of `Vec<u8>`s it has
//! already `await`ed from JavaScript, or uses [`Detached`] and drives the
//! verification directly. **The verification is the same code on both targets,
//! which is the property ADR 0001 is about; only the socket differs, and the
//! socket is the part a browser insists on owning anyway.**
//!
//! # What is deliberately absent
//!
//! There is **no `audit` method.** `GET /kt/v1/audit` returns megabytes —
//! measured at 3.9 MB and 1–3 s for five epochs (§10) — and §8.5 is explicit
//! that *"a client cannot substitute its own consistency check for a
//! witness's"*. A client-side audit method would be an invitation to attempt
//! the check that does not scale, and its absence is the API stating that the
//! witness role is load-bearing rather than optional.

use crate::error::ClientError;

/// How a client reaches a key-transparency log.
///
/// Every method returns raw bytes. Decoding, and every decision taken on what
/// was decoded, belongs to [`crate::wire`] and [`crate::KtClient`] — a
/// transport that returned typed values would be a second place where a
/// response is interpreted, and the whole point of §11.4 is that there is one.
pub trait Transport {
    /// `GET /kt/v1/sth` — the latest [`f2z_kt_core::api::TreeHeadBundle`].
    ///
    /// # Errors
    ///
    /// [`ClientError::Unreachable`] if the log did not answer,
    /// [`ClientError::Refused`] if it answered with a §9.5 error body.
    fn latest_sth(&self) -> Result<Vec<u8>, ClientError>;

    /// `GET /kt/v1/sth/{epoch}` — that epoch's bundle.
    ///
    /// Needed for §6.3 rule 7: a head that skips epochs is not accepted, and
    /// the only correct response is to fetch every intervening head and check
    /// the chain link by link. *A gap accepted on trust is a branch accepted on
    /// trust.* [`crate::KtClient`] binds the decoded head back to this exact
    /// `epoch` before acceptance, so a duplicate or reordered response cannot
    /// consume a page position. One catch-up operation calls this at most
    /// [`crate::MAX_EPOCH_CATCHUP`] times and persists the last accepted signed
    /// head as its checkpoint.
    ///
    /// # Errors
    ///
    /// As [`Transport::latest_sth`].
    fn sth_at(&self, epoch: u64) -> Result<Vec<u8>, ClientError>;

    /// `POST /kt/v1/lookup`, with an encoded [`f2z_kt_core::api::LookupRequest`]
    /// as the body.
    ///
    /// # Errors
    ///
    /// As [`Transport::latest_sth`].
    fn lookup(&self, request: &[u8]) -> Result<Vec<u8>, ClientError>;

    /// `POST /kt/v1/history`, with an encoded
    /// [`f2z_kt_core::api::HistoryRequest`] as the body.
    ///
    /// # Errors
    ///
    /// As [`Transport::latest_sth`].
    fn history(&self, request: &[u8]) -> Result<Vec<u8>, ClientError>;

    /// `GET /.well-known/free2z-kt/v1/authority` — §4.6's
    /// [`f2z_kt_core::policy::SignedAuthorityPolicy`], which §8.1 step 7 makes
    /// a client fetch and verify.
    ///
    /// # Errors
    ///
    /// As [`Transport::latest_sth`].
    fn authority_policy(&self) -> Result<Vec<u8>, ClientError>;

    /// `GET /.well-known/free2z-kt/v1/log` — §9.1's
    /// [`f2z_kt_core::descriptor::SignedLogDescriptor`].
    ///
    /// # Errors
    ///
    /// As [`Transport::latest_sth`].
    fn descriptor(&self) -> Result<Vec<u8>, ClientError>;
}

/// The real client: `ureq`, blocking, `rustls`.
///
/// A sibling of `f2z_witness::HttpTransport` and knowingly so — same crate,
/// same blocking shape, same refusal of a cleartext base. It is not shared code
/// because that one lives in an AGPL-3.0 binary and this one is linked by every
/// client; §11.4's *one crate, three consumers* is about the code that decides
/// protocol outcomes, and neither of these decides one.
#[cfg(feature = "http")]
pub struct HttpTransport {
    base: String,
    agent: ureq::Agent,
}

/// Hand-written because the workspace `Debug` scan insists on it wherever raw
/// bytes are held, and because a base URL is the one field here worth printing.
#[cfg(feature = "http")]
impl core::fmt::Debug for HttpTransport {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("HttpTransport")
            .field("base", &self.base)
            .finish_non_exhaustive()
    }
}

#[cfg(feature = "http")]
impl HttpTransport {
    /// Point a client at a log.
    ///
    /// `base` is the origin, e.g. `https://kt.free2z.cash`. A trailing slash is
    /// trimmed so the paths below are unambiguous.
    ///
    /// # Errors
    ///
    /// [`ClientError::Configuration`] if `base` is not an `https://` URL.
    ///
    /// **`http://` is refused.** A client that polled a log in cleartext could
    /// be shown a different tree head by anybody on the path — and since a
    /// lookup response is not signed, an attacker on that path can substitute a
    /// whole answer, which is [#133](https://github.com/free2z/zuu/issues/133)'s
    /// moment arriving over plain TCP.
    pub fn new(base: &str, timeout: core::time::Duration) -> Result<Self, ClientError> {
        if !base.starts_with("https://") {
            return Err(ClientError::Configuration(format!(
                "{base}: a client resolves handles over HTTPS; a cleartext lookup lets anyone \
                 on the path choose which key this client is about to encrypt to"
            )));
        }
        Ok(Self::build(base, timeout))
    }

    /// As [`HttpTransport::new`], but permitting a cleartext base.
    ///
    /// **For a loopback log and for nothing else** — a development log on
    /// `127.0.0.1`, or the acceptance suite. A separate function rather than a
    /// flag so that using it is visible in the code that calls it, exactly as
    /// `f2z_witness::HttpTransport::insecure_loopback` is.
    ///
    /// # Errors
    ///
    /// [`ClientError::Configuration`] if `base` is neither `http://` nor
    /// `https://`.
    pub fn insecure_loopback(
        base: &str,
        timeout: core::time::Duration,
    ) -> Result<Self, ClientError> {
        if !base.starts_with("http://") && !base.starts_with("https://") {
            return Err(ClientError::Configuration(format!(
                "{base}: not an http(s) URL"
            )));
        }
        Ok(Self::build(base, timeout))
    }

    fn build(base: &str, timeout: core::time::Duration) -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(timeout))
            .build();
        Self {
            base: base.trim_end_matches('/').to_owned(),
            agent: config.into(),
        }
    }

    fn get(&self, path: &str) -> Result<Vec<u8>, ClientError> {
        let url = format!("{}{path}", self.base);
        let mut response = self
            .agent
            .get(&url)
            .header("accept", "application/octet-stream")
            .call()
            .map_err(|error| ClientError::Unreachable(format!("{url}: {error}")))?;
        response
            .body_mut()
            .read_to_vec()
            .map_err(|error| ClientError::Unreachable(format!("{url}: {error}")))
    }

    fn post(&self, path: &str, body: &[u8]) -> Result<Vec<u8>, ClientError> {
        let url = format!("{}{path}", self.base);
        let mut response = self
            .agent
            .post(&url)
            .header("content-type", "application/octet-stream")
            .header("accept", "application/octet-stream")
            .send(body)
            .map_err(|error| ClientError::Unreachable(format!("{url}: {error}")))?;
        response
            .body_mut()
            .read_to_vec()
            .map_err(|error| ClientError::Unreachable(format!("{url}: {error}")))
    }
}

#[cfg(feature = "http")]
impl Transport for HttpTransport {
    fn latest_sth(&self) -> Result<Vec<u8>, ClientError> {
        self.get(crate::wire::PATH_STH)
    }

    fn sth_at(&self, epoch: u64) -> Result<Vec<u8>, ClientError> {
        self.get(&format!("{}/{epoch}", crate::wire::PATH_STH))
    }

    fn lookup(&self, request: &[u8]) -> Result<Vec<u8>, ClientError> {
        self.post(crate::wire::PATH_LOOKUP, request)
    }

    fn history(&self, request: &[u8]) -> Result<Vec<u8>, ClientError> {
        self.post(crate::wire::PATH_HISTORY, request)
    }

    fn authority_policy(&self) -> Result<Vec<u8>, ClientError> {
        self.get(crate::wire::PATH_AUTHORITY)
    }

    fn descriptor(&self) -> Result<Vec<u8>, ClientError> {
        self.get(crate::wire::PATH_DESCRIPTOR)
    }
}

#[cfg(all(test, feature = "http"))]
mod tests {
    use super::HttpTransport;

    #[test]
    fn a_cleartext_log_url_is_refused_by_default() {
        let error = HttpTransport::new("http://kt.example", core::time::Duration::from_secs(5))
            .unwrap_err();
        assert!(format!("{error}").contains("HTTPS"));
    }

    #[test]
    fn the_loopback_escape_hatch_is_a_separate_function_and_is_visible_at_the_call_site() {
        assert!(
            HttpTransport::insecure_loopback(
                "http://127.0.0.1:8443",
                core::time::Duration::from_secs(5)
            )
            .is_ok()
        );
        assert!(
            HttpTransport::insecure_loopback("ftp://nope", core::time::Duration::from_secs(5))
                .is_err()
        );
    }

    #[test]
    fn the_debug_rendering_of_a_transport_is_a_base_url_and_nothing_else() {
        let transport =
            HttpTransport::new("https://kt.example/", core::time::Duration::from_secs(5)).unwrap();
        assert_eq!(
            format!("{transport:?}"),
            "HttpTransport { base: \"https://kt.example\", .. }"
        );
    }
}

/// A [`Transport`] with no socket behind it.
///
/// **This is the browser's constructor, not a stub.** `wasm32-unknown-unknown`
/// cannot host a blocking HTTP client, and the module note above says why this
/// crate does not ship an async trait to accommodate one. What a WASM binding
/// does instead is drive `fetch` in JavaScript, `await` it there, and hand the
/// bytes to a client built over this — every verification that follows is the
/// same code the native build runs.
///
/// Every method refuses, with a message that says what the caller should be
/// doing, because a `Detached` client that silently answered would be worse
/// than one that does not answer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Detached;

impl Detached {
    /// The refusal every method returns.
    fn refuse(what: &str) -> ClientError {
        ClientError::Unreachable(format!(
            "this client is detached and has no transport; fetch {what} yourself and hand the \
             bytes to the verifier"
        ))
    }
}

impl Transport for Detached {
    fn latest_sth(&self) -> Result<Vec<u8>, ClientError> {
        Err(Self::refuse("GET /kt/v1/sth"))
    }

    fn sth_at(&self, epoch: u64) -> Result<Vec<u8>, ClientError> {
        Err(Self::refuse(&format!("GET /kt/v1/sth/{epoch}")))
    }

    fn lookup(&self, _request: &[u8]) -> Result<Vec<u8>, ClientError> {
        Err(Self::refuse("POST /kt/v1/lookup"))
    }

    fn history(&self, _request: &[u8]) -> Result<Vec<u8>, ClientError> {
        Err(Self::refuse("POST /kt/v1/history"))
    }

    fn authority_policy(&self) -> Result<Vec<u8>, ClientError> {
        Err(Self::refuse("GET /.well-known/free2z-kt/v1/authority"))
    }

    fn descriptor(&self) -> Result<Vec<u8>, ClientError> {
        Err(Self::refuse("GET /.well-known/free2z-kt/v1/log"))
    }
}
