//! ID token verification (`docs/free2z/sdk/spec/oidc.md` §7, §11): an `RS256` JWS
//! keyed by `kid` from `jwks_uri`, then `iss`, `aud`, `exp` and `nonce`.
//!
//! Only `RS256` is accepted. The header's `alg` must say so **and** the key
//! selected by `kid` must be an RSA key; nothing about the algorithm is taken
//! from the token alone.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::signature::{RSA_PKCS1_2048_8192_SHA256, RsaPublicKeyComponents};
use serde::Deserialize;
use serde_json::Value;

use crate::error::Error;

/// Clock skew tolerated on `exp`, in seconds.
const LEEWAY_SECS: u64 = 60;

/// The verified claims of an ID token: who signed in, and how.
#[non_exhaustive]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdTokenClaims {
    /// The user's stable, opaque account id — the same for every app.
    pub sub: String,
    /// When the user last authenticated interactively, Unix seconds.
    pub auth_time: Option<u64>,
    /// The authentication context achieved (`urn:f2z:acr:1fa`,
    /// `urn:f2z:acr:mfa`).
    pub acr: Option<String>,
    /// The methods used (`pwd`, `otp`, `urn:f2z:amr:passkey`, …).
    pub amr: Vec<String>,
    /// With `profile`.
    pub preferred_username: Option<String>,
    /// With `profile`.
    pub name: Option<String>,
    /// With `profile`.
    pub picture: Option<String>,
    /// With `email`.
    pub email: Option<String>,
    /// With `email`.
    pub email_verified: Option<bool>,
    /// Expiry, Unix seconds.
    pub exp: u64,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
}

#[derive(Deserialize)]
struct RawClaims {
    iss: String,
    sub: String,
    aud: Value,
    exp: u64,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    azp: Option<String>,
    #[serde(default)]
    auth_time: Option<u64>,
    #[serde(default)]
    acr: Option<String>,
    #[serde(default)]
    amr: Vec<String>,
    #[serde(default)]
    preferred_username: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    picture: Option<String>,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    email_verified: Option<bool>,
}

/// A JSON Web Key Set. Unknown members and key types are ignored.
#[derive(Clone, Debug, Default, Deserialize)]
pub(crate) struct Jwks {
    #[serde(default)]
    keys: Vec<Jwk>,
}

#[derive(Clone, Debug, Deserialize)]
struct Jwk {
    kty: String,
    #[serde(default)]
    kid: Option<String>,
    #[serde(default)]
    alg: Option<String>,
    #[serde(default, rename = "use")]
    use_: Option<String>,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    e: Option<String>,
}

fn bad(m: impl Into<String>) -> Error {
    Error::IdToken(m.into())
}

fn b64(segment: &str, what: &str) -> Result<Vec<u8>, Error> {
    URL_SAFE_NO_PAD
        .decode(segment)
        .map_err(|_| bad(format!("{what} is not base64url")))
}

/// RSASSA-PKCS1-v1_5 with SHA-256 over `message`, by the public key
/// `(n, e)`; `ring` refuses moduli under 2048 bits.
fn check_rs256_signature(
    n: &[u8],
    e: &[u8],
    message: &[u8],
    signature: &[u8],
) -> Result<(), Error> {
    RsaPublicKeyComponents { n, e }
        .verify(&RSA_PKCS1_2048_8192_SHA256, message, signature)
        .map_err(|_| bad("signature does not verify"))
}

/// What the token must say, besides its signature.
pub(crate) struct Expected<'a> {
    pub issuer: &'a str,
    pub client_id: &'a str,
    pub nonce: Option<&'a str>,
    pub now: u64,
}

/// Verify `token` against `jwks` and `expected`.
pub(crate) fn verify(
    token: &str,
    jwks: &Jwks,
    expected: &Expected<'_>,
) -> Result<IdTokenClaims, Error> {
    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(bad("not a compact JWS"));
    };
    let header: Header =
        serde_json::from_slice(&b64(h, "header")?).map_err(|_| bad("header is not JSON"))?;
    if header.alg != "RS256" {
        return Err(bad(format!("alg {:?} is not RS256", header.alg)));
    }
    let kid = header.kid.ok_or_else(|| bad("header has no kid"))?;
    let key = jwks
        .keys
        .iter()
        .find(|k| k.kid.as_deref() == Some(kid.as_str()))
        .ok_or_else(|| bad(format!("no key {kid:?} in the JWKS")))?;
    if key.kty != "RSA"
        || key.alg.as_deref().is_some_and(|a| a != "RS256")
        || key.use_.as_deref().is_some_and(|u| u != "sig")
    {
        return Err(bad(format!("key {kid:?} is not an RS256 signing key")));
    }
    let n = b64(key.n.as_deref().ok_or_else(|| bad("key has no n"))?, "n")?;
    let e = b64(key.e.as_deref().ok_or_else(|| bad("key has no e"))?, "e")?;
    let signature = b64(s, "signature")?;
    let signing_input_len = h.len().saturating_add(1).saturating_add(p.len());
    let signing_input = token
        .get(..signing_input_len)
        .ok_or_else(|| bad("malformed token"))?;
    check_rs256_signature(&n, &e, signing_input.as_bytes(), &signature)?;

    let claims: RawClaims =
        serde_json::from_slice(&b64(p, "payload")?).map_err(|e| bad(format!("claims: {e}")))?;
    if claims.iss != expected.issuer {
        return Err(bad(format!("iss {:?} is not the issuer", claims.iss)));
    }
    let audience_ok = match &claims.aud {
        Value::String(a) => a == expected.client_id,
        Value::Array(list) => {
            let has = list.iter().any(|a| a.as_str() == Some(expected.client_id));
            // OIDC Core §3.1.3.7: several audiences need azp naming us.
            has && (list.len() == 1 || claims.azp.as_deref() == Some(expected.client_id))
        }
        _ => false,
    };
    if !audience_ok {
        return Err(bad("aud does not name this client"));
    }
    if claims.exp.saturating_add(LEEWAY_SECS) <= expected.now {
        return Err(bad("expired"));
    }
    if let Some(want) = expected.nonce
        && claims.nonce.as_deref() != Some(want)
    {
        return Err(bad("nonce does not match this sign-in"));
    }
    Ok(IdTokenClaims {
        sub: claims.sub,
        auth_time: claims.auth_time,
        acr: claims.acr,
        amr: claims.amr,
        preferred_username: claims.preferred_username,
        name: claims.name,
        picture: claims.picture,
        email: claims.email,
        email_verified: claims.email_verified,
        exp: claims.exp,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_other_algorithms_before_looking_at_keys() {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","kid":"k"}"#);
        let token = format!("{header}.e30.");
        let err = verify(
            &token,
            &Jwks::default(),
            &Expected {
                issuer: "https://free2z.cash",
                client_id: "c",
                nonce: None,
                now: 0,
            },
        )
        .unwrap_err();
        assert!(err.to_string().contains("not RS256"), "{err}");
    }
}
