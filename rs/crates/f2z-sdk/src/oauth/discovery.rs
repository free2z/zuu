//! OpenID Connect Discovery (`docs/sdk/spec/oidc.md` §9.1).

use serde::Deserialize;
use url::Url;

use crate::config::{check_server_url, is_loopback_http};
use crate::error::Error;

/// The parts of the IdP's discovery document this SDK uses. Unknown members
/// are ignored, so the IdP can add to the document (`dpop_…`, a Zcash grant)
/// without breaking a deployed client.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Discovery {
    /// Must equal the configured issuer exactly (RFC 8414 §3.3).
    pub issuer: String,
    /// Where the browser is sent.
    pub authorization_endpoint: String,
    /// Code exchange and refresh.
    pub token_endpoint: String,
    /// The ID token's signing keys.
    pub jwks_uri: String,
    /// OpenID Connect userinfo.
    #[serde(default)]
    pub userinfo_endpoint: Option<String>,
    /// RFC 7009 revocation, used on sign-out.
    #[serde(default)]
    pub revocation_endpoint: Option<String>,
    /// PKCE methods; must contain `S256`.
    #[serde(default)]
    pub code_challenge_methods_supported: Vec<String>,
    /// RFC 9207: whether the authorization response carries `iss`. This SDK
    /// requires `iss` on every response regardless (the Free2Z profile
    /// always sends it).
    #[serde(default)]
    pub authorization_response_iss_parameter_supported: bool,
    /// The grants the IdP offers.
    #[serde(default)]
    pub grant_types_supported: Vec<String>,
    /// The scopes the IdP knows.
    #[serde(default)]
    pub scopes_supported: Vec<String>,
}

impl Discovery {
    /// Check the document against the issuer it was fetched for.
    pub(crate) fn validate(&self, issuer: &str) -> Result<(), Error> {
        if self.issuer != issuer {
            return Err(Error::Discovery(format!(
                "issuer {:?} is not the configured issuer {issuer:?}",
                self.issuer
            )));
        }
        if !self
            .code_challenge_methods_supported
            .iter()
            .any(|m| m == "S256")
        {
            return Err(Error::Discovery(
                "code_challenge_methods_supported does not offer S256".into(),
            ));
        }
        let issuer_url =
            Url::parse(issuer).map_err(|e| Error::Discovery(format!("issuer: {e}")))?;
        let https_only = !is_loopback_http(&issuer_url);
        let mut endpoints = vec![
            ("authorization_endpoint", Some(&self.authorization_endpoint)),
            ("token_endpoint", Some(&self.token_endpoint)),
            ("jwks_uri", Some(&self.jwks_uri)),
            ("revocation_endpoint", self.revocation_endpoint.as_ref()),
        ];
        endpoints.push(("userinfo_endpoint", self.userinfo_endpoint.as_ref()));
        for (name, value) in endpoints {
            let Some(value) = value else { continue };
            let url = Url::parse(value).map_err(|e| Error::Discovery(format!("{name}: {e}")))?;
            check_server_url(&url).map_err(|m| Error::Discovery(format!("{name}: {m}")))?;
            if https_only && url.scheme() != "https" {
                return Err(Error::Discovery(format!(
                    "{name} is not https under an https issuer"
                )));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(issuer: &str) -> Discovery {
        Discovery {
            issuer: issuer.into(),
            authorization_endpoint: format!("{issuer}/oauth/authorize"),
            token_endpoint: format!("{issuer}/api/oauth/token"),
            jwks_uri: format!("{issuer}/api/oauth/jwks"),
            userinfo_endpoint: None,
            revocation_endpoint: Some(format!("{issuer}/api/oauth/revoke")),
            code_challenge_methods_supported: vec!["S256".into()],
            authorization_response_iss_parameter_supported: true,
            grant_types_supported: vec![],
            scopes_supported: vec![],
        }
    }

    #[test]
    fn the_spec_example_validates() {
        doc("https://free2z.cash")
            .validate("https://free2z.cash")
            .unwrap();
    }

    #[test]
    fn a_different_issuer_is_refused() {
        let d = doc("https://free2z.cash.evil.example");
        assert!(matches!(
            d.validate("https://free2z.cash"),
            Err(Error::Discovery(_))
        ));
    }

    #[test]
    fn no_s256_is_refused() {
        let mut d = doc("https://free2z.cash");
        d.code_challenge_methods_supported = vec!["plain".into()];
        assert!(d.validate("https://free2z.cash").is_err());
    }

    #[test]
    fn a_plain_http_endpoint_under_an_https_issuer_is_refused() {
        let mut d = doc("https://free2z.cash");
        d.token_endpoint = "http://127.0.0.1:1/token".into();
        assert!(d.validate("https://free2z.cash").is_err());
    }
}
