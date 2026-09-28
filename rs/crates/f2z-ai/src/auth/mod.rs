//! Authentication and limits: chat-api.md §2.2 steps 1 and 2, in front of
//! `/v1/chat`.
//!
//! | Step | Refusal | Module |
//! |---|---|---|
//! | The bearer token: `ES256`, `typ: at+jwt`, signature by `kid` from the issuer's JWKS, `iss`, `aud` ∋ `f2z-ai`, `exp` ± 30 s | `401 invalid_token`, `details.reason` ∈ `missing`, `malformed`, `expired`, `signature`, `issuer`, `audience` | [`jwt`], [`jwks`] |
//! | The key set has never loaded | `503 unavailable`, `reason: token_keys` | [`jwks`] |
//! | `aep` / `agen` current — Redis, then the IdP's internal epoch endpoint | `401 token_revoked` (`account_epoch` / `grant_generation`); state unknown → `503 unavailable`, `reason: revocation_check`. **Never allow on unknown** | [`revocation`] |
//! | Scope `ai:invoke` | `403 insufficient_scope`, `details.scope` | [`jwt`] |
//! | Concurrency (4 per user) and rate (per (app, user), per app) | `429 concurrency_limit` / `429 rate_limited` + `Retry-After` | [`limits`] |
//!
//! Every `401`/`403` carries `WWW-Authenticate: Bearer …` (RFC 6750 §3), the
//! body the errors.md envelope.
//!
//! The order is the spec's: a revoked token is told it is revoked even when
//! it also lacks the scope, and no limit is spent on a request that fails
//! authentication.

pub mod jwks;
pub mod jwt;
pub mod limits;
pub mod revocation;
pub mod store;

use std::sync::Arc;

use async_trait::async_trait;
use axum::http::{HeaderMap, header};
use f2z_ai_proto::ErrorCode;

use crate::error::ApiFailure;
use jwks::{KeyCache, Lookup};
use jwt::{Claims, TokenError};
use limits::{Lease, Limits};
use revocation::{Revocation, Verdict};

/// Who is calling: the verified claims of the access token.
pub type Principal = Claims;

/// An authenticated, admitted call.
#[derive(Debug)]
pub struct Admitted {
    /// The token's claims.
    pub principal: Principal,
    /// The concurrency lease, held until the call is settled. `None` only
    /// from a gatekeeper that applies no concurrency limit.
    pub lease: Option<Lease>,
}

/// What stands in front of `/v1/chat`.
#[async_trait]
pub trait Gatekeeper: Send + Sync + 'static {
    /// Authenticate and admit the request with these headers.
    ///
    /// # Errors
    ///
    /// The refusal to answer with.
    async fn admit(&self, headers: &HeaderMap) -> Result<Admitted, ApiFailure>;
}

/// No authentication is configured: every call is refused `503`. A gateway
/// that cannot check tokens serves nobody — it never serves everybody.
#[derive(Clone, Copy, Debug, Default)]
pub struct Unconfigured;

#[async_trait]
impl Gatekeeper for Unconfigured {
    async fn admit(&self, _headers: &HeaderMap) -> Result<Admitted, ApiFailure> {
        Err(ApiFailure::new(
            ErrorCode::Unavailable,
            "this gateway has no token verification configured",
        )
        .detail("reason", "token_keys"))
    }
}

/// `401 invalid_token` with the RFC 6750 challenge.
#[must_use]
pub fn invalid_token(error: TokenError) -> ApiFailure {
    let failure = ApiFailure::new(
        ErrorCode::InvalidToken,
        match error {
            TokenError::Missing => "an access token is required: Authorization: Bearer <token>",
            TokenError::Malformed => "the access token is malformed",
            TokenError::Signature => "the access token's signature does not verify",
            TokenError::Expired => "the access token has expired",
            TokenError::Issuer => "the access token was not issued by the expected issuer",
            TokenError::Audience => "the access token is not for this gateway",
        },
    )
    .detail("reason", error.reason());
    // RFC 6750 §3.1: a request with no credentials gets no error code.
    let challenge = if error == TokenError::Missing {
        "Bearer realm=\"f2z-ai\"".to_owned()
    } else {
        format!(
            "Bearer realm=\"f2z-ai\", error=\"invalid_token\", error_description=\"{}\"",
            error.reason()
        )
    };
    failure.header(header::WWW_AUTHENTICATE, &challenge)
}

fn revoked(reason: &'static str) -> ApiFailure {
    ApiFailure::new(
        ErrorCode::TokenRevoked,
        "the access token was revoked: the account or the grant changed; sign in again",
    )
    .detail("reason", reason)
    .header(
        header::WWW_AUTHENTICATE,
        "Bearer realm=\"f2z-ai\", error=\"invalid_token\", error_description=\"revoked\"",
    )
}

fn insufficient_scope() -> ApiFailure {
    ApiFailure::new(
        ErrorCode::InsufficientScope,
        "the access token lacks the ai:invoke scope",
    )
    .detail("scope", jwt::SCOPE)
    .header(
        header::WWW_AUTHENTICATE,
        "Bearer realm=\"f2z-ai\", error=\"insufficient_scope\", scope=\"ai:invoke\"",
    )
}

fn unavailable(reason: &'static str) -> ApiFailure {
    ApiFailure::new(
        ErrorCode::Unavailable,
        "the gateway cannot confirm this token right now; retry with backoff",
    )
    .detail("reason", reason)
    .retry_after(1)
}

/// The production gatekeeper.
pub struct Gate {
    issuer: String,
    audience: String,
    keys: Arc<KeyCache>,
    revocation: Revocation,
    limits: Limits,
}

impl std::fmt::Debug for Gate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gate")
            .field("issuer", &self.issuer)
            .field("audience", &self.audience)
            .finish_non_exhaustive()
    }
}

impl Gate {
    /// A gate for tokens from `issuer` addressed to `audience`.
    #[must_use]
    pub fn new(
        issuer: String,
        audience: String,
        keys: Arc<KeyCache>,
        revocation: Revocation,
        limits: Limits,
    ) -> Self {
        Self {
            issuer,
            audience,
            keys,
            revocation,
            limits,
        }
    }

    /// The limits, for inspection.
    #[must_use]
    pub const fn limits(&self) -> &Limits {
        &self.limits
    }

    /// Steps 1's token checks, without revocation or limits.
    ///
    /// # Errors
    ///
    /// `401 invalid_token`, or `503` while no key set has loaded.
    pub async fn verify(&self, headers: &HeaderMap) -> Result<Claims, ApiFailure> {
        let token = jwt::bearer(headers).map_err(invalid_token)?;
        let unverified = jwt::parse(token).map_err(invalid_token)?;
        let key = match self.keys.lookup(&unverified.kid).await {
            Lookup::Found(key) => key,
            Lookup::Unknown => return Err(invalid_token(TokenError::Signature)),
            Lookup::Unavailable => return Err(unavailable("token_keys")),
        };
        let payload = jwt::Unverified::verify(&unverified, &key).map_err(invalid_token)?;
        jwt::check_claims(
            &payload,
            &self.issuer,
            &self.audience,
            crate::catalog::now_unix(),
        )
        .map_err(invalid_token)
    }
}

#[async_trait]
impl Gatekeeper for Gate {
    async fn admit(&self, headers: &HeaderMap) -> Result<Admitted, ApiFailure> {
        let claims = self.verify(headers).await?;
        match self.revocation.check(&claims).await {
            Verdict::Current => {}
            Verdict::Revoked(reason) => return Err(revoked(reason)),
            Verdict::Unknown => return Err(unavailable("revocation_check")),
        }
        if !claims.has_scope(jwt::SCOPE) {
            return Err(insufficient_scope());
        }
        let lease = self.limits.admit(&claims).await?;
        Ok(Admitted {
            principal: claims,
            lease: Some(lease),
        })
    }
}

/// The gatekeeper `config` describes: [`Gate`] when authentication is
/// configured, [`Unconfigured`] (refuse everything) when it is not.
///
/// # Errors
///
/// The HTTP client or the Redis client could not be built, or a URL is
/// invalid.
pub fn from_config(config: &crate::config::AuthConfig) -> Result<Arc<dyn Gatekeeper>, String> {
    let (Some(endpoint), Some(token)) = (&config.epoch_endpoint, &config.epoch_token) else {
        tracing::warn!("no auth_epoch_endpoint configured: every /v1/chat call is refused");
        return Ok(Arc::new(Unconfigured));
    };
    let client = crate::provider::client::build_client(jwks::FETCH_TIMEOUT)?;
    let jwks_uri = config
        .jwks_uri
        .as_deref()
        .map(jwks::check_url)
        .transpose()?;
    let keys = Arc::new(KeyCache::new(
        Arc::new(jwks::HttpKeySource::new(
            client.clone(),
            config.issuer.clone(),
            jwks_uri,
        )),
        config.jwks_min_refetch,
    ));
    let store: Option<Arc<dyn store::Store>> = match &config.redis_url {
        Some(url) => Some(Arc::new(store::RedisStore::new(url, config.redis_timeout)?)),
        None => {
            tracing::warn!(
                "no Redis configured: revocation goes to the epoch endpoint on every call and \
                 rate limits are per pod"
            );
            None
        }
    };
    let endpoint = reqwest::Url::parse(endpoint).map_err(|_| "auth_epoch_endpoint".to_owned())?;
    let revocation = Revocation::new(
        store.clone(),
        config.redis_namespace.clone(),
        Some(Arc::new(revocation::HttpEpochSource::new(
            client,
            endpoint,
            token.clone(),
            config.epoch_timeout,
        ))),
    );
    let limits = Limits::new(
        limits::LimitsConfig {
            user: store::Rate {
                per_minute: config.rate_user_per_minute,
                burst: config.rate_user_burst,
            },
            app: (config.rate_app_per_minute > 0).then_some(store::Rate {
                per_minute: config.rate_app_per_minute,
                burst: config.rate_app_burst,
            }),
            concurrency: config.concurrency_per_user,
            lease_ttl: config.concurrency_lease,
        },
        store,
        config.redis_namespace.clone(),
    );
    // Warm the key set in the background so the first call does not pay for
    // the fetch; a failure here is retried on first use.
    let warm = Arc::clone(&keys);
    tokio::spawn(async move {
        warm.refresh().await;
    });
    Ok(Arc::new(Gate::new(
        config.issuer.clone(),
        config.audience.clone(),
        keys,
        revocation,
        limits,
    )))
}
