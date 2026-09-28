//! The outbound HTTP client and the request it sends — the security boundary
//! between a client's call and a provider account.
//!
//! * **One pooled client per provider**, HTTP/2 when the provider negotiates
//!   it (ALPN over rustls), with Mozilla's roots compiled in.
//! * **No redirects.** A redirect would carry the provider key — including a
//!   custom header like `x-api-key`, which reqwest does not strip — to
//!   wherever the `Location` points.
//! * **No proxy from the environment.** `HTTPS_PROXY` in a pod's environment
//!   must not be able to route every prompt and key through a third party.
//! * **The URL is configuration.** Base URLs come from the operator's config
//!   ([`crate::config::ProviderConfig`]), must be `https://` (plain `http://`
//!   only to a loopback address, for the mock provider), and the path is the
//!   adapter's constant. Nothing a client sends is ever part of a URL the
//!   gateway fetches.
//! * **Headers are an allowlist.** The adapter's headers
//!   ([`super::Provider::headers`]) plus `content-type` and `accept`, checked
//!   against [`ALLOWED_HEADERS`] before every send. The backend never sees
//!   the client's HTTP headers at all, so an `anthropic-beta` or
//!   `OpenAI-Organization` from a client has no path to the provider; the
//!   check makes an adapter bug that tried to add one fail loudly.
//! * **Keys are [`SecretString`]** and are exposed only into a header value
//!   marked sensitive. Nothing here logs a request or a header.

use std::time::Duration;

use reqwest::header::{self, HeaderMap, HeaderValue};
use reqwest::{Client, Url};
use secrecy::SecretString;

use crate::error::ApiFailure;
use f2z_ai_proto::ErrorCode;

/// Every header the gateway may send a provider. Anything else in a built
/// request is a bug, and [`checked_headers`] refuses it.
pub const ALLOWED_HEADERS: [&str; 5] = [
    "authorization",
    "x-api-key",
    "anthropic-version",
    "content-type",
    "accept",
];

/// The most of a provider's error body the gateway reads (to find its error
/// `type`): 64 KiB.
pub const ERROR_BODY_LIMIT: usize = 64 * 1024;

/// The provider connect timeout (chat-api.md §1, fixed).
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// A client for one provider.
///
/// # Errors
///
/// The TLS backend could not be initialised.
pub fn build_client(connect_timeout: Duration) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(connect_timeout)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .pool_idle_timeout(Duration::from_secs(90))
        .tcp_keepalive(Duration::from_secs(30))
        .http2_keep_alive_interval(Duration::from_secs(20))
        .http2_keep_alive_while_idle(true)
        .http2_adaptive_window(true)
        .build()
        .map_err(|e| format!("provider HTTP client: {e}"))
}

/// Validate a configured base URL: `https://`, or `http://` to loopback.
///
/// # Errors
///
/// Why the URL is refused.
pub fn base_url(text: &str) -> Result<Url, String> {
    let url = Url::parse(text).map_err(|_| format!("`{text}` is not a URL"))?;
    let loopback = match url.host_str() {
        Some("localhost") => true,
        Some(host) => host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback()),
        None => false,
    };
    match url.scheme() {
        "https" => {}
        "http" if loopback => {}
        _ => {
            return Err(format!(
                "`{text}`: a provider base URL must be https:// (http:// only to loopback)"
            ));
        }
    }
    if url.query().is_some() || url.fragment().is_some() || !url.username().is_empty() {
        return Err(format!(
            "`{text}`: a provider base URL carries no query, fragment or credentials"
        ));
    }
    Ok(url)
}

/// `base` + `path`, keeping any path prefix `base` has.
#[must_use]
pub fn endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    let joined = format!("{}{}", base.path().trim_end_matches('/'), path);
    url.set_path(&joined);
    url
}

/// The adapter's headers plus the fixed ones, checked against the
/// allowlist.
///
/// # Errors
///
/// `500 internal` if the adapter produced a header outside the allowlist.
pub fn checked_headers(
    adapter: &dyn super::Provider,
    key: &SecretString,
) -> Result<HeaderMap, ApiFailure> {
    let mut headers = adapter.headers(key)?;
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::ACCEPT,
        HeaderValue::from_static("text/event-stream"),
    );
    if let Some(name) = headers
        .keys()
        .find(|name| !ALLOWED_HEADERS.contains(&name.as_str()))
    {
        tracing::error!(
            header = name.as_str(),
            "adapter built a header outside the allowlist"
        );
        return Err(ApiFailure::new(
            ErrorCode::Internal,
            "the gateway built a provider request it may not send",
        )
        .detail("reason", "header_allowlist"));
    }
    Ok(headers)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls_are_https_or_loopback() {
        assert!(base_url("https://api.anthropic.com").is_ok());
        assert!(base_url("http://127.0.0.1:9000").is_ok());
        assert!(base_url("http://localhost:9000").is_ok());
        assert!(base_url("http://[::1]:9000").is_ok());
        assert!(base_url("http://api.openai.com").is_err());
        assert!(base_url("ftp://x").is_err());
        assert!(base_url("https://u:p@api.x.ai").is_err());
        assert!(base_url("https://api.x.ai/?a=b").is_err());
    }

    #[test]
    fn endpoints_keep_a_base_path() {
        let base = base_url("https://gw.example/openai/").unwrap();
        assert_eq!(
            endpoint(&base, "/v1/responses").as_str(),
            "https://gw.example/openai/v1/responses"
        );
        let base = base_url("https://api.x.ai").unwrap();
        assert_eq!(
            endpoint(&base, "/v1/chat/completions").as_str(),
            "https://api.x.ai/v1/chat/completions"
        );
    }
}
