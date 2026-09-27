//! The issuer's signing keys: fetched from `jwks_uri`, cached, and refetched
//! on an unknown `kid` at most once per `min_refetch` (oidc.md §6.1: "MUST
//! refresh its JWKS cache on an unknown `kid` (at most once per minute)
//! before refusing the token").
//!
//! Only P-256 keys are kept (`kty: EC`, `crv: P-256`, `alg` absent or
//! `ES256`, `use` absent or `sig`). The IdP publishes its RS256 ID-token keys
//! in the same set; they are dropped here, so no token can be checked against
//! them whatever its header claims.
//!
//! # What an unknown `kid` means
//!
//! * The **most recent fetch succeeded** and the `kid` is not in what it
//!   returned (after the refetch the rate limit allows) → [`Lookup::Unknown`],
//!   a `401`: the issuer, asked, does not publish that key.
//! * Otherwise — nothing has ever loaded, the last fetch failed (the issuer
//!   may have rotated to a key this pod could not fetch), or the set is older
//!   than [`MAX_STALE`] → [`Lookup::Unavailable`], a `503`. Telling a client
//!   its token is invalid because this pod cannot reach the issuer would sign
//!   users out for an outage. While the last fetch failed, the refetch
//!   interval is [`UNLOADED_RETRY`] rather than a full minute.
//!
//! # A successful fetch is authoritative
//!
//! A `200` carrying a valid key set **replaces** the cached one, even when it
//! holds no usable ES256 key: withdrawing a key is how an issuer revokes it
//! after a compromise, and keeping the withdrawn key would honour tokens
//! minted with it indefinitely. A fetch that fails keeps the previous set, but
//! only for [`MAX_STALE`] after it was fetched; past that the cached keys are
//! not used at all (`503`), so an issuer outage cannot extend a key's life
//! without bound.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use reqwest::{Client, Url};
use serde::Deserialize;

/// How often a fetch is retried while no key set has ever loaded.
pub const UNLOADED_RETRY: Duration = Duration::from_secs(2);
/// A set older than this is refreshed (in the background) on next use. The
/// IdP serves its JWKS with `max-age=3600`.
pub const MAX_AGE: Duration = Duration::from_secs(3600);
/// The longest a key set is used after its fetch, whatever happens to later
/// fetches. The IdP keeps a retired key in its JWKS for at least 24 hours
/// (oidc.md §6.1); a withdrawn key stops verifying at the latest this long
/// after this pod last saw the set, even through an issuer outage.
pub const MAX_STALE: Duration = Duration::from_secs(24 * 3600);
/// The most of a JWKS or discovery document read.
pub const MAX_DOCUMENT_BYTES: usize = 256 * 1024;
/// The per-fetch timeout.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(5);

/// Where the raw JWKS document comes from.
#[async_trait]
pub trait KeySource: Send + Sync + 'static {
    /// The JWKS JSON, or why it could not be had.
    async fn fetch(&self) -> Result<Vec<u8>, String>;
}

/// The result of looking a `kid` up.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Lookup {
    /// The key: an uncompressed SEC1 P-256 point.
    Found(Arc<[u8]>),
    /// The most recent fetch succeeded and has no such key.
    Unknown,
    /// No current key set: never loaded, the last fetch failed, or the set is
    /// older than [`MAX_STALE`].
    Unavailable,
}

#[derive(Default)]
struct KeySet {
    keys: HashMap<String, Arc<[u8]>>,
    fetched_at: Option<Instant>,
}

impl KeySet {
    /// Fetched, and not older than [`MAX_STALE`].
    fn usable(&self) -> bool {
        self.fetched_at.is_some_and(|at| at.elapsed() <= MAX_STALE)
    }
}

/// The cache. Cheap to share: `Arc<KeyCache>`.
pub struct KeyCache {
    source: Arc<dyn KeySource>,
    set: RwLock<Arc<KeySet>>,
    /// Serialises fetches, so a burst of unknown-`kid` tokens costs one.
    fetching: tokio::sync::Mutex<()>,
    last_attempt: Mutex<Option<Instant>>,
    /// Whether the most recent fetch succeeded.
    last_ok: std::sync::atomic::AtomicBool,
    min_refetch: Duration,
    fetches: std::sync::atomic::AtomicU64,
}

impl std::fmt::Debug for KeyCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyCache")
            .field("min_refetch", &self.min_refetch)
            .finish_non_exhaustive()
    }
}

#[derive(Deserialize)]
struct Document {
    keys: Vec<serde_json::Value>,
}

/// Parse a JWKS document into its usable P-256 keys by `kid`.
///
/// # Errors
///
/// Not a JWKS document.
pub fn parse_jwks(bytes: &[u8]) -> Result<HashMap<String, Arc<[u8]>>, String> {
    let document: Document =
        serde_json::from_slice(bytes).map_err(|_| "the JWKS is not a JSON key set".to_owned())?;
    let mut keys = HashMap::new();
    for key in document.keys {
        let field = |name: &str| key.get(name).and_then(serde_json::Value::as_str);
        let usable = field("kty") == Some("EC")
            && field("crv") == Some("P-256")
            && field("alg").is_none_or(|a| a == super::jwt::ALG)
            && field("use").is_none_or(|u| u == "sig");
        let (Some(kid), true) = (field("kid"), usable) else {
            continue;
        };
        let coordinate = |name: &str| {
            field(name)
                .and_then(|v| URL_SAFE_NO_PAD.decode(v).ok())
                .filter(|v| v.len() == 32)
        };
        let (Some(x), Some(y)) = (coordinate("x"), coordinate("y")) else {
            continue;
        };
        let mut point = Vec::with_capacity(65);
        point.push(0x04);
        point.extend_from_slice(&x);
        point.extend_from_slice(&y);
        keys.insert(kid.to_owned(), Arc::from(point));
    }
    Ok(keys)
}

impl KeyCache {
    /// A cache over `source`, refetching on an unknown `kid` at most once per
    /// `min_refetch`.
    #[must_use]
    pub fn new(source: Arc<dyn KeySource>, min_refetch: Duration) -> Self {
        Self {
            source,
            set: RwLock::new(Arc::new(KeySet::default())),
            fetching: tokio::sync::Mutex::new(()),
            last_attempt: Mutex::new(None),
            last_ok: std::sync::atomic::AtomicBool::new(false),
            min_refetch,
            fetches: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// Fetch attempts so far (for tests and metrics).
    #[must_use]
    pub fn fetches(&self) -> u64 {
        self.fetches.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn current(&self) -> Arc<KeySet> {
        Arc::clone(
            &self
                .set
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    fn healthy(&self) -> bool {
        self.last_ok.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn interval(&self) -> Duration {
        if self.healthy() && self.current().usable() {
            self.min_refetch
        } else {
            self.min_refetch.min(UNLOADED_RETRY)
        }
    }

    /// Whether a fetch may start now (without claiming it).
    fn attempt_due(&self) -> bool {
        let interval = self.interval();
        let last = self
            .last_attempt
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        !last.is_some_and(|at| at.elapsed() < interval)
    }

    /// Whether a fetch may start now, and if so, record that one does.
    fn claim_attempt(&self) -> bool {
        let interval = self.interval();
        let mut last = self
            .last_attempt
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if last.is_some_and(|at| at.elapsed() < interval) {
            return false;
        }
        *last = Some(Instant::now());
        true
    }

    /// Fetch now if the rate limit allows. Returns whether a fetch ran.
    pub async fn refresh(&self) -> bool {
        let _one = self.fetching.lock().await;
        if !self.claim_attempt() {
            return false;
        }
        self.fetches
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        match self.source.fetch().await.and_then(|b| parse_jwks(&b)) {
            Ok(keys) => {
                if keys.is_empty() {
                    // Authoritative: every previously trusted key is
                    // withdrawn. Tokens are refused until the issuer
                    // publishes one again.
                    tracing::error!("the issuer's JWKS holds no ES256 key; no token will verify");
                } else {
                    tracing::info!("access-token key set refreshed");
                }
                let set = Arc::new(KeySet {
                    keys,
                    fetched_at: Some(Instant::now()),
                });
                *self
                    .set
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = set;
                self.last_ok
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
            Err(error) => {
                self.last_ok
                    .store(false, std::sync::atomic::Ordering::SeqCst);
                tracing::warn!(%error, "the issuer's JWKS could not be fetched");
            }
        }
        true
    }

    /// The key for `kid`.
    pub async fn lookup(self: &Arc<Self>, kid: &str) -> Lookup {
        let set = self.current();
        if set.usable()
            && let Some(key) = set.keys.get(kid)
        {
            if set.fetched_at.is_some_and(|at| at.elapsed() > MAX_AGE) && self.attempt_due() {
                let this = Arc::clone(self);
                tokio::spawn(async move {
                    this.refresh().await;
                });
            }
            return Lookup::Found(Arc::clone(key));
        }
        self.refresh().await;
        let set = self.current();
        if !set.usable() {
            return Lookup::Unavailable;
        }
        match set.keys.get(kid) {
            Some(key) => Lookup::Found(Arc::clone(key)),
            None if self.healthy() => Lookup::Unknown,
            None => Lookup::Unavailable,
        }
    }
}

/// Fetches the JWKS over HTTPS: from `jwks_uri` if configured, otherwise from
/// the `jwks_uri` the issuer's discovery document names (whose `issuer` must
/// equal the configured issuer exactly).
pub struct HttpKeySource {
    client: Client,
    issuer: String,
    jwks_uri: Mutex<Option<Url>>,
}

impl HttpKeySource {
    /// A source for `issuer`, with an optional fixed `jwks_uri`.
    #[must_use]
    pub fn new(client: Client, issuer: String, jwks_uri: Option<Url>) -> Self {
        Self {
            client,
            issuer,
            jwks_uri: Mutex::new(jwks_uri),
        }
    }

    async fn discover(&self) -> Result<Url, String> {
        let url = format!(
            "{}/.well-known/openid-configuration",
            self.issuer.trim_end_matches('/')
        );
        let body = get(&self.client, &url).await?;
        let document: serde_json::Value = serde_json::from_slice(&body)
            .map_err(|_| "the discovery document is not JSON".to_owned())?;
        if document.get("issuer").and_then(serde_json::Value::as_str) != Some(&self.issuer) {
            return Err("the discovery document names a different issuer".to_owned());
        }
        let jwks = document
            .get("jwks_uri")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "the discovery document has no jwks_uri".to_owned())?;
        check_url(jwks)
    }
}

#[async_trait]
impl KeySource for HttpKeySource {
    async fn fetch(&self) -> Result<Vec<u8>, String> {
        let known = self
            .jwks_uri
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let url = match known {
            Some(url) => url,
            None => {
                let url = self.discover().await?;
                *self
                    .jwks_uri
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(url.clone());
                url
            }
        };
        get(&self.client, url.as_str()).await
    }
}

/// `https://`, or `http://` to a loopback address (a test issuer).
///
/// # Errors
///
/// Why the URL is refused.
pub fn check_url(text: &str) -> Result<Url, String> {
    crate::provider::client::base_url(text)
}

/// GET `url`, `200` only, at most [`MAX_DOCUMENT_BYTES`].
async fn get(client: &Client, url: &str) -> Result<Vec<u8>, String> {
    let mut response = tokio::time::timeout(FETCH_TIMEOUT, client.get(url).send())
        .await
        .map_err(|_| "timed out".to_owned())?
        .map_err(|e| format!("request failed: {}", e.without_url()))?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(format!("status {}", response.status().as_u16()));
    }
    let mut body = Vec::new();
    let read = async {
        while let Some(chunk) = response.chunk().await.map_err(|_| "body read failed")? {
            if body.len().saturating_add(chunk.len()) > MAX_DOCUMENT_BYTES {
                return Err("document too large");
            }
            body.extend_from_slice(&chunk);
        }
        Ok(())
    };
    tokio::time::timeout(FETCH_TIMEOUT, read)
        .await
        .map_err(|_| "timed out".to_owned())?
        .map_err(str::to_owned)?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn xy() -> (String, String) {
        (
            URL_SAFE_NO_PAD.encode([1u8; 32]),
            URL_SAFE_NO_PAD.encode([2u8; 32]),
        )
    }

    #[test]
    fn only_p256_signing_keys_are_kept() {
        let (x, y) = xy();
        let doc = json!({"keys": [
            {"kty": "EC", "crv": "P-256", "kid": "a", "x": x, "y": y, "alg": "ES256", "use": "sig"},
            {"kty": "EC", "crv": "P-256", "kid": "b", "x": x, "y": y},
            {"kty": "EC", "crv": "P-384", "kid": "c", "x": x, "y": y},
            {"kty": "RSA", "kid": "d", "n": "AQAB", "e": "AQAB", "alg": "RS256"},
            {"kty": "EC", "crv": "P-256", "kid": "e", "x": x, "y": y, "alg": "ES384"},
            {"kty": "EC", "crv": "P-256", "kid": "f", "x": x, "y": y, "use": "enc"},
            {"kty": "EC", "crv": "P-256", "kid": "g", "x": "AAAA", "y": y},
            {"kty": "oct", "kid": "h", "k": x},
        ]});
        let keys = parse_jwks(doc.to_string().as_bytes()).unwrap();
        let mut kids: Vec<_> = keys.keys().cloned().collect();
        kids.sort();
        assert_eq!(kids, ["a", "b"]);
        assert_eq!(keys["a"].len(), 65);
        assert_eq!(keys["a"][0], 4);
    }

    struct Counting {
        calls: AtomicU32,
        doc: Mutex<Vec<u8>>,
    }

    #[async_trait]
    impl KeySource for Counting {
        async fn fetch(&self) -> Result<Vec<u8>, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let doc = self.doc.lock().unwrap().clone();
            if doc.is_empty() {
                Err("down".into())
            } else {
                Ok(doc)
            }
        }
    }

    #[tokio::test]
    async fn an_unknown_kid_refetches_at_most_once_per_interval() {
        let (x, y) = xy();
        let source = Arc::new(Counting {
            calls: AtomicU32::new(0),
            doc: Mutex::new(
                json!({"keys": [{"kty": "EC", "crv": "P-256", "kid": "a", "x": x, "y": y}]})
                    .to_string()
                    .into_bytes(),
            ),
        });
        let cache = Arc::new(KeyCache::new(source.clone(), Duration::from_secs(60)));
        assert!(matches!(cache.lookup("a").await, Lookup::Found(_)));
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
        // Known kid: no fetch.
        assert!(matches!(cache.lookup("a").await, Lookup::Found(_)));
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
        // Unknown kids within the interval: refused without a fetch each.
        for _ in 0..10 {
            assert_eq!(cache.lookup("zzz").await, Lookup::Unknown);
        }
        assert_eq!(source.calls.load(Ordering::SeqCst), 1);
    }

    fn doc(kids: &[&str]) -> Vec<u8> {
        let (x, y) = xy();
        let keys: Vec<_> = kids
            .iter()
            .map(|k| json!({"kty": "EC", "crv": "P-256", "kid": k, "x": x, "y": y}))
            .collect();
        json!({ "keys": keys }).to_string().into_bytes()
    }

    #[tokio::test]
    async fn a_successful_fetch_without_the_key_withdraws_it() {
        let source = Arc::new(Counting {
            calls: AtomicU32::new(0),
            doc: Mutex::new(doc(&["a"])),
        });
        let cache = Arc::new(KeyCache::new(source.clone(), Duration::ZERO));
        assert!(matches!(cache.lookup("a").await, Lookup::Found(_)));
        // The issuer withdraws every ES256 key (a compromise response).
        *source.doc.lock().unwrap() = json!({"keys": []}).to_string().into_bytes();
        assert!(cache.refresh().await);
        assert_eq!(cache.lookup("a").await, Lookup::Unknown);
    }

    #[tokio::test]
    async fn an_unknown_kid_during_an_issuer_outage_is_unavailable_not_unknown() {
        let source = Arc::new(Counting {
            calls: AtomicU32::new(0),
            doc: Mutex::new(doc(&["a"])),
        });
        let cache = Arc::new(KeyCache::new(source.clone(), Duration::ZERO));
        assert!(matches!(cache.lookup("a").await, Lookup::Found(_)));
        // The issuer rotates to "b" and this pod cannot reach it.
        source.doc.lock().unwrap().clear();
        assert_eq!(cache.lookup("b").await, Lookup::Unavailable);
        // The key it has still verifies meanwhile.
        assert!(matches!(cache.lookup("a").await, Lookup::Found(_)));
        // The issuer is back: "b" is found.
        *source.doc.lock().unwrap() = doc(&["a", "b"]);
        assert!(matches!(cache.lookup("b").await, Lookup::Found(_)));
    }

    #[tokio::test]
    async fn never_loaded_is_unavailable_not_unknown() {
        let source = Arc::new(Counting {
            calls: AtomicU32::new(0),
            doc: Mutex::new(Vec::new()),
        });
        let cache = Arc::new(KeyCache::new(source, Duration::from_secs(60)));
        assert_eq!(cache.lookup("a").await, Lookup::Unavailable);
    }
}
