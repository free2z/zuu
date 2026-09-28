//! Signing a user in to Free2Z: OAuth 2.0 authorization code with PKCE
//! `S256`, as `docs/free2z/sdk/spec/oidc.md` profiles it.
//!
//! # The flow, and who does what
//!
//! 1. [`crate::Client::sign_in`] reads discovery (the issuer is the only URL
//!    hard-coded anywhere), draws a fresh PKCE verifier, `state` and `nonce`,
//!    and builds the authorization URL.
//! 2. An [`AuthSession`] shows it to the user and returns the URL the IdP
//!    redirected back to. **This is the pluggable part**: on desktop it is a
//!    [`LoopbackSession`] (a listener on `127.0.0.1:<random>` plus the system
//!    browser, opened through the caller's [`UrlOpener`]); on iOS and Android
//!    the Tauri plugin supplies one over `ASWebAuthenticationSession` /
//!    Custom Tabs with a claimed `https` link or a private-use scheme. Never
//!    an embedded web view.
//! 3. The SDK verifies the response's `iss` (RFC 9207) and `state` **before**
//!    it looks at `code` or `error`, exchanges the code with the verifier,
//!    and verifies the ID token (`RS256` from `jwks_uri`; `iss`, `aud`, `exp`,
//!    `nonce`).
//! 4. The access token stays in memory; the refresh token goes to the
//!    [`crate::TokenStore`]. Refreshes rotate the refresh token and are
//!    **single-flight** per [`crate::Client`]: concurrent callers wait on the
//!    one refresh in flight, because two parallel refreshes are
//!    indistinguishable from token theft (§8).
//! 5. [`crate::Client::sign_out`] revokes the refresh token (which revokes
//!    its family) and clears the store.

mod discovery;
mod id_token;
mod loopback;

use std::future::Future;
use std::pin::Pin;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use url::Url;

pub use discovery::Discovery;
pub use id_token::IdTokenClaims;
pub(crate) use id_token::{Expected, Jwks, verify as verify_id_token};
pub(crate) use loopback::Listener;
pub use loopback::LoopbackSession;

use crate::config::is_loopback_http;
use crate::error::{Error, StepUp};
use crate::keychain::Persistence;

/// A boxed, `Send` future — the return type of the object-safe async traits
/// here.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Opens a URL in the system browser (desktop), or the platform's browser
/// surface. Used by [`LoopbackSession`] for sign-in and by an app to open a
/// card checkout.
///
/// Any `Fn(&str) -> Result<(), String> + Send + Sync` is one.
pub trait UrlOpener: Send + Sync {
    /// Open `url`. Return when it has been handed to the browser, not when
    /// the user is done.
    ///
    /// # Errors
    ///
    /// Why it could not be opened, for [`Error::Browser`].
    fn open(&self, url: &str) -> Result<(), String>;
}

impl<F> UrlOpener for F
where
    F: Fn(&str) -> Result<(), String> + Send + Sync,
{
    fn open(&self, url: &str) -> Result<(), String> {
        self(url)
    }
}

/// What an [`AuthSession`] is asked to show.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorizationRequest {
    /// The full authorization URL to open.
    pub url: String,
    /// The redirect URI the IdP will send the browser back to — the session's
    /// own [`AuthSession::redirect_uri`].
    pub redirect_uri: String,
}

/// A way to take the user through the authorization endpoint and capture
/// the redirect: the seam that lets desktop, iOS and Android differ.
///
/// Implementations: [`LoopbackSession`] (desktop); the Tauri plugin's
/// `ASWebAuthenticationSession` (iOS) and Custom Tabs (Android) sessions.
/// A session must use the system browser or the platform's authentication
/// session, never an embedded web view (RFC 8252 §8.12).
pub trait AuthSession: Send + Sync {
    /// The redirect URI this session captures: a loopback
    /// `http://127.0.0.1:<port>/<path>`, a claimed `https` URI, or a
    /// reverse-DNS private-use scheme (`com.example.app:/oauth/callback`).
    /// It must be registered for the app (the port of a loopback URI aside).
    fn redirect_uri(&self) -> &str;

    /// Show `request.url` to the user and resolve with the **full** URL the
    /// browser was redirected to (`<redirect_uri>?code=…&state=…&iss=…`).
    /// Do not interpret it; the SDK verifies it.
    ///
    /// The SDK bounds the whole call with [`crate::Config::callback_timeout`];
    /// an implementation should resolve with [`Error::Browser`] when the user
    /// dismisses the sheet.
    fn authorize<'a>(
        &'a self,
        request: &'a AuthorizationRequest,
    ) -> BoxFuture<'a, Result<String, Error>>;
}

/// `prompt` (OpenID Connect Core §3.1.2.1).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Prompt {
    /// No UI. Cannot obtain `ai:invoke`, `purchase:create` or
    /// `offline_access` for a loopback or private-scheme client.
    None,
    /// Re-authenticate.
    Login,
    /// Show consent again.
    Consent,
}

impl Prompt {
    fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Login => "login",
            Self::Consent => "consent",
        }
    }
}

/// Optional parameters of one sign-in.
#[non_exhaustive]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SignInOptions {
    /// `prompt`.
    pub prompt: Option<Prompt>,
    /// `max_age`, seconds.
    pub max_age: Option<u64>,
    /// `acr_values`, e.g. `urn:f2z:acr:mfa`.
    pub acr_values: Option<String>,
    /// `login_hint`.
    pub login_hint: Option<String>,
    /// `ui_locales`, space-separated BCP 47 tags.
    pub ui_locales: Option<String>,
}

impl SignInOptions {
    /// The options that answer a step-up challenge (§10): its `max_age`
    /// and/or `acr_values`, plus `prompt=login` when `max_age` is present.
    #[must_use]
    pub fn step_up(challenge: &StepUp) -> Self {
        Self {
            prompt: challenge.max_age.map(|_| Prompt::Login),
            max_age: challenge.max_age,
            acr_values: challenge.acr_values.clone(),
            ..Self::default()
        }
    }

    /// With `prompt`.
    #[must_use]
    pub fn with_prompt(mut self, prompt: Prompt) -> Self {
        self.prompt = Some(prompt);
        self
    }

    /// With `login_hint`.
    #[must_use]
    pub fn with_login_hint(mut self, hint: impl Into<String>) -> Self {
        self.login_hint = Some(hint.into());
        self
    }
}

/// The result of a successful sign-in.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedIn {
    /// The user's account id (`sub`), when an ID token was issued.
    pub subject: Option<String>,
    /// The scopes actually granted — the user may have declined some. Read
    /// this rather than assuming the request.
    pub scopes: Vec<String>,
    /// The verified ID token's claims, when `openid` was granted.
    pub id_token: Option<IdTokenClaims>,
    /// Whether a refresh token was issued (`offline_access`) and so the
    /// session outlives the five-minute access token.
    pub refreshable: bool,
    /// Where the refresh token was kept.
    pub persistence: Persistence,
}

/// The PKCE pair of RFC 7636: the verifier, and its S256 challenge.
pub(crate) struct Pkce {
    pub verifier: crate::secret::Secret,
    pub challenge: String,
}

impl Pkce {
    pub(crate) fn new() -> Result<Self, Error> {
        let verifier = crate::random::token_43()?;
        let digest = ring::digest::digest(&ring::digest::SHA256, verifier.as_bytes());
        Ok(Self {
            challenge: URL_SAFE_NO_PAD.encode(digest.as_ref()),
            verifier: crate::secret::Secret::new(verifier),
        })
    }
}

/// Check a session's redirect URI is one of the shapes of §3.
pub(crate) fn check_redirect_uri(uri: &str) -> Result<Url, Error> {
    let bad = |m: &str| Error::Config(format!("redirect URI {uri:?}: {m}"));
    let url = Url::parse(uri).map_err(|e| bad(&e.to_string()))?;
    if url.query().is_some() || url.fragment().is_some() {
        return Err(bad("may not carry a query or fragment"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(bad("may not carry credentials"));
    }
    match url.scheme() {
        "https" if url.host().is_some() => Ok(url),
        "http" if is_loopback_http(&url) && url.port().is_some() => Ok(url),
        "http" => Err(bad("http only on 127.0.0.1 or [::1], with a port")),
        scheme if scheme.contains('.') && url.host().is_none() && url.path().starts_with('/') => {
            Ok(url)
        }
        _ => Err(bad(
            "must be loopback http, https, or a reverse-DNS private-use scheme",
        )),
    }
}

/// Whether `callback` is a redirect to `redirect`: same scheme, host, port
/// and path.
pub(crate) fn same_endpoint(redirect: &Url, callback: &Url) -> bool {
    redirect.scheme() == callback.scheme()
        && redirect.host_str() == callback.host_str()
        && redirect.port_or_known_default() == callback.port_or_known_default()
        && redirect.path() == callback.path()
}

/// Constant-time equality for `state`.
pub(crate) fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Build the authorization URL (§9.2).
pub(crate) struct AuthorizeParams<'a> {
    pub endpoint: &'a str,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub scope: &'a str,
    pub state: &'a str,
    pub nonce: Option<&'a str>,
    pub challenge: &'a str,
    pub options: &'a SignInOptions,
}

pub(crate) fn authorization_url(p: &AuthorizeParams<'_>) -> Result<String, Error> {
    let mut url = Url::parse(p.endpoint)
        .map_err(|e| Error::Discovery(format!("authorization_endpoint: {e}")))?;
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("response_type", "code")
            .append_pair("client_id", p.client_id)
            .append_pair("redirect_uri", p.redirect_uri)
            .append_pair("scope", p.scope)
            .append_pair("state", p.state)
            .append_pair("code_challenge", p.challenge)
            .append_pair("code_challenge_method", "S256");
        if let Some(nonce) = p.nonce {
            q.append_pair("nonce", nonce);
        }
        if let Some(prompt) = p.options.prompt {
            q.append_pair("prompt", prompt.as_str());
        }
        if let Some(max_age) = p.options.max_age {
            q.append_pair("max_age", &max_age.to_string());
        }
        if let Some(acr) = &p.options.acr_values {
            q.append_pair("acr_values", acr);
        }
        if let Some(hint) = &p.options.login_hint {
            q.append_pair("login_hint", hint);
        }
        if let Some(locales) = &p.options.ui_locales {
            q.append_pair("ui_locales", locales);
        }
    }
    Ok(url.into())
}

/// The verified authorization response: a code, or the IdP's error.
pub(crate) enum Callback {
    Code(String),
    Refused(crate::error::OAuthError),
}

/// Verify the authorization response (§9.3): the endpoint, then `iss`, then
/// `state`, and only then `error` / `code`.
pub(crate) fn parse_callback(
    redirect: &Url,
    callback: &str,
    issuer: &str,
    state: &str,
) -> Result<Callback, Error> {
    let url =
        Url::parse(callback).map_err(|e| Error::Protocol(format!("callback is not a URL: {e}")))?;
    if !same_endpoint(redirect, &url) {
        return Err(Error::Protocol(
            "callback is not a redirect to this session's redirect URI".into(),
        ));
    }
    let mut params = std::collections::BTreeMap::new();
    for (k, v) in url.query_pairs() {
        // RFC 6749 §3.1: a parameter MUST NOT appear more than once.
        if params.insert(k.into_owned(), v.into_owned()).is_some() {
            return Err(Error::Protocol("callback repeats a parameter".into()));
        }
    }
    match params.get("iss") {
        Some(got) if got == issuer => {}
        got => {
            return Err(Error::IssuerMismatch {
                expected: issuer.to_owned(),
                got: got.cloned(),
            });
        }
    }
    match params.get("state") {
        Some(got) if ct_eq(got, state) => {}
        _ => return Err(Error::StateMismatch),
    }
    if let Some(error) = params.get("error") {
        return Ok(Callback::Refused(crate::error::OAuthError::new(
            error.clone(),
            params.get("error_description").cloned(),
        )));
    }
    match params.remove("code") {
        Some(code) if !code.is_empty() => Ok(Callback::Code(code)),
        _ => Err(Error::Protocol(
            "callback carries neither code nor error".into(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ISS: &str = "https://free2z.cash";

    fn redirect() -> Url {
        Url::parse("http://127.0.0.1:49152/callback").unwrap()
    }

    #[test]
    fn pkce_s256_matches_rfc7636_appendix_b() {
        // RFC 7636 Appendix B's verifier and challenge.
        let digest = ring::digest::digest(
            &ring::digest::SHA256,
            b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        );
        assert_eq!(
            URL_SAFE_NO_PAD.encode(digest.as_ref()),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let p = Pkce::new().unwrap();
        assert_eq!(p.verifier.expose().len(), 43);
        assert_eq!(p.challenge.len(), 43);
    }

    #[test]
    fn iss_is_checked_before_state_and_before_error() {
        let cb = "http://127.0.0.1:49152/callback?error=access_denied&state=s&iss=https%3A%2F%2Fevil.example";
        assert!(matches!(
            parse_callback(&redirect(), cb, ISS, "s"),
            Err(Error::IssuerMismatch { .. })
        ));
        let missing = "http://127.0.0.1:49152/callback?code=c&state=s";
        assert!(matches!(
            parse_callback(&redirect(), missing, ISS, "s"),
            Err(Error::IssuerMismatch { got: None, .. })
        ));
    }

    #[test]
    fn state_mismatch_hides_the_error_and_the_code() {
        let cb = "http://127.0.0.1:49152/callback?code=c&state=other&iss=https%3A%2F%2Ffree2z.cash";
        assert!(matches!(
            parse_callback(&redirect(), cb, ISS, "s"),
            Err(Error::StateMismatch)
        ));
    }

    #[test]
    fn a_good_response_yields_the_code_and_an_error_yields_the_error() {
        let cb = "http://127.0.0.1:49152/callback?code=abc&state=s&iss=https%3A%2F%2Ffree2z.cash";
        assert!(matches!(
            parse_callback(&redirect(), cb, ISS, "s"),
            Ok(Callback::Code(c)) if c == "abc"
        ));
        let denied = "http://127.0.0.1:49152/callback?error=access_denied&state=s&iss=https%3A%2F%2Ffree2z.cash";
        assert!(matches!(
            parse_callback(&redirect(), denied, ISS, "s"),
            Ok(Callback::Refused(e)) if e.error == "access_denied"
        ));
    }

    #[test]
    fn a_callback_to_another_path_or_with_duplicates_is_refused() {
        let other =
            "http://127.0.0.1:49152/elsewhere?code=abc&state=s&iss=https%3A%2F%2Ffree2z.cash";
        assert!(parse_callback(&redirect(), other, ISS, "s").is_err());
        let dup =
            "http://127.0.0.1:49152/callback?code=a&code=b&state=s&iss=https%3A%2F%2Ffree2z.cash";
        assert!(parse_callback(&redirect(), dup, ISS, "s").is_err());
    }

    #[test]
    fn redirect_shapes() {
        assert!(check_redirect_uri("http://127.0.0.1:5000/callback").is_ok());
        assert!(check_redirect_uri("http://[::1]:5000/callback").is_ok());
        assert!(check_redirect_uri("https://tutor.example.com/oauth/callback").is_ok());
        assert!(check_redirect_uri("com.example.tutor:/oauth/callback").is_ok());
        assert!(check_redirect_uri("http://localhost:5000/callback").is_err());
        assert!(check_redirect_uri("http://127.0.0.1:5000/callback?x=1").is_err());
        assert!(check_redirect_uri("tutor:/oauth/callback").is_err());
    }

    #[test]
    fn state_comparison() {
        assert!(ct_eq("abc", "abc"));
        assert!(!ct_eq("abc", "abd"));
        assert!(!ct_eq("abc", "ab"));
    }
}
