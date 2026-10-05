//! Small axum fakes of the three servers the SDK talks to, shaped after the
//! contract (`docs/free2z/sdk/spec/*`) and the account service implementation:
//!
//! * **the issuer** — discovery, an authorization endpoint that approves at
//!   once and redirects with `code`, `state` and `iss` (RFC 9207), PKCE S256
//!   checked at the token endpoint, RS256 ID tokens, rotating refresh tokens
//!   in families with a configurable grace for the immediately previous
//!   token and reuse → `invalid_grant` + family revoked, and RFC 7009
//!   revocation;
//! * **the account API** — `GET /api/sdk/v1/balance`, `POST
//!   /api/sdk/v1/purchases` (Idempotency-Key required and replayed) and
//!   `GET /api/sdk/v1/purchases/{id}`;
//! * **the gateway** — `POST /v1/chat` streaming scripted SSE per model
//!   name, `GET /v1/calls/{id}`, `GET /v1/models` with an ETag,
//!   `POST /v1/chat/estimate`.
//!
//! Also used by `examples/full_flow.rs` (`#[path]`), so it must stay free of
//! test-only macros.

#![allow(
    dead_code,
    missing_docs,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::result_large_err
)]

use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, Response, StatusCode, Uri, header};
use axum::routing::{get, post};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use bytes::Bytes;
use f2z_sdk::oauth::{AuthSession, AuthorizationRequest, BoxFuture};
use serde_json::{Value, json};

pub const CLIENT_ID: &str = "app_test";
pub const SUBJECT: &str = "3f0c9b7e-6a2d-4b1f-8e5c-2d9a7c4e1b60";
pub const KID: &str = "test-rs-1";

/// A 2048-bit RSA key (PKCS#1 DER, base64) generated for this test suite
/// only. It signs the fake issuer's ID tokens and nothing else; it has never
/// been, and must never be, used outside these tests.
const TEST_RSA_KEY_B64: &str = include_str!("test_rsa_key.b64");

// ----------------------------------------------------------------------
// State
// ----------------------------------------------------------------------

#[derive(Clone, Debug)]
struct CodeGrant {
    challenge: String,
    redirect_uri: String,
    nonce: Option<String>,
    scope: String,
    used: bool,
}

#[derive(Clone, Debug)]
enum RState {
    Current,
    Rotated {
        at: Instant,
        successor: String,
        successor_access: String,
    },
}

#[derive(Clone, Debug)]
struct Refresh {
    family: u64,
    scope: String,
    state: RState,
}

#[derive(Clone, Debug)]
struct Access {
    scope: String,
    valid: bool,
    revoked: bool,
}

#[derive(Default)]
struct IssuerState {
    codes: HashMap<String, CodeGrant>,
    refresh: HashMap<String, Refresh>,
    access: HashMap<String, Access>,
    revoked_families: HashSet<u64>,
    next_id: u64,
}

#[derive(Default)]
struct PurchaseState {
    intents: HashMap<String, Value>,
    keys: HashMap<String, (String, String)>,
    polls: HashMap<String, u32>,
}

#[derive(Default)]
struct GatewayState {
    /// Every `/v1/chat` request: (model, Idempotency-Key).
    calls: Vec<(String, String)>,
    /// Finished call records by key and by call id.
    records_by_key: HashMap<String, Value>,
    records_by_id: HashMap<String, Value>,
    next_call: u64,
}

/// Knobs and counters shared by the fakes.
pub struct Fake {
    pub issuer: String,
    pub api_base: String,
    pub ai_base: String,
    rsa: ring::signature::RsaKeyPair,
    jwk_n: String,
    jwk_e: String,
    issuer_state: Mutex<IssuerState>,
    purchases: Mutex<PurchaseState>,
    gateway: Mutex<GatewayState>,

    /// How long the IdP accepts the immediately previous refresh token after
    /// a rotation (the spec's 60 s; zero to make any overlap a reuse).
    pub grace: Mutex<Duration>,
    /// Delay added to every refresh answer, to widen a race window.
    pub refresh_delay: Mutex<Duration>,
    pub refresh_body_delay: Mutex<Duration>,
    pub break_refresh_response_once: AtomicBool,
    pub broken_purchase_bodies: AtomicU32,
    pub broken_chat_replay: AtomicBool,
    /// Scopes the "user" declines at consent.
    pub declined_scopes: Mutex<Vec<String>>,
    /// Sign ID tokens with this nonce instead of the request's.
    pub id_token_nonce_override: Mutex<Option<String>>,
    /// The balance endpoint demands step-up.
    pub require_step_up: AtomicBool,
    /// The first purchase create sleeps this long before answering.
    pub create_delay_first: Mutex<Duration>,
    /// Delay before the revocation endpoint answers.
    pub revoke_delay: Mutex<Duration>,
    pub refuse_revocation: AtomicBool,
    /// Delay before the balance endpoint looks at the token.
    pub balance_delay: Mutex<Duration>,
    pub grant_delay: Mutex<Duration>,
    pub grant_body: Mutex<Value>,
    pub grant_calls: AtomicU32,
    /// A purchase is credited after this many polls.
    pub credit_after_polls: AtomicU32,
    /// `error-before-meta` fails this many calls before succeeding.
    pub fail_first: AtomicU32,

    pub auth_code_calls: AtomicU32,
    pub refresh_calls: AtomicU32,
    pub revoke_calls: AtomicU32,
    pub authorize_calls: AtomicU32,
    pub create_calls: AtomicU32,
    pub hang_disconnected: AtomicBool,
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

fn b64url_sha256(input: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(&ring::digest::SHA256, input).as_ref())
}

fn random_token(prefix: &str, n: u64) -> String {
    let mut bytes = [0u8; 16];
    ring::rand::SecureRandom::fill(&ring::rand::SystemRandom::new(), &mut bytes).unwrap();
    format!("{prefix}{n}_{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn query_map(query: Option<&str>) -> HashMap<String, String> {
    url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .into_owned()
        .collect()
}

fn json_response(status: StatusCode, body: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn oauth_error(status: StatusCode, error: &str, description: &str) -> Response<Body> {
    json_response(
        status,
        json!({"error": error, "error_description": description}),
    )
}

pub fn envelope(status: StatusCode, code: &str, details: Option<Value>) -> Response<Body> {
    let mut error = json!({"code": code, "message": format!("fake {code}")});
    if let Some(d) = details {
        error["details"] = d;
    }
    json_response(status, json!({"error": error}))
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::to_owned)
}

impl Fake {
    fn new_bare() -> Self {
        let der = STANDARD
            .decode(TEST_RSA_KEY_B64.split_whitespace().collect::<String>())
            .unwrap();
        let rsa = ring::signature::RsaKeyPair::from_der(&der).unwrap();
        let components = ring::signature::RsaPublicKeyComponents::<Vec<u8>>::from(rsa.public());
        Self {
            issuer: String::new(),
            api_base: String::new(),
            ai_base: String::new(),
            jwk_n: URL_SAFE_NO_PAD.encode(&components.n),
            jwk_e: URL_SAFE_NO_PAD.encode(&components.e),
            rsa,
            issuer_state: Mutex::default(),
            purchases: Mutex::default(),
            gateway: Mutex::default(),
            grace: Mutex::new(Duration::from_secs(60)),
            refresh_delay: Mutex::new(Duration::ZERO),
            refresh_body_delay: Mutex::new(Duration::ZERO),
            break_refresh_response_once: AtomicBool::new(false),
            broken_purchase_bodies: AtomicU32::new(0),
            broken_chat_replay: AtomicBool::new(false),
            declined_scopes: Mutex::default(),
            id_token_nonce_override: Mutex::default(),
            require_step_up: AtomicBool::new(false),
            create_delay_first: Mutex::new(Duration::ZERO),
            revoke_delay: Mutex::new(Duration::ZERO),
            refuse_revocation: AtomicBool::new(false),
            balance_delay: Mutex::new(Duration::ZERO),
            grant_delay: Mutex::new(Duration::ZERO),
            grant_calls: AtomicU32::new(0),
            grant_body: Mutex::new(json!({"sub": SUBJECT, "client_id": CLIENT_ID,
                "account_epoch": 4, "grant_generation": 2, "scopes":["ai:invoke"],
                "spend_cap_2z": 500, "cap_period":"total", "enforced":true,
                "as_of":"2026-09-28T00:00:00Z"})),
            credit_after_polls: AtomicU32::new(1),
            fail_first: AtomicU32::new(1),
            auth_code_calls: AtomicU32::new(0),
            refresh_calls: AtomicU32::new(0),
            revoke_calls: AtomicU32::new(0),
            authorize_calls: AtomicU32::new(0),
            create_calls: AtomicU32::new(0),
            hang_disconnected: AtomicBool::new(false),
        }
    }

    /// Start the issuer + account API on one port and the gateway on
    /// another, both on 127.0.0.1.
    pub async fn start() -> Arc<Self> {
        let issuer_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer_addr: SocketAddr = issuer_listener.local_addr().unwrap();
        let gateway_addr: SocketAddr = gateway_listener.local_addr().unwrap();
        let mut fake = Self::new_bare();
        fake.issuer = format!("http://{issuer_addr}");
        fake.api_base = format!("http://{issuer_addr}/api/sdk/v1");
        fake.ai_base = format!("http://{gateway_addr}/v1");
        let fake = Arc::new(fake);

        let issuer_app = Router::new()
            .route("/.well-known/openid-configuration", get(discovery))
            .route("/oauth/authorize", get(authorize))
            .route("/api/oauth/token", post(token))
            .route("/api/oauth/jwks", get(jwks))
            .route("/api/oauth/revoke", post(revoke))
            .route("/api/sdk/v1/balance", get(balance))
            .route("/api/sdk/v1/grant", get(grant))
            .route("/api/sdk/v1/purchases", post(create_purchase))
            .route("/api/sdk/v1/purchases/{id}", get(get_purchase))
            .with_state(Arc::clone(&fake));
        let gateway_app = Router::new()
            .route("/v1/chat", post(chat))
            .route("/v1/chat/estimate", post(estimate))
            .route("/v1/models", get(models))
            .route("/v1/calls/{id}", get(call_record))
            .with_state(Arc::clone(&fake));
        tokio::spawn(async move {
            axum::serve(issuer_listener, issuer_app).await.unwrap();
        });
        tokio::spawn(async move {
            axum::serve(gateway_listener, gateway_app).await.unwrap();
        });
        fake
    }

    pub fn config(&self) -> f2z_sdk::Config {
        f2z_sdk::Config::new(CLIENT_ID)
            .with_issuer(&self.issuer)
            .with_api_base(&self.api_base)
            .with_ai_base(&self.ai_base)
            .with_callback_timeout(Duration::from_secs(10))
    }

    /// Every access token stops working (as after its five minutes): the
    /// resource servers answer `401 invalid_token`.
    pub fn expire_access_tokens(&self) {
        for a in self.issuer_state.lock().unwrap().access.values_mut() {
            a.valid = false;
        }
    }

    /// The user revoked the app: tokens answer `401 token_revoked`, and every
    /// refresh family is dead.
    pub fn revoke_grant(&self) {
        let mut s = self.issuer_state.lock().unwrap();
        for a in s.access.values_mut() {
            a.revoked = true;
        }
        let families: Vec<u64> = s.refresh.values().map(|r| r.family).collect();
        s.revoked_families.extend(families);
    }

    pub fn live_refresh_tokens(&self) -> usize {
        let s = self.issuer_state.lock().unwrap();
        s.refresh
            .values()
            .filter(|r| {
                matches!(r.state, RState::Current) && !s.revoked_families.contains(&r.family)
            })
            .count()
    }

    pub fn chat_calls(&self) -> Vec<(String, String)> {
        self.gateway.lock().unwrap().calls.clone()
    }

    pub fn intents(&self) -> usize {
        self.purchases.lock().unwrap().intents.len()
    }

    fn sign_jwt(&self, header: &Value, claims: &Value) -> String {
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let mut sig = vec![0u8; self.rsa.public().modulus_len()];
        self.rsa
            .sign(
                &ring::signature::RSA_PKCS1_SHA256,
                &ring::rand::SystemRandom::new(),
                input.as_bytes(),
                &mut sig,
            )
            .unwrap();
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig))
    }

    /// Mint a token pair for a new or existing family.
    fn mint(&self, s: &mut IssuerState, family: u64, scope: &str) -> (String, String) {
        s.next_id += 1;
        let access = random_token("at", s.next_id);
        let refresh = random_token("rt", s.next_id);
        s.access.insert(
            access.clone(),
            Access {
                scope: scope.to_owned(),
                valid: true,
                revoked: false,
            },
        );
        s.refresh.insert(
            refresh.clone(),
            Refresh {
                family,
                scope: scope.to_owned(),
                state: RState::Current,
            },
        );
        (access, refresh)
    }

    /// Check a bearer token for a resource server: `Ok(scope)` or the 401.
    fn check_bearer(&self, headers: &HeaderMap) -> Result<String, Response<Body>> {
        let unauthorized = |code: &str| {
            let mut r = envelope(StatusCode::UNAUTHORIZED, code, None);
            r.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                format!("Bearer error=\"{code}\"").parse().unwrap(),
            );
            r
        };
        let Some(token) = bearer(headers) else {
            return Err(unauthorized("invalid_token"));
        };
        let s = self.issuer_state.lock().unwrap();
        match s.access.get(&token) {
            Some(a) if a.revoked => Err(unauthorized("token_revoked")),
            Some(a) if a.valid => Ok(a.scope.clone()),
            _ => Err(unauthorized("invalid_token")),
        }
    }
}

// ----------------------------------------------------------------------
// Issuer
// ----------------------------------------------------------------------

async fn discovery(State(f): State<Arc<Fake>>) -> Response<Body> {
    let i = &f.issuer;
    json_response(
        StatusCode::OK,
        json!({
            "issuer": i,
            "authorization_endpoint": format!("{i}/oauth/authorize"),
            "token_endpoint": format!("{i}/api/oauth/token"),
            "userinfo_endpoint": format!("{i}/api/oauth/userinfo"),
            "jwks_uri": format!("{i}/api/oauth/jwks"),
            "revocation_endpoint": format!("{i}/api/oauth/revoke"),
            "response_types_supported": ["code"],
            "grant_types_supported": ["authorization_code", "refresh_token"],
            "code_challenge_methods_supported": ["S256"],
            "id_token_signing_alg_values_supported": ["RS256"],
            "authorization_response_iss_parameter_supported": true,
            "dpop_signing_alg_values_supported": ["ES256"],
            "something_new": {"the": "client must ignore this"}
        }),
    )
}

async fn jwks(State(f): State<Arc<Fake>>) -> Response<Body> {
    json_response(
        StatusCode::OK,
        json!({"keys": [
            {"kty": "EC", "kid": "es-1", "crv": "P-256", "x": "AA", "y": "AA", "alg": "ES256", "use": "sig"},
            {"kty": "RSA", "kid": KID, "alg": "RS256", "use": "sig", "n": f.jwk_n, "e": f.jwk_e}
        ]}),
    )
}

/// The loopback rule of RFC 8252 §7.3 as the IdP applies it: the registered
/// `http://127.0.0.1:0/callback` matches any port.
fn redirect_allowed(uri: &str) -> bool {
    let Ok(u) = url::Url::parse(uri) else {
        return false;
    };
    (u.scheme() == "http"
        && u.host_str() == Some("127.0.0.1")
        && (u.path() == "/callback" || u.path() == "/cb"))
        || uri == "com.example.tutor:/oauth/callback"
}

async fn authorize(State(f): State<Arc<Fake>>, uri: Uri) -> Response<Body> {
    f.authorize_calls.fetch_add(1, Ordering::SeqCst);
    let q = query_map(uri.query());
    let get = |k: &str| q.get(k).cloned();
    if get("client_id").as_deref() != Some(CLIENT_ID) {
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "unknown client");
    }
    let Some(redirect_uri) = get("redirect_uri").filter(|r| redirect_allowed(r)) else {
        // Never redirect to an unregistered URI (RFC 6749 §4.1.2.1).
        return oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "redirect_uri");
    };
    let state = get("state").unwrap_or_default();
    let redirect_with = |params: Vec<(&str, String)>| {
        let mut target = url::Url::parse(&redirect_uri).unwrap();
        {
            let mut qp = target.query_pairs_mut();
            for (k, v) in params {
                qp.append_pair(k, &v);
            }
            qp.append_pair("state", &state);
            qp.append_pair("iss", &f.issuer);
        }
        Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, target.as_str())
            .body(Body::empty())
            .unwrap()
    };
    let scope = get("scope").unwrap_or_default();
    let challenge_ok = get("code_challenge_method").as_deref() == Some("S256")
        && get("code_challenge").is_some_and(|c| c.len() == 43);
    let openid = scope.split(' ').any(|s| s == "openid");
    if get("response_type").as_deref() != Some("code")
        || !challenge_ok
        || state.len() < 22
        || (openid && get("nonce").is_none())
    {
        return redirect_with(vec![("error", "invalid_request".into())]);
    }
    let declined = f.declined_scopes.lock().unwrap().clone();
    let granted: Vec<&str> = scope
        .split(' ')
        .filter(|s| !declined.iter().any(|d| d == s))
        .collect();
    let code = {
        let mut s = f.issuer_state.lock().unwrap();
        s.next_id += 1;
        let code = random_token("code", s.next_id);
        s.codes.insert(
            code.clone(),
            CodeGrant {
                challenge: get("code_challenge").unwrap(),
                redirect_uri: redirect_uri.clone(),
                nonce: get("nonce"),
                scope: granted.join(" "),
                used: false,
            },
        );
        code
    };
    redirect_with(vec![("code", code)])
}

async fn token(State(f): State<Arc<Fake>>, body: Bytes) -> Response<Body> {
    let form: HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
    let get = |k: &str| form.get(k).cloned().unwrap_or_default();
    if get("client_id") != CLIENT_ID {
        return oauth_error(StatusCode::UNAUTHORIZED, "invalid_client", "unknown client");
    }
    match get("grant_type").as_str() {
        "authorization_code" => {
            f.auth_code_calls.fetch_add(1, Ordering::SeqCst);
            let mut s = f.issuer_state.lock().unwrap();
            let Some(grant) = s.codes.get_mut(&get("code")) else {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", "unknown code");
            };
            if grant.used {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", "code used");
            }
            grant.used = true;
            let grant = grant.clone();
            if grant.redirect_uri != get("redirect_uri") {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", "redirect_uri");
            }
            let verifier = get("code_verifier");
            if !(43..=128).contains(&verifier.len())
                || b64url_sha256(verifier.as_bytes()) != grant.challenge
            {
                return oauth_error(
                    StatusCode::BAD_REQUEST,
                    "invalid_grant",
                    "PKCE verifier mismatch",
                );
            }
            s.next_id += 1;
            let family = s.next_id;
            let (access, refresh) = f.mint(&mut s, family, &grant.scope);
            drop(s);
            let mut body = json!({
                "token_type": "Bearer",
                "access_token": access,
                "expires_in": 300,
                "scope": grant.scope,
            });
            if grant.scope.split(' ').any(|x| x == "offline_access") {
                body["refresh_token"] = json!(refresh);
            }
            if grant.scope.split(' ').any(|x| x == "openid") {
                let nonce = f
                    .id_token_nonce_override
                    .lock()
                    .unwrap()
                    .clone()
                    .or(grant.nonce.clone());
                let now = now_unix();
                let claims = json!({
                    "iss": f.issuer, "sub": SUBJECT, "aud": CLIENT_ID,
                    "exp": now + 3600, "iat": now, "auth_time": now - 10,
                    "nonce": nonce, "acr": "urn:f2z:acr:1fa", "amr": ["pwd"],
                    "preferred_username": "tutor_user"
                });
                body["id_token"] =
                    json!(f.sign_jwt(&json!({"alg": "RS256", "kid": KID, "typ": "JWT"}), &claims));
            }
            json_response(StatusCode::OK, body)
        }
        "refresh_token" => {
            f.refresh_calls.fetch_add(1, Ordering::SeqCst);
            let delay = *f.refresh_delay.lock().unwrap();
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let grace = *f.grace.lock().unwrap();
            let presented = get("refresh_token");
            let mut s = f.issuer_state.lock().unwrap();
            let Some(entry) = s.refresh.get(&presented).cloned() else {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", "unknown");
            };
            if s.revoked_families.contains(&entry.family) {
                return oauth_error(StatusCode::BAD_REQUEST, "invalid_grant", "revoked");
            }
            match entry.state {
                RState::Current => {
                    let (access, refresh) = f.mint(&mut s, entry.family, &entry.scope);
                    s.refresh.insert(
                        presented,
                        Refresh {
                            state: RState::Rotated {
                                at: Instant::now(),
                                successor: refresh.clone(),
                                successor_access: access.clone(),
                            },
                            ..entry.clone()
                        },
                    );
                    if f.break_refresh_response_once.swap(false, Ordering::SeqCst) {
                        return broken_json(StatusCode::OK);
                    }
                    delayed_json(
                        json!({"token_type": "Bearer", "access_token": access, "expires_in": 300,
                               "refresh_token": refresh, "scope": entry.scope}),
                        *f.refresh_body_delay.lock().unwrap(),
                    )
                }
                RState::Rotated {
                    at,
                    successor,
                    successor_access,
                } => {
                    let successor_current = s
                        .refresh
                        .get(&successor)
                        .is_some_and(|r| matches!(r.state, RState::Current));
                    if at.elapsed() < grace && successor_current {
                        // The spec's 60 s grace: the same successor again.
                        json_response(
                            StatusCode::OK,
                            json!({"token_type": "Bearer", "access_token": successor_access,
                                   "expires_in": 300, "refresh_token": successor,
                                   "scope": entry.scope}),
                        )
                    } else {
                        // Reuse: the whole family dies.
                        s.revoked_families.insert(entry.family);
                        oauth_error(
                            StatusCode::BAD_REQUEST,
                            "invalid_grant",
                            "refresh token reuse",
                        )
                    }
                }
            }
        }
        _ => oauth_error(StatusCode::BAD_REQUEST, "unsupported_grant_type", ""),
    }
}

async fn revoke(State(f): State<Arc<Fake>>, body: Bytes) -> Response<Body> {
    let delay = *f.revoke_delay.lock().unwrap();
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    f.revoke_calls.fetch_add(1, Ordering::SeqCst);
    if f.refuse_revocation.load(Ordering::SeqCst) {
        return Response::builder()
            .status(StatusCode::SERVICE_UNAVAILABLE)
            .body(Body::empty())
            .unwrap();
    }
    let form: HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
    let token = form.get("token").cloned().unwrap_or_default();
    let mut s = f.issuer_state.lock().unwrap();
    if s.access.contains_key(&token) {
        return oauth_error(
            StatusCode::BAD_REQUEST,
            "unsupported_token_type",
            "access token",
        );
    }
    if let Some(family) = s.refresh.get(&token).map(|r| r.family) {
        s.revoked_families.insert(family);
    }
    Response::builder()
        .status(StatusCode::OK)
        .body(Body::empty())
        .unwrap()
}

// ----------------------------------------------------------------------
// Account API
// ----------------------------------------------------------------------

fn has_scope(scope: &str, want: &str) -> bool {
    scope.split(' ').any(|s| s == want)
}

async fn grant(State(f): State<Arc<Fake>>, headers: HeaderMap) -> Response<Body> {
    let scope = match f.check_bearer(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if !has_scope(&scope, "ai:invoke") {
        return envelope(
            StatusCode::FORBIDDEN,
            "insufficient_scope",
            Some(json!({"scope":"ai:invoke"})),
        );
    }
    f.grant_calls.fetch_add(1, Ordering::SeqCst);
    let body = f.grant_body.lock().unwrap().clone();
    let delay = *f.grant_delay.lock().unwrap();
    tokio::time::sleep(delay).await;
    json_response(StatusCode::OK, body)
}

async fn balance(State(f): State<Arc<Fake>>, headers: HeaderMap) -> Response<Body> {
    let delay = *f.balance_delay.lock().unwrap();
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    let scope = match f.check_bearer(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if f.require_step_up.load(Ordering::SeqCst) {
        let mut r = envelope(
            StatusCode::UNAUTHORIZED,
            "insufficient_user_authentication",
            Some(json!({"max_age": 300})),
        );
        r.headers_mut().insert(
            header::WWW_AUTHENTICATE,
            "Bearer error=\"insufficient_user_authentication\", max_age=\"300\", acr_values=\"urn:f2z:acr:mfa\""
                .parse()
                .unwrap(),
        );
        return r;
    }
    if !has_scope(&scope, "balance:read") {
        return envelope(
            StatusCode::FORBIDDEN,
            "insufficient_scope",
            Some(json!({"scope": "balance:read"})),
        );
    }
    let credited: u64 = f
        .purchases
        .lock()
        .unwrap()
        .intents
        .values()
        .filter_map(|i| i["credited_milli_2z"].as_u64())
        .sum();
    json_response(
        StatusCode::OK,
        json!({"available_milli_2z": 41_500 + credited, "held_milli_2z": 2000,
               "balance_milli_2z": 43_500 + credited, "debt_milli_2z": 0,
               "as_of": "2026-09-26T21:04:14Z"}),
    )
}

async fn create_purchase(
    State(f): State<Arc<Fake>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    let n = f.create_calls.fetch_add(1, Ordering::SeqCst);
    let scope = match f.check_bearer(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if !has_scope(&scope, "purchase:create") {
        return envelope(StatusCode::FORBIDDEN, "insufficient_scope", None);
    }
    let Some(key) = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
    else {
        return envelope(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            Some(json!({"field": "Idempotency-Key"})),
        );
    };
    let fingerprint = String::from_utf8_lossy(&body).into_owned();
    let replay = {
        let p = f.purchases.lock().unwrap();
        p.keys.get(&key).cloned()
    };
    if let Some((id, fp)) = replay {
        if fp != fingerprint {
            return envelope(
                StatusCode::CONFLICT,
                "idempotency_conflict",
                Some(json!({"in_flight": false})),
            );
        }
        let intent = f.purchases.lock().unwrap().intents[&id].clone();
        if f.broken_purchase_bodies.load(Ordering::SeqCst) == 2 {
            return broken_json(StatusCode::CREATED);
        }
        return json_response(StatusCode::CREATED, intent);
    }
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    if req["rail"] != "card" {
        return envelope(
            StatusCode::BAD_REQUEST,
            "rail_unavailable",
            Some(json!({"rail": req["rail"]})),
        );
    }
    let quantity = req["quantity_2z"].as_u64().unwrap_or(0);
    if !(100..=10_000).contains(&quantity) {
        return envelope(
            StatusCode::BAD_REQUEST,
            "invalid_quantity",
            Some(json!({"min_2z": 100, "max_2z": 10_000})),
        );
    }
    let id = format!("0f6e3b2a-7c1d-4e8f-9a0b-{:012x}", n);
    let intent = json!({
        "id": id, "rail": "card", "status": "pending", "quantity_2z": quantity,
        "price": {"currency": "USD", "amount_minor": quantity},
        "pricing_version": "2026-09-01", "created_at": "2026-09-26T21:10:00Z",
        "expires_at": "2026-09-26T21:40:00Z", "credited_at": null, "credited_milli_2z": null,
        "rail_data": {"checkout_url": format!("https://checkout.example/c/pay/cs_test_{n}")}
    });
    {
        let mut p = f.purchases.lock().unwrap();
        p.intents.insert(id.clone(), intent.clone());
        p.keys.insert(key, (id, fingerprint));
    }
    // After the intent exists: a client whose request timed out here must
    // get THIS intent back when it re-sends the key.
    let delay = if n == 0 {
        *f.create_delay_first.lock().unwrap()
    } else {
        Duration::ZERO
    };
    if !delay.is_zero() {
        tokio::time::sleep(delay).await;
    }
    if f.broken_purchase_bodies.load(Ordering::SeqCst) > 0 {
        return broken_json(StatusCode::CREATED);
    }
    json_response(StatusCode::CREATED, intent)
}

async fn get_purchase(State(f): State<Arc<Fake>>, headers: HeaderMap, uri: Uri) -> Response<Body> {
    if let Err(r) = f.check_bearer(&headers) {
        return r;
    }
    let id = uri.path().rsplit('/').next().unwrap_or("").to_owned();
    let mut p = f.purchases.lock().unwrap();
    let polls = {
        let c = p.polls.entry(id.clone()).or_insert(0);
        *c += 1;
        *c
    };
    let Some(intent) = p.intents.get_mut(&id) else {
        return envelope(StatusCode::NOT_FOUND, "purchase_not_found", None);
    };
    if polls > f.credit_after_polls.load(Ordering::SeqCst) && intent["status"] == "pending" {
        intent["status"] = json!("credited");
        intent["credited_at"] = json!("2026-09-26T21:12:00Z");
        intent["credited_milli_2z"] = json!(intent["quantity_2z"].as_u64().unwrap() * 1000);
    }
    let mut r = json_response(StatusCode::OK, intent.clone());
    r.headers_mut()
        .insert(header::RETRY_AFTER, "0".parse().unwrap());
    r
}

// ----------------------------------------------------------------------
// Gateway
// ----------------------------------------------------------------------

fn sse(frames: &[(&str, Value)], crlf: bool) -> String {
    let nl = if crlf { "\r\n" } else { "\n" };
    let mut out = String::new();
    for (i, (name, data)) in frames.iter().enumerate() {
        if name.is_empty() {
            out.push_str(&format!(": ping{nl}{nl}"));
            continue;
        }
        out.push_str(&format!(
            "event: {name}{nl}id: {}{nl}data: {data}{nl}{nl}",
            i + 1
        ));
    }
    out
}

fn meta(call_id: &str, model: &str) -> Value {
    json!({"call_id": call_id, "model": model, "requested_model": model,
           "provider": "example-provider", "hold_2z": 2, "max_output_tokens": 800,
           "input_tokens_estimate": 1200, "created_at": "2026-09-26T21:04:11Z"})
}

fn usage() -> Value {
    json!({"usage": {"input_tokens": 1187, "cached_input_tokens": 0, "cache_write_tokens": 0,
            "output_tokens": 342, "reasoning_tokens": 0, "images": 0, "tool_calls": 0},
           "source": "provider"})
}

fn done_settled() -> Value {
    json!({"charged_2z": 1, "receipt_id": "rcpt_1", "finish_reason": "stop",
           "balance_hint_milli_2z": 41500, "settlement": "settled", "hold_2z": 2,
           "released_2z": 1, "collected_milli_2z": 1000, "shortfall_milli_2z": 0,
           "cap_remaining_milli_2z": 199000, "usage_source": "provider"})
}

fn record(call_id: &str, status: &str, charged: Option<u64>, replayed: bool) -> Value {
    json!({"call_id": call_id, "status": status, "model": "m", "charged_2z": charged,
           "receipt_id": charged.filter(|c| *c > 0).map(|_| "rcpt_1"), "hold_2z": 2,
           "replayed": replayed, "created_at": "2026-09-26T21:04:11Z"})
}

fn stream_response(call_id: &str, body: Body) -> Response<Body> {
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-store")
        .header("x-f2z-call-id", call_id)
        .body(body)
        .unwrap()
}

async fn chat(State(f): State<Arc<Fake>>, headers: HeaderMap, body: Bytes) -> Response<Body> {
    let scope = match f.check_bearer(&headers) {
        Ok(s) => s,
        Err(r) => return r,
    };
    if !has_scope(&scope, "ai:invoke") {
        return envelope(
            StatusCode::FORBIDDEN,
            "insufficient_scope",
            Some(json!({"scope": "ai:invoke"})),
        );
    }
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let model = req["model"].as_str().unwrap_or("").to_owned();

    let (call_id, nth_for_model) = {
        let mut g = f.gateway.lock().unwrap();
        if let Some(rec) = g.records_by_key.get(&key).cloned() {
            let mut rec = rec;
            rec["replayed"] = json!(true);
            if f.broken_chat_replay.load(Ordering::SeqCst) {
                return broken_json(StatusCode::OK);
            }
            return json_response(StatusCode::OK, rec);
        }
        g.calls.push((model.clone(), key.clone()));
        g.next_call += 1;
        let call_id = format!("019a2f1c-9c7b-7e21-8a3d-{:012x}", g.next_call);
        let nth = g.calls.iter().filter(|(m, _)| *m == model).count() as u32;
        (call_id, nth)
    };
    let remember = |status: &str, charged: Option<u64>| {
        let mut g = f.gateway.lock().unwrap();
        let rec = record(&call_id, status, charged, false);
        g.records_by_key.insert(key.clone(), rec.clone());
        g.records_by_id.insert(call_id.clone(), rec);
    };
    let happy = |crlf: bool| {
        sse(
            &[
                ("meta", meta(&call_id, &model)),
                ("delta", json!({"text": "Line 3 divides both sides by "})),
                ("", Value::Null),
                ("delta", json!({"text": "x, which is zero when x = 0."})),
                ("future_event", json!({"anything": true})),
                ("usage", usage()),
                ("done", done_settled()),
            ],
            crlf,
        )
    };
    let body = match model.as_str() {
        "settled" => {
            remember("settled", Some(1));
            happy(false)
        }
        "slow-headers" => {
            // The call is accepted and settled; only the answer is lost.
            remember("settled", Some(1));
            tokio::time::sleep(Duration::from_millis(800)).await;
            happy(false)
        }
        "crlf" => {
            remember("settled", Some(1));
            happy(true)
        }
        // A `response_format` reply: JSON text split across deltas.
        "structured" => {
            remember("settled", Some(1));
            sse(
                &[
                    ("meta", meta(&call_id, &model)),
                    ("delta", json!({"text": "{\"title\":\"Fractions\","})),
                    (
                        "delta",
                        json!({"text": "\"steps\":[\"Halve a pizza\",\"Name the half\"]}"}),
                    ),
                    ("usage", usage()),
                    ("done", done_settled()),
                ],
                false,
            )
        }
        "pending" => {
            remember("settling", None);
            sse(
                &[
                    ("meta", meta(&call_id, &model)),
                    ("delta", json!({"text": "hi"})),
                    (
                        "done",
                        json!({"finish_reason": "stop", "settlement": "pending", "hold_2z": 2}),
                    ),
                ],
                false,
            )
        }
        "released" => {
            remember("released", Some(0));
            sse(
                &[
                    ("meta", meta(&call_id, &model)),
                    ("delta", json!({"text": "hi"})),
                    (
                        "done",
                        json!({"finish_reason": "stop", "settlement": "released",
                                    "charged_2z": 0, "hold_2z": 2, "released_2z": 2}),
                    ),
                ],
                false,
            )
        }
        "error-before-meta" => {
            if nth_for_model <= f.fail_first.load(Ordering::SeqCst) {
                remember("released", Some(0));
                sse(
                    &[(
                        "error",
                        json!({"code": "provider_error", "message": "upstream 500",
                               "settlement": "settled", "charged_2z": 0}),
                    )],
                    false,
                )
            } else {
                remember("settled", Some(1));
                happy(false)
            }
        }
        "charged-failure" => {
            remember("settled_partial", Some(1));
            sse(
                &[
                    ("meta", meta(&call_id, &model)),
                    ("delta", json!({"text": "partial "})),
                    (
                        "error",
                        json!({"code": "provider_error", "message": "closed early",
                               "settlement": "settled", "charged_2z": 1, "receipt_id": "rcpt_1",
                               "collected_milli_2z": 1000, "shortfall_milli_2z": 0,
                               "partial": true}),
                    ),
                ],
                false,
            )
        }
        "delivery-aborted" => sse(
            &[
                ("meta", meta(&call_id, &model)),
                ("delta", json!({"text": "partial "})),
                (
                    "error",
                    json!({"code": "delivery_aborted", "message": "buffer full",
                           "settlement": "pending", "partial": true}),
                ),
            ],
            false,
        ),
        "disconnect" => {
            remember("streaming", None);
            sse(
                &[
                    ("meta", meta(&call_id, &model)),
                    ("delta", json!({"text": "cut "})),
                ],
                false,
            )
        }
        "hang" => {
            remember("streaming", None);
            let first = sse(&[("meta", meta(&call_id, &model))], false);
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, Infallible>>(4);
            tx.send(Ok(Bytes::from(first))).await.unwrap();
            let fake = Arc::clone(&f);
            tokio::spawn(async move {
                tx.closed().await;
                fake.hang_disconnected.store(true, Ordering::SeqCst);
            });
            let stream = futures_util::stream::unfold(rx, |mut rx| async move {
                rx.recv().await.map(|item| (item, rx))
            });
            return stream_response(&call_id, Body::from_stream(stream));
        }
        "rate-limited-once" if nth_for_model == 1 => {
            let mut r = envelope(StatusCode::TOO_MANY_REQUESTS, "rate_limited", None);
            r.headers_mut()
                .insert(header::RETRY_AFTER, "0".parse().unwrap());
            return r;
        }
        "rate-limited-once" => {
            remember("settled", Some(1));
            happy(false)
        }
        "stall-503" => {
            // Headers, then a body that never finishes.
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, Infallible>>(1);
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(30)).await;
                drop(tx);
            });
            let stream = futures_util::stream::unfold(rx, |mut rx| async move {
                rx.recv().await.map(|item| (item, rx))
            });
            return Response::builder()
                .status(StatusCode::SERVICE_UNAVAILABLE)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from_stream(stream))
                .unwrap();
        }
        "insufficient" => {
            return envelope(
                StatusCode::PAYMENT_REQUIRED,
                "insufficient_balance",
                Some(json!({"available_milli_2z": 400, "required_2z": 1, "min_charge_2z": 1})),
            );
        }
        _ => {
            return envelope(
                StatusCode::NOT_FOUND,
                "model_not_found",
                Some(json!({"model": model})),
            );
        }
    };
    stream_response(&call_id, Body::from(body))
}

async fn call_record(State(f): State<Arc<Fake>>, headers: HeaderMap, uri: Uri) -> Response<Body> {
    if let Err(r) = f.check_bearer(&headers) {
        return r;
    }
    let id = uri.path().rsplit('/').next().unwrap_or("");
    match f.gateway.lock().unwrap().records_by_id.get(id) {
        Some(rec) => json_response(StatusCode::OK, rec.clone()),
        None => envelope(StatusCode::NOT_FOUND, "call_not_found", None),
    }
}

async fn models(State(f): State<Arc<Fake>>, headers: HeaderMap) -> Response<Body> {
    if let Err(r) = f.check_bearer(&headers) {
        return r;
    }
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some("\"v7\"")
    {
        return Response::builder()
            .status(StatusCode::NOT_MODIFIED)
            .header(header::ETAG, "\"v7\"")
            .body(Body::empty())
            .unwrap();
    }
    let mut r = json_response(
        StatusCode::OK,
        json!({"catalog_version": 7, "includes_markup_bps": 0, "models": [
            {"id": "settled", "provider": "example-provider", "display_name": "Example",
             "context_window": 400000, "max_output_tokens": 128000,
             "capabilities": {"vision": true, "tools": true, "reasoning": false},
             "prices": {"input_milli_2z_per_mtok": 300000, "output_milli_2z_per_mtok": 1200000},
             "min_charge_2z": 1, "ttfb_timeout_ms": 30000},
            {"id": "structured", "provider": "example-provider", "display_name": "Example (JSON)",
             "context_window": 128000, "max_output_tokens": 16384,
             "capabilities": {"vision": false, "tools": true, "reasoning": false,
                              "structured_output": true},
             "prices": {"input_milli_2z_per_mtok": 150000, "output_milli_2z_per_mtok": 600000},
             "min_charge_2z": 1, "ttfb_timeout_ms": 30000}
        ]}),
    );
    r.headers_mut()
        .insert(header::ETAG, "\"v7\"".parse().unwrap());
    r
}

async fn estimate(State(f): State<Arc<Fake>>, headers: HeaderMap, body: Bytes) -> Response<Body> {
    if let Err(r) = f.check_bearer(&headers) {
        return r;
    }
    // Scripted strict refusals, by model name (`Ai::preflight`).
    let model = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v["model"].as_str().map(str::to_owned));
    match model.as_deref() {
        Some("needs-top-up") => {
            return envelope(
                StatusCode::PAYMENT_REQUIRED,
                "insufficient_balance",
                Some(
                    json!({"reason": "max_output_tokens_strict", "max_output_tokens": 1800,
                    "required_2z": 12, "available_milli_2z": 500, "min_charge_2z": 1}),
                ),
            );
        }
        Some("needs-budget") => {
            return envelope(
                StatusCode::FORBIDDEN,
                "cap_exceeded",
                Some(
                    json!({"reason": "max_output_tokens_strict", "max_output_tokens": 1800,
                    "required_2z": 12, "cap_2z": 200, "cap_period": "week",
                    "cap_remaining_milli_2z": 0, "resets_at": "2026-10-12T00:00:00Z"}),
                ),
            );
        }
        // The model ceiling (strict), and a malformed `max_output_tokens`:
        // the same field, different refusals (`provider::strict_model_ceiling`
        // and `chat::validate` in f2z-ai).
        Some("above-model-max") => {
            return envelope(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                Some(
                    json!({"field": "max_output_tokens", "reason": "max_output_tokens_strict",
                    "max_output_tokens": 1800, "model_max_output_tokens": 1024}),
                ),
            );
        }
        Some("out-of-range") => {
            return envelope(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                Some(json!({"field": "max_output_tokens", "reason": "out_of_range"})),
            );
        }
        Some("too-large") => {
            return envelope(
                StatusCode::BAD_REQUEST,
                "context_length_exceeded",
                Some(
                    json!({"reason": "max_output_tokens_strict", "max_output_tokens": 1800,
                    "input_tokens_estimate": 399000, "context_window": 400000}),
                ),
            );
        }
        _ => {}
    }
    json_response(
        StatusCode::OK,
        json!({"model": "settled", "input_tokens": 1200, "max_output_tokens": 800, "hold_2z": 2,
               "min_charge_2z": 1, "available_milli_2z": 42500, "cap_remaining_milli_2z": null,
               "catalog_version": 7}),
    )
}

// ----------------------------------------------------------------------
// Scripted browsers
// ----------------------------------------------------------------------

/// Follow the authorization URL like a browser would, without following the
/// final redirect: returns the `Location` the IdP sent.
pub async fn follow_authorize(url: &str) -> String {
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let r = http.get(url).send().await.unwrap();
    assert_eq!(
        r.status(),
        reqwest::StatusCode::FOUND,
        "authorize did not redirect"
    );
    r.headers()[reqwest::header::LOCATION]
        .to_str()
        .unwrap()
        .to_owned()
}

type Tamper =
    Box<dyn Fn(String, String) -> Pin<Box<dyn Future<Output = String> + Send>> + Send + Sync>;

/// A mobile-style [`AuthSession`] (an `ASWebAuthenticationSession` stand-in):
/// it "shows" the URL by fetching it and returns the redirect it got, after
/// an optional tamper step that plays an attacker.
pub struct ScriptedBrowser {
    pub redirect_uri: String,
    tamper: Option<Tamper>,
    pub seen: Mutex<Vec<String>>,
}

impl ScriptedBrowser {
    pub fn new(redirect_uri: &str) -> Self {
        Self {
            redirect_uri: redirect_uri.to_owned(),
            tamper: None,
            seen: Mutex::default(),
        }
    }

    /// `tamper(authorize_url, callback) -> callback'`.
    pub fn with_tamper<F, Fut>(mut self, f: F) -> Self
    where
        F: Fn(String, String) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = String> + Send + 'static,
    {
        self.tamper = Some(Box::new(move |a, b| Box::pin(f(a, b))));
        self
    }
}

impl AuthSession for ScriptedBrowser {
    fn redirect_uri(&self) -> &str {
        &self.redirect_uri
    }

    fn authorize<'a>(
        &'a self,
        request: &'a AuthorizationRequest,
    ) -> BoxFuture<'a, Result<String, f2z_sdk::Error>> {
        Box::pin(async move {
            self.seen.lock().unwrap().push(request.url.clone());
            let callback = follow_authorize(&request.url).await;
            Ok(match &self.tamper {
                Some(t) => t(request.url.clone(), callback).await,
                None => callback,
            })
        })
    }
}

/// Replace (or add) one query parameter of a URL.
pub fn set_param(url: &str, name: &str, value: &str) -> String {
    let mut u = url::Url::parse(url).unwrap();
    let pairs: Vec<(String, String)> = u
        .query_pairs()
        .filter(|(k, _)| k != name)
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    {
        let mut q = u.query_pairs_mut();
        q.clear();
        for (k, v) in &pairs {
            q.append_pair(k, v);
        }
        q.append_pair(name, value);
    }
    u.into()
}

pub fn get_param(url: &str, name: &str) -> Option<String> {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

/// A desktop opener for [`f2z_sdk::oauth::LoopbackSession`]: a "system
/// browser" that follows the IdP's redirect to the loopback listener.
pub fn loopback_browser() -> impl Fn(&str) -> Result<(), String> + Send + Sync {
    |url: &str| {
        let url = url.to_owned();
        tokio::spawn(async move {
            let location = follow_authorize(&url).await;
            let body = reqwest::get(&location).await.unwrap().text().await.unwrap();
            assert!(body.contains("close this window"), "{body}");
        });
        Ok(())
    }
}

pub fn chat_request(model: &str) -> f2z_sdk::proto::ChatRequest {
    serde_json::from_value(json!({
        "model": model,
        "messages": [{"role": "user", "content": [{"type": "text", "text": "What is wrong with my working?"}]}],
        "max_output_tokens": 800
    }))
    .unwrap()
}

// Flush headers and a partial body before resetting the connection.
fn broken_json(status: StatusCode) -> Response<Body> {
    let stream = futures_util::stream::unfold(0, |step| async move {
        match step {
            0 => Some((Ok::<_, std::io::Error>(Bytes::from_static(b"{")), 1)),
            1 => {
                tokio::time::sleep(Duration::from_millis(30)).await;
                Some((Err(std::io::Error::other("injected body reset")), 2))
            }
            _ => None,
        }
    });
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from_stream(stream))
        .unwrap()
}

fn delayed_json(value: Value, delay: Duration) -> Response<Body> {
    let stream = futures_util::stream::once(async move {
        tokio::time::sleep(delay).await;
        Ok::<_, Infallible>(Bytes::from(serde_json::to_vec(&value).unwrap()))
    });
    Response::builder()
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from_stream(stream))
        .unwrap()
}
