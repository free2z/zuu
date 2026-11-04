//! Shared HTTP plumbing: the client, the error envelope, `Retry-After`,
//! `WWW-Authenticate`.

use std::time::Duration;

use reqwest::header::{HeaderMap, RETRY_AFTER, WWW_AUTHENTICATE};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::error::{ApiError, Error, StepUp};

pub(crate) const USER_AGENT: &str = concat!("f2z-sdk/", env!("CARGO_PKG_VERSION"));

/// The one HTTP client of a [`crate::Client`]. Redirects are never followed:
/// none of these APIs redirect, and a token request that did would be a bug
/// or an attack.
pub(crate) fn build_client() -> Result<reqwest::Client, Error> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .build()
        .map_err(Error::from)
}

/// `application/x-www-form-urlencoded`.
pub(crate) fn form(pairs: &[(&str, &str)]) -> String {
    let mut s = url::form_urlencoded::Serializer::new(String::new());
    for (k, v) in pairs {
        s.append_pair(k, v);
    }
    s.finish()
}

/// `Retry-After` in delta-seconds. An HTTP-date is ignored (none of these
/// servers send one).
pub(crate) fn retry_after(headers: &HeaderMap) -> Option<Duration> {
    headers
        .get(RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

pub(crate) fn header_string(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

#[derive(Deserialize)]
struct Envelope {
    error: EnvelopeBody,
}

#[derive(Deserialize)]
struct EnvelopeBody {
    code: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    details: Option<Map<String, Value>>,
}

/// Read a non-2xx response into the `errors.md` §1 envelope. A body that is
/// not the envelope (a proxy's HTML page) becomes code `http_<status>`,
/// which nothing retries.
pub(crate) async fn read_error(response: reqwest::Response) -> ApiError {
    let status = response.status().as_u16();
    let headers = response.headers().clone();
    let body = response.bytes().await.unwrap_or_default();
    envelope_from(status, &headers, &body)
}

pub(crate) fn envelope_from(status: u16, headers: &HeaderMap, body: &[u8]) -> ApiError {
    let (code, message, details) = match serde_json::from_slice::<Envelope>(body) {
        Ok(e) => (e.error.code, e.error.message, e.error.details),
        Err(_) => {
            // A 401 challenge without an envelope still names its code.
            let code = www_authenticate(headers)
                .and_then(|p| param(&p, "error"))
                .unwrap_or_else(|| format!("http_{status}"));
            (code, String::new(), None)
        }
    };
    ApiError {
        status,
        code,
        message,
        details,
        retry_after: retry_after(headers),
        call_id: header_string(headers, "x-f2z-call-id"),
    }
}

/// Read a 2xx JSON body.
pub(crate) async fn read_json<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
) -> Result<T, Error> {
    let body = response.bytes().await?;
    serde_json::from_slice(&body).map_err(|e| Error::Protocol(format!("unexpected body: {e}")))
}

/// Whether the response is 2xx; otherwise its envelope as an error.
pub(crate) async fn expect_success(
    response: reqwest::Response,
) -> Result<reqwest::Response, Error> {
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(Error::Api(Box::new(read_error(response).await)))
    }
}

fn www_authenticate(headers: &HeaderMap) -> Option<String> {
    header_string(headers, WWW_AUTHENTICATE.as_str())
}

/// The `name="value"` / `name=value` parameters of a `WWW-Authenticate:
/// Bearer …` challenge, in order.
fn params(challenge: &str) -> Vec<(String, String)> {
    let s = challenge.trim_start();
    let s = match s.get(..6) {
        Some(scheme) if scheme.eq_ignore_ascii_case("bearer") => s.get(6..).unwrap_or(""),
        _ => s,
    };
    let mut out = Vec::new();
    let mut it = s.chars().peekable();
    loop {
        while matches!(it.peek(), Some(c) if *c == ',' || c.is_whitespace()) {
            it.next();
        }
        let mut key = String::new();
        while let Some(&c) = it.peek() {
            if c == '=' || c == ',' {
                break;
            }
            key.push(c);
            it.next();
        }
        match it.next() {
            Some('=') => {}
            Some(_) => continue,
            None => break,
        }
        let mut value = String::new();
        if it.peek() == Some(&'"') {
            it.next();
            let mut escaped = false;
            for c in it.by_ref() {
                if escaped {
                    value.push(c);
                    escaped = false;
                } else if c == '\\' {
                    escaped = true;
                } else if c == '"' {
                    break;
                } else {
                    value.push(c);
                }
            }
        } else {
            while let Some(&c) = it.peek() {
                if c == ',' {
                    break;
                }
                value.push(c);
                it.next();
            }
            value = value.trim().to_owned();
        }
        out.push((key.trim().to_owned(), value));
    }
    out
}

fn param(challenge: &str, name: &str) -> Option<String> {
    params(challenge)
        .into_iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v)
}

/// The RFC 9470 step-up requirement of a `401
/// insufficient_user_authentication`: from `WWW-Authenticate`, falling back
/// to the envelope's `details`.
pub(crate) fn step_up(headers: &HeaderMap, error: &ApiError) -> StepUp {
    let challenge = www_authenticate(headers).unwrap_or_default();
    let max_age = param(&challenge, "max_age")
        .and_then(|v| v.parse().ok())
        .or_else(|| error.detail_u64("max_age"))
        .or_else(|| error.detail_str("max_age").and_then(|v| v.parse().ok()));
    let acr_values = param(&challenge, "acr_values")
        .or_else(|| error.detail_str("acr_values").map(str::to_owned));
    StepUp {
        max_age,
        acr_values,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc9470_challenge_params() {
        let c = r#"Bearer error="insufficient_user_authentication", error_description="Raising a cap, needs \"recent\" auth", max_age="300", acr_values=urn:f2z:acr:mfa"#;
        assert_eq!(
            param(c, "error").as_deref(),
            Some("insufficient_user_authentication")
        );
        assert_eq!(param(c, "max_age").as_deref(), Some("300"));
        assert_eq!(param(c, "acr_values").as_deref(), Some("urn:f2z:acr:mfa"));
        assert_eq!(
            param(c, "error_description").as_deref(),
            Some("Raising a cap, needs \"recent\" auth")
        );
        assert_eq!(param(c, "absent"), None);
    }

    #[test]
    fn non_envelope_bodies_become_http_codes() {
        let e = envelope_from(502, &HeaderMap::new(), b"<html>bad gateway</html>");
        assert_eq!(e.code, "http_502");
        assert!(!e.retryable());
    }

    #[test]
    fn form_encodes() {
        assert_eq!(form(&[("a", "b c"), ("d", "&=")]), "a=b+c&d=%26%3D");
    }
}
