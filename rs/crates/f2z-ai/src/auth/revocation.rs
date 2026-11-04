//! Revocation: is the token's `aep` / `agen` still current? (oidc.md §6.2,
//! §6.3.) **Fails closed.**
//!
//! 1. Read both counters from the shared Redis the IdP publishes to
//!    ([`super::store::Store::counters`]).
//! 2. If either is absent or unreadable — a TTL lapse, a Redis outage, a value
//!    that is not a decimal integer — ask the IdP's internal epoch endpoint
//!    (`GET <endpoint><sub>/`, shared-secret bearer). Its contract, from
//!    `dj.apps.oidc.views.InternalEpochView`:
//!    * `200 {"sub", "aep", "agen": {client_id: generation}}` — `agen` lists
//!      **live** grants only, so a `client_id` absent from it is revoked;
//!    * `404` — no such subject: refuse;
//!    * `503`, anything else, or no answer — **unknown**.
//! 3. The token's value below the current one → [`Verdict::Revoked`];
//!    unknown → [`Verdict::Unknown`], which the caller answers with
//!    `503 unavailable`, `reason: revocation_check`, never with "allow".
//!
//! A token *ahead* of the published value is accepted: the IdP only mints
//! the current value, so "ahead" is a publication that has not landed yet.
//!
//! The endpoint is a fallback, and a Redis outage would otherwise send every
//! request to it at once, so at most [`MAX_ENDPOINT_IN_FLIGHT`] calls are in
//! flight per gateway; beyond that the answer is unknown (`503`), which the
//! client retries.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use reqwest::{Client, Url};
use secrecy::{ExposeSecret as _, SecretString};
use serde::Deserialize;
use tokio::sync::Semaphore;

use super::jwt::Claims;
use super::store::Store;

/// Concurrent calls to the internal epoch endpoint, per gateway.
pub const MAX_ENDPOINT_IN_FLIGHT: usize = 64;
/// The most of an epoch answer read.
pub const MAX_ANSWER_BYTES: usize = 64 * 1024;

/// What the check concluded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Both counters are current.
    Current,
    /// Refuse with `401 token_revoked` and this `details.reason`.
    Revoked(&'static str),
    /// The state could not be determined: `503 unavailable`.
    Unknown,
}

/// errors.md §2: `token_revoked` reasons.
pub const ACCOUNT_EPOCH: &str = "account_epoch";
/// errors.md §2: `token_revoked` reasons.
pub const GRANT_GENERATION: &str = "grant_generation";

/// What the internal epoch endpoint said.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EpochAnswer {
    /// `200`: the account epoch and every **live** grant's generation.
    Current {
        /// The account epoch.
        aep: u64,
        /// `client_id` → generation, live grants only.
        agen: HashMap<String, u64>,
    },
    /// `404`: no such subject.
    NoSubject,
    /// Anything else.
    Unknown,
}

/// Where the fallback answer comes from.
#[async_trait]
pub trait EpochSource: Send + Sync + 'static {
    /// The current counters for `sub`.
    async fn current(&self, sub: &str) -> EpochAnswer;
}

/// The IdP's internal epoch endpoint over HTTP.
pub struct HttpEpochSource {
    client: Client,
    base: Url,
    token: SecretString,
    timeout: Duration,
}

impl std::fmt::Debug for HttpEpochSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpEpochSource")
            .field("base", &self.base.as_str())
            .finish_non_exhaustive()
    }
}

impl HttpEpochSource {
    /// `base` ends in `/` (`…/api/oauth/internal/epoch/`); the subject and a
    /// trailing `/` are appended.
    #[must_use]
    pub const fn new(client: Client, base: Url, token: SecretString, timeout: Duration) -> Self {
        Self {
            client,
            base,
            token,
            timeout,
        }
    }
}

#[derive(Deserialize)]
struct Answer {
    sub: String,
    aep: u64,
    agen: HashMap<String, u64>,
}

#[async_trait]
impl EpochSource for HttpEpochSource {
    async fn current(&self, sub: &str) -> EpochAnswer {
        // `sub` is a canonical UUID (`jwt::check_claims`), so joining it
        // cannot escape the path.
        let Ok(url) = self.base.join(&format!("{sub}/")) else {
            return EpochAnswer::Unknown;
        };
        let Ok(mut authorization) = reqwest::header::HeaderValue::from_str(&format!(
            "Bearer {}",
            self.token.expose_secret()
        )) else {
            return EpochAnswer::Unknown;
        };
        authorization.set_sensitive(true);
        let fetch = async {
            let mut response = self
                .client
                .get(url)
                .header(reqwest::header::AUTHORIZATION, authorization)
                .send()
                .await
                .ok()?;
            match response.status().as_u16() {
                200 => {}
                404 => return Some(EpochAnswer::NoSubject),
                status => {
                    tracing::warn!(status, "internal epoch endpoint did not answer 200");
                    return Some(EpochAnswer::Unknown);
                }
            }
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.ok()? {
                if body.len().saturating_add(chunk.len()) > MAX_ANSWER_BYTES {
                    return Some(EpochAnswer::Unknown);
                }
                body.extend_from_slice(&chunk);
            }
            let answer: Answer = serde_json::from_slice(&body).ok()?;
            if answer.sub != sub {
                tracing::error!("internal epoch endpoint answered for another subject");
                return Some(EpochAnswer::Unknown);
            }
            Some(EpochAnswer::Current {
                aep: answer.aep,
                agen: answer.agen,
            })
        };
        match tokio::time::timeout(self.timeout, fetch).await {
            Ok(Some(answer)) => answer,
            Ok(None) => {
                tracing::warn!("internal epoch endpoint unreachable or answered garbage");
                EpochAnswer::Unknown
            }
            Err(_) => {
                tracing::warn!("internal epoch endpoint timed out");
                EpochAnswer::Unknown
            }
        }
    }
}

/// The revocation check.
pub struct Revocation {
    store: Option<Arc<dyn Store>>,
    namespace: String,
    endpoint: Option<Arc<dyn EpochSource>>,
    in_flight: Arc<Semaphore>,
}

impl std::fmt::Debug for Revocation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Revocation")
            .field("namespace", &self.namespace)
            .field("store", &self.store.is_some())
            .field("endpoint", &self.endpoint.is_some())
            .finish()
    }
}

/// `<ns>:aep:<sub>` — `dj.apps.oidc.epoch_publish.account_epoch_key`.
#[must_use]
pub fn account_epoch_key(namespace: &str, sub: &str) -> String {
    format!("{namespace}:aep:{sub}")
}

/// `<ns>:agen:<client_id>:<sub>` —
/// `dj.apps.oidc.epoch_publish.grant_generation_key`.
#[must_use]
pub fn grant_generation_key(namespace: &str, client_id: &str, sub: &str) -> String {
    format!("{namespace}:agen:{client_id}:{sub}")
}

/// A published counter: a plain decimal string, as `epoch_publish` writes it.
fn counter(value: Option<&str>) -> Option<u64> {
    let text = value?;
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

fn compare(claims: &Claims, aep: u64, agen: u64) -> Verdict {
    if claims.aep < aep {
        Verdict::Revoked(ACCOUNT_EPOCH)
    } else if claims.agen < agen {
        Verdict::Revoked(GRANT_GENERATION)
    } else {
        Verdict::Current
    }
}

impl Revocation {
    /// A check reading `store` under `namespace`, falling back to `endpoint`.
    /// With neither, every answer is [`Verdict::Unknown`].
    #[must_use]
    pub fn new(
        store: Option<Arc<dyn Store>>,
        namespace: String,
        endpoint: Option<Arc<dyn EpochSource>>,
    ) -> Self {
        Self {
            store,
            namespace,
            endpoint,
            in_flight: Arc::new(Semaphore::new(MAX_ENDPOINT_IN_FLIGHT)),
        }
    }

    /// Check `claims`.
    pub async fn check(&self, claims: &Claims) -> Verdict {
        if let Some(store) = &self.store {
            let aep_key = account_epoch_key(&self.namespace, &claims.sub);
            let agen_key = grant_generation_key(&self.namespace, &claims.client_id, &claims.sub);
            if let Ok([aep, agen]) = store.counters([&aep_key, &agen_key]).await
                && let (Some(aep), Some(agen)) = (counter(aep.as_deref()), counter(agen.as_deref()))
            {
                return compare(claims, aep, agen);
            }
        }
        let Some(endpoint) = &self.endpoint else {
            return Verdict::Unknown;
        };
        let Ok(_permit) = self.in_flight.try_acquire() else {
            tracing::warn!("internal epoch endpoint: too many checks in flight; failing closed");
            return Verdict::Unknown;
        };
        match endpoint.current(&claims.sub).await {
            EpochAnswer::Current { aep, agen } => match agen.get(&claims.client_id) {
                Some(generation) => compare(claims, aep, *generation),
                // Live grants only: absent is revoked, not unknown.
                None if claims.aep < aep => Verdict::Revoked(ACCOUNT_EPOCH),
                None => Verdict::Revoked(GRANT_GENERATION),
            },
            EpochAnswer::NoSubject => Verdict::Revoked(ACCOUNT_EPOCH),
            EpochAnswer::Unknown => Verdict::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_counter_is_a_plain_decimal_string() {
        assert_eq!(counter(Some("4")), Some(4));
        assert_eq!(counter(Some("0012")), Some(12));
        for bad in ["", "-1", "+1", "1.0", " 1", "1e3", "x"] {
            assert_eq!(counter(Some(bad)), None, "{bad}");
        }
        assert_eq!(counter(None), None);
    }

    #[test]
    fn keys_match_epoch_publish() {
        assert_eq!(account_epoch_key("free2z", "s"), "free2z:aep:s");
        assert_eq!(
            grant_generation_key("free2z", "app_1", "s"),
            "free2z:agen:app_1:s"
        );
    }
}
