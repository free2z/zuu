//! Buying 2Z (`docs/sdk/spec/purchase.md`): create a purchase intent, open
//! the surface its rail returns, poll until it settles.
//!
//! The app never handles a payment. For a card, it opens the intent's
//! [`PurchaseIntent::checkout_url`] in the system browser (desktop) or the
//! platform's browser surface (iOS, Android) and then polls with
//! [`Client::wait_for_purchase`]. **The return redirect is a convenience,
//! not the signal**: the platform credits from the processor's webhook, so a
//! user who closes the browser early is still credited, and the poll sees it.
//! [`ReturnListener`] is the loopback helper for a desktop `return_url`.
//!
//! 2Z are platform credits, not money.

use std::time::{Duration, Instant};

use f2z_ai_proto::{Milli2z, Whole2z};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use url::Url;

use crate::client::Client;
use crate::error::Error;
use crate::http;
use crate::oauth::Listener;
use crate::random;

/// How a purchase is paid.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rail {
    /// A card, on the processor's hosted checkout.
    Card,
    /// Zcash, to a per-intent address (not yet offered by the platform).
    Zcash,
    /// Apple in-app purchase — Free2Z's own apps only.
    AppleIap,
    /// Google Play Billing — Free2Z's own apps only.
    GoogleIap,
    /// A rail newer than this SDK. Deserialization only.
    #[serde(other)]
    Unknown,
}

/// The platform the purchase surface is for (it decides what `rail_data`
/// holds).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    /// macOS, Windows, Linux.
    Desktop,
    /// iOS and iPadOS.
    Ios,
    /// Android.
    Android,
    /// A browser page.
    Web,
}

/// Where an intent is (§1.2).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PurchaseStatus {
    /// Exists; no payment surface opened yet.
    Created,
    /// Waiting for the user to pay.
    Pending,
    /// Payment observed, not yet credited.
    Paid,
    /// The 2Z are on the balance.
    Credited,
    /// Nothing was paid before `expires_at`.
    Expired,
    /// The payment failed or was cancelled.
    Failed,
    /// Refunded in full after crediting; the 2Z were taken back.
    Refunded,
    /// Refunded in part after crediting.
    PartiallyRefunded,
    /// Under dispute after crediting.
    Disputed,
    /// The store revoked it after crediting.
    ClawedBack,
    /// A status newer than this SDK. Deserialization only.
    #[serde(other)]
    Unknown,
}

impl PurchaseStatus {
    /// Whether a client keeps polling (§1.3): `created`, `pending` and
    /// `paid` — a `paid` intent is polled past `expires_at` until it
    /// settles. Everything else is terminal *for the client*, including a
    /// status newer than this SDK, so a poll can never run forever on one.
    #[must_use]
    pub fn is_in_progress(self) -> bool {
        matches!(self, Self::Created | Self::Pending | Self::Paid)
    }
}

/// A price in minor units of a currency: `499` `USD` is $4.99.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Price {
    /// ISO 4217, upper case.
    pub currency: String,
    /// Minor units.
    pub amount_minor: u64,
}

/// A purchase intent (§1.2). Unknown fields are ignored.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PurchaseIntent {
    /// The intent's id.
    pub id: String,
    /// How it is paid.
    pub rail: Rail,
    /// Where it is.
    pub status: PurchaseStatus,
    /// The 2Z bought.
    pub quantity_2z: Whole2z,
    /// What it costs.
    pub price: Price,
    /// The price list it was created under.
    #[serde(default)]
    pub pricing_version: Option<String>,
    /// RFC 3339.
    #[serde(default)]
    pub created_at: Option<String>,
    /// RFC 3339.
    #[serde(default)]
    pub expires_at: Option<String>,
    /// RFC 3339, once credited.
    #[serde(default)]
    pub credited_at: Option<String>,
    /// What reached the balance, once credited. May differ from
    /// `quantity_2z` on the Zcash rail.
    #[serde(default)]
    pub credited_milli_2z: Option<Milli2z>,
    /// Rail-specific: for a card, `checkout_url`.
    #[serde(default)]
    pub rail_data: Map<String, Value>,
}

impl PurchaseIntent {
    /// The hosted checkout page of a card intent, when it is an `https` URL.
    /// Open it in the system browser; never in an embedded web view.
    #[must_use]
    pub fn checkout_url(&self) -> Option<&str> {
        let url = self.rail_data.get("checkout_url")?.as_str()?;
        Url::parse(url)
            .ok()
            .filter(|u| u.scheme() == "https")
            .map(|_| url)
    }
}

/// `POST /purchases` (§2).
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurchaseRequest {
    /// How it will be paid.
    pub rail: Rail,
    /// Whole 2Z. Card: 100 to 10,000.
    pub quantity_2z: Whole2z,
    /// Which surface to return.
    pub platform: Platform,
    /// Card only, and required for it: where the checkout sends the browser
    /// afterwards — a loopback URI ([`ReturnListener::return_url`]) or one of
    /// the app's registered `https` redirect URIs. No query string.
    pub return_url: Option<String>,
    /// The `Idempotency-Key`. Generated when `None`. Supply your own (and
    /// keep it) to make "create" safe to repeat across an app restart.
    pub idempotency_key: Option<String>,
}

impl PurchaseRequest {
    /// A card purchase.
    #[must_use]
    pub fn card(quantity_2z: Whole2z, platform: Platform, return_url: impl Into<String>) -> Self {
        Self {
            rail: Rail::Card,
            quantity_2z,
            platform,
            return_url: Some(return_url.into()),
            idempotency_key: None,
        }
    }

    /// With a caller-chosen `Idempotency-Key` (1–128 printable ASCII).
    #[must_use]
    pub fn with_idempotency_key(mut self, key: impl Into<String>) -> Self {
        self.idempotency_key = Some(key.into());
        self
    }
}

#[derive(Serialize)]
struct CreateBody<'a> {
    rail: Rail,
    quantity_2z: Whole2z,
    platform: Platform,
    #[serde(skip_serializing_if = "Option::is_none")]
    return_url: Option<&'a str>,
}

/// How long [`Client::wait_for_purchase`] polls.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PollOptions {
    /// Give up after this long and return the last intent seen.
    pub max_wait: Duration,
}

impl Default for PollOptions {
    fn default() -> Self {
        Self {
            max_wait: Duration::from_secs(30 * 60),
        }
    }
}

impl PollOptions {
    /// Poll for at most `max_wait`.
    #[must_use]
    pub fn max_wait(max_wait: Duration) -> Self {
        Self { max_wait }
    }
}

/// The §1.3 schedule: 2 s, 4 s, 8 s, then every 15 s.
fn poll_delay(attempt: u32) -> Duration {
    match attempt {
        0 => Duration::from_secs(2),
        1 => Duration::from_secs(4),
        2 => Duration::from_secs(8),
        _ => Duration::from_secs(15),
    }
}

/// Re-sends of a create that got no response, with the **same** key.
const CREATE_TRANSPORT_RETRIES: u32 = 2;
/// Re-sends while the server reports the original is still in flight.
const CREATE_IN_FLIGHT_RETRIES: u32 = 4;

impl Client {
    /// Create a purchase intent (§2). Needs `purchase:create`.
    ///
    /// The request carries an `Idempotency-Key`, and every re-send of it
    /// uses the **same** key — after a network failure, or while the server
    /// says the original is still in flight — so the server replays the one
    /// intent instead of opening a second checkout.
    ///
    /// # Errors
    ///
    /// [`Error::Api`] with the envelope: `invalid_quantity` (with
    /// `details.min_2z` / `max_2z`), `rail_unavailable`, `invalid_request`,
    /// `idempotency_conflict`.
    pub async fn create_purchase(
        &self,
        request: &PurchaseRequest,
    ) -> Result<PurchaseIntent, Error> {
        let key = match &request.idempotency_key {
            Some(k)
                if (1..=128).contains(&k.len())
                    && k.bytes().all(|b| (0x21..=0x7e).contains(&b)) =>
            {
                k.clone()
            }
            Some(_) => {
                return Err(Error::Config(
                    "an Idempotency-Key is 1-128 printable ASCII characters".into(),
                ));
            }
            None => random::uuid_v4()?,
        };
        let body = serde_json::to_vec(&CreateBody {
            rail: request.rail,
            quantity_2z: request.quantity_2z,
            platform: request.platform,
            return_url: request.return_url.as_deref(),
        })
        .map_err(|e| Error::Internal(e.to_string()))?;
        let url = format!("{}/purchases", self.inner.config.api_base);
        let timeout = self.inner.config.request_timeout;

        let (mut transport_left, mut in_flight_left) =
            (CREATE_TRANSPORT_RETRIES, CREATE_IN_FLIGHT_RETRIES);
        let mut delay = Duration::from_secs(1);
        // Every re-send acts as the user the purchase was started for.
        let mut session = None;
        loop {
            let sent = self
                .send_authorized_in(&mut session, |http, token| {
                    http.post(&url)
                        .bearer_auth(token)
                        .header("Idempotency-Key", &key)
                        .header(reqwest::header::CONTENT_TYPE, "application/json")
                        .timeout(timeout)
                        .body(body.clone())
                })
                .await;
            let response = match sent {
                // No response at all: the request may or may not have
                // reached the server, so re-send it with the SAME key.
                Err(Error::Transport(_)) if transport_left > 0 => {
                    transport_left = transport_left.saturating_sub(1);
                    tokio::time::sleep(delay).await;
                    delay = delay.saturating_mul(2);
                    continue;
                }
                other => other?,
            };
            if response.status().is_success() {
                return http::read_json(response).await;
            }
            let error = http::read_error(response).await;
            let in_flight = error.code == "idempotency_conflict"
                && error
                    .details
                    .as_ref()
                    .and_then(|d| d.get("in_flight"))
                    .and_then(Value::as_bool)
                    == Some(true);
            if in_flight && in_flight_left > 0 {
                in_flight_left = in_flight_left.saturating_sub(1);
                tokio::time::sleep(error.retry_after.unwrap_or(delay)).await;
                delay = delay.saturating_mul(2);
                continue;
            }
            return Err(Error::Api(Box::new(error)));
        }
    }

    /// `GET /purchases/{id}`: the intent as it is now.
    ///
    /// # Errors
    ///
    /// [`Error::Api`] (`404 purchase_not_found`, …).
    pub async fn purchase(&self, id: &str) -> Result<PurchaseIntent, Error> {
        Ok(self.purchase_with_hint(id).await?.0)
    }

    async fn purchase_with_hint(
        &self,
        id: &str,
    ) -> Result<(PurchaseIntent, Option<Duration>), Error> {
        let mut url = Url::parse(&self.inner.config.api_base)
            .map_err(|e| Error::Config(format!("api_base: {e}")))?;
        url.path_segments_mut()
            .map_err(|()| Error::Config("api_base cannot be a base".into()))?
            .extend(["purchases", id]);
        let timeout = self.inner.config.request_timeout;
        let response = self
            .send_authorized(|http, token| {
                http.get(url.clone()).bearer_auth(token).timeout(timeout)
            })
            .await?;
        let response = http::expect_success(response).await?;
        let hint = http::retry_after(response.headers());
        Ok((http::read_json(response).await?, hint))
    }

    /// Poll an intent (§1.3) — 2 s, 4 s, 8 s, then every 15 s, never sooner
    /// than the server's `Retry-After` — until it is no longer
    /// [`PurchaseStatus::is_in_progress`], or `options.max_wait` passes.
    /// Returns the last intent seen either way; check its `status`.
    ///
    /// Late success after the poll stops is still credited by the server:
    /// re-read [`Client::balance`] when the app returns to the foreground.
    ///
    /// # Errors
    ///
    /// As [`Client::purchase`]. A transport failure during the poll is
    /// retried on the schedule; it only surfaces if no intent was ever read.
    pub async fn wait_for_purchase(
        &self,
        id: &str,
        options: PollOptions,
    ) -> Result<PurchaseIntent, Error> {
        let deadline = Instant::now().checked_add(options.max_wait);
        let mut last: Option<PurchaseIntent> = None;
        let mut attempt = 0u32;
        loop {
            let hint = match self.purchase_with_hint(id).await {
                Ok((intent, hint)) => {
                    if !intent.status.is_in_progress() {
                        return Ok(intent);
                    }
                    last = Some(intent);
                    hint
                }
                Err(Error::Transport(_)) if last.is_some() => None,
                Err(e) => return Err(e),
            };
            let delay = poll_delay(attempt).max(hint.unwrap_or_default());
            attempt = attempt.saturating_add(1);
            let now = Instant::now();
            match deadline {
                Some(d) if now.checked_add(delay).is_none_or(|t| t > d) => {
                    return last.ok_or(Error::Timeout("the purchase"));
                }
                _ => tokio::time::sleep(delay).await,
            }
        }
    }
}

/// A loopback listener for a card checkout's `return_url` on desktop.
///
/// Bind it, pass [`ReturnListener::return_url`] in the [`PurchaseRequest`],
/// open the checkout, then [`ReturnListener::wait`] for the browser — and
/// poll the intent regardless: the redirect is a convenience, not the
/// signal.
#[derive(Debug)]
pub struct ReturnListener {
    listener: Listener,
}

/// What the checkout's redirect said. Informational: the intent's own
/// status is the truth.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PurchaseReturn {
    /// `purchase_id`, as the platform appended it.
    pub purchase_id: Option<String>,
    /// `status` (`success` or `cancel`).
    pub status: Option<String>,
}

impl ReturnListener {
    /// Bind `127.0.0.1:<random><path>`.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] for a bad path, [`Error::Browser`] if nothing can be
    /// bound.
    pub async fn bind(path: &str) -> Result<Self, Error> {
        Ok(Self {
            listener: Listener::bind(path).await?,
        })
    }

    /// The `return_url` to send.
    #[must_use]
    pub fn return_url(&self) -> String {
        self.listener.uri()
    }

    /// Wait up to `timeout` for the browser to come back.
    ///
    /// # Errors
    ///
    /// [`Error::Timeout`] when it does not.
    pub async fn wait(&self, timeout: Duration) -> Result<PurchaseReturn, Error> {
        let url = tokio::time::timeout(
            timeout,
            self.listener.next_callback(
                "Payment finished. You can close this window and return to the app.",
            ),
        )
        .await
        .map_err(|_| Error::Timeout("the checkout return"))??;
        let url = Url::parse(&url).map_err(|e| Error::Protocol(e.to_string()))?;
        let get = |name: &str| {
            url.query_pairs()
                .find(|(k, _)| k == name)
                .map(|(_, v)| v.into_owned())
        };
        Ok(PurchaseReturn {
            purchase_id: get("purchase_id"),
            status: get("status"),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_spec_intent_decodes_and_checkout_url_needs_https() {
        let intent: PurchaseIntent = serde_json::from_value(serde_json::json!({
            "id": "0f6e3b2a-7c1d-4e8f-9a0b-1c2d3e4f5a6b",
            "rail": "card", "status": "pending", "quantity_2z": 500,
            "price": {"currency": "USD", "amount_minor": 500},
            "pricing_version": "2026-09-01",
            "created_at": "2026-09-26T21:10:00Z", "expires_at": "2026-09-26T21:40:00Z",
            "credited_at": null, "credited_milli_2z": null,
            "rail_data": {"checkout_url": "https://checkout.stripe.com/c/pay/cs_x"},
            "a_future_field": true
        }))
        .unwrap();
        assert_eq!(
            intent.checkout_url(),
            Some("https://checkout.stripe.com/c/pay/cs_x")
        );
        assert!(intent.status.is_in_progress());

        let mut http_only = intent.clone();
        http_only
            .rail_data
            .insert("checkout_url".into(), "http://evil.example/".into());
        assert_eq!(http_only.checkout_url(), None);
    }

    #[test]
    fn unknown_statuses_stop_the_poll() {
        let s: PurchaseStatus = serde_json::from_str("\"something_new\"").unwrap();
        assert_eq!(s, PurchaseStatus::Unknown);
        assert!(!s.is_in_progress());
        assert!(PurchaseStatus::Paid.is_in_progress());
        assert!(!PurchaseStatus::Credited.is_in_progress());
    }

    #[test]
    fn schedule_matches_the_spec() {
        let secs: Vec<u64> = (0..5).map(|a| poll_delay(a).as_secs()).collect();
        assert_eq!(secs, [2, 4, 8, 15, 15]);
    }
}
