//! Authentication and limits in front of `/v1/chat`, end to end: a real
//! gateway on loopback, a fake issuer (discovery, JWKS and the internal epoch
//! endpoint, over real HTTP) and an in-memory stand-in for the shared Redis
//! with fault injection. The real [`f2z_ai::auth::Gate`] is used throughout;
//! nothing here is a stub of the code under test.
//!
//! Every refusal test is also the negative control of the one before it: the
//! same token, changed in exactly one respect, flips the verdict.

#![allow(
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

mod support;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, Response, StatusCode, header};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use f2z_ai::auth::jwks::{HttpKeySource, KeyCache};
use f2z_ai::auth::limits::{Limits, LimitsConfig};
use f2z_ai::auth::revocation::{HttpEpochSource, Revocation};
use f2z_ai::auth::store::{Admission, AdmitRequest, Rate, Refusal, Store, StoreError};
use f2z_ai::auth::{Gate, Gatekeeper};
use f2z_ai::chat::{ChatBackend, NotImplemented};
use f2z_ai::{Deps, Gateway};
use hyper::body::Incoming;
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair as _};
use secrecy::SecretString;
use serde_json::{Value, json};
use support::{
    ControlledBackend, RecordingSettler, config, error_of, fixed_catalog, send, valid_chat,
    wait_records,
};

const SECRET: &str = "internal-epoch-secret";
const SUB: &str = "3f0c9b7e-6a2d-4b1f-8e5c-2d9a7c4e1b60";
const CLIENT: &str = "app_7f3c2e";
const NS: &str = "testns";

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn b64(bytes: impl AsRef<[u8]>) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

// ---------------------------------------------------------------------------
// The fake issuer.
// ---------------------------------------------------------------------------

struct SigningKey {
    kid: String,
    pair: EcdsaKeyPair,
}

impl SigningKey {
    fn generate(kid: &str) -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let pair = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
            .unwrap();
        Self {
            kid: kid.to_owned(),
            pair,
        }
    }

    fn point(&self) -> &[u8] {
        self.pair.public_key().as_ref()
    }

    fn jwk(&self) -> Value {
        let point = self.point();
        json!({
            "kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig", "kid": self.kid,
            "x": b64(&point[1..33]), "y": b64(&point[33..65]),
        })
    }

    fn sign(&self, header: &Value, claims: &Value) -> String {
        let input = format!("{}.{}", b64(header.to_string()), b64(claims.to_string()));
        let signature = self
            .pair
            .sign(&SystemRandom::new(), input.as_bytes())
            .unwrap();
        format!("{input}.{}", b64(signature.as_ref()))
    }
}

enum EpochMode {
    Answer { aep: u64, agen: Value },
    Status(u16),
    Hang,
}

struct Idp {
    issuer: String,
    jwks: Mutex<Value>,
    jwks_fetches: AtomicU32,
    epoch: Mutex<EpochMode>,
    epoch_calls: AtomicU32,
}

impl Idp {
    fn set_epoch(&self, mode: EpochMode) {
        *self.epoch.lock().unwrap() = mode;
    }
}

async fn idp_handler(idp: Arc<Idp>, request: Request<Body>) -> Response<Body> {
    let path = request.uri().path().to_owned();
    let json_response = |status: u16, value: Value| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(value.to_string()))
            .unwrap()
    };
    if path == "/.well-known/openid-configuration" {
        return json_response(
            200,
            json!({"issuer": idp.issuer, "jwks_uri": format!("{}/api/oauth/jwks", idp.issuer)}),
        );
    }
    if path == "/api/oauth/jwks" {
        idp.jwks_fetches.fetch_add(1, Ordering::SeqCst);
        let jwks = idp.jwks.lock().unwrap().clone();
        return json_response(200, jwks);
    }
    if let Some(rest) = path.strip_prefix("/api/oauth/internal/epoch/") {
        idp.epoch_calls.fetch_add(1, Ordering::SeqCst);
        let authorized = request
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            == Some(&format!("Bearer {SECRET}"));
        if !authorized {
            return json_response(401, json!({"detail": "unauthorized"}));
        }
        let sub = rest.trim_end_matches('/').to_owned();
        let answer = match &*idp.epoch.lock().unwrap() {
            EpochMode::Answer { aep, agen } => Ok(json!({"sub": sub, "aep": aep, "agen": agen})),
            EpochMode::Status(status) => Err(Some(*status)),
            EpochMode::Hang => Err(None),
        };
        return match answer {
            Ok(value) => json_response(200, value),
            Err(Some(status)) => json_response(status, json!({"detail": "x"})),
            Err(None) => {
                tokio::time::sleep(Duration::from_secs(60)).await;
                json_response(503, json!({}))
            }
        };
    }
    json_response(404, json!({}))
}

async fn start_idp(keys: &[&SigningKey]) -> Arc<Idp> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let idp = Arc::new(Idp {
        issuer,
        jwks: Mutex::new(json!({"keys": keys.iter().map(|k| k.jwk()).collect::<Vec<_>>()})),
        jwks_fetches: AtomicU32::new(0),
        epoch: Mutex::new(EpochMode::Answer {
            aep: 4,
            agen: json!({CLIENT: 2}),
        }),
        epoch_calls: AtomicU32::new(0),
    });
    let state = Arc::clone(&idp);
    let router = axum::Router::new().fallback(move |request: Request<Body>| {
        let idp = Arc::clone(&state);
        async move { idp_handler(idp, request).await }
    });
    tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    idp
}

// ---------------------------------------------------------------------------
// The in-memory shared store, with the Lua script's semantics.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct MemoryStore {
    counters: Mutex<HashMap<String, String>>,
    buckets: Mutex<HashMap<String, (u64, Instant)>>,
    leases: Mutex<HashMap<String, HashMap<String, Instant>>>,
    down: AtomicBool,
    /// Run `admit` and then lose its reply, as a timeout after Redis ran the
    /// script does.
    lose_admit_replies: AtomicBool,
    counter_reads: AtomicU32,
}

impl MemoryStore {
    fn publish(&self, aep: u64, agen: u64) {
        let mut c = self.counters.lock().unwrap();
        c.insert(format!("{NS}:aep:{SUB}"), aep.to_string());
        c.insert(format!("{NS}:agen:{CLIENT}:{SUB}"), agen.to_string());
    }

    fn open_leases(&self) -> usize {
        let now = Instant::now();
        self.leases
            .lock()
            .unwrap()
            .values()
            .map(|set| set.values().filter(|e| **e > now).count())
            .sum()
    }

    fn level(&self, key: &str, rate: Rate, now: Instant) -> u64 {
        let cap = u64::from(rate.burst) * 1000;
        match self.buckets.lock().unwrap().get(key) {
            None => cap,
            Some((tokens, at)) => {
                let ms = u64::try_from(now.duration_since(*at).as_millis()).unwrap();
                (tokens + ms * u64::from(rate.per_minute) / 60).min(cap)
            }
        }
    }
}

#[async_trait]
impl Store for MemoryStore {
    async fn counters(&self, keys: [&str; 2]) -> Result<[Option<String>; 2], StoreError> {
        self.counter_reads.fetch_add(1, Ordering::SeqCst);
        if self.down.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        let c = self.counters.lock().unwrap();
        Ok([c.get(keys[0]).cloned(), c.get(keys[1]).cloned()])
    }

    async fn admit(&self, r: &AdmitRequest) -> Result<Admission, StoreError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        let now = Instant::now();
        {
            let mut leases = self.leases.lock().unwrap();
            let set = leases.entry(r.lease_key.clone()).or_default();
            set.retain(|_, expiry| *expiry > now);
            if set.len() >= r.lease_limit as usize {
                return Ok(Admission::Refused {
                    by: Refusal::Concurrency,
                    retry_after_ms: 1000,
                });
            }
        }
        let user = self.level(&r.user_bucket, r.user_rate, now);
        let app = self.level(&r.app_bucket, r.app_rate, now);
        if user < 1000 {
            return Ok(Admission::Refused {
                by: Refusal::User,
                retry_after_ms: (1000 - user) * 60 / u64::from(r.user_rate.per_minute),
            });
        }
        if app < 1000 {
            return Ok(Admission::Refused {
                by: Refusal::App,
                retry_after_ms: (1000 - app) * 60 / u64::from(r.app_rate.per_minute),
            });
        }
        let mut buckets = self.buckets.lock().unwrap();
        buckets.insert(r.user_bucket.clone(), (user - 1000, now));
        buckets.insert(r.app_bucket.clone(), (app - 1000, now));
        self.leases
            .lock()
            .unwrap()
            .entry(r.lease_key.clone())
            .or_default()
            .insert(r.member.clone(), now + r.lease_ttl);
        if self.lose_admit_replies.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        Ok(Admission::Admitted {
            remaining: u32::try_from((user - 1000) / 1000).unwrap(),
        })
    }

    async fn renew(&self, lease_key: &str, member: &str, ttl: Duration) -> Result<(), StoreError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        self.leases
            .lock()
            .unwrap()
            .entry(lease_key.to_owned())
            .or_default()
            .insert(member.to_owned(), Instant::now() + ttl);
        Ok(())
    }

    async fn release(&self, lease_key: &str, member: &str) -> Result<(), StoreError> {
        if self.down.load(Ordering::SeqCst) {
            return Err(StoreError);
        }
        if let Some(set) = self.leases.lock().unwrap().get_mut(lease_key) {
            set.remove(member);
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Wiring.
// ---------------------------------------------------------------------------

struct Harness {
    key: SigningKey,
    idp: Arc<Idp>,
    store: Arc<MemoryStore>,
    keys: Arc<KeyCache>,
}

fn limits_config(per_minute: u32, burst: u32, concurrency: u32) -> LimitsConfig {
    LimitsConfig {
        user: Rate { per_minute, burst },
        app: Rate {
            per_minute: 100_000,
            burst: 10_000,
        },
        concurrency,
        lease_ttl: Duration::from_secs(360),
    }
}

impl Harness {
    async fn new() -> Self {
        let key = SigningKey::generate("2026-09-a");
        let idp = start_idp(&[&key]).await;
        let store = Arc::new(MemoryStore::default());
        store.publish(4, 2);
        let keys = Arc::new(KeyCache::new(
            Arc::new(HttpKeySource::new(
                reqwest::Client::new(),
                idp.issuer.clone(),
                None,
            )),
            Duration::from_secs(60),
        ));
        Self {
            key,
            idp,
            store,
            keys,
        }
    }

    fn gate(&self, limits: LimitsConfig) -> Gate {
        let store: Arc<dyn Store> = self.store.clone();
        let endpoint =
            reqwest::Url::parse(&format!("{}/api/oauth/internal/epoch/", self.idp.issuer)).unwrap();
        Gate::new(
            self.idp.issuer.clone(),
            "f2z-ai".into(),
            Arc::clone(&self.keys),
            Revocation::new(
                Some(Arc::clone(&store)),
                NS.into(),
                Some(Arc::new(HttpEpochSource::new(
                    reqwest::Client::new(),
                    endpoint,
                    SecretString::from(SECRET),
                    Duration::from_millis(300),
                ))),
            ),
            Limits::new(limits, Some(store), NS.into()),
        )
    }

    async fn gateway(
        &self,
        limits: LimitsConfig,
        backend: Arc<dyn ChatBackend>,
        settler: RecordingSettler,
    ) -> Gateway {
        Gateway::bind(
            &config(&[]),
            Deps {
                gate: Arc::new(self.gate(limits)),
                catalog: fixed_catalog(),
                backend,
                settler: Arc::new(settler),
            },
        )
        .await
        .unwrap()
    }

    fn claims(&self) -> Value {
        let now = now();
        json!({
            "iss": self.idp.issuer,
            "sub": SUB,
            "aud": ["f2z-id", "f2z-ai", "f2z-api"],
            "client_id": CLIENT,
            "app_id": "22222222-2222-4222-8222-222222222222",
            "scope": "openid profile ai:invoke",
            "iat": now,
            "exp": now + 300,
            "jti": "019a2f1c-9c7b-7e21-8a3d-4b5e6f7a8b9c",
            "aep": 4,
            "agen": 2,
        })
    }

    fn header(&self) -> Value {
        json!({"alg": "ES256", "typ": "at+jwt", "kid": self.key.kid})
    }

    fn token(&self) -> String {
        self.key.sign(&self.header(), &self.claims())
    }

    fn token_with(&self, key: &str, value: Value) -> String {
        let mut claims = self.claims();
        claims[key] = value;
        self.key.sign(&self.header(), &claims)
    }
}

fn authed(token: Option<&str>) -> Request<Body> {
    let mut builder = Request::post("/v1/chat")
        .header(header::HOST, "gateway")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
    }
    builder
        .body(Body::from(valid_chat("hello").to_string()))
        .unwrap()
}

async fn call(gateway: &Gateway, token: Option<&str>) -> Response<Incoming> {
    send(gateway.public_addr(), authed(token)).await
}

/// `(status, code, details.reason)`.
async fn verdict(gateway: &Gateway, token: Option<&str>) -> (u16, String, Value) {
    let response = call(gateway, token).await;
    let status = response.status().as_u16();
    let error = error_of(response).await;
    (
        status,
        error["code"].as_str().unwrap_or_default().to_owned(),
        error["details"]["reason"].clone(),
    )
}

fn not_implemented() -> Arc<dyn ChatBackend> {
    Arc::new(NotImplemented)
}

fn open_limits() -> LimitsConfig {
    limits_config(100_000, 10_000, 4)
}

// ---------------------------------------------------------------------------
// The token.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_valid_token_reaches_the_backend() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    let (status, code, _) = verdict(&gw, Some(&h.token())).await;
    assert_eq!((status, code.as_str()), (501, "not_implemented"));
    // The key set came through discovery and was fetched once.
    assert_eq!(h.idp.jwks_fetches.load(Ordering::SeqCst), 1);
    assert_eq!(h.idp.epoch_calls.load(Ordering::SeqCst), 0, "Redis hit");
}

#[tokio::test]
async fn application_identity_is_required_and_signed_separately_from_opaque_client() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501);
    for value in [
        json!(null),
        json!(CLIENT),
        json!(42),
        json!("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"),
    ] {
        let (status, code, _) = verdict(&gw, Some(&h.token_with("app_id", value))).await;
        assert_eq!((status, code.as_str()), (401, "invalid_token"));
    }
    let mut claims = h.claims();
    claims.as_object_mut().unwrap().remove("app_id");
    let missing = h.key.sign(&h.header(), &claims);
    assert_eq!(verdict(&gw, Some(&missing)).await.0, 401);
    // A well-formed app UUID cannot be substituted without the issuer signature.
    let token = h.token();
    let mut parts: Vec<_> = token.split('.').map(str::to_owned).collect();
    claims["app_id"] = json!("33333333-3333-4333-8333-333333333333");
    parts[1] = b64(claims.to_string());
    assert_eq!(verdict(&gw, Some(&parts.join("."))).await.0, 401);
}

#[tokio::test]
async fn no_token_or_a_malformed_one_is_401_with_a_challenge() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    let response = call(&gw, None).await;
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.headers()[header::WWW_AUTHENTICATE],
        "Bearer realm=\"f2z-ai\""
    );
    let error = error_of(response).await;
    assert_eq!(error["code"], "invalid_token");
    assert_eq!(error["details"]["reason"], "missing");

    for bad in ["garbage", "a.b.c", "e30.e30.e30"] {
        let (status, code, reason) = verdict(&gw, Some(bad)).await;
        assert_eq!((status, code.as_str()), (401, "invalid_token"), "{bad}");
        assert_eq!(reason, "malformed", "{bad}");
    }
}

#[tokio::test]
async fn algorithm_confusion_is_refused() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    let claims = b64(h.claims().to_string());

    // `alg: none`, no signature.
    let none = format!(
        "{}.{claims}.",
        b64(json!({"alg": "none", "typ": "at+jwt", "kid": h.key.kid}).to_string())
    );
    // HS256 keyed with the issuer's public key — the published point, and
    // the JWK text — which a verifier that trusts the header would accept.
    let hs = |secret: &[u8]| {
        let header = b64(json!({"alg": "HS256", "typ": "at+jwt", "kid": h.key.kid}).to_string());
        let input = format!("{header}.{claims}");
        let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret);
        format!(
            "{input}.{}",
            b64(ring::hmac::sign(&key, input.as_bytes()).as_ref())
        )
    };
    let hs_point = hs(h.key.point());
    let hs_jwk = hs(h.key.jwk().to_string().as_bytes());
    // ES256 with the right kid, signed by a key the issuer never published.
    let forged = SigningKey::generate(&h.key.kid).sign(&h.header(), &h.claims());
    // A header naming another algorithm, genuinely signed (ES256) by the
    // issuer's own key: the signature verifies, and the token is still
    // refused, because `alg` is decided by configuration, not by the token.
    let relabel = |alg: &str| {
        h.key.sign(
            &json!({"alg": alg, "typ": "at+jwt", "kid": h.key.kid}),
            &h.claims(),
        )
    };

    for (name, token) in [
        ("none", none),
        ("HS256/point", hs_point),
        ("HS256/jwk", hs_jwk),
        ("forged ES256", forged),
        ("RS256", relabel("RS256")),
        ("ES384", relabel("ES384")),
    ] {
        let (status, code, reason) = verdict(&gw, Some(&token)).await;
        assert_eq!((status, code.as_str()), (401, "invalid_token"), "{name}");
        assert_eq!(reason, "signature", "{name}");
    }
    // The control: the genuine token, relabelled with its own alg, passes.
    assert_eq!(verdict(&gw, Some(&relabel("ES256"))).await.0, 501);
}

#[tokio::test]
async fn audience_issuer_expiry_and_typ() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    let now = now();
    let cases = [
        (
            h.token_with("aud", json!(["f2z-id", "f2z-api"])),
            401,
            "audience",
        ),
        (h.token_with("aud", json!("f2z-ai")), 401, "audience"),
        (
            h.token_with("iss", json!("https://free2z.cash")),
            401,
            "issuer",
        ),
        (h.token_with("exp", json!(now - 31)), 401, "expired"),
        (h.token_with("iat", json!(now + 120)), 401, "expired"),
        (h.token_with("aep", json!("4")), 401, "malformed"),
    ];
    for (token, want_status, want_reason) in cases {
        let (status, code, reason) = verdict(&gw, Some(&token)).await;
        assert_eq!(
            (status, code.as_str(), reason.as_str().unwrap()),
            (want_status, "invalid_token", want_reason)
        );
    }
    // Within the 30 s leeway.
    assert_eq!(
        verdict(&gw, Some(&h.token_with("exp", json!(now - 20))))
            .await
            .0,
        501
    );
    // An ID-token-shaped `typ` is not an access token.
    let id_token = h.key.sign(
        &json!({"alg": "ES256", "typ": "JWT", "kid": h.key.kid}),
        &h.claims(),
    );
    let (status, _, reason) = verdict(&gw, Some(&id_token)).await;
    assert_eq!((status, reason.as_str().unwrap()), (401, "malformed"));
}

#[tokio::test]
async fn a_token_without_ai_invoke_is_403_insufficient_scope() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    for scope in ["openid profile balance:read", "ai:invoker", "ai"] {
        let response = call(&gw, Some(&h.token_with("scope", json!(scope)))).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{scope}");
        assert!(
            response.headers()[header::WWW_AUTHENTICATE]
                .to_str()
                .unwrap()
                .contains("insufficient_scope")
        );
        let error = error_of(response).await;
        assert_eq!(error["code"], "insufficient_scope");
        assert_eq!(error["details"]["scope"], "ai:invoke");
    }
}

#[tokio::test]
async fn an_unknown_kid_refetches_once_per_interval_and_picks_up_a_rotation() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501);
    assert_eq!(h.idp.jwks_fetches.load(Ordering::SeqCst), 1);

    // A kid nobody published: refused after at most one refetch, and a burst
    // of them costs no further fetches.
    let stranger = SigningKey::generate("nobody");
    for _ in 0..5 {
        let token = stranger.sign(
            &json!({"alg": "ES256", "typ": "at+jwt", "kid": "nobody"}),
            &h.claims(),
        );
        let (status, _, reason) = verdict(&gw, Some(&token)).await;
        assert_eq!((status, reason.as_str().unwrap()), (401, "signature"));
    }
    assert!(h.idp.jwks_fetches.load(Ordering::SeqCst) <= 2);
}

#[tokio::test]
async fn a_rotated_key_is_found_by_refetching() {
    let h = Harness::new().await;
    // The cache has never seen the new key: the first token signed with it
    // triggers the refetch that finds it.
    let rotated = SigningKey::generate("2026-10-a");
    *h.idp.jwks.lock().unwrap() = json!({"keys": [rotated.jwk(), h.key.jwk()]});
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    let token = rotated.sign(
        &json!({"alg": "ES256", "typ": "at+jwt", "kid": "2026-10-a"}),
        &h.claims(),
    );
    assert_eq!(verdict(&gw, Some(&token)).await.0, 501);
    assert_eq!(
        verdict(&gw, Some(&h.token())).await.0,
        501,
        "the predecessor"
    );
}

// ---------------------------------------------------------------------------
// Revocation — fails closed.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_stale_aep_or_agen_in_redis_is_token_revoked() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    let cases = [
        ((5, 2), 401, "account_epoch"),
        ((4, 3), 401, "grant_generation"),
        ((5, 3), 401, "account_epoch"),
    ];
    for ((aep, agen), want, reason_want) in cases {
        h.store.publish(aep, agen);
        let response = call(&gw, Some(&h.token())).await;
        assert_eq!(response.status().as_u16(), want);
        assert!(
            response.headers()[header::WWW_AUTHENTICATE]
                .to_str()
                .unwrap()
                .contains("invalid_token")
        );
        let error = error_of(response).await;
        assert_eq!(error["code"], "token_revoked");
        assert_eq!(error["details"]["reason"], reason_want);
    }
    // Current, and ahead of a publication that has not landed: accepted.
    for (aep, agen) in [(4, 2), (3, 1)] {
        h.store.publish(aep, agen);
        assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501, "{aep}/{agen}");
    }
    assert_eq!(h.idp.epoch_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_redis_miss_asks_the_internal_endpoint_and_fails_closed() {
    let h = Harness::new().await;
    h.store.counters.lock().unwrap().clear();
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;

    // 200 with the grant live and current.
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501);
    assert_eq!(h.idp.epoch_calls.load(Ordering::SeqCst), 1);

    let cases: [(EpochMode, u16, &str, &str); 7] = [
        // The grant is absent: live grants only, so revoked.
        (
            EpochMode::Answer {
                aep: 4,
                agen: json!({"other_app": 9}),
            },
            401,
            "token_revoked",
            "grant_generation",
        ),
        (
            EpochMode::Answer {
                aep: 5,
                agen: json!({CLIENT: 2}),
            },
            401,
            "token_revoked",
            "account_epoch",
        ),
        (
            EpochMode::Answer {
                aep: 4,
                agen: json!({CLIENT: 3}),
            },
            401,
            "token_revoked",
            "grant_generation",
        ),
        (
            EpochMode::Status(404),
            401,
            "token_revoked",
            "account_epoch",
        ),
        (
            EpochMode::Status(503),
            503,
            "unavailable",
            "revocation_check",
        ),
        (
            EpochMode::Status(500),
            503,
            "unavailable",
            "revocation_check",
        ),
        (EpochMode::Hang, 503, "unavailable", "revocation_check"),
    ];
    for (mode, status_want, code_want, reason_want) in cases {
        h.idp.set_epoch(mode);
        let (status, code, reason) = verdict(&gw, Some(&h.token())).await;
        assert_eq!(
            (status, code.as_str(), reason.as_str().unwrap()),
            (status_want, code_want, reason_want)
        );
    }
    // A partial hit (aep present, agen missing) is a miss, not half an answer.
    h.idp.set_epoch(EpochMode::Status(503));
    h.store
        .counters
        .lock()
        .unwrap()
        .insert(format!("{NS}:aep:{SUB}"), "4".into());
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 503);
    // A value that is not a plain decimal is a miss too.
    h.store.publish(4, 2);
    h.store
        .counters
        .lock()
        .unwrap()
        .insert(format!("{NS}:agen:{CLIENT}:{SUB}"), "2.0".into());
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 503);
}

#[tokio::test]
async fn redis_down_never_falls_open_for_revocation() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    h.store.down.store(true, Ordering::SeqCst);

    // Redis down + endpoint unknown: refused, retryable.
    h.idp.set_epoch(EpochMode::Status(503));
    let response = call(&gw, Some(&h.token())).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert!(response.headers().contains_key(header::RETRY_AFTER));
    let error = error_of(response).await;
    assert_eq!(error["code"], "unavailable");
    assert_eq!(error["details"]["reason"], "revocation_check");

    // Redis down + endpoint answers: served (limits locally).
    h.idp.set_epoch(EpochMode::Answer {
        aep: 4,
        agen: json!({CLIENT: 2}),
    });
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501);
    // …and a revocation the endpoint knows still lands.
    h.idp.set_epoch(EpochMode::Answer {
        aep: 5,
        agen: json!({CLIENT: 2}),
    });
    assert_eq!(verdict(&gw, Some(&h.token())).await.1, "token_revoked");
}

#[tokio::test]
async fn a_wrong_internal_secret_is_unknown_not_allowed() {
    let h = Harness::new().await;
    h.store.counters.lock().unwrap().clear();
    let endpoint =
        reqwest::Url::parse(&format!("{}/api/oauth/internal/epoch/", h.idp.issuer)).unwrap();
    let store: Arc<dyn Store> = h.store.clone();
    let gate = Gate::new(
        h.idp.issuer.clone(),
        "f2z-ai".into(),
        Arc::clone(&h.keys),
        Revocation::new(
            Some(Arc::clone(&store)),
            NS.into(),
            Some(Arc::new(HttpEpochSource::new(
                reqwest::Client::new(),
                endpoint,
                SecretString::from("wrong"),
                Duration::from_millis(300),
            ))),
        ),
        Limits::new(open_limits(), Some(store), NS.into()),
    );
    let mut headers = axum::http::HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        format!("Bearer {}", h.token()).parse().unwrap(),
    );
    let refusal = gate.admit(&headers).await.unwrap_err();
    assert_eq!(refusal.code(), "unavailable");
}

// ---------------------------------------------------------------------------
// Limits.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_rate_limit_is_429_with_retry_after_and_the_rate_headers() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            limits_config(60, 2, 4),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501);
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501);
    let response = call(&gw, Some(&h.token())).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    let headers = response.headers().clone();
    let retry: u64 = headers[header::RETRY_AFTER]
        .to_str()
        .unwrap()
        .parse()
        .unwrap();
    assert!((1..=2).contains(&retry), "{retry}");
    assert_eq!(headers["x-f2z-ratelimit-limit"], "60");
    assert_eq!(headers["x-f2z-ratelimit-remaining"], "0");
    assert!(headers.contains_key("x-f2z-ratelimit-reset"));
    assert_eq!(error_of(response).await["code"], "rate_limited");

    // Redis down: the local limit still holds.
    h.store.down.store(true, Ordering::SeqCst);
    assert_eq!(verdict(&gw, Some(&h.token())).await.1, "rate_limited");
}

#[tokio::test]
async fn the_shared_bucket_limits_across_pods() {
    let h = Harness::new().await;
    // Two gateways — two pods, each with its own local GCRA — share a store.
    let a = h
        .gateway(
            limits_config(60, 2, 4),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    let b = h
        .gateway(
            limits_config(60, 2, 4),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    assert_eq!(verdict(&a, Some(&h.token())).await.0, 501);
    assert_eq!(verdict(&a, Some(&h.token())).await.0, 501);
    // Pod b's local bucket is full; the shared one is not.
    assert_eq!(verdict(&b, Some(&h.token())).await.1, "rate_limited");
    // The control: with the store down, pod b falls back to local only and
    // admits — the documented degradation, for limits only.
    h.store.down.store(true, Ordering::SeqCst);
    assert_eq!(verdict(&b, Some(&h.token())).await.0, 501);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_concurrency_lease_counts_a_disconnected_call_until_it_is_settled() {
    let h = Harness::new().await;
    let (backend, mut streams) = ControlledBackend::new();
    let settler = RecordingSettler::default();
    let gw = h.gateway(open_limits(), backend, settler.clone()).await;

    let mut bodies = Vec::new();
    let mut senders = Vec::new();
    for _ in 0..4 {
        let response = call(&gw, Some(&h.token())).await;
        assert_eq!(response.status(), StatusCode::OK);
        bodies.push(response);
        senders.push(streams.recv().await.unwrap());
    }
    assert_eq!(h.store.open_leases(), 4);

    let response = call(&gw, Some(&h.token())).await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(response.headers().contains_key(header::RETRY_AFTER));
    let error = error_of(response).await;
    assert_eq!(error["code"], "concurrency_limit");
    assert_eq!(error["details"]["limit"], 4);

    // The client of one call disconnects. Its upstream is still being read,
    // so it still counts.
    drop(bodies.pop());
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(verdict(&gw, Some(&h.token())).await.1, "concurrency_limit");

    // Its upstream ends; it is settled; only then does its lease end.
    drop(senders.pop());
    wait_records(&settler, 1).await;
    let mut admitted = false;
    for _ in 0..100 {
        let response = call(&gw, Some(&h.token())).await;
        if response.status() == StatusCode::OK {
            admitted = true;
            drop(response);
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(admitted, "a settled call's lease was never released");
    drop(senders);
    drop(bodies);
}

struct PanickingBackend;

#[async_trait]
impl ChatBackend for PanickingBackend {
    async fn start(
        &self,
        _request: f2z_ai_proto::chat::ChatRequest,
        _catalog: Arc<f2z_ai::catalog::VerifiedCatalog>,
        _call: &f2z_ai::admission::CallHandle,
    ) -> Result<Box<dyn f2z_ai::call::Upstream>, f2z_ai::ApiFailure> {
        panic!("backend bug");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_panicking_call_does_not_leak_its_lease() {
    let h = Harness::new().await;
    let settler = RecordingSettler::default();
    // Concurrency 1: a leaked lease would refuse every later call.
    let gw = h
        .gateway(
            limits_config(100_000, 10_000, 1),
            Arc::new(PanickingBackend),
            settler.clone(),
        )
        .await;
    for n in 1..=3 {
        let response = call(&gw, Some(&h.token())).await;
        assert_eq!(
            response.status(),
            StatusCode::INTERNAL_SERVER_ERROR,
            "call {n}"
        );
        let records = wait_records(&settler, n).await;
        assert_eq!(
            records.last().unwrap().upstream,
            f2z_ai::settle::UpstreamEnd::Panicked
        );
        // The shared lease is released too (asynchronously).
        for _ in 0..100 {
            if h.store.open_leases() == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(h.store.open_leases(), 0, "call {n}");
    }
}

#[tokio::test]
async fn nothing_is_spent_on_a_refused_token() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            limits_config(60, 1, 4),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    // Many bad tokens, then a good one: the bucket (burst 1) is untouched.
    for _ in 0..5 {
        assert_eq!(verdict(&gw, Some("x.y.z")).await.0, 401);
        h.store.publish(5, 2);
        assert_eq!(verdict(&gw, Some(&h.token())).await.1, "token_revoked");
        h.store.publish(4, 2);
    }
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501);
}

// ---------------------------------------------------------------------------
// The real Redis, when one is provided.
// ---------------------------------------------------------------------------

/// Without `F2Z_AI_TEST_REDIS_URL` a real-Redis test is skipped, loudly; with
/// `F2Z_AI_REQUIRE_REDIS=1` (CI, which runs a Redis service) it fails instead.
fn skip_without_redis(message: &str) {
    assert!(
        std::env::var("F2Z_AI_REQUIRE_REDIS").as_deref() != Ok("1"),
        "F2Z_AI_REQUIRE_REDIS=1 but F2Z_AI_TEST_REDIS_URL is not set"
    );
    eprintln!("{message}");
}

/// Runs the Lua script and the counter read against a real Redis when
/// `F2Z_AI_TEST_REDIS_URL` is set (`docker run -p 6390:6379 redis:7` then
/// `F2Z_AI_TEST_REDIS_URL=redis://127.0.0.1:6390`). CI runs a Redis service and
/// sets both variables; elsewhere the test prints that it was skipped.
#[tokio::test]
async fn the_redis_store_against_a_real_redis() {
    let Ok(url) = std::env::var("F2Z_AI_TEST_REDIS_URL") else {
        skip_without_redis(
            "SKIPPED: F2Z_AI_TEST_REDIS_URL is not set; the Lua script was not exercised",
        );
        return;
    };
    use f2z_ai::auth::store::RedisStore;
    let store = RedisStore::new(&SecretString::from(url.clone()), Duration::from_secs(2)).unwrap();
    let client = redis::Client::open(url).unwrap();
    let mut raw = client.get_multiplexed_async_connection().await.unwrap();
    let ns = format!("f2zaitest{}", std::process::id());
    // What `epoch_publish` writes: plain decimal strings.
    let _: () = redis::cmd("SET")
        .arg(format!("{ns}:aep:{SUB}"))
        .arg("7")
        .query_async(&mut raw)
        .await
        .unwrap();
    let read = store
        .counters([
            &format!("{ns}:aep:{SUB}"),
            &format!("{ns}:agen:{CLIENT}:{SUB}"),
        ])
        .await
        .unwrap();
    assert_eq!(read, [Some("7".to_owned()), None]);

    let request = |member: &str| AdmitRequest {
        user_bucket: format!("{ns}:ai:rl:u:{CLIENT}:{SUB}"),
        app_bucket: format!("{ns}:ai:rl:a:{CLIENT}"),
        lease_key: format!("{ns}:ai:cc:{SUB}"),
        member: member.to_owned(),
        user_rate: Rate {
            per_minute: 60,
            burst: 3,
        },
        app_rate: Rate {
            per_minute: 6000,
            burst: 100,
        },
        lease_limit: 2,
        lease_ttl: Duration::from_secs(30),
    };
    assert_eq!(
        store.admit(&request("m1")).await.unwrap(),
        Admission::Admitted { remaining: 2 }
    );
    assert_eq!(
        store.admit(&request("m2")).await.unwrap(),
        Admission::Admitted { remaining: 1 }
    );
    // Two open: the lease refuses, and takes no token.
    assert!(matches!(
        store.admit(&request("m3")).await.unwrap(),
        Admission::Refused {
            by: Refusal::Concurrency,
            ..
        }
    ));
    store
        .release(&format!("{ns}:ai:cc:{SUB}"), "m1")
        .await
        .unwrap();
    assert_eq!(
        store.admit(&request("m3")).await.unwrap(),
        Admission::Admitted { remaining: 0 }
    );
    store
        .release(&format!("{ns}:ai:cc:{SUB}"), "m2")
        .await
        .unwrap();
    // A renew re-adds a member Redis lost (m1 was released above), and a
    // release then removes it.
    let lease_key = format!("{ns}:ai:cc:{SUB}");
    store
        .renew(&lease_key, "m1", Duration::from_secs(30))
        .await
        .unwrap();
    let score: Option<f64> = redis::cmd("ZSCORE")
        .arg(&lease_key)
        .arg("m1")
        .query_async(&mut raw)
        .await
        .unwrap();
    assert!(score.is_some(), "renew did not re-add a lost member");
    store.release(&lease_key, "m1").await.unwrap();
    // The bucket (burst 3) is empty: refused by the user bucket, with a wait
    // of about one second (60 per minute).
    match store.admit(&request("m4")).await.unwrap() {
        Admission::Refused {
            by: Refusal::User,
            retry_after_ms,
        } => assert!((1..=1000).contains(&retry_after_ms), "{retry_after_ms}"),
        other => panic!("{other:?}"),
    }
    let _: () = redis::cmd("DEL")
        .arg(format!("{ns}:aep:{SUB}"))
        .arg(format!("{ns}:ai:rl:u:{CLIENT}:{SUB}"))
        .arg(format!("{ns}:ai:rl:a:{CLIENT}"))
        .arg(format!("{ns}:ai:cc:{SUB}"))
        .query_async(&mut raw)
        .await
        .unwrap();
}

/// The whole gate on a real Redis (same opt-in as above): revocation read
/// from the keys `epoch_publish` writes, and a panicking call's lease removed
/// from the real sorted set.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_gate_on_a_real_redis() {
    let Ok(url) = std::env::var("F2Z_AI_TEST_REDIS_URL") else {
        skip_without_redis(
            "SKIPPED: F2Z_AI_TEST_REDIS_URL is not set; the gate never met a real Redis",
        );
        return;
    };
    use f2z_ai::auth::store::RedisStore;
    let h = Harness::new().await;
    let ns = format!("f2zaigate{}", std::process::id());
    let client = redis::Client::open(url.clone()).unwrap();
    let mut raw = client.get_multiplexed_async_connection().await.unwrap();
    let setter = raw.clone();
    let set = |key: String, value: &'static str| {
        let mut raw = setter.clone();
        async move {
            let _: () = redis::cmd("SET")
                .arg(key)
                .arg(value)
                .arg("EX")
                .arg(300)
                .query_async(&mut raw)
                .await
                .unwrap();
        }
    };
    set(format!("{ns}:aep:{SUB}"), "4").await;
    set(format!("{ns}:agen:{CLIENT}:{SUB}"), "2").await;

    let store: Arc<dyn Store> =
        Arc::new(RedisStore::new(&SecretString::from(url), Duration::from_secs(1)).unwrap());
    let endpoint =
        reqwest::Url::parse(&format!("{}/api/oauth/internal/epoch/", h.idp.issuer)).unwrap();
    h.idp.set_epoch(EpochMode::Status(503));
    let gate = Gate::new(
        h.idp.issuer.clone(),
        "f2z-ai".into(),
        Arc::clone(&h.keys),
        Revocation::new(
            Some(Arc::clone(&store)),
            ns.clone(),
            Some(Arc::new(HttpEpochSource::new(
                reqwest::Client::new(),
                endpoint,
                SecretString::from(SECRET),
                Duration::from_millis(300),
            ))),
        ),
        Limits::new(limits_config(100_000, 10_000, 1), Some(store), ns.clone()),
    );
    let settler = RecordingSettler::default();
    let gw = Gateway::bind(
        &config(&[]),
        Deps {
            gate: Arc::new(gate),
            catalog: fixed_catalog(),
            backend: Arc::new(PanickingBackend),
            settler: Arc::new(settler.clone()),
        },
    )
    .await
    .unwrap();

    let lease_key = format!("{ns}:ai:cc:{SUB}");
    for n in 1..=3 {
        assert_eq!(call(&gw, Some(&h.token())).await.status(), 500, "call {n}");
        wait_records(&settler, n).await;
        let mut open = 1;
        for _ in 0..100 {
            open = redis::cmd("ZCARD")
                .arg(&lease_key)
                .query_async::<i64>(&mut raw)
                .await
                .unwrap();
            if open == 0 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(open, 0, "call {n}: the lease stayed in Redis");
    }
    // Revocation from the real keys; the endpoint is down, so nothing else
    // could have answered.
    set(format!("{ns}:agen:{CLIENT}:{SUB}"), "3").await;
    let (status, code, reason) = verdict(&gw, Some(&h.token())).await;
    assert_eq!(
        (status, code.as_str(), reason.as_str().unwrap()),
        (401, "token_revoked", "grant_generation")
    );
    assert_eq!(h.idp.epoch_calls.load(Ordering::SeqCst), 0);

    let _: () = redis::cmd("DEL")
        .arg(format!("{ns}:aep:{SUB}"))
        .arg(format!("{ns}:agen:{CLIENT}:{SUB}"))
        .arg(format!("{ns}:ai:rl:u:{CLIENT}:{SUB}"))
        .arg(format!("{ns}:ai:rl:a:{CLIENT}"))
        .arg(&lease_key)
        .query_async(&mut raw)
        .await
        .unwrap();
}

#[tokio::test]
async fn without_auth_configured_every_call_is_refused() {
    let h = Harness::new().await;
    let gw = Gateway::bind(
        &config(&[]),
        Deps {
            gate: Arc::new(f2z_ai::auth::Unconfigured),
            catalog: fixed_catalog(),
            backend: not_implemented(),
            settler: Arc::new(RecordingSettler::default()),
        },
    )
    .await
    .unwrap();
    for token in [Some(h.token()), None] {
        let (status, code, reason) = verdict(&gw, token.as_deref()).await;
        assert_eq!(
            (status, code.as_str(), reason.as_str().unwrap()),
            (503, "unavailable", "token_keys")
        );
    }
}

#[tokio::test]
async fn a_lease_whose_admit_reply_was_lost_is_still_released() {
    let h = Harness::new().await;
    let gw = h
        .gateway(
            open_limits(),
            not_implemented(),
            RecordingSettler::default(),
        )
        .await;
    // Redis runs the script (the member is added) but the reply never
    // arrives: the gateway falls back to local limits and must still own the
    // member's removal.
    h.store.lose_admit_replies.store(true, Ordering::SeqCst);
    for _ in 0..6 {
        assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501);
    }
    h.store.lose_admit_replies.store(false, Ordering::SeqCst);
    for _ in 0..100 {
        if h.store.open_leases() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(h.store.open_leases(), 0, "orphaned lease members");
    // And the user is not locked out of the shared limit.
    assert_eq!(verdict(&gw, Some(&h.token())).await.0, 501);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_outliving_the_lease_ttl_still_counts_on_another_pod() {
    let h = Harness::new().await;
    let (backend, mut streams) = ControlledBackend::new();
    let mut short = limits_config(100_000, 10_000, 1);
    short.lease_ttl = Duration::from_millis(300);
    let a = h.gateway(short, backend, RecordingSettler::default()).await;
    let b = h
        .gateway(short, not_implemented(), RecordingSettler::default())
        .await;
    let body = call(&a, Some(&h.token())).await;
    assert_eq!(body.status(), StatusCode::OK);
    let sender = streams.recv().await.unwrap();
    // Four TTLs later the call is still open on pod a: pod b must still see it.
    tokio::time::sleep(Duration::from_millis(1200)).await;
    assert_eq!(verdict(&b, Some(&h.token())).await.1, "concurrency_limit");
    drop(sender);
    drop(body);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_call_admitted_during_a_redis_outage_counts_again_once_redis_is_back() {
    let h = Harness::new().await;
    let (backend, mut streams) = ControlledBackend::new();
    let mut short = limits_config(100_000, 10_000, 1);
    // Long enough that only a release, not the TTL, can clear the member
    // within the final poll; a renewal fires every second.
    short.lease_ttl = Duration::from_secs(3);
    let a = h.gateway(short, backend, RecordingSettler::default()).await;
    let b = h
        .gateway(short, not_implemented(), RecordingSettler::default())
        .await;
    // Pod a admits a call while Redis is down: no member is written.
    h.store.down.store(true, Ordering::SeqCst);
    h.idp.set_epoch(EpochMode::Answer {
        aep: 4,
        agen: json!({CLIENT: 2}),
    });
    let body = call(&a, Some(&h.token())).await;
    assert_eq!(body.status(), StatusCode::OK);
    let sender = streams.recv().await.unwrap();
    assert_eq!(h.store.open_leases(), 0);
    // Redis comes back; within a renewal period the live call is counted
    // again, so pod b refuses the user's second call.
    h.store.down.store(false, Ordering::SeqCst);
    tokio::time::sleep(Duration::from_millis(1300)).await;
    assert_eq!(h.store.open_leases(), 1);
    assert_eq!(verdict(&b, Some(&h.token())).await.1, "concurrency_limit");
    // The call ends: its member is released, not left to expire.
    drop(sender);
    drop(body);
    for _ in 0..100 {
        if h.store.open_leases() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(h.store.open_leases(), 0);
}
