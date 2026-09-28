//! Readiness is a verified, unexpired catalogue. The source is a trait.
//!
//! `docs/free2z/ai-gateway/README.md`: *the gateway prices nothing it did not read
//! from a signed catalogue … No verified, unexpired catalogue means the
//! process does not report ready.* This module holds that rule and the two
//! that come with it — a running gateway does not replace a catalogue with a
//! lower `version` (with one bounded exception, below), and a catalogue is
//! checked against the clock every time it is read, not only when it was
//! fetched.
//!
//! # A lower version, legitimately (zuu#1067)
//!
//! The platform derives `version` from timestamps (tuzi #2235,
//! `dj.apps.pricing.catalog`): `version` is Unix **microseconds** — the later
//! of the current one-minute re-issue window and the newest content
//! revision — and `issued_at = version / 1_000_000`. So `issued_at` always
//! moves **with** `version`: a lower version always has an equal-or-older
//! `issued_at`. And `version` is not strictly monotone: deleting the model
//! with the newest `updated_at`, two publisher pods straddling a minute, or a
//! writer's clock up to 5 minutes ahead each make a later catalogue carry a
//! lower version. The producer bounds that dip at
//! `VERSION_REGRESSION_BOUND_SECONDS` = 2 × 60 s + 300 s = **420 s**, and
//! [`DEFAULT_VERSION_REGRESSION_BOUND_SECS`] restates it (configurable as
//! `catalog_version_regression_bound_secs`).
//!
//! The rule, over **issue floor** = the newest `issued_at` this process has
//! installed, minus the bound:
//!
//! * a higher version is installed (as before);
//! * the same version is `Unchanged`;
//! * a lower version is installed iff its `issued_at` is at or above the
//!   floor — within the bound of the newest catalogue seen, not merely of the
//!   one held, so two catalogues cannot trade places for longer than the
//!   bound: once a newer one arrives the floor moves past the older — **and**
//!   within the bound of now, since a legitimate dip is always fresh, so a
//!   stale source replaying a superseded catalogue hours later is refused
//!   even if nothing newer was installed meanwhile;
//! * anything below the floor is a **replay**: the held copy stays, and the
//!   refusal is logged and counted (`f2z_ai_catalog_replays_total`), which is
//!   the series to alert on. A legitimate regression never increments it.
//!
//! What this gives up is bounded by the same 420 s: a replay of a catalogue
//! issued within the bound of the newest one can be installed. Signature and
//! expiry checks are unchanged and happen before any of this.
//!
//! [`HttpSource`] fetches and verifies a bounded signed envelope against
//! startup trust anchors. [`Unconfigured`] keeps diagnostic/test deployments
//! closed until configured; production wiring lives in the binary.

use std::sync::{Arc, RwLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use f2z_ai_proto::catalog::Catalog;
use tokio::sync::watch;

use crate::metrics::Metrics;

/// A catalogue whose signature a [`CatalogSource`] has verified.
///
/// There is no way to obtain one from an unverified [`Catalog`] other than
/// [`VerifiedCatalog::from_verified`], which is the one line a reviewer of a
/// new source has to look at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedCatalog(Catalog);

impl VerifiedCatalog {
    /// Wrap `catalog`, which the caller has verified.
    ///
    /// Runs [`Catalog::validate`] — a signature proves a catalogue authentic,
    /// not sane.
    ///
    /// # Errors
    ///
    /// The validation failure.
    pub fn from_verified(catalog: Catalog) -> Result<Self, String> {
        catalog.validate().map_err(|e| e.to_string())?;
        Ok(Self(catalog))
    }

    /// The catalogue.
    #[must_use]
    pub const fn catalog(&self) -> &Catalog {
        &self.0
    }
}

/// Where catalogues come from.
#[async_trait]
pub trait CatalogSource: Send + Sync + 'static {
    /// Fetch and verify the current catalogue.
    ///
    /// # Errors
    ///
    /// A human-readable reason, logged at `warn`. It must not contain a
    /// credential.
    async fn fetch(&self) -> Result<VerifiedCatalog, String>;
}

/// The binary's source in this build: none. See the module docs.
#[derive(Clone, Copy, Debug, Default)]
pub struct Unconfigured;

#[async_trait]
impl CatalogSource for Unconfigured {
    async fn fetch(&self) -> Result<VerifiedCatalog, String> {
        Err("no catalogue source is configured".to_owned())
    }
}

/// HTTPS catalogue source. Trust anchors come exclusively from startup configuration.
pub struct HttpSource {
    client: reqwest::Client,
    url: reqwest::Url,
    keys: Vec<f2z_ai_proto::catalog::TrustedKey>,
}

impl HttpSource {
    /// Construct a bounded, redirect-free source without ambient proxy credentials.
    pub fn new(
        url: &str,
        keys: &std::collections::BTreeMap<String, String>,
    ) -> Result<Self, String> {
        let url = reqwest::Url::parse(url).map_err(|_| "invalid catalogue URL")?;
        let loopback = url.host_str().is_some_and(|h| {
            h == "localhost"
                || h.parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if !(url.scheme() == "https" || (url.scheme() == "http" && loopback))
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("catalogue URL must be HTTPS without credentials or fragment".into());
        }
        if keys.is_empty() || keys.len() > 16 {
            return Err("configure 1..=16 catalogue trust anchors".into());
        }
        let keys = keys
            .iter()
            .map(|(id, hex)| {
                f2z_ai_proto::catalog::TrustedKey::from_hex(id, hex)
                    .map_err(|_| "invalid catalogue trust anchor".to_owned())
            })
            .collect::<Result<_, _>>()?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "catalogue HTTP client")?;
        Ok(Self { client, url, keys })
    }

    fn verify(&self, bytes: &[u8]) -> Result<VerifiedCatalog, String> {
        // Strictly parse the WHOLE envelope before extracting the payload: ordinary
        // Value deserialization would silently discard duplicate catalogue members.
        let envelope = f2z_ai_proto::canonical::parse_strict(bytes)
            .map_err(|_| "invalid catalogue envelope")?;
        let payload = envelope.get("catalog").ok_or("missing catalogue")?;
        let signature = envelope
            .get("signature")
            .ok_or("missing catalogue signature")?;
        let id = signature
            .get("key_id")
            .and_then(serde_json::Value::as_str)
            .ok_or("missing signature key")?;
        let hex = signature
            .get("signature_hex")
            .and_then(serde_json::Value::as_str)
            .ok_or("missing signature bytes")?;
        let signature = f2z_ai_proto::catalog::DetachedSignature::from_hex(id, hex)
            .map_err(|_| "invalid signature encoding")?;
        let payload = serde_json::to_vec(payload).map_err(|_| "invalid catalogue payload")?;
        let catalog =
            f2z_ai_proto::catalog::verify_catalog(&payload, &signature, &self.keys, now_unix())
                .map_err(|_| "catalogue verification refused")?;
        VerifiedCatalog::from_verified(catalog)
    }
}

#[async_trait]
impl CatalogSource for HttpSource {
    async fn fetch(&self) -> Result<VerifiedCatalog, String> {
        let mut response = self
            .client
            .get(self.url.clone())
            .send()
            .await
            .map_err(|_| "catalogue fetch failed")?;
        if response.status() != reqwest::StatusCode::OK {
            return Err("catalogue endpoint refused".into());
        }
        const MAX: usize = 1024 * 1024;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "catalogue body failed")?
        {
            if bytes.len().saturating_add(chunk.len()) > MAX {
                return Err("catalogue exceeds byte limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        self.verify(&bytes)
    }
}

/// A fixed catalogue, for tests and local development. It performs no
/// verification of its own: whoever constructs the [`VerifiedCatalog`] did.
#[derive(Clone, Debug)]
pub struct Fixed(pub VerifiedCatalog);

#[async_trait]
impl CatalogSource for Fixed {
    async fn fetch(&self) -> Result<VerifiedCatalog, String> {
        Ok(self.0.clone())
    }
}

/// Unix seconds now. A clock that reads before 1970 reads as 0 — a broken
/// host clock, which the platform's node time sync is responsible for; the
/// verifying source additionally refuses by `verify_catalog`'s own
/// expiry check.
#[must_use]
pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// How far (seconds of `issued_at`) below the newest catalogue installed a
/// lower version may be and still be installed (zuu#1067): tuzi's
/// `dj.apps.pricing.catalog.VERSION_REGRESSION_BOUND_SECONDS`
/// (`2 * REISSUE_SECONDS + FUTURE_REVISION_TOLERANCE_SECONDS`).
pub const DEFAULT_VERSION_REGRESSION_BOUND_SECS: u64 = 420;

/// What [`State::install`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Installed {
    /// It is now the catalogue in use.
    Replaced,
    /// Same version as the one in use; nothing changed.
    Unchanged,
    /// Lower version than the one in use: refused (a replay).
    Older,
    /// Already expired at `now`.
    Expired,
}

/// The catalogue in use.
#[derive(Debug)]
pub struct State {
    current: RwLock<Option<Arc<VerifiedCatalog>>>,
    /// The newest `issued_at` ever installed. Only rises.
    newest_issued: std::sync::atomic::AtomicU64,
    /// [`DEFAULT_VERSION_REGRESSION_BOUND_SECS`] unless configured.
    regression_bound: u64,
}

impl Default for State {
    fn default() -> Self {
        Self::new(DEFAULT_VERSION_REGRESSION_BOUND_SECS)
    }
}

impl State {
    /// A state accepting version regressions within `regression_bound`
    /// seconds of `issued_at` (see the module docs).
    #[must_use]
    pub const fn new(regression_bound: u64) -> Self {
        Self {
            current: RwLock::new(None),
            newest_issued: std::sync::atomic::AtomicU64::new(0),
            regression_bound,
        }
    }

    /// The catalogue to price with at `now`, if one is loaded and unexpired.
    #[must_use]
    pub fn current(&self, now: u64) -> Option<Arc<VerifiedCatalog>> {
        let guard = self.current.read().unwrap_or_else(|p| p.into_inner());
        guard
            .as_ref()
            .filter(|c| now < c.catalog().expires_at)
            .map(Arc::clone)
    }

    /// Offer `candidate` at `now`.
    pub fn install(&self, candidate: VerifiedCatalog, now: u64) -> Installed {
        if now >= candidate.catalog().expires_at {
            return Installed::Expired;
        }
        let mut guard = self.current.write().unwrap_or_else(|p| p.into_inner());
        let offered = candidate.catalog();
        if let Some(existing) = guard.as_ref() {
            let held = existing.catalog();
            if offered.version == held.version {
                return Installed::Unchanged;
            }
            let floor = self
                .newest_issued
                .load(std::sync::atomic::Ordering::SeqCst)
                .saturating_sub(self.regression_bound);
            if offered.issued_at < floor {
                return Installed::Older;
            }
            // A lower version is a *fresh* dip or nothing: the producer's
            // versions are never older than its current window, so a
            // legitimately lower one is issued within the bound of now.
            // Without this, a stale cache replaying a superseded catalogue
            // hours later would still clear a floor that only moves on
            // installs (codex).
            if offered.version < held.version
                && offered.issued_at < now.saturating_sub(self.regression_bound)
            {
                return Installed::Older;
            }
            if offered.version < held.version {
                tracing::info!(
                    held = held.version,
                    offered = offered.version,
                    "installing a lower catalogue version within the platform's regression bound \
                     (zuu#1067)"
                );
            }
        }
        self.newest_issued
            .fetch_max(offered.issued_at, std::sync::atomic::Ordering::SeqCst);
        *guard = Some(Arc::new(candidate));
        Installed::Replaced
    }
}

/// Poll `source` every `interval` until `stop`, installing what it returns.
pub(crate) async fn poll(
    source: Arc<dyn CatalogSource>,
    state: Arc<State>,
    metrics: Arc<Metrics>,
    interval: Duration,
    stop: watch::Receiver<bool>,
) {
    poll_with_clock(source, state, metrics, interval, stop, now_unix).await;
}

// Keep the production clock unchanged while making exact age-boundary tests
// independent of a wall-clock tick between fetching and installing an offer.
async fn poll_with_clock(
    source: Arc<dyn CatalogSource>,
    state: Arc<State>,
    metrics: Arc<Metrics>,
    interval: Duration,
    mut stop: watch::Receiver<bool>,
    now: impl Fn() -> u64,
) {
    loop {
        // A fetch is bounded by the poll interval and interrupted by shutdown:
        // a source that hangs must neither stop the refresh loop for good nor
        // hold the process at SIGTERM.
        let fetched = tokio::select! {
            fetched = tokio::time::timeout(interval, source.fetch()) => fetched
                .unwrap_or_else(|_| Err("catalogue fetch timed out".to_owned())),
            () = crate::shutdown::raised(&mut stop) => return,
        };
        match fetched {
            Ok(candidate) => {
                let version = candidate.catalog().version;
                match state.install(candidate, now()) {
                    Installed::Replaced => {
                        tracing::info!(version, "verified catalogue installed");
                        metrics.set_catalog_version(version);
                    }
                    Installed::Unchanged => {}
                    Installed::Older => {
                        metrics.record_catalog_replay();
                        tracing::warn!(
                            version,
                            "refused a catalogue older than the one in use (replay?)"
                        );
                    }
                    Installed::Expired => {
                        tracing::warn!(version, "refused an expired catalogue");
                    }
                }
            }
            Err(reason) => tracing::warn!(%reason, "catalogue fetch failed"),
        }
        if state.current(now()).is_none() {
            metrics.set_catalog_version(0);
        }
        tokio::select! {
            () = tokio::time::sleep(interval) => {}
            () = crate::shutdown::raised(&mut stop) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const US: u64 = 1_000_000;

    /// A catalogue shaped as tuzi's producer mints it: `version` in
    /// microseconds, `issued_at = version / 1_000_000`, 72 h validity.
    fn produced(version: u64) -> VerifiedCatalog {
        let text = include_str!("../../f2z-ai-proto/fixtures/catalog/catalog.json");
        let mut c: Catalog = serde_json::from_str(text).unwrap();
        c.version = version;
        c.issued_at = version / US;
        c.expires_at = c.issued_at + 72 * 3600;
        VerifiedCatalog::from_verified(c).unwrap()
    }

    fn catalog(version: u64, expires_at: u64) -> VerifiedCatalog {
        let mut c = produced(version).catalog().clone();
        c.issued_at = 1;
        c.expires_at = expires_at;
        VerifiedCatalog::from_verified(c).unwrap()
    }

    /// A minute-window start, in producer units.
    const T: u64 = 1_790_000_040;

    #[test]
    fn higher_wins_equal_is_unchanged() {
        let state = State::default();
        assert_eq!(state.install(produced(T * US), T), Installed::Replaced);
        assert_eq!(state.install(produced(T * US), T), Installed::Unchanged);
        assert_eq!(
            state.install(produced((T + 60) * US), T + 60),
            Installed::Replaced
        );
        assert_eq!(
            state.current(T + 60).unwrap().catalog().version,
            (T + 60) * US
        );
    }

    #[test]
    fn the_three_documented_regressions_are_installed_and_not_counted() {
        // (a) The newest model is deleted: the revision drops back to the
        //     window start (the held copy carried a revision 37.5 s into it).
        let state = State::default();
        assert_eq!(
            state.install(produced(T * US + 37_500_000), T + 38),
            Installed::Replaced
        );
        assert_eq!(state.install(produced(T * US), T + 39), Installed::Replaced);
        assert_eq!(state.current(T + 39).unwrap().catalog().version, T * US);

        // (b) Two pods straddling a minute: the next window, then this one.
        let state = State::default();
        assert_eq!(
            state.install(produced((T + 60) * US), T + 60),
            Installed::Replaced
        );
        assert_eq!(state.install(produced(T * US), T + 60), Installed::Replaced);

        // (c) A writer clock 5 min ahead stamped a revision; then the model
        //     is deleted, or a pod refuses that revision: back to the window.
        //     The dip is the full bound (300 s tolerance + 2 windows).
        let state = State::default();
        assert_eq!(
            state.install(produced((T + 420) * US), T + 1),
            Installed::Replaced
        );
        assert_eq!(state.install(produced(T * US), T + 1), Installed::Replaced);
    }

    #[test]
    fn beyond_the_bound_is_a_replay_and_counted() {
        let state = State::default();
        assert_eq!(
            state.install(produced((T + 421) * US), T + 421),
            Installed::Replaced
        );
        assert_eq!(state.install(produced(T * US), T + 421), Installed::Older);
        assert_eq!(
            state.current(T + 421).unwrap().catalog().version,
            (T + 421) * US
        );
        // A configured bound is honoured.
        let state = State::new(60);
        assert_eq!(
            state.install(produced((T + 61) * US), T + 61),
            Installed::Replaced
        );
        assert_eq!(state.install(produced(T * US), T + 61), Installed::Older);
    }

    #[test]
    fn two_catalogues_cannot_trade_places_past_the_bound() {
        let state = State::default();
        let (a, b) = ((T + 60) * US, T * US);
        // Within the bound they may alternate (the producer's own flap)…
        assert_eq!(state.install(produced(a), T + 60), Installed::Replaced);
        assert_eq!(state.install(produced(b), T + 60), Installed::Replaced);
        assert_eq!(state.install(produced(a), T + 60), Installed::Replaced);
        // …but once a catalogue past the bound of `b` has been installed, the
        // floor has moved and neither old one comes back.
        let later = (T + 500) * US;
        assert_eq!(state.install(produced(later), T + 500), Installed::Replaced);
        assert_eq!(state.install(produced(b), T + 500), Installed::Older);
        // And the floor does not follow a regression down: installing a lower
        // version leaves it where the newest catalogue put it.
        assert_eq!(
            state.install(produced((T + 440) * US), T + 500),
            Installed::Replaced
        );
        assert_eq!(
            state.install(produced((T + 79) * US), T + 500),
            Installed::Older
        );
    }

    struct Sequence {
        offers: std::sync::Mutex<Vec<VerifiedCatalog>>,
        exhausted: tokio::sync::Notify,
    }

    #[async_trait]
    impl CatalogSource for Sequence {
        async fn fetch(&self) -> Result<VerifiedCatalog, String> {
            let mut left = self.offers.lock().unwrap();
            if left.is_empty() {
                // This fetch starts only after the previous candidate has been
                // installed and counted. Never stop before the last offer.
                self.exhausted.notify_one();
                Err("sequence exhausted".to_owned())
            } else {
                Ok(left.remove(0))
            }
        }
    }

    fn replays(metrics: &Metrics) -> String {
        let text = metrics.render(crate::metrics::Gauges {
            active_streams: 0,
            buffered_bytes: 0,
            ready: true,
            draining: false,
        });
        text.lines()
            .find_map(|l| l.strip_prefix("f2z_ai_catalog_replays_total "))
            .unwrap()
            .to_owned()
    }

    /// The poller, with producer-shaped catalogues valid now: a legitimate
    /// dip never touches the replay counter; a beyond-bound one does.
    #[tokio::test]
    async fn only_a_beyond_bound_offer_increments_the_replay_counter() {
        let at = |secs_ago: u64| produced((T - secs_ago) * US);
        for (sequence, want) in [
            (vec![at(0), at(60), at(420), at(0)], "0"),
            (vec![at(0), at(421), at(0)], "1"),
        ] {
            let metrics = Arc::new(Metrics::default());
            let state = Arc::new(State::default());
            let (stop_tx, stop) = watch::channel(false);
            let source = Arc::new(Sequence {
                offers: std::sync::Mutex::new(sequence),
                exhausted: tokio::sync::Notify::new(),
            });
            let task = tokio::spawn(poll_with_clock(
                source.clone(),
                Arc::clone(&state),
                Arc::clone(&metrics),
                Duration::from_millis(5),
                stop,
                || T,
            ));
            tokio::time::timeout(Duration::from_secs(5), source.exhausted.notified())
                .await
                .expect("poller must process every offered catalogue");
            stop_tx.send_replace(true);
            task.await.unwrap();
            assert_eq!(replays(&metrics), want);
        }
    }

    #[test]
    fn a_stale_lower_version_is_a_replay_even_if_nothing_newer_arrived() {
        let state = State::default();
        assert_eq!(state.install(produced(T * US), T), Installed::Replaced);
        assert_eq!(
            state.install(produced((T + 60) * US), T + 60),
            Installed::Replaced
        );
        // Three hours later a stale source offers the superseded one.
        assert_eq!(
            state.install(produced(T * US), T + 3 * 3600),
            Installed::Older
        );
        // At the time of the dip it would have been accepted.
        assert_eq!(state.install(produced(T * US), T + 60), Installed::Replaced);
    }

    #[test]
    fn with_nothing_held_any_unexpired_catalogue_installs() {
        let state = State::default();
        assert_eq!(state.install(produced(T * US), T), Installed::Replaced);
    }

    #[test]
    fn expiry_is_checked_on_every_read_not_only_at_install() {
        let state = State::default();
        assert_eq!(state.install(catalog(1, 100), 10), Installed::Replaced);
        assert!(state.current(99).is_some());
        assert!(state.current(100).is_none(), "expires_at is exclusive");
    }

    #[test]
    fn an_expired_catalogue_is_never_installed() {
        let state = State::default();
        assert_eq!(state.install(catalog(1, 100), 100), Installed::Expired);
        assert!(state.current(0).is_none());
    }

    #[test]
    fn an_insane_catalogue_is_refused_even_if_verified() {
        let text = include_str!("../../f2z-ai-proto/fixtures/catalog/catalog.json");
        let mut c: Catalog = serde_json::from_str(text).unwrap();
        c.expires_at = c.issued_at;
        assert!(VerifiedCatalog::from_verified(c).is_err());
    }
}

#[cfg(test)]
mod http_source_tests {
    use super::*;
    use ring::signature::KeyPair as _;
    fn signed() -> (HttpSource, Vec<u8>) {
        let key = ring::signature::Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
        let hex = |bytes: &[u8]| bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
        let mut catalog: serde_json::Value = serde_json::from_str(include_str!(
            "../../f2z-ai-proto/fixtures/catalog/catalog.json"
        ))
        .unwrap();
        catalog["issued_at"] = serde_json::json!(now_unix());
        catalog["expires_at"] = serde_json::json!(now_unix() + 3600);
        let message = f2z_ai_proto::catalog::catalog_signing_message(&catalog).unwrap();
        let body=serde_json::to_vec(&serde_json::json!({"catalog":catalog,"signature":{"key_id":"test","signature_hex":hex(key.sign(&message).as_ref())}})).unwrap();
        let source = HttpSource::new(
            "http://127.0.0.1:1/catalog",
            &std::collections::BTreeMap::from([("test".into(), hex(key.public_key().as_ref()))]),
        )
        .unwrap();
        (source, body)
    }
    #[test]
    fn verified_envelope_accepts_only_signed_payload() {
        let (source, body) = signed();
        assert!(source.verify(&body).is_ok());
        let mut changed: serde_json::Value = serde_json::from_slice(&body).unwrap();
        changed["catalog"]["platform_margin_bps"] = serde_json::json!(0);
        assert!(
            source
                .verify(&serde_json::to_vec(&changed).unwrap())
                .is_err()
        );
    }
    #[test]
    fn duplicate_member_cannot_be_hidden_by_envelope_extraction() {
        let (source, body) = signed();
        let body = String::from_utf8(body).unwrap().replacen(
            "\"schema\":1",
            "\"schema\":2,\"schema\":1",
            1,
        );
        assert!(source.verify(body.as_bytes()).is_err());
    }
    #[test]
    fn catalogue_transport_refuses_plain_remote_or_embedded_credentials() {
        let keys = std::collections::BTreeMap::from([("test".into(), "00".repeat(32))]);
        assert!(HttpSource::new("http://example.com/catalog", &keys).is_err());
        assert!(HttpSource::new("https://user:password@example.com/catalog", &keys).is_err());
    }
}
