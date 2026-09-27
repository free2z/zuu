//! What a [`crate::Client`] talks to, and as whom.

use std::time::Duration;

use url::Url;

use crate::error::Error;

/// The production issuer, `docs/sdk/spec/oidc.md` §1.
pub const DEFAULT_ISSUER: &str = "https://free2z.cash";
/// The account API root, fixed by the contract (`docs/sdk/README.md`).
pub const DEFAULT_API_BASE: &str = "https://free2z.cash/api/sdk/v1";
/// The AI gateway root, fixed by the contract.
pub const DEFAULT_AI_BASE: &str = "https://ai.free2z.cash/v1";

/// The scopes a new [`Config`] asks for: sign-in, a refresh token, the
/// balance, purchases and AI. Narrow them with [`Config::with_scopes`] to what
/// the app actually uses — the user sees each one on the consent screen.
pub const DEFAULT_SCOPES: &[&str] = &[
    "openid",
    "profile",
    "offline_access",
    "balance:read",
    "purchase:create",
    "ai:invoke",
];

/// The configuration of one app's client.
///
/// Built with [`Config::new`] and the `with_*` methods; every field has the
/// production default except the `client_id`, which the developer console
/// assigns.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    /// The issuer (`iss`). The only URL a client hard-codes: every IdP
    /// endpoint comes from its discovery document.
    pub issuer: String,
    /// The app's `client_id`. This SDK is a **public** client: no secret.
    pub client_id: String,
    /// The scopes to request, space-joined on the wire.
    pub scopes: Vec<String>,
    /// The account API root (`…/api/sdk/v1`).
    pub api_base: String,
    /// The AI gateway root (`…/v1`).
    pub ai_base: String,
    /// The limit on one non-streaming request and on waiting for a token-store
    /// operation. A store timeout is `Error::Storage`; its blocking operation
    /// may finish later, with writes still sequenced. Refresh's first attempt
    /// is additionally capped at 30 seconds to leave recovery time, and its
    /// entire same-token recovery sequence is capped at 55 seconds.
    pub request_timeout: Duration,
    /// How long sign-in waits for the browser to come back to the redirect
    /// URI.
    pub callback_timeout: Duration,
    /// How long a chat stream may go without receiving a byte before it is
    /// treated as interrupted. The gateway sends a `: ping` every 15 s while
    /// it waits on a provider, so this is a dead-connection detector.
    pub stream_idle_timeout: Duration,
}

impl Config {
    /// The production configuration for `client_id`.
    #[must_use]
    pub fn new(client_id: impl Into<String>) -> Self {
        Self {
            issuer: DEFAULT_ISSUER.to_owned(),
            client_id: client_id.into(),
            scopes: DEFAULT_SCOPES.iter().map(|s| (*s).to_owned()).collect(),
            api_base: DEFAULT_API_BASE.to_owned(),
            ai_base: DEFAULT_AI_BASE.to_owned(),
            request_timeout: Duration::from_secs(30),
            callback_timeout: Duration::from_secs(600),
            stream_idle_timeout: Duration::from_secs(90),
        }
    }

    /// Another issuer (a staging IdP, or a local fake).
    #[must_use]
    pub fn with_issuer(mut self, issuer: impl Into<String>) -> Self {
        self.issuer = issuer.into();
        self
    }

    /// The scopes to request.
    #[must_use]
    pub fn with_scopes<I, S>(mut self, scopes: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.scopes = scopes.into_iter().map(Into::into).collect();
        self
    }

    /// Another account API root.
    #[must_use]
    pub fn with_api_base(mut self, base: impl Into<String>) -> Self {
        self.api_base = base.into();
        self
    }

    /// Another AI gateway root.
    #[must_use]
    pub fn with_ai_base(mut self, base: impl Into<String>) -> Self {
        self.ai_base = base.into();
        self
    }

    /// The limit on one non-streaming request.
    #[must_use]
    pub fn with_request_timeout(mut self, timeout: Duration) -> Self {
        self.request_timeout = timeout;
        self
    }

    /// How long sign-in waits for the redirect.
    #[must_use]
    pub fn with_callback_timeout(mut self, timeout: Duration) -> Self {
        self.callback_timeout = timeout;
        self
    }

    /// How long a chat stream may be silent before it counts as interrupted.
    #[must_use]
    pub fn with_stream_idle_timeout(mut self, timeout: Duration) -> Self {
        self.stream_idle_timeout = timeout;
        self
    }

    pub(crate) fn validate(&self) -> Result<Validated, Error> {
        if self.client_id.trim().is_empty() {
            return Err(Error::Config("client_id is empty".into()));
        }
        if self.scopes.iter().any(|s| s.is_empty() || s.contains(' ')) {
            return Err(Error::Config("a scope is empty or contains a space".into()));
        }
        let issuer = self.issuer.trim_end_matches('/').to_owned();
        let issuer_url = server_url(&issuer, "issuer")?;
        if issuer_url.query().is_some() {
            return Err(Error::Config("the issuer carries a query".into()));
        }
        let api_base = self.api_base.trim_end_matches('/').to_owned();
        server_url(&api_base, "api_base")?;
        let ai_base = self.ai_base.trim_end_matches('/').to_owned();
        server_url(&ai_base, "ai_base")?;
        Ok(Validated {
            issuer,
            client_id: self.client_id.clone(),
            scopes: self.scopes.clone(),
            api_base,
            ai_base,
            request_timeout: self.request_timeout,
            callback_timeout: self.callback_timeout,
            stream_idle_timeout: self.stream_idle_timeout,
        })
    }
}

/// A [`Config`] that has been checked, with trailing slashes removed.
#[derive(Clone, Debug)]
pub(crate) struct Validated {
    pub issuer: String,
    pub client_id: String,
    pub scopes: Vec<String>,
    pub api_base: String,
    pub ai_base: String,
    pub request_timeout: Duration,
    pub callback_timeout: Duration,
    pub stream_idle_timeout: Duration,
}

impl Validated {
    pub fn scope_string(&self) -> String {
        self.scopes.join(" ")
    }

    pub fn wants(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
}

/// Whether `url` is a loopback `http` URL (`127.0.0.1` or `[::1]`).
pub(crate) fn is_loopback_http(url: &Url) -> bool {
    url.scheme() == "http"
        && matches!(
            url.host(),
            Some(url::Host::Ipv4(ip)) if ip.is_loopback()
        )
        || url.scheme() == "http"
            && matches!(url.host(), Some(url::Host::Ipv6(ip)) if ip.is_loopback())
}

/// Parse a server URL: `https`, or `http` on the loopback interface only (a
/// local fake or a development server). No credentials, no fragment.
pub(crate) fn server_url(value: &str, what: &str) -> Result<Url, Error> {
    let url = Url::parse(value).map_err(|e| Error::Config(format!("{what}: {e}")))?;
    check_server_url(&url).map_err(|m| Error::Config(format!("{what}: {m}")))?;
    Ok(url)
}

pub(crate) fn check_server_url(url: &Url) -> Result<(), &'static str> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("a URL may not carry credentials");
    }
    if url.fragment().is_some() {
        return Err("a URL may not carry a fragment");
    }
    if url.scheme() == "https" && url.host().is_some() {
        return Ok(());
    }
    if is_loopback_http(url) {
        return Ok(());
    }
    Err("must be https (or http on 127.0.0.1 / [::1])")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_defaults_validate() {
        let v = Config::new("app_1").validate().unwrap();
        assert_eq!(v.issuer, "https://free2z.cash");
        assert!(v.wants("ai:invoke"));
    }

    #[test]
    fn plain_http_off_loopback_is_refused() {
        let bad = Config::new("app_1").with_issuer("http://free2z.cash");
        assert!(matches!(bad.validate(), Err(Error::Config(_))));
        let bad = Config::new("app_1").with_ai_base("http://localhost:1/v1");
        assert!(matches!(bad.validate(), Err(Error::Config(_))));
        let ok = Config::new("app_1")
            .with_issuer("http://127.0.0.1:9/")
            .with_api_base("http://[::1]:9/api/sdk/v1");
        assert_eq!(ok.validate().unwrap().issuer, "http://127.0.0.1:9");
    }

    #[test]
    fn empty_client_id_is_refused() {
        assert!(Config::new(" ").validate().is_err());
    }
}
