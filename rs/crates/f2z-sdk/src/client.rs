//! [`Client`]: the session, its tokens, and authenticated requests.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OnceCell};

use crate::config::{Config, Validated};
use crate::error::{Error, OAuthError, SignedOutReason};
use crate::http;
use crate::keychain::{Persistence, TokenStore};
use crate::oauth::{
    self, AuthSession, AuthorizationRequest, AuthorizeParams, Callback, Discovery, Expected, Jwks,
    Pkce, SignInOptions, SignedIn,
};
use crate::random;
use crate::secret::Secret;

/// An access token is refreshed this long before its `expires_in` runs out,
/// so a request never leaves with a token about to die in flight.
const EXPIRY_SKEW: Duration = Duration::from_secs(30);
/// `expires_in` when the token response omits it: the spec's fixed lifetime.
const DEFAULT_EXPIRES_IN: u64 = 300;
/// The version of the stored session blob.
const STORED_VERSION: u32 = 1;

/// The SDK's entry point: one app's client, for one user at a time.
///
/// Cheap to clone; clones share the session, so a refresh done through one
/// is seen by all, and refreshes are single-flight across all of them. There
/// is no global state: two `Client`s are two independent sessions.
///
/// ```no_run
/// use std::sync::Arc;
/// use f2z_sdk::{Client, Config, MemoryStore};
///
/// # fn main() -> Result<(), f2z_sdk::Error> {
/// let client = Client::new(Config::new("app_7f3c2e"), Arc::new(MemoryStore::new()))?;
/// # Ok(()) }
/// ```
#[derive(Clone)]
pub struct Client {
    pub(crate) inner: Arc<Inner>,
}

pub(crate) struct Inner {
    pub(crate) config: Validated,
    pub(crate) http: reqwest::Client,
    store: Arc<dyn TokenStore>,
    /// Orders writes to the store by when they were issued (always under
    /// the session lock), not by when their blocking task happens to finish:
    /// a slow save whose caller was cancelled can never land after a later
    /// delete or a later session's save.
    store_order: Arc<std::sync::Mutex<StoreOrder>>,
    account: String,
    discovery: OnceCell<Discovery>,
    session: Mutex<SessionState>,
    pub(crate) models_cache: std::sync::Mutex<Option<(String, crate::ai::Models)>>,
}

/// Issued and last-applied sequence numbers of store writes.
#[derive(Debug, Default)]
struct StoreOrder {
    issued: u64,
    applied: u64,
}

enum StoreWrite {
    Save(Secret),
    Delete,
}

#[derive(Default)]
struct SessionState {
    /// Whether the store has been read into this state.
    loaded: bool,
    access: Option<Access>,
    refresh: Option<Secret>,
    scope: Option<String>,
    subject: Option<String>,
    /// Which session this is. Moves on every sign-in, sign-out and forced
    /// sign-out — never on a refresh, which keeps the same user and grant.
    /// An operation that started under one generation never continues under
    /// another: its retries would act, and spend, as someone else.
    generation: u64,
}

impl SessionState {
    /// Forget the session and start a new generation.
    fn reset(&mut self) {
        let generation = self.generation.wrapping_add(1);
        *self = Self {
            loaded: true,
            generation,
            ..Self::default()
        };
    }
}

struct Access {
    token: Secret,
    expires_at: Instant,
}

impl Access {
    fn fresh(&self) -> bool {
        Instant::now()
            .checked_add(EXPIRY_SKEW)
            .is_some_and(|t| t < self.expires_at)
    }
}

#[derive(Serialize, Deserialize)]
struct Stored {
    v: u32,
    refresh_token: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    sub: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    token_type: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
}

#[derive(Deserialize)]
struct OAuthErrorBody {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

impl fmt::Debug for Client {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Client")
            .field("issuer", &self.inner.config.issuer)
            .field("client_id", &self.inner.config.client_id)
            .finish_non_exhaustive()
    }
}

pub(crate) fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

impl Client {
    /// A client for `config`, keeping its refresh token in `store`.
    ///
    /// No network happens here; discovery is read on first use.
    ///
    /// # Errors
    ///
    /// [`Error::Config`] for an unusable configuration.
    pub fn new(config: Config, store: Arc<dyn TokenStore>) -> Result<Self, Error> {
        let config = config.validate()?;
        let account = format!("{} {}", config.issuer, config.client_id);
        Ok(Self {
            inner: Arc::new(Inner {
                http: http::build_client()?,
                config,
                store,
                store_order: Arc::default(),
                account,
                discovery: OnceCell::new(),
                session: Mutex::new(SessionState::default()),
                models_cache: std::sync::Mutex::new(None),
            }),
        })
    }

    /// Where the refresh token is kept: an app on
    /// [`Persistence::MemoryOnly`] should expect the user to sign in again
    /// after a restart.
    #[must_use]
    pub fn token_persistence(&self) -> Persistence {
        self.inner.store.persistence()
    }

    /// The IdP's discovery document, fetched once and validated against the
    /// configured issuer.
    ///
    /// # Errors
    ///
    /// [`Error::Discovery`] for a document that fails validation; transport
    /// and HTTP errors as they come. A failure is not cached.
    pub async fn discovery(&self) -> Result<&Discovery, Error> {
        self.inner
            .discovery
            .get_or_try_init(|| async {
                let issuer = &self.inner.config.issuer;
                let url = format!("{issuer}/.well-known/openid-configuration");
                let response = self
                    .inner
                    .http
                    .get(url)
                    .timeout(self.inner.config.request_timeout)
                    .send()
                    .await?;
                let response = http::expect_success(response).await?;
                let doc: Discovery = http::read_json(response)
                    .await
                    .map_err(|e| Error::Discovery(e.to_string()))?;
                doc.validate(issuer)?;
                Ok(doc)
            })
            .await
    }

    // ------------------------------------------------------------------
    // Sign-in
    // ------------------------------------------------------------------

    /// Sign the user in through `session` (§9.2–§9.4).
    ///
    /// A fresh PKCE verifier, `state` and (with `openid`) `nonce` are drawn
    /// for every call. The response's `iss` and `state` are verified before
    /// its `code` is used; a mismatch is [`Error::IssuerMismatch`] or
    /// [`Error::StateMismatch`] and the code is never sent anywhere. With
    /// `openid` granted, the ID token is verified (§11).
    ///
    /// On success the new tokens replace any previous session, and the old
    /// refresh token is revoked (best effort).
    ///
    /// # Errors
    ///
    /// [`Error::Authorization`] when the IdP refused (`access_denied`, …);
    /// [`Error::Token`] when the code exchange failed (`invalid_grant`);
    /// [`Error::Timeout`] when nothing came back within
    /// [`Config::callback_timeout`]; [`Error::IdToken`] for an ID token that
    /// does not verify; [`Error::Storage`] if the new session could not be
    /// persisted (it is still active in memory).
    pub async fn sign_in(
        &self,
        session: &dyn AuthSession,
        options: SignInOptions,
    ) -> Result<SignedIn, Error> {
        let config = &self.inner.config;
        let started_under = {
            let mut s = self.inner.session.lock().await;
            self.ensure_loaded(&mut s).await?;
            s.generation
        };
        let discovery = self.discovery().await?.clone();
        let redirect_uri = session.redirect_uri().to_owned();
        let redirect = oauth::check_redirect_uri(&redirect_uri)?;

        let pkce = Pkce::new()?;
        let state = random::token_43()?;
        let wants_openid = config.wants("openid");
        let nonce = if wants_openid {
            Some(random::token_43()?)
        } else {
            None
        };
        let scope = config.scope_string();
        let url = oauth::authorization_url(&AuthorizeParams {
            endpoint: &discovery.authorization_endpoint,
            client_id: &config.client_id,
            redirect_uri: &redirect_uri,
            scope: &scope,
            state: &state,
            nonce: nonce.as_deref(),
            challenge: &pkce.challenge,
            options: &options,
        })?;
        let request = AuthorizationRequest {
            url,
            redirect_uri: redirect_uri.clone(),
        };
        let callback = tokio::time::timeout(config.callback_timeout, session.authorize(&request))
            .await
            .map_err(|_| Error::Timeout("the sign-in redirect"))??;

        let code = match oauth::parse_callback(&redirect, &callback, &config.issuer, &state)? {
            Callback::Code(code) => Secret::new(code),
            Callback::Refused(e) => return Err(Error::Authorization(e)),
        };

        let body = http::form(&[
            ("grant_type", "authorization_code"),
            ("code", code.expose()),
            ("redirect_uri", &redirect_uri),
            ("client_id", &config.client_id),
            ("code_verifier", pkce.verifier.expose()),
        ]);
        let tokens = self.post_token(&discovery.token_endpoint, body).await?;
        let granted = tokens.scope.clone().unwrap_or_else(|| scope.clone());
        let granted_openid = granted.split(' ').any(|s| s == "openid");

        let id_token = match (&tokens.id_token, granted_openid) {
            (Some(token), _) => {
                let jwks = self.fetch_jwks(&discovery.jwks_uri).await?;
                Some(oauth::verify_id_token(
                    token,
                    &jwks,
                    &Expected {
                        issuer: &config.issuer,
                        client_id: &config.client_id,
                        nonce: nonce.as_deref(),
                        now: now_unix(),
                    },
                )?)
            }
            (None, true) => {
                return Err(Error::IdToken(
                    "openid was granted but no ID token was issued".into(),
                ));
            }
            (None, false) => None,
        };
        let subject = id_token.as_ref().map(|c| c.sub.clone());
        let refreshable = tokens.refresh_token.is_some();

        let replaced = {
            let mut s = self.inner.session.lock().await;
            if s.generation != started_under {
                // A sign-out (or another sign-in) finished while this one
                // waited on the browser. Installing now would undo it.
                drop(s);
                if let Some(rt) = tokens.refresh_token {
                    let _ = self.revoke(&discovery, &Secret::new(rt)).await;
                }
                return Err(Error::SignedOut(SignedOutReason::SessionChanged));
            }
            s.loaded = true;
            s.generation = s.generation.wrapping_add(1);
            let old = s.refresh.take();
            s.subject = subject.clone();
            let persisted = self.install(&mut s, tokens, &granted).await;
            if !refreshable {
                // No refresh token: nothing to keep across runs, and nothing
                // stale may stay behind in the store either.
                self.store_delete().await?;
            }
            persisted?;
            old
        };
        if let Some(old) = replaced {
            // A new family replaces the old one; do not leave it valid.
            let _ = self.revoke(&discovery, &old).await;
        }
        Ok(SignedIn {
            subject,
            scopes: granted
                .split(' ')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect(),
            id_token,
            refreshable,
            persistence: self.token_persistence(),
        })
    }

    /// Sign out: revoke the refresh token at the IdP (which revokes its
    /// family, §9.5) and forget the session locally, in memory and in the
    /// store.
    ///
    /// Returns whether the IdP confirmed the revocation. The local session is
    /// gone either way; a revocation that could not be delivered leaves the
    /// refresh token to expire on its own (30 days) — the user can also
    /// revoke the app at `free2z.cash/account/apps`.
    ///
    /// # Errors
    ///
    /// [`Error::Storage`] if the store could not be cleared.
    pub async fn sign_out(&self) -> Result<bool, Error> {
        let mut s = self.inner.session.lock().await;
        if !s.loaded {
            // Best effort: a store we cannot read we will still try to clear.
            let _ = self.load(&mut s).await;
        }
        let refresh = s.refresh.take();
        s.reset();
        // Local state first: the store delete is issued before anything that
        // can stall, and its blocking task completes even if this future is
        // dropped — a cancelled sign-out never leaves the session restorable.
        let deleted = self.store_delete().await;
        drop(s);
        // The revocation runs on its own task for the same reason: the only
        // copy of the refresh token is in it now.
        let revoked = match refresh {
            Some(rt) => {
                let client = self.clone();
                tokio::spawn(async move {
                    match client.discovery().await {
                        Ok(d) => {
                            let d = d.clone();
                            client.revoke(&d, &rt).await
                        }
                        Err(_) => false,
                    }
                })
                .await
                .unwrap_or(false)
            }
            None => false,
        };
        deleted?;
        Ok(revoked)
    }

    /// Whether there is a session: a live access token in memory or a
    /// refresh token in memory or the store. No network.
    ///
    /// # Errors
    ///
    /// [`Error::Storage`] if the store cannot be read.
    pub async fn is_signed_in(&self) -> Result<bool, Error> {
        let mut s = self.inner.session.lock().await;
        self.ensure_loaded(&mut s).await?;
        Ok(s.refresh.is_some() || s.access.as_ref().is_some_and(Access::fresh))
    }

    /// The signed-in user's `sub`, when known.
    pub async fn subject(&self) -> Option<String> {
        self.inner.session.lock().await.subject.clone()
    }

    /// The scopes granted to the current session.
    pub async fn granted_scopes(&self) -> Vec<String> {
        let s = self.inner.session.lock().await;
        s.scope
            .as_deref()
            .unwrap_or("")
            .split(' ')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect()
    }

    /// A valid access token, refreshing first if the one in memory is about
    /// to expire. Refreshes are single-flight: every concurrent caller waits
    /// on the one refresh in flight.
    ///
    /// The token is opaque to the app (§11); send it as a bearer credential
    /// to Free2Z endpoints this SDK does not wrap.
    ///
    /// # Errors
    ///
    /// [`Error::SignedOut`] when there is no session or the IdP refused the
    /// refresh token (`invalid_grant`, which also clears the store);
    /// transport and 5xx errors leave the session intact for a retry.
    pub async fn access_token(&self) -> Result<Secret, Error> {
        self.access_token_in(&mut None).await
    }

    /// [`Client::access_token`] for one operation: the first call records
    /// the session generation in `generation`, and every later call refuses
    /// with [`SignedOutReason::SessionChanged`] if the session is no longer
    /// that one.
    pub(crate) async fn access_token_in(
        &self,
        generation: &mut Option<u64>,
    ) -> Result<Secret, Error> {
        let mut s = self.inner.session.lock().await;
        self.ensure_loaded(&mut s).await?;
        match *generation {
            Some(g) if g != s.generation => {
                return Err(Error::SignedOut(SignedOutReason::SessionChanged));
            }
            _ => *generation = Some(s.generation),
        }
        if let Some(access) = s.access.as_ref().filter(|a| a.fresh()) {
            return Ok(access.token.clone());
        }
        self.refresh_locked(&mut s).await
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    async fn ensure_loaded(&self, s: &mut SessionState) -> Result<(), Error> {
        if s.loaded {
            return Ok(());
        }
        self.load(s).await
    }

    async fn load(&self, s: &mut SessionState) -> Result<(), Error> {
        let store = Arc::clone(&self.inner.store);
        let account = self.inner.account.clone();
        let blob = tokio::task::spawn_blocking(move || store.load(&account))
            .await
            .map_err(|e| Error::Storage(format!("token store task: {e}")))?
            .map_err(|e| Error::Storage(e.to_string()))?;
        s.loaded = true;
        if let Some(blob) = blob {
            match serde_json::from_str::<Stored>(blob.expose()) {
                Ok(stored) if stored.v == STORED_VERSION => {
                    s.refresh = Some(Secret::new(stored.refresh_token));
                    s.scope = stored.scope;
                    s.subject = stored.sub;
                }
                // Unreadable or from a newer SDK: not a session we can use.
                _ => {}
            }
        }
        Ok(())
    }

    async fn store_save(&self, s: &SessionState) -> Result<(), Error> {
        let Some(refresh) = &s.refresh else {
            return Ok(());
        };
        let stored = Stored {
            v: STORED_VERSION,
            refresh_token: refresh.expose().to_owned(),
            scope: s.scope.clone(),
            sub: s.subject.clone(),
        };
        let blob = Secret::new(
            serde_json::to_string(&stored).map_err(|e| Error::Internal(e.to_string()))?,
        );
        // Wipe the plaintext copy the blob was built from.
        drop(Secret::new(stored.refresh_token));
        self.store_write(StoreWrite::Save(blob)).await
    }

    async fn store_delete(&self) -> Result<(), Error> {
        self.store_write(StoreWrite::Delete).await
    }

    /// One store write, sequenced (see [`Inner::store_order`]). Called with
    /// the session lock held, so issue order is the session's own order. The
    /// blocking task runs to completion even if this future is dropped; a
    /// write that a later one has already overtaken is skipped.
    async fn store_write(&self, write: StoreWrite) -> Result<(), Error> {
        let order = Arc::clone(&self.inner.store_order);
        let seq = {
            let mut o = order
                .lock()
                .map_err(|_| Error::Storage("store order lock poisoned".into()))?;
            o.issued = o.issued.wrapping_add(1);
            o.issued
        };
        let store = Arc::clone(&self.inner.store);
        let account = self.inner.account.clone();
        tokio::task::spawn_blocking(move || {
            let mut o = order
                .lock()
                .map_err(|_| crate::keychain::StoreError("store order lock poisoned".into()))?;
            if seq < o.applied {
                return Ok(());
            }
            let result = match &write {
                StoreWrite::Save(blob) => store.save(&account, blob),
                StoreWrite::Delete => store.delete(&account),
            };
            if result.is_ok() {
                o.applied = seq;
            }
            result
        })
        .await
        .map_err(|e| Error::Storage(format!("token store task: {e}")))?
        .map_err(|e| Error::Storage(e.to_string()))
    }

    /// Put a token response into the session and persist the refresh token.
    /// The in-memory session is updated even when persisting fails.
    async fn install(
        &self,
        s: &mut SessionState,
        tokens: TokenResponse,
        granted: &str,
    ) -> Result<(), Error> {
        if !tokens.token_type.eq_ignore_ascii_case("bearer") {
            return Err(Error::Protocol(format!(
                "token_type {:?} is not Bearer",
                tokens.token_type
            )));
        }
        let lifetime = Duration::from_secs(tokens.expires_in.unwrap_or(DEFAULT_EXPIRES_IN));
        s.access = Some(Access {
            token: Secret::new(tokens.access_token),
            expires_at: Instant::now()
                .checked_add(lifetime)
                .unwrap_or_else(Instant::now),
        });
        if let Some(rt) = tokens.refresh_token {
            s.refresh = Some(Secret::new(rt));
        }
        s.scope = Some(granted.to_owned());
        self.store_save(s).await
    }

    async fn refresh_locked(&self, s: &mut SessionState) -> Result<Secret, Error> {
        let Some(refresh) = s.refresh.clone() else {
            s.access = None;
            return Err(Error::SignedOut(SignedOutReason::NoSession));
        };
        let token_endpoint = self.discovery().await?.token_endpoint.clone();
        let body = http::form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh.expose()),
            ("client_id", &self.inner.config.client_id),
        ]);
        match self.post_token(&token_endpoint, body).await {
            Ok(tokens) => {
                let granted = tokens
                    .scope
                    .clone()
                    .or_else(|| s.scope.clone())
                    .unwrap_or_default();
                self.install(s, tokens, &granted).await?;
                s.access
                    .as_ref()
                    .map(|a| a.token.clone())
                    .ok_or_else(|| Error::Internal("no access token after refresh".into()))
            }
            Err(Error::Token(e)) if e.error == "invalid_grant" => {
                // §9.4: every invalid_grant on a refresh means "sign in
                // again". Never retried: a retry of a reused token is what
                // the IdP's reuse detection exists to catch.
                self.clear_locked(s).await?;
                Err(Error::SignedOut(SignedOutReason::RefreshRejected))
            }
            Err(e) => Err(e),
        }
    }

    async fn clear_locked(&self, s: &mut SessionState) -> Result<(), Error> {
        s.reset();
        self.store_delete().await
    }

    /// Forget `failed` if it is still the access token in memory: a resource
    /// server said `401 invalid_token` for it. The next
    /// [`Client::access_token`] refreshes; concurrent callers that saw the
    /// same failure find the token already replaced and do not refresh again.
    async fn invalidate(&self, failed: &Secret) {
        let mut s = self.inner.session.lock().await;
        if s.access.as_ref().is_some_and(|a| &a.token == failed) {
            s.access = None;
        }
    }

    async fn post_token(&self, endpoint: &str, body: String) -> Result<TokenResponse, Error> {
        let response = self
            .inner
            .http
            .post(endpoint)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .header(reqwest::header::ACCEPT, "application/json")
            .timeout(self.inner.config.request_timeout)
            .body(body)
            .send()
            .await?;
        let status = response.status();
        if status.is_success() {
            return http::read_json(response).await;
        }
        let headers = response.headers().clone();
        let bytes = response.bytes().await.unwrap_or_default();
        match serde_json::from_slice::<OAuthErrorBody>(&bytes) {
            Ok(e) if status.is_client_error() => {
                Err(Error::Token(OAuthError::new(e.error, e.error_description)))
            }
            _ => Err(Error::Api(Box::new(http::envelope_from(
                status.as_u16(),
                &headers,
                &bytes,
            )))),
        }
    }

    async fn fetch_jwks(&self, uri: &str) -> Result<Jwks, Error> {
        let response = self
            .inner
            .http
            .get(uri)
            .timeout(self.inner.config.request_timeout)
            .send()
            .await?;
        let response = http::expect_success(response).await?;
        http::read_json(response).await
    }

    /// RFC 7009 revocation of a refresh token; whether the IdP said 200.
    async fn revoke(&self, discovery: &Discovery, refresh: &Secret) -> bool {
        let Some(endpoint) = &discovery.revocation_endpoint else {
            return false;
        };
        let body = http::form(&[
            ("token", refresh.expose()),
            ("token_type_hint", "refresh_token"),
            ("client_id", &self.inner.config.client_id),
        ]);
        self.inner
            .http
            .post(endpoint)
            .header(
                reqwest::header::CONTENT_TYPE,
                "application/x-www-form-urlencoded",
            )
            .timeout(self.inner.config.request_timeout)
            .body(body)
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
    }

    /// Send a request with the session's bearer token, handling the §11
    /// `401` rules: `invalid_token` → refresh (single-flight) and send once
    /// more; `token_revoked` → clear the session; `insufficient_user_
    /// authentication` → [`Error::StepUpRequired`]. Every other status is
    /// returned to the caller.
    pub(crate) async fn send_authorized<F>(&self, build: F) -> Result<reqwest::Response, Error>
    where
        F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    {
        self.send_authorized_in(&mut None, build).await
    }

    /// [`Client::send_authorized`] bound to one session generation (see
    /// [`Client::access_token_in`]): an operation that re-sends — a refresh
    /// after `401`, a transport retry, a chat retry — keeps acting as the
    /// user it started as, or stops.
    pub(crate) async fn send_authorized_in<F>(
        &self,
        generation: &mut Option<u64>,
        build: F,
    ) -> Result<reqwest::Response, Error>
    where
        F: Fn(&reqwest::Client, &str) -> reqwest::RequestBuilder,
    {
        let mut retried = false;
        loop {
            let token = self.access_token_in(generation).await?;
            let response = build(&self.inner.http, token.expose()).send().await?;
            if response.status() != StatusCode::UNAUTHORIZED {
                return Ok(response);
            }
            let headers = response.headers().clone();
            let error = http::read_error(response).await;
            match error.code.as_str() {
                "invalid_token" if !retried => {
                    retried = true;
                    self.invalidate(&token).await;
                }
                "token_revoked" => {
                    // Only the session this request was sent under is
                    // cleared: a late answer must not sign out whoever
                    // signed in since.
                    let mut s = self.inner.session.lock().await;
                    if *generation == Some(s.generation) {
                        self.clear_locked(&mut s).await?;
                    }
                    return Err(Error::SignedOut(SignedOutReason::TokenRevoked));
                }
                "insufficient_user_authentication" => {
                    return Err(Error::StepUpRequired(http::step_up(&headers, &error)));
                }
                _ => return Err(Error::Api(Box::new(error))),
            }
        }
    }
}
